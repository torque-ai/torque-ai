# Setup Guide

## Prerequisites

| Requirement | Version | Purpose |
|-------------|---------|---------|
| **Node.js** | 20.0+ | Runtime |
| **Claude Code** | Latest | MCP host (IDE integration) |
| **Ollama** | Latest | Local LLM execution (optional) |
| **Git** | Any | Version control, baselines, rollback |

### Optional

| Requirement | Purpose |
|-------------|---------|
| **NVIDIA GPU** | Accelerated Ollama inference |
| **nvidia-smi** | GPU metrics monitoring |

## Installation

TORQUE is included in the project repository. No separate installation is needed.

### 1. Clone the Repository

```bash
git clone <repository-url>
cd Torque
```

### 2. Install Dependencies

```bash
cd server
npm install
```

Dependencies:
- `better-sqlite3` - SQLite database
- `uuid` - Task ID generation
- `bonjour-service` - mDNS LAN discovery

### 3. Open in Claude Code

When you open the project in Claude Code:

1. The MCP server starts automatically via `.mcp.json`
2. Slash commands load from `.claude/commands/`
3. The database is created at `~/.torque/tasks.db`

No additional configuration is required.

## Verifying the Setup

### Check MCP Server

The server starts automatically. Verify with:

```
/torque-status
```

You should see a status overview with queue information.

### Check Ollama (Optional)

If using local LLMs:

```
/torque-status hosts
```

This shows all Ollama hosts and their status.

### Check Dashboard

Open your browser to `http://localhost:3456` for the real-time dashboard.

## Configuration

TORQUE stores configuration in a SQLite key-value table. All settings have sensible defaults.

### Ports

| Service | Default Port | Config Key |
|---------|-------------|------------|
| Dashboard (HTTP + WebSocket) | 3456 | `dashboard_port` |
| REST API | 3457 | `api_port` |
| MCP SSE Transport | 3458 | `mcp_sse_port` |
| GPU Metrics Server | 9394 | `gpu_metrics_port` |

### Core Settings

| Config Key | Default | Description |
|------------|---------|-------------|
| `max_concurrent` | 3 | Maximum parallel tasks |
| `default_provider` | `ollama` | Default execution provider |
| `ollama_host` | `http://localhost:11434` | Local Ollama URL |
| `ollama_model` | `(auto-discovered from hosts)` | Default Ollama model |
| `ollama_fallback_provider` | `claude-cli` | Fallback when Ollama unavailable |

### Smart Routing

| Config Key | Default | Description |
|------------|---------|-------------|
| `smart_routing_enabled` | `1` | Enable automatic provider selection |
| `smart_routing_default_provider` | `ollama` | Default for routed tasks |
| `ollama_health_check_enabled` | `1` | Auto-check Ollama availability |

### LLM Tuning

| Config Key | Default | Description |
|------------|---------|-------------|
| `ollama_temperature` | `0.3` | Sampling temperature (0.1-1.0) |
| `ollama_num_ctx` | `8192` | Context window size |
| `ollama_top_p` | `0.9` | Nucleus sampling threshold |
| `ollama_top_k` | `40` | Top-k sampling limit |
| `ollama_repeat_penalty` | `1.1` | Repetition penalty |
| `ollama_num_predict` | `-1` | Max tokens (-1 = unlimited) |
| `ollama_preset` | `code` | Active tuning preset |

### Hardware Tuning

| Config Key | Default | Description |
|------------|---------|-------------|
| `ollama_num_gpu` | `-1` | GPU layers (-1=auto, 0=CPU, N=layers) |
| `ollama_num_thread` | `0` | CPU threads (0=auto) |
| `ollama_keep_alive` | `5m` | Model memory retention |

### Maintenance

| Config Key | Default | Description |
|------------|---------|-------------|
| `auto_archive_days` | - | Auto-archive tasks older than N days |
| `cleanup_log_days` | - | Delete logs older than N days |
| `stale_running_minutes` | - | Mark running tasks as stalled after N minutes |
| `stale_queued_minutes` | - | Mark queued tasks as stalled after N minutes |
| `health_check_interval_seconds` | `60` | Host health check interval |

### Modifying Configuration

Use the `/torque-config` command or call tools directly:

```
/torque-config tuning
/torque-config hardware
/torque-config safeguards
```

Or use MCP tools:

```
configure { key: "max_concurrent", value: "5" }
set_llm_tuning { temperature: 0.2, num_ctx: 16384 }
set_hardware_tuning { num_gpu: 70, keep_alive: "10m" }
```

## Tuning Presets

Quick-apply predefined parameter sets:

| Preset | Temperature | Top-K | Context | Best For |
|--------|------------|-------|---------|----------|
| `code` | 0.3 | 40 | 8192 | Code generation (default) |
| `precise` | 0.1 | 20 | 8192 | Deterministic output |
| `creative` | 0.8 | 60 | 4096 | Brainstorming, writing |
| `balanced` | 0.5 | 40 | 8192 | General purpose |
| `fast` | 0.3 | 40 | 4096 | Quick tasks, smaller context |

Apply a preset:

```
apply_llm_preset { preset: "precise" }
```

## Auto-Tuning

TORQUE can automatically adjust parameters based on task type:

| Task Type | Detection Keywords | Temperature |
|-----------|--------------------|-------------|
| Code generation | write, implement, create, generate | 0.2 |
| Code review | review, check code, find bugs | 0.3 |
| Documentation | document, readme, explain | 0.5 |
| Creative | brainstorm, ideas, suggest | 0.7 |
| Precise | exact, specific, deterministic | 0.1 |
| Debugging | debug, fix bug, error, not working | 0.3 |

Enable/disable:

```
set_auto_tuning { enabled: true }
```

## Data Directory

TORQUE stores its database and logs in:

| Platform | Path |
|----------|------|
| Linux/macOS | `~/.torque/` |
| Windows | `~/.torque/` |
| Custom | Set `TORQUE_DATA_DIR` environment variable |

Contents:
- `tasks.db` - SQLite database (all tasks, config, history)
- `torque-debug.log` - Debug log file
- Structured JSON logs via the logger module

## Services Auto-Started

When TORQUE starts, it automatically launches:

1. **Dashboard** - HTTP + WebSocket (port 3456)
2. **REST API** - HTTP endpoints (port 3457)
3. **MCP SSE Transport** - Survives context rollovers (port 3458)
4. **GPU Metrics Server** - nvidia-smi polling (port 9394)
5. **LAN Discovery** - mDNS + auto-scan for Ollama hosts
6. **Maintenance Scheduler** - Archive, cleanup, vacuum (60s interval)
7. **Queue Processor** - Safety-net polling every 5 seconds

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TORQUE_DATA_DIR` | Override data directory path |
| `ANTHROPIC_API_KEY` | API key for Anthropic Claude provider |
| `GROQ_API_KEY` | API key for Groq provider |
| `DEEPINFRA_API_KEY` | API key for DeepInfra provider |
| `HYPERBOLIC_API_KEY` | API key for Hyperbolic provider |
| `OLLAMA_HOST` | Override default Ollama URL |

## Next Steps

- [Provider Guide](providers.md) - Configure providers and routing
- [Multi-Host Guide](multi-host.md) - Set up remote Ollama hosts
- [Safeguards](../safeguards.md) - Quality gates and validation
- [Tool Reference](../api/tool-reference.md) - All ~600 MCP tools
