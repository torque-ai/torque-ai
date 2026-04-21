# Close-handler & retry observability — design

**Date:** 2026-04-20
**Scope:** Cluster A of the factory self-improvement initiative — three related changes that share one data backbone.
**Status:** Draft, pending user review.

## Context

Analysis of 9 days of torque-public factory activity (354 work items, 881 tasks, 150 decision-log entries):

- **19% of `Plan:` execute tasks (55/291) produce no file modifications** — Codex returns success, worktree stays clean, factory falls through to verify which retries with error context. Roughly 7.9h / week of Codex time spent on zero-diff completions.
- **Ambiguous-verify** is the second pathology: the classifier returns `ambiguous` confidence and the code falls straight through to `submitVerifyFixTask` — burning a Codex slot on what is often a flaky test or transient remote-env blip.
- **Retry prompt context is thin** — `buildVerifyFixPrompt` (loop-controller.js:4532) feeds Codex only the plan title, branch, verify command, and tail of verify output. No signal about what prior attempts did, whether they produced a diff, or how verify output evolved between attempts. Codex has to re-derive state every retry.

These three failure modes share two files (`worktree-auto-commit.js`, `loop-controller.js`) and the same missing primitive: a per-attempt history that persists what Codex did, whether it changed files, and its own summary.

## Goals

1. Capture a rationale (not just "the worktree is clean") for every zero-diff execute completion.
2. Auto-route clean-worktree completions that Codex self-reports as "already in place" to ship-noop, skipping the verify stage entirely.
3. On ambiguous verify, rerun verify once silently before spawning a fix task.
4. On every verify retry, prepend structured prior-attempt context to the Codex fix prompt so it can make progress instead of re-deriving state.

## Non-goals

- Any change to scout/intake prioritization, plan-quality gate, or cancellation-reason fields. Those belong to Clusters B and C.
- Re-architecting the close-handler pipeline. All changes are additive; existing decision-log actions continue to fire.
- New dashboards or UI. Observability arrives as decision-log entries and a new table queryable via existing MCP surfaces.
- Touching the Codex provider adapter. All new data is captured from `stdout_tail` that the provider already persists on the `tasks` row.

## Architecture

One new table, one new module, and targeted edits to two existing files.

```
                 ┌──────────────────────────────────────────────┐
                 │             factory_attempt_history          │
                 │   (append-only, indexed by batch_id,attempt) │
                 └───────────────▲───────────────────▲──────────┘
                                 │ write             │ read
      ┌──────────────────────────┤                   ├──────────────────────────┐
      │                          │                   │                          │
┌─────┴─────┐   calls       ┌────┴──────┐            │                    ┌─────┴──────┐
│ worktree- │──────────────▶│ completion│            │                    │ buildVerify│
│ auto-     │ (on clean     │ -rationale│            │                    │  FixPrompt │
│ commit.js │  worktree +   │ classifier│            │                    │ (retry     │
│           │  on commit)   │           │            │                    │  prompt    │
│           │               │ (heuristic│            │                    │  builder)  │
└─────┬─────┘               │  → LLM)   │            │                    └────────────┘
      │                     └───────────┘            │
      │                                              │
      ▼ emits decision                               │
┌──────────────┐                              ┌──────┴────────┐
│   decisions  │◀───── emits decision ────────│ loop-         │
│     log      │                              │ controller.js │
└──────────────┘                              │               │
                                              │  • verify-    │
                                              │    silent-    │
                                              │    rerun path │
                                              │  • ambiguous  │
                                              │    fall-      │
                                              │    through    │
                                              │  • retry      │
                                              │    prompt     │
                                              │    read path  │
                                              └───────────────┘
```

### Data backbone: `factory_attempt_history`

```sql
CREATE TABLE factory_attempt_history (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id           TEXT    NOT NULL,
  work_item_id       TEXT    NOT NULL,
  attempt            INTEGER NOT NULL,
  kind               TEXT    NOT NULL CHECK (kind IN ('execute','verify_retry')),
  task_id            TEXT    NOT NULL,
  files_touched      TEXT,              -- JSON array of relative paths
  file_count         INTEGER NOT NULL DEFAULT 0,
  stdout_tail        TEXT,              -- last 1200 chars, ANSI-stripped
  zero_diff_reason   TEXT,              -- 'already_in_place'|'blocked'|'precondition_missing'|'unknown'|NULL
  classifier_source  TEXT    NOT NULL DEFAULT 'none'
                              CHECK (classifier_source IN ('heuristic','llm','none')),
  classifier_conf    REAL,
  verify_output_tail TEXT,              -- populated by retry path right before next submission
  created_at         TEXT    NOT NULL
);
CREATE INDEX idx_factory_attempt_history_batch
  ON factory_attempt_history (batch_id, attempt);
CREATE INDEX idx_factory_attempt_history_work_item
  ON factory_attempt_history (work_item_id, created_at DESC);
```

- `attempt` is a monotonic per-`work_item_id` counter across **all** Codex invocations. Each plan-task execute run gets its own attempt number; each verify retry continues the sequence. A work item with a 3-task plan that triggers 2 verify retries produces 5 rows: attempts 1–3 with `kind='execute'` (one per plan task), attempts 4–5 with `kind='verify_retry'`. The `factory:verify_retry=N` tag on tasks maps to the retry's ordinal position within `kind='verify_retry'` — attempt number is derived by a `SELECT max(attempt)+1` on row insert.
- `files_touched` is captured by `worktree-auto-commit.js` from `git diff --name-only HEAD` after staging (on skip-clean paths it is an empty array; on commit paths it is the full staged list).
- `stdout_tail` is read from the `tasks` row that the provider writes to, trimmed to 1200 bytes after ANSI stripping.
- `verify_output_tail` is written by the retry submission path onto the row for attempt N (the most recent attempt) immediately before submitting attempt N+1. The prompt builder for attempt N+1 reads this column off the prior row to render the error-progression diff.

No new columns on existing tables. No migration of historical data — this table starts empty and grows forward.

### Module: `server/factory/completion-rationale.js`

Pure classifier with one optional LLM fallback.

Signature:

```js
async function classifyZeroDiff({
  stdout_tail,          // string, already trimmed + ANSI-stripped
  attempt,              // int — skip-ship-noop decision uses this
  kind,                 // 'execute' | 'verify_retry'
  llmRouter,            // optional smart_submit_task-like handle for fallback
  timeoutMs = 30000,
}) => {
  // returns: { reason, source, confidence }
}
```

**Heuristic layer** (zero LLM cost, runs first). Lower-cased tail is scanned for any pattern in an ordered list. First match wins; confidence = 1.0.

| Bucket                 | Seed patterns |
|------------------------|---------------|
| `already_in_place`     | `already in place`, `already present`, `no changes needed`, `no modifications required`, `nothing to change`, `change is already`, `already satisfies`, `already applied`, `code already implements` |
| `blocked`              | `cannot proceed`, `blocked by`, `refusing to`, `unable to locate`, `permission denied`, `read-only`, `outside the worktree`, `sandbox denied` |
| `precondition_missing` | `file does not exist`, `no such file`, `path not found`, `module not found`, `not initialized`, `prerequisite` |

Pattern list lives in `completion-rationale.js` as a top-level constant; tests assert exhaustively per bucket. Patterns are deliberately conservative — tight phrasing favors precision over recall; recall is LLM's job.

**LLM fallback.** Invoked only when all heuristic patterns miss. Uses the injected `llmRouter` (so tests can substitute a fake). Prompt is deterministic and short:

```
Classify this Codex stdout tail from a task that produced no file changes.
Answer with one word from this set: already_in_place, blocked, precondition_missing, unknown.
No other text.

Tail:
```
<tail>
```
```

- Provider preference: caller passes `llmRouter` bound to `codex-spark` (fast, cheap). Falls back through configured template on router failure.
- Response parsed as `/^\s*(already_in_place|blocked|precondition_missing|unknown)\s*$/i`. Anything else → `unknown`.
- Result assigned `confidence = 0.7` (lower than heuristic; model can hallucinate against truncated tail).

**Guardrails embedded in the classifier output contract:**

- If `attempt > 1` **and** caller indicates the result will feed the ship-noop auto-route, the classifier always returns confidence = 0 for `already_in_place` regardless of patterns. Retries that produce zero-diff are the existing pathology, not "done."
- Classifier never throws to callers. On internal error (LLM timeout, unparseable stdout) it returns `{ reason: 'unknown', source: 'none', confidence: 0 }` and logs a warning.

### Edits to `worktree-auto-commit.js`

All three `auto_commit_skipped_clean` return paths (lines 259, 310, 340) gain two additional steps before returning:

1. Read `stdout_tail` from the task row (1200 chars, ANSI-stripped).
2. Call `classifyZeroDiff(...)` and write a row to `factory_attempt_history`. The `safeLogDecision` call for `auto_commit_skipped_clean` is enriched with the classifier's `reason`, `source`, `confidence`.

The committed path (when `pathsToStage.length > 0`) also writes an attempt-history row — `kind='execute'` (or `'verify_retry'` if the task has `factory:verify_retry=N`), `files_touched = allStaged`, `zero_diff_reason = NULL`, `classifier_source='none'`. This keeps history shape consistent across outcomes and gives the retry prompt builder a row to read for every attempt.

### Edits to `loop-controller.js`

Three deltas.

**1. Ship-noop auto-route.** At the EXECUTE → VERIFY transition, before advancing, check the most recent `factory_attempt_history` row for the batch. If `zero_diff_reason = 'already_in_place'` **and** `classifier_conf >= 0.8` **and** feature flag `factory.auto_ship_noop_enabled` is true:

- Emit `shipped_as_noop` decision with `rationale_source`, `classifier_conf`, `stdout_tail[0:400]` as outcome fields.
- Advance directly to LEARN (skipping VERIFY entirely), marking the work item `shipped` with a `shipped_as_noop` flag on its metadata.

If `zero_diff_reason` is `blocked` or `precondition_missing` **and** `classifier_conf >= 0.8`: pause the loop at the EXECUTE stage using the existing pause-at-gate machinery (`loop_paused_at_stage='EXECUTE'`, `paused_at_gate` decision action, per loop-controller.js:1646). The decision outcome carries a new `paused_reason: 'blocked_by_codex' | 'precondition_missing'` field plus the classifier's `stdout_tail[0:400]` for operator context. No new stage state is introduced.

**2. Verify silent rerun.** In the ambiguous branch at loop-controller.js:5282, before falling through to `submitVerifyFixTask`:

- If this batch has already consumed its one silent-rerun (tracked via `factory_loop_instances.verify_silent_reruns` column, bumped atomically) → fall through as today.
- If feature flag `factory.verify_silent_rerun_enabled` is false → fall through as today.
- Else: re-run `verify_command` against the same branch on the same remote. Emit `verify_silent_rerun_started` on entry.
  - **Passes:** emit `verify_passed_on_silent_rerun`, advance to LEARN.
  - **Fails with same error signature:** emit `verify_rerun_same_failure`, fall through (today's retry path fires, cost unchanged).
  - **Fails with different error signature:** emit `verify_rerun_different_failure`, fall through *with both failures concatenated* into the verify-output stash used by the retry prompt.
  - **Remote unreachable / rerun errors out:** emit `verify_silent_rerun_failed`, fall through.

**Error signature** computed in a new helper `verifySignature(verifyOutput)`:
- If output contains vitest/mocha/jest-style failing test markers (regex probes for `✗` / `FAIL` / `× ` / `not ok`), extract the test-name set, normalize (strip timestamps, paths, line numbers), `sha1(sortedNames.join('\n'))`.
- Else, fall back to `sha1(normalizedLast200CharsOfStderr)` where normalization strips timestamps, PIDs, and absolute paths.

**3. Retry prompt enrichment.** `buildVerifyFixPrompt` signature grows two optional inputs:

```js
function buildVerifyFixPrompt({
  planPath, planTitle, branch, verifyCommand, verifyOutput,
  priorAttempts,       // array, at most 3, ordered oldest-first
  verifyOutputPrev,    // string, previous retry's output tail, nullable
})
```

Caller (`submitVerifyFixTask`) reads up to 3 most-recent rows from `factory_attempt_history` for this `(batch_id, work_item_id)` and passes both. If no rows exist, both are `undefined` and the prompt renders exactly as today.

New section inserted between framing paragraph and `Constraints:`:

```
Prior attempts on this work item:
- Attempt 1 (execute): 3 files touched — src/foo.ts, src/bar.ts, test/foo.test.ts.
  Codex summary: "Added early-return guard; existing tests cover edge cases."
- Attempt 2 (verify retry #1): 0 files touched — classified as `already_in_place`.
  Codex summary: "The guard is already present; no fix applied."

Verify error progression:
- Previous run failed with: 2 failures in test/foo.test.ts ("rejects null", "handles empty array")
- This run is failing with: 1 failure in test/foo.test.ts ("handles empty array")
  → Partial progress. One test now passes. Stay on the same file; do not revert.
```

Progression line appears only when `verifyOutputPrev` is present and the error-signature helper can extract a failing-test set from both. If only one side has a parseable set, render the side we have with no comparison.

**Token budget.** `VERIFY_FIX_PROMPT_PRIOR_BUDGET = 1800` chars. Assembled block is trimmed oldest-first until under budget. The progression line is preserved as long as any prior attempt fits — it carries the most information per byte. Existing `VERIFY_FIX_PROMPT_TAIL_BUDGET` is unchanged.

## Data flow

### Happy path — zero-diff ship-noop

```
Codex plan task completes
  └─▶ worktree-auto-commit.js listener fires
        ├─ git status --porcelain → empty
        ├─ read stdout_tail from tasks row
        ├─ classifyZeroDiff(stdout_tail, attempt=1, kind='execute')
        │    └─ heuristic hits 'already_in_place' pattern, conf=1.0
        ├─ INSERT factory_attempt_history row
        └─ safeLogDecision('auto_commit_skipped_clean', { zero_diff_reason, classifier_source, classifier_conf })

loop-controller.js EXECUTE → VERIFY transition
  ├─ read most-recent factory_attempt_history row for batch
  ├─ reason = 'already_in_place' AND conf ≥ 0.8 AND flag ON
  ├─ safeLogDecision('shipped_as_noop')
  └─ advance LEARN → mark work item shipped (metadata: shipped_as_noop=true)
```

### Happy path — silent rerun passes

```
Remote verify fails
  └─ verify-review classifier → 'ambiguous'

loop-controller.js ambiguous branch
  ├─ flag ON, silent-rerun not yet consumed this batch
  ├─ safeLogDecision('verify_silent_rerun_started')
  ├─ invoke remote verify_command (no code change)
  ├─ exit code 0
  ├─ safeLogDecision('verify_passed_on_silent_rerun')
  └─ advance VERIFY → LEARN
```

### Retry path — enriched prompt

```
Remote verify fails, silent-rerun consumed or flag OFF
  └─ submitVerifyFixTask called

submitVerifyFixTask
  ├─ read up to 3 most-recent factory_attempt_history rows for (batch_id, work_item_id)
  ├─ read verify_output_tail from most-recent row (written at prior retry)
  ├─ buildVerifyFixPrompt({ ..., priorAttempts, verifyOutputPrev })
  ├─ submit task with tag factory:verify_retry=N
  └─ when task completes → worktree-auto-commit.js writes new row (kind='verify_retry')
        └─ before submitting next retry, loop-controller UPDATE sets verify_output_tail
           on this row so next prompt build has previous output
```

## Components

### New

| Component                                       | Responsibility |
|-------------------------------------------------|----------------|
| `server/factory/completion-rationale.js`        | Classify Codex stdout tail into one of four buckets via heuristic + optional LLM. No DB access. Pure function. |
| `server/factory/verify-signature.js`            | Compute deterministic SHA-1 signature of a verify output string so same-vs-different failures are comparable across runs. |
| `factory_attempt_history` table                 | Per-attempt persistent record of what each Codex plan task did. |
| Migration `NNNN_factory_attempt_history.sql`    | Adds table + two indices. Idempotent. |

### Edited

| Component                                       | Change |
|-------------------------------------------------|--------|
| `server/factory/worktree-auto-commit.js`        | All paths write `factory_attempt_history` rows; clean-worktree paths classify via `completion-rationale`. |
| `server/factory/loop-controller.js`             | EXECUTE→VERIFY checks for ship-noop; ambiguous-verify branch attempts silent rerun; `buildVerifyFixPrompt` signature grows and consumes prior attempts + error-signature progression. |
| `server/factory/factory-health.js`              | Exposes `factory.auto_ship_noop_enabled` and `factory.verify_silent_rerun_enabled` feature-flag reads. |
| `server/db/factory-loop-instances.js` (or eq.)  | Adds `verify_silent_reruns INTEGER DEFAULT 0` column + atomic bump helper. |

### Unchanged

- Codex provider adapter. All data is read from fields it already populates on the `tasks` row.
- `safeLogDecision` and the `decisions` table schema.
- `verify-review` classifier (`ambiguous`/`task_caused`/`baseline_broken`/`environment`). We consume its existing output without modifying its contract.
- `remote-agents` plugin. Silent rerun reuses the same remote invocation path as the initial verify.

## Error handling

| Failure                                         | Detection                               | Fallback |
|-------------------------------------------------|-----------------------------------------|----------|
| `completion-rationale` classifier throws        | try/catch around module call            | Write history row with `zero_diff_reason=NULL`, `classifier_source='none'`; loop behaves as flag-off. |
| LLM-fallback classifier errors / times out      | promise reject or > 30s                 | Heuristic-only result wins; if heuristic was `unknown`, stays `unknown`. No retry. |
| `factory_attempt_history` write fails           | sqlite error                            | Warning decision `attempt_history_write_failed`; prompt builder treats attempt as absent → today's prompt. |
| Silent-rerun remote errors / times out          | exit code, network error                | Fall through to `submitVerifyFixTask`. Emit `verify_silent_rerun_failed`. |
| Error-signature extraction returns empty        | regex probes find nothing               | Treat as "same failure" — no worse than today's unconditional retry. |
| Prior-attempts block > budget after minimum fit | assembled length > budget, can't trim more | Keep progression line + most-recent attempt only. Never skip current-retry context. |
| Feature-flag read fails                         | config throws                           | Default to false. Classification + history still run; behavioral changes are gated. |
| `attempt > 1` ship-noop guardrail               | caller passes attempt explicitly        | Classifier pins confidence to 0 for `already_in_place` regardless of pattern match. |

**Invariant: the loop never regresses when any new code path fails.** Additive writes, flag-gated behavior, no new required fields on existing tables.

## Feature flags

| Flag                                     | Default | Gates |
|------------------------------------------|---------|-------|
| `factory.auto_ship_noop_enabled`         | `false` | Ship-noop auto-route and EXECUTE_BLOCKED pause. Classification + history still run with flag off. |
| `factory.verify_silent_rerun_enabled`    | `false` | Silent-rerun branch. Ambiguous-verify falls through to today's behavior with flag off. |

Retry-prompt enrichment is unflagged — it is additive (absent rows produce today's prompt) and flipping it off would leave the history table unused.

## Testing

### Unit tests

- `completion-rationale.test.js`
  - One test per heuristic bucket (all seed patterns must match).
  - One test that asserts unknown phrasing returns `{ source: 'none', confidence: 0 }` when no LLM router is provided.
  - LLM fallback invoked only when heuristic misses; router return parsed correctly; malformed response → `unknown`.
  - `attempt > 1` guardrail: `already_in_place` pattern match returns confidence 0 when caller marks attempt as retry.
  - Classifier never throws: inject a router that throws, assert `{ reason: 'unknown' }` returned.

- `verify-signature.test.js`
  - Same failing-test set in different order → same signature.
  - Different timestamps / paths / line numbers → same signature.
  - Completely different failures → different signatures.
  - Fall-back path: generic stderr with same last-200-chars → same signature.

- `attempt-history-prompt.test.js`
  - Empty prior-attempts array → prompt identical to today's output.
  - 1, 2, 3 prior attempts rendered in order with correct kind labels.
  - 4+ attempts → oldest elided with "(N earlier attempts elided)".
  - Budget enforcement: force attempts to exceed budget, assert progression line survives and oldest is dropped first.
  - Progression line appears only when both current and prior output have extractable test sets.

### Integration tests

- Factory loop synthetic 3-attempt batch:
  1. Execute produces zero-diff with `already_in_place` Codex phrasing.
  2. Flag OFF: loop advances to VERIFY; ship-noop decision absent.
  3. Flag ON: loop advances to LEARN; `shipped_as_noop` decision present; work item status `shipped`; `shipped_as_noop=true` in metadata.

- Ambiguous-verify → silent-rerun-passes integration:
  - Mock verify-review classifier to return `ambiguous`.
  - First invocation of remote verify fails; second invocation (no diff) passes.
  - Assert: no `verify_retry_submitted`, one `verify_passed_on_silent_rerun`, loop at LEARN, `factory_loop_instances.verify_silent_reruns = 1`.

- Silent-rerun budget consumed:
  - Same setup but with `verify_silent_reruns` already at 1.
  - Assert: falls through to today's `submitVerifyFixTask` path; no silent-rerun decisions emitted.

- Retry prompt assembly from real history:
  - Seed `factory_attempt_history` with 2 execute rows + 1 verify_retry row for a batch.
  - Call `submitVerifyFixTask` with a mocked smart-router that captures the submitted prompt.
  - Assert prompt contains prior-attempts block, correct file counts, and progression line.

### Test hygiene

- Tests hit a real ephemeral SQLite via the existing test harness (no DB mocks — see `feedback_test_on_omen` and the past-incident-driven "no mocks for DB" rule).
- Integration tests run remotely via `torque-remote npx vitest run server/tests/factory-*.test.js` per project `verify_command`.

## Success metrics

All measurable from the new `factory_attempt_history` table plus existing `decisions`.

| Metric                                          | Source                               | Target |
|-------------------------------------------------|--------------------------------------|--------|
| Zero-diff rate on Plan:Execute                  | `factory_attempt_history`, `kind='execute'`, `file_count=0` | Trend down after ship-noop flag flips |
| Codex-time on zero-diff                         | `tasks.duration_ms` joined on history | Drop from ~7.9h/week by ≥ 50% within one week of flag flip |
| Verify retries per work item (median)           | `factory_attempt_history`, `kind='verify_retry'` grouped by `work_item_id` | Decrease after retry-prompt enrichment ships |
| Silent-rerun pass rate                          | `verify_passed_on_silent_rerun / verify_reviewed_ambiguous_retrying` | ≥ 30% (threshold for "worth it") |
| Classifier unknown rate                         | `factory_attempt_history`, `zero_diff_reason='unknown'` | Track; inform future pattern additions |

## Rollout

1. **Ship schema + history writer + heuristic classifier + retry-prompt enrichment.** Both flags OFF. Watch `factory_attempt_history` for 48h to confirm writes are happening on every `auto_commit_skipped_clean` and every commit, and that the classifier's heuristic bucket distribution matches spot-checks against the raw stdout tails.
2. **Enable LLM fallback.** Same flag state. Watch for runaway LLM calls (cap: expected < 20% of zero-diff events; alert if > 60%).
3. **Flip `factory.verify_silent_rerun_enabled` → true.** Watch `verify_passed_on_silent_rerun` rate; flip back if < 15% pass rate (means ambiguous is almost always real and we're spending verify time for no reason).
4. **Flip `factory.auto_ship_noop_enabled` → true** after ≥ 20 `already_in_place` classifications have been manually spot-checked against the shipped-noop candidates.

## Open questions

None at spec-approval time. Implementation details (exact pattern list tuning, LLM model choice for fallback, decision-outcome field naming for paused-by-codex case) resolved during the implementation plan.

## Appendix: touched files

- **New:** `server/factory/completion-rationale.js`, `server/factory/verify-signature.js`, `server/migrations/NNNN_factory_attempt_history.sql` (exact NNNN assigned during plan writing).
- **Edited:** `server/factory/worktree-auto-commit.js`, `server/factory/loop-controller.js`, `server/factory/factory-health.js` (feature-flag readers), `server/db/factory-loop-instances.js` (column + bump helper) or its DI-registered equivalent.
- **Tests:** `server/tests/completion-rationale.test.js`, `server/tests/verify-signature.test.js`, `server/tests/attempt-history-prompt.test.js`, `server/tests/factory-ship-noop.test.js`, `server/tests/factory-silent-rerun.test.js`.
