# Dynamic Model Registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all 845 hardcoded model name references so users can swap local LLMs without code changes.

**Architecture:** Extend the existing model_registry table with a model_roles table mapping roles (default, fallback, fast, balanced, quality) to models per provider. Add getModelForRole(provider, role) as the single lookup function. Replace every hardcoded model string in production code with a role-based lookup. Routing decisions check model capabilities (from model_capabilities table) instead of name-matching.

**Tech Stack:** Node.js, better-sqlite3, vitest

**Test command:** `torque-remote "cd C:/Users/<user>/Projects/torque-public/server && npx vitest run tests/<file>"`

**Important context (2026-03-22):**
- The codebase now uses a **DI container** (`server/container.js`) with 130+ registered services. New modules MUST export a `createXxx(deps)` factory and register in the container. Do NOT use `require('./database')` in new code.
- **aider-ollama was removed** — skip any references to it.
- Several files were **split by the OSS session**: `smart-routing.js` from provider-routing-core, `task-startup.js` from task-manager. Check these files too.
- Tests should use `server/tests/test-container.js` for DI-based isolation.
- Run `npm run lint:di` after changes to verify DI compliance.

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `server/db/model-roles.js` | Role-based model lookup and assignment | Create (with `createModelRoles` factory) |
| `server/container.js` | Register modelRoles service | Modify |
| `server/db/schema-migrations.js` | Add model_roles table | Modify |
| `server/handlers/model-registry-handlers.js` | MCP tool handlers for configure_model_roles | Modify |
| `server/tool-defs/model-defs.js` | MCP tool definition for configure_model_roles | Modify |
| `server/constants.js` | Remove DEFAULT_FALLBACK_MODEL hardcoded string | Modify |
| `server/providers/execution.js` | Replace hardcoded fallback with role lookup | Modify |
| `server/execution/queue-scheduler.js` | Replace hardcoded tier models with role lookup | Modify |
| `server/execution/fallback-retry.js` | Replace hardcoded model escalation with role lookup | Modify |
| `server/execution/strategic-hooks.js` | Replace DEFAULT_MODEL with role lookup | Modify |
| `server/handlers/integration/routing.js` | Replace model name checks with capability lookups | Modify |
| `server/db/provider-routing-core.js` | Replace hardcoded model in greenfield gate | Modify |
| `server/tests/model-roles.test.js` | Unit tests for model-roles.js (use test-container.js) | Create |
| `server/tests/test-helpers.js` | Add TEST_MODEL constant for test fixtures | Modify |

---

## Phase 1: Model Roles Infrastructure

### Task 1: Add model_roles table and create model-roles.js

**Files:**
- Create: `server/db/model-roles.js`
- Modify: `server/db/schema-migrations.js`
- Test: `server/tests/model-roles.test.js`

- [ ] **Step 1: Write failing tests for model role operations**

Tests should cover: getModelForRole returns null when empty, setModelRole assigns correctly, setModelRole replaces existing, getModelForRole falls back through role hierarchy (fast -> default -> null), listModelRoles returns all assignments, clearModelRole removes assignments, roles resolve independently per provider.

- [ ] **Step 2: Run tests — expect FAIL (module does not exist)**

- [ ] **Step 3: Add schema migration for model_roles table**

In `server/db/schema-migrations.js`, add a `model_roles` table with columns: provider TEXT NOT NULL, role TEXT NOT NULL, model_name TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (provider, role).

- [ ] **Step 4: Implement model-roles.js**

Core functions:
- `getModelForRole(provider, role)` — looks up model by provider+role, falls through a chain (fast->default, quality->default, etc.)
- `setModelRole(provider, role, modelName)` — INSERT OR REPLACE
- `clearModelRole(provider, role)` — DELETE
- `listModelRoles(provider)` — list all roles, optionally filtered by provider
- `VALID_ROLES` constant: default, fallback, fast, balanced, quality
- `ROLE_FALLBACK_CHAIN` map: fast->[fast,default], quality->[quality,default], etc.
- Export `createModelRoles(deps)` factory for DI container
- `deps.db` is the better-sqlite3 instance

- [ ] **Step 5: Register in container.js**

In `server/container.js`, add registration alongside other db modules:
```js
_defaultContainer.register('modelRoles', ['db'], (deps) => {
  const { createModelRoles } = require('./db/model-roles');
  return createModelRoles(deps);
});
```

- [ ] **Step 6: Run tests — expect PASS**

Use `test-container.js` helper for test isolation:
```js
import { createTestDb } from './test-container.js';
```

- [ ] **Step 7: Commit**

---

### Task 2: Add configure_model_roles MCP tool

**Files:**
- Modify: `server/tool-defs/model-defs.js`
- Modify: handler file for model registry (find via grep for handleApproveModel)

- [ ] **Step 1: Add tool definitions for configure_model_roles and list_model_roles**

configure_model_roles takes provider, role (enum of valid roles), and model_name. list_model_roles takes optional provider filter.

- [ ] **Step 2: Add handler implementations**

handleConfigureModelRoles calls modelRoles.setModelRole. handleListModelRoles calls modelRoles.listModelRoles and formats as a table.

- [ ] **Step 3: Register handlers in tools.js**

- [ ] **Step 4: Test via MCP call**

- [ ] **Step 5: Commit**

---

### Task 3: Seed default roles on server startup

**Files:**
- Modify: `server/db/schema-seeds.js` or server startup path

- [ ] **Step 1: Add seed logic — if no roles exist for ollama, seed from existing config**

Read serverConfig ollama_model first, fall back to 'qwen3-coder:30b'. Seed both 'default' and 'fallback' roles. Only seed when no roles exist (fresh install).

- [ ] **Step 2: Test — fresh DB gets seeded roles, existing DB keeps user config**

- [ ] **Step 3: Commit**

---

## Phase 2: Replace Hardcoded References in Production Code

### Task 4: Replace constants.js and execution.js fallbacks

**Files:**
- Modify: `server/constants.js:163`
- Modify: `server/providers/execution.js:501`
- Modify: `server/execution/strategic-hooks.js:10`

- [ ] **Step 1: Update DEFAULT_FALLBACK_MODEL in constants.js to qwen3-coder:30b (immediate value fix)**

Note: Cannot make this fully dynamic at require-time since it is used as a constant. Update the value now; Task 8 will replace usages with function calls.

- [ ] **Step 2: In execution.js, replace hardcoded fallback with role lookup**

Use the DI container pattern. If the module already receives deps via init(), add modelRoles to its deps. Otherwise use lazy container access:
```js
if (!resolvedModel) {
  const { defaultContainer } = require('../container');
  const modelRoles = defaultContainer.get('modelRoles');
  resolvedModel = modelRoles.getModelForRole(provider, 'default') || 'qwen3-coder:30b';
}
```

- [ ] **Step 3: In strategic-hooks.js, replace DEFAULT_MODEL with role lookup function**

Same DI pattern. The 'qwen3-coder:30b' literal here is ONLY a bootstrap fallback for before the container is ready — not the configured default.

- [ ] **Step 4: Run affected tests**

- [ ] **Step 5: Commit**

---

### Task 5: Replace queue-scheduler.js tier model lookups

**Files:**
- Modify: `server/execution/queue-scheduler.js:554,802`

- [ ] **Step 1: Replace hardcoded tier model lookups with role-based resolution**

Lookup chain: serverConfig tier override -> modelRoles.getModelForRole(provider, tierName) -> modelRoles.getModelForRole(provider, 'default') -> 'qwen3-coder:30b'

- [ ] **Step 2: Run queue-scheduler tests**

- [ ] **Step 3: Commit**

---

### Task 6: Replace fallback-retry.js model escalation

**Files:**
- Modify: `server/execution/fallback-retry.js:384`

- [ ] **Step 1: Replace hardcoded model with role lookup**

```js
const currentModel = task.model || modelRoles.getModelForRole(task.provider || 'ollama', 'default') || 'qwen3-coder:30b';
```

- [ ] **Step 2: Review model escalation chain functions (lines 504-570) — use capabilities where possible**

- [ ] **Step 3: Run fallback-retry tests**

- [ ] **Step 4: Commit**

---

### Task 7: Replace integration/routing.js model name checks with capability lookups

**Files:**
- Modify: `server/handlers/integration/routing.js` (16 references)
- Modify: `server/db/schema-migrations.js` (add capability columns)
- Modify: `server/db/model-capabilities.js`

This is the most complex task. routing.js makes decisions based on model names (e.g., "codestral destroys files >50 lines", "qwen2.5-coder:32b safe up to 233 lines").

- [ ] **Step 1: Add capability columns to model_capabilities table**

Add migration: can_create_files INTEGER DEFAULT 1, can_edit_safely INTEGER DEFAULT 1, max_safe_edit_lines INTEGER DEFAULT 250, is_agentic INTEGER DEFAULT 0

- [ ] **Step 2: Seed capabilities for qwen3-coder:30b**

```js
upsertModelCapabilities('qwen3-coder:30b', {
  can_create_files: 1, can_edit_safely: 1,
  max_safe_edit_lines: 500, is_agentic: 1,
  context_window: 16384, param_size_b: 30,
});
```

- [ ] **Step 3: Replace name checks in routing.js with capability lookups**

Instead of `if (model === 'codestral:22b') skip`, use:
```js
const caps = modelCaps.getModelCapabilities(taskModel);
if (caps && fileLineCount > (caps.max_safe_edit_lines || 250)) { /* route to codex */ }
```

- [ ] **Step 4: Remove all 16 hardcoded model name references in routing.js**

- [ ] **Step 5: Run integration-routing tests**

- [ ] **Step 6: Commit**

---

## Phase 3: Update Tests

### Task 8: Create shared test model constant and bulk-replace test references

**Files:**
- Modify: `server/tests/test-helpers.js`
- Modify: ~94 test files

- [ ] **Step 1: Add TEST_MODELS constant to test-helpers.js**

```js
const TEST_MODELS = {
  DEFAULT: 'qwen3-coder:30b',
  FALLBACK: 'qwen3-coder:30b',
  LEGACY: 'qwen2.5-coder:32b',
  SMALL: 'qwen3-coder:7b',
};
```

- [ ] **Step 2: Bulk-replace hardcoded model strings in test files**

Replace 'qwen2.5-coder:32b' with TEST_MODELS.DEFAULT and 'codestral:22b' with TEST_MODELS.FALLBACK. For files with 1-2 refs: inline string replacement. For files with 10+ refs: import TEST_MODELS.

This is mechanical work — dispatch as parallel agent work.

Note: 142 test files still import database.js for core functions (resetForTest, getDbInstance) — this is acceptable per OSS session guidance. Only new test setup code should use test-container.js.

Also remove any remaining references to aider-ollama in test fixtures.

- [ ] **Step 3: Run full test suite**

- [ ] **Step 4: Commit**

---

## Summary

| Phase | Tasks | Files | Impact |
|-------|-------|-------|--------|
| 1: Infrastructure | 1-3 | 5 new/modified | model_roles table, getModelForRole, MCP tool, seeding |
| 2: Production code | 4-7 | 8 modified | All hardcoded models in routing/scheduling/fallback replaced |
| 3: Tests | 8 | ~94 modified | All hardcoded test models replaced with shared constant |

**After this plan, swapping a local LLM is one command:**
```
configure_model_roles { provider: "ollama", role: "default", model_name: "new-model:30b" }
```
**Instead of grep-and-replace across 110 files.**
