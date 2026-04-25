# Fabro #22: Sub-Workflows as Callable Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A workflow spec can declare `sub_workflows`, each of which becomes a callable MCP tool the orchestrating agent can invoke from inside a parent task. Each sub-workflow runs in an isolated session with structured parameters and returns a structured result. Inspired by Goose's subrecipes-as-tools.

**Architecture:** A workflow's `sub_workflows: { name: spec_path }` declarations get registered as ephemeral MCP tools at workflow start. When a parent task's agent calls one (e.g., `call_subworkflow_<name>`), TORQUE creates a child workflow from the named spec, runs it to completion, and returns the result to the parent's tool call. Child workflows inherit the parent's `working_directory` but get an isolated context. Tool registration is per-workflow (scoped to the parent workflow's lifetime).

**Depends on Plan 1 (workflow-as-code).**

---

## File Structure

**New files:**
- `server/subworkflows/register.js` — register sub-workflows as MCP tools
- `server/subworkflows/invoke.js` — execute a child workflow synchronously, return result
- `server/handlers/subworkflow-handlers.js`
- `server/tests/subworkflows.test.js`

**Modified files:**
- `server/workflow-spec/schema.js` — accept `sub_workflows` field
- `server/handlers/workflow/index.js` — register sub-workflow tools when starting parent
- `server/execution/workflow-runtime.js` — unregister on workflow finalization
- `docs/subworkflows.md`

---

## Task 1: Schema + invoke logic

- [ ] **Step 1: Schema**

In `server/workflow-spec/schema.js` top-level properties:

```js
sub_workflows: {
  type: 'object',
  description: 'Map of sub-workflow name → spec_path. Each becomes a callable MCP tool inside parent tasks.',
  additionalProperties: { type: 'string' },
},
```

- [ ] **Step 2: Invoke module + tests**

Create `server/tests/subworkflows.test.js`:

```js
'use strict';
const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const fs = require('fs');
const path = require('path');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { invokeSubWorkflow } = require('../subworkflows/invoke');

let db, testDir;
beforeAll(() => { const e = setupTestDb('subworkflows'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

describe('invokeSubWorkflow', () => {
  it('creates a child workflow from a spec and returns its workflow_id', async () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'sub.yaml'), `
version: 1
name: sub-test
project: p
tasks:
  - node_id: only
    task: do the thing
`);

    const result = await invokeSubWorkflow({
      spec_path: path.join(wfDir, 'sub.yaml'),
      working_directory: testDir,
      parent_task_id: 'parent-1',
      params: { custom: 'value' },
    });

    expect(result.ok).toBe(true);
    expect(result.workflow_id).toMatch(/^[a-f0-9-]{36}$/);
    const wf = db.getWorkflow(result.workflow_id);
    expect(wf.name).toBe('sub-test');
    expect(wf.context.parent_task_id).toBe('parent-1');
  });

  it('returns error for missing spec', async () => {
    const result = await invokeSubWorkflow({
      spec_path: '/no/such/file.yaml',
      working_directory: testDir,
      parent_task_id: 'parent-1',
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/subworkflows/invoke.js`:

```js
'use strict';

const fs = require('fs');
const workflowHandlers = require('../handlers/workflow');
const logger = require('../logger').child({ component: 'subworkflows' });

async function invokeSubWorkflow({ spec_path, working_directory, parent_task_id, params = {} }) {
  if (!fs.existsSync(spec_path)) {
    return { ok: false, error: `Sub-workflow spec not found: ${spec_path}` };
  }
  const { parseSpec } = require('../workflow-spec');
  const parsed = parseSpec(spec_path);
  if (!parsed.ok) {
    return { ok: false, error: `Sub-workflow spec invalid: ${parsed.errors.join('; ')}` };
  }
  const spec = parsed.spec;

  // Optionally interpolate params into task descriptions (simple {{ params.X }} replacement)
  for (const t of spec.tasks) {
    if (typeof t.task_description === 'string') {
      t.task_description = t.task_description.replace(/{{\s*params\.([\w_]+)\s*}}/g, (_, key) => params[key] ?? '');
    }
  }

  const createResult = workflowHandlers.handleCreateWorkflow({
    name: `${spec.name} (sub of ${parent_task_id?.slice(0, 8)})`,
    description: `Sub-workflow invoked by ${parent_task_id}`,
    working_directory: working_directory || spec.working_directory,
    project: spec.project,
    version_intent: spec.version_intent || 'internal',
    tasks: spec.tasks,
    // Pass parent_task_id in workflow context for traceability
  });

  if (createResult.isError) {
    return { ok: false, error: createResult.content?.[0]?.text || 'create_workflow failed' };
  }
  const workflowId = (createResult.content?.[0]?.text || '').match(/([a-f0-9-]{36})/)?.[1];

  // Mark parent linkage
  try {
    const db = require('../database');
    const wf = db.getWorkflow(workflowId);
    const ctx = wf.context || {};
    ctx.parent_task_id = parent_task_id;
    ctx.invoked_with_params = params;
    db.updateWorkflow(workflowId, { context: ctx });
  } catch (e) { logger.info(`[subworkflows] parent-link failed: ${e.message}`); }

  return { ok: true, workflow_id: workflowId };
}

module.exports = { invokeSubWorkflow };
```

Run tests → PASS. Commit: `feat(subworkflows): invoke a child workflow from a spec path`.

---

## Task 2: Register sub-workflow tools per parent workflow

- [ ] **Step 1: Register module**

Create `server/subworkflows/register.js`:

```js
'use strict';

// In-memory registry: workflow_id -> Map<tool_name, { spec_path, working_directory }>
const registry = new Map();

function registerForWorkflow(workflowId, subWorkflows, workingDirectory) {
  const tools = new Map();
  for (const [name, specPath] of Object.entries(subWorkflows || {})) {
    tools.set(`call_subworkflow_${name}`, { spec_path: specPath, working_directory: workingDirectory });
  }
  registry.set(workflowId, tools);
  return [...tools.keys()];
}

function unregisterForWorkflow(workflowId) {
  registry.delete(workflowId);
}

function lookupTool(workflowId, toolName) {
  return registry.get(workflowId)?.get(toolName) || null;
}

function listToolsForWorkflow(workflowId) {
  return [...(registry.get(workflowId)?.entries() || [])].map(([name, def]) => ({ name, ...def }));
}

module.exports = { registerForWorkflow, unregisterForWorkflow, lookupTool, listToolsForWorkflow };
```

- [ ] **Step 2: Wire into workflow start**

In `server/handlers/workflow/index.js` `startWorkflowExecution`, after the workflow record is loaded and tasks are about to start, if the workflow's context contains `sub_workflows`:

```js
if (workflow.context?.sub_workflows) {
  const { registerForWorkflow } = require('../../subworkflows/register');
  registerForWorkflow(workflow.id, workflow.context.sub_workflows, workflow.working_directory);
}
```

In `handleRunWorkflowSpec` (Plan 1), pass `sub_workflows` into workflow context.

In `server/execution/workflow-runtime.js` workflow-finalize site:

```js
const { unregisterForWorkflow } = require('../subworkflows/register');
unregisterForWorkflow(workflowId);
```

Commit: `feat(subworkflows): per-workflow tool registration with auto-cleanup`.

---

## Task 3: Expose as MCP tools (dynamic dispatch)

- [ ] **Step 1: MCP handler**

Create `server/handlers/subworkflow-handlers.js`:

```js
'use strict';
const { lookupTool } = require('../subworkflows/register');
const { invokeSubWorkflow } = require('../subworkflows/invoke');
const { ErrorCodes, makeError } = require('./shared');

/**
 * Dispatch a `call_subworkflow_*` tool call. The caller must supply
 * parent_workflow_id (the workflow context the agent is running inside)
 * and parent_task_id.
 */
async function handleCallSubWorkflow(args) {
  const { tool_name, parent_workflow_id, parent_task_id, params = {} } = args;
  const def = lookupTool(parent_workflow_id, tool_name);
  if (!def) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `No sub-workflow registered as ${tool_name} for workflow ${parent_workflow_id}`);
  }
  const result = await invokeSubWorkflow({
    spec_path: def.spec_path,
    working_directory: def.working_directory,
    parent_task_id,
    params,
  });
  if (!result.ok) return makeError(ErrorCodes.OPERATION_FAILED, result.error);
  return {
    content: [{ type: 'text', text: `Sub-workflow created: ${result.workflow_id}. Use await_workflow to wait for it.` }],
    structuredData: result,
  };
}

module.exports = { handleCallSubWorkflow };
```

In `server/tools.js`, dispatch any tool name starting with `call_subworkflow_` through this handler. Add a generic catch-all in the `handleToolCall` switch:

```js
default: {
  if (name.startsWith('call_subworkflow_')) {
    const { handleCallSubWorkflow } = require('./handlers/subworkflow-handlers');
    return handleCallSubWorkflow({ tool_name: name, ...args });
  }
  // ...existing default handling
}
```

- [ ] **Step 2: Commit**

`feat(subworkflows): dynamic MCP dispatch for call_subworkflow_*`.

---

## Task 4: Docs + restart + smoke

- [x] **Step 1: Docs**

Create `docs/subworkflows.md`:

````markdown
# Sub-Workflows as Callable Tools

A workflow spec can declare sub-workflows that become callable MCP tools inside parent tasks:

```yaml
version: 1
name: parent-pipeline
sub_workflows:
  run_lint: workflows/sub/lint.yaml
  run_security_scan: workflows/sub/security.yaml
tasks:
  - node_id: implement
    task: |
      Implement the feature. After making changes, call_subworkflow_run_lint
      to lint, then call_subworkflow_run_security_scan to scan.
    provider: claude-cli
```

The sub-workflows are registered as `call_subworkflow_run_lint` and `call_subworkflow_run_security_scan` for the duration of the parent workflow.

## Calling from a task

The agent inside `implement` calls these tools the same way it calls any MCP tool. The call returns `{ workflow_id }` — the parent agent can then use `await_workflow` to wait for the sub-workflow to finish.

## Parameters

Sub-workflow specs can use `{{ params.KEY }}` in task descriptions. Pass them at call time:

```
call_subworkflow_run_lint { params: { target_path: "src/" } }
```

## Isolation

Each sub-workflow runs as a separate workflow record with its own DAG, retries, and verify gates. The parent_task_id is stored in `workflow.context.parent_task_id` for traceability.

## Lifecycle

Sub-workflow tool registrations are cleaned up automatically when the parent workflow finalizes.
````

`await_restart`. Smoke: create a parent workflow that declares a sub-workflow and calls it. Confirm child workflow runs and parent_task_id is set on it.

Commit: `docs(subworkflows): callable sub-workflow guide`.
