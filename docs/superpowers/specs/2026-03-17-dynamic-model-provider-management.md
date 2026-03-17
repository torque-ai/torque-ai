# Dynamic Model & Provider Management — Design Spec

**Date:** 2026-03-17
**Status:** Approved (pending implementation)

## Overview

Make TORQUE's model and provider ecosystem fully user-driven. Models are auto-discovered across all provider types (local Ollama, cloud APIs, custom endpoints), require user approval before routing, and dynamically adjust when added or removed. Providers are fully manageable (add/remove/configure) through MCP tools, REST API, and dashboard UI.

## Motivation

TORQUE currently has:
- Static model defaults hardcoded in config seeds (`ollama_model: 'deepseek-r1:14b'`)
- Provider list fixed at install time — users can enable/disable but not add/remove
- No awareness of which models are actually available on hosts — tasks stall when the configured default doesn't exist
- No mechanism for users to control which discovered models are used for routing

This causes: tasks silently stalling in queue (model not on any host), inability to add custom inference endpoints, and no user control over model selection.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Discovery trigger | Auto on health check + manual probe | Continuous awareness without user action |
| New model default | `pending` (requires approval) | Prevents routing to models user pulled for experimentation |
| Approval channels | MCP tools + REST + Dashboard | All three surfaces the user interacts with |
| Provider CRUD scope | Full — add, remove, configure all provider types | Users control their entire inference ecosystem |
| Model disappearance | Silent re-route to best available | Keep tasks moving, don't fail unnecessarily |
| Provider types | `ollama`, `cloud-cli`, `cloud-api`, `custom` | Covers all current and future provider patterns |

## Provider Data Model

Extend `provider_config` table with new columns:

```sql
-- New columns on provider_config
api_base_url TEXT,           -- endpoint URL (e.g., https://api.deepinfra.com/v1)
api_key_env_var TEXT,        -- env var name for API key
api_key_encrypted TEXT,      -- encrypted API key (alternative to env var)
provider_type TEXT,          -- ollama | cloud-cli | cloud-api | custom
model_discovery TEXT,        -- auto | manual | probe
default_model TEXT,          -- preferred model for this provider
```

Provider types:
- `ollama` — local/LAN Ollama instance. Model discovery via `/api/tags` on health check.
- `cloud-cli` — codex, claude-cli. No model discovery, fixed capabilities.
- `cloud-api` — anthropic, deepinfra, groq, hyperbolic, cerebras, google-ai, openrouter, ollama-cloud. Models specified by user or known lists.
- `custom` — user-added OpenAI-compatible endpoint. Probes `/v1/models` if available, otherwise manual model entry.

Existing seed-based providers get `provider_type` backfilled during migration:
- codex, claude-cli → `cloud-cli`
- ollama, hashline-ollama, aider-ollama → `ollama`
- anthropic, deepinfra, groq, hyperbolic, cerebras, google-ai, openrouter, ollama-cloud → `cloud-api`

## Model Registry

New `model_registry` table tracks every model across every provider:

```sql
CREATE TABLE model_registry (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,        -- provider_config.provider
  host_id TEXT,                  -- workstation/ollama_hosts ID (null for cloud)
  model_name TEXT NOT NULL,
  size_bytes INTEGER,            -- null for cloud models
  status TEXT DEFAULT 'pending', -- pending | approved | denied | removed
  first_seen_at TEXT,
  last_seen_at TEXT,
  approved_at TEXT,
  approved_by TEXT,              -- 'user' | 'auto' | null
  UNIQUE(provider, host_id, model_name)
);
```

**Status lifecycle:**
- `pending` — discovered, not yet approved. Not routable. Triggers notification.
- `approved` — user approved. Routable for task execution.
- `denied` — user explicitly blocked. Never routed to. Can be re-approved later.
- `removed` — was approved but model no longer detected on host. Tasks auto-reroute.

**Discovery per provider type:**
- `ollama`: health check calls `/api/tags` → new models inserted as `pending`, known models get `last_seen_at` updated, missing models marked `removed`
- `cloud-api`: on provider add, user specifies models OR TORQUE probes provider-specific model list endpoint
- `custom`: user specifies models, or TORQUE probes `/v1/models` if URL supports it
- `cloud-cli`: fixed model sets seeded on install (codex → gpt-5.3-codex-spark, claude-cli → claude)

## Notification & Approval Flow

### When new model detected:
1. Insert into `model_registry` with `status: 'pending'`
2. Push MCP notification to all connected sessions:
   ```json
   {
     "type": "model_discovered",
     "provider": "deepinfra",
     "model": "llama3:70b",
     "host": "cloud",
     "size_bytes": null
   }
   ```
3. Dashboard badge on Hosts page: "3 pending models" (amber banner)

### Approval MCP tools:
- `approve_model { provider, model_name }` — sets status to `approved`
- `deny_model { provider, model_name }` — sets status to `denied`
- `list_pending_models` — returns all pending models across all providers
- `bulk_approve_models { provider }` — approve all pending for a provider

### Dashboard:
- Pending models panel on Hosts page (amber banner when pending exist)
- Each model shows: provider, name, size (if known), host, first seen
- Approve/Deny buttons per model, "Approve All" per provider

### REST endpoints (v2):
- `GET /api/v2/models/pending` → list pending
- `POST /api/v2/models/approve` → approve `{ provider, model_name }`
- `POST /api/v2/models/deny` → deny `{ provider, model_name }`
- `POST /api/v2/models/bulk-approve` → approve all for provider `{ provider }`
- `GET /api/v2/models` → list all models (any status) with filters

## Provider CRUD

### MCP tools:
- `add_provider { name, provider_type, api_base_url, api_key, max_concurrent, default_model, models }` — creates provider entry. For Ollama type, triggers model discovery. For custom, probes `/v1/models` if URL provided.
- `remove_provider { provider, confirm }` — two-step: first call shows affected tasks/models, second call with `confirm: true` removes. Queued tasks auto-reroute.
- `update_provider` — already exists, enhanced with new fields (api_base_url, default_model, provider_type)
- `list_providers` — already exists, enhanced to include provider_type, api_base_url, model count, pending model count

### REST endpoints (v2, POST-based):
- `POST /api/v2/providers/add` → add_provider
- `POST /api/v2/providers/remove` → remove_provider (with confirm flag)
- Existing configure/toggle routes unchanged

### Dashboard Providers page:
- "Add Provider" button → inline form:
  - Name (text)
  - Type (dropdown: Ollama, Cloud API, Cloud CLI, Custom)
  - Type-dependent fields: API Base URL (cloud-api, custom), API Key (cloud-api, custom), Host URL (ollama)
  - Max Concurrent (number)
  - Default Model (text, optional)
- Remove button per provider (confirmation shows affected tasks)
- Model count badge per provider card: "5 models (2 pending)"

## Routing Changes

### Replace static model defaults:

**Before (static):**
```javascript
const model = task.model || serverConfig.get('ollama_model') || 'mistral:7b';
```

**After (registry-driven):**
```javascript
const model = task.model || selectBestApprovedModel(provider, taskComplexity);
```

`selectBestApprovedModel(provider, complexity)`:
1. Query `model_registry` WHERE provider matches AND status = 'approved'
2. For Ollama providers: filter to models on healthy hosts with capacity
3. Rank by `model_capabilities` scores for the task type/complexity
4. Return best match, or null if no approved models

### Auto-recovery when model disappears:
1. Health check detects model gone → mark `removed` in registry
2. Query queued tasks with that model assigned
3. For each: call `selectBestApprovedModel` → update task's model + host
4. Push MCP notification: `"Model qwen3:8b removed from BahumutsOmen. 2 tasks re-routed to codestral:22b."`

### Auto-recovery when provider removed:
1. All models for that provider marked `removed`
2. Queued tasks re-routed to next best provider/model
3. Running tasks marked failed with clear error

## Testing Strategy

### Unit tests (~15)
- Model registry CRUD — insert, approve, deny, remove, query by status
- `selectBestApprovedModel` — picks approved models only, ranks by capability
- Provider CRUD — add custom provider, remove provider, validate fields
- Discovery integration — health check feeds registry, new models get `pending`
- Auto-recovery — model removed → queued tasks re-routed

### Integration tests (~10)
- Add custom provider via MCP tool → provider appears in list
- Remove provider with queued tasks → tasks re-routed
- Approve model → model becomes routable
- Deny model → model never selected by router
- Health check discovers new model → notification pushed
- Model disappears → queued tasks re-routed, notification pushed

### Dashboard tests (~3)
- Pending models banner appears when pending models exist
- Approve button updates model status
- Add provider form creates entry

## Files to Create/Modify

### New files
- `server/models/registry.js` — model registry CRUD, discovery, approval, best-model selection
- `server/handlers/model-handlers.js` — MCP tool handlers (approve, deny, list, bulk approve)
- `server/tool-defs/model-defs.js` — tool definitions for model management
- `server/handlers/provider-crud-handlers.js` — add_provider, remove_provider handlers
- `server/tool-defs/provider-crud-defs.js` — tool definitions for provider CRUD
- `server/tests/model-registry.test.js` — unit + integration tests
- `server/tests/provider-crud.test.js` — unit + integration tests

### Modified files
- `server/db/schema-migrations.js` — create `model_registry` table, add columns to `provider_config`
- `server/db/schema-seeds.js` — backfill `provider_type` for existing providers
- `server/utils/host-monitoring.js` — feed discovered models into registry during health check
- `server/execution/queue-scheduler.js` — use registry for model selection + auto-recovery
- `server/providers/aider-command.js` — use registry instead of static default
- `server/providers/execute-hashline.js` — use registry instead of static default
- `server/providers/execute-ollama.js` — use registry instead of static default
- `server/mcp-sse.js` — push `model_discovered` and `model_removed` notifications
- `server/tools.js` — register new tools and handlers
- `server/api/routes.js` — v2 routes for model + provider CRUD
- `server/api/v2-dispatch.js` — handler wrappers for dashboard
- `dashboard/src/views/Hosts.jsx` — pending models panel with approve/deny
- `dashboard/src/views/Providers.jsx` — add/remove provider form, model counts
- `dashboard/src/api.js` — model + provider CRUD API client
