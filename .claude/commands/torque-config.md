---
name: torque-config
description: View and modify TORQUE configuration — tuning, hardware, safeguards
argument-hint: "[setting=value | 'tuning' | 'hardware' | 'safeguards']"
allowed-tools:
  - mcp__torque__configure
  - mcp__torque__get_llm_tuning
  - mcp__torque__set_llm_tuning
  - mcp__torque__apply_llm_preset
  - mcp__torque__get_hardware_tuning
  - mcp__torque__set_hardware_tuning
  - mcp__torque__get_host_settings
  - mcp__torque__set_host_settings
  - mcp__torque__run_benchmark
  - mcp__torque__check_ollama_health
  - mcp__torque__list_ollama_models
  - mcp__torque__get_codex_breaker_status
  - mcp__torque__trip_codex_breaker
  - mcp__torque__untrip_codex_breaker
  - mcp__torque__configure_codex_policy
  - AskUserQuestion
---

# TORQUE Config

View and modify TORQUE system configuration.

## Instructions

### If no argument — show full config overview:

1. Call in parallel:
   - `configure` (no args) — general settings
   - `get_llm_tuning` — model tuning parameters
   - `get_hardware_tuning` — GPU/CPU settings
   - `check_ollama_health` — host status

2. Present as:

```
## TORQUE Configuration

### General
| Setting | Value |
|---------|-------|
| max_concurrent | X |
| default_timeout | X min |

### LLM Tuning
| Parameter | Value |
|-----------|-------|
| temperature | X |
| top_p | X |
| preset | X |

### Hardware
| Setting | Value |
|---------|-------|
| num_gpu | X |
| keep_alive | X |

### Hosts
[Per-host status and settings]
```

### If argument is a category:

- **"tuning"**: Show `get_llm_tuning` details. Offer preset selection via AskUserQuestion (code, precise, creative, balanced, fast).
- **"hardware"**: Show `get_hardware_tuning`. Offer to run benchmark via AskUserQuestion.
- **"safeguards"**: Show current safeguard config. Offer toggles for: quality_scoring, build_check, auto_rollback, validation.

### If argument is key=value:

Parse the setting and route to the correct tool:
- `max=N` or `max_concurrent=N` → `configure`
- `timeout=N` → `configure`
- `temperature=N`, `top_p=N` → `set_llm_tuning`
- `preset=X` → `apply_llm_preset`
- `num_gpu=N`, `keep_alive=X` → `set_hardware_tuning`
- `quality_scoring=0|1`, `build_check=0|1`, `auto_rollback=0|1` → `configure`

Apply the setting and confirm the new value.

### If argument starts with "codex-breaker" or "codex-policy":

Route to the Codex circuit-breaker subcommands documented below.

## Codex Breaker / Fallback Policy

Operate the Codex circuit breaker and per-project fallback policy.

### Status

`/torque-config codex-breaker status`

Returns the current Codex breaker state — both in-memory state machine (CLOSED / OPEN / HALF_OPEN, consecutive failures, last failure category) and the persisted DB record (trip reason, last canary at).

Maps to `get_codex_breaker_status` (no args).

### Manual trip

`/torque-config codex-breaker trip [--reason="..."]`

Marks Codex unavailable. The factory then routes per each project's `codex_fallback_policy`. Pair with `untrip` when ready to resume.

Maps to `trip_codex_breaker { reason: "..." }`.

### Manual untrip

`/torque-config codex-breaker untrip [--reason="..."]`

Marks Codex available again. Emits `circuit:recovered`, which auto-resumes any work items currently in `parked_codex_unavailable` status.

Maps to `untrip_codex_breaker { reason: "..." }`.

### Per-project fallback policy

`/torque-config codex-policy --project=<name> --mode={auto|manual|wait_for_codex}`

Sets the project codex_fallback_policy. Three modes:

- **auto** (default): when the breaker trips, the factory falls back per the routing template (Phase 2 will wire EXECUTE failover).
- **manual**: never auto-falls-back. The operator must trip explicitly to enter fallback for this project.
- **wait_for_codex**: the strictest mode. When the breaker trips, the project freezes at PRIORITIZE — selected work items are immediately parked as `parked_codex_unavailable`, no PLAN/EXECUTE work runs until the breaker untrips.

Resolve `<name>` to a project_id via `list_factory_projects` first if needed.

Maps to `configure_codex_policy { project_id: "<id>", mode: "<mode>" }`.

