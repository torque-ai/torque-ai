# Structured Tool Outputs Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `outputSchema` + `structuredData` to 10 more tools (workflow history, model registry, archives, health, tags, batch summary). Same pattern as Phase 1-2.

**Architecture:** Same as Phase 1-2 — add schemas to `server/tool-output-schemas.js`, add `structuredData` to handler returns. No new infrastructure.

**Tech Stack:** Node.js, Vitest, MCP protocol

**IMPORTANT:** Always push to origin/main before running tests. Use `torque-remote` for all test execution.

## Tools (10)

| Tool | Handler File | Data Type |
|------|-------------|-----------|
| `workflow_history` | `handlers/workflow/index.js:1311` | Event timeline array |
| `list_models` | `handlers/model-handlers.js:79` | Already JSON — model registry |
| `list_pending_models` | `handlers/model-handlers.js:18` | Already JSON — pending models |
| `list_archived` | `handlers/task/operations.js:1235` | Archived task list |
| `get_archive_stats` | `handlers/task/operations.js:1297` | Archive counts by status/reason |
| `get_provider_health_trends` | `handlers/provider-handlers.js:452` | Already JSON — trend data |
| `health_check` | `handlers/task/operations.js:229` | Health status + details |
| `get_integration_health` | `handlers/integration/index.js:148` | Integration status list |
| `list_tags` | `handlers/task/operations.js:81` | Tag usage counts |
| `get_batch_summary` | `handlers/automation-handlers.js:720` | Workflow completion report |

---

### Task 1: Add 10 Schemas to Registry

**Files:**
- Modify: `server/tool-output-schemas.js`
- Modify: `server/tests/tool-output-schemas.test.js`

- [ ] **Step 1: Add all 10 schemas to OUTPUT_SCHEMAS**

```js
  // ── Phase 3: Workflow History, Models, Archives, Health, Tags, Batch ──

  workflow_history: {
    type: 'object',
    properties: {
      workflow_id: { type: 'string' },
      count: { type: 'number' },
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            time: { type: 'string' },
            event: { type: 'string' },
            task_id: { type: 'string' },
            details: { type: 'string' },
          },
        },
      },
    },
    required: ['workflow_id', 'events'],
  },

  list_models: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      models: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            provider: { type: 'string' },
            model_name: { type: 'string' },
            host_id: { type: 'string' },
            status: { type: 'string' },
            size_bytes: { type: 'number' },
          },
        },
      },
    },
    required: ['count', 'models'],
  },

  list_pending_models: {
    type: 'object',
    properties: {
      pending_count: { type: 'number' },
      models: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            provider: { type: 'string' },
            model_name: { type: 'string' },
            host_id: { type: 'string' },
            size_bytes: { type: 'number' },
            first_seen_at: { type: 'string' },
          },
        },
      },
    },
    required: ['pending_count', 'models'],
  },

  list_archived: {
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
            description: { type: 'string' },
            archived_at: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
    required: ['count', 'tasks'],
  },

  get_archive_stats: {
    type: 'object',
    properties: {
      total_archived: { type: 'number' },
      by_status: { type: 'object' },
      by_reason: { type: 'object' },
    },
    required: ['total_archived'],
  },

  get_provider_health_trends: {
    type: 'object',
    properties: {
      trends: { type: 'array' },
    },
    required: ['trends'],
  },

  health_check: {
    type: 'object',
    properties: {
      check_type: { type: 'string' },
      status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
      response_time_ms: { type: 'number' },
      error_message: { type: 'string' },
      details: { type: 'object' },
    },
    required: ['status'],
  },

  get_integration_health: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      integrations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            status: { type: 'string' },
            latency_ms: { type: 'number' },
          },
        },
      },
    },
    required: ['count', 'integrations'],
  },

  list_tags: {
    type: 'object',
    properties: {
      total_unique: { type: 'number' },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            usage_count: { type: 'number' },
          },
        },
      },
    },
    required: ['total_unique', 'tags'],
  },

  get_batch_summary: {
    type: 'object',
    properties: {
      workflow_id: { type: 'string' },
      workflow_status: { type: 'string' },
      completed_tasks: { type: 'number' },
      failed_tasks: { type: 'number' },
      total_tasks: { type: 'number' },
      duration_seconds: { type: 'number' },
      files_added: { type: 'number' },
      files_modified: { type: 'number' },
      test_count: { type: 'number' },
    },
    required: ['workflow_id', 'workflow_status'],
  },
```

- [ ] **Step 2: Update schema count test**

Update the expected array in `server/tests/tool-output-schemas.test.js` to add the 10 new tools and assert `expected.length` (29 total).

- [ ] **Step 3: Commit and push**

```bash
git add server/tool-output-schemas.js server/tests/tool-output-schemas.test.js
git commit -m "feat: add 10 Phase 3 output schemas (history/models/archives/health/tags/batch)"
git push origin main
```

---

### Task 2: Add structuredData to All 10 Handlers

**Files:**
- Modify: `server/handlers/workflow/index.js` — handleWorkflowHistory
- Modify: `server/handlers/model-handlers.js` — handleListModels, handleListPendingModels
- Modify: `server/handlers/task/operations.js` — handleListArchived, handleGetArchiveStats, handleHealthCheck, handleListTags
- Modify: `server/handlers/provider-handlers.js` — handleGetProviderHealthTrends
- Modify: `server/handlers/integration/index.js` — handleGetIntegrationHealth
- Modify: `server/handlers/automation-handlers.js` — handleGetBatchSummary

**Pattern for each handler:**

For handlers already returning JSON (`list_models`, `list_pending_models`, `get_provider_health_trends`):
```js
// Extract data object, set as both JSON text and structuredData
const data = { count, models };
return {
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredData: data,
};
```

For handlers returning markdown, build structuredData from existing variables alongside the markdown construction. DO NOT change the markdown output.

**Key implementation notes per handler:**

- **workflow_history**: The handler builds a markdown table from workflow event data. Build `structuredData.events` array from the same data.
- **list_archived**: Handler iterates `archived` array building markdown table. Build `structuredData.tasks` from same array.
- **get_archive_stats**: Handler has `stats` object with totals and breakdowns. Extract into structuredData.
- **health_check**: Handler has `status`, `response_time_ms`, `error_message`, `details`. Set as structuredData directly.
- **get_integration_health**: Handler builds markdown table from integration checks. Build `structuredData.integrations` array.
- **list_tags**: Handler has tag array with counts. Build `structuredData.tags` from it.
- **get_batch_summary**: Handler has workflow status, task counts, git diff stats. Build structuredData from all of these.

- [ ] **Step 1: Read each handler, add structuredData to return statements**

- [ ] **Step 2: Commit and push**

```bash
git add server/handlers/workflow/index.js server/handlers/model-handlers.js server/handlers/task/operations.js server/handlers/provider-handlers.js server/handlers/integration/index.js server/handlers/automation-handlers.js
git commit -m "feat: structuredData for 10 Phase 3 tools (history/models/archives/health/tags/batch)"
git push origin main
```

---

### Task 3: Conformance Tests + Verification

**Files:**
- Modify: `server/tests/tool-output-schemas.test.js`

- [ ] **Step 1: Add Phase 3 conformance tests**

Add `describe('handler conformance — Phase 3', ...)` with one test per tool. Same pattern as Phase 2: call handler, verify `structuredData` exists with required fields, verify `content` exists.

For handlers needing specific args:
- `workflow_history` needs `{ workflow_id }` — create test workflow or use nonexistent (may return error)
- `get_batch_summary` needs `{ workflow_id }` — same approach
- Most others work with `{}` or have sensible defaults

Be pragmatic — if a handler returns error in test environment (no data), verify the shape of whatever it returns.

- [ ] **Step 2: Commit and push**

```bash
git add server/tests/tool-output-schemas.test.js
git commit -m "test: Phase 3 conformance tests for 10 history/models/archives/health/tags/batch tools"
git push origin main
```

- [ ] **Step 3: Run all tests on remote**

```bash
torque-remote "cd server && npx vitest run tests/tool-output-schemas.test.js tests/tool-annotations.test.js tests/context-handler.test.js --reporter verbose"
```
Expected: All pass

- [ ] **Step 4: Verify total schema count**

```bash
cd server && node -e "
const { TOOLS } = require('./tools');
const withSchema = TOOLS.filter(t => t.outputSchema);
console.log('Tools with outputSchema:', withSchema.length);
console.log('Tools with annotations:', TOOLS.filter(t => t.annotations).length);
console.log('Total tools:', TOOLS.length);
"
```
Expected: 29 tools with outputSchema, 553+ with annotations
