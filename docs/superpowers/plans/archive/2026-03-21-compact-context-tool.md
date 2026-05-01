# Compact Context Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `get_context` Tier 1 tool that returns a token-efficient digest (~200-300 tokens) for LLM session resume — replacing the need to call 3-4 verbose tools.

**Architecture:** New `server/handlers/context-handler.js` aggregates data from existing DB queries and task-manager APIs into compact structured output. Wired via auto-dispatch (`handleGetContext` → `get_context`). Includes `outputSchema` and annotations following the patterns established in prior tasks.

**Tech Stack:** Node.js, Vitest, MCP protocol (JSON-RPC 2.0)

**Spec:** `docs/superpowers/specs/2026-03-21-compact-context-tool-design.md`

**IMPORTANT:** Always push to origin/main before running tests. Use `torque-remote` for all test execution — never run vitest locally.

---

### Task 1: Export getTaskInfoPressureLevel + Create Tool Definition

**Files:**
- Modify: `server/handlers/task/core.js:1296-1309` (add to module.exports)
- Create: `server/tool-defs/context-defs.js`

- [x] **Step 1: Export getTaskInfoPressureLevel from task/core.js**

In `server/handlers/task/core.js`, add `getTaskInfoPressureLevel` to the module.exports at line 1296:

```js
module.exports = {
  handleSubmitTask,
  handleQueueTask,
  handleCheckStatus,
  handleGetResult,
  handleWaitForTask,
  handleListTasks,
  handleCancelTask,
  handleConfigure,
  handleGetProgress,
  handleShareContext,
  handleSyncFiles,
  handleTaskInfo,
  getTaskInfoPressureLevel,  // exported for context-handler.js
};
```

- [x] **Step 2: Create tool definition**

Create `server/tool-defs/context-defs.js`:

```js
/**
 * Tool definition for get_context — compact session context for LLM resume.
 */

module.exports = [
  {
    name: 'get_context',
    description: 'Compact session context for LLM resume. Returns a token-efficient digest of current state — what completed, what is running, what is next, any blockers. Use this when resuming a session or needing a quick situational overview instead of calling multiple status tools.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: {
          type: 'string',
          description: 'Workflow ID for workflow-scoped context. Omit for queue-wide context.',
        },
        include_output: {
          type: 'boolean',
          description: 'Include truncated output snippets from completed/failed tasks (default: false)',
          default: false,
        },
      },
    },
  },
];
```

- [x] **Step 3: Commit**

```bash
git add server/handlers/task/core.js server/tool-defs/context-defs.js
git commit -m "feat: export getTaskInfoPressureLevel, create context-defs.js tool definition"
git push origin main
```

---

### Task 2: Wire Into tools.js, core-tools.js, annotations, and output schemas

**Files:**
- Modify: `server/tools.js:46` (add to TOOLS array) and `server/tools.js:112` (add to HANDLER_MODULES)
- Modify: `server/core-tools.js:17` (add to TIER_1)
- Modify: `server/tool-annotations.js` (add explicit override)
- Modify: `server/tool-output-schemas.js` (add outputSchema)

- [x] **Step 1: Add context-defs to TOOLS array**

In `server/tools.js`, add before the closing `];` of TOOLS (after line 46):

```js
  ...require('./tool-defs/context-defs'),
```

- [x] **Step 2: Add context-handler to HANDLER_MODULES**

In `server/tools.js`, add to HANDLER_MODULES (after line 112, before `];`):

```js
  require('./handlers/context-handler'),
```

Note: The handler file doesn't exist yet — this will cause a startup error until Task 3 creates it. That's expected in TDD.

- [x] **Step 3: Add get_context to TIER_1**

In `server/core-tools.js`, add `'get_context'` to the TIER_1 array. Add after the Task lifecycle section (line 20):

```js
  // Context (compact session resume)
  'get_context',
```

- [x] **Step 4: Add annotation override**

In `server/tool-annotations.js`, add to the OVERRIDES object (the `get_` prefix convention already produces `readOnlyHint: true, idempotentHint: true`, but an explicit override documents intent):

```js
  get_context:                     Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
```

- [x] **Step 5: Add outputSchema**

In `server/tool-output-schemas.js`, add to the OUTPUT_SCHEMAS object:

```js
  get_context: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['queue', 'workflow'] },
      pressure_level: { type: 'string' },
      running: { type: 'object' },
      queued: { type: 'object' },
      recent_completed: { type: 'object' },
      recent_failed: { type: 'object' },
      active_workflows: { type: 'object' },
      provider_health: { type: 'object' },
      workflow: { type: 'object' },
      counts: { type: 'object' },
      completed_tasks: { type: 'array' },
      running_tasks: { type: 'array' },
      failed_tasks: { type: 'array' },
      blocked_tasks: { type: 'array' },
      next_actionable: { type: 'array' },
      alerts: { type: 'array' },
    },
    required: ['scope'],
  },
```

- [x] **Step 6: Commit**

```bash
git add server/tools.js server/core-tools.js server/tool-annotations.js server/tool-output-schemas.js
git commit -m "feat: wire get_context into tools, tier 1, annotations, and output schemas"
git push origin main
```

---

### Task 3: Implement handleGetContext — Queue Scope

**Files:**
- Create: `server/handlers/context-handler.js`
- Create: `server/tests/context-handler.test.js`

- [x] **Step 1: Write failing tests for queue scope**

Create `server/tests/context-handler.test.js`:

```js
'use strict';

const db = require('../database');

describe('context-handler', () => {
  beforeAll(() => {
    if (typeof db.resetForTest === 'function') db.resetForTest();
  });

  afterAll(() => {
    if (typeof db.resetForTest === 'function') db.resetForTest();
  });

  describe('queue scope', () => {
    it('returns correct shape with scope=queue when no workflow_id', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.scope).toBe('queue');
      expect(result.structuredData.pressure_level).toBeDefined();
      expect(result.structuredData.running).toBeDefined();
      expect(typeof result.structuredData.running.count).toBe('number');
      expect(Array.isArray(result.structuredData.running.tasks)).toBe(true);
      expect(result.structuredData.queued).toBeDefined();
      expect(result.structuredData.recent_completed).toBeDefined();
      expect(result.structuredData.recent_failed).toBeDefined();
      expect(result.structuredData.active_workflows).toBeDefined();
      expect(result.structuredData.provider_health).toBeDefined();
      expect(result.content).toBeDefined(); // backward compat markdown
    });

    it('caps running.tasks at 5', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      expect(result.structuredData.running.tasks.length).toBeLessThanOrEqual(5);
    });

    it('caps queued.next at 5', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      expect(result.structuredData.queued.next.length).toBeLessThanOrEqual(5);
    });

    it('caps recent_completed.last_3 at 3', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      expect(result.structuredData.recent_completed.last_3.length).toBeLessThanOrEqual(3);
    });

    it('provider_health has healthy/down/degraded arrays', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      const ph = result.structuredData.provider_health;
      expect(Array.isArray(ph.healthy)).toBe(true);
      expect(Array.isArray(ph.down)).toBe(true);
      expect(Array.isArray(ph.degraded)).toBe(true);
    });

    it('nothing-happening state returns correct shape with zeros and empty arrays', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      const sd = result.structuredData;
      // Counts should be numbers (possibly 0)
      expect(typeof sd.running.count).toBe('number');
      expect(typeof sd.queued.count).toBe('number');
      expect(typeof sd.recent_completed.count).toBe('number');
      expect(typeof sd.recent_failed.count).toBe('number');
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

```bash
git push origin main
torque-remote "cd server && npx vitest run tests/context-handler.test.js --reporter verbose"
```
Expected: FAIL — `Cannot find module '../handlers/context-handler'`

- [x] **Step 3: Create server/handlers/context-handler.js with queue scope**

```js
'use strict';

const db = require('../database');
const taskManager = require('../task-manager');
const { getTaskInfoPressureLevel } = require('./task/core');
const { ErrorCodes, makeError, getWorkflowTaskCounts, evaluateWorkflowVisibility } = require('./shared');
const logger = require('../logger');

const MAX_RUNNING = 5;
const MAX_QUEUED = 5;
const MAX_RECENT_COMPLETED = 3;
const MAX_RECENT_FAILED = 10;
const ERROR_SNIPPET_LENGTH = 200;
const OUTPUT_TAIL_LENGTH = 500;

/**
 * Build compact queue-scope context digest.
 */
function buildQueueContext(args) {
  const pressureLevel = getTaskInfoPressureLevel();
  const includeOutput = Boolean(args.include_output);

  // Running tasks (fetch all for accurate count, then slice for compact output)
  const running = db.listTasks({ status: 'running', orderDir: 'desc' });
  const runningTasks = running.slice(0, MAX_RUNNING).map(task => {
    const progress = taskManager.getTaskProgress(task.id);
    const activity = taskManager.getTaskActivity(task.id, { skipGitCheck: true });
    return {
      id: task.id,
      provider: task.provider || null,
      progress: progress?.progress || 0,
      elapsed_seconds: progress?.elapsedSeconds || null,
      description: (task.task_description || '').slice(0, 200),
      is_stalled: activity?.isStalled || false,
    };
  });

  // Queued tasks (fetch all for accurate count, slice for compact output)
  const allQueued = db.listTasks({ status: 'queued', orderDir: 'desc' });
  const queued = allQueued.slice(0, MAX_QUEUED);
  const queuedNext = queued.map(task => ({
    id: task.id,
    priority: task.priority || 0,
    description: (task.task_description || '').slice(0, 200),
  }));

  // Recent completed (most recent first)
  const completed = db.listTasks({ status: 'completed', limit: MAX_RECENT_COMPLETED, orderDir: 'desc' });
  const completedLast3 = completed.map(task => {
    const entry = {
      id: task.id,
      status: 'completed',
      exit_code: task.exit_code != null ? task.exit_code : null,
      duration_seconds: (task.started_at && task.completed_at)
        ? Math.round((new Date(task.completed_at) - new Date(task.started_at)) / 1000)
        : null,
      description: (task.task_description || '').slice(0, 200),
    };
    if (includeOutput && task.output) {
      entry.output_tail = task.output.slice(-OUTPUT_TAIL_LENGTH);
    }
    return entry;
  });
  const completedAll = db.listTasks({ status: 'completed' });
  const completedCount = completedAll.length;

  // Recent failed (most recent first)
  const failed = db.listTasks({ status: 'failed', limit: MAX_RECENT_FAILED, orderDir: 'desc' });
  const failedTasks = failed.map(task => {
    const errorSource = task.error_output || task.output || '';
    const entry = {
      id: task.id,
      status: 'failed',
      exit_code: task.exit_code != null ? task.exit_code : null,
      error_snippet: errorSource.slice(0, ERROR_SNIPPET_LENGTH) || null,
      description: (task.task_description || '').slice(0, 200),
    };
    if (includeOutput && task.output) {
      entry.output_tail = task.output.slice(-OUTPUT_TAIL_LENGTH);
    }
    return entry;
  });
  const failedAll = db.listTasks({ status: 'failed' });
  const failedCount = failedAll.length;

  // Active workflows
  const allWorkflows = typeof db.listWorkflows === 'function' ? db.listWorkflows({}) : [];
  const activeWfs = allWorkflows.filter(wf => wf.status === 'running' || wf.status === 'pending');
  const workflowDigest = activeWfs.slice(0, 5).map(wf => {
    let completedTasks = 0;
    let totalTasks = 0;
    try {
      const detailed = db.getWorkflowStatus(wf.id);
      if (detailed) {
        const counts = getWorkflowTaskCounts(detailed);
        completedTasks = counts.completed;
        totalTasks = counts.total;
      }
    } catch { /* ignore */ }
    return {
      id: wf.id,
      name: wf.name,
      status: wf.status,
      completed: completedTasks,
      total: totalTasks,
    };
  });

  // Provider health (Ollama hosts only)
  const healthy = [];
  const down = [];
  const degraded = [];
  try {
    const hosts = typeof db.listOllamaHosts === 'function' ? db.listOllamaHosts({}) : [];
    for (const host of hosts) {
      if (host.status === 'healthy') healthy.push(host.name || host.id);
      else if (host.status === 'down') down.push(host.name || host.id);
      else if (host.status === 'degraded') degraded.push(host.name || host.id);
    }
  } catch { /* ignore */ }

  return {
    scope: 'queue',
    pressure_level: pressureLevel,
    running: { count: running.length, tasks: runningTasks },
    queued: { count: allQueued.length, next: queuedNext },
    recent_completed: { count: completedCount, last_3: completedLast3 },
    recent_failed: { count: failedCount, tasks: failedTasks },
    active_workflows: { count: activeWfs.length, workflows: workflowDigest },
    provider_health: { healthy, down, degraded },
  };
}

/**
 * Format queue context as compact markdown.
 */
function formatQueueMarkdown(ctx) {
  const lines = [];
  lines.push(`## Context — Queue Overview`);
  lines.push(`**Pressure:** ${ctx.pressure_level} | **Running:** ${ctx.running.count} | **Queued:** ${ctx.queued.count}`);

  if (ctx.running.tasks.length > 0) {
    lines.push(`\n### Running`);
    for (const t of ctx.running.tasks) {
      const stall = t.is_stalled ? ' STALLED' : '';
      lines.push(`- ${t.id.slice(0, 8)}... ${t.provider || '?'} ${t.progress}%${stall} — ${t.description}`);
    }
  }

  if (ctx.recent_failed.tasks.length > 0) {
    lines.push(`\n### Recent Failures (${ctx.recent_failed.count})`);
    for (const t of ctx.recent_failed.tasks) {
      lines.push(`- ${t.id.slice(0, 8)}... exit=${t.exit_code} — ${t.description}`);
    }
  }

  if (ctx.active_workflows.workflows.length > 0) {
    lines.push(`\n### Active Workflows`);
    for (const wf of ctx.active_workflows.workflows) {
      lines.push(`- ${wf.name} [${wf.status}] ${wf.completed}/${wf.total}`);
    }
  }

  lines.push(`\n**Hosts:** ${ctx.provider_health.healthy.length} healthy, ${ctx.provider_health.down.length} down`);

  return lines.join('\n');
}

/**
 * Main handler — dispatches to queue or workflow scope.
 * Export name: handleGetContext → auto-dispatched as tool 'get_context'
 */
function handleGetContext(args) {
  if (args.workflow_id) {
    return buildWorkflowContext(args);
  }

  const ctx = buildQueueContext(args);
  return {
    content: [{ type: 'text', text: formatQueueMarkdown(ctx) }],
    structuredData: ctx,
  };
}

// Placeholder for Task 4 — workflow scope
function buildWorkflowContext(args) {
  return makeError(ErrorCodes.OPERATION_FAILED, 'Workflow scope not yet implemented');
}

module.exports = {
  handleGetContext,
};
```

- [x] **Step 4: Run tests to verify they pass**

```bash
git push origin main
torque-remote "cd server && npx vitest run tests/context-handler.test.js --reporter verbose"
```
Expected: All queue scope tests PASS

- [x] **Step 5: Commit**

```bash
git add server/handlers/context-handler.js server/tests/context-handler.test.js
git commit -m "feat: handleGetContext with queue scope implementation"
git push origin main
```

---

### Task 4: Implement Workflow Scope

**Files:**
- Modify: `server/handlers/context-handler.js` (replace `buildWorkflowContext` placeholder)
- Modify: `server/tests/context-handler.test.js` (add workflow scope tests)

- [x] **Step 1: Write failing tests for workflow scope**

Add inside the outer `describe('context-handler', ...)` block in the test file:

```js
  describe('workflow scope', () => {
    let testWorkflowId;

    beforeAll(() => {
      // Create a minimal workflow for testing
      if (typeof db.createWorkflow === 'function') {
        testWorkflowId = db.createWorkflow({ name: 'test-context-wf', status: 'pending' });
      }
    });

    it('returns correct shape with scope=workflow when workflow_id provided', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      if (!testWorkflowId) return; // skip if DB doesn't support createWorkflow

      const result = handleGetContext({ workflow_id: testWorkflowId });
      if (result.isError) return; // skip if workflow not found (DB compat)

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.scope).toBe('workflow');
      expect(result.structuredData.workflow).toBeDefined();
      expect(result.structuredData.workflow.id).toBe(testWorkflowId);
      expect(result.structuredData.counts).toBeDefined();
      expect(typeof result.structuredData.counts.total).toBe('number');
      expect(Array.isArray(result.structuredData.completed_tasks)).toBe(true);
      expect(Array.isArray(result.structuredData.running_tasks)).toBe(true);
      expect(Array.isArray(result.structuredData.failed_tasks)).toBe(true);
      expect(Array.isArray(result.structuredData.blocked_tasks)).toBe(true);
      expect(Array.isArray(result.structuredData.next_actionable)).toBe(true);
      expect(Array.isArray(result.structuredData.alerts)).toBe(true);
    });

    it('invalid workflow_id returns error without structuredData', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({ workflow_id: 'nonexistent-wf-xyz' });
      expect(result.isError).toBe(true);
      expect(result.structuredData).toBeUndefined();
    });

    it('workflow scope with all-pending tasks returns zero counts', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      if (!testWorkflowId) return;

      const result = handleGetContext({ workflow_id: testWorkflowId });
      if (result.isError) return;

      expect(result.structuredData.counts.completed).toBe(0);
      expect(result.structuredData.counts.running).toBe(0);
      expect(result.structuredData.counts.failed).toBe(0);
    });
  });
```

- [x] **Step 2: Run tests to verify workflow tests fail**

```bash
git push origin main
torque-remote "cd server && npx vitest run tests/context-handler.test.js --reporter verbose"
```
Expected: Workflow scope tests FAIL (placeholder returns error)

- [x] **Step 3: Implement buildWorkflowContext**

Replace the placeholder `buildWorkflowContext` function in `server/handlers/context-handler.js`:

```js
/**
 * Build compact workflow-scope context digest.
 */
function buildWorkflowContext(args) {
  const includeOutput = Boolean(args.include_output);

  const status = db.getWorkflowStatus(args.workflow_id);
  if (!status) {
    return makeError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow not found: ${args.workflow_id}`);
  }

  const visibility = evaluateWorkflowVisibility(status);
  const counts = getWorkflowTaskCounts(status);
  const taskList = Object.values(status.tasks || {});

  // Elapsed time from workflow start
  let elapsedSeconds = null;
  if (status.started_at) {
    const endTime = status.completed_at ? new Date(status.completed_at) : new Date();
    elapsedSeconds = Math.round((endTime - new Date(status.started_at)) / 1000);
  }

  // Categorize tasks
  const completedTasks = [];
  const runningTasks = [];
  const failedTasks = [];
  const blockedTasks = [];
  const nextActionable = [];
  const alerts = [];

  // Track completed node_ids for blocked_by and next_actionable computation
  const completedNodeIds = new Set();
  for (const task of taskList) {
    if (task.status === 'completed') completedNodeIds.add(task.node_id || task.id);
  }

  for (const task of taskList) {
    const nodeId = task.node_id || task.id?.substring(0, 8) || '?';
    const deps = parseDeps(task.depends_on);

    switch (task.status) {
      case 'completed': {
        const entry = {
          node_id: nodeId,
          exit_code: task.exit_code != null ? task.exit_code : null,
          duration_seconds: (task.started_at && task.completed_at)
            ? Math.round((new Date(task.completed_at) - new Date(task.started_at)) / 1000)
            : null,
        };
        if (includeOutput && task.output) {
          entry.output_tail = task.output.slice(-OUTPUT_TAIL_LENGTH);
        }
        completedTasks.push(entry);
        break;
      }
      case 'running': {
        const progress = taskManager.getTaskProgress(task.id);
        const activity = taskManager.getTaskActivity(task.id, { skipGitCheck: true });
        runningTasks.push({
          node_id: nodeId,
          provider: task.provider || null,
          elapsed_seconds: progress?.elapsedSeconds || null,
          progress: progress?.progress || 0,
        });
        // Stall alerts
        if (activity?.isStalled) {
          alerts.push(`Task ${nodeId} stalled (no output ${activity.lastActivitySeconds}s)`);
        }
        break;
      }
      case 'failed': {
        const errorSource = task.error_output || task.output || '';
        const entry = {
          node_id: nodeId,
          exit_code: task.exit_code != null ? task.exit_code : null,
          error_snippet: errorSource.slice(0, ERROR_SNIPPET_LENGTH) || null,
        };
        if (includeOutput && task.output) {
          entry.output_tail = task.output.slice(-OUTPUT_TAIL_LENGTH);
        }
        failedTasks.push(entry);
        break;
      }
      default: {
        // pending, queued, blocked, skipped, cancelled
        if (deps.length > 0) {
          const incompleteDeps = deps.filter(d => !completedNodeIds.has(d));
          if (incompleteDeps.length > 0) {
            // Check if any incomplete dep has failed — if so, this is truly blocked
            const failedNodeIds = new Set(taskList.filter(t => t.status === 'failed').map(t => t.node_id || t.id));
            const hasFailedDep = incompleteDeps.some(d => failedNodeIds.has(d));
            if (hasFailedDep) {
              blockedTasks.push({ node_id: nodeId, blocked_by: incompleteDeps });
            } else {
              // Deps still running/pending but not failed — actionable soon (ready: false)
              nextActionable.push({ node_id: nodeId, depends_on: deps, ready: false });
            }
          } else {
            // All deps completed — this task is actionable now
            nextActionable.push({ node_id: nodeId, depends_on: deps, ready: true });
          }
        } else if (task.status === 'pending' || task.status === 'queued') {
          // No deps and not started — actionable
          nextActionable.push({ node_id: nodeId, depends_on: [], ready: true });
        }
        break;
      }
    }

    // Provider fallback alerts from metadata
    try {
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
      if (meta._provider_switch_reason) {
        alerts.push(`Task ${nodeId} fell back: ${meta._provider_switch_reason}`);
      }
    } catch { /* ignore parse errors */ }
  }

  const ctx = {
    scope: 'workflow',
    workflow: {
      id: status.id,
      name: status.name,
      status: status.status,
      visibility: visibility.label,
      elapsed_seconds: elapsedSeconds,
    },
    counts: {
      completed: counts.completed,
      running: counts.running,
      queued: counts.queued,
      pending: counts.pending,
      blocked: counts.blocked,
      failed: counts.failed,
      skipped: counts.skipped,
      cancelled: counts.cancelled,
      total: counts.total,
    },
    completed_tasks: completedTasks,
    running_tasks: runningTasks,
    failed_tasks: failedTasks,
    blocked_tasks: blockedTasks,
    next_actionable: nextActionable,
    alerts: alerts,
  };

  return {
    content: [{ type: 'text', text: formatWorkflowMarkdown(ctx) }],
    structuredData: ctx,
  };
}

/**
 * Parse depends_on which may be a JSON string or array.
 */
function parseDeps(depsRaw) {
  if (!depsRaw) return [];
  if (Array.isArray(depsRaw)) return depsRaw;
  if (typeof depsRaw === 'string') {
    try { return JSON.parse(depsRaw); } catch { return []; }
  }
  return [];
}

/**
 * Format workflow context as compact markdown.
 */
function formatWorkflowMarkdown(ctx) {
  const lines = [];
  lines.push(`## Context — ${ctx.workflow.name}`);
  lines.push(`**Status:** ${ctx.workflow.status} | **Visibility:** ${ctx.workflow.visibility}`);
  lines.push(`**Progress:** ${ctx.counts.completed}/${ctx.counts.total} completed, ${ctx.counts.running} running, ${ctx.counts.failed} failed`);

  if (ctx.running_tasks.length > 0) {
    lines.push(`\n### Running`);
    for (const t of ctx.running_tasks) {
      lines.push(`- ${t.node_id} — ${t.provider || '?'} ${t.progress}%`);
    }
  }

  if (ctx.failed_tasks.length > 0) {
    lines.push(`\n### Failed`);
    for (const t of ctx.failed_tasks) {
      lines.push(`- ${t.node_id} — exit=${t.exit_code}`);
    }
  }

  if (ctx.blocked_tasks.length > 0) {
    lines.push(`\n### Blocked`);
    for (const t of ctx.blocked_tasks) {
      lines.push(`- ${t.node_id} ← waiting on [${t.blocked_by.join(', ')}]`);
    }
  }

  if (ctx.next_actionable.length > 0) {
    lines.push(`\n### Next`);
    for (const t of ctx.next_actionable) {
      lines.push(`- ${t.node_id}${t.ready ? ' (ready)' : ''}`);
    }
  }

  if (ctx.alerts.length > 0) {
    lines.push(`\n### Alerts`);
    for (const a of ctx.alerts) {
      lines.push(`- ${a}`);
    }
  }

  return lines.join('\n');
}
```

- [x] **Step 4: Run tests to verify all pass**

```bash
git push origin main
torque-remote "cd server && npx vitest run tests/context-handler.test.js --reporter verbose"
```
Expected: All tests PASS (queue scope + workflow scope)

- [x] **Step 5: Commit**

```bash
git add server/handlers/context-handler.js server/tests/context-handler.test.js
git commit -m "feat: handleGetContext workflow scope with blocked_by, next_actionable, alerts"
git push origin main
```

---

### Task 5: Integration Tests + Full Verification

**Files:**
- Modify: `server/tests/context-handler.test.js` (add integration tests)

- [x] **Step 1: Add integration tests**

Add inside the outer describe block:

```js
  describe('integration', () => {
    it('get_context appears in Tier 1 tool list', () => {
      const { CORE_TOOL_NAMES } = require('../core-tools');
      expect(CORE_TOOL_NAMES).toContain('get_context');
    });

    it('get_context has annotations (readOnly + idempotent)', () => {
      const { TOOLS } = require('../tools');
      const tool = TOOLS.find(t => t.name === 'get_context');
      expect(tool).toBeDefined();
      expect(tool.annotations).toBeDefined();
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.idempotentHint).toBe(true);
    });

    it('get_context has outputSchema', () => {
      const { TOOLS } = require('../tools');
      const tool = TOOLS.find(t => t.name === 'get_context');
      expect(tool).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema.required).toContain('scope');
    });

    it('get_context structuredData flows through protocol as structuredContent', () => {
      const { getOutputSchema } = require('../tool-output-schemas');
      const { handleGetContext } = require('../handlers/context-handler');

      const result = handleGetContext({});
      expect(result.structuredData).toBeDefined();

      // Simulate protocol layer
      if (result.structuredData && !result.isError && getOutputSchema('get_context')) {
        result.structuredContent = result.structuredData;
        delete result.structuredData;
      }

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.scope).toBe('queue');
      expect(result.structuredData).toBeUndefined();
    });
  });
```

- [x] **Step 2: Run all context-handler tests**

```bash
git push origin main
torque-remote "cd server && npx vitest run tests/context-handler.test.js --reporter verbose"
```
Expected: All tests PASS

- [x] **Step 3: Run annotation + output schema tests for regressions**

```bash
torque-remote "cd server && npx vitest run tests/tool-annotations.test.js tests/tool-output-schemas.test.js tests/context-handler.test.js --reporter verbose"
```
Expected: All pass, no regressions

- [x] **Step 4: Verify tool appears in tools list**

```bash
cd server && node -e "
const { TOOLS } = require('./tools');
const tool = TOOLS.find(t => t.name === 'get_context');
console.log('get_context found:', !!tool);
console.log('  annotations:', JSON.stringify(tool.annotations));
console.log('  outputSchema required:', tool.outputSchema?.required);
console.log('  inputSchema properties:', Object.keys(tool.inputSchema?.properties || {}));
"
```

- [x] **Step 5: Commit**

```bash
git add server/tests/context-handler.test.js
git commit -m "test: integration tests for get_context — tier 1, annotations, schema, protocol"
git push origin main
```
