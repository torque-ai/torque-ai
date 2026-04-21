# Structured Tool Outputs Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `outputSchema` + `structuredData` to 10 more tools (provider stats, cost tracking, monitoring) using the same pattern established in Phase 1.

**Architecture:** Same as Phase 1 — add schemas to `server/tool-output-schemas.js`, add `structuredData` to handler return statements. No new infrastructure needed.

**Tech Stack:** Node.js, Vitest, MCP protocol (JSON-RPC 2.0)

**Spec:** `docs/superpowers/specs/2026-03-21-structured-outputs-phase2-design.md`

**IMPORTANT:** Always push to origin/main before running tests. Use `torque-remote` for all test execution — never run vitest locally.

---

### Task 1: Add 10 Schemas to Registry

**Files:**
- Modify: `server/tool-output-schemas.js` — add 10 new schema entries
- Modify: `server/tests/tool-output-schemas.test.js` — update expected count

- [x] **Step 1: Add all 10 schemas to OUTPUT_SCHEMAS in `server/tool-output-schemas.js`**

Add the following entries to the OUTPUT_SCHEMAS object. Read the spec at `docs/superpowers/specs/2026-03-21-structured-outputs-phase2-design.md` for the exact JSON Schema definitions. The 10 tools are:

```js
  // ── Phase 2: Provider/Cost/Monitoring ──

  provider_stats: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      total_tasks: { type: 'number' },
      successful_tasks: { type: 'number' },
      failed_tasks: { type: 'number' },
      success_rate: { type: 'number' },
      total_tokens: { type: 'number' },
      total_cost: { type: 'number' },
      avg_duration_seconds: { type: 'number' },
      enabled: { type: 'boolean' },
      priority: { type: 'number' },
      max_concurrent: { type: 'number' },
    },
    required: ['provider'],
  },

  success_rates: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      rates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            group_key: { type: 'string' },
            total: { type: 'number' },
            successful: { type: 'number' },
            failed: { type: 'number' },
            success_rate: { type: 'number' },
          },
        },
      },
    },
    required: ['count', 'rates'],
  },

  list_providers: {
    type: 'object',
    properties: {
      default_provider: { type: 'string' },
      count: { type: 'number' },
      providers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            enabled: { type: 'boolean' },
            priority: { type: 'number' },
            max_concurrent: { type: 'number' },
          },
        },
      },
    },
    required: ['count', 'providers'],
  },

  check_ollama_health: {
    type: 'object',
    properties: {
      healthy_count: { type: 'number' },
      total_count: { type: 'number' },
      hosts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            url: { type: 'string' },
            status: { type: 'string' },
            running_tasks: { type: 'number' },
            models_count: { type: 'number' },
          },
        },
      },
    },
    required: ['healthy_count', 'total_count', 'hosts'],
  },

  get_cost_summary: {
    type: 'object',
    properties: {
      days: { type: 'number' },
      costs: { type: 'object' },
    },
    required: ['days'],
  },

  get_budget_status: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      budgets: { type: 'array' },
    },
    required: ['count', 'budgets'],
  },

  get_cost_forecast: {
    type: 'object',
    properties: {
      forecast: { type: 'object' },
    },
    required: ['forecast'],
  },

  get_concurrency_limits: {
    type: 'object',
    properties: {
      providers: { type: 'array' },
      hosts: { type: 'array' },
    },
    required: ['providers'],
  },

  check_stalled_tasks: {
    type: 'object',
    properties: {
      running_count: { type: 'number' },
      stalled_count: { type: 'number' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            elapsed_seconds: { type: 'number' },
            last_activity_seconds: { type: 'number' },
            is_stalled: { type: 'boolean' },
          },
        },
      },
    },
    required: ['running_count', 'stalled_count', 'tasks'],
  },

  check_task_progress: {
    type: 'object',
    properties: {
      running_count: { type: 'number' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            host: { type: 'string' },
            runtime_seconds: { type: 'number' },
            output_length: { type: 'number' },
            status: { type: 'string' },
          },
        },
      },
    },
    required: ['running_count', 'tasks'],
  },
```

- [x] **Step 2: Update the schema count test**

In `server/tests/tool-output-schemas.test.js`, update the "declares schemas for all expected tools" test to include the 10 new tools and expect count 19:

```js
    it('declares schemas for all expected tools', () => {
      const expected = [
        'check_status', 'task_info', 'list_tasks', 'get_result',
        'get_progress', 'workflow_status', 'list_workflows', 'list_ollama_hosts',
        'get_context',
        // Phase 2
        'provider_stats', 'success_rates', 'list_providers', 'check_ollama_health',
        'get_cost_summary', 'get_budget_status', 'get_cost_forecast',
        'get_concurrency_limits', 'check_stalled_tasks', 'check_task_progress',
      ];
      for (const name of expected) {
        expect(getOutputSchema(name)).toBeDefined();
      }
      expect(Object.keys(OUTPUT_SCHEMAS).length).toBe(expected.length);
    });
```

- [x] **Step 3: Commit and push**

```bash
git add server/tool-output-schemas.js server/tests/tool-output-schemas.test.js
git commit -m "feat: add 10 Phase 2 output schemas (provider/cost/monitoring)"
git push origin main
```

---

### Task 2: Add structuredData to Provider + Cost Handlers

**Files:**
- Modify: `server/handlers/provider-handlers.js` — handleProviderStats (~line 177), handleListProviders (~line 84)
- Modify: `server/handlers/provider-ollama-hosts.js` — handleCheckOllamaHealth (~line 141)
- Modify: `server/handlers/validation/index.js` — handleGetCostSummary (~line 837), handleGetBudgetStatus (~line 852), handleGetCostForecast (~line 889)
- Modify: `server/handlers/integration/index.js` — handleSuccessRates (~line 584)
- Modify: `server/handlers/concurrency-handlers.js` — handleGetConcurrencyLimits

For each handler, the pattern is the same:
1. Read the handler to understand what data variables are already computed
2. Add a `structuredData` field to the return object, built from those existing variables
3. Keep the existing `content` markdown untouched

**Special case:** `get_cost_summary`, `get_budget_status`, `get_cost_forecast` already return JSON in their text content. For these, just set `structuredData` to the same object that's being JSON.stringify'd:

```js
// Before:
return { content: [{ type: 'text', text: JSON.stringify({ days, costs }, null, 2) }] };

// After:
const data = { days, costs };
return {
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredData: data,
};
```

For the remaining handlers, build `structuredData` from existing variables following the schema field names. Use the spec's schema definitions to know which fields to include.

- [x] **Step 1: Modify all 8 handler files**

Read each handler, understand what variables are available, add `structuredData` to the return. Do NOT change the markdown `content` output.

- [x] **Step 2: Commit and push**

```bash
git add server/handlers/provider-handlers.js server/handlers/provider-ollama-hosts.js server/handlers/validation/index.js server/handlers/integration/index.js server/handlers/concurrency-handlers.js
git commit -m "feat: structuredData for 10 Phase 2 tools (provider/cost/monitoring)"
git push origin main
```

---

### Task 3: Conformance Tests + Verification

**Files:**
- Modify: `server/tests/tool-output-schemas.test.js` — add Phase 2 conformance tests

- [ ] **Step 1: Add conformance tests**

Add a new describe block `'handler conformance — Phase 2'` in the test file. For each of the 10 tools, add one test that:
1. Calls the handler with representative args
2. Verifies `result.structuredData` exists
3. Verifies the required fields from the schema are present
4. Verifies `result.content` still exists (backward compat)

The tests need the template DB buffer pattern (same as existing conformance tests in the file — use `db.resetForTest(templateBuffer)` in beforeAll).

For handlers that require specific args (like `provider_stats` needing a provider name), use sensible defaults or check the handler for what it does when given empty/default args.

- [ ] **Step 2: Commit and push**

```bash
git add server/tests/tool-output-schemas.test.js
git commit -m "test: Phase 2 conformance tests for 10 provider/cost/monitoring tools"
git push origin main
```

- [ ] **Step 3: Run all tests on remote**

```bash
torque-remote "cd server && npx vitest run tests/tool-output-schemas.test.js tests/tool-annotations.test.js tests/context-handler.test.js --reporter verbose"
```
Expected: All tests pass (annotations + Phase 1 + Phase 2 + context handler)

- [ ] **Step 4: Verify schema count**

```bash
cd server && node -e "
const { TOOLS } = require('./tools');
const withSchema = TOOLS.filter(t => t.outputSchema);
console.log('Tools with outputSchema:', withSchema.length);
for (const t of withSchema) {
  console.log('  -', t.name);
}
"
```
Expected: 19 tools listed
