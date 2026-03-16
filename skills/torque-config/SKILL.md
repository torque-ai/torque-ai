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

