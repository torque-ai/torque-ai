# Codex Fallback for EXECUTE — Phase 3 Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the plan-quality gap that Phase 2 left open. Free-provider plans frequently fail the plan-quality gate (`task_has_acceptance_criterion`); Phase 3 adds an auto-augmenter that injects missing verify commands derived from the project's `verify_command` default. Also fix the dangling Phase 2 canary submitTask stub so canary auto-recovery is genuinely functional. Optionally extend the existing decomposer to convert `codex_only` items into smaller free-eligible sub-items before parking.

**Architecture:** Auto-augmenter is a pure post-processor that runs on free-provider plans before they hit the plan-quality gate. The augmenter prefers Groq for an LLM-driven pass, falls back to a deterministic template that reads `project.config_json.verify_command`. The decompose-on-park hook reuses the existing `decomposeTask` from `server/db/host-complexity.js` and routes the resulting sub-items through the Phase 2 eligibility classifier. The canary wire-up replaces the container's stub with a real `smart_submit_task` invocation so canary success drives `circuit:recovered`.

**Tech Stack:** Node.js + better-sqlite3; vitest; Groq via existing provider infrastructure.

**Phase scope:** Components C (Plan Auto-Augmenter) + E (Decompose-on-park) from `docs/superpowers/specs/2026-04-26-codex-fallback-execute-design.md`, plus the canary stub fix that Phase 2 deferred.

**Prerequisites:**
- Worktree: `.worktrees/feat-codex-fallback-phase3` on branch `feat/codex-fallback-phase3` (created from main after Phase 2 merge `7707517a`).
- Phase 1 + 2 already shipped on main.

---

## File Map

**Created:**
- `server/factory/plan-augmenter.js` — pure-ish module: `augment(plan, projectConfig, deps)` returns augmentedPlan. Uses Groq if available; falls back to deterministic template.
- `server/factory/canary-task-submitter.js` — small adapter exposing `submitCanaryTask(args)` that calls the real `smart_submit_task` handler.
- `server/tests/plan-augmenter.test.js`
- `server/tests/decompose-on-park.test.js`
- `server/tests/canary-task-submitter.test.js`
- `server/tests/integration/codex-fallback-phase3-smoke.test.js`

**Modified:**
- `server/factory/plan-quality-gate.js` — invokes the augmenter before validating free-provider plans.
- `server/factory/loop-controller.js` — when `decideCodexFallbackAction` returns `'park'` and the item is `codex_only`-classified, attempt decomposition first; only park if decomposition produces 0 free-eligible sub-items.
- `server/container.js` — wire `canaryTaskSubmitter`; replace the canary scheduler's stub `submitTask` with the real adapter.

---

## Conventions
- Tests under `server/tests/` per Phase 1/2 patterns.
- `db.prepare(...).run()` for fixtures.
- Commit messages: `feat(codex-fallback-3):`, `fix(codex-fallback-3):`, `test(codex-fallback-3):`.
- All commits on `feat/codex-fallback-phase3`. Tests via `torque-remote npx vitest run <path>` with local fallback (remote workstation has been flaky — local-vitest verification is acceptable per Phase 2 precedent).

---

## Task 1: Plan Auto-Augmenter

**Files:**
- Create: `server/factory/plan-augmenter.js`
- Create: `server/tests/plan-augmenter.test.js`

**Behavior:**
- `augment(plan, projectConfig, deps)` where `deps = { groqClient, logger }`.
- Iterates `plan.tasks`. For each task missing an acceptance criterion (no `verify` field, no `assert` field, no test command in description), derive one from `projectConfig.verify_command`.
- If `groqClient` is available, call it with a scaffolded prompt: "Add a verify command to this task. Project's verify command: `<verify>`. Task: `<task>`." Validate the LLM response against the plan-task schema before accepting.
- On Groq failure or schema-validation failure: deterministic fallback. Insert literal: ``Run `<verify_command>` and assert no new failures.``
- If `projectConfig.verify_command` is empty: skip augmentation, log a warning, return plan unchanged.
- Returns `{ plan: augmentedPlan, augmented: number, fallback: number }` for telemetry.

**Step 1: Write failing tests**

```javascript
'use strict';
/* global describe, it, expect, vi */

const { augment } = require('../factory/plan-augmenter');

describe('plan-augmenter', () => {
  it('returns plan unchanged if all tasks have acceptance criteria', async () => {
    const plan = { tasks: [
      { description: 'Do X', verify: 'npm test' },
      { description: 'Do Y', assert: 'lints clean' },
    ]};
    const result = await augment(plan, { verify_command: 'npm test' }, {});
    expect(result.augmented).toBe(0);
    expect(result.plan.tasks).toEqual(plan.tasks);
  });

  it('augments missing acceptance criteria via deterministic fallback when no Groq client', async () => {
    const plan = { tasks: [{ description: 'Do X' }] };
    const result = await augment(plan, { verify_command: 'npm test' }, {});
    expect(result.augmented).toBe(1);
    expect(result.fallback).toBe(1);
    expect(result.plan.tasks[0].verify).toMatch(/npm test/);
  });

  it('uses Groq when available', async () => {
    const groqClient = vi.fn().mockResolvedValue({
      tasks: [{ description: 'Do X', verify: 'pytest -k test_x and assert exit 0' }],
    });
    const plan = { tasks: [{ description: 'Do X' }] };
    const result = await augment(plan, { verify_command: 'pytest' }, { groqClient });
    expect(groqClient).toHaveBeenCalled();
    expect(result.augmented).toBe(1);
    expect(result.fallback).toBe(0);
    expect(result.plan.tasks[0].verify).toContain('pytest');
  });

  it('falls back to deterministic template on Groq failure', async () => {
    const groqClient = vi.fn().mockRejectedValue(new Error('groq down'));
    const plan = { tasks: [{ description: 'Do X' }] };
    const result = await augment(plan, { verify_command: 'npm test' }, { groqClient });
    expect(result.augmented).toBe(1);
    expect(result.fallback).toBe(1);
    expect(result.plan.tasks[0].verify).toMatch(/npm test/);
  });

  it('falls back when Groq returns malformed JSON', async () => {
    const groqClient = vi.fn().mockResolvedValue({ totally: 'wrong shape' });
    const plan = { tasks: [{ description: 'Do X' }] };
    const result = await augment(plan, { verify_command: 'npm test' }, { groqClient });
    expect(result.fallback).toBe(1);
  });

  it('skips augmentation when project has no verify_command', async () => {
    const plan = { tasks: [{ description: 'Do X' }] };
    const result = await augment(plan, {}, {});
    expect(result.augmented).toBe(0);
    expect(result.plan.tasks[0].verify).toBeUndefined();
  });

  it('handles empty/null plan gracefully', async () => {
    const result = await augment(null, { verify_command: 'npm test' }, {});
    expect(result.plan).toBeNull();
    expect(result.augmented).toBe(0);
  });

  it('preserves existing fields on augmented tasks', async () => {
    const plan = { tasks: [{ description: 'Do X', priority: 5, files: ['x.js'] }] };
    const result = await augment(plan, { verify_command: 'npm test' }, {});
    expect(result.plan.tasks[0].priority).toBe(5);
    expect(result.plan.tasks[0].files).toEqual(['x.js']);
    expect(result.plan.tasks[0].verify).toBeDefined();
  });
});
```

**Step 2: Run, expect FAIL.**

`torque-remote npx vitest run server/tests/plan-augmenter.test.js` (or `cd server && npx vitest run tests/plan-augmenter.test.js`).

**Step 3: Implement**

```javascript
'use strict';

const PROMPT_TEMPLATE = `You are augmenting a plan task with a verify command.
Project verify command: {{verify_command}}
Task: {{task_description}}

Return JSON: { "verify": "<one-line verify command>" }
Use the project's verify_command as the basis. Be specific about what success looks like.`;

function hasAcceptanceCriterion(task) {
  if (!task) return false;
  if (typeof task.verify === 'string' && task.verify.trim()) return true;
  if (typeof task.assert === 'string' && task.assert.trim()) return true;
  // Description-level signals: contains "run X and assert Y" or "test command:"
  if (typeof task.description === 'string') {
    if (/\b(verify|assert|expect)\b.*(?:passes?|succeeds?|equals?|=)/i.test(task.description)) return true;
    if (/\btest\s+command:/i.test(task.description)) return true;
  }
  return false;
}

function deterministicVerify(verifyCommand, taskDescription) {
  return 'Run `' + verifyCommand + '` and assert no new failures.';
}

async function augment(plan, projectConfig, deps = {}) {
  const result = { plan, augmented: 0, fallback: 0 };
  if (!plan || !Array.isArray(plan.tasks)) return result;
  const verify = projectConfig && typeof projectConfig.verify_command === 'string' && projectConfig.verify_command.trim();
  if (!verify) {
    if (deps.logger) deps.logger.warn('[codex-fallback-3] augmenter skipped: no verify_command on project');
    return result;
  }

  const log = deps.logger || { info() {}, warn() {} };
  const newTasks = [];

  for (const task of plan.tasks) {
    if (hasAcceptanceCriterion(task)) {
      newTasks.push(task);
      continue;
    }

    let augmentedTask = null;
    if (deps.groqClient) {
      try {
        const response = await deps.groqClient(PROMPT_TEMPLATE
          .replace('{{verify_command}}', verify)
          .replace('{{task_description}}', task.description || ''));
        // Validate response shape — expect { verify: string } or { tasks: [{ verify: string }] }.
        let verifyText = null;
        if (response && typeof response.verify === 'string') verifyText = response.verify;
        else if (response && Array.isArray(response.tasks) && response.tasks[0] && typeof response.tasks[0].verify === 'string') {
          verifyText = response.tasks[0].verify;
        }
        if (verifyText && verifyText.trim()) {
          augmentedTask = { ...task, verify: verifyText.trim() };
        }
      } catch (err) {
        log.warn('[codex-fallback-3] augmenter Groq call failed', { error: err.message });
      }
    }

    if (!augmentedTask) {
      augmentedTask = { ...task, verify: deterministicVerify(verify, task.description) };
      result.fallback += 1;
    }

    result.augmented += 1;
    newTasks.push(augmentedTask);
  }

  result.plan = { ...plan, tasks: newTasks };
  return result;
}

module.exports = { augment, hasAcceptanceCriterion, deterministicVerify };
```

**Step 4: PASS — 8 tests.**

**Step 5: Commit**

```bash
git add server/factory/plan-augmenter.js server/tests/plan-augmenter.test.js
git commit -m "feat(codex-fallback-3): add plan auto-augmenter"
```

---

## Task 2: Wire augmenter into plan-quality-gate

**Files:**
- Modify: `server/factory/plan-quality-gate.js`

**Behavior:** When the gate is about to validate a plan AND the plan was generated by a free provider (heuristic: `plan.metadata.executor === 'free'` or similar — read the file to find the actual signal), call `augment()` first. If augmentation succeeds, validate the augmented plan. If validation still fails after augmentation, the existing re-plan loop handles it (Phase 3 doesn't change the loop).

**Step 1: Read** `server/factory/plan-quality-gate.js` — find the validation entry point and any existing executor / provider metadata on the plan.

**Step 2: Add a small test** (the bulk of behavior is covered by Task 1's unit tests; this test verifies the gate calls the augmenter on free-provider plans).

**Step 3: Implement** — call `augment` before validation when the plan came from a free provider. Threading: the augmenter needs `projectConfig` (already in scope at the gate) and a `groqClient` dep (read existing provider clients in the file).

If the gate doesn't have access to a Groq client at this layer, run the augmenter in deterministic mode only (no LLM call). The deterministic fallback alone closes most of the gap — the LLM-augmented path is a quality improvement, not a requirement.

**Step 4: Commit**

```bash
git add server/factory/plan-quality-gate.js server/tests/plan-quality-gate-augmenter.test.js
git commit -m "feat(codex-fallback-3): plan-quality-gate runs auto-augmenter on free-provider plans"
```

---

## Task 3: Decompose-on-park hook

**Files:**
- Modify: `server/factory/loop-controller.js` — the existing PRIORITIZE branch where `decideCodexFallbackAction` returns `'park'`. Before calling `parkWorkItemForCodex`, attempt to decompose the item into free-eligible sub-items using `host-complexity.decomposeTask`.

**Behavior:**
- When `decision.action === 'park'` and the breaker is tripped (we know it is, since that's the only path that returns `park`):
  1. Call `decomposeTask(workItem.title, workingDirectory)` from `server/db/host-complexity.js`.
  2. For each sub-item in the result, classify it via Phase 2's `eligibility-classifier.classify`.
  3. If ≥1 sub-item is `free` eligible, replace the original item with the sub-items in the work-item table and route the eligible ones (don't park).
  4. If 0 sub-items are free-eligible, fall through to the existing park behavior.
- Failure cases (decomposer crashes, returns nothing useful) → park unchanged.

**Step 1: Test**

Create `server/tests/decompose-on-park.test.js` that exercises the decompose-then-park flow via the helper.

**Step 2: Implement**

Add a small helper in loop-controller.js:

```javascript
function decomposeBeforePark({ db, projectId, workItem, projectConfig }) {
  try {
    const { decomposeTask } = require('../db/host-complexity');
    const subtasks = decomposeTask(workItem.title || '', workItem.working_directory || '');
    if (!subtasks || subtasks.length === 0) return { decomposed: false, eligibleCount: 0 };
    const { classify } = require('../routing/eligibility-classifier');
    let eligibleCount = 0;
    for (const sub of subtasks) {
      const subItem = { category: sub.category || workItem.category || 'default' };
      const subPlan = { tasks: [{ files_touched: sub.files || [], estimated_lines: sub.lines || 0 }] };
      const result = classify(subItem, subPlan, projectConfig);
      if (result.eligibility === 'free') eligibleCount += 1;
    }
    return { decomposed: true, eligibleCount, subtaskCount: subtasks.length };
  } catch (err) {
    return { decomposed: false, eligibleCount: 0, error: err.message };
  }
}
```

In the existing `'park'` branch, call `decomposeBeforePark`. If `eligibleCount > 0`, replace the work item with the sub-items (DB write). Otherwise fall through to the existing `parkWorkItemForCodex`.

**Step 3: Commit**

```bash
git add server/factory/loop-controller.js server/tests/decompose-on-park.test.js
git commit -m "feat(codex-fallback-3): decompose codex_only items before parking"
```

---

## Task 4: Canary stub real wire-up

**Files:**
- Create: `server/factory/canary-task-submitter.js`
- Modify: `server/container.js` — replace canary scheduler's stub `submitTask`.

**Behavior:**
- `submitCanaryTask({ description, ... })` calls the real `smart_submit_task` handler with `provider: 'codex'`, `is_canary: true`, and a short read-only description.
- The `smart_submit_task` handler is at `server/handlers/...` somewhere — find it. Or wire via the MCP tool dispatch.
- On Codex success, the existing close-handler's `recordSuccess` path in completion-pipeline.js (Phase 1's behavior) untrips the breaker.

**Step 1: Find** the in-process equivalent of `smart_submit_task` (search `handleSmartSubmitTask` or `smartSubmit`).

**Step 2: Write** the adapter:

```javascript
'use strict';

const { defaultContainer } = require('../container');

async function submitCanaryTask({ description, logger }) {
  // Use the in-process submit-task entry point so close-handler still records the result.
  // Match the existing handler API surface.
  const handlers = require('../handlers/task-submission'); // or wherever
  const args = {
    description,
    provider: 'codex',
    is_canary: true,
    timeout_minutes: 5,
  };
  const result = await handlers.handleSmartSubmitTask(args);
  if (logger) logger.info('[codex-fallback-3] canary submitted', { result });
  return result;
}

module.exports = { submitCanaryTask };
```

(The exact handler name and import path depend on what you find. Read first.)

**Step 3: Replace stub** in `server/container.js`:

```javascript
_defaultContainer.register(
  'canaryScheduler',
  ['eventBus', 'logger'],
  ({ eventBus, logger: log }) => {
    const { createCanaryScheduler } = require('./factory/canary-scheduler');
    const { submitCanaryTask } = require('./factory/canary-task-submitter');
    return createCanaryScheduler({
      eventBus,
      submitTask: (args) => submitCanaryTask({ description: args.description, logger: log }),
      logger: log,
    });
  }
);
```

**Step 4: Commit**

```bash
git add server/factory/canary-task-submitter.js server/container.js server/tests/canary-task-submitter.test.js
git commit -m "fix(codex-fallback-3): wire canary scheduler to real smart_submit_task"
```

---

## Task 5: Phase 3 integration smoke test

**Files:**
- Create: `server/tests/integration/codex-fallback-phase3-smoke.test.js`

**Scenarios:**
1. **Augmenter end-to-end.** Generate a plan missing acceptance criteria, run through `augment()`, verify all tasks now have a `verify` field that matches the project's `verify_command`.
2. **Decompose-then-park.** Set up a `codex_only` work item; trigger the park decision; confirm the helper returns a result that either yields free-eligible sub-items OR falls through to park.
3. **Canary submitter** (mocked at the handler boundary since real Codex isn't available in tests). Verify the adapter calls the right handler with the right args.
4. Full Phase 3 surface run.

**Step 1: Implement** mirroring Phase 1/2 smoke test patterns.

**Step 2: Run**

```bash
cd server && npx vitest run tests/integration/codex-fallback-phase3-smoke.test.js
```

**Step 3: Commit**

```bash
git add server/tests/integration/codex-fallback-phase3-smoke.test.js
git commit -m "test(codex-fallback-3): Phase 3 integration smoke test"
```

Then `scripts/worktree-cutover.sh codex-fallback-phase3`.

---

## Self-Review

**Spec coverage:**
- ✓ Component C (auto-augmenter) — Task 1 + Task 2.
- ✓ Component E (decompose-on-park) — Task 3.
- ✓ Phase 2's canary stub — Task 4 (bonus follow-up).
- ✓ Smoke test — Task 5.

**Out of scope:**
- Plan-quality gate calibration changes (the gate stays strict; augmenter just helps plans pass it).
- Provider scoring feedback from augmentation success rate (could be a future enhancement).
- Multi-provider circuit breakers — this whole arc is Codex-specific.

**Type/method consistency:**
- `augment(plan, projectConfig, deps)` returns `{ plan, augmented, fallback }`.
- `decomposeBeforePark({ db, projectId, workItem, projectConfig })` returns `{ decomposed, eligibleCount, subtaskCount? }`.
- `submitCanaryTask({ description, logger })` returns the handler's result shape.

**Dependencies between tasks:**
- Tasks 1 + 2: 2 depends on 1.
- Task 3 is independent (uses Phase 2's `eligibility-classifier`).
- Task 4 is independent (replaces Phase 2's stub).
- Task 5 depends on 1, 2, 3, 4.

The 4 implementation tasks are mostly independent and small. Phase 3 should ship in roughly half the time of Phase 2.
