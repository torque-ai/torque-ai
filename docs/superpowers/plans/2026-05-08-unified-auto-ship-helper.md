# Unified Auto-Ship Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three implicit auto-ship decision actions (`auto_shipped_at_prioritize`, `auto_shipped_empty_branch`, `auto_shipped_at_verify_fail`) with a single canonical action `auto_shipped` carrying a frozen reason enum. Future auto-ship paths add a reason value rather than a new decision action.

**Architecture:** New focused helper module `server/factory/auto-ship.js` exports `emitAutoShipped()` and `AUTO_SHIPPED_REASONS`. Helper does emission only — caller still handles `factoryIntake.updateWorkItem` and constructs return values. Catalog goes from 3 stage-keyed terminal entries to 1 cross-stage entry. Hard cut, no alias period.

**Tech Stack:** Node.js 20+, vitest (server/), CommonJS modules.

**Spec:** `docs/superpowers/specs/2026-05-08-unified-auto-ship-helper-design.md`

---

## File Structure

**New files:**
- `server/factory/auto-ship.js` — helper module (`emitAutoShipped`, `AUTO_SHIPPED_REASONS`)
- `server/tests/auto-ship.test.js` — 9 unit tests

**Modified files:**
- `server/factory/loop-controller.js` — 3 emit-site rewrites + 1 import line
- `server/factory/decision-actions.js` — remove 3 entries, add 1
- `docs/factory-loop-states.md` — autogen-block re-rendered + operator runbook note

---

## Conventions

- `'use strict'` + `require()` only. Vitest globals (no `import` statements). Established convention from sub-project 1.
- Test runs from inside the worktree's `server/` directory:
  ```bash
  torque-remote bash -c 'cd server && npx vitest run tests/auto-ship.test.js 2>&1 | tail -10'
  ```
  When the remote is unreachable, `torque-remote` falls back to local execution; both work.
- Audit script run as a smoke check after Task 2 (from worktree root):
  ```bash
  node server/factory/scripts/audit-decision-actions.js
  ```
  Expected: exit 0, "All gap categories empty."

---

### Task 1: Create the auto-ship helper module + tests

**Files:**
- Create: `server/factory/auto-ship.js`
- Create: `server/tests/auto-ship.test.js`

**Goal:** New module exports `emitAutoShipped()` (validates reason against frozen enum, emits via `decisionLog.logDecision`) and `AUTO_SHIPPED_REASONS` (frozen enum with three values). 9 unit tests cover the spec's coverage targets.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/auto-ship.test.js`:

```js
'use strict';

const { vi } = require('vitest');

// Mock decision-log before requiring the helper, so emitAutoShipped picks
// up the recording stub. Tests in this file capture every decision the
// helper emits.
const recorded = [];
vi.mock('../factory/decision-log', () => ({
  logDecision: (entry) => {
    recorded.push(entry);
    return { id: recorded.length };
  },
}));

const { emitAutoShipped, AUTO_SHIPPED_REASONS } = require('../factory/auto-ship');

beforeEach(() => {
  recorded.length = 0;
});

describe('AUTO_SHIPPED_REASONS', () => {
  it('exposes three reason values', () => {
    expect(AUTO_SHIPPED_REASONS.AT_PRIORITIZE).toBe('at_prioritize');
    expect(AUTO_SHIPPED_REASONS.EMPTY_BRANCH_MERGE_FAIL).toBe('empty_branch_merge_fail');
    expect(AUTO_SHIPPED_REASONS.AT_VERIFY_FAIL).toBe('at_verify_fail');
  });

  it('is frozen — cannot mutate or add reasons at runtime', () => {
    expect(Object.isFrozen(AUTO_SHIPPED_REASONS)).toBe(true);
    expect(() => { AUTO_SHIPPED_REASONS.NEW_REASON = 'foo'; }).toThrow();
  });
});

describe('emitAutoShipped', () => {
  it('emits a decision with action=auto_shipped and reason in outcome', () => {
    emitAutoShipped({
      project_id: 1,
      stage: 'PRIORITIZE',
      reason: AUTO_SHIPPED_REASONS.AT_PRIORITIZE,
      work_item_id: 'wi-7',
      confidence: 'high',
      signals: ['commit-match', 'title-match'],
    });
    expect(recorded.length).toBe(1);
    expect(recorded[0].action).toBe('auto_shipped');
    expect(recorded[0].stage).toBe('PRIORITIZE');
    expect(recorded[0].outcome.reason).toBe('at_prioritize');
    expect(recorded[0].outcome.work_item_id).toBe('wi-7');
    expect(recorded[0].outcome.confidence).toBe('high');
    expect(recorded[0].outcome.signals).toEqual(['commit-match', 'title-match']);
    expect(recorded[0].inputs.reason).toBe('at_prioritize');
  });

  it('throws on unknown reason with a clear message listing valid values', () => {
    expect(() => emitAutoShipped({
      project_id: 1,
      stage: 'PRIORITIZE',
      reason: 'made_up_reason',
      work_item_id: 'wi-7',
      confidence: 'high',
      signals: [],
    })).toThrow(/unknown reason "made_up_reason"/);

    expect(() => emitAutoShipped({
      project_id: 1,
      stage: 'PRIORITIZE',
      reason: 'made_up_reason',
      work_item_id: 'wi-7',
      confidence: 'high',
      signals: [],
    })).toThrow(/at_prioritize/);
  });

  it('accepts every declared reason without error (parametric coverage)', () => {
    for (const value of Object.values(AUTO_SHIPPED_REASONS)) {
      expect(() => emitAutoShipped({
        project_id: 1,
        stage: 'PRIORITIZE',
        reason: value,
        work_item_id: 'wi-7',
        confidence: 'high',
        signals: [],
      })).not.toThrow();
    }
    expect(recorded.length).toBe(Object.values(AUTO_SHIPPED_REASONS).length);
  });

  it('merges extra keys into outcome (preserves stage-specific context)', () => {
    emitAutoShipped({
      project_id: 1,
      stage: 'LEARN',
      reason: AUTO_SHIPPED_REASONS.EMPTY_BRANCH_MERGE_FAIL,
      work_item_id: 'wi-7',
      confidence: 'medium',
      signals: ['title-match'],
      batch_id: 'batch-42',
      extra: {
        factory_worktree_id: 'wt-1',
        resolution_source: 'auto-detector',
        error: 'no commits ahead',
      },
    });
    expect(recorded[0].outcome.factory_worktree_id).toBe('wt-1');
    expect(recorded[0].outcome.resolution_source).toBe('auto-detector');
    expect(recorded[0].outcome.error).toBe('no commits ahead');
    // Core fields still present:
    expect(recorded[0].outcome.work_item_id).toBe('wi-7');
    expect(recorded[0].outcome.reason).toBe('empty_branch_merge_fail');
    expect(recorded[0].batch_id).toBe('batch-42');
  });

  it('generates default reasoning when caller does not pass one', () => {
    emitAutoShipped({
      project_id: 1,
      stage: 'VERIFY',
      reason: AUTO_SHIPPED_REASONS.AT_VERIFY_FAIL,
      work_item_id: 'wi-7',
      confidence: 'high',
      signals: [],
    });
    expect(recorded[0].reasoning).toMatch(/Auto-shipped at VERIFY/);
    expect(recorded[0].reasoning).toMatch(/reason=at_verify_fail/);
    expect(recorded[0].reasoning).toMatch(/confidence=high/);
  });

  it('preserves caller-provided reasoning override', () => {
    emitAutoShipped({
      project_id: 1,
      stage: 'PRIORITIZE',
      reason: AUTO_SHIPPED_REASONS.AT_PRIORITIZE,
      work_item_id: 'wi-7',
      confidence: 'high',
      signals: [],
      reasoning: 'Custom reasoning string for this site',
    });
    expect(recorded[0].reasoning).toBe('Custom reasoning string for this site');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
torque-remote bash -c 'cd server && npx vitest run tests/auto-ship.test.js 2>&1 | tail -15'
```

Expected: tests FAIL with "Cannot find module '../factory/auto-ship'".

- [ ] **Step 3: Implement the helper module**

Create `server/factory/auto-ship.js`:

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
 *
 * @param {object} args
 * @param {string|number} args.project_id
 * @param {string} args.stage          - LOOP_STATES value where the auto-ship fires
 * @param {string} args.reason         - One of AUTO_SHIPPED_REASONS values
 * @param {string|number} args.work_item_id
 * @param {string} args.confidence     - shipped-detector confidence ('high' | 'medium' | 'low')
 * @param {Array}  args.signals        - shipped-detector match signals
 * @param {string} [args.batch_id]     - Decision batch ID
 * @param {object} [args.extra]        - Stage-specific outcome keys merged into outcome
 * @param {string} [args.reasoning]    - Optional reasoning override; defaults to a stage+reason string
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

  const outcome = {
    work_item_id,
    confidence,
    signals,
    reason,
    ...extra,
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

- [ ] **Step 4: Run tests to verify pass**

```bash
torque-remote bash -c 'cd server && npx vitest run tests/auto-ship.test.js 2>&1 | tail -15'
```

Expected: 9 tests PASS (2 enum + 7 emitAutoShipped). Total: 9.

- [ ] **Step 5: Commit**

```bash
git add server/factory/auto-ship.js server/tests/auto-ship.test.js
git commit -m "feat(factory): add auto-ship helper with reason enum"
```

---

### Task 2: Migrate three call sites + update catalog atomically

**Files:**
- Modify: `server/factory/loop-controller.js` — 3 emit-site rewrites + 1 import
- Modify: `server/factory/decision-actions.js` — remove 3 entries (lines 60, 570, 684), add 1 entry

**Goal:** Switch the three call sites from inline `safeLogDecision({ action: 'auto_shipped_*', ... })` to `emitAutoShipped({ reason, ... })`. Update the catalog atomically so the audit gate stays green. Re-run audit + tests.

The catalog change MUST be in the same commit as the call-site changes — splitting them creates a window where the audit gate fails.

- [ ] **Step 1: Add the import to loop-controller.js**

Find the existing `require('./shipped-detector')` or similar `require('./<sibling>')` near the top of `server/factory/loop-controller.js`. Add the new import in that neighborhood:

```js
const { emitAutoShipped, AUTO_SHIPPED_REASONS } = require('./auto-ship');
```

If unsure where to place it, place it directly above the `safeLogDecision` definition (around line 3696). The exact location doesn't matter as long as the names resolve at call time.

- [ ] **Step 2: Migrate Site 1 — PRIORITIZE (line ~4665)**

Find this block in `server/factory/loop-controller.js`:

```js
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.PRIORITIZE,
        action: 'auto_shipped_at_prioritize',
        reasoning: `Shipped-detector found existing commits matching "${workItem.title}" with ${detection.confidence} confidence — skipping to next item.`,
        inputs: { ...getWorkItemDecisionContext(workItem) },
        outcome: {
          work_item_id: workItem.id,
          confidence: detection.confidence,
          signals: detection.signals,
        },
        confidence: 1,
        batch_id: getDecisionBatchId(project, workItem, null, instance),
      });
```

Replace with:

```js
      emitAutoShipped({
        project_id: project.id,
        stage: LOOP_STATES.PRIORITIZE,
        reason: AUTO_SHIPPED_REASONS.AT_PRIORITIZE,
        work_item_id: workItem.id,
        confidence: detection.confidence,
        signals: detection.signals,
        batch_id: getDecisionBatchId(project, workItem, null, instance),
        extra: { ...getWorkItemDecisionContext(workItem) },
        reasoning: `Shipped-detector found existing commits matching "${workItem.title}" with ${detection.confidence} confidence — skipping to next item.`,
      });
```

The key change: `getWorkItemDecisionContext(workItem)` keys move from `inputs` to `extra` (which merges into outcome).

- [ ] **Step 3: Migrate Site 2 — LEARN empty-branch (line ~3449)**

Find this block:

```js
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.LEARN,
                action: 'auto_shipped_empty_branch',
                reasoning: `Merge failed (no commits ahead) but shipped-detector found matching evidence on main (${detection.confidence} confidence). Marking shipped instead of leaving the loop stuck.`,
                inputs: {
                  batch_id: batch_id || null,
                  resolution_source: resolutionSource,
                },
                outcome: { ...sharedOutcome, work_item_id: workItem.id },
                confidence: 1,
                batch_id: shippingDecision.decision_batch_id || decisionBatchId,
              });
```

Replace with:

```js
              emitAutoShipped({
                project_id,
                stage: LOOP_STATES.LEARN,
                reason: AUTO_SHIPPED_REASONS.EMPTY_BRANCH_MERGE_FAIL,
                work_item_id: workItem.id,
                confidence: detection.confidence,
                signals: detection.signals,
                batch_id: shippingDecision.decision_batch_id || decisionBatchId,
                extra: {
                  ...sharedOutcome,
                  resolution_source: resolutionSource,
                },
                reasoning: `Merge failed (no commits ahead) but shipped-detector found matching evidence on main (${detection.confidence} confidence). Marking shipped instead of leaving the loop stuck.`,
              });
```

Key changes:
- `signals` lifted from `sharedOutcome.detection.signals` to a top-level required core key
- `sharedOutcome` and `resolution_source` move to `extra`
- `batch_id` moves from `inputs` (where it lived in old code) to a top-level helper field

- [ ] **Step 4: Migrate Site 3 — VERIFY fail (line ~12335)**

Find this block:

```js
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'auto_shipped_at_verify_fail',
                  reasoning: `Verify failed but shipped-detector found matching commits on main (${detection.confidence} confidence). Marking shipped instead of auto-rejecting.`,
                  inputs: { work_item_id: wi.id },
                  outcome: { confidence: detection.confidence, signals: detection.signals },
                  confidence: 1,
                  batch_id,
                });
```

Replace with:

```js
                emitAutoShipped({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  reason: AUTO_SHIPPED_REASONS.AT_VERIFY_FAIL,
                  work_item_id: wi.id,
                  confidence: detection.confidence,
                  signals: detection.signals,
                  batch_id,
                  reasoning: `Verify failed but shipped-detector found matching commits on main (${detection.confidence} confidence). Marking shipped instead of auto-rejecting.`,
                });
```

Cleanest of the three — no `extra` needed.

- [ ] **Step 5: Update catalog — remove three entries, add one**

In `server/factory/decision-actions.js`:

Remove the entry at line ~60:
```js
  auto_shipped_at_prioritize: {
    stage: 'PRIORITIZE',
    classifier: 'terminal',
    outcome: ['work_item_id', 'status'],
  },
```

Remove the entry at line ~570 (search for `auto_shipped_at_verify_fail`):
```js
  auto_shipped_at_verify_fail: {
    stage: 'VERIFY',
    classifier: 'terminal',
    outcome: [...],
  },
```

Remove the entry at line ~684 (search for `auto_shipped_empty_branch`):
```js
  auto_shipped_empty_branch: {
    stage: 'LEARN',
    classifier: 'terminal',
    outcome: [...],
  },
```

Add a single new entry in the appropriate ANY-stage block (search for `auto_recovery_classified` or another `stage: 'ANY'` entry to find the section):

```js
  auto_shipped: {
    stage: 'ANY',
    classifier: 'terminal',
    outcome: ['work_item_id', 'confidence', 'signals', 'reason'],
  },
```

- [ ] **Step 6: Run audit script — verify gate is clean**

From the worktree root:

```bash
node server/factory/scripts/audit-decision-actions.js
```

Expected output:
```
=== factory_decisions audit ===
Total literal emit sites: 141
Dynamic-action sites: 15

All gap categories empty.
```

Exit code: 0.

If `emitted_not_in_catalog` shows `auto_shipped_at_prioritize` or similar, you've removed catalog entries but a call site still emits the old name — re-check Steps 2-4. If `catalog_not_emitted` shows `auto_shipped_at_prioritize` (etc.), you've kept catalog entries that are no longer emitted — re-check Step 5.

- [ ] **Step 7: Run vitest tests — verify nothing regressed**

```bash
torque-remote bash -c 'cd server && npx vitest run tests/auto-ship.test.js tests/audit-decision-actions.test.js tests/factory-decision-actions-catalog.test.js tests/auto-recovery-unknown-action.test.js tests/render-decision-actions-doc.test.js 2>&1 | tail -15'
```

Expected: 38 tests PASS (9 from Task 1 + 18 audit + 5 catalog gate + 3 unknown-action + 3 renderer).

The CI gate `factory-decision-actions-catalog.test.js` (5 tests) explicitly verifies `runDecisionActionsAudit({ rootDir, catalog: DECISION_ACTIONS })` returns no gaps — this is the integration check.

- [ ] **Step 8: Commit (atomic call-site + catalog)**

```bash
git add server/factory/loop-controller.js server/factory/decision-actions.js
git commit -m "$(cat <<'EOF'
refactor(factory): unify auto-ship emit sites under emitAutoShipped helper

Three independent decision actions (auto_shipped_at_prioritize,
auto_shipped_empty_branch, auto_shipped_at_verify_fail) collapse into
one canonical action 'auto_shipped' with a frozen AUTO_SHIPPED_REASONS
enum (AT_PRIORITIZE / EMPTY_BRANCH_MERGE_FAIL / AT_VERIFY_FAIL). New
auto-ship paths add a reason value rather than a new decision action.

Call-site shape changes:
- inputs no longer carries per-site context (now in outcome via extra)
- LEARN site: signals lifted from outcome.detection.signals to top-level
  outcome.signals (helper required core)
- Caller return values unchanged (return { status: 'passed', reason: '...' })

Catalog: 143 -> 141 entries (3 removed, 1 added).
Audit gate: All gap categories empty.
EOF
)"
```

---

### Task 3: Doc autogen regeneration + operator runbook note

**Files:**
- Modify: `docs/factory-loop-states.md` — autogen-block re-rendered + operator runbook addition

**Goal:** Re-run the renderer to update the autogen decision-action table in `docs/factory-loop-states.md` (3 rows removed, 1 row added). Add an operator-runbook note explaining the action rename so operators know how to query for new auto-ship rows.

- [ ] **Step 1: Run the renderer with --write**

From the worktree root:

```bash
node server/factory/scripts/render-decision-actions-doc.js --write
```

Expected output: `Wrote autogen table to <repo>/docs/factory-loop-states.md`.

Verify the diff shows three rows removed and one row added:

```bash
git diff docs/factory-loop-states.md | head -30
```

- [ ] **Step 2: Add the operator runbook note**

In `docs/factory-loop-states.md`, locate the existing "## Finding production drift" section (after the autogen-block, around line 296 in the current state).

Find the existing "When you find a hit:" line that comes after the second SQL block. Insert this new subsection immediately before that line:

```markdown
### Migration note: auto-ship action rename (2026-05-08)

The three previous auto-ship actions (`auto_shipped_at_prioritize`, `auto_shipped_empty_branch`, `auto_shipped_at_verify_fail`) were collapsed into a single `auto_shipped` action with a `reason` discriminator. Historical rows in `factory_decisions` retain their original action names; new rows use the unified shape.

Operator query patterns:

\`\`\`sql
-- All auto-ship rows (combines historical + new)
SELECT created_at, action,
       json_extract(outcome, '$.reason') AS reason,
       json_extract(outcome, '$.work_item_id') AS work_item_id
FROM factory_decisions
WHERE action IN ('auto_shipped', 'auto_shipped_at_prioritize',
                 'auto_shipped_empty_branch', 'auto_shipped_at_verify_fail')
ORDER BY created_at DESC;

-- Frequency by reason (new rows only)
SELECT json_extract(outcome, '$.reason') AS reason, COUNT(*) AS hits
FROM factory_decisions
WHERE action = 'auto_shipped'
GROUP BY reason
ORDER BY hits DESC;
\`\`\`

The reason values map 1:1 to the previous action names: `at_prioritize` <-> `auto_shipped_at_prioritize`, `empty_branch_merge_fail` <-> `auto_shipped_empty_branch`, `at_verify_fail` <-> `auto_shipped_at_verify_fail`.
```

(In the actual edit, replace the escaped `\`\`\`sql` and `\`\`\`` with real triple-backtick fences. The escaping above is to keep this code-block within this code-block readable.)

- [ ] **Step 3: Verify the autogen snapshot test still passes**

```bash
torque-remote bash -c 'cd server && npx vitest run tests/render-decision-actions-doc.test.js 2>&1 | tail -10'
```

Expected: 3 tests PASS (the snapshot test specifically asserts the doc's autogen-block content matches `renderTable(DECISION_ACTIONS)`).

- [ ] **Step 4: Commit**

```bash
git add docs/factory-loop-states.md
git commit -m "$(cat <<'EOF'
docs(factory): regenerate decision-actions table + auto-ship migration note

Renderer reflects the catalog change from sub-project 4 (3 auto-ship
rows replaced by 1 unified entry). Adds a 'Migration note' subsection
to 'Finding production drift' explaining the action rename and giving
operators query patterns that bridge historical rows (with old action
names) and new rows (action='auto_shipped' + reason discriminator).
EOF
)"
```

---

## Self-Review

**Spec coverage:**

- Module shape (Section 1) -> Task 1
- AUTO_SHIPPED_REASONS values (Section 2) -> Task 1 (enum) + Task 2 (call sites use them)
- Catalog impact (Section 3) -> Task 2 Step 5
- Call-site migration (Section 4) -> Task 2 Steps 2-4
- Tests (Section 5) -> Task 1 (9 unit tests; spec lists 7 coverage targets, plan implements 9 by splitting the enum tests; spec's intent is met)
- Migration & rollout (Section 6) -> Three commits per Tasks 1, 2, 3
- Risk surface notes (`inputs` semantics, `signals` shape) -> Documented in Task 2 Step 8 commit message

**Placeholder scan:** No `TBD`, no vague phrases. Each step has concrete code or commands.

**Type / name consistency:** `emitAutoShipped`, `AUTO_SHIPPED_REASONS`, `at_prioritize`, `empty_branch_merge_fail`, `at_verify_fail`, `auto_shipped`, `factory-loop` (actor) -- all consistent across tasks.

**Gaps:**
- The plan does not include the full vitest 4.x global verification — `vi.mock` should resolve via `const { vi } = require('vitest')` at the top of the test file. Already noted in the test code.
- The plan does not test caller return values (which are unchanged per the spec). Out of scope for this sub-project; existing handler tests cover the return-value contract.
