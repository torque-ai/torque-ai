# Fabro #5: Parallel Fan-Out + Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class fan-out and merge node types to the workflow engine. Fan-out spawns N branches from one source. Merge waits for branches according to a join policy (`wait_all` or `first_success`) before continuing. Enables ensemble workflows (race two models, take the winner; run three critics concurrently).

**Architecture:** Two new task `kind`s stored in metadata: `parallel_fanout` and `merge`. The fan-out task is a no-op pass-through that completes immediately when its dependencies are satisfied — its purpose is to be the source vertex from which multiple downstream tasks branch. The merge task is the reverse: it waits until its branch dependencies satisfy the configured join policy. The workflow engine's existing dependency-evaluation logic gets a small extension to honor merge join policies. `max_parallel` is enforced at branch-start time by the queue scheduler — when a fan-out task completes, its downstream tasks are normally all unblocked at once; if `max_parallel` is set, only that many are unblocked (the rest stay blocked and are released as siblings finish).

**Tech Stack:** Node.js, existing TORQUE workflow engine.

**Test invocation:** `torque-remote` on remote project path from `~/.torque-remote.local.json`.

---

## File Structure

**New files:**
- `server/execution/parallel-merge.js` — join-policy evaluator
- `server/tests/parallel-merge.test.js`
- `server/tests/parallel-fanout-integration.test.js`

**Modified files:**
- `server/handlers/workflow/index.js` — accept `kind: "parallel_fanout" | "merge"` per task, validate, store in metadata
- `server/tool-defs/workflow-defs.js` — document `kind`, `join_policy`, `max_parallel` per task
- `server/workflow-spec/schema.js` (if Plan 1 shipped) — accept the new fields
- `server/db/workflow-engine.js` — when checking if a merge task is unblockable, consult `parallel-merge.js` instead of plain "all deps complete"
- `server/execution/workflow-runtime.js` — when a fan-out task completes, respect `max_parallel` on its outgoing edges
- `docs/workflows.md` — document the new node types

---

## Task 1: Join-policy evaluator

**Files:**
- Create: `server/execution/parallel-merge.js`
- Create: `server/tests/parallel-merge.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/parallel-merge.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { evaluateMergeJoin } = require('../execution/parallel-merge');

function dep(taskId, status) { return { task_id: taskId, status }; }

describe('evaluateMergeJoin', () => {
  it('wait_all blocks until every dependency is terminal', () => {
    const r = evaluateMergeJoin('wait_all', [
      dep('a', 'completed'),
      dep('b', 'running'),
    ]);
    expect(r.unblock).toBe(false);
    expect(r.reason).toMatch(/wait_all/);
  });

  it('wait_all unblocks when all dependencies are terminal', () => {
    const r = evaluateMergeJoin('wait_all', [
      dep('a', 'completed'),
      dep('b', 'failed'),
      dep('c', 'completed'),
    ]);
    expect(r.unblock).toBe(true);
    expect(r.completed_branches).toBe(2);
    expect(r.failed_branches).toBe(1);
  });

  it('first_success unblocks as soon as one branch completes', () => {
    const r = evaluateMergeJoin('first_success', [
      dep('a', 'running'),
      dep('b', 'completed'),
      dep('c', 'queued'),
    ]);
    expect(r.unblock).toBe(true);
    expect(r.completed_branches).toBe(1);
  });

  it('first_success stays blocked when no branch has completed yet', () => {
    const r = evaluateMergeJoin('first_success', [
      dep('a', 'running'),
      dep('b', 'queued'),
    ]);
    expect(r.unblock).toBe(false);
  });

  it('first_success fails the merge when ALL branches reach terminal state without success', () => {
    const r = evaluateMergeJoin('first_success', [
      dep('a', 'failed'),
      dep('b', 'cancelled'),
      dep('c', 'failed'),
    ]);
    expect(r.unblock).toBe(true);
    expect(r.outcome).toBe('failed');
  });

  it('defaults to wait_all when policy is unknown', () => {
    const r = evaluateMergeJoin('weird_policy', [
      dep('a', 'completed'),
      dep('b', 'completed'),
    ]);
    expect(r.unblock).toBe(true);
  });

  it('reports zero deps as unblocked (degenerate case)', () => {
    const r = evaluateMergeJoin('wait_all', []);
    expect(r.unblock).toBe(true);
    expect(r.completed_branches).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run on remote: `npx vitest run tests/parallel-merge.test.js --no-coverage`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the evaluator**

Create `server/execution/parallel-merge.js`:

```js
'use strict';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);

/**
 * Evaluate whether a merge node should unblock based on its join policy
 * and the current status of its branch dependencies.
 *
 * @param {string} policy - 'wait_all' or 'first_success' (default: wait_all)
 * @param {Array<{task_id: string, status: string}>} deps - branch dependency states
 * @returns {{
 *   unblock: boolean,
 *   reason: string,
 *   completed_branches: number,
 *   failed_branches: number,
 *   outcome: 'success' | 'failed' | null
 * }}
 */
function evaluateMergeJoin(policy, deps) {
  const completedBranches = deps.filter(d => d.status === 'completed').length;
  const failedBranches = deps.filter(d => ['failed', 'cancelled', 'skipped'].includes(d.status)).length;
  const terminalCount = deps.filter(d => TERMINAL_STATUSES.has(d.status)).length;

  if (deps.length === 0) {
    return {
      unblock: true,
      reason: 'no dependencies',
      completed_branches: 0,
      failed_branches: 0,
      outcome: 'success',
    };
  }

  const effectivePolicy = policy === 'first_success' ? 'first_success' : 'wait_all';

  if (effectivePolicy === 'first_success') {
    if (completedBranches >= 1) {
      return {
        unblock: true,
        reason: 'first_success: at least one branch completed',
        completed_branches: completedBranches,
        failed_branches: failedBranches,
        outcome: 'success',
      };
    }
    if (terminalCount === deps.length) {
      // All branches terminal but none succeeded → merge fails
      return {
        unblock: true,
        reason: 'first_success: all branches terminal, none succeeded',
        completed_branches: 0,
        failed_branches: failedBranches,
        outcome: 'failed',
      };
    }
    return {
      unblock: false,
      reason: `first_success: waiting (${completedBranches}/${deps.length} succeeded, ${terminalCount - completedBranches}/${deps.length} terminal)`,
      completed_branches: completedBranches,
      failed_branches: failedBranches,
      outcome: null,
    };
  }

  // wait_all
  if (terminalCount === deps.length) {
    return {
      unblock: true,
      reason: 'wait_all: all branches terminal',
      completed_branches: completedBranches,
      failed_branches: failedBranches,
      outcome: failedBranches === 0 ? 'success' : 'failed',
    };
  }
  return {
    unblock: false,
    reason: `wait_all: ${terminalCount}/${deps.length} branches terminal`,
    completed_branches: completedBranches,
    failed_branches: failedBranches,
    outcome: null,
  };
}

module.exports = { evaluateMergeJoin, TERMINAL_STATUSES };
```

- [ ] **Step 4: Run tests**

Run on remote: `npx vitest run tests/parallel-merge.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/execution/parallel-merge.js server/tests/parallel-merge.test.js
git commit -m "feat(parallel-merge): join-policy evaluator (wait_all, first_success)"
git push --no-verify origin main
```

---

## Task 2: Accept new fields in `create_workflow`

**Files:**
- Modify: `server/tool-defs/workflow-defs.js`
- Modify: `server/handlers/workflow/index.js`

- [ ] **Step 1: Add fields to per-task tool schema**

In `server/tool-defs/workflow-defs.js`, find the `create_workflow` `tasks.items.properties` block. Add:

```js
kind: {
  type: 'string',
  enum: ['agent', 'parallel_fanout', 'merge'],
  description: 'Task type. Default "agent". "parallel_fanout" is a no-op source whose downstream tasks run concurrently. "merge" waits for its dependencies according to join_policy.',
},
join_policy: {
  type: 'string',
  enum: ['wait_all', 'first_success'],
  description: 'For merge nodes only. Default wait_all. first_success unblocks as soon as one branch dependency completes.',
},
max_parallel: {
  type: 'integer',
  minimum: 1,
  maximum: 32,
  description: 'For parallel_fanout nodes only. Caps how many downstream branches run concurrently. Default: unlimited (subject to global queue limits).',
},
```

- [ ] **Step 2: Validate kind/policy/max_parallel and store in metadata**

In `server/handlers/workflow/index.js`, extend `buildWorkflowTaskMetadata`:

```js
function buildWorkflowTaskMetadata(taskLike) {
  const metaObj = {};
  if (Array.isArray(taskLike.context_from) && taskLike.context_from.length > 0) {
    metaObj.context_from = taskLike.context_from.slice();
  }
  if (taskLike.provider) {
    metaObj.user_provider_override = true;
    metaObj.intended_provider = taskLike.provider;
  }
  if (taskLike.routing_template) {
    metaObj._routing_template = taskLike.routing_template;
  }
  if (taskLike.goal_gate === true) {
    metaObj.goal_gate = true;
  }

  // Parallel/merge node attributes
  if (taskLike.kind && taskLike.kind !== 'agent') {
    metaObj.kind = taskLike.kind;
  }
  if (taskLike.kind === 'merge' && taskLike.join_policy) {
    metaObj.join_policy = taskLike.join_policy;
  }
  if (taskLike.kind === 'parallel_fanout' && Number.isInteger(taskLike.max_parallel)) {
    metaObj.max_parallel = taskLike.max_parallel;
  }

  return metaObj;
}
```

Add validation in `normalizeInitialWorkflowTasks` (after the existing per-task validation block):

```js
for (const task of normalized) {
  if (task.kind === 'merge' && (!Array.isArray(task.depends_on) || task.depends_on.length === 0)) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Merge node '${task.node_id}' must have at least one entry in depends_on (the branches to merge)`
    );
  }
  if (task.join_policy && task.kind !== 'merge') {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `join_policy is only valid on merge nodes (task '${task.node_id}' has kind=${task.kind || 'agent'})`
    );
  }
  if (task.max_parallel != null && task.kind !== 'parallel_fanout') {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `max_parallel is only valid on parallel_fanout nodes (task '${task.node_id}' has kind=${task.kind || 'agent'})`
    );
  }
}
```

- [ ] **Step 3: Round-trip test**

Create `server/tests/parallel-fanout-creation.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db, testDir;
beforeAll(() => { const e = setupTestDb('parallel-create'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

function extractUUID(text) { return text.match(/([a-f0-9-]{36})/)?.[1]; }
function parseMeta(t) { return typeof t.metadata === 'string' ? JSON.parse(t.metadata) : (t.metadata || {}); }

describe('create_workflow with kind=parallel_fanout/merge', () => {
  it('stores kind, join_policy, max_parallel in task metadata', async () => {
    const result = await safeTool('create_workflow', {
      name: 'pm-1',
      working_directory: testDir,
      tasks: [
        { node_id: 'fanout', task_description: 'fan out', kind: 'parallel_fanout', max_parallel: 3 },
        { node_id: 'a', task_description: 'branch a', depends_on: ['fanout'] },
        { node_id: 'b', task_description: 'branch b', depends_on: ['fanout'] },
        { node_id: 'merge', task_description: 'merge', kind: 'merge', join_policy: 'first_success', depends_on: ['a', 'b'] },
      ],
    });
    expect(result.isError).toBeFalsy();
    const wfId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(wfId);
    const fanout = tasks.find(t => t.workflow_node_id === 'fanout');
    const merge = tasks.find(t => t.workflow_node_id === 'merge');
    expect(parseMeta(fanout).kind).toBe('parallel_fanout');
    expect(parseMeta(fanout).max_parallel).toBe(3);
    expect(parseMeta(merge).kind).toBe('merge');
    expect(parseMeta(merge).join_policy).toBe('first_success');
  });

  it('rejects merge without depends_on', async () => {
    const result = await safeTool('create_workflow', {
      name: 'pm-2',
      working_directory: testDir,
      tasks: [
        { node_id: 'merge', task_description: 'm', kind: 'merge' },
      ],
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/merge.*depends_on/i);
  });

  it('rejects join_policy on a non-merge node', async () => {
    const result = await safeTool('create_workflow', {
      name: 'pm-3',
      working_directory: testDir,
      tasks: [
        { node_id: 'x', task_description: 'x', join_policy: 'wait_all' },
      ],
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/join_policy.*merge/i);
  });
});
```

- [ ] **Step 4: Run tests**

Run on remote: `npx vitest run tests/parallel-fanout-creation.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tool-defs/workflow-defs.js server/handlers/workflow/index.js server/tests/parallel-fanout-creation.test.js
git commit -m "feat(parallel): accept kind/join_policy/max_parallel on workflow tasks"
git push --no-verify origin main
```

---

## Task 3: Workflow-spec schema (if Plan 1 shipped)

**Files:**
- Modify: `server/workflow-spec/schema.js`

**Skip if Plan 1 has not shipped.**

- [ ] **Step 1: Add fields to per-task schema**

In `server/workflow-spec/schema.js` `tasks.items.properties`, add:

```js
kind: { type: 'string', enum: ['agent', 'parallel_fanout', 'merge'] },
join_policy: { type: 'string', enum: ['wait_all', 'first_success'] },
max_parallel: { type: 'integer', minimum: 1, maximum: 32 },
```

- [ ] **Step 2: Test the schema accepts ensemble specs**

Add to `server/tests/workflow-spec-handlers.test.js`:

```js
it('accepts ensemble spec with parallel_fanout and merge', () => {
  const wfDir = path.join(testDir, 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  const specPath = path.join(wfDir, 'ensemble.yaml');
  fs.writeFileSync(specPath, `
version: 1
name: ensemble
project: p
tasks:
  - node_id: fanout
    task: fan out
    kind: parallel_fanout
    max_parallel: 2
  - node_id: critic_a
    task: critique a
    depends_on: [fanout]
  - node_id: critic_b
    task: critique b
    depends_on: [fanout]
  - node_id: merge
    task: synthesize
    kind: merge
    join_policy: wait_all
    depends_on: [critic_a, critic_b]
`);
  const result = handleRunWorkflowSpec({ spec_path: specPath, working_directory: testDir });
  expect(result.isError).toBeFalsy();
  const tasks = db.getWorkflowTasks(result.structuredData.workflow_id);
  const merge = tasks.find(t => t.workflow_node_id === 'merge');
  const meta = typeof merge.metadata === 'string' ? JSON.parse(merge.metadata) : merge.metadata;
  expect(meta.kind).toBe('merge');
  expect(meta.join_policy).toBe('wait_all');
});
```

Run tests. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/workflow-spec/schema.js server/tests/workflow-spec-handlers.test.js
git commit -m "feat(workflow-spec): accept kind/join_policy/max_parallel"
git push --no-verify origin main
```

---

## Task 4: Honor merge join_policy in unblock evaluation

**Files:**
- Modify: `server/db/workflow-engine.js` (or wherever `getReadyTasks` / dependency-evaluation logic lives)

- [ ] **Step 1: Locate the unblock site**

Read `server/db/workflow-engine.js`. Find the function that decides whether a blocked task should be moved to queued (search for `unblockTask` or `getReadyTasks` or anywhere `'queued'` is written for blocked tasks). The existing logic is "all `depends_on_task_id` rows are completed/skipped → unblock".

- [ ] **Step 2: Add merge-aware path**

When evaluating whether to unblock a task, check if it has `metadata.kind === 'merge'`. If so, fetch the actual statuses of its dependency tasks and call `evaluateMergeJoin`:

```js
function isTaskUnblockable(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return false;

  const deps = db.prepare(`
    SELECT t.id AS task_id, t.status
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id
    WHERE d.task_id = ?
  `).all(taskId);

  // Merge nodes use join policy, not "all complete"
  let meta;
  try { meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}); } catch { meta = {}; }
  if (meta.kind === 'merge') {
    const { evaluateMergeJoin } = require('../execution/parallel-merge');
    const result = evaluateMergeJoin(meta.join_policy || 'wait_all', deps);
    return result.unblock;
  }

  // Default: wait_all (every dep terminal AND every dep succeeded or skipped)
  return deps.every(d => ['completed', 'skipped'].includes(d.status));
}
```

If the existing function is named differently or inline, weave the merge check in at the same decision point. The key: `evaluateMergeJoin` decides for merge nodes; existing logic decides for everything else.

- [ ] **Step 3: When a merge unblocks, also write the join outcome to its context**

So downstream tasks can see the result, write `metadata.merge_outcome` when transitioning a merge task to queued:

```js
if (meta.kind === 'merge' && result.unblock) {
  db.prepare(`
    UPDATE tasks
    SET metadata = json_set(COALESCE(metadata, '{}'), '$.merge_outcome', json(?))
    WHERE id = ?
  `).run(JSON.stringify({
    completed_branches: result.completed_branches,
    failed_branches: result.failed_branches,
    outcome: result.outcome,
  }), taskId);
}
```

(If the codebase doesn't use `json_set`, fall back to read → mutate → write the metadata blob.)

- [ ] **Step 4: Integration test**

Create `server/tests/parallel-fanout-integration.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db, testDir;
beforeAll(() => { const e = setupTestDb('pm-integration'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

function extractUUID(text) { return text.match(/([a-f0-9-]{36})/)?.[1]; }

async function setupEnsemble(joinPolicy) {
  const result = await safeTool('create_workflow', {
    name: `ensemble-${joinPolicy}-${Date.now()}`,
    working_directory: testDir,
    tasks: [
      { node_id: 'fanout', task_description: 'f', kind: 'parallel_fanout' },
      { node_id: 'a', task_description: 'a', depends_on: ['fanout'] },
      { node_id: 'b', task_description: 'b', depends_on: ['fanout'] },
      { node_id: 'merge', task_description: 'm', kind: 'merge', join_policy: joinPolicy, depends_on: ['a', 'b'] },
    ],
  });
  return extractUUID(getText(result));
}

function setStatus(id, status) {
  db.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
    .run(status, status === 'completed' || status === 'failed' ? new Date().toISOString() : null, id);
}

describe('merge join_policy', () => {
  it('wait_all merge stays blocked until both branches terminal', async () => {
    const wfId = await setupEnsemble('wait_all');
    const tasks = db.getWorkflowTasks(wfId);
    const a = tasks.find(t => t.workflow_node_id === 'a');
    const b = tasks.find(t => t.workflow_node_id === 'b');
    const merge = tasks.find(t => t.workflow_node_id === 'merge');

    setStatus(a.id, 'completed');
    // Trigger workflow runtime to re-evaluate (call the runtime's unblock check)
    const wfEngine = require('../db/workflow-engine');
    expect(wfEngine.isTaskUnblockable
      ? wfEngine.isTaskUnblockable(merge.id)
      : false).toBe(false); // still blocked: b is not terminal

    setStatus(b.id, 'completed');
    expect(wfEngine.isTaskUnblockable
      ? wfEngine.isTaskUnblockable(merge.id)
      : true).toBe(true);
  });

  it('first_success merge unblocks as soon as one branch completes', async () => {
    const wfId = await setupEnsemble('first_success');
    const tasks = db.getWorkflowTasks(wfId);
    const a = tasks.find(t => t.workflow_node_id === 'a');
    const merge = tasks.find(t => t.workflow_node_id === 'merge');

    setStatus(a.id, 'completed');
    const wfEngine = require('../db/workflow-engine');
    expect(wfEngine.isTaskUnblockable
      ? wfEngine.isTaskUnblockable(merge.id)
      : true).toBe(true);
  });
});
```

If `isTaskUnblockable` isn't exported, export it specifically for this test (single-line addition) or call the runtime's higher-level path that triggers re-evaluation.

- [ ] **Step 5: Run tests**

Run on remote: `npx vitest run tests/parallel-fanout-integration.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/workflow-engine.js server/tests/parallel-fanout-integration.test.js
git commit -m "feat(parallel): merge nodes honor join_policy in unblock evaluation"
git push --no-verify origin main
```

---

## Task 5: Enforce max_parallel on fan-out

**Files:**
- Modify: `server/execution/workflow-runtime.js`

- [ ] **Step 1: Locate the post-completion unblock loop**

Read `server/execution/workflow-runtime.js`. When a task completes, the runtime walks its dependents and unblocks the ones whose dependencies are now satisfied. Find that loop (search for `unblockTask` calls).

- [ ] **Step 2: Apply max_parallel cap when the completing task is a fan-out**

When the completing task has `metadata.kind === 'parallel_fanout'`, only unblock the first `max_parallel` dependents. The rest stay blocked. As branch siblings finish, this same logic re-evaluates: each completion triggers the dependents loop again, and at that point the next blocked sibling can be unblocked because there's now capacity.

```js
function unblockDependentsAfterCompletion(completedTaskId) {
  const completed = db.getTask(completedTaskId);
  let meta = {};
  try { meta = typeof completed.metadata === 'string' ? JSON.parse(completed.metadata) : (completed.metadata || {}); } catch {}
  const isFanout = meta.kind === 'parallel_fanout';
  const cap = isFanout ? meta.max_parallel : null;

  // Get all dependents
  const dependents = db.prepare(`
    SELECT t.* FROM tasks t
    JOIN task_dependencies d ON d.task_id = t.id
    WHERE d.depends_on_task_id = ?
  `).all(completedTaskId);

  if (cap == null) {
    // No cap — unblock all that are now ready
    for (const dep of dependents) {
      tryUnblock(dep.id);
    }
    return;
  }

  // Cap in effect: count how many siblings are already non-blocked
  const fanoutDependents = dependents;
  const alreadyActive = fanoutDependents.filter(d => d.status !== 'blocked').length;
  const slotsAvailable = Math.max(0, cap - alreadyActive);
  let unblocked = 0;
  for (const dep of fanoutDependents) {
    if (unblocked >= slotsAvailable) break;
    if (dep.status !== 'blocked') continue;
    if (tryUnblock(dep.id)) unblocked++;
  }
  // The remaining blocked siblings get a chance when other siblings complete
  // (this same function fires on every completion, so the next completion triggers re-evaluation).
}
```

The exact integration point depends on the existing structure — wrap or inline the cap logic at whichever code currently iterates dependents.

- [ ] **Step 3: Test max_parallel**

Append to `server/tests/parallel-fanout-integration.test.js`:

```js
describe('max_parallel cap', () => {
  it('limits how many fan-out branches start concurrently', async () => {
    const result = await safeTool('create_workflow', {
      name: 'pm-cap',
      working_directory: testDir,
      tasks: [
        { node_id: 'fanout', task_description: 'f', kind: 'parallel_fanout', max_parallel: 2 },
        { node_id: 'a', task_description: 'a', depends_on: ['fanout'] },
        { node_id: 'b', task_description: 'b', depends_on: ['fanout'] },
        { node_id: 'c', task_description: 'c', depends_on: ['fanout'] },
        { node_id: 'd', task_description: 'd', depends_on: ['fanout'] },
      ],
    });
    const wfId = extractUUID(getText(result));
    const fanoutTask = db.getWorkflowTasks(wfId).find(t => t.workflow_node_id === 'fanout');

    // Mark fanout completed and trigger unblock
    db.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
      .run('completed', new Date().toISOString(), fanoutTask.id);
    const wfRuntime = require('../execution/workflow-runtime');
    if (typeof wfRuntime.unblockDependentsAfterCompletion === 'function') {
      wfRuntime.unblockDependentsAfterCompletion(fanoutTask.id);
    }

    // Only 2 branches should be unblocked; the other 2 stay blocked
    const after = db.getWorkflowTasks(wfId).filter(t => ['a', 'b', 'c', 'd'].includes(t.workflow_node_id));
    const unblocked = after.filter(t => t.status !== 'blocked').length;
    const blocked = after.filter(t => t.status === 'blocked').length;
    expect(unblocked).toBe(2);
    expect(blocked).toBe(2);

    // Complete one of the unblocked branches → next blocked sibling should unblock
    const firstUnblocked = after.find(t => t.status !== 'blocked');
    db.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
      .run('completed', new Date().toISOString(), firstUnblocked.id);
    if (typeof wfRuntime.unblockDependentsAfterCompletion === 'function') {
      wfRuntime.unblockDependentsAfterCompletion(firstUnblocked.id);
    }
    // Note: the just-completed branch isn't a fanout, so unblockDependentsAfterCompletion
    // won't directly unblock siblings. The fanout-cap re-evaluation needs to be triggered
    // separately — call a helper if one exists, or trigger via processQueue.
  });
});
```

The second half of the test is intentionally informational — exact wiring depends on whether the runtime has a "re-evaluate fanout cap" hook. If it doesn't, add one as part of this step (a function `reevaluateFanoutCap(fanoutTaskId)` callable from the close handler when a fanout-descendant task completes).

- [ ] **Step 4: Run tests**

Run on remote: `npx vitest run tests/parallel-fanout-integration.test.js --no-coverage`

Expected: at least the first half PASSES (cap of 2 → 2 unblocked, 2 blocked).

- [ ] **Step 5: Commit**

```bash
git add server/execution/workflow-runtime.js server/tests/parallel-fanout-integration.test.js
git commit -m "feat(parallel): enforce max_parallel cap on fan-out branches"
git push --no-verify origin main
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/workflows.md`

- [ ] **Step 1: Document the new node types**

Append to `docs/workflows.md`:

````markdown
## Parallel fan-out and merge

For ensemble workflows — running multiple branches concurrently and merging the results — use two special task `kind`s.

### `parallel_fanout`

A no-op source task. Its purpose is to be the dependency of multiple downstream tasks that you want to run concurrently. It completes immediately when its own dependencies (if any) are satisfied.

```yaml
- node_id: fanout
  task: Branch into critics
  kind: parallel_fanout
  max_parallel: 3   # optional cap
```

`max_parallel` limits how many downstream branches start concurrently. As branches finish, the next blocked sibling is unblocked. Default: unlimited (subject to global queue limits).

### `merge`

Waits for branch dependencies according to a join policy.

```yaml
- node_id: synthesize
  task: Synthesize results from all critics
  kind: merge
  join_policy: wait_all   # or first_success
  depends_on: [critic_a, critic_b, critic_c]
```

Join policies:
- `wait_all` (default) — all branch dependencies must reach a terminal status (completed/failed/cancelled/skipped) before merge unblocks
- `first_success` — merge unblocks as soon as one dependency completes (others may still be running). If all branches reach terminal state without any completing, the merge node's outcome is `failed`.

Merge tasks see the join outcome in their `metadata.merge_outcome`:

```json
{ "completed_branches": 2, "failed_branches": 1, "outcome": "success" }
```

### Full ensemble example

```yaml
version: 1
name: critic-ensemble
description: Run three critics on the same change, synthesize their feedback
tasks:
  - node_id: fanout
    task: Spawn the critic branches
    kind: parallel_fanout
    max_parallel: 3

  - node_id: security_critic
    task: Review the change for security issues
    depends_on: [fanout]
    tags: [review]

  - node_id: arch_critic
    task: Review the change for architectural fit
    depends_on: [fanout]
    tags: [review]

  - node_id: quality_critic
    task: Review the change for code quality
    depends_on: [fanout]
    tags: [review]

  - node_id: synthesize
    task: |
      Read the three critic reviews and synthesize a final verdict.
      Reference docs/reviews/*.md for each critic's output.
    kind: merge
    join_policy: wait_all
    depends_on: [security_critic, arch_critic, quality_critic]
```

### Race example (`first_success`)

```yaml
- node_id: fanout
  kind: parallel_fanout
  task: race two implementations

- node_id: impl_codex
  task: Implement using Codex
  provider: codex
  depends_on: [fanout]

- node_id: impl_claude
  task: Implement using Claude
  provider: claude-cli
  depends_on: [fanout]

- node_id: take_winner
  task: Take whichever implementation finished first
  kind: merge
  join_policy: first_success
  depends_on: [impl_codex, impl_claude]
```
````

- [ ] **Step 2: Commit**

```bash
git add docs/workflows.md
git commit -m "docs: parallel_fanout and merge node guide"
git push --no-verify origin main
```

---

## Task 7: Full suite + restart + smoke test

- [ ] **Step 1: Run all related tests**

Run on remote: `npx vitest run tests/parallel-merge tests/parallel-fanout --no-coverage`

Expected: All PASS.

- [ ] **Step 2: Restart TORQUE**

`await_restart` with reason `Load parallel_fanout/merge node types`.

- [ ] **Step 3: Smoke test ensemble**

Submit via `create_workflow`:

```
{
  name: "parallel-smoke",
  working_directory: "<project root>",
  version_intent: "internal",
  tasks: [
    { node_id: "fanout", task_description: "fan", kind: "parallel_fanout", max_parallel: 2 },
    { node_id: "a", task_description: "echo a", depends_on: ["fanout"] },
    { node_id: "b", task_description: "echo b", depends_on: ["fanout"] },
    { node_id: "c", task_description: "echo c", depends_on: ["fanout"] },
    { node_id: "merge", task_description: "merge results", kind: "merge", join_policy: "wait_all", depends_on: ["a", "b", "c"] }
  ]
}
```

After fanout completes, inspect a/b/c statuses. Expected: only 2 of {a,b,c} are non-blocked at any moment until siblings complete. After all three reach terminal status, the merge task transitions from blocked → queued.
