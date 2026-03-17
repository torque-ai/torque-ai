# Dynamic Model & Provider Management Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-discover models across all provider types, require user approval before routing, enable full provider CRUD, and auto-recover when models/providers disappear.

**Architecture:** A `model_registry` table tracks every model across every provider with approval status. Health checks feed discoveries into the registry. Routing queries the registry for approved models instead of static config defaults. Provider CRUD tools enable adding custom endpoints. MCP notifications and dashboard UI surface pending models for approval.

**Tech Stack:** Node.js, SQLite (better-sqlite3), React, Vitest

**Spec:** `docs/superpowers/specs/2026-03-17-dynamic-model-provider-management.md`

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `server/models/registry.js` | Model registry CRUD, discovery intake, approval, best-model selection |
| `server/handlers/model-handlers.js` | MCP tool handlers: approve, deny, list pending, bulk approve |
| `server/tool-defs/model-defs.js` | Tool definitions for model management |
| `server/handlers/provider-crud-handlers.js` | MCP handlers: add_provider, remove_provider |
| `server/tool-defs/provider-crud-defs.js` | Tool definitions for provider CRUD |
| `server/tests/model-registry.test.js` | Unit and integration tests for model registry |
| `server/tests/provider-crud.test.js` | Unit and integration tests for provider CRUD |

### Modified files
| File | Changes |
|------|---------|
| `server/db/schema-migrations.js` | Create `model_registry` table, add columns to `provider_config` |
| `server/db/schema-seeds.js` | Backfill `provider_type` for existing 13 providers |
| `server/utils/host-monitoring.js` | Feed discovered models into registry during health check |
| `server/execution/queue-scheduler.js` | Use registry for model selection and auto-recovery |
| `server/providers/aider-command.js` | Use registry instead of static default |
| `server/providers/execute-hashline.js` | Same |
| `server/providers/execute-ollama.js` | Same |
| `server/mcp-sse.js` | Push model_discovered and model_removed notifications |
| `server/tools.js` | Register new tools and handlers |
| `server/api/routes.js` | v2 routes for model and provider CRUD |
| `server/api/v2-dispatch.js` | Handler wrappers for dashboard |
| `dashboard/src/views/Hosts.jsx` | Pending models panel with approve/deny |
| `dashboard/src/views/Providers.jsx` | Add/remove provider, model counts |
| `dashboard/src/api.js` | Model and provider CRUD API client |

---

## Chunk 1: Schema and Model Registry Module

### Task 1: Schema Migration

**Files:**
- Modify: `server/db/schema-migrations.js`
- Modify: `server/db/schema-seeds.js`

- [ ] **Step 1: Add model_registry table and provider_config columns to schema-migrations.js**

At the end of `runMigrations()`, add the CREATE TABLE for model_registry with columns: id (PK), provider, host_id, model_name, size_bytes, status (default pending), first_seen_at, last_seen_at, approved_at, approved_by. Add UNIQUE constraint on (provider, host_id, model_name). Add indexes on status and provider.

Then add safeAddColumn calls for provider_config: api_base_url TEXT, api_key_env_var TEXT, api_key_encrypted TEXT, provider_type TEXT, model_discovery TEXT, default_model TEXT.

- [ ] **Step 2: Backfill provider_type in schema-seeds.js**

After existing provider INSERT statements, add UPDATE statements to set provider_type for all 13 providers: codex and claude-cli get cloud-cli, ollama/hashline-ollama/aider-ollama get ollama, the rest get cloud-api. Only update WHERE provider_type IS NULL.

- [ ] **Step 3: Commit**

### Task 2: Model Registry Module

**Files:**
- Create: `server/models/registry.js`
- Test: `server/tests/model-registry.test.js`

- [ ] **Step 1: Implement registry module with these exports:**

setDb, registerModel, approveModel, denyModel, bulkApproveByProvider, markModelRemoved, listModels, listPendingModels, getApprovedModels, selectBestApprovedModel, syncModelsFromHealthCheck, getModelCount.

Key behaviors: registerModel inserts as pending for new models, updates last_seen_at for existing. syncModelsFromHealthCheck does bulk insert/update/remove and returns {new, updated, removed}. selectBestApprovedModel queries approved models and uses model_capabilities table scores when available.

- [ ] **Step 2: Write 12+ tests covering all functions**

- [ ] **Step 3: Run tests on Omen, commit**

### Task 3: Feed Health Check into Registry

**Files:**
- Modify: `server/utils/host-monitoring.js`

- [ ] **Step 1: After health check extracts models from /api/tags (around line 144), feed them into the registry**

Call registry.syncModelsFromHealthCheck for each Ollama provider (ollama, hashline-ollama, aider-ollama) with the host ID and discovered model list. Log new discoveries. Wrap in try/catch so registry failures dont break health checks.

- [ ] **Step 2: Commit**

## Chunk 2: Model Approval Tools and Notifications

### Task 4: Model Tool Definitions

**Files:**
- Create: `server/tool-defs/model-defs.js`

- [ ] **Step 1: Define 5 tools:** list_pending_models, approve_model, deny_model, bulk_approve_models, list_models. Each with appropriate inputSchema.

- [ ] **Step 2: Commit**

### Task 5: Model Handlers

**Files:**
- Create: `server/handlers/model-handlers.js`

- [ ] **Step 1: Implement 5 handlers with handle prefix:** handleListPendingModels, handleApproveModel, handleDenyModel, handleBulkApproveModels, handleListModels. All return MCP content format.

- [ ] **Step 2: Commit**

### Task 6: Model Notifications

**Files:**
- Modify: `server/models/registry.js`
- Modify: `server/mcp-sse.js`

- [ ] **Step 1: Emit process events from registry on new model and model removal**

process.emit('torque:model-discovered', ...) and process.emit('torque:model-removed', ...)

- [ ] **Step 2: Listen in mcp-sse.js and push notifications to all sessions**

- [ ] **Step 3: Commit**

### Task 7: Register Model Tools and Routes

**Files:**
- Modify: `server/tools.js`
- Modify: `server/api/routes.js`
- Modify: `server/api/v2-dispatch.js`

- [ ] **Step 1: Register tool defs and handlers in tools.js**
- [ ] **Step 2: Add v2 routes with middleware in routes.js**
- [ ] **Step 3: Add v2-dispatch handler wrappers**
- [ ] **Step 4: Commit**

## Chunk 3: Provider CRUD and Routing Changes

### Task 8: Provider CRUD Tools

**Files:**
- Create: `server/tool-defs/provider-crud-defs.js`
- Create: `server/handlers/provider-crud-handlers.js`
- Test: `server/tests/provider-crud.test.js`

- [ ] **Step 1: Define add_provider and remove_provider tools**
- [ ] **Step 2: Implement handlers:** handleAddProvider validates and inserts into provider_config, triggers model discovery for Ollama/custom types. handleRemoveProvider is two-step (info then confirm).
- [ ] **Step 3: Write tests, register in tools.js/routes.js/v2-dispatch.js**
- [ ] **Step 4: Commit**

### Task 9: Routing Uses Registry Instead of Static Defaults

**Files:**
- Modify: `server/execution/queue-scheduler.js`
- Modify: `server/providers/aider-command.js`
- Modify: `server/providers/execute-hashline.js`
- Modify: `server/providers/execute-ollama.js`

- [ ] **Step 1: In all 4 files, replace static model defaults with registry lookup**

Pattern: try registry.selectBestApprovedModel(provider) first, fall back to serverConfig.get('ollama_model'), then hardcoded default.

- [ ] **Step 2: Run affected tests on Omen**
- [ ] **Step 3: Commit**

### Task 10: Auto-Recovery When Model Disappears

**Files:**
- Modify: `server/models/registry.js`
- Modify: `server/mcp-sse.js`

- [ ] **Step 1: In syncModelsFromHealthCheck, after marking models removed, re-route queued tasks**

Query tasks WHERE status=queued AND model=removedModel, call selectBestApprovedModel, update task model.

- [ ] **Step 2: Push MCP notification on model removal with re-route count**
- [ ] **Step 3: Commit**

## Chunk 4: Dashboard UI

### Task 11: Dashboard API Client

**Files:**
- Modify: `dashboard/src/api.js`

- [ ] **Step 1: Add models and providerCrud API exports**
- [ ] **Step 2: Commit**

### Task 12: Pending Models Panel on Hosts Page

**Files:**
- Modify: `dashboard/src/views/Hosts.jsx`

- [ ] **Step 1: Add amber banner with pending model count, approve/deny buttons, bulk approve per provider**
- [ ] **Step 2: Rebuild dashboard, commit**

### Task 13: Provider Add/Remove on Providers Page

**Files:**
- Modify: `dashboard/src/views/Providers.jsx`

- [ ] **Step 1: Add Provider button with inline form (name, type dropdown, conditional fields), Remove button with confirmation**
- [ ] **Step 2: Rebuild dashboard, commit**

### Task 14: Full Verification on Omen

- [ ] **Step 1: Run full suite on Omen**
- [ ] **Step 2: Fix any regressions**
- [ ] **Step 3: Final commit**

---

## Summary

| Chunk | Tasks | Description |
|-------|-------|-------------|
| **1** | 1-3 | Schema, model registry module, health check integration |
| **2** | 4-7 | Model approval MCP tools, handlers, notifications, routes |
| **3** | 8-10 | Provider CRUD, routing changes, auto-recovery |
| **4** | 11-14 | Dashboard UI for models and providers, verification |

**Total:** 14 tasks, 7 new files, 14 modified files
