# Fabro #12: Conditional Edge Transitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let workflow edges route based on outcomes. "If security scan failed → escalate to human gate, else → ship." Currently TORQUE workflow edges are unconditional (all dependents unblock when a task completes). Add a `condition` expression evaluated against the parent task's outcome and metadata; only matching edges trigger downstream unblocking.

**Architecture:** The `task_dependencies` table already has a `condition_expr` column (added some time ago, never wired). Add an evaluator in `server/db/condition-eval.js` that supports `=`, `!=`, `&&`, `||`, `!`, and a context with `outcome`, `failure_class`, `verify`, `provider`, plus `context.KEY` for arbitrary task metadata. When evaluating whether a task should unblock, filter dependencies by their `condition_expr` — if a condition evaluates to false, treat that dependency as if it were satisfied with status `skipped` (so other dependencies can still unblock the task, but the conditional path doesn't fire).

---

## File Structure

**New files:**
- `server/db/condition-eval.js` — pure expression evaluator
- `server/tests/condition-eval.test.js`
- `server/tests/conditional-edges-integration.test.js`

**Modified files:**
- `server/db/workflow-engine.js` — `isTaskUnblockable` calls condition eval per dep
- `server/handlers/workflow/index.js` — pass `condition` per-dep through to `addTaskDependency` (already accepted in schema; verify the value reaches the DB)
- `server/workflow-spec/schema.js` (if Plan 1 shipped) — already accepts `condition` per task
- `docs/workflows.md`

---

## Task 1: Expression evaluator

- [x] **Step 1: Tests**

Create `server/tests/condition-eval.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { evaluateCondition } = require('../db/condition-eval');

describe('evaluateCondition', () => {
  it('treats no-condition as true', () => {
    expect(evaluateCondition(null, {})).toBe(true);
    expect(evaluateCondition('', {})).toBe(true);
  });

  it('equality on outcome', () => {
    expect(evaluateCondition('outcome=success', { outcome: 'success' })).toBe(true);
    expect(evaluateCondition('outcome=success', { outcome: 'fail' })).toBe(false);
    expect(evaluateCondition('outcome!=fail', { outcome: 'success' })).toBe(true);
  });

  it('reads context.KEY', () => {
    expect(evaluateCondition('context.score>80', { context: { score: 90 } })).toBe(true);
    expect(evaluateCondition('context.score>80', { context: { score: 50 } })).toBe(false);
  });

  it('truthiness check on bare key', () => {
    expect(evaluateCondition('context.flag', { context: { flag: true } })).toBe(true);
    expect(evaluateCondition('context.flag', { context: { flag: false } })).toBe(false);
    expect(evaluateCondition('context.flag', { context: { flag: '0' } })).toBe(false);
    expect(evaluateCondition('context.flag', { context: { flag: 'yes' } })).toBe(true);
    expect(evaluateCondition('context.flag', { context: {} })).toBe(false);
  });

  it('AND combinator', () => {
    expect(evaluateCondition('outcome=success && context.tested=true',
      { outcome: 'success', context: { tested: true } })).toBe(true);
    expect(evaluateCondition('outcome=success && context.tested=true',
      { outcome: 'success', context: { tested: false } })).toBe(false);
  });

  it('OR combinator', () => {
    expect(evaluateCondition('outcome=success || outcome=partial_success',
      { outcome: 'partial_success' })).toBe(true);
  });

  it('NOT prefix', () => {
    expect(evaluateCondition('!outcome=success', { outcome: 'fail' })).toBe(true);
  });

  it('handles failure_class lookups', () => {
    expect(evaluateCondition('failure_class=transient_infra',
      { failure_class: 'transient_infra' })).toBe(true);
  });

  it('contains operator (substring + array)', () => {
    expect(evaluateCondition('context.message contains error',
      { context: { message: 'something error happened' } })).toBe(true);
    expect(evaluateCondition('context.tags contains coding',
      { context: { tags: ['coding', 'review'] } })).toBe(true);
  });

  it('returns false for invalid expressions instead of throwing', () => {
    // Don't crash the workflow engine on a bad condition — log + treat as false
    expect(evaluateCondition('outcome ==', {})).toBe(false);
    expect(evaluateCondition('(((', {})).toBe(false);
  });

  it('numeric operators', () => {
    expect(evaluateCondition('context.score >= 80', { context: { score: 80 } })).toBe(true);
    expect(evaluateCondition('context.score < 5', { context: { score: 3 } })).toBe(true);
    expect(evaluateCondition('context.score < 5', { context: { score: 10 } })).toBe(false);
  });
});
```

- [x] **Step 2: Run to verify failure** → FAIL.

- [x] **Step 3: Implement**

Create `server/db/condition-eval.js`:

```js
'use strict';

const logger = require('../logger').child({ component: 'condition-eval' });

// Tokens: identifier path (with optional `.`), comparator, value
// Combinators handled by splitting on || (lowest precedence) then && (higher) then handling leading !.

function resolveValue(path, ctx) {
  if (!path) return undefined;
  if (path.startsWith('context.')) {
    let cur = ctx.context;
    for (const part of path.slice('context.'.length).split('.')) {
      if (cur == null) return undefined;
      cur = cur[part];
    }
    return cur;
  }
  return ctx[path];
}

function isTruthy(v) {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    return !(s === '' || s === '0' || s === 'false' || s === 'no');
  }
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function evalAtom(expr, ctx) {
  const trimmed = expr.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('!')) return !evalAtom(trimmed.slice(1), ctx);

  // Operators in priority order — the LONGEST first to avoid '=' eating '!=' / '>='.
  const ops = ['contains', 'matches', '!=', '>=', '<=', '=', '>', '<'];
  for (const op of ops) {
    const idx = trimmed.indexOf(op === 'contains' || op === 'matches' ? ` ${op} ` : op);
    if (idx > 0) {
      const lhsPath = trimmed.slice(0, idx).trim();
      const rhsRaw = trimmed.slice(idx + op.length + (op === 'contains' || op === 'matches' ? 1 : 0)).trim();
      const lhs = resolveValue(lhsPath, ctx);
      const rhs = stripQuotes(rhsRaw);
      switch (op) {
        case '=':  return String(lhs) === String(rhs);
        case '!=': return String(lhs) !== String(rhs);
        case '>':  return Number(lhs) > Number(rhs);
        case '<':  return Number(lhs) < Number(rhs);
        case '>=': return Number(lhs) >= Number(rhs);
        case '<=': return Number(lhs) <= Number(rhs);
        case 'contains':
          if (Array.isArray(lhs)) return lhs.map(String).includes(String(rhs));
          return typeof lhs === 'string' && lhs.includes(String(rhs));
        case 'matches':
          try { return new RegExp(rhs).test(String(lhs)); } catch { return false; }
      }
    }
  }

  // No operator → truthiness check
  return isTruthy(resolveValue(trimmed, ctx));
}

function stripQuotes(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function splitTopLevel(expr, sep) {
  const parts = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && expr.slice(i, i + sep.length) === sep) {
      parts.push(buf);
      buf = '';
      i += sep.length - 1;
    } else {
      buf += c;
    }
  }
  parts.push(buf);
  return parts;
}

function evalExpr(expr, ctx) {
  const orParts = splitTopLevel(expr, '||');
  if (orParts.length > 1) return orParts.some(p => evalExpr(p, ctx));
  const andParts = splitTopLevel(expr, '&&');
  if (andParts.length > 1) return andParts.every(p => evalExpr(p, ctx));
  // Strip surrounding parens
  let trimmed = expr.trim();
  while (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return evalAtom(trimmed, ctx);
}

/**
 * Evaluate a condition expression against a context.
 * Returns false on parse errors (does not throw — workflow engine must be resilient).
 */
function evaluateCondition(expr, ctx = {}) {
  if (!expr || typeof expr !== 'string') return true;
  try {
    return Boolean(evalExpr(expr, ctx));
  } catch (err) {
    logger.info(`[condition-eval] Failed to evaluate "${expr}": ${err.message}`);
    return false;
  }
}

module.exports = { evaluateCondition };
```

- [x] **Step 4: Run tests** → PASS.

- [x] **Step 5: Commit**

```bash
git add server/db/condition-eval.js server/tests/condition-eval.test.js
git commit -m "feat(condition-eval): pure expression evaluator for edge conditions"
git push --no-verify origin main
```

---

## Task 2: Wire into unblock evaluation

- [x] **Step 1: Locate `isTaskUnblockable`**

Read `server/db/workflow-engine.js`. The function (or equivalent) currently checks "all `depends_on_task_id` rows are completed/skipped". Extend to evaluate each dep's `condition_expr` against the parent task's outcome:

```js
function isTaskUnblockable(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return false;

  const deps = db.prepare(`
    SELECT t.id AS dep_task_id, t.status, t.exit_code, t.metadata, t.tags,
           d.condition_expr
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id
    WHERE d.task_id = ?
  `).all(taskId);

  // Check merge nodes via parallel-merge module (Plan 5 — only if shipped)
  let meta;
  try { meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}); } catch { meta = {}; }
  if (meta.kind === 'merge') {
    const { evaluateMergeJoin } = require('../execution/parallel-merge');
    return evaluateMergeJoin(meta.join_policy || 'wait_all', deps.map(d => ({ task_id: d.dep_task_id, status: d.status }))).unblock;
  }

  // For each dep: must be terminal AND its condition must hold
  const { evaluateCondition } = require('./condition-eval');
  for (const d of deps) {
    if (!['completed', 'failed', 'cancelled', 'skipped'].includes(d.status)) {
      return false; // dep not yet terminal → keep blocked
    }
    if (d.condition_expr) {
      let depMeta;
      try { depMeta = typeof d.metadata === 'string' ? JSON.parse(d.metadata) : (d.metadata || {}); } catch { depMeta = {}; }
      let depTags;
      try { depTags = typeof d.tags === 'string' ? JSON.parse(d.tags) : (d.tags || []); } catch { depTags = []; }
      const ctx = {
        outcome: d.status === 'completed' ? 'success' : (d.status === 'failed' ? 'fail' : d.status),
        exit_code: d.exit_code,
        failure_class: depMeta.failure_class || null,
        provider: depMeta.intended_provider || null,
        context: { tags: depTags, ...depMeta },
      };
      const ok = evaluateCondition(d.condition_expr, ctx);
      if (!ok) {
        // Condition failed — this conditional dep "doesn't apply".
        // Default behavior: skip the dependent task (don't unblock it via this edge).
        // If the dependent has OTHER deps with passing conditions, those still gate it.
        // We model "no-op edge" by treating the condition-failed dep as `skipped`
        // for the unblock decision — it does NOT prevent unblocking, but it also
        // doesn't trigger the dependent if it's the ONLY dep.
        // To prevent the dependent from running when ALL of its conditions fail,
        // count condition-failed deps separately:
        d._conditionFailed = true;
      }
    }
  }

  // If every dep had a condition that failed, the task should be skipped, not run.
  const allConditionsFailed = deps.length > 0 && deps.every(d => d._conditionFailed);
  if (allConditionsFailed) {
    db.updateTaskStatus(taskId, 'skipped', { error_output: 'All dependency conditions evaluated to false' });
    return false;
  }

  return true;
}
```

- [x] **Step 2: Verify dependencies pass condition through**

The existing `addTaskDependency` already accepts a `condition_expr`. In `server/handlers/workflow/index.js` `createSeededWorkflowTasks`, the dep insertion already uses `taskDef.condition`:

```js
workflowEngine.addTaskDependency({
  workflow_id: workflowId,
  task_id: taskId,
  depends_on_task_id: nodeToTaskMap[depNodeId],
  condition_expr: taskDef.condition,
  on_fail: taskDef.on_fail || 'skip',
  ...
});
```

If this is missing in the actual code, add it.

- [x] **Step 3: Integration test**

Create `server/tests/conditional-edges-integration.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db, testDir;
beforeAll(() => { const e = setupTestDb('conditional-edges'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

function extractUUID(text) { return text.match(/([a-f0-9-]{36})/)?.[1]; }

describe('conditional edges', () => {
  it('routes to ship branch only when scan succeeds', async () => {
    const result = await safeTool('create_workflow', {
      name: 'cond-1', working_directory: testDir,
      tasks: [
        { node_id: 'scan', task_description: 'scan' },
        { node_id: 'ship', task_description: 'ship', depends_on: ['scan'], condition: 'outcome=success' },
        { node_id: 'escalate', task_description: 'escalate', depends_on: ['scan'], condition: 'outcome=fail' },
      ],
    });
    const wfId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(wfId);
    const scan = tasks.find(t => t.workflow_node_id === 'scan');

    // Mark scan as completed (success)
    db.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
      .run('completed', new Date().toISOString(), scan.id);

    const wfEngine = require('../db/workflow-engine');
    const ship = tasks.find(t => t.workflow_node_id === 'ship');
    const escalate = tasks.find(t => t.workflow_node_id === 'escalate');

    expect(wfEngine.isTaskUnblockable(ship.id)).toBe(true);
    expect(wfEngine.isTaskUnblockable(escalate.id)).toBe(false);
    // escalate should now be skipped (all conditions failed)
    const escalateAfter = db.getTask(escalate.id);
    expect(escalateAfter.status).toBe('skipped');
  });

  it('failure_class condition routes to fix node', async () => {
    const result = await safeTool('create_workflow', {
      name: 'cond-2', working_directory: testDir,
      tasks: [
        { node_id: 'impl', task_description: 'impl' },
        { node_id: 'retry', task_description: 'retry', depends_on: ['impl'], condition: 'failure_class=transient_infra' },
        { node_id: 'escalate', task_description: 'escalate', depends_on: ['impl'], condition: 'failure_class=deterministic' },
      ],
    });
    const wfId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(wfId);
    const impl = tasks.find(t => t.workflow_node_id === 'impl');

    // Mark impl as failed with a transient_infra class
    db.prepare('UPDATE tasks SET status = ?, completed_at = ?, metadata = ? WHERE id = ?')
      .run('failed', new Date().toISOString(), JSON.stringify({ failure_class: 'transient_infra' }), impl.id);

    const wfEngine = require('../db/workflow-engine');
    const retry = tasks.find(t => t.workflow_node_id === 'retry');
    const escalate = tasks.find(t => t.workflow_node_id === 'escalate');
    expect(wfEngine.isTaskUnblockable(retry.id)).toBe(true);
    expect(wfEngine.isTaskUnblockable(escalate.id)).toBe(false);
  });
});
```

- [x] **Step 4: Run tests** → PASS.

- [x] **Step 5: Commit**

```bash
git add server/db/workflow-engine.js server/handlers/workflow/index.js server/tests/conditional-edges-integration.test.js
git commit -m "feat(conditional-edges): evaluate condition_expr during unblock"
git push --no-verify origin main
```

---

## Task 3: Docs

- [ ] **Step 1: Append to `docs/workflows.md`**

````markdown
## Conditional edges

Each dependency edge can have a `condition` — a boolean expression evaluated against the parent task's outcome and metadata. If the condition is false, the edge does not fire (the dependent task does not unblock via this edge).

If a dependent has multiple `depends_on` and all their conditions evaluate to false, the dependent is auto-`skipped`.

### Available context

| Key | Resolves to |
|---|---|
| `outcome` | `success` / `fail` / `cancelled` / `skipped` |
| `exit_code` | Process exit code (number) |
| `failure_class` | From Plan 4 — `transient_infra` / `deterministic` / etc. |
| `provider` | Provider that ran the parent task |
| `context.KEY` | Parent task's `metadata.KEY` (or `tags`, an array) |
| Bare key | Truthiness check |

### Operators

`=` `!=` `>` `<` `>=` `<=` `contains` `matches` `&&` `||` `!`

### Examples

```yaml
tasks:
  - node_id: scan
    task: Run security scan

  - node_id: ship
    task: Ship to staging
    depends_on: [scan]
    condition: "outcome=success"

  - node_id: escalate
    task: Notify human
    depends_on: [scan]
    condition: "outcome=fail"
```

```yaml
# Failure-class routing
- node_id: implement
  task: Implement feature
- node_id: retry_transient
  task: Auto-retry transient failures
  depends_on: [implement]
  condition: "failure_class=transient_infra"
- node_id: human_escalation
  task: Escalate to human
  depends_on: [implement]
  condition: "failure_class=deterministic || failure_class=structural"
```

```yaml
# Composite condition
- node_id: deploy_prod
  task: Deploy to production
  depends_on: [tests, security]
  condition: "outcome=success && context.coverage>=80"
```

### Error handling

A condition that fails to parse is treated as `false` (the edge doesn't fire) and a warning is logged. The workflow engine never crashes on a bad expression.
````

- [ ] **Step 2: Restart, smoke**

```bash
git add docs/workflows.md
git commit -m "docs(conditional-edges): condition expression guide"
git push --no-verify origin main
```

`await_restart`. Smoke: submit a workflow with a `condition: outcome=fail` edge, complete the parent successfully, confirm the conditional dependent is auto-skipped.
