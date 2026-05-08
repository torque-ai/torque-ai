# Unified Auto-Ship Helper — Design

**Date:** 2026-05-08
**Status:** Spec — pending implementation plan
**Owner:** Codex
**Parent arc:** Factory loop state-machine rationalization (sub-project 4 of 7)
**Related:** `docs/factory-loop-states.md`, `docs/superpowers/specs/2026-05-07-factory-decision-actions-catalog-design.md` (sub-project 1 — already shipped)

## Problem

Three emit sites in `server/factory/loop-controller.js` independently emit the same conceptual event — "the shipped-detector found this work item already done, mark shipped":

- `auto_shipped_at_prioritize` (line ~4665) — PRIORITIZE stage detected before execution
- `auto_shipped_empty_branch` (line ~3449) — LEARN merge had no commits ahead but detector found matching evidence
- `auto_shipped_at_verify_fail` (line ~12335) — VERIFY failed but detector found matching commits

Each is a separate decision-action name in the catalog (sub-project 1). Adding a new auto-ship path means adding a new action and a new catalog entry — the implicit contract is "every stage gets its own auto-ship action."

This sub-project replaces the implicit contract with an explicit one: a single canonical action `auto_shipped` with a `reason` enum. New auto-ship paths add a reason value rather than a new decision action — keeping the catalog clean and the contract uniform.

## Goals

- Single canonical decision action `auto_shipped` for every shipped-detector-driven auto-ship path.
- Frozen `AUTO_SHIPPED_REASONS` enum, runtime-validated by the helper.
- Catalog reduced from 3 stage-keyed entries to 1 `stage: 'ANY'` entry.
- All three current call sites migrated; CI gate green after migration.
- Future auto-ship paths add a reason value, not a new action.

## Non-goals

- Other auto-decision events (e.g., `auto_recovery_*`, `auto_rejected_*`, `auto_committed_task`). They have their own contracts; this sub-project is shipped-detector auto-ship only.
- Changing the `factoryIntake.updateWorkItem(workItem.id, { status: 'shipped' })` call. The helper handles emission only; "mark shipped" stays at the call site.
- Changing caller return values (`return { status: 'passed', reason: 'auto_shipped_*' }`). The decision-log action name is independent of the caller-facing return contract.
- The fourth string at line 4243 (`auto_shipped_empty_branch_at_verify`) — this is a return value, not an emission. Out of scope.
- Backward-compat alias period for the three old action names. Hard cut per CLAUDE.md ("Avoid backwards-compatibility hacks").
- Historical row migration in `factory_decisions`. Old rows keep their original action names; new rows use `auto_shipped`. Operator runbook documents the change.

## Module shape

`server/factory/auto-ship.js`:

```js
'use strict';

const decisionLog = require('./decision-log');

// Frozen enum of valid auto-ship reasons. New auto-ship paths must add a
// reason value here BEFORE calling emitAutoShipped — runtime validation
// enforces this. Catalog stays clean: one decision action, multiple reasons.
const AUTO_SHIPPED_REASONS = Object.freeze({
  AT_PRIORITIZE: 'at_prioritize',
  EMPTY_BRANCH_MERGE_FAIL: 'empty_branch_merge_fail',
  AT_VERIFY_FAIL: 'at_verify_fail',
});

const VALID_REASONS = new Set(Object.values(AUTO_SHIPPED_REASONS));

/**
 * Emit a unified auto_shipped decision for a work item the shipped-detector
 * has identified as already done.
 */
function emitAutoShipped({
  project_id,
  stage,
  reason,
  work_item_id,
  confidence,
  signals,
  batch_id = null,
  extra = {},
  reasoning,
}) {
  if (!VALID_REASONS.has(reason)) {
    throw new Error(
      `emitAutoShipped: unknown reason "${reason}". Add it to AUTO_SHIPPED_REASONS first. Valid: ${[...VALID_REASONS].join(', ')}`
    );
  }

  // Core keys win on collision so a caller can't bypass `reason` validation
  // by stuffing a different reason into `extra`. Stage-specific keys in
  // `extra` (factory_worktree_id, error, detection, etc.) flow through
  // unchanged because they don't collide with the four core names.
  const outcome = {
    ...extra,
    work_item_id,
    confidence,
    signals,
    reason,
  };

  const defaultReasoning = `Auto-shipped at ${stage} (reason=${reason}, confidence=${confidence}). Shipped-detector found matching commits on main.`;

  return decisionLog.logDecision({
    project_id,
    stage,
    actor: 'factory-loop',
    action: 'auto_shipped',
    reasoning: reasoning || defaultReasoning,
    inputs: { reason },
    outcome,
    confidence: 1,
    batch_id,
  });
}

module.exports = { emitAutoShipped, AUTO_SHIPPED_REASONS };
```

### Helper contract

| Param | Required | Purpose |
|---|---|---|
| `project_id` | yes | Forwarded to `logDecision` |
| `stage` | yes | The `LOOP_STATES` value where the auto-ship fires (`PRIORITIZE` / `LEARN` / `VERIFY` / future) |
| `reason` | yes | One of `AUTO_SHIPPED_REASONS` values; validated at runtime |
| `work_item_id` | yes | The work item being shipped |
| `confidence` | yes | shipped-detector confidence (`high` / `medium` / `low`) |
| `signals` | yes | shipped-detector match signals array |
| `batch_id` | optional | Decision batch ID (defaults to null) |
| `extra` | optional | Stage-specific outcome keys merged into the emitted outcome |
| `reasoning` | optional | Override the default reasoning string |

### Runtime validation

`emitAutoShipped` throws on unknown `reason` value. The error message lists the valid set so the caller knows what to add. This is the single point where the enum is enforced — no helper rewriting required when `AUTO_SHIPPED_REASONS` is extended.

## Reason enum

| Constant | Value | When emitted | Replaces |
|---|---|---|---|
| `AT_PRIORITIZE` | `'at_prioritize'` | PRIORITIZE detected an already-shipped item before execution | `auto_shipped_at_prioritize` |
| `EMPTY_BRANCH_MERGE_FAIL` | `'empty_branch_merge_fail'` | LEARN merge had no commits ahead but shipped-detector found matching evidence | `auto_shipped_empty_branch` |
| `AT_VERIFY_FAIL` | `'at_verify_fail'` | VERIFY failed but shipped-detector found matching commits | `auto_shipped_at_verify_fail` |

Naming convention: `<location_in_lifecycle>` shape. Future reasons follow the same pattern (e.g., `at_plan_review`, `at_execute_pre_run`).

## Catalog impact

**Removed (3 entries):**

```js
auto_shipped_at_prioritize: { stage: 'PRIORITIZE', classifier: 'terminal', outcome: ['work_item_id', 'status'] },
auto_shipped_empty_branch: { stage: 'LEARN', classifier: 'terminal', outcome: [...] },
auto_shipped_at_verify_fail: { stage: 'VERIFY', classifier: 'terminal', outcome: [...] },
```

**Added (1 entry):**

```js
auto_shipped: {
  stage: 'ANY',
  classifier: 'terminal',
  outcome: ['work_item_id', 'confidence', 'signals', 'reason'],
},
```

**Net change:** 143 entries → 141 entries.

**Stage:** `'ANY'` because the action fires from PRIORITIZE, LEARN, VERIFY, and potentially future stages. The catalog `stage` field documents that the action is cross-stage by design; the `stage` field on each emitted decision row matches the call site.

**Outcome:** four core keys. `extra` keys are not enumerated in the catalog because they vary by call site; the catalog `outcome` field is documentation-only in v1 (per the parent spec).

**Audit-gate check after migration:** `runDecisionActionsAudit` reports `All gap categories empty.`. The three old names are not in `EMITTED_ACTIONS` and not in the catalog; the new `auto_shipped` is in both. Verified during implementation.

## Call-site migration

**Site 1: PRIORITIZE (line ~4665)**

`getWorkItemDecisionContext(workItem)` keys move from `inputs` to `extra` (which merges into outcome). Reasoning preserved as override.

**Site 2: LEARN empty-branch (line ~3449)**

`sharedOutcome` (containing `factory_worktree_id`, `error`, `detection`) and `resolution_source` move to `extra`. `signals` is lifted from `sharedOutcome.detection.signals` to a top-level required core key — a shape change worth noting in the commit.

**Site 3: VERIFY fail (line ~12335)**

Cleanest migration — only the core fields, no `extra` needed.

**Imports added at top of `loop-controller.js`:**

```js
const { emitAutoShipped, AUTO_SHIPPED_REASONS } = require('./auto-ship');
```

**Caller return values unchanged.** Each site's `return { status: 'passed', reason: 'auto_shipped_*' }` keeps its current string. Rebranding return values would expand scope into other handlers' control flow.

## Tests

`server/tests/auto-ship.test.js`:

1. Valid reason emits a decision with `action: 'auto_shipped'` and `outcome.reason` equal to the enum value.
2. Unknown reason throws with a clear message listing valid values.
3. Each enum constant value emits without error (parametric over `Object.values(AUTO_SHIPPED_REASONS)`).
4. `extra` keys merge into outcome (preserves stage-specific context).
5. Default `reasoning` is generated and contains stage + reason.
6. Override `reasoning` is preserved when passed.
7. `AUTO_SHIPPED_REASONS` is frozen (mutation attempts throw in strict mode or fail silently otherwise).

**Audit-gate verification (no new test):** the catalog gate from sub-project 1 (`server/tests/factory-decision-actions-catalog.test.js`) automatically catches drift. After migration, that gate must still pass.

**Migration smoke check:**

```bash
node server/factory/scripts/audit-decision-actions.js
```

Expected: exit 0, `All gap categories empty.`. Dynamic-action sites count unchanged from baseline (15).

## Migration & rollout

**Three commits, each CI-green:**

1. Add `server/factory/auto-ship.js` + `server/tests/auto-ship.test.js`. No call-site changes, no catalog changes. CI green (new module + tests pass; audit gate unchanged).
2. Migrate the three call sites in `loop-controller.js` AND update the catalog in the same commit. The catalog must change atomically with the emit sites — splitting them creates a window where the audit gate fails (catalog has 3 dead entries OR emit sites use unknown action). After this commit: re-run audit, expect green.
3. Regenerate doc table via `node server/factory/scripts/render-decision-actions-doc.js --write`. The renderer's snapshot test re-passes. Add operator-runbook note explaining the action rename.

**Cutover:** standard `worktree-cutover.sh`. No restart barrier — pure refactor; helper behavior is identical to inlined emissions.

**Rollback:** revert in reverse order. Each commit is self-contained. The `auto-ship.js` file alone is harmless if not imported. The call-site migration + catalog update (commit 2) is the load-bearing one; reverting restores the three old action names.

## Risk surface

- **`inputs` field semantics shift.** Old code put per-site context in `inputs` (e.g., LEARN passed `batch_id` and `resolution_source` into inputs). New helper puts `{ reason }` in inputs; everything else is outcome. Operator queries filtering on `inputs.batch_id` or `inputs.resolution_source` for these specific actions would need to read from `outcome` instead. Same data is preserved in the row.

- **`signals` field at LEARN site.** Currently nested at `outcome.detection.signals`; new shape lifts it to `outcome.signals` per the helper's required core. Operator queries on `outcome.detection.signals` for `auto_shipped_empty_branch` would need updating to `outcome.signals` for `auto_shipped` with `reason: 'empty_branch_merge_fail'`. Documented in the commit message.

- **Hard cut, no alias.** Operators with dashboards keyed on the three old action names will see "0 hits" for new auto-ships. Historical hits remain. Documented in the operator runbook update (Step 3 above).

- **Unknown reason at runtime.** A new auto-ship path that calls `emitAutoShipped` with an undeclared reason throws. This is intentional — it's the validation gate. New paths require declaring the reason in `AUTO_SHIPPED_REASONS` before the call site lands.

## Documentation deliverables

- This spec at `docs/superpowers/specs/2026-05-08-unified-auto-ship-helper-design.md`.
- `docs/factory-loop-states.md`:
  - Decision-action emission map autogen block re-rendered (3 entries removed, 1 added).
  - Operator runbook note in the existing "Finding production drift" section explaining that `auto_shipped` rows after this cutover replace the three old action names; query pattern: `WHERE action = 'auto_shipped' AND json_extract(outcome, '$.reason') = '<reason>'`.

## Open questions / risks

- **Future auto-ship paths must remember to add an enum value.** The runtime validation throws on unknown reason, so this is enforced at the first call rather than silently producing a new value. But the developer experience requires reading the `auto-ship.js` source to discover the enum. If `AUTO_SHIPPED_REASONS` exports grow common, consider adding an "Adding a new auto-ship reason" subsection to `docs/factory-loop-states.md`. v1 omits this; revisit if a 4th reason lands.
- **Helper does emission only.** The "mark shipped" call (`factoryIntake.updateWorkItem`) and caller return value remain at the call site. Tightly coupling them in the helper would simplify call sites but expands scope. Deferred unless future call-site duplication grows.
- **Catalog `outcome` field is documentation-only in v1.** Strict validation that emitted outcomes contain exactly these keys would catch missing `signals`, etc. — out of scope for sub-project 4; tracked at parent-arc level.
