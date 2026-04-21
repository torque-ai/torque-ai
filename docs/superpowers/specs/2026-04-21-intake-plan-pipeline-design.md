# Intake / plan pipeline improvements — design

**Date:** 2026-04-21
**Scope:** Cluster B of the factory self-improvement initiative — three related changes to the PRIORITIZE → PLAN pipeline, sharing the intake queue and scout-findings metadata.
**Status:** Draft, pending user review.

## Context

Factory analysis on 2026-04-20 surfaced three pathologies in the intake/plan pipeline:

- **Plan quality gate rejection tax.** 33 `replan_feedback` Codex tasks in the recent window. The plan-quality gate accepts a plan on first try ~71% of the time; the remaining 29% go through a full Codex re-plan cycle with the gate's violations as feedback. Each rejection costs one Codex plan-gen round-trip (~30s and one slot). The rules are known up front in `server/factory/plan-quality-gate.js` — the architect prompt does not currently include them, so the LLM re-derives what "a good task body" looks like on every call.
- **Scout findings sit in the backlog behind plan_files.** 94 scout items intake'd; only 9 shipped. Scout findings (security, performance, quality issues) are consistently beaten by plan_file items at the same numeric priority because the selection tie-breaks on creation order, and plan_files arrive first. When project scores drop (structural, security, user-facing), there is no mechanism to promote relevant scout findings.
- **Stale scout findings waste plan-gen + execute cycles.** Scout findings from a prior week may already have been fixed by unrelated commits. The current pipeline plans and executes against them anyway — sometimes producing zero-diff completions, sometimes re-applying already-present fixes.

## Goals

1. Embed plan-quality rules into the architect prompt so plans pass the gate on first try more often.
2. Promote scout findings ahead of plan_files when their severity or the project's weakest score dimensions justify it.
3. Retire scout findings that have been addressed by post-scan commits, before burning a plan-gen cycle on them.

## Non-goals

- Changing the plan-quality gate itself. RULES and their thresholds stay as-is; this spec only *surfaces* them to the LLM.
- Replacing the existing `buildArchitectPrompt` architecture — one new helper composes the guide; the call site already accepts an injected guide via `injectPlanAuthoringGuide`.
- Building a scout re-runner. Stale-probe uses cheap git-level signals, not another scout invocation.
- Adding UI for any of this. All config is via `factory_projects.config_json`; all observability is decision-log + existing dashboard tables.

## Architecture

Three new modules, no new tables, one status-enum addition.

```
                       ┌────────────────────────────────┐
                       │ plan-quality-gate.js (unchanged│
                       │  except add `description` per  │
                       │  rule)                         │
                       └───────┬────────────────────────┘
                               │ read RULES
                               ▼
             ┌────────────────────────────────────┐
             │  plan-authoring-guide.js (new)     │
             │  composeGuide({rulesSource,        │
             │                examplesBlock})     │
             └───────┬────────────────────────────┘
                     │
                     ▼
    ┌───────────────────────────────┐       ┌─────────────────────────────┐
    │ architect-runner.js           │       │ loop-controller.js          │
    │ (existing)                    │       │ (existing)                  │
    │   injectPlanAuthoringGuide(   │       │   PRIORITIZE branch         │
    │     buildArchitectPrompt(...),│       │                             │
    │     composeGuide()            │       │   candidates =              │
    │   )                           │       │     listIntake(project_id)  │
    └───────────────────────────────┘       │        │                    │
                                            │        ▼                    │
                                            │   rankIntake(candidates,    │
                                            │     {scores, cfg})          │
                                            │        │                    │
                                            │        ▼                    │
                                            │   probeStaleness(winner)    │
                                            │   → shipped_stale? repick   │
                                            └──────┬──────────────────────┘
                                                   │
                               ┌───────────────────┴───────────────────┐
                               ▼                                       ▼
                 ┌─────────────────────────────┐         ┌─────────────────────────────┐
                 │ promotion-policy.js (new)   │         │ stale-probe.js (new)        │
                 │  rankIntake(items, {        │         │  probeStaleness(item, {     │
                 │    projectScores,           │         │    projectPath,             │
                 │    promotionConfig, now     │         │    gitRunner, now           │
                 │  })                         │         │  })                         │
                 └─────────────────────────────┘         └─────────────────────────────┘
```

### Data backbone

**No new tables.** The spec uses existing columns:

- `factory_work_items.priority` / `source` / `created_at` — consumed by promotion policy's tie-breaks.
- `factory_work_items.origin_json` — scout items carry `severity`, `target_file`, `variant`, `scan_path`, `finding_hash`, `suggested_fix` here. Promotion and stale probe read these fields.
- `factory_projects.scores` — five dimension scores, already computed; promotion policy reads them.
- `factory_projects.config_json.scout_promotion` — new optional object for tuning; absent means use defaults.

**Status-enum addition.** Add `'shipped_stale'` to the statuses used on `factory_work_items`. The column is free-text TEXT (per the comment at top of `migrations.js`), so no schema migration is required. The dashboard view logic that enumerates statuses (if any) gets `shipped_stale` added to its display map as a follow-up if needed.

**Config shape** under `factory_projects.config_json.scout_promotion`:

```json
{
  "severity_floor": "HIGH",
  "score_trigger": {
    "structural": 60,
    "security": 75,
    "user_facing": 60,
    "performance": 70,
    "test_coverage": 60,
    "documentation": 50,
    "dependency_health": 70,
    "debt_ratio": 50
  },
  "stale_probe_enabled": true,
  "stale_max_repicks": 3,
  "stale_churn_threshold": 5
}
```

All fields optional. `DEFAULT_PROMOTION_CONFIG` in `promotion-policy.js` supplies any missing field.

## Module: `server/factory/plan-authoring-guide.js`

Pure function, no DB access.

**Signature:**

```js
function composeGuide({
  rulesSource = RULES,         // imported from plan-quality-gate
  examplesBlock = DEFAULT_EXAMPLES,
} = {}) {
  return [
    '## Plan authoring rules',
    '',
    'Every plan you produce goes through a quality gate. Plans that violate',
    'these rules are rejected and re-planning burns a Codex slot. Comply on',
    'the first pass.',
    '',
    ...renderRuleList(rulesSource),
    '',
    '## Good task body anatomy',
    '',
    examplesBlock,
  ].join('\n');
}
```

### Rule-list rendering

Each rule in `RULES` (plan-quality-gate.js) gains a `description` field — a one-line English restatement of the check. Example (added in that file, not this module):

```js
const RULES = {
  plan_has_task_heading: {
    severity: 'hard', scope: 'plan',
    description: 'Each task must begin with a "### Task N: ..." heading.',
  },
  task_body_min_length: {
    severity: 'hard', scope: 'task', min: 100,
    description: 'Task bodies must be at least 100 characters of concrete instruction.',
  },
  task_has_file_reference: {
    severity: 'hard', scope: 'task',
    description: 'Every task body must reference at least one file path.',
  },
  task_has_acceptance_criterion: {
    severity: 'hard', scope: 'task',
    description: 'Every task must state an acceptance criterion — a test command, an assertion, or a specific observable outcome.',
  },
  task_avoids_vague_phrases: {
    severity: 'hard', scope: 'task', minHits: 1,
    description: 'Avoid vague phrases ("improve", "update", "clean up", "refactor accordingly") unless accompanied by a concrete file path, function name, or symbol.',
  },
  // ... one description per rule key
};
```

`renderRuleList(rulesSource)` returns an array of markdown bullets, sorted by rule key for stable output. Hard rules are rendered plainly; warn-severity rules are prefixed `(soft)` so the LLM treats them differently.

### Examples block

`DEFAULT_EXAMPLES` is a template string in the module. Concrete good/bad pair:

````markdown
**Good** — concrete, testable, self-contained:

    ### Task 3: Normalize test-name paths in verify-signature

    **Files:**
    - Modify: `server/factory/verify-signature.js`
    - Test:   `server/tests/verify-signature.test.js`

    - [ ] Step 1: Replace the non-greedy path regex with a
          per-token strip-to-last-slash helper.
    - [ ] Step 2: Run `torque-remote npx vitest run
          server/tests/verify-signature.test.js`.
          Expected: 6 passing tests.

**Bad** — vague and untestable:

    ### Task 3: Improve path handling

    Clean up the path regex in verify-signature so it works
    better on Windows paths. Update the tests as needed.
````

Co-located with the composer; deliberately short.

### Wiring

`architect-runner.js:577` currently reads:

```js
const prompt = injectPlanAuthoringGuide(buildArchitectPrompt({ ... }));
```

After this spec: `injectPlanAuthoringGuide` takes the guide as its second arg (today it reads from a fixed file). The call becomes:

```js
const { composeGuide } = require('./plan-authoring-guide');
const prompt = injectPlanAuthoringGuide(buildArchitectPrompt({ ... }), composeGuide());
```

The existing guide-file reader path stays as a fallback if `composeGuide()` throws.

## Module: `server/factory/promotion-policy.js`

Pure function, consumed by PRIORITIZE.

**Signature:**

```js
function rankIntake(items, {
  projectScores,
  promotionConfig = DEFAULT_PROMOTION_CONFIG,
  now = new Date(),
}) {
  // returns items sorted by composite key, highest priority first
}
```

### Composite sort key

For each item, compute a five-element key and sort ascending on it:

1. `severity_bucket` — `0=CRITICAL, 1=HIGH, 2=MEDIUM, 3=LOW, 4=N/A`. Non-scout items land in `N/A`.
2. `promotion_tier` — `0` if the item qualifies for promotion (see below), `1` otherwise.
3. `negated_priority` — `-item.priority` (so higher priority sorts first ascending).
4. `source_tiebreak` — `0=scout, 1=manual, 2=plan_file, 3=conversation`.
5. `age_tiebreak` — `-item.created_at_ms` (older first).

### `promotion_tier` logic

```js
function computeTier(item, scores, cfg) {
  if (item.source !== 'scout') return 1;
  const severity = normalizeSeverity(item.origin?.severity);
  if (severity === 'CRITICAL') return 0;              // CRITICAL always promotes
  if (rank(severity) <= rank(cfg.severity_floor)) {    // HIGH or above when floor=HIGH
    const relevantDims = SCORE_MAP[item.origin?.variant] || ALL_DIMS;
    const triggered = relevantDims.some((dim) => {
      const score = scores[dim];
      const threshold = cfg.score_trigger[dim];
      return score != null && threshold != null && score < threshold;
    });
    if (triggered) return 0;
  }
  return 1;
}
```

### `SCORE_MAP` — variant → relevant score dimensions

| Variant | Triggering dimensions |
|---|---|
| `security` | `security`, `debt_ratio` |
| `quality` | `structural`, `debt_ratio`, `test_coverage` |
| `performance` | `performance`, `structural` |
| `visual` | `user_facing` |
| `accessibility` | `user_facing` |
| `test-coverage` | `test_coverage` |
| `documentation` | `documentation` |
| `dependency` | `dependency_health` |
| _unknown/unset_ | `ALL_DIMS` (trigger if any below threshold) |

`ALL_DIMS = Object.keys(DEFAULT_PROMOTION_CONFIG.score_trigger)` — eight dimensions: `structural, security, user_facing, performance, test_coverage, documentation, dependency_health, debt_ratio`. Stored as a constant next to the function. Adding a variant is a one-line change.

### Defaults

```js
const DEFAULT_PROMOTION_CONFIG = {
  severity_floor: 'HIGH',
  score_trigger: {
    structural: 60,
    security: 75,
    user_facing: 60,
    performance: 70,
    test_coverage: 60,
    documentation: 50,
    dependency_health: 70,
    debt_ratio: 50,
  },
  stale_probe_enabled: true,
  stale_max_repicks: 3,
  stale_churn_threshold: 5,
};
```

### Observability

`rankIntake` emits one `scout_promoted` decision per PRIORITIZE advance *only when at least one item was promoted* (tier changed from 1 to 0 for a scout). Outcome payload carries: `promoted_ids`, `promoted_severities`, `triggering_dims` (which scores were below threshold), `config_hash`. If no promotion occurred, no entry — avoids log noise on every advance.

## Module: `server/factory/stale-probe.js`

Async function called from PRIORITIZE immediately after `rankIntake` returns its ordered list.

**Signature:**

```js
async function probeStaleness(item, {
  projectPath,
  promotionConfig = DEFAULT_PROMOTION_CONFIG,
  now = new Date(),
  gitRunner = defaultGitRunner,
}) {
  // returns: { stale, reason, commits_since_scan, probe_ms }
}
```

### Gate sequence

**Gate 1 — eligibility.**

```js
if (item.source !== 'scout')           return { stale: false, reason: 'not_scout_eligible' };
if (!item.origin?.target_file)         return { stale: false, reason: 'no_target_file' };
if (!cfg.stale_probe_enabled)          return { stale: false, reason: 'probe_disabled' };
```

**Gate 2 — path safety.** Resolve `target_file` against `projectPath`; if the resolved path escapes the project root, reject.

```js
const abs = path.resolve(projectPath, item.origin.target_file);
const resolvedRoot = path.resolve(projectPath);
if (!abs.startsWith(resolvedRoot + path.sep)) {
  return { stale: false, reason: 'invalid_target_path' };
}
```

**Gate 3 — file existence.**

```js
if (!fs.existsSync(abs)) {
  return { stale: true, reason: 'target_file_deleted', commits_since_scan: 0 };
}
```

**Gate 4 — git commit trail since scan.**

```js
// scout-findings-intake does not store scan_timestamp on origin today;
// item.created_at (when the intake row was written) approximates
// scan time closely enough for the probe's purposes. Keep the
// `?? origin.scan_timestamp` path as forward-compat.
const scanTs = item.origin?.scan_timestamp || item.created_at;
const { stdout } = await withTimeout(
  gitRunner(projectPath, [
    'log',
    `--since=${scanTs}`,
    '--pretty=format:%H',
    '--',
    item.origin.target_file,
  ]),
  3000,
);
const commits = stdout.trim().split(/\r?\n/).filter(Boolean);
```

- If `commits.length === 0` → `{ stale: false, reason: 'no_commits_since_scan' }`. Finding is almost certainly still valid.
- If `commits.length < cfg.stale_churn_threshold` (default 5) → `{ stale: false, reason: 'minor_churn_probably_valid', commits_since_scan }`.
- If `commits.length >= cfg.stale_churn_threshold` → `{ stale: true, reason: 'substantial_churn', commits_since_scan }`.

**Timeout behavior.** The 3-second wrapper throws on timeout; caller catches and returns `{ stale: false, reason: 'probe_timeout' }`. Fail-open: never skip an item because git was slow.

### PRIORITIZE consumer

In `loop-controller.js` PRIORITIZE branch, after today's candidate fetch:

```js
const ranked = rankIntake(candidates, { projectScores, promotionConfig });
const skipped = [];
let winner = null;
for (let i = 0; i < ranked.length && skipped.length < promotionConfig.stale_max_repicks; i++) {
  const candidate = ranked[i];
  let probe;
  try {
    probe = await probeStaleness(candidate, { projectPath: project.path, promotionConfig });
  } catch (err) {
    logger.warn('stale_probe_threw', { err: err.message, work_item_id: candidate.id });
    probe = { stale: false, reason: 'probe_errored' };
  }
  if (probe.stale) {
    try {
      factoryIntake.updateWorkItem(candidate.id, {
        status: 'shipped_stale',
        metadata: {
          stale_reason: probe.reason,
          commits_since_scan: probe.commits_since_scan,
          probed_at: now.toISOString(),
        },
      });
    } catch (err) {
      logger.warn('stale_status_write_failed', { err: err.message, work_item_id: candidate.id });
    }
    safeLogDecision({
      project_id, stage: LOOP_STATES.PRIORITIZE,
      action: 'skipped_stale_scout_item',
      reasoning: `Scout finding no longer reproduces: ${probe.reason}`,
      outcome: { work_item_id: candidate.id, ...probe },
      confidence: 1,
    });
    skipped.push(candidate.id);
    continue;
  }
  winner = candidate;
  break;
}
if (!winner) {
  safeLogDecision({
    project_id, stage: LOOP_STATES.PRIORITIZE,
    action: 'stale_probe_starvation',
    reasoning: `Top ${skipped.length} candidates all marked stale; falling back to ranked[0].`,
    outcome: { skipped },
    confidence: 1,
  });
  winner = ranked[0];
}
```

Caps: at most `stale_max_repicks = 3` probes per advance. Total added wall-clock: 3 × 3s = 9s worst case. Typical: ~150ms total (three small git-log invocations).

## Data flow

### Happy path — promoted CRITICAL scout ships

```
scout drops CRITICAL finding in docs/findings/<date>-security-scan.md
  └─ scout-findings-intake parses file, inserts factory_work_items row
        (source=scout, priority=70, origin.severity=CRITICAL, target_file=<path>)

Factory tick → PRIORITIZE branch
  ├─ listIntake returns candidates [critical_scout, high_scout, plan_file_65]
  ├─ rankIntake reorders:
  │    tier 0: critical_scout (CRITICAL → tier 0 unconditionally)
  │    tier 1: high_scout, plan_file_65
  ├─ probeStaleness(critical_scout):
  │    target_file exists, zero commits since scan → not stale
  ├─ safeLogDecision(scout_promoted, outcome: { promoted_ids: [critical_scout.id], ... })
  └─ selected_work_item: critical_scout
```

### Stale path — HIGH scout with churned file is skipped

```
PRIORITIZE
  ├─ rankIntake reorders: [high_scout_A, high_scout_B, plan_file_65]
  ├─ probeStaleness(high_scout_A):
  │    target_file exists, 7 commits since scan → substantial_churn → stale
  ├─ markStatus(high_scout_A, shipped_stale, { stale_reason: 'substantial_churn', ... })
  ├─ safeLogDecision(skipped_stale_scout_item, outcome: { ... })
  ├─ probeStaleness(high_scout_B):
  │    target_file exists, 1 commit since scan → not stale
  └─ selected_work_item: high_scout_B
```

### Plan-gen preemption path

```
PRIORITIZE advances PLAN
  └─ architect-runner
        ├─ buildArchitectPrompt(...)
        ├─ composeGuide() — rules + examples
        ├─ injectPlanAuthoringGuide(prompt, guide)
        └─ submit to Codex → plan with task bodies that pass the quality gate
              → plan_quality_passed (not plan_quality_rejected_will_replan)
```

## Error handling

Every failure path in this spec preserves today's PRIORITIZE behavior. Failures never pause or crash the loop.

| Failure | Detection | Fallback |
|---|---|---|
| `composeGuide` throws | try/catch in architect-runner | Fall back to the previous guide-file path; log `plan_authoring_guide_compose_failed` at warn. |
| Rule missing `description` field | `renderRuleList` throws if it finds a RULES key without a description | Same as above — the existing guide file is used. A unit test asserts full coverage so this shouldn't reach production. |
| `rankIntake` throws | try/catch in PRIORITIZE | Use `candidates` in today's order; log `promotion_policy_failed` at warn. |
| `promotionConfig` JSON parse fails | try/catch around `JSON.parse(project.config_json)` | Use `DEFAULT_PROMOTION_CONFIG`; log `promotion_config_parse_failed` at warn. |
| `probeStaleness` throws | try/catch in PRIORITIZE | `{ stale: false, reason: 'probe_errored' }`; log at warn. Item stays selectable. |
| `git log` timeout (> 3s) | `withTimeout` wrapper | `{ stale: false, reason: 'probe_timeout' }`. Never mark stale on timeout. |
| Git binary missing | `spawn ENOENT` caught inside probe | `{ stale: false, reason: 'git_unavailable' }`. Log once per process. |
| `target_file` path traversal (`..`) | `path.resolve` + `startsWith(projectRoot)` check | `{ stale: false, reason: 'invalid_target_path' }`. |
| `factoryIntake.updateWorkItem('shipped_stale', ...)` write fails | try/catch around the status update | Log `stale_status_write_failed`; continue — item will be re-probed next tick. |
| All top N candidates stale (`stale_max_repicks` exhausted) | loop bound | Fall back to `ranked[0]` unconditionally; emit `stale_probe_starvation` decision. |

**Invariant:** fail-open. The promotion + stale-probe pipeline never increases the loop's failure surface.

## Feature flags

| Flag | Default | Gates |
|---|---|---|
| `factory.scout_promotion.stale_probe_enabled` | `true` | Gate 1 of `probeStaleness`. Flipping false disables all stale probing per-project without a redeploy. |

No flag for `rankIntake` — when nothing qualifies for promotion, the output is identical to today's order, so gating adds friction without safety.

No flag for the plan-authoring guide — the composed guide replaces the existing guide unconditionally. If it misbehaves the fix is a follow-up commit, not a flag.

## Testing

### Unit

- `plan-authoring-guide.test.js`
  - RULES key coverage: every key in `RULES` has a `description` field (enumeration test).
  - `composeGuide()` produces markdown with expected section headers.
  - Degenerate `composeGuide({ rulesSource: {}, examplesBlock: '' })` returns a valid-but-minimal guide.
  - Snapshot of the full composed output so regressions are visible on PR.

- `promotion-policy.test.js`
  - CRITICAL scout always lands in tier 0 regardless of scores.
  - HIGH scout promotes only when a relevant dimension is below threshold.
  - MEDIUM/LOW scouts never promote.
  - Same-tier tie-break chain: priority → source → age.
  - Unknown variant uses `ALL_DIMS` fallback.
  - Missing / empty / malformed `promotionConfig` uses `DEFAULT_PROMOTION_CONFIG`.
  - `scout_promoted` decision fires only when at least one item changed tier.

- `stale-probe.test.js`
  - Non-scout item and disabled flag both skip (Gate 1).
  - Path traversal target rejected (Gate 2).
  - Missing file → stale (Gate 3).
  - Injected `gitRunner`: 0 commits → not stale; `< stale_churn_threshold` commits → `minor_churn_probably_valid`; `>=` threshold → `substantial_churn`.
  - Timeout path returns `probe_timeout`, not stale.
  - Git binary missing returns `git_unavailable`, not stale.

### Integration

- `factory-cluster-b-integration.test.js`
  - Synthetic PRIORITIZE advance with three candidates (CRITICAL-scout, plan_file-at-priority-65, HIGH-scout-with-variant-triggering-low-score). Assert `rankIntake` order matches spec.
  - Seed a tmpdir git repo: `git init`, commit a file, wait a beat, commit again. Call `probeStaleness` with `scan_timestamp` before both commits; assert `commits_since_scan >= 2`.
  - Mark a file target with 6 commits since scan → assert item is marked `shipped_stale` and the decision-log entry is emitted.
  - Run `stale_max_repicks=1`; if both top two candidates are stale, assert fallback to `ranked[0]` and `stale_probe_starvation` decision fires.

- Full-suite regression: `torque-remote npx vitest run server/tests/` must stay green (no new test failures elsewhere).

### Test hygiene

- Tests hit a real ephemeral SQLite via the existing test harness; no DB mocks (per `feedback_test_on_omen`).
- Git integration test uses a real tmpdir + `git init` + `git commit` rather than mocking `child_process.spawn`.
- RULES-coverage test imports from the real `plan-quality-gate.js` — no shadow copy.

## Success metrics

All measurable from existing `factory_decisions` + `factory_work_items`.

| Metric | Source | Target |
|---|---|---|
| `replan_feedback` Codex tasks per week | Count of tasks with `## Prior plan rejected` prefix in description | Drop ≥ 40% within a week |
| Plan-quality first-pass acceptance rate | `plan_quality_passed / (plan_quality_passed + plan_quality_rejected_will_replan)` | From 71% (5/7 in the analysis window) to ≥ 85% |
| Scout items shipped per week | `factory_work_items.status='shipped'` where `source='scout'` | From 9/157 today to ≥ 25/week once promotion is live |
| `scout_promoted` decisions per week | Decision log count | Track; should be non-zero whenever any score is below threshold |
| Stale-skip rate | `skipped_stale_scout_item / total PRIORITIZE selections` | Track; alert if > 30% (threshold may be too low) |
| `shipped_stale` items per week | `status='shipped_stale'` | Track; non-zero means the probe is retiring work we'd otherwise waste time on |

## Rollout

1. **Ship all three modules together.** `stale_probe_enabled` defaults on; promotion is unflagged. Merge + cutover via `scripts/worktree-cutover.sh intake-plan-pipeline`.
2. **Watch for 48h.** Monitor `plan_quality_rejected_will_replan` (should drop), `scout_promoted` (should appear when a score is low), `skipped_stale_scout_item` (should be moderate).
3. **Tune if needed.** If stale-skip rate is too high, bump `stale_churn_threshold` from 5 to 8 per-project. If promotion fires too rarely, lower `score_trigger` thresholds. Both are `config_json` edits — no redeploy.
4. **No gated flip required.** All three changes are safe-by-construction: fail-open, fallback to today's behavior on any error.

## Open questions

None at spec-approval time. Tuning of `stale_churn_threshold`, the exact wording of the examples block, and any new scout variants' `SCORE_MAP` row are resolved during implementation.

## Appendix: touched files

**New:**
- `server/factory/plan-authoring-guide.js`
- `server/factory/promotion-policy.js`
- `server/factory/stale-probe.js`
- `server/tests/plan-authoring-guide.test.js`
- `server/tests/promotion-policy.test.js`
- `server/tests/stale-probe.test.js`
- `server/tests/factory-cluster-b-integration.test.js`

**Edited:**
- `server/factory/plan-quality-gate.js` — add `description` field to every RULES entry.
- `server/factory/architect-runner.js` — call `composeGuide()` and pass to `injectPlanAuthoringGuide`.
- `server/factory/loop-controller.js` — PRIORITIZE branch gains `rankIntake` + `probeStaleness` pass before `selected_work_item`.

**Unchanged:**
- Plan-quality gate itself. Rules, thresholds, and vague-phrase detection stay as-is. This spec only surfaces them to plan-gen.
- Scout-findings intake. The metadata it writes to `origin_json` already carries everything `probeStaleness` needs.
- Decision-log schema.
