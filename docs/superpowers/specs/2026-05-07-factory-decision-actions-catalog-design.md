# Factory Decision-Actions Catalog & Drift Prevention — Design

**Date:** 2026-05-07
**Status:** Spec — pending implementation plan
**Owner:** Codex
**Parent arc:** Factory loop state-machine rationalization (sub-project 1 of 7)
**Related:** `docs/factory-loop-states.md`, `docs/recovery-decisions.md`

## Problem

`docs/factory-loop-states.md` is the canonical reference for the factory loop's decision-action emission map. The implementation has drifted: recent fixes (`learn_merge_target_dirty`, `execute_zero_diff_short_circuit`, `executor_failed_needs_replan`, `phantom_completion_detected`) were each reactive classifier rules added because an emission site fired in production with no matching rule, routing to `UNKNOWN_CLASSIFICATION` and the engine's default `['retry', 'escalate']` chain — which often loops on the same provider that just failed.

The bug class is documented in `docs/factory-loop-states.md` ("silent UNKNOWN routing is the most common bug class in the recovery-decisions audit"), but nothing prevents it. Each new emission site is at risk of repeating the pattern.

This spec covers sub-project 1 of a 7-part state-machine rationalization arc: an authoritative decision-action catalog, an audit script that finds today's gaps, gap-fixing, a CI gate that prevents future drift, and a production guard that catches anything dynamic the static analysis can't see.

## Goals

- A single authoritative catalog of valid `factory_decisions` actions, with stage, classifier kind, and outcome shape per action.
- An audit script that finds today's gaps (emit sites without classifier wiring, catalog without emit sites, rule-id mismatches).
- All current gaps closed (zero `UNKNOWN_CLASSIFICATION` from known emit sites).
- A CI gate that fails when a new emit site lacks a paired rule or benign-skip pattern.
- A production guard that emits a tracked decision action when the recovery engine routes to `UNKNOWN`, so dynamic action names and out-of-CI changes are observable.
- Doc table in `docs/factory-loop-states.md` becomes auto-generated from the catalog.

## Non-goals

- Outcome-shape strict validation (catalog `outcome` field is documentation-only in v1; validating outcome keys against actual call sites is harder and can be a follow-up).
- Auto-correcting the strategy chain a rule selects. The CI gate asserts wiring exists, not that the wiring is the *right* recovery strategy.
- Other open questions in `docs/factory-loop-states.md` (READY_FOR watchdog, dual-meaning EXECUTE, auto-ship unification, undeclared backward edges, legacy mirror sweep, restart re-entry). These are sub-projects 2–7 with their own specs.
- Alerting/paging on production-guard hits. v1 ships observability via the existing `factory_decisions` table; alert plumbing is its own arc.
- Per-task-cancellation safety review of the recovery engine. Out of scope.

## Authority model

The new file `server/factory/decision-actions.js` is canonical.

- Doc table in `docs/factory-loop-states.md` is auto-generated from the catalog.
- `server/plugins/auto-recovery-core/rules.js` and `isBenignFlowDecision` (in `server/factory/auto-recovery/engine.js`) remain the runtime classifiers; the catalog asserts that every emit site has wiring through one of them, not the other way around.
- The catalog is hand-maintained. Adding a new emit site means adding a catalog entry in the same commit.

## Catalog file shape

`server/factory/decision-actions.js`:

```js
const DECISION_ACTIONS = {
  scanned_plans: {
    stage: 'SENSE',
    classifier: 'benign',
    outcome: ['plans_dir', 'scanned', 'created_count', 'shipped_count'],
  },
  selected_work_item: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['work_item_id', 'priority', 'status', 'source', 'batch_id'],
  },
  execute_zero_diff_short_circuit: {
    stage: 'EXECUTE',
    classifier: 'recovery-rule',
    rule_id: 'execute_zero_diff_short_circuit',
    outcome: ['work_item_id', 'reason'],
  },
  // ...one entry per documented action
};

module.exports = { DECISION_ACTIONS };
```

### Five `classifier` enum values

| Value | Meaning |
|---|---|
| `benign` | Forward-progress event. Engine skips via `isBenignFlowDecision`. |
| `recovery-rule` | A-side classifier rule consumes it. Must include `rule_id` matching `rules.js`. |
| `b-side-reject` | Routed to `recovery-strategies/registry.js` or `rejected-recovery.js` for replan. |
| `terminal` | Success or terminal-failure that doesn't need recovery. Engine skips. |
| `engine` | Emitted by the recovery engine itself. Not consumed by rules. |

### Stage values

Match `LOOP_STATES` in `loop-states.js` (`SENSE`, `PRIORITIZE`, `PLAN`, `EXECUTE`, `VERIFY`, `LEARN`, `IDLE`, `PAUSED`, `STARVED`) plus `ANY` for cross-stage actions like `paused_at_gate`, `gate_approved`, `auto_recovery_unknown_action`.

### Outcome field

Documentation-only in v1. Listed for grep-ability and future strict validation. The CI gate does NOT assert that emit-site call sites use exactly these keys.

## Audit script

`server/factory/scripts/audit-decision-actions.js`:

- Exports `runDecisionActionsAudit()` returning a structured report.
- CLI mode (`if (require.main === module) ...`) pretty-prints the report and exits non-zero on gaps.
- Two flags: bare invocation = report mode; `--gap-detail` = per-gap context (file:line, suggested fix).

### Discovery

1. **Emit sites:** parse `server/factory/**/*.js` and `server/plugins/auto-recovery-core/**/*.js` for `safeLogDecision({` calls. Statically resolve the `action:` literal. Dynamic actions (template literal, variable, computed) recorded separately.
2. **Classifier rules:** parse `server/plugins/auto-recovery-core/rules.js` for rule definitions; extract each rule's `id` and the action-matchers it dispatches on.
3. **Benign-skip patterns:** parse `server/factory/auto-recovery/engine.js` for `isBenignFlowDecision`'s pattern set (literal action names + prefixes like `started_*`).

### Cross-reference

Build:

- `EMITTED_ACTIONS` — every literal action name found via emit-site parsing.
- `CATALOG_ACTIONS` — keys of `DECISION_ACTIONS`.
- `MATCHED_ACTIONS` — actions that have a matching classifier rule, benign-skip pattern, or terminal/engine catalog entry.

### Gap categories

| Category | Meaning | Severity |
|---|---|---|
| `emitted_not_in_catalog` | Code emits action X, catalog has no entry. | Fix: add catalog entry or fix typo. |
| `emitted_no_classifier` | Code emits X, action is in catalog, but no classifier wiring. | High — the bug class. Routes to UNKNOWN. |
| `catalog_not_emitted` | Catalog entry exists, no emit site found. | Fix: dead doc. Remove or document why. |
| `rule_id_mismatch` | Catalog says `rule_id: 'foo'`, but `foo` not in `rules.js`. | Mechanical fix. |

Plus a non-fatal warning category:

- `dynamic_action_sites` — emit calls where `action:` is computed. Listed as `file:line`. Operator decides whether each is acceptable or should be refactored to a literal.

### Implementation tooling

Prefer regex (`safeLogDecision\(\{[^}]*action:\s*['"]([^'"]+)['"]`) over AST in v1 — the parsing surface is small and the pattern is stable. AST upgrade is a follow-up if needed.

## Gap-fixing strategy (one-shot work)

Triage each gap with operator review.

**`emitted_not_in_catalog`:**
- Read the emit site and surrounding handler.
- Determine classifier:
  - Forward-progress / informational → `benign`. Add prefix to `isBenignFlowDecision` if not covered. Add catalog entry.
  - Failure / stuck-state → `recovery-rule`. Add rule to `rules.js` with appropriate strategy chain. Add catalog entry referencing rule_id.
  - Reject-then-replan → `b-side-reject`. Add pattern in `rejected-recovery.js`. Add catalog entry.
  - Terminal → `terminal`. Catalog entry only.
  - Engine internal → `engine`. Catalog entry only.

**`emitted_no_classifier`:**
- Same triage. This is the high-priority bucket — these have been silently routing to UNKNOWN.
- Compare to existing entries in `recovery-decisions.md`'s conflict catalog; if the action matches a documented pattern, the rule shape is half-written.

**`catalog_not_emitted`:**
- Almost always stale doc. Remove from catalog.
- Edge case: emit site uses a dynamic action name the parser missed. Cross-reference with `dynamic_action_sites` warnings.

**`rule_id_mismatch`:**
- Either rename the rule in catalog or fix `rules.js`. Mechanical.

### Triage anchor

When classification is ambiguous, default to `recovery-rule` with `retry`-only (single attempt, then escalate) rather than `benign`. False-benign hides bugs; false-retry adds at most one extra attempt before escalation.

### Order of operations

1. Audit produces gap report.
2. Triage with operator on each ambiguous case.
3. Fix in dependency order: dead-doc removals, then rule_id mismatches, then `emitted_no_classifier` (highest priority — actively buggy), then `emitted_not_in_catalog`.
4. Re-run audit between commits.
5. End state: zero gaps in all four categories before moving to CI gate.

## CI gate

`server/tests/factory-decision-actions-catalog.test.js`:

```js
const { describe, it, expect, beforeAll } = require('vitest');
const { runDecisionActionsAudit } = require('../factory/scripts/audit-decision-actions');

describe('factory decision-actions catalog', () => {
  let report;
  beforeAll(() => { report = runDecisionActionsAudit(); });

  it('every emitted action is in the catalog', () => {
    expect(report.emitted_not_in_catalog).toEqual([]);
  });

  it('every emitted action has a classifier', () => {
    expect(report.emitted_no_classifier).toEqual([]);
  });

  it('every catalog rule_id reference matches a real rule in rules.js', () => {
    expect(report.rule_id_mismatch).toEqual([]);
  });

  it('catalog has no orphan entries (dead documentation)', () => {
    expect(report.catalog_not_emitted).toEqual([]);
  });

  it('reports dynamic-action sites for manual review (non-fatal)', () => {
    if (report.dynamic_action_sites.length > 0) {
      console.warn(`Dynamic action sites (manual review): ${report.dynamic_action_sites.length}`);
    }
  });
});
```

### What the CI gate catches

- New emission site without catalog entry.
- Catalog entry referencing a renamed `rule_id`.
- Action emitted but no classifier wired (the production bug class).
- Stale catalog entry after emit-site deletion.

### What the CI gate doesn't catch (intentional v1 limits)

- Dynamic action names. Non-fatal warning in the report. Section 5's production guard catches these in operation.
- Outcome key drift. Documented v1 limit.
- Whether the chosen classifier strategy chain is the *right* one. Lint asserts wiring exists; correctness is human judgment.

### Performance

Parsing the factory + recovery-core source tree is fast (regex pass over ~50-80 files); the test runs in well under a second. AST upgrade if pursued later would still be sub-second on this scope.

## Production guard

When the recovery engine routes a decision to `UNKNOWN_CLASSIFICATION`, emit `auto_recovery_unknown_action`.

### New decision action

| Field | Type | Source |
|---|---|---|
| `original_action` | string | The action that didn't match any rule. |
| `original_stage` | string | Stage column on the unmatched decision. |
| `outcome_keys` | string[] | Keys present on the unmatched decision's `outcome` (keys only — values may contain PII). |
| `work_item_id` | string \| null | If the unmatched decision had one. |
| `task_id` | string \| null | Same. |
| `engine_decided_strategies` | string[] | Default chain (`['retry', 'escalate']`) the engine fell back to. |

### Emission site

`server/factory/auto-recovery/engine.js`, in the path that builds the default chain when no rule matches. `safeLogDecision({ action: 'auto_recovery_unknown_action', ... })` fires before the engine commits to the default chain.

### Catalog entry

```js
auto_recovery_unknown_action: {
  stage: 'ANY',
  classifier: 'engine',
  outcome: ['original_action', 'original_stage', 'outcome_keys', 'work_item_id', 'task_id', 'engine_decided_strategies'],
},
```

### Recursion defense

Engine classifier short-circuits `action === 'auto_recovery_unknown_action'` as `engine` kind early, before the rule-matching loop. Without this guard, a misclassified `auto_recovery_unknown_action` would emit another `auto_recovery_unknown_action`, recursing.

### Operator queries

```sql
-- Anything that slipped past CI in the last 24h
SELECT created_at, json_extract(outcome, '$.original_action'), json_extract(outcome, '$.original_stage')
FROM factory_decisions
WHERE action = 'auto_recovery_unknown_action'
  AND created_at > datetime('now', '-1 day')
ORDER BY created_at DESC;

-- Frequency by original_action
SELECT json_extract(outcome, '$.original_action') AS action, COUNT(*) AS hits
FROM factory_decisions
WHERE action = 'auto_recovery_unknown_action'
GROUP BY action
ORDER BY hits DESC;
```

These queries land in the operator runbook (`docs/factory-loop-states.md` "Finding production drift" section).

### What the production guard does NOT do

- No alerting/paging. Operator queries when they suspect drift.
- No rate-limiting. If a single bug fires UNKNOWN 1000x in a minute, the table grows. Acceptable: factory_decisions volume is low vs task events; the hit count is itself the actionable signal.
- No automatic rule synthesis. The engine still routes to `['retry', 'escalate']` default chain — guard is observability only.

## Doc table sync (auto-generation)

The doc table in `docs/factory-loop-states.md` becomes auto-generated. Mechanism:

- Delimited block in the doc:

```markdown
<!-- BEGIN AUTOGEN: decision-actions-table -->
| Stage | Action | Classifier | Outcome shape |
|---|---|---|---|
...
<!-- END AUTOGEN: decision-actions-table -->
```

- Renderer script: `server/factory/scripts/render-decision-actions-doc.js`. Reads `DECISION_ACTIONS`, prints markdown table.
- `--write` flag updates the doc in place; bare invocation prints to stdout.
- Test asserts the rendered output matches the doc's autogen-block content. Fails CI if doc and catalog disagree.

The prose around the table (commentary, transition catalog, pause-variant table) stays hand-written. Only the decision-action emission map is autogen.

## Migration & rollout

Steps land in dependency order so each commit ships value and CI stays green throughout.

1. **Audit infrastructure** — add `audit-decision-actions.js`. Run locally; capture gap report. No CI gate yet.
2. **Catalog file** — add `decision-actions.js` populated with current emissions. Best-effort classification.
3. **Triage and gap-fix** — fix `emitted_no_classifier` and `rule_id_mismatch` first. End state: zero gaps.
4. **Production guard** — add `auto_recovery_unknown_action` emission + catalog entry + engine short-circuit.
5. **CI gate** — add `factory-decision-actions-catalog.test.js`. Should pass green.
6. **Doc autogen** — add `render-decision-actions-doc.js`, autogen block in doc, snapshot test.
7. **Operator docs** — add SQL queries + update "When changing the loop" section.

**Cutover:** No restart barrier required. Recovery engine emits one new decision action and reads from a new file. Standard `worktree-cutover.sh`.

**Rollback:** Each step is its own commit; revert in reverse order. Catalog file deletion alone is harmless if the test is also reverted.

## Risk surface

- **Step 3 triage is the highest-judgment step.** Wrong classifier kind means recovery flow behaves differently. Mitigation: default to `recovery-rule` + `retry`-only when ambiguous.
- **Production guard recursion bomb.** Mitigated by engine classifier short-circuit on `auto_recovery_unknown_action` before rule-matching.
- **Autogen block formatting drift.** Hand-edits inside the autogen-bounded markdown caught by snapshot test. Deleted delimiters caught loudly when renderer runs.
- **Dynamic action sites.** Static analysis can't classify them. Listed as warnings; operator triages each (refactor to literal vs document why dynamic). Production guard catches misses in operation.

## Test coverage

- `factory-decision-actions-catalog.test.js` — the CI gate (Section 4).
- A snapshot/string-match test for the doc autogen block (Section 6).
- Unit tests for `runDecisionActionsAudit` exercising each gap category with synthetic input fixtures (so the audit script's logic is independently testable).
- A regression test for the production guard's recursion defense — invoking the classifier directly with `action: 'auto_recovery_unknown_action'` must return the engine short-circuit, not enter the rule-matching loop.

## Documentation deliverables

- This spec at `docs/superpowers/specs/2026-05-07-factory-decision-actions-catalog-design.md`.
- `docs/factory-loop-states.md`:
  - Decision-action emission map becomes the autogen block.
  - "Finding production drift" section with the two SQL queries.
  - "When changing the loop" section's step 3 (decision actions) updated to point at `decision-actions.js` as the canonical source.

## Open questions / risks

- **Audit script's regex parser may miss exotic emit sites.** E.g., a `safeLogDecision` invocation built from a wrapper function. Mitigation: the production guard catches misses in operation; AST upgrade is a follow-up.
- **The `outcome` field in the catalog is documentation-only.** Future strict validation (assert emit-site call uses exactly these keys) requires per-call-site analysis. Out of scope for v1; tracked as future work.
- **The 7 sub-projects are independent but the audit/catalog work is foundational.** Sub-projects 2–7 may add new emission sites; the CI gate from sub-project 1 means each later sub-project's changes will require catalog updates. This is the intent — but worth noting that completing this sub-project changes the development pattern for all factory-loop work going forward.
