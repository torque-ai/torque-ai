# Verify-Review Hybrid — Design

## Goal

Replace the factory's current "retry verify N times blindly, then reject"
pattern with a hybrid classifier that distinguishes between a task's
own failure and a pre-existing broken baseline. When `verify_command`
fails after a factory worktree task, classify whether the failure is
attributable to the task's changes or the project's baseline, and
branch:

- Task-caused → retry with error feedback (existing path).
- Baseline → reject the item with a specific reason, pause the project
  until an operator fixes the baseline, surface an event.
- Environment failure (command not found, timeout, permission error) →
  same pause path, different reason.
- Ambiguous → retry as today (conservative default; never pauses a
  project without positive classification).

On 2026-04-18, bitsy ran 9 work items that all hit
`verify_failed_after_3_retries`. All nine were almost certainly
baseline-broken: the action provider produced plausible code three
times per item, each time the project's pre-existing broken pytest
suite refused it. That's 27 wasted plan-task cycles on compute the
classifier would have saved at attempt 0. This design eliminates that
category.

## Placement

The classifier runs **at the first verify failure**, before the
existing retry-increment logic, inside `executeVerifyStage` in
`server/factory/loop-controller.js` (around lines 4100-4250). It fires
after the verify runner returns a non-zero exit code and before the
retry-task submission path.

Rationale: classifying once at entry is cheapest — we avoid running
the classifier N times per item and avoid burning N-1 plan-task cycles
on items that were never going to pass verify.

## Behavior summary

Two-pass scoring:

1. **Deterministic pass** (fast, zero LLM cost): environment-failure
   detection from exit codes / stderr patterns, then file-path
   intersection between failing test paths and `git diff --name-only`.
2. **LLM tiebreak** (runs only when deterministic says `baseline_candidate`
   or `ambiguous`): routes through the existing `plan_generation`
   category to a text-gen provider. Prompt asks "are these failures
   attributable to this diff?" Returns go/no-go + one-sentence critique.

Decision matrix:

| Deterministic verdict | LLM runs? | Final classification | Factory action |
|---|---|---|---|
| `environment_failure` (exit 127, timeout) | no | `environment_failure` | Reject item (`verify_failed_environment`); pause project; emit event |
| `task_caused` (intersection ≠ ∅) | no | `task_caused` | Retry with error feedback (existing path) |
| `baseline_candidate` + LLM confirms | yes | `baseline_broken` | Reject item (`verify_failed_baseline_unrelated`); pause project; emit event |
| `baseline_candidate` + LLM disagrees | yes | `task_caused` | Retry (existing path) |
| `ambiguous` + LLM says task-caused | yes | `task_caused` | Retry |
| `ambiguous` + LLM says baseline | yes | `baseline_broken` | Reject item; pause project |
| `ambiguous` + LLM null (timeout/error) | yes | `ambiguous` | Retry (conservative default) |

Project pause semantics: only positive LLM agreement triggers
`baseline_broken`. Null LLM results or unclear deterministic signals
all default to retry. The classifier must be able to cause the factory
to pause a project, but only with evidence in hand.

Fail-open on gate errors: if the classifier itself throws, log a warn
and fall through to the existing retry path. Same principle as the
plan-quality-gate: the classifier must never block the factory due to
its own bug.

## Paused-project recovery

Three operator paths, all converging on the same `probeProjectBaseline`
action:

- **Auto-heal via factory tick** (primary): every `tickProject` call
  for a paused project with `config_json.baseline_broken_since` set
  runs a bare `verify_command` probe on a clean checkout of `main`
  (no worktree). Green probe → clear the flag, set `status='running'`,
  emit `factory:project_baseline_cleared`, resume. Red probe → stay
  paused, log `baseline_probe_still_failing`.
- **Explicit operator trigger**: `resume_project_baseline_fixed` MCP
  tool + `POST /api/v2/factory/projects/:id/baseline-resume` REST
  endpoint. Same probe, runs immediately instead of waiting for tick.
  Returns 200 on green; 409 with probe output preview on red.
- **Dashboard button**: UI sugar wired to the REST endpoint.

Probe backoff: first probe fires on the tick after pause; subsequent
probes use exponentially growing tick-count gaps, capped at 1 probe
per hour. Concretely, the gap between probe N and probe N+1 is
`min(2 ^ (N-1), 12)` ticks (assuming the default 5-min tick interval).
So gaps run 1, 2, 4, 8, 12, 12, 12, ... ticks, which at 5-min ticks
means probes cluster in the first hour (at t=5, 10, 20, 40 min), then
once every 60 minutes thereafter. Caps prevent compounding verify
load per paused project.

## Components

### New file: `server/factory/verify-review.js`

Main entry:

```js
async function reviewVerifyFailure({
  verifyOutput,       // { exitCode, stdout, stderr, timedOut } from the runner
  workingDirectory,   // project path (for git diff)
  worktreeBranch,     // feat/factory-<N>-<slug> (for git diff base)
  mergeBase,          // git merge-base with main (usually 'main')
  workItem,           // { id, title, description }
  project,            // { id, path }
  options = {},       // { llmTimeoutMs }
})
  → {
      classification: 'task_caused' | 'baseline_broken' | 'environment_failure' | 'ambiguous',
      confidence: 'high' | 'medium' | 'low',
      modifiedFiles: [...],
      failingTests: [...],
      intersection: [...],          // paths present in both arrays
      environmentSignals: [...],    // specific strings/codes that triggered env class
      llmVerdict: 'go' | 'no-go' | null,  // 'go' = confirm task_caused/retry; 'no-go' = confirm baseline
      llmCritique: string | null,
      suggestedRejectReason: string | null,  // e.g. 'verify_failed_baseline_unrelated'
    }
```

Internal helpers, exported for tests:

```js
function detectEnvironmentFailure(verifyOutput)
  → { detected: boolean, signals: string[], reason: string | null }

function parseFailingTests(verifyOutput)
  → string[]  // file paths

async function getModifiedFiles(workingDirectory, worktreeBranch, mergeBase)
  → string[]  // file paths

async function runLlmTiebreak({ failingTests, modifiedFiles, workItem, project, timeoutMs })
  → { verdict: 'go' | 'no-go' | null, critique: string | null }
```

Constants:

```js
const LLM_TIMEOUT_MS = 60_000;
const ENVIRONMENT_EXIT_CODES = new Set([127, 126, 124]);  // command-not-found, permission, timeout
const ENVIRONMENT_STDERR_PATTERNS = [/EPERM/, /EACCES/, /ENOENT/, /timeout after \d+/i, /killed by signal/i];
```

### New file: `server/factory/baseline-probe.js`

Single-purpose probe for paused-project recovery:

```js
async function probeProjectBaseline({ project, verifyCommand, runner, timeoutMs })
  → {
      passed: boolean,
      exitCode: number | null,
      output: string,       // combined stdout + stderr, truncated to 4KB
      durationMs: number,
      error: string | null, // 'timeout' | 'runner_threw' | 'no_verify_command' | null
    }
```

Delegates to the existing runner (same path `executeVerifyStage` uses
for task-verify). Runner defaults to the remote workstation when
configured, falls back to local. Checks out a clean copy of `main` on
the runner before invoking `verify_command`.

### Modification: `executeVerifyStage` in `loop-controller.js`

Around the existing non-zero-exit handler (line ~4100), before the
retry-increment branch:

```js
const verifyReview = require('./verify-review');

let review;
try {
  review = await verifyReview.reviewVerifyFailure({
    verifyOutput: res,
    workingDirectory: project.path,
    worktreeBranch: worktreeRecord.branch,
    mergeBase: worktreeRecord.base_branch || 'main',
    workItem: factoryIntake.getWorkItem(instance.work_item_id),
    project,
  });
} catch (err) {
  logger.warn('verify-review classifier failed; falling through to existing retry path', {
    project_id, err: err.message,
  });
  safeLogDecision({
    project_id,
    stage: LOOP_STATES.VERIFY,
    action: 'verify_reviewer_fail_open',
    reasoning: `Classifier threw: ${err.message}. Retrying as before.`,
    outcome: { work_item_id: instance.work_item_id },
    confidence: 1,
    batch_id,
  });
  review = null;
}

if (review && (review.classification === 'baseline_broken' ||
               review.classification === 'environment_failure')) {
  // Reject the item. Pause the project. Emit event. Stop.
  // ...details below
  return { status: 'rejected', reason: review.classification };
}
// Falls through: classification is 'task_caused', 'ambiguous', or null (fail-open).
// Existing retry-increment + retry-task-submission path continues unchanged.
```

When classification is consequential (`baseline_broken` or
`environment_failure`), the executeVerifyStage branch:

1. Emits `factory:project_baseline_broken` (or
   `factory:project_environment_failure`) with the evidence payload.
2. Calls `factoryHealth.updateProject(project.id, { status: 'paused',
   config_json: { ...existing, baseline_broken_since: nowIso(),
   baseline_broken_reason: review.suggestedRejectReason,
   baseline_broken_evidence: { failing_tests, exit_code,
   environment_signals } } })`.
3. Calls `factoryTick.stopTick(project.id)` to halt the 5-minute
   advance timer (the probe-phase of the tick still runs via the
   paused-project scan path).
4. Marks the work item rejected:
   `factoryIntake.updateWorkItem(instance.work_item_id, { status:
   'rejected', reject_reason: review.suggestedRejectReason })`.
5. Writes `safeLogDecision` with action
   `verify_reviewed_baseline_broken` or
   `verify_reviewed_environment_failure` and the full evidence in
   `outcome`.
6. Does NOT abandon the worktree. The code the action provider
   produced may be correct; leave it for operator inspection.

### Modification: `factory-tick.js`

Immediately after the existing `reconcileOrphanWorktrees` step and
before the instance-advance loop, insert a paused-baseline probe:

```js
const baselineProbe = require('./baseline-probe');

if (freshProject && freshProject.status === 'paused') {
  const cfg = getProjectConfig(freshProject);
  if (cfg.baseline_broken_since && shouldRunProbeThisTick(project.id, cfg)) {
    const probe = await baselineProbe.probeProjectBaseline({...});
    if (probe.passed) {
      // Clear flag, resume project, emit event, log decision.
      factoryHealth.updateProject(project.id, {
        status: 'running',
        config_json: { ...cfg, baseline_broken_since: null, ... },
      });
      eventBus.emitFactoryProjectBaselineCleared({ project_id, cleared_after_ms });
      safeLogDecision({ action: 'baseline_probe_cleared', ... });
    } else {
      // Stay paused. Log at debug (probes run every tick by default).
      safeLogDecision({ action: 'baseline_probe_still_failing', ... });
    }
    return; // paused probe path does not advance instances
  }
  // existing auto_continue-resume path stays here for paused projects
  // without baseline_broken_since (those are operator pauses)
}
```

`shouldRunProbeThisTick(project_id, cfg)` implements exponential
backoff keyed on `cfg.baseline_broken_probe_attempts` (incremented on
each probe). Returns true when the current tick count since pause
matches the next backoff slot.

### New MCP tool + REST endpoint

- Tool `resume_project_baseline_fixed({ project })` in
  `server/handlers/factory-handlers.js`.
- Route `POST /api/v2/factory/projects/:id/baseline-resume` in
  `server/api/routes/factory-routes.js`.
- Shared `handleBaselineResume(project_id)`:
  - 400 if project isn't currently `baseline_broken_since` set.
  - 400 if no `verify_command` configured.
  - Runs `probeProjectBaseline` immediately.
  - 200 `{ resumed: true, probe_duration_ms }` on green probe (flag
    cleared, project status back to `running`).
  - 409 `{ error: 'baseline_still_failing', probe_output: '...', exit_code }`
    on red probe (flag stays set, probe output preview returned).

### Event-bus additions: `server/event-bus.js`

```js
emitFactoryProjectBaselineBroken({ project_id, reason, failing_tests, evidence })
  → emit('factory:project_baseline_broken', data)
emitFactoryProjectBaselineCleared({ project_id, cleared_after_ms })
  → emit('factory:project_baseline_cleared', data)
emitFactoryProjectEnvironmentFailure({ project_id, signals, exit_code })
  → emit('factory:project_environment_failure', data)
```

All with matching `on*` helpers following the existing pattern.

### Decision-log actions

New `safeLogDecision` actions in the existing pattern:

- `verify_reviewed_task_caused`
- `verify_reviewed_baseline_broken`
- `verify_reviewed_environment_failure`
- `verify_reviewed_ambiguous_retrying`
- `verify_reviewer_fail_open` (classifier exception)
- `baseline_probe_cleared`
- `baseline_probe_still_failing`
- `baseline_probe_runner_unreachable`

### Data model

No new DB tables or columns. Paused-project state persists via
`factory_projects.config_json` (existing JSON blob):

```json
{
  "loop": { "auto_continue": true },
  "baseline_broken_since": "2026-04-19T14:12:00.000Z",
  "baseline_broken_reason": "verify_failed_baseline_unrelated",
  "baseline_broken_evidence": {
    "failing_tests": ["tests/legacy_reconciler_test.py"],
    "exit_code": 1,
    "environment_signals": []
  },
  "baseline_broken_probe_attempts": 3
}
```

Presence of `baseline_broken_since` is the "is this project
baseline-broken?" signal. All other fields are audit/observability.

## Error handling

### Classifier throws

Fail-open: log a warn, emit `verify_reviewer_fail_open` decision,
continue with the existing retry path. The classifier never blocks
the factory due to its own bug.

### LLM pass errors

- Timeout: returns null from `runLlmTiebreak`.
- Provider error (4xx/5xx, no key configured): returns null.
- Unparseable output: returns null.
- Timeout budget: 60 seconds, no retry.

Fallback rule: when the deterministic pass says `baseline_candidate`
and the LLM returns null, classify as `ambiguous` (not
`baseline_broken`). Conservative — never pauses a project without
positive LLM agreement.

### Test-output parsing failures

When `parseFailingTests` returns an empty list (format unknown,
output truncated, runner crashed early):

- Deterministic classification: `ambiguous`.
- LLM runs with an empty failing-test list.
- If LLM also can't tell → returns null → classification stays
  `ambiguous` → retry-as-before.

No project pause without both a concrete failing-test list AND
positive LLM agreement.

### Git diff errors

`getModifiedFiles` returns `[]` on any git error (worktree missing,
merge-base command fails, spawn error). Intersection becomes empty;
classification cascades through to LLM as above. Same safe fallback.

### Probe errors in factory-tick

```js
try {
  const probe = await baselineProbe.probeProjectBaseline(...);
  if (probe.passed) { /* clear flag */ }
  else { /* stay paused */ }
} catch (err) {
  logger.debug('factory-tick: baseline probe failed', { err: err.message });
  // Stay paused. Next tick will retry.
}
```

Probe errors never clear the flag — only `exitCode === 0` does.

### Probe runner unreachable

When the remote workstation is unreachable and `torque-remote` falls
back to local, probe may still succeed. If both remote and local are
unavailable, probe returns `{ passed: false, error: 'runner_threw' }`
→ stays paused → next tick retries.

A project stays paused while the runner is down, even if the
baseline is actually fine. Acceptable: under-resume is safer than
over-resume into still-broken test suites.

### Worktree cleanup after baseline pause

When verify-review rejects an item with `baseline_broken` class, the
task's worktree stays. The code the action provider produced may be
correct; leave it for operator inspection. Matches the existing
`verify_failed_after_N_retries` cleanup pattern (no auto-abandon).

Future work: a "resubmit worktree" flow for paused items — out of
scope for this design.

### Concurrency

Two verify-review evaluations may race if two worktrees fail verify
at the same time for the same project. Both may call the pause path.
Writes are idempotent (`updateProject` overwrites; timestamp differs
slightly, second write wins harmlessly). Two events emit; subscribers
see two events for the same cause, which is expected signal behavior.

## Testing

### Unit tests: `server/tests/verify-review.test.js`

Each classifier branch gets positive + negative coverage. Test
fixtures compose verify-output, diff-paths, and failing-test-paths
as plain JS objects — no real git or test-runner needed for
deterministic-pass tests.

**Environment-failure detection:**

- Exit 127 → `environment_failure`, signal `command_not_found`
- `timedOut: true` → `environment_failure`, signal `timeout`
- Exit 1 with normal test-runner output → not environment
- stderr containing `EPERM` / `EACCES` → environment

**File-path intersection:**

- `failingTests=['tests/foo.test.ts']` + `modifiedFiles=['tests/foo.test.ts']` →
  `task_caused` high, LLM not called
- `failingTests=['tests/foo.test.ts']` + `modifiedFiles=['src/bar.ts']` →
  `baseline_candidate`, LLM called
- `failingTests=['tests/foo.test.ts']` +
  `modifiedFiles=['tests/foo.test.ts','src/bar.ts']` → `task_caused`
- Empty `failingTests` + non-empty `modifiedFiles` → `ambiguous`, LLM called
- Empty `failingTests` + empty `modifiedFiles` → `ambiguous`, LLM called

**LLM tiebreak:**

- Deterministic `baseline_candidate` + LLM returns `no-go` + critique →
  `baseline_broken`, confidence high, critique in output
- Deterministic `baseline_candidate` + LLM returns `go` → `task_caused`,
  confidence medium (LLM overruled deterministic)
- Deterministic `baseline_candidate` + LLM times out (null) →
  `ambiguous`, confidence low
- Deterministic `ambiguous` + LLM returns `go` → `task_caused`,
  confidence low
- Deterministic `ambiguous` + LLM returns `no-go` → `baseline_broken`,
  confidence medium

**Test-runner output parsing:**

- pytest `FAILED tests/foo.py::test_bar` → `['tests/foo.py']`
- vitest `❯ src/foo.test.ts > describe > it` → `['src/foo.test.ts']`
- dotnet test `Failed! - Failed: 3` with `Files: tests/Foo.Tests.dll`
  → `['tests/Foo.Tests.dll']`
- Empty output → `[]`
- Unknown format → `[]` (falls through to ambiguous classification)

**Output shape:**

- Every branch returns the full schema from the `reviewVerifyFailure`
  signature.
- `suggestedRejectReason` matches classification.

### Unit tests: `server/tests/baseline-probe.test.js`

- Stubbed runner returning `{ exitCode: 0 }` → `passed: true`
- Runner returns `{ exitCode: 1, stdout: 'FAIL' }` → `passed: false`,
  output preserved
- Runner throws → returns `{ passed: false, error: 'runner_threw' }`
- Timeout — mock runner that never resolves → `passed: false,
  error: 'timeout'`
- No `verify_command` configured → `{ passed: false,
  error: 'no_verify_command' }`

### Integration tests: `server/tests/factory-verify-review-integration.test.js`

End-to-end through `executeVerifyStage`:

- Scenario 1: `task_caused` → retry fires, existing flow unchanged
- Scenario 2: `baseline_broken` (LLM confirms) → item rejected with
  `verify_failed_baseline_unrelated`, project paused with
  `baseline_broken_since`, event emitted
- Scenario 3: `environment_failure` (exit 127) → item rejected with
  `verify_failed_environment`, project paused, event emitted
- Scenario 4: `ambiguous` (deterministic + LLM null) → retry fires
  (conservative default)
- Scenario 5: `baseline_candidate` + LLM says `go` → retry fires, not
  paused
- Scenario 6: classifier throws → retry fires (fail-open), decision
  log has `verify_reviewer_fail_open`

### Integration tests: `server/tests/factory-baseline-probe-integration.test.js`

- Tick on paused project with `baseline_broken_since` set:
  - Probe passes → project resumed, flag cleared, event emitted
  - Probe fails → project stays paused, `baseline_probe_still_failing` logged
  - Probe throws → stays paused, flag unchanged
- Exponential backoff: probes fire at ticks `[1, 2, 4, 8, 16, 28, 40, 52, ...]`
  (absolute tick index since pause). Gap sequence: `[1, 2, 4, 8, 12, 12, 12, ...]`
  (capped at 12 ticks = 60 min at the default 5-min cadence).
- `resume_project_baseline_fixed` MCP tool:
  - Project not baseline-flagged → 400
  - Project baseline-flagged, probe passes → 200, flag cleared
  - Project baseline-flagged, probe fails → 409, probe output preview
  - Project has no `verify_command` → 400

### Lint coverage

Classifier and probe live under `server/factory/`. Today's lint rules
apply:

- `no-hardcoded-factory-provider` — the LLM tiebreak routes through
  `submitFactoryInternalTask` + `plan_generation` category, not a
  hardcoded provider.
- `no-spawn-sync-in-factory` — `getModifiedFiles` uses async `spawn`,
  not `spawnSync`. Probe delegates to the existing async runner.

### Regression coverage for existing surface

- Existing `executeVerifyStage` tests in
  `server/tests/factory-loop-controller.test.js` (grep
  `verify_failed_after_3_retries`) — their assertions around
  `reject_reason` string should pass unchanged when the classifier
  returns `task_caused` (retries exhaust, existing path fires).
- If any existing test asserts exact decision-log entries in the verify
  path, add `verify_reviewed_task_caused` to the expected list.
- Full suite: `npx vitest run` on the merged branch; 0 failures
  required before merging.

## Out of scope

- AST-level import-graph dependency analysis. Deferred: deterministic
  file-path intersection + LLM tiebreak covers the common cases; add
  graph analysis only if v1 telemetry shows LLM catching too much.
- "Resubmit worktree" flow for items paused by baseline-broken (operator
  fixes baseline, wants to re-verify the task's existing worktree).
- Structured rejection metadata for a factory-self-improvement loop.
  The `reviewVerifyFailure` output schema is machine-readable and
  cluster-friendly; a future learning layer can consume it without
  extra work here. Out of scope to build that layer in this design.
- Per-project probe cadence tuning. Exponential backoff to 60min max
  is the only knob; finer control deferred.
- Dashboard UI button wiring. Covered in scope as "a button that calls
  the REST endpoint" but the full UI implementation belongs to the
  frontend work, not this backend design.

These are candidates for v2 once the v1 telemetry (classification
breakdown, false-positive rate, probe frequency, operator-override
usage) tells us what actually matters.
