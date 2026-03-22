# Per-Host Default Ollama Model

## Problem

When a task targets an Ollama provider without specifying a model, TORQUE falls back to `serverConfig.get('ollama_model')` — a global config key. If that's unset, several modules have hardcoded fallbacks to `'qwen2.5-coder:32b'`, which is now stale (the model was replaced with `qwen3-coder:30b` on BahumutsOmen). There's no UI to set the default model, and no way to configure different defaults per host.

## Solution

Add a `default_model` column to the `ollama_hosts` table and expose it as a dropdown on the dashboard's Hosts page. The model resolution chain becomes:

```
task.model → host.default_model → config('ollama_model') → first model in host's models_cache
```

This eliminates hardcoded model names and lets users configure per-host defaults through the UI.

## Scope

### In scope
- New `default_model` column on `ollama_hosts` table (migration + base DDL)
- Model dropdown on each host card in the Hosts dashboard page
- Updated model resolution in ALL provider execution files (13+ files)
- Remove ALL hardcoded `'qwen2.5-coder:32b'` fallbacks from runtime code
- New `PATCH /api/hosts/:id` REST endpoint for updating host config
- MCP tool support for setting `default_model` via `add_ollama_host` and `set_host_settings`

### Out of scope
- Per-project model defaults (already exists via `project_config.default_model`)
- Model auto-selection based on task complexity (existing smart routing handles this)
- Model pulling/downloading from the dashboard

## Architecture

### Database

Add column via migration AND update base DDL:

```sql
-- Migration:
ALTER TABLE ollama_hosts ADD COLUMN default_model TEXT;

-- Base DDL in schema-tables.js also gets the column for fresh installs.
```

No new table. The column is nullable — `NULL` means "use the global config fallback."

### Model Resolution Chain

Updated resolution order (checked in sequence, first non-empty wins):

1. `task.model` — explicit model in the task submission
2. `host.default_model` — per-host default from the new column (only when host is already selected)
3. `serverConfig.get('ollama_model')` — global config
4. First model in the host's `models_cache` — dynamic fallback from what's actually loaded

**Note:** Some call sites resolve the model *before* host selection (e.g., queue-scheduler choosing a model before calling `selectOllamaHostForModel`). In those cases, step 2 is skipped — the `host` parameter is null. The helper handles this via optional chaining (`host?.default_model`).

Step 4 replaces all hardcoded `'qwen2.5-coder:32b'` references. If a host has models loaded, use the first one. If no models are known, the task fails with a clear error rather than requesting a model that doesn't exist.

**Tier-specific model interaction:** The resolution chain applies to the generic `ollama_model` config. Tier-specific keys (`ollama_fast_model`, `ollama_balanced_model`, `ollama_quality_model`) take priority when set, since they represent an explicit tier preference. The chain becomes: `task.model → tier_model → host.default_model → ollama_model → first cached model`.

### Files to Modify

**Database layer:**
- `server/db/schema-migrations.js` — add migration for `default_model` column
- `server/db/schema-tables.js` — add `default_model TEXT` to base `CREATE TABLE ollama_hosts` DDL
- `server/db/host-management.js` — add `'default_model'` to `allowedFields` whitelist in `updateOllamaHost()`, expose in host getters

**Model resolution — primary provider files:**
- `server/execution/queue-scheduler.js` (lines 553, 801) — replace `'qwen2.5-coder:32b'` with `resolveOllamaModel()`
- `server/execution/fallback-retry.js` (line 648) — use `resolveOllamaModel()`
- `server/providers/execute-hashline.js` (line 495) — use `resolveOllamaModel()`
- `server/providers/execute-ollama.js` (line 194) — use `resolveOllamaModel()`
- `server/providers/execution.js` (lines 462, 496, 501) — use `resolveOllamaModel()`. Note: line 501 has a hidden `'qwen3-coder:30b'` fallback that must also be replaced.
- `server/constants.js` (line 162) — keep `DEFAULT_FALLBACK_MODEL` but update usage to be last-resort only

**Model resolution — additional runtime files with hardcoded model names:**
- `server/execution/strategic-hooks.js` (line 10) — `DEFAULT_MODEL = 'qwen2.5-coder:32b'`
- `server/handlers/integration/routing.js` (lines 619, 802) — hardcoded `'qwen2.5-coder:32b'` in subtask model
- `server/handlers/integration/index.js` (line 907) — hardcoded model fallback
- `server/orchestrator/strategic-brain.js` (line 25) — `DEFAULT_MODELS.ollama`
- `server/providers/ollama-strategic.js` (line 28) — `this.defaultModel` fallback
- `server/db/host-complexity.js` (lines 198-200) — three tier model fallbacks

**API layer (new PATCH endpoint — does not currently exist):**
- `server/dashboard/routes/infrastructure.js` — add `PATCH /hosts/:id` endpoint
- `server/dashboard/router.js` — register the new PATCH route
- `server/api/v2-infrastructure-handlers.js` — add `PATCH /hosts/:id` handler
- `server/api/v2-dispatch.js` — register the new v2 PATCH route

**MCP tool layer:**
- `server/handlers/provider-ollama-hosts.js` — add `default_model` parameter to `handleAddOllamaHost()`, add `default_model` handling to `handleSetHostSettings()`, optionally add `set_default_model` action to `MANAGE_HOST_DISPATCH`

**Dashboard:**
- `dashboard/src/views/Hosts.jsx` — add model dropdown to each host card
- `dashboard/src/api.js` — add `hosts.update(id, data)` method for PATCH calls

### Dashboard UI

On each host card in Hosts.jsx, add a "Default Model" dropdown below the existing models list:

```
┌─────────────────────────────────────┐
│ BahumutsOmen          ● Healthy     │
│ http://192.168.1.183:11434          │
│                                     │
│ Models: qwen3-coder:30b             │
│                                     │
│ Default Model: [qwen3-coder:30b ▾]  │
│                                     │
│ Capacity: 0/3 (0%)                  │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░ │
└─────────────────────────────────────┘
```

- Dropdown is populated from the host's `models_cache` (already available in the API response)
- Includes a "None (use global default)" option for clearing the per-host override
- Selection auto-saves via `PATCH /api/ollama/hosts/:id` with `{ default_model: "model-name" }`
- Shows current value on load

### Helper Function

Create a shared `resolveOllamaModel(task, host)` function that encapsulates the resolution chain. All provider files call this instead of duplicating the fallback logic:

```js
function resolveOllamaModel(task, host) {
  if (task?.model) return task.model;
  if (host?.default_model) return host.default_model;
  const globalDefault = serverConfig.get('ollama_model');
  if (globalDefault) return globalDefault;
  // Dynamic fallback: first model on the host
  if (host?.models?.length) return host.models[0].name || host.models[0];
  return null; // Caller handles the "no model available" error
}
```

This lives in `server/providers/ollama-shared.js` (already exists, exports shared Ollama utilities).

Both parameters are optional: callers without host context pass `null` for host (steps 1, 3, 4 still apply). Callers without task context pass `null` for task (steps 2, 3, 4 still apply).

## Testing

- Migration test: verify column is added, nullable, default NULL
- Base DDL test: fresh `CREATE TABLE` includes `default_model`
- `resolveOllamaModel` unit tests: task model > host default > global config > first cached model > null
- Host management test: `updateOllamaHost({ default_model: 'x' })` persists and is returned by `getOllamaHost()`
- API test: `PATCH /hosts/:id` with `default_model` field (new endpoint)
- MCP test: `add_ollama_host` with `default_model` parameter
- Integration test: submit task without model → verify it uses the host's default_model
- Test file updates: ~30 test files reference `'qwen2.5-coder:32b'` in fixtures — update to reference `DEFAULT_FALLBACK_MODEL` constant or the new dynamic resolution

## Migration Safety

- Column is nullable with no default — existing hosts get `NULL`, which means "use global fallback"
- No data loss, no behavioral change for hosts without a configured default
- The resolution chain is strictly additive — it checks one more level before the existing fallback
- Base DDL updated alongside migration — fresh installs and migrated installs both work
