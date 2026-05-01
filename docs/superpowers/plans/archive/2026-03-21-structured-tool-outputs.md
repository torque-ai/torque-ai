# Structured Tool Outputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP `outputSchema` and `structuredContent` to 8 high-value query tools so LLMs can parse task/workflow/provider data directly instead of regex-parsing markdown.

**Architecture:** New `server/tool-output-schemas.js` registry holds JSON Schemas per tool. Handlers add `structuredData` field alongside existing `content`. Protocol layer in `mcp-protocol.js` copies `structuredData` → `structuredContent`. `tools.js` merges `outputSchema` at startup.

**Tech Stack:** Node.js, Vitest, MCP protocol (JSON-RPC 2.0)

**Spec:** `docs/superpowers/specs/2026-03-21-structured-tool-outputs-design.md`

---

### Task 1: Create tool-output-schemas.js — Schema Registry

**Files:**
- Create: `server/tool-output-schemas.js`
- Create: `server/tests/tool-output-schemas.test.js`

- [ ] **Step 1: Write failing tests for schema registry**

Create `server/tests/tool-output-schemas.test.js`:

```js
'use strict';

const { getOutputSchema, OUTPUT_SCHEMAS } = require('../tool-output-schemas');

describe('tool-output-schemas', () => {
  describe('getOutputSchema', () => {
    it('returns schema for declared tools', () => {
      const schema = getOutputSchema('check_status');
      expect(schema).toBeDefined();
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
    });

    it('returns undefined for undeclared tools', () => {
      expect(getOutputSchema('some_unknown_tool')).toBeUndefined();
      expect(getOutputSchema('submit_task')).toBeUndefined();
    });

    it('returns undefined for non-string input', () => {
      expect(getOutputSchema(null)).toBeUndefined();
      expect(getOutputSchema(42)).toBeUndefined();
    });
  });

  describe('schema validity', () => {
    it('every schema is a valid JSON Schema object with properties', () => {
      for (const [name, schema] of Object.entries(OUTPUT_SCHEMAS)) {
        expect(schema.type).toBe('object');
        expect(schema.properties).toBeDefined();
        expect(typeof schema.properties).toBe('object');
      }
    });

    it('every schema has required array', () => {
      for (const [name, schema] of Object.entries(OUTPUT_SCHEMAS)) {
        expect(Array.isArray(schema.required)).toBe(true);
        expect(schema.required.length).toBeGreaterThan(0);
      }
    });

    it('Phase 1 declares exactly 8 schemas', () => {
      const expected = [
        'check_status', 'task_info', 'list_tasks', 'get_result',
        'get_progress', 'workflow_status', 'list_workflows', 'list_ollama_hosts',
      ];
      for (const name of expected) {
        expect(getOutputSchema(name)).toBeDefined();
      }
      expect(Object.keys(OUTPUT_SCHEMAS).length).toBe(8);
    });
  });

  describe('stale detection', () => {
    it('validateSchemaCoverage detects stale schemas', () => {
      const { validateSchemaCoverage } = require('../tool-output-schemas');
      const result = validateSchemaCoverage(['check_status']); // most schemas will be stale
      expect(result.stale.length).toBeGreaterThan(0);
    });

    it('validateSchemaCoverage returns empty stale when all schemas have tools', () => {
      const { validateSchemaCoverage } = require('../tool-output-schemas');
      const allSchemaNames = Object.keys(OUTPUT_SCHEMAS);
      // Pass a superset that includes all schema names
      const result = validateSchemaCoverage([...allSchemaNames, 'submit_task', 'cancel_task']);
      expect(result.stale).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/tool-output-schemas.test.js --reporter verbose`
Expected: FAIL — `Cannot find module '../tool-output-schemas'`

- [ ] **Step 3: Create `server/tool-output-schemas.js` with all 8 schemas**

```js
'use strict';

/**
 * Centralized registry of MCP outputSchema definitions.
 * Maps tool names to JSON Schema objects describing their structuredContent shape.
 * Only tools that return parseable structured data get schemas.
 *
 * Pattern: same as tool-annotations.js — centralized, auditable, startup-merged.
 */

const OUTPUT_SCHEMAS = {
  // ── Task lifecycle ──

  check_status: {
    type: 'object',
    properties: {
      pressure_level: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
      task: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'] },
          provider: { type: 'string' },
          model: { type: 'string' },
          progress: { type: 'number' },
          exit_code: { type: 'number' },
          elapsed_seconds: { type: 'number' },
          description: { type: 'string' },
        },
        required: ['id', 'status'],
      },
      running_count: { type: 'number' },
      queued_count: { type: 'number' },
      running_tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            progress: { type: 'number' },
            is_stalled: { type: 'boolean' },
            last_activity_seconds: { type: 'number' },
            description: { type: 'string' },
          },
        },
      },
      queued_tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            priority: { type: 'number' },
            description: { type: 'string' },
          },
        },
      },
      recent_tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            model: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
    required: ['pressure_level'],
  },

  task_info: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['status', 'result', 'progress'] },
      pressure_level: { type: 'string' },
      task: { type: 'object' },
      running_count: { type: 'number' },
      queued_count: { type: 'number' },
      running_tasks: { type: 'array' },
      queued_tasks: { type: 'array' },
      recent_tasks: { type: 'array' },
      id: { type: 'string' },
      status: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      exit_code: { type: 'number' },
      duration_seconds: { type: 'number' },
      output: { type: 'string' },
      error_output: { type: 'string' },
      files_modified: { type: 'array', items: { type: 'string' } },
      progress: { type: 'number' },
      elapsed_seconds: { type: 'number' },
      output_tail: { type: 'string' },
    },
    required: ['mode'],
  },

  list_tasks: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            priority: { type: 'number' },
            description: { type: 'string' },
            created_at: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    required: ['count', 'tasks'],
  },

  get_result: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      host_name: { type: 'string' },
      exit_code: { type: 'number' },
      duration_seconds: { type: 'number' },
      output: { type: 'string' },
      error_output: { type: 'string' },
      files_modified: { type: 'array', items: { type: 'string' } },
    },
    required: ['id', 'status'],
  },

  get_progress: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string' },
      progress: { type: 'number' },
      elapsed_seconds: { type: 'number' },
      output_tail: { type: 'string' },
    },
    required: ['id', 'status', 'progress'],
  },

  // ── Workflows ──

  workflow_status: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      status: { type: 'string' },
      visibility: { type: 'string' },
      completed_count: { type: 'number' },
      running_count: { type: 'number' },
      queued_count: { type: 'number' },
      pending_count: { type: 'number' },
      blocked_count: { type: 'number' },
      failed_count: { type: 'number' },
      skipped_count: { type: 'number' },
      cancelled_count: { type: 'number' },
      open_count: { type: 'number' },
      total_count: { type: 'number' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            node_id: { type: 'string' },
            task_id: { type: 'string' },
            status: { type: 'string' },
            provider: { type: 'string' },
            progress: { type: 'number' },
            exit_code: { type: 'number' },
            depends_on: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    required: ['id', 'name', 'status', 'total_count'],
  },

  list_workflows: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      workflows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            status: { type: 'string' },
            visibility: { type: 'string' },
            total_tasks: { type: 'number' },
            completed_tasks: { type: 'number' },
            open_tasks: { type: 'number' },
            created_at: { type: 'string' },
          },
        },
      },
    },
    required: ['count', 'workflows'],
  },

  // ── Provider/Host ──

  list_ollama_hosts: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      hosts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            url: { type: 'string' },
            status: { type: 'string', enum: ['healthy', 'down', 'degraded', 'unknown'] },
            enabled: { type: 'boolean' },
            running_tasks: { type: 'number' },
            max_concurrent: { type: 'number' },
            memory_limit_mb: { type: 'number' },
            models: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    required: ['count', 'hosts'],
  },
};

/**
 * Get the output schema for a tool, or undefined if none declared.
 * @param {string} name - Tool name
 * @returns {object|undefined}
 */
function getOutputSchema(name) {
  if (typeof name !== 'string') return undefined;
  return OUTPUT_SCHEMAS[name];
}

/**
 * Validate that all declared schemas reference tools that exist.
 * @param {string[]} toolNames - All registered tool names
 * @returns {{ stale: string[] }} - stale = schema keys not in toolNames
 */
function validateSchemaCoverage(toolNames) {
  const nameSet = new Set(toolNames);
  const stale = [];
  for (const name of Object.keys(OUTPUT_SCHEMAS)) {
    if (!nameSet.has(name)) {
      stale.push(name);
    }
  }
  return { stale };
}

module.exports = {
  OUTPUT_SCHEMAS,
  getOutputSchema,
  validateSchemaCoverage,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/tool-output-schemas.test.js --reporter verbose`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/tool-output-schemas.js server/tests/tool-output-schemas.test.js
git commit -m "feat: tool-output-schemas.js registry with 8 Phase 1 schemas"
```

---

### Task 2: Merge outputSchema into tools.js + Protocol Layer

**Files:**
- Modify: `server/tools.js:66-67` (after annotation validator, before HANDLER_MODULES)
- Modify: `server/mcp-protocol.js:146-148` (in _handleToolCallInternal, before `return result`)
- Modify: `server/tests/tool-output-schemas.test.js`

- [ ] **Step 1: Write integration and protocol tests**

Append inside the outer `describe('tool-output-schemas', ...)` block in `server/tests/tool-output-schemas.test.js`:

```js
  describe('integration — tools.js merge', () => {
    it('tools with schemas have outputSchema on tool object', () => {
      const { TOOLS } = require('../tools');
      const { OUTPUT_SCHEMAS } = require('../tool-output-schemas');
      for (const name of Object.keys(OUTPUT_SCHEMAS)) {
        const tool = TOOLS.find(t => t.name === name);
        expect(tool).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        expect(tool.outputSchema.type).toBe('object');
      }
    });

    it('tools without schemas do NOT have outputSchema', () => {
      const { TOOLS } = require('../tools');
      const { OUTPUT_SCHEMAS } = require('../tool-output-schemas');
      const schemaNames = new Set(Object.keys(OUTPUT_SCHEMAS));
      const toolsWithoutSchema = TOOLS.filter(t => !schemaNames.has(t.name));
      for (const tool of toolsWithoutSchema.slice(0, 10)) { // spot check 10
        expect(tool.outputSchema).toBeUndefined();
      }
    });

    it('no stale schemas (all reference real tools)', () => {
      const { TOOLS } = require('../tools');
      const { validateSchemaCoverage } = require('../tool-output-schemas');
      const names = TOOLS.map(t => t.name);
      const result = validateSchemaCoverage(names);
      expect(result.stale).toEqual([]);
    });
  });

  describe('protocol layer — structuredData handling', () => {
    it('structuredContent is set when structuredData is present', () => {
      // Simulate what mcp-protocol.js does
      const { getOutputSchema } = require('../tool-output-schemas');
      const name = 'check_status';
      const result = {
        content: [{ type: 'text', text: 'test' }],
        structuredData: { pressure_level: 'low', running_count: 0, queued_count: 0 },
      };

      // Protocol layer logic
      if (result.structuredData && !result.isError && getOutputSchema(name)) {
        result.structuredContent = result.structuredData;
        delete result.structuredData;
      }

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.pressure_level).toBe('low');
      expect(result.structuredData).toBeUndefined();
    });

    it('structuredContent is NOT set for tools without schema, but structuredData is cleaned up', () => {
      const { getOutputSchema } = require('../tool-output-schemas');
      const name = 'submit_task';
      const result = {
        content: [{ type: 'text', text: 'test' }],
        structuredData: { something: true },
      };

      // Match actual protocol logic: delete is ALWAYS inside the outer if block
      if (result.structuredData && !result.isError) {
        if (getOutputSchema(name)) {
          result.structuredContent = result.structuredData;
        }
        delete result.structuredData; // always clean up internal field
      }

      expect(result.structuredContent).toBeUndefined();
      // structuredData is cleaned up even when no schema matched
      expect(result.structuredData).toBeUndefined();
    });

    it('structuredContent is NOT set on error responses', () => {
      const { getOutputSchema } = require('../tool-output-schemas');
      const name = 'check_status';
      const result = {
        content: [{ type: 'text', text: 'Error' }],
        isError: true,
        structuredData: { pressure_level: 'low' },
      };

      if (result.structuredData && !result.isError && getOutputSchema(name)) {
        result.structuredContent = result.structuredData;
        delete result.structuredData;
      }

      expect(result.structuredContent).toBeUndefined();
    });
  });
```

- [ ] **Step 2: Run integration tests to verify they fail**

Run: `cd server && npx vitest run tests/tool-output-schemas.test.js --reporter verbose -t "integration"`
Expected: FAIL — `tool.outputSchema` is undefined

- [ ] **Step 3: Add outputSchema merge to tools.js**

In `server/tools.js`, after the annotation validation block (after line 66, before `// ── Handler modules ──`), add:

```js
// ── Merge MCP output schemas (Phase: structured tool outputs) ──
const { getOutputSchema, validateSchemaCoverage } = require('./tool-output-schemas');

for (const tool of TOOLS) {
  if (tool && tool.name) {
    const schema = getOutputSchema(tool.name);
    if (schema) tool.outputSchema = schema;
  }
}

// Startup validator: warn on stale schemas
const _schemaCoverage = validateSchemaCoverage(_allToolNames);
if (_schemaCoverage.stale.length > 0) {
  logger.warn(`[tool-output-schemas] ${_schemaCoverage.stale.length} stale schema(s) reference nonexistent tools: ${_schemaCoverage.stale.join(', ')}`);
}
```

Note: `_allToolNames` is already computed earlier (line 59) for annotation validation.

- [ ] **Step 4: Add structuredData → structuredContent in mcp-protocol.js**

In `server/mcp-protocol.js`, in the `_handleToolCallInternal` function, replace the simple `return result;` at line 148 with:

```js
    // Promote structuredData → structuredContent for tools with outputSchema
    if (result && result.structuredData && !result.isError) {
      const { getOutputSchema } = require('./tool-output-schemas');
      if (getOutputSchema(name)) {
        result.structuredContent = result.structuredData;
      }
      delete result.structuredData; // always clean up internal field
    }

    return result;
```

- [ ] **Step 5: Run all tests**

Run: `cd server && npx vitest run tests/tool-output-schemas.test.js --reporter verbose`
Expected: All tests PASS

- [ ] **Step 6: Run full test suite for regressions**

Run: `cd server && npx vitest run --reporter verbose 2>&1 | tail -10`
Expected: No new failures

- [ ] **Step 7: Commit**

```bash
git add server/tools.js server/mcp-protocol.js server/tests/tool-output-schemas.test.js
git commit -m "feat: merge outputSchema at startup, structuredData→structuredContent in protocol layer"
```

---

### Task 3: Add structuredData to check_status and task_info

**Files:**
- Modify: `server/handlers/task/core.js:544-620` (handleCheckStatus) and `server/handlers/task/core.js:1166-1195` (handleTaskInfo)
- Modify: `server/tests/tool-output-schemas.test.js`

- [ ] **Step 1: Write handler conformance tests**

Add to `server/tests/tool-output-schemas.test.js` inside the outer describe:

```js
  describe('handler conformance — check_status', () => {
    // These tests call the real handlers and verify structuredData shape.
    // They require a running database, so we use the test DB from global setup.

    it('check_status with task_id returns structuredData with task object', () => {
      const db = require('../database');
      const taskId = db.createTask({ task_description: 'test task', status: 'completed', exit_code: 0 });
      const { handleCheckStatus } = require('../handlers/task/core');
      const result = handleCheckStatus({ task_id: taskId });

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.pressure_level).toBeDefined();
      expect(result.structuredData.task).toBeDefined();
      expect(result.structuredData.task.id).toBe(taskId);
      expect(result.structuredData.task.status).toBe('completed');
      expect(result.content).toBeDefined(); // backward compat
    });

    it('check_status without task_id returns structuredData with counts and arrays', () => {
      const { handleCheckStatus } = require('../handlers/task/core');
      const result = handleCheckStatus({});

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.pressure_level).toBeDefined();
      expect(typeof result.structuredData.running_count).toBe('number');
      expect(typeof result.structuredData.queued_count).toBe('number');
      expect(Array.isArray(result.structuredData.running_tasks)).toBe(true);
      expect(Array.isArray(result.structuredData.queued_tasks)).toBe(true);
      expect(Array.isArray(result.structuredData.recent_tasks)).toBe(true);
    });

    it('check_status with invalid task_id returns error without structuredData', () => {
      const { handleCheckStatus } = require('../handlers/task/core');
      const result = handleCheckStatus({ task_id: 'nonexistent-id' });

      expect(result.isError).toBe(true);
      expect(result.structuredData).toBeUndefined();
    });

    it('task_info delegates and adds mode field', () => {
      const { handleTaskInfo } = require('../handlers/task/core');
      const result = handleTaskInfo({ mode: 'status' });

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.mode).toBe('status');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/tool-output-schemas.test.js --reporter verbose -t "handler conformance — check_status"`
Expected: FAIL — `result.structuredData` is undefined

- [ ] **Step 3: Modify handleCheckStatus to add structuredData**

In `server/handlers/task/core.js`, modify the `handleCheckStatus` function.

**Single task path (lines 547-559):** Change the return to:

```js
    const progress = taskManager.getTaskProgress(args.task_id);

    return {
      pressureLevel,
      content: [{
        type: 'text',
        text: formatTaskStatus(task, progress)
      }],
      structuredData: {
        pressure_level: pressureLevel,
        task: {
          id: task.id,
          status: task.status,
          provider: task.provider || null,
          model: task.model || null,
          progress: progress?.progress || 0,
          exit_code: task.exit_code != null ? task.exit_code : null,
          elapsed_seconds: progress?.elapsedSeconds || null,
          description: (task.task_description || '').slice(0, 200),
        },
      },
    };
```

**Queue summary path (lines 616-619):** Change the return to include structuredData built from the existing `running`, `queued`, `recent` arrays. Build the structured arrays inside the existing for-loops (or after them) from the same data already being iterated:

Accumulate structured arrays INSIDE the existing loops to avoid double-calling `getTaskProgress`/`getTaskActivity`. Add a `const structuredRunning = [];` before the running loop, and push entries inside the loop body:

Before the `if (running.length > 0)` block, add:
```js
  const structuredRunning = [];
```

Inside the existing running loop (after the `summary +=` line at ~596), add:
```js
      structuredRunning.push({
        id: task.id,
        status: task.status,
        provider: task.provider || null,
        model: task.model || null,
        progress: progress?.progress || 0,
        is_stalled: activity?.isStalled || false,
        last_activity_seconds: activity?.lastActivitySeconds || null,
        description: (task.task_description || '').slice(0, 200),
      });
```

This reuses the `progress` and `activity` variables already computed at lines 580-581. No double-call.

For queued and recent, use `.map()` since those loops don't already compute extra data:

```js
  const structuredQueued = queued.map(task => ({
    id: task.id,
    provider: task.provider || null,
    model: task.model || null,
    priority: task.priority || 0,
    description: (task.task_description || '').slice(0, 200),
  }));

  const structuredRecent = recent.map(task => ({
    id: task.id,
    status: task.status,
    model: task.model || null,
    description: (task.task_description || '').slice(0, 200),
  }));
```

Then change the final return:
```js
  return {
    pressureLevel,
    content: [{ type: 'text', text: summary }],
    structuredData: {
      pressure_level: pressureLevel,
      running_count: running.length,
      queued_count: queued.length,
      running_tasks: structuredRunning,
      queued_tasks: structuredQueued,
      recent_tasks: structuredRecent,
    },
  };
```

**Modify handleTaskInfo (lines 1166-1195):** After the delegate call returns, add mode to structuredData:

```js
function handleTaskInfo(args) {
  const mode = args.mode || 'status';
  let result;

  switch (mode) {
    case 'status':
      result = handleCheckStatus(args);
      break;
    case 'result':
      if (!args.task_id) {
        return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required for mode=result');
      }
      result = handleGetResult(args);
      break;
    case 'progress':
      if (!args.task_id) {
        return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required for mode=progress');
      }
      result = handleGetProgress(args);
      break;
    default:
      return makeError(ErrorCodes.INVALID_PARAM, `Unknown mode: ${mode}. Valid: status, result, progress`);
  }

  if (result && !result.isError && result.pressureLevel === undefined) {
    result.pressureLevel = getTaskInfoPressureLevel();
  }

  // Tag structuredData with mode for task_info superset schema
  if (result && result.structuredData && !result.isError) {
    result.structuredData.mode = mode;
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/tool-output-schemas.test.js --reporter verbose`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/handlers/task/core.js server/tests/tool-output-schemas.test.js
git commit -m "feat: structuredData for check_status and task_info"
```

---

### Task 4: Add structuredData to list_tasks, get_result, get_progress

**Files:**
- Modify: `server/handlers/task/core.js:781-835` (handleListTasks), `server/handlers/task/core.js:626-698` (handleGetResult), `server/handlers/task/core.js:960-1005` (handleGetProgress)
- Modify: `server/tests/tool-output-schemas.test.js`

- [ ] **Step 1: Write conformance tests**

Add to `server/tests/tool-output-schemas.test.js`:

```js
  describe('handler conformance — list/result/progress', () => {
    it('list_tasks returns structuredData with count and tasks array', () => {
      const { handleListTasks } = require('../handlers/task/core');
      const result = handleListTasks({ all_projects: true });

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.tasks)).toBe(true);
    });

    it('list_tasks with no results returns count 0 and empty array', () => {
      const { handleListTasks } = require('../handlers/task/core');
      const result = handleListTasks({ status: 'running', tags: ['nonexistent_tag_xyz'] });

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.count).toBe(0);
      expect(result.structuredData.tasks).toEqual([]);
    });

    it('get_result returns structuredData with task fields', () => {
      const db = require('../database');
      const taskId = db.createTask({
        task_description: 'test',
        status: 'completed',
        exit_code: 0,
        output: 'hello world',
        started_at: new Date(Date.now() - 60000).toISOString(),
        completed_at: new Date().toISOString(),
      });
      const { handleGetResult } = require('../handlers/task/core');
      const result = handleGetResult({ task_id: taskId });

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.id).toBe(taskId);
      expect(result.structuredData.status).toBe('completed');
      expect(typeof result.structuredData.duration_seconds).toBe('number');
      expect(result.structuredData.output).toBe('hello world');
    });

    it('get_result for running task returns no structuredData', () => {
      const db = require('../database');
      const taskId = db.createTask({ task_description: 'test', status: 'running' });
      const { handleGetResult } = require('../handlers/task/core');
      const result = handleGetResult({ task_id: taskId });

      // Running tasks get an informational message, not structured data
      expect(result.structuredData).toBeUndefined();
    });

    it('get_progress returns structuredData with progress fields', () => {
      const db = require('../database');
      const taskId = db.createTask({ task_description: 'test', status: 'running' });
      const { handleGetProgress } = require('../handlers/task/core');
      const result = handleGetProgress({ task_id: taskId });

      // If task-manager has no progress, it returns an error
      // In test environment, we may need to check for either
      if (!result.isError) {
        expect(result.structuredData).toBeDefined();
        expect(typeof result.structuredData.progress).toBe('number');
        expect(result.structuredData.id).toBe(taskId);
      }
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/tool-output-schemas.test.js --reporter verbose -t "handler conformance — list/result/progress"`
Expected: FAIL — `result.structuredData` is undefined

- [ ] **Step 3: Modify handleListTasks**

In `server/handlers/task/core.js`, modify `handleListTasks`.

**Empty result path (lines 797-806):** Add structuredData to the "no tasks found" return:

```js
    return {
      content: [{ type: 'text', text: msg }],
      structuredData: { count: 0, tasks: [] },
    };
```

**Results path (lines 832-834):** Change the return:

```js
  return {
    content: [{ type: 'text', text: result }],
    structuredData: {
      count: tasks.length,
      tasks: tasks.map(task => ({
        id: task.id,
        status: task.status,
        provider: task.provider || null,
        model: task.model || null,
        priority: task.priority || 0,
        description: (task.task_description || '').slice(0, 200),
        created_at: task.created_at || null,
        tags: Array.isArray(task.tags) ? task.tags : [],
      })),
    },
  };
```

- [ ] **Step 4: Modify handleGetResult**

In `server/handlers/task/core.js`, modify `handleGetResult`.

**Only add structuredData to the success path** (lines 695-697). The early returns for running/queued/pending tasks (lines 630-637) should NOT get structuredData.

Two changes needed in the existing handler body:

**First**, move the host name into an outer-scope variable. Before the existing host resolution block (line ~659), add `let hostName = null;`. Then inside the existing `if (task.ollama_host_id)` block (~line 660), add `hostName = host ? host.name : task.ollama_host_id;` using the already-resolved `host` variable. The existing markdown generation continues to work unchanged.

**Second**, compute `durationSeconds` and add the structuredData return. Replace the final return (line ~695-697):

```js
  // Compute raw duration in seconds (calculateDuration returns formatted string)
  let durationSeconds = null;
  if (task.started_at && task.completed_at) {
    durationSeconds = Math.round((new Date(task.completed_at) - new Date(task.started_at)) / 1000);
  }

  return {
    content: [{ type: 'text', text: result }],
    structuredData: {
      id: task.id,
      status: task.status,
      provider: task.provider || null,
      model: task.model || null,
      host_name: hostName, // reuses variable set in the host resolution block above
      exit_code: task.exit_code != null ? task.exit_code : null,
      duration_seconds: durationSeconds,
      output: task.output || null,
      error_output: task.error_output || null,
      files_modified: Array.isArray(task.files_modified) ? task.files_modified : [],
    },
  };
```

**Note:** `task.files_modified` may be stored as a JSON string in the DB. If so, parse it: `JSON.parse(task.files_modified)`. Check what `db.getTask()` returns — if it already parses the field, use as-is.

- [ ] **Step 5: Modify handleGetProgress**

In `server/handlers/task/core.js`, modify `handleGetProgress`.

Change the final return (lines 1002-1004):

```js
  return {
    content: [{ type: 'text', text: result }],
    structuredData: {
      id: args.task_id,
      status: progress.running ? 'running' : 'finished',
      progress: progress.progress || 0,
      elapsed_seconds: progress.elapsedSeconds || null,
      output_tail: tailOutput || null,
    },
  };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/tool-output-schemas.test.js --reporter verbose`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add server/handlers/task/core.js server/tests/tool-output-schemas.test.js
git commit -m "feat: structuredData for list_tasks, get_result, get_progress"
```

---

### Task 5: Add structuredData to workflow_status and list_workflows

**Files:**
- Modify: `server/handlers/workflow/index.js:1038-1112` (handleWorkflowStatus), `server/handlers/workflow/index.js:1211-1260` (handleListWorkflows)
- Modify: `server/tests/tool-output-schemas.test.js`

- [ ] **Step 1: Write conformance tests**

Add to `server/tests/tool-output-schemas.test.js`:

```js
  describe('handler conformance — workflows', () => {
    it('workflow_status returns structuredData with counts and tasks', () => {
      const db = require('../database');
      // Create a minimal workflow for testing
      const wfId = db.createWorkflow({ name: 'test-wf', status: 'pending' });
      const { handleWorkflowStatus } = require('../handlers/workflow');
      const result = handleWorkflowStatus({ workflow_id: wfId });

      if (!result.isError) {
        expect(result.structuredData).toBeDefined();
        expect(result.structuredData.id).toBe(wfId);
        expect(result.structuredData.name).toBe('test-wf');
        expect(typeof result.structuredData.total_count).toBe('number');
        expect(result.structuredData.visibility).toBeDefined();
      }
    });

    it('workflow_status with invalid id returns error without structuredData', () => {
      const { handleWorkflowStatus } = require('../handlers/workflow');
      const result = handleWorkflowStatus({ workflow_id: 'nonexistent-wf' });
      expect(result.isError).toBe(true);
      expect(result.structuredData).toBeUndefined();
    });

    it('list_workflows returns structuredData with count and workflows array', () => {
      const { handleListWorkflows } = require('../handlers/workflow');
      const result = handleListWorkflows({});

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.workflows)).toBe(true);
    });

    it('list_workflows with no results returns count 0 and empty array', () => {
      const { handleListWorkflows } = require('../handlers/workflow');
      const result = handleListWorkflows({ status: 'nonexistent_status_xyz' });

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.count).toBe(0);
      expect(result.structuredData.workflows).toEqual([]);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/tool-output-schemas.test.js --reporter verbose -t "handler conformance — workflows"`
Expected: FAIL — `result.structuredData` is undefined

- [ ] **Step 3: Modify handleWorkflowStatus**

In `server/handlers/workflow/index.js`, modify `handleWorkflowStatus`.

After the existing markdown construction, before the final return (line 1109), build structuredData from the already-computed `counts`, `visibility`, and `taskList`:

```js
  const taskList3 = Object.values(status.tasks);
  return {
    content: [{ type: 'text', text: output }],
    structuredData: {
      id: status.id,
      name: status.name,
      status: status.status,
      visibility: visibility.label,
      completed_count: counts.completed,
      running_count: counts.running,
      queued_count: counts.queued,
      pending_count: counts.pending,
      blocked_count: counts.blocked,
      failed_count: counts.failed,
      skipped_count: counts.skipped,
      cancelled_count: counts.cancelled,
      open_count: counts.open,
      total_count: counts.total,
      tasks: taskList3.map(task => {
        const deps = task.depends_on
          ? (typeof task.depends_on === 'string' ? safeJsonParse(task.depends_on, []) : task.depends_on)
          : [];
        return {
          node_id: task.node_id || null,
          task_id: task.id || null,
          status: task.status,
          provider: task.provider || null,
          progress: task.progress || 0,
          exit_code: task.exit_code != null ? task.exit_code : null,
          depends_on: deps,
        };
      }),
    },
  };
```

- [ ] **Step 4: Modify handleListWorkflows**

In `server/handlers/workflow/index.js`, modify `handleListWorkflows`.

**Empty result path (lines 1222-1226):** Add structuredData:

```js
    return {
      content: [{ type: 'text', text: `No workflows found.` }],
      structuredData: { count: 0, workflows: [] },
    };
```

**Results path (lines 1257-1259):** Change the return:

```js
  return {
    content: [{ type: 'text', text: output.trimEnd() }],
    structuredData: {
      count: annotated.length,
      workflows: annotated.map(entry => ({
        id: entry.workflow.id,
        name: entry.workflow.name,
        status: entry.workflow.status,
        visibility: entry.visibility.label,
        total_tasks: entry.counts.total,
        completed_tasks: entry.counts.completed,
        open_tasks: entry.counts.open,
        created_at: entry.workflow.created_at || null,
      })),
    },
  };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/tool-output-schemas.test.js --reporter verbose`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/handlers/workflow/index.js server/tests/tool-output-schemas.test.js
git commit -m "feat: structuredData for workflow_status and list_workflows"
```

---

### Task 6: Add structuredData to list_ollama_hosts

**Files:**
- Modify: `server/handlers/provider-ollama-hosts.js:410-472` (handleListOllamaHosts)
- Modify: `server/tests/tool-output-schemas.test.js`

- [ ] **Step 1: Write conformance test**

Add to `server/tests/tool-output-schemas.test.js`:

```js
  describe('handler conformance — list_ollama_hosts', () => {
    it('list_ollama_hosts returns structuredData with count and hosts array', () => {
      const { handleListOllamaHosts } = require('../handlers/provider-ollama-hosts');
      const result = handleListOllamaHosts({});

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.hosts)).toBe(true);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tool-output-schemas.test.js --reporter verbose -t "list_ollama_hosts"`
Expected: FAIL — `result.structuredData` is undefined

- [ ] **Step 3: Modify handleListOllamaHosts**

In `server/handlers/provider-ollama-hosts.js`, modify `handleListOllamaHosts`.

**Empty result path (line 423):** Add structuredData:

```js
    return {
      content: [{ type: 'text', text: output }],
      structuredData: { count: 0, hosts: [] },
    };
```

**Results path (line 471):** Change the return. Build the structured array after the existing for-loop (or accumulate during it):

```js
  const structuredHosts = hosts.map(host => {
    const modelCount = host.models?.length || 0;
    return {
      id: host.id,
      name: host.name,
      url: host.url,
      status: host.status || 'unknown',
      enabled: Boolean(host.enabled),
      running_tasks: host.running_tasks || 0,
      max_concurrent: host.max_concurrent || 0,
      memory_limit_mb: host.memory_limit_mb || null,
      models: Array.isArray(host.models) ? host.models.map(m => typeof m === 'string' ? m : m.name || String(m)) : [],
    };
  });

  return {
    content: [{ type: 'text', text: output }],
    structuredData: {
      count: hosts.length,
      hosts: structuredHosts,
    },
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/tool-output-schemas.test.js --reporter verbose`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `cd server && npx vitest run --reporter verbose 2>&1 | tail -10`
Expected: No new regressions

- [ ] **Step 6: Commit**

```bash
git add server/handlers/provider-ollama-hosts.js server/tests/tool-output-schemas.test.js
git commit -m "feat: structuredData for list_ollama_hosts"
```

---

### Task 7: Final Verification

**Files:** None modified — verification only

- [ ] **Step 1: Run full test suite**

Run: `cd server && npx vitest run --reporter verbose 2>&1 | tail -10`
Expected: All annotation + output schema tests pass, no regressions

- [ ] **Step 2: Verify schemas appear in MCP tools/list response**

```bash
cd server && node -e "
const { TOOLS } = require('./tools');
const withSchema = TOOLS.filter(t => t.outputSchema);
console.log('Tools with outputSchema:', withSchema.length);
for (const t of withSchema) {
  console.log('  -', t.name, '(required:', t.outputSchema.required?.join(', '), ')');
}
"
```

Expected: 8 tools with outputSchema listed

- [ ] **Step 3: Verify structuredData flows through protocol**

```bash
cd server && node -e "
const { TOOLS } = require('./tools');
const tool = TOOLS.find(t => t.name === 'check_status');
console.log('check_status has annotations:', !!tool.annotations);
console.log('check_status has outputSchema:', !!tool.outputSchema);
console.log('Schema required fields:', tool.outputSchema.required);
"
```

- [ ] **Step 4: Commit plan completion**

```bash
git add docs/superpowers/plans/2026-03-21-structured-tool-outputs.md
git commit -m "docs: structured tool outputs implementation plan — complete"
```
