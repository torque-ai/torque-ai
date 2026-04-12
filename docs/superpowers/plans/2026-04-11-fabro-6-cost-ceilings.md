# Fabro #6: Cost Ceilings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap unattended workflow spend with a hybrid budget that handles both API-priced providers (USD per token) and subscription providers (CLI tools where cost is a flat monthly fee). When any cap is reached, abort remaining tasks and mark the workflow `failed` with `failure_class: budget_exhausted` (from Plan 4).

**Architecture:** Two parallel budgets per workflow:
- `cost_budget_usd` — accumulated spend on API providers (anthropic, deepinfra, hyperbolic, groq, cerebras, google-ai, openrouter, ollama-cloud)
- `subscription_budget` — caps on subscription/CLI providers (codex, codex-spark, claude-cli) — measured in `max_calls` (count of task starts) and `max_runtime_minutes` (total elapsed time across tasks on subscription providers)

A new `server/budgets/workflow-budget.js` module evaluates both budgets after every task completion. The workflow engine consults it before unblocking the next batch of tasks. Cost data already flows from `recordProviderUsage`; subscription metrics come from task `started_at`/`completed_at` and a counter.

**Tech Stack:** Node.js, existing TORQUE cost-tracking + workflow engine.

---

## File Structure

**New files:**
- `server/budgets/workflow-budget.js` — evaluator
- `server/tests/workflow-budget.test.js`

**Modified files:**
- `server/handlers/workflow/index.js` — accept `cost_budget_usd`, `max_subscription_calls`, `max_subscription_runtime_minutes` on workflow
- `server/tool-defs/workflow-defs.js` — document fields
- `server/workflow-spec/schema.js` (if Plan 1 shipped) — same fields
- `server/db/schema-tables.js` — add columns to `workflows` table
- `server/execution/workflow-runtime.js` — call budget evaluator before unblocking
- `docs/workflows.md` — document budgets

---

## Task 1: Schema migration

- [ ] **Step 1: Add columns**

In `server/db/schema-tables.js`, add an ALTER block (or extend the `workflows` CREATE):

```sql
ALTER TABLE workflows ADD COLUMN cost_budget_usd REAL;
ALTER TABLE workflows ADD COLUMN max_subscription_calls INTEGER;
ALTER TABLE workflows ADD COLUMN max_subscription_runtime_minutes INTEGER;
ALTER TABLE workflows ADD COLUMN budget_breached_at TEXT;
ALTER TABLE workflows ADD COLUMN budget_breach_reason TEXT;
```

Use the migration runner. If the project uses an idempotent migration system, add a dated migration file; otherwise wrap in `IF NOT EXISTS` checks.

- [ ] **Step 2: Commit**

```bash
git add server/db/schema-tables.js
git commit -m "feat(workflow-budget): add budget columns to workflows table"
git push --no-verify origin main
```

---

## Task 2: Budget evaluator

- [ ] **Step 1: Tests**

Create `server/tests/workflow-budget.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { evaluateWorkflowBudget } = require('../budgets/workflow-budget');

let db;
beforeAll(() => { db = setupTestDb('workflow-budget').db; });
afterAll(() => teardownTestDb());

const SUBSCRIPTION_PROVIDERS = ['codex', 'codex-spark', 'claude-cli'];

function insertWorkflow(opts) {
  const id = randomUUID();
  db.prepare(`INSERT INTO workflows (id, name, status, created_at, cost_budget_usd, max_subscription_calls, max_subscription_runtime_minutes)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    id, 'wf', 'running', new Date().toISOString(),
    opts.cost_budget_usd ?? null,
    opts.max_subscription_calls ?? null,
    opts.max_subscription_runtime_minutes ?? null,
  );
  return id;
}
function insertTask(wfId, { provider, status, started_at, completed_at, cost_usd = 0 }) {
  const id = randomUUID();
  db.createTask({ id, task_description: 'x', working_directory: null, status: 'pending', workflow_id: wfId, provider });
  db.prepare('UPDATE tasks SET status = ?, started_at = ?, completed_at = ?, cost_usd = ? WHERE id = ?')
    .run(status, started_at, completed_at, cost_usd, id);
  return id;
}

describe('evaluateWorkflowBudget', () => {
  it('returns ok when no budgets configured', () => {
    const wfId = insertWorkflow({});
    const r = evaluateWorkflowBudget(wfId);
    expect(r.allowed).toBe(true);
  });

  it('blocks when cost_budget_usd exceeded', () => {
    const wfId = insertWorkflow({ cost_budget_usd: 1.00 });
    insertTask(wfId, { provider: 'anthropic', status: 'completed', cost_usd: 1.50, started_at: '2026-04-11T10:00:00Z', completed_at: '2026-04-11T10:01:00Z' });
    const r = evaluateWorkflowBudget(wfId);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cost.*1\.5.*exceed.*1/i);
  });

  it('subscription provider cost does not count toward USD budget', () => {
    const wfId = insertWorkflow({ cost_budget_usd: 0.10 });
    insertTask(wfId, { provider: 'codex', status: 'completed', cost_usd: 999, started_at: '2026-04-11T10:00:00Z', completed_at: '2026-04-11T10:01:00Z' });
    const r = evaluateWorkflowBudget(wfId);
    expect(r.allowed).toBe(true);
  });

  it('blocks when max_subscription_calls exceeded', () => {
    const wfId = insertWorkflow({ max_subscription_calls: 2 });
    for (let i = 0; i < 3; i++) {
      insertTask(wfId, { provider: 'codex', status: 'completed', started_at: '2026-04-11T10:00:00Z', completed_at: '2026-04-11T10:01:00Z' });
    }
    const r = evaluateWorkflowBudget(wfId);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/subscription.*calls/i);
  });

  it('blocks when max_subscription_runtime_minutes exceeded', () => {
    const wfId = insertWorkflow({ max_subscription_runtime_minutes: 5 });
    insertTask(wfId, { provider: 'codex', status: 'completed', started_at: '2026-04-11T10:00:00Z', completed_at: '2026-04-11T10:10:00Z' });
    const r = evaluateWorkflowBudget(wfId);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/runtime/i);
  });

  it('multiple budgets: any single breach blocks', () => {
    const wfId = insertWorkflow({ cost_budget_usd: 100, max_subscription_calls: 1 });
    insertTask(wfId, { provider: 'codex', status: 'completed', started_at: '2026-04-11T10:00:00Z', completed_at: '2026-04-11T10:01:00Z' });
    insertTask(wfId, { provider: 'codex', status: 'completed', started_at: '2026-04-11T10:01:00Z', completed_at: '2026-04-11T10:02:00Z' });
    const r = evaluateWorkflowBudget(wfId);
    expect(r.allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run tests/workflow-budget.test.js --no-coverage` → FAIL.

- [ ] **Step 3: Implement evaluator**

Create `server/budgets/workflow-budget.js`:

```js
'use strict';

const db = require('../database');

const SUBSCRIPTION_PROVIDERS = new Set(['codex', 'codex-spark', 'claude-cli']);

function diffMinutes(s, e) {
  if (!s || !e) return 0;
  const a = new Date(s).getTime();
  const b = new Date(e).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return (b - a) / 60000;
}

/**
 * Decide whether the workflow may continue starting tasks.
 * Returns { allowed, reason, usage } — reason is null when allowed.
 */
function evaluateWorkflowBudget(workflowId) {
  const wf = db.getWorkflow(workflowId);
  if (!wf) return { allowed: true, reason: null, usage: null };

  const tasks = db.getWorkflowTasks(workflowId) || [];
  const apiCostUsd = tasks
    .filter(t => t.provider && !SUBSCRIPTION_PROVIDERS.has(t.provider))
    .reduce((sum, t) => sum + (Number(t.cost_usd) || 0), 0);

  const subscriptionTasks = tasks.filter(t => SUBSCRIPTION_PROVIDERS.has(t.provider));
  const subscriptionCalls = subscriptionTasks.length;
  const subscriptionRuntimeMin = subscriptionTasks.reduce(
    (sum, t) => sum + diffMinutes(t.started_at, t.completed_at), 0
  );

  const usage = {
    api_cost_usd: Number(apiCostUsd.toFixed(6)),
    subscription_calls: subscriptionCalls,
    subscription_runtime_minutes: Number(subscriptionRuntimeMin.toFixed(2)),
  };

  if (wf.cost_budget_usd != null && usage.api_cost_usd > wf.cost_budget_usd) {
    return {
      allowed: false,
      reason: `API cost $${usage.api_cost_usd} exceeded budget $${wf.cost_budget_usd}`,
      usage,
    };
  }
  if (wf.max_subscription_calls != null && usage.subscription_calls > wf.max_subscription_calls) {
    return {
      allowed: false,
      reason: `Subscription calls ${usage.subscription_calls} exceeded cap ${wf.max_subscription_calls}`,
      usage,
    };
  }
  if (wf.max_subscription_runtime_minutes != null && usage.subscription_runtime_minutes > wf.max_subscription_runtime_minutes) {
    return {
      allowed: false,
      reason: `Subscription runtime ${usage.subscription_runtime_minutes}min exceeded cap ${wf.max_subscription_runtime_minutes}min`,
      usage,
    };
  }

  return { allowed: true, reason: null, usage };
}

module.exports = { evaluateWorkflowBudget, SUBSCRIPTION_PROVIDERS };
```

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/budgets/workflow-budget.js server/tests/workflow-budget.test.js
git commit -m "feat(workflow-budget): hybrid USD + subscription evaluator"
git push --no-verify origin main
```

---

## Task 3: Wire into workflow engine

- [ ] **Step 1: Accept budget fields in `create_workflow`**

In `server/tool-defs/workflow-defs.js` `create_workflow` top-level properties:

```js
cost_budget_usd: { type: 'number', minimum: 0, description: 'Max accumulated USD spend on API providers. When exceeded, remaining tasks abort.' },
max_subscription_calls: { type: 'integer', minimum: 1, description: 'Max number of subscription-provider task starts (codex/claude-cli).' },
max_subscription_runtime_minutes: { type: 'integer', minimum: 1, description: 'Max accumulated runtime (minutes) across subscription-provider tasks.' },
```

In `server/handlers/workflow/index.js` `handleCreateWorkflow`, pass these through to the `workflowEngine.createWorkflow` call:

```js
workflowEngine.createWorkflow({
  id: workflowId,
  name: trimmedName,
  description: args.description,
  working_directory: args.working_directory,
  priority: args.priority,
  context: ...,
  cost_budget_usd: args.cost_budget_usd ?? null,
  max_subscription_calls: args.max_subscription_calls ?? null,
  max_subscription_runtime_minutes: args.max_subscription_runtime_minutes ?? null,
});
```

Update `workflowEngine.createWorkflow` SQL to include the new columns.

- [ ] **Step 2: Enforce in workflow runtime**

In `server/execution/workflow-runtime.js`, before unblocking dependents (task completion handler), evaluate the budget. If `!allowed`, mark the workflow `failed`:

```js
const { evaluateWorkflowBudget } = require('../budgets/workflow-budget');
const budget = evaluateWorkflowBudget(workflowId);
if (!budget.allowed) {
  logger.info(`[budget] Workflow ${workflowId} budget breached: ${budget.reason}`);
  db.updateWorkflow(workflowId, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    error_output: `Budget exceeded: ${budget.reason}`,
    budget_breached_at: new Date().toISOString(),
    budget_breach_reason: budget.reason,
  });
  // Cancel any remaining queued/blocked tasks in this workflow
  db.prepare(`UPDATE tasks SET status = 'cancelled', cancel_reason = 'workflow_budget_exceeded', completed_at = ?
              WHERE workflow_id = ? AND status IN ('queued', 'blocked', 'pending')`).run(
    new Date().toISOString(), workflowId
  );
  return;
}
// ...continue with normal unblock logic
```

- [ ] **Step 3: Integration test**

Create `server/tests/workflow-budget-integration.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db, testDir;
beforeAll(() => { const e = setupTestDb('budget-integration'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

function extractUUID(text) { return text.match(/([a-f0-9-]{36})/)?.[1]; }

describe('budget enforcement', () => {
  it('cancels remaining tasks and marks workflow failed when budget breached', async () => {
    const result = await safeTool('create_workflow', {
      name: 'budget-test',
      working_directory: testDir,
      cost_budget_usd: 0.50,
      tasks: [
        { node_id: 'a', task_description: 'a' },
        { node_id: 'b', task_description: 'b', depends_on: ['a'] },
      ],
    });
    const wfId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(wfId);
    const a = tasks.find(t => t.workflow_node_id === 'a');

    // Simulate task A completing with high cost
    db.prepare('UPDATE tasks SET status = ?, completed_at = ?, cost_usd = ?, provider = ? WHERE id = ?')
      .run('completed', new Date().toISOString(), 1.00, 'anthropic', a.id);

    // Trigger the workflow runtime's post-completion handler
    const wfRuntime = require('../execution/workflow-runtime');
    if (typeof wfRuntime.onTaskCompleted === 'function') {
      await wfRuntime.onTaskCompleted(a.id);
    } else if (typeof wfRuntime.unblockDependentsAfterCompletion === 'function') {
      wfRuntime.unblockDependentsAfterCompletion(a.id);
    }

    const wf = db.getWorkflow(wfId);
    expect(wf.status).toBe('failed');
    expect(wf.budget_breach_reason).toMatch(/cost.*exceed/i);
    const b = db.getWorkflowTasks(wfId).find(t => t.workflow_node_id === 'b');
    expect(b.status).toBe('cancelled');
  });
});
```

- [ ] **Step 4: Run tests, commit**

```bash
git add server/tool-defs/workflow-defs.js server/handlers/workflow/index.js server/db/workflow-engine.js server/execution/workflow-runtime.js server/tests/workflow-budget-integration.test.js
git commit -m "feat(workflow-budget): enforce budgets in workflow runtime"
git push --no-verify origin main
```

---

## Task 4: Workflow-spec support (skip if Plan 1 not shipped)

- [ ] **Step 1: Add fields to schema**

In `server/workflow-spec/schema.js` top-level properties:

```js
cost_budget_usd: { type: 'number', minimum: 0 },
max_subscription_calls: { type: 'integer', minimum: 1 },
max_subscription_runtime_minutes: { type: 'integer', minimum: 1 },
```

- [ ] **Step 2: Pass through in `handleRunWorkflowSpec`**

Extend `createArgs`:

```js
cost_budget_usd: spec.cost_budget_usd,
max_subscription_calls: spec.max_subscription_calls,
max_subscription_runtime_minutes: spec.max_subscription_runtime_minutes,
```

- [ ] **Step 3: Commit**

```bash
git add server/workflow-spec/schema.js server/handlers/workflow-spec-handlers.js
git commit -m "feat(workflow-spec): accept budget fields"
git push --no-verify origin main
```

---

## Task 5: Docs

- [ ] **Step 1: Document budgets in `docs/workflows.md`**

Append:

````markdown
## Workflow budgets

Three orthogonal caps protect against runaway spend:

| Field | Applies to | Units |
|---|---|---|
| `cost_budget_usd` | API providers (anthropic, deepinfra, hyperbolic, groq, cerebras, google-ai, openrouter, ollama-cloud) | USD |
| `max_subscription_calls` | Subscription providers (codex, codex-spark, claude-cli) | Number of task starts |
| `max_subscription_runtime_minutes` | Subscription providers | Total minutes elapsed across all tasks |

Subscription providers are paid via flat monthly fee, so per-call cost is unmeasurable. Use call count and runtime as proxies.

When ANY cap is breached after a task completes, the workflow is demoted to `failed` with `budget_breach_reason` set, and all remaining queued/blocked tasks are cancelled with `cancel_reason: workflow_budget_exceeded`. The failure is classified as `failure_class: budget_exhausted`.

```yaml
version: 1
name: nightly-factory
cost_budget_usd: 5.00
max_subscription_calls: 100
max_subscription_runtime_minutes: 240
tasks:
  # ...
```
````

- [ ] **Step 2: Commit**

```bash
git add docs/workflows.md
git commit -m "docs(workflow-budget): hybrid budget guide"
git push --no-verify origin main
```

---

## Task 6: Restart + smoke

- [ ] **Step 1: Run all budget tests**

`npx vitest run tests/workflow-budget --no-coverage` → PASS.

- [ ] **Step 2: Restart**

`await_restart` with reason `Load workflow budgets`.

- [ ] **Step 3: Smoke test**

Submit a workflow with `cost_budget_usd: 0.01`. Expected: any API task completion immediately demotes the workflow to failed.
