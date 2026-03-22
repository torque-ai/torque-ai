# Concurrency Limits UI — Design Spec

**Date:** 2026-03-16
**Status:** Approved (pending implementation)

## Overview

Expose all concurrency controls through both MCP tools (for Claude sessions) and the dashboard UI (for visual tuning). Four limit scopes, all persisted in the database between sessions.

## Concurrency Scopes

| Scope | Storage | Current State | What's New |
|-------|---------|---------------|------------|
| **Per-provider `max_concurrent`** | `provider_config.max_concurrent` | Settable via `update_provider` MCP tool | Dashboard UI on Providers page |
| **Per-workstation `max_concurrent`** | `workstations.max_concurrent` | Settable via `update_workstation` (no dedicated tool) | MCP tool + Dashboard UI on Hosts page |
| **Per-host `max_concurrent`** (legacy) | `ollama_hosts.max_concurrent` | Settable via existing host tools | Dashboard UI on Hosts page |
| **VRAM overhead factor** | Currently hardcoded `0.95` in `host-management.js` | Not configurable | Move to `config` table + MCP tool + Dashboard UI on Hosts page |

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| MCP tool design | Two tools: `get_concurrency_limits` + `set_concurrency_limit` | Unified view + single setter with scope parameter |
| VRAM factor storage | `config` table, key `vram_overhead_factor` | Follows existing pattern for global config |
| VRAM factor range | 0.50–1.00, default 0.95 | Prevents nonsensical values; 1.00 = use all VRAM |
| Dashboard placement | Providers page for provider limits; Hosts page for workstation + host + VRAM | Matches existing page responsibilities; workstations show alongside hosts per user preference |
| Persistence | All in database, zero hardcoded defaults at runtime | Config table for global, provider_config for per-provider, workstations/ollama_hosts for per-machine |

## MCP Tools

### `get_concurrency_limits`

Returns a unified view of all concurrency settings:

```json
{
  "vram_overhead_factor": 0.95,
  "providers": [
    { "provider": "codex", "max_concurrent": 10, "enabled": true },
    { "provider": "hashline-ollama", "max_concurrent": 2, "enabled": true }
  ],
  "workstations": [
    { "name": "remote-gpu-host", "max_concurrent": 3, "gpu_vram_mb": 24576, "effective_vram_budget_mb": 23347, "running_tasks": 1 }
  ],
  "ollama_hosts": [
    { "name": "remote-gpu-host", "max_concurrent": 3, "running_tasks": 1 }
  ]
}
```

Input: `{}` (no args, returns everything)

### `set_concurrency_limit`

Sets a specific concurrency limit by scope.

Input:
```json
{
  "scope": "provider | workstation | host | vram_factor",
  "target": "codex | remote-gpu-host | host-id",
  "max_concurrent": 5,
  "vram_factor": 0.95
}
```

`target` identifies the entity — provider name, workstation name, or host ID (matching existing conventions).

Required fields per scope:

| Scope | Required | Optional |
|-------|----------|----------|
| `provider` | `target`, `max_concurrent` | — |
| `workstation` | `target`, `max_concurrent` | — |
| `host` | `target`, `max_concurrent` | — |
| `vram_factor` | `vram_factor` | — |

- `scope: "provider"` + `target` + `max_concurrent` → updates `provider_config.max_concurrent`
- `scope: "workstation"` + `target` (name) + `max_concurrent` → updates `workstations.max_concurrent`
- `scope: "host"` + `target` (host ID) + `max_concurrent` → updates `ollama_hosts.max_concurrent`
- `scope: "vram_factor"` + `vram_factor` (0.50–1.00) → updates `config.vram_overhead_factor`

Validates: `max_concurrent` must be integer 1–100 (or 0 for unlimited on hosts). `vram_factor` must be 0.50–1.00. Invalid `scope` returns error.

Returns confirmation with the new effective limits.

## Dashboard UI

### Providers Page — Concurrency Column

Add an editable `max_concurrent` field to each `ProviderCard` in `dashboard/src/views/Providers.jsx`:
- Display current value as an inline number input
- On change: `PATCH /api/providers/:name` with `{ max_concurrent: N }`
- Show current running count next to limit (e.g., "2 / 10")
- Validate: integer 1–100

### Hosts Page — Concurrency & VRAM Section

Extend `dashboard/src/views/Hosts.jsx`:

**Per-host card (existing ollama_hosts):**
- Add editable `max_concurrent` input next to the existing `CapacityBar`
- On change: `PATCH /api/hosts/:id` with `{ max_concurrent: N }`

**Per-workstation card (new section on Hosts page):**
- Show workstation name, host, capabilities, GPU info
- Add editable `max_concurrent` input with `CapacityBar`
- On change: `PATCH /api/workstations/:id` with `{ max_concurrent: N }`

**VRAM Settings (global, top of Hosts page):**
- "VRAM Budget Factor" slider/input: 0.50–1.00, shows effective budget in GB for each host
- Example display: "VRAM Budget: 95% → 23.3 GB of 24.6 GB"
- On change: `PATCH /api/config/vram_overhead_factor` with `{ value: "0.95" }`
- Applies globally to all workstations/hosts

## API Endpoints (REST — v1, POST-based)

Follow existing v1 convention (all mutations use POST, not PATCH):

- `GET /api/concurrency` → returns same shape as `get_concurrency_limits` MCP tool
- `POST /api/concurrency/set` → unified setter, same args as `set_concurrency_limit` MCP tool (scope, target, max_concurrent/vram_factor)
- Existing `POST /api/providers/configure` already supports `max_concurrent` — no changes needed
- Existing `POST /api/ollama/hosts/:id/...` routes already support host updates — extend if needed

## VRAM Factor Migration

Move the hardcoded constant in `host-management.js`:

**Before:**
```javascript
const VRAM_OVERHEAD_FACTOR = 0.95;
```

**After:**
```javascript
function getVramOverheadFactor() {
  const configured = getConfig('vram_overhead_factor');
  if (configured) {
    const val = parseFloat(configured);
    if (val >= 0.5 && val <= 1.0) return val;
  }
  return 0.95; // default
}
```

Seed default: `setConfigDefault('vram_overhead_factor', '0.95')` in `schema-seeds.js`.

## Testing Strategy

### Unit tests (~8)
- `get_concurrency_limits` returns all 4 scopes
- `set_concurrency_limit` for each scope (provider, workstation, host, vram_factor)
- `set_concurrency_limit` validates range (vram_factor 0.5–1.0, max_concurrent 1–100)
- `getVramOverheadFactor()` reads from config, falls back to 0.95

### Integration tests (~4)
- Set VRAM factor → verify `checkVramBudget` uses new value
- Set workstation max_concurrent → verify `tryReserveHostSlot` respects it
- Set provider max_concurrent via tool → verify provider config updated
- `get_concurrency_limits` returns workstations with effective VRAM budget

### Dashboard tests (~3)
- Provider card shows and updates max_concurrent
- Host card shows and updates max_concurrent
- VRAM slider updates config

## Files to Create/Modify

### New files
- `server/handlers/concurrency-handlers.js` — MCP tool handlers
- `server/tool-defs/concurrency-defs.js` — tool definitions
- `server/tests/concurrency-limits.test.js` — unit + integration tests

### Modified files
- `server/db/host-management.js` — replace hardcoded `VRAM_OVERHEAD_FACTOR` with `getVramOverheadFactor()`
- `server/db/schema-seeds.js` — seed `vram_overhead_factor` default
- `server/tools.js` — register concurrency tools and handlers
- `server/api-server.js` — add `GET /api/concurrency`, `PATCH /api/workstations/:id`
- `dashboard/src/views/Providers.jsx` — add editable max_concurrent to ProviderCard
- `dashboard/src/views/Hosts.jsx` — add workstation section, editable limits, VRAM slider
- `dashboard/src/api.js` — add workstation and concurrency API calls
