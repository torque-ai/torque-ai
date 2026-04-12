# Fabro #4: Goal Gates + Failure Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two small additive features that compose well:
1. **Goal gates** — Mark workflow tasks as `goal_gate: true`. A workflow cannot be marked `completed` if any goal-gated task did not succeed (`completed` with no test failures). Tasks tagged `tests:fail:N` automatically count as goal-gate violations regardless of task status.
2. **Failure classification** — Classify every failed task into one of `transient_infra`, `deterministic`, `budget_exhausted`, `canceled`, `structural`, or `unknown`. Store the class in task metadata so it's queryable, surface it in retros (Plan 2), and use it for downstream routing decisions (future).

**Architecture:**
- `goal_gate` becomes a per-task field accepted by `create_workflow` and stored in task metadata. The workflow-completion code path checks all goal-gated tasks before transitioning the workflow to `completed`. If any goal-gate violations exist, the workflow goes to `failed` instead with a structured reason.
- A new `server/validation/failure-classifier.js` module classifies error output into a class. Called from the close handler (after `handleProviderFailover`) and stamped into task metadata as `failure_class`. The classifier is a pure function so it's trivially testable.

**Tech Stack:** Node.js, existing TORQUE workflow engine.

**Test invocation:** `torque-remote` on remote project path from `~/.torque-remote.local.json`.

---

## File Structure

**New files:**
- `server/validation/failure-classifier.js` — pure classifier
- `server/tests/failure-classifier.test.js`
- `server/tests/goal-gate-workflow.test.js`

**Modified files:**
- `server/handlers/workflow/index.js` — accept `goal_gate` per task, store in metadata
- `server/tool-defs/workflow-defs.js` — document `goal_gate` arg
- `server/workflow-spec/schema.js` (if Plan 1 shipped) — accept `goal_gate` field
- `server/execution/workflow-runtime.js` — enforce goal gates on workflow completion
- `server/execution/task-finalizer.js` — call classifier, stamp `failure_class` into metadata
- `server/retros/build-stats.js` (if Plan 2 shipped) — surface `failure_class` per stage
- `docs/workflows.md` (or wherever workflow docs live) — document goal_gate + failure_class

---

## Task 1: Failure classifier

**Files:**
- Create: `server/validation/failure-classifier.js`
- Create: `server/tests/failure-classifier.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/failure-classifier.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { classifyFailure } = require('../validation/failure-classifier');

describe('classifyFailure', () => {
  it('returns unknown when no inputs', () => {
    expect(classifyFailure({}).class).toBe('unknown');
  });

  it('detects rate-limit as transient_infra', () => {
    expect(classifyFailure({ errorOutput: 'Error 429: Too Many Requests, retry after 60s' }).class)
      .toBe('transient_infra');
  });

  it('detects 5xx as transient_infra', () => {
    expect(classifyFailure({ errorOutput: 'HTTP 503 Service Unavailable' }).class)
      .toBe('transient_infra');
  });

  it('detects timeout as transient_infra', () => {
    expect(classifyFailure({ errorOutput: 'request timeout after 30000ms' }).class)
      .toBe('transient_infra');
  });

  it('detects network errors as transient_infra', () => {
    expect(classifyFailure({ errorOutput: 'ECONNRESET while reading from upstream' }).class)
      .toBe('transient_infra');
    expect(classifyFailure({ errorOutput: 'ETIMEDOUT' }).class)
      .toBe('transient_infra');
  });

  it('detects auth errors as deterministic', () => {
    expect(classifyFailure({ errorOutput: 'Error 401: invalid API key' }).class)
      .toBe('deterministic');
    expect(classifyFailure({ errorOutput: '403 Forbidden' }).class)
      .toBe('deterministic');
    expect(classifyFailure({ errorOutput: 'Authentication failed' }).class)
      .toBe('deterministic');
  });

  it('detects context length / quota as budget_exhausted', () => {
    expect(classifyFailure({ errorOutput: 'context_length_exceeded' }).class)
      .toBe('budget_exhausted');
    expect(classifyFailure({ errorOutput: 'maximum context length is 200000 tokens' }).class)
      .toBe('budget_exhausted');
    expect(classifyFailure({ errorOutput: 'quota exceeded for this billing period' }).class)
      .toBe('budget_exhausted');
  });

  it('detects cancellation as canceled', () => {
    expect(classifyFailure({ errorOutput: 'Task cancelled by user', cancelReason: 'user' }).class)
      .toBe('canceled');
    expect(classifyFailure({ errorOutput: '', cancelReason: 'orphan_cleanup' }).class)
      .toBe('canceled');
  });

  it('exit code 0 + non-empty errorOutput → unknown (provider succeeded)', () => {
    expect(classifyFailure({ exitCode: 0, errorOutput: 'some warning' }).class)
      .toBe('unknown');
  });

  it('returns details object with matched pattern when classifying', () => {
    const r = classifyFailure({ errorOutput: 'Error 429: rate limit' });
    expect(r.matched_pattern).toBeTruthy();
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('handles structural / scope violation patterns', () => {
    expect(classifyFailure({ errorOutput: 'write scope violation: refused to modify file outside working_directory' }).class)
      .toBe('structural');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run on remote: `npx vitest run tests/failure-classifier.test.js --no-coverage`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement classifier**

Create `server/validation/failure-classifier.js`:

```js
'use strict';

// Pattern → class. Order matters: the FIRST matching pattern wins.
// Patterns are case-insensitive. Keep narrow patterns above broad ones.
const PATTERNS = [
  // Cancellation comes first so it overrides any error output noise
  { class: 'canceled', test: ({ cancelReason }) => !!cancelReason, name: 'cancel_reason set' },

  // Structural — agent refused to do something it shouldn't
  { class: 'structural', re: /write scope violation|refused to modify/i, name: 'write_scope_violation' },

  // Budget — explicit context/quota exhaustion
  { class: 'budget_exhausted', re: /context_length_exceeded|maximum context length|context window/i, name: 'context_length' },
  { class: 'budget_exhausted', re: /quota exceeded|usage limit reached|billing period/i, name: 'quota_exceeded' },
  { class: 'budget_exhausted', re: /token.*limit.*reached|max.*tokens?.*exceeded/i, name: 'token_limit' },

  // Deterministic — auth/config errors that retry won't fix
  { class: 'deterministic', re: /\b401\b|invalid api key|unauthorized\b/i, name: 'auth_401' },
  { class: 'deterministic', re: /\b403\b|forbidden|authentication failed/i, name: 'auth_403' },
  { class: 'deterministic', re: /invalid_request|bad request|400\b/i, name: 'bad_request' },

  // Transient — retryable infrastructure
  { class: 'transient_infra', re: /\b429\b|too many requests|rate limit/i, name: 'rate_limit_429' },
  { class: 'transient_infra', re: /\b5\d{2}\b|service unavailable|gateway timeout|bad gateway/i, name: 'http_5xx' },
  { class: 'transient_infra', re: /timeout|timed out|ETIMEDOUT/i, name: 'timeout' },
  { class: 'transient_infra', re: /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i, name: 'network' },
  { class: 'transient_infra', re: /stream.*interrupted|connection.*closed/i, name: 'stream_drop' },
];

/**
 * Classify a task failure into one of the known classes.
 * @param {{ errorOutput?: string, output?: string, exitCode?: number, cancelReason?: string|null }} input
 * @returns {{ class: string, matched_pattern: string|null, confidence: number }}
 */
function classifyFailure(input = {}) {
  const ctx = {
    errorOutput: input.errorOutput || '',
    output: input.output || '',
    exitCode: input.exitCode,
    cancelReason: input.cancelReason || null,
  };

  // Provider succeeded → not really a failure for this purpose
  if (ctx.exitCode === 0 && !ctx.cancelReason) {
    return { class: 'unknown', matched_pattern: null, confidence: 0 };
  }

  for (const p of PATTERNS) {
    if (p.test) {
      if (p.test(ctx)) {
        return { class: p.class, matched_pattern: p.name, confidence: 0.9 };
      }
      continue;
    }
    if (p.re && (p.re.test(ctx.errorOutput) || p.re.test(ctx.output))) {
      return { class: p.class, matched_pattern: p.name, confidence: 0.7 };
    }
  }

  return { class: 'unknown', matched_pattern: null, confidence: 0 };
}

module.exports = { classifyFailure };
```

- [ ] **Step 4: Run tests**

Run on remote: `npx vitest run tests/failure-classifier.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/validation/failure-classifier.js server/tests/failure-classifier.test.js
git commit -m "feat(failure-classifier): pure function for error categorization"
git push --no-verify origin main
```

---

## Task 2: Stamp failure_class into task metadata

**Files:**
- Modify: `server/execution/task-finalizer.js`

- [ ] **Step 1: Locate where final metadata is built**

Read `server/execution/task-finalizer.js`. Find where `metadata` is assembled before the final `updateTaskStatus` call (search for `buildValidationMetadata` or the `metadata` field passed to `updateTaskStatus`).

- [ ] **Step 2: Add classification call**

Right before the metadata is written (and after `handleProviderFailover` has run, so its early-exit doesn't skip this), add:

```js
// Failure classification — store the class so retros, dashboard, and routing can use it
try {
  if (ctx.status === 'failed') {
    const { classifyFailure } = require('../validation/failure-classifier');
    const classification = classifyFailure({
      errorOutput: ctx.errorOutput,
      output: ctx.output,
      exitCode: ctx.rawExitCode ?? ctx.code,
      cancelReason: ctx.task?.cancel_reason || null,
    });
    metadata.failure_class = classification.class;
    if (classification.matched_pattern) {
      metadata.failure_class_pattern = classification.matched_pattern;
    }
  }
} catch (clsErr) {
  // Classification is best-effort — don't fail finalization over it
  logger.info(`[finalizer] Failure classification failed: ${clsErr.message}`);
}
```

The exact insertion site: just before `metadata` is passed to `updateTaskStatus`. If the file builds metadata via `buildValidationMetadata(task, ctx, rawExitCode)`, do the augmentation right after that call, mutating the returned object.

- [ ] **Step 3: Write integration test**

Create `server/tests/failure-classifier-integration.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db, testDir;
beforeAll(() => { const e = setupTestDb('fc-integration'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

describe('failure_class stamping', () => {
  it('stamps transient_infra into metadata for rate-limited failed tasks', async () => {
    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'x',
      working_directory: testDir,
      status: 'pending',
      provider: 'codex',
    });
    db.prepare('UPDATE tasks SET status = ?, started_at = ?, error_output = ? WHERE id = ?')
      .run('running', '2026-04-11T10:00:00Z', '', taskId);

    // Simulate the finalizer calling updateTaskStatus with a rate-limit error
    const taskFinalizer = require('../execution/task-finalizer');
    // Initialize finalizer if it requires init in the test env
    if (typeof taskFinalizer.init === 'function') {
      try {
        taskFinalizer.init({ db, sanitizeTaskOutput: x => x, safeUpdateTaskStatus: db.updateTaskStatus });
      } catch { /* may already be initialized */ }
    }
    await taskFinalizer.finalizeTask(taskId, {
      exitCode: 1,
      output: '',
      errorOutput: 'Error 429: Too Many Requests',
      filesModified: [],
    });

    const t = db.getTask(taskId);
    expect(t.status).toBe('failed');
    const meta = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : t.metadata;
    expect(meta.failure_class).toBe('transient_infra');
    expect(meta.failure_class_pattern).toMatch(/rate_limit|429/);
  });
});
```

If your test environment doesn't expose `taskFinalizer.finalizeTask` directly, fall back to verifying classifier integration via `buildValidationMetadata` unit-style — call the metadata builder with a mock ctx that has `status: 'failed'` and `errorOutput: 'Error 429'` and assert the returned metadata contains `failure_class`.

- [ ] **Step 4: Run test**

Run on remote: `npx vitest run tests/failure-classifier-integration.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/execution/task-finalizer.js server/tests/failure-classifier-integration.test.js
git commit -m "feat(failure-class): stamp class into task metadata at finalization"
git push --no-verify origin main
```

---

## Task 3: Goal-gate field accepted at workflow creation

**Files:**
- Modify: `server/handlers/workflow/index.js`
- Modify: `server/tool-defs/workflow-defs.js`

- [ ] **Step 1: Add `goal_gate` to per-task tool schema**

In `server/tool-defs/workflow-defs.js`, find the `create_workflow` schema's `tasks.items.properties` block. Add:

```js
goal_gate: {
  type: 'boolean',
  description: 'If true, this task must succeed (or pass tests:pass) for the workflow to be marked completed. Failed goal gates demote the workflow to failed.',
},
```

- [ ] **Step 2: Store goal_gate in task metadata at creation**

In `server/handlers/workflow/index.js`, find `buildWorkflowTaskMetadata`. Augment it:

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
  return metaObj;
}
```

- [ ] **Step 3: Test that the field round-trips**

Create `server/tests/goal-gate-workflow.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db, testDir;
beforeAll(() => { const e = setupTestDb('goal-gate'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

function extractUUID(text) { return text.match(/([a-f0-9-]{36})/)?.[1]; }
function parseMeta(t) { return typeof t.metadata === 'string' ? JSON.parse(t.metadata) : (t.metadata || {}); }

describe('create_workflow with goal_gate', () => {
  it('stores goal_gate flag in task metadata', async () => {
    const result = await safeTool('create_workflow', {
      name: 'gg-1',
      working_directory: testDir,
      tasks: [
        { node_id: 'critical', task_description: 'critical step', goal_gate: true },
        { node_id: 'optional', task_description: 'optional step' },
      ],
    });
    expect(result.isError).toBeFalsy();
    const wfId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(wfId);
    const critical = tasks.find(t => t.workflow_node_id === 'critical');
    const optional = tasks.find(t => t.workflow_node_id === 'optional');
    expect(parseMeta(critical).goal_gate).toBe(true);
    expect(parseMeta(optional).goal_gate).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run test**

Run on remote: `npx vitest run tests/goal-gate-workflow.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/handlers/workflow/index.js server/tool-defs/workflow-defs.js server/tests/goal-gate-workflow.test.js
git commit -m "feat(goal-gate): accept goal_gate per task in create_workflow"
git push --no-verify origin main
```

---

## Task 4: Workflow-spec schema (if Plan 1 shipped)

**Files:**
- Modify: `server/workflow-spec/schema.js`

**Skip this task if Plan 1 has not shipped.**

- [ ] **Step 1: Add to per-task schema**

In `server/workflow-spec/schema.js` `tasks.items.properties`, add:

```js
goal_gate: { type: 'boolean' },
```

- [ ] **Step 2: Test round-trip via spec handler**

Add to `server/tests/workflow-spec-handlers.test.js`:

```js
it('passes goal_gate per task through to create_workflow', () => {
  const wfDir = path.join(testDir, 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  const specPath = path.join(wfDir, 'gg.yaml');
  fs.writeFileSync(specPath, `
version: 1
name: gg-spec
project: p
tasks:
  - node_id: critical
    task: critical
    goal_gate: true
  - node_id: optional
    task: optional
`);
  const result = handleRunWorkflowSpec({ spec_path: specPath, working_directory: testDir });
  expect(result.isError).toBeFalsy();
  const tasks = db.getWorkflowTasks(result.structuredData.workflow_id);
  const critical = tasks.find(t => t.workflow_node_id === 'critical');
  const meta = typeof critical.metadata === 'string' ? JSON.parse(critical.metadata) : critical.metadata;
  expect(meta.goal_gate).toBe(true);
});
```

Run tests. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/workflow-spec/schema.js server/tests/workflow-spec-handlers.test.js
git commit -m "feat(workflow-spec): accept goal_gate per task"
git push --no-verify origin main
```

---

## Task 5: Enforce goal gates at workflow completion

**Files:**
- Modify: `server/execution/workflow-runtime.js`

- [ ] **Step 1: Find the workflow-completion site**

Read `server/execution/workflow-runtime.js`. Identify where a workflow transitions to `completed`. There is typically a function that detects "all tasks reached terminal status" and writes `workflows.status = 'completed'`. Search for `'completed'` in update statements.

- [ ] **Step 2: Insert goal-gate check before marking completed**

Right before the `completed` status write, add a goal-gate enforcement step:

```js
// Goal-gate enforcement: a workflow with any failed goal-gated task is demoted to failed
function evaluateGoalGates(workflowId) {
  const tasks = db.getWorkflowTasks(workflowId) || [];
  const violations = [];
  for (const task of tasks) {
    let meta;
    try { meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}); } catch { meta = {}; }
    if (!meta.goal_gate) continue;

    // Goal gate violation if:
    // - task didn't reach completed
    // - task is completed but tags include tests:fail:N
    let tags;
    try { tags = typeof task.tags === 'string' ? JSON.parse(task.tags) : (task.tags || []); } catch { tags = []; }
    const verifyFailTag = tags.find(t => typeof t === 'string' && t.startsWith('tests:fail:'));

    if (task.status !== 'completed') {
      violations.push({ node_id: task.workflow_node_id, reason: `status=${task.status}` });
    } else if (verifyFailTag) {
      violations.push({ node_id: task.workflow_node_id, reason: `verify failed (${verifyFailTag})` });
    }
  }
  return violations;
}
```

Then at the completion site:

```js
const violations = evaluateGoalGates(workflowId);
if (violations.length > 0) {
  const reason = `Goal-gate violations: ${violations.map(v => `${v.node_id} (${v.reason})`).join('; ')}`;
  logger.info(`[workflow-runtime] Workflow ${workflowId} demoted to failed: ${reason}`);
  db.updateWorkflow(workflowId, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    error_output: reason,
  });
  // Skip the normal "completed" path
  return;
}
// ... existing code that marks workflow as completed ...
```

- [ ] **Step 3: Integration test**

Append to `server/tests/goal-gate-workflow.test.js`:

```js
describe('goal-gate enforcement on workflow completion', () => {
  it('demotes workflow to failed when a goal-gated task has tests:fail:N tag', async () => {
    const result = await safeTool('create_workflow', {
      name: 'gg-enforce-1',
      working_directory: testDir,
      tasks: [
        { node_id: 'critical', task_description: 'x', goal_gate: true },
      ],
    });
    const wfId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(wfId);
    const taskId = tasks[0].id;

    // Simulate task completion with a verify failure
    db.prepare('UPDATE tasks SET status = ?, completed_at = ?, tags = ? WHERE id = ?')
      .run('completed', new Date().toISOString(), JSON.stringify(['tests:fail:5']), taskId);

    // Trigger workflow finalization (call the runtime function or wait for the normal path)
    const workflowRuntime = require('../execution/workflow-runtime');
    if (typeof workflowRuntime.finalizeWorkflow === 'function') {
      await workflowRuntime.finalizeWorkflow(wfId);
    } else if (typeof workflowRuntime.evaluateWorkflowCompletion === 'function') {
      await workflowRuntime.evaluateWorkflowCompletion(wfId);
    } else {
      // Fall back to whatever public function the runtime exposes for "all tasks done, decide workflow status"
      throw new Error('Unable to locate workflow finalization entry point — adjust the test to call the right function');
    }

    const wf = db.getWorkflow(wfId);
    expect(wf.status).toBe('failed');
    expect(wf.error_output).toMatch(/goal-gate/i);
  });

  it('marks workflow completed when all goal-gated tasks succeed', async () => {
    const result = await safeTool('create_workflow', {
      name: 'gg-enforce-2',
      working_directory: testDir,
      tasks: [
        { node_id: 'critical', task_description: 'x', goal_gate: true },
      ],
    });
    const wfId = extractUUID(getText(result));
    const taskId = db.getWorkflowTasks(wfId)[0].id;
    db.prepare('UPDATE tasks SET status = ?, completed_at = ?, tags = ? WHERE id = ?')
      .run('completed', new Date().toISOString(), JSON.stringify(['tests:pass']), taskId);

    const workflowRuntime = require('../execution/workflow-runtime');
    if (typeof workflowRuntime.finalizeWorkflow === 'function') {
      await workflowRuntime.finalizeWorkflow(wfId);
    } else if (typeof workflowRuntime.evaluateWorkflowCompletion === 'function') {
      await workflowRuntime.evaluateWorkflowCompletion(wfId);
    }

    const wf = db.getWorkflow(wfId);
    expect(wf.status).toBe('completed');
  });
});
```

- [ ] **Step 4: Run tests**

Run on remote: `npx vitest run tests/goal-gate-workflow.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/execution/workflow-runtime.js server/tests/goal-gate-workflow.test.js
git commit -m "feat(goal-gate): demote workflow to failed when goal gates not met"
git push --no-verify origin main
```

---

## Task 6: Surface failure_class in retros (if Plan 2 shipped)

**Files:**
- Modify: `server/retros/build-stats.js`

**Skip this task if Plan 2 has not shipped.**

- [ ] **Step 1: Include failure_class per stage**

In `server/retros/build-stats.js`, the `perStage` mapping currently builds an object per task. Add `failure_class`:

```js
const perStage = tasks.map(t => {
  let meta;
  try { meta = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : (t.metadata || {}); } catch { meta = {}; }
  return {
    task_id: t.id,
    node_id: t.workflow_node_id,
    status: t.status,
    provider: t.provider,
    original_provider: t.original_provider || null,
    duration_seconds: diffSeconds(t.started_at, t.completed_at),
    retry_count: t.retry_count || 0,
    files_modified: (() => { try { return typeof t.files_modified === 'string' ? JSON.parse(t.files_modified) : (t.files_modified || []); } catch { return []; } })(),
    verify: parseVerifyTag((() => { try { return typeof t.tags === 'string' ? JSON.parse(t.tags) : (t.tags || []); } catch { return []; } })()),
    tags: (() => { try { return typeof t.tags === 'string' ? JSON.parse(t.tags) : (t.tags || []); } catch { return []; } })(),
    error_reason: t.status === 'failed' ? (t.error_output || '').slice(0, 500) : null,
    failure_class: meta.failure_class || null,        // NEW
    goal_gate: meta.goal_gate === true,                // NEW
  };
});
```

- [ ] **Step 2: Update narrative prompt to mention failure classes**

In `server/retros/narrative-prompt.js` `buildPrompt`, extend the per-stage line:

```js
${stats.per_stage.map(s => `- ${s.node_id} (${s.provider}): ${s.status} in ${s.duration_seconds}s, retries=${s.retry_count}, verify=${s.verify.outcome}${s.failure_class ? `, failure_class=${s.failure_class}` : ''}${s.goal_gate ? ' [goal_gate]' : ''}${s.error_reason ? `, error: ${s.error_reason.slice(0, 200)}` : ''}`).join('\n')}
```

- [ ] **Step 3: Test**

Update `server/tests/retros-build-stats.test.js` — add a case where a task has `metadata.failure_class = 'transient_infra'` and assert it appears in `per_stage`.

```js
it('includes failure_class and goal_gate flags from task metadata', () => {
  const wfId = require('crypto').randomUUID();
  insertWorkflow({ id: wfId, startedAt: '2026-04-11T10:00:00Z', completedAt: '2026-04-11T10:01:00Z' });
  const taskId = require('crypto').randomUUID();
  insertTask({
    id: taskId, workflow_id: wfId, provider: 'codex', status: 'failed',
    started_at: '2026-04-11T10:00:00Z', completed_at: '2026-04-11T10:00:30Z', files_modified: [],
  });
  db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ failure_class: 'transient_infra', goal_gate: true }), taskId);

  const stats = require('../retros/build-stats').buildStats(wfId);
  const stage = stats.per_stage[0];
  expect(stage.failure_class).toBe('transient_infra');
  expect(stage.goal_gate).toBe(true);
});
```

Run tests. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/retros/build-stats.js server/retros/narrative-prompt.js server/tests/retros-build-stats.test.js
git commit -m "feat(retros): include failure_class + goal_gate per stage"
git push --no-verify origin main
```

---

## Task 7: Documentation

**Files:**
- Create or modify: `docs/workflows.md`

- [ ] **Step 1: Document goal_gate + failure_class**

Add a new section to `docs/workflows.md` (create if missing):

````markdown
## Goal gates

Mark a workflow task as `goal_gate: true` when it represents a non-bypassable quality check (tests, security scan, human approval). The workflow cannot transition to `completed` if any goal-gated task did not succeed.

A goal gate is violated when:
- The task's status is not `completed` (it failed, was cancelled, or skipped)
- OR the task is completed but has a `tests:fail:N` tag

If any goal-gate violation exists at workflow finalization, the workflow is marked `failed` with an `error_output` listing the violations.

### Example

```yaml
tasks:
  - node_id: implement
    task: Implement the feature
  - node_id: tests
    task: Run the test suite and report results
    goal_gate: true   # workflow can't succeed if tests fail
  - node_id: deploy
    task: Deploy to staging
    depends_on: [tests]
```

If `tests` ends with `tests:fail:5`, the workflow is demoted to failed even if `deploy` somehow succeeds.

## Failure classification

Every failed task is automatically classified into one of:

| Class | Meaning | Example |
|---|---|---|
| `transient_infra` | Retryable infrastructure problem | Rate limits, timeouts, 5xx, network errors |
| `deterministic` | Permanent failure — retrying won't help | Auth errors, invalid request, bad config |
| `budget_exhausted` | Resource limit reached | Context length, token quota, billing limits |
| `canceled` | User or system cancellation | `cancel_task` invoked, orphan cleanup |
| `structural` | Scope or safety violation | Agent refused write outside working_directory |
| `unknown` | Could not classify | No matching pattern |

The class is stored as `metadata.failure_class` on the task. Use it to filter failed tasks (`list_tasks { tags: ["..."] }` doesn't cover this; query metadata directly via the tasks REST endpoint), to inform retro narratives, and as a future input to retry/escalation routing.
````

- [ ] **Step 2: Commit**

```bash
git add docs/workflows.md
git commit -m "docs: goal_gate + failure_class guide"
git push --no-verify origin main
```

---

## Task 8: Full suite + restart + smoke test

- [ ] **Step 1: Run all tests**

Run on remote: `npx vitest run tests/failure-classifier tests/goal-gate --no-coverage`

Expected: All PASS.

- [ ] **Step 2: Restart TORQUE**

`await_restart` with reason `Load goal_gate enforcement + failure_class stamping`.

- [ ] **Step 3: Smoke test goal gate**

Submit via `create_workflow`:

```
{
  name: "gg-smoke",
  working_directory: "<project root>",
  version_intent: "internal",
  tasks: [
    { node_id: "alwaysfail", task_description: "exit 1 immediately", provider: "codex", goal_gate: true }
  ]
}
```

After it completes, fetch the workflow status. Expected: `failed` with `error_output` mentioning goal-gate violation.

- [ ] **Step 4: Smoke test failure_class**

Inspect a recently failed task via the v2 API. Expected: `metadata.failure_class` populated with one of the known values (or `unknown` if no pattern matched).
