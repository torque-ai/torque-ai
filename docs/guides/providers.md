# Provider Guide

TORQUE routes tasks across 12 execution providers. This guide covers how to configure each one.

## Provider Types

| Type | How It Works | Examples |
|------|-------------|----------|
| **Local** | Runs on your Ollama instance (local or LAN) | Ollama |
| **CLI** | Invokes an installed CLI tool | Codex, Codex Spark, Claude Code |
| **API (BYOK)** | Calls a cloud API with your key | DeepInfra, Anthropic, Groq, Cerebras, Google AI, Hyperbolic, OpenRouter |

**BYOK** = Bring Your Own Key. You provide the API key; TORQUE handles routing and orchestration.

## Smart Routing

By default, TORQUE picks the best provider automatically based on:

- **Task complexity** — simple tasks stay local, complex tasks route to more capable providers
- **Provider health** — unhealthy or overloaded providers are skipped
- **Available capacity** — tasks go to providers with open slots
- **Capability match** — file creation routes to providers that support it, edits to those optimized for it

Override routing for any task:

```bash
torque submit "Write tests for auth.ts" --provider codex
```

Or configure routing templates to control which providers handle which task categories. See the [Routing Templates](#routing-templates) section.

## Local Providers

### Ollama

Runs on your local Ollama instance. Best for general prompts, documentation, and brainstorming.

**Prerequisites:**
1. Install Ollama from [ollama.com](https://ollama.com/)
2. Pull a model: `ollama pull qwen3-coder:30b`
3. Start Ollama: `ollama serve`

TORQUE auto-detects Ollama at `http://localhost:11434` during `torque init`. No additional configuration needed.

**Tuning parameters** (configurable via MCP tools or dashboard):
- `temperature` — controls randomness (default: 0.2)
- `num_ctx` — context window size (default: 8192)
- `num_predict` — max output tokens (default: -1, unlimited)

## CLI Providers

CLI providers invoke locally installed tools. They run on your machine but may use cloud compute (depending on the tool's own configuration).

### Codex

OpenAI's Codex CLI tool. Best for complex multi-file tasks and greenfield code generation.

**Setup:**
1. Install: `npm install -g @openai/codex`
2. Authenticate: `codex auth`
3. Set environment variable: `export OPENAI_API_KEY=your-key`

### Codex Spark

Same as Codex but uses the `gpt-5.3-codex-spark` model for faster single-file edits.

**Setup:** Same as Codex — shares the same CLI and API key.

### Claude Code

Anthropic's Claude Code CLI. Best for architectural decisions and complex debugging.

**Setup:**
1. Install: `npm install -g @anthropic-ai/claude-code`
2. Authenticate: `claude auth`

## API Providers (BYOK)

Cloud API providers are disabled by default. To enable one:

1. Set the API key as an environment variable
2. Enable the provider via MCP tool or dashboard

### Provider Reference

| Provider | Environment Variable | Default Model |
|----------|---------------------|---------------|
| **Anthropic** | `ANTHROPIC_API_KEY` | Claude (latest) |
| **DeepInfra** | `DEEPINFRA_API_KEY` | Qwen/Qwen2.5-72B-Instruct |
| **Hyperbolic** | `HYPERBOLIC_API_KEY` | Qwen/Qwen2.5-72B-Instruct |
| **Groq** | `GROQ_API_KEY` | (auto-selected) |
| **Cerebras** | `CEREBRAS_API_KEY` | (auto-selected) |
| **Google AI** | `GOOGLE_AI_API_KEY` | (auto-selected) |
| **OpenRouter** | `OPENROUTER_API_KEY` | (auto-selected) |

### Example: Enable DeepInfra

```bash
# Set your API key
export DEEPINFRA_API_KEY=your-key-here
```

Then via MCP tool:
```
configure_provider { provider: "deepinfra", enabled: true }
```

Or via REST API:

    curl -X POST http://127.0.0.1:3457/api/tools/configure_provider \
      -H "Content-Type: application/json" \
      -d '{"provider": "deepinfra", "enabled": true}'

### Ollama Cloud

A special provider for remote Ollama-compatible endpoints (e.g., a cloud-hosted Ollama instance or any OpenAI-compatible API).

| Environment Variable | Purpose |
|---------------------|---------|
| `OLLAMA_CLOUD_API_KEY` | API key for the remote endpoint |

Configure the endpoint URL via the dashboard or MCP tools.

## Multi-Host Setup

TORQUE can distribute tasks across multiple Ollama instances on your LAN.

### Adding a Remote Host

```
add_ollama_host { name: "gpu-server", url: "http://192.0.2.100:11434" }
```

### Remote Host Prerequisites

On the remote machine:
1. Install and start Ollama
2. Bind to all interfaces: `OLLAMA_HOST=0.0.0.0:11434 ollama serve`
3. Allow inbound TCP on port 11434

### Load Balancing

Tasks route to the least-loaded host that has the requested model:
1. Filter to enabled hosts with healthy status
2. Filter to hosts with the requested model
3. Pick the host with the fewest running tasks

### Health Monitoring

TORQUE checks all hosts every 60 seconds:
- Models are refreshed on each successful health check
- 3 consecutive failures mark a host as `down`
- Hosts auto-recover when they come back online

Check host status:
```
list_ollama_hosts
check_ollama_health
```

## Fallback Chains

When a provider fails, TORQUE retries on the next provider in the fallback chain. Default chains:

- **Codex** → Claude CLI → DeepInfra → Ollama Cloud → Ollama
- **DeepInfra** → Ollama Cloud → Hyperbolic → Claude CLI → Codex → Ollama
- **Ollama** → fallback model on alternate host → DeepInfra → Codex

Customize chains:
```
configure_fallback_chain { provider: "ollama", chain: ["deepinfra", "codex"] }
```

## Routing Templates

Routing templates give you explicit control over which providers handle which task categories. TORQUE auto-detects 9 task categories from the task description:

`security`, `xaml_wpf`, `architectural`, `reasoning`, `large_code_gen`, `documentation`, `simple_generation`, `targeted_file_edit`, `default`

### Preset Templates

| Template | Strategy |
|----------|----------|
| **System Default** | Codex for hard problems, balanced routing for rest |
| **Quality First** | Codex primary for all code work |
| **Cost Saver** | Lightweight providers first, Codex as last resort |
| **Cloud Sprint** | Cerebras primary, maximum speed |
| **All Local** | Ollama for everything, Codex escape hatch for complex tasks |

### Activate a Template

```
activate_routing_template { name: "Quality First" }
```

### Per-Task Override

    smart_submit_task { task: "...", routing_template: "Cost Saver" }

## Concurrency

Each provider has independent concurrency limits:

| Setting | Default | Description |
|---------|---------|-------------|
| `max_concurrent` | 20 | Global task limit |
| `max_ollama_concurrent` | 8 | Ollama provider limit |
| `max_codex_concurrent` | 6 | Codex provider limit |
| `max_api_concurrent` | 4 | Per-API-provider limit |
| `max_per_host` | 4 | Per-Ollama-host limit |

Ollama tasks share host-level VRAM limits, so their combined running tasks respect the per-host cap.

## Stall Detection

TORQUE detects stuck tasks and can auto-recover:

| Provider | Stall Threshold |
|----------|----------------|
| Ollama | 180 seconds |
| Codex | 600 seconds |
| DeepInfra / Hyperbolic | 180 seconds |

Stalled tasks are cancelled and resubmitted to the next provider in the fallback chain.

Configure per provider:
```
configure_stall_detection { provider: "codex", stall_threshold_seconds: 300, auto_resubmit: true }
```