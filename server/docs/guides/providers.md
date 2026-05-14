# Provider Guide

TORQUE routes tasks across multiple execution providers, balancing cost, speed, and quality.

## Providers

| Provider | ID | Execution | Cost | Best For |
|----------|----|-----------|------|----------|
| **Ollama (direct)** | `ollama` | Local HTTP | Free | General prompts, documentation, lightweight local edits |
| **Codex** | `codex` | Cloud subscription CLI | Paid | Greenfield code, complex multi-file tasks |
| **Codex Spark** | `codex-spark` | Cloud subscription CLI | Paid | Fast single-file edits (gpt-5.3-codex-spark model) |
| **Claude CLI** | `claude-cli` | Cloud subscription CLI subprocess | Paid | Architectural decisions, complex debugging (raw CLI subprocess) |
| **Claude Code SDK** | `claude-code-sdk` | Cloud subscription, in-process SDK | Paid | SDK-based agentic loop with structured streaming, session store, permission modes (auto / acceptEdits / plan / bypassPermissions), and skills loading. Default model `claude-sonnet-4-20250514` |
| **claude-ollama** | `claude-ollama` | Local CLI-harness | Free | Local Ollama models driven through the Claude Code agentic loop (Read/Edit/Bash) — not the raw prompt-response shape used by `ollama` |
| **Anthropic API** | `anthropic` | Cloud HTTP (BYOK) | Paid | Direct Claude API tasks |
| **Cerebras** | `cerebras` | Cloud HTTP (BYOK) | Paid | Fast inference, low latency |
| **Google AI** | `google-ai` | Cloud HTTP (BYOK) | Paid | Large context (800K+ tokens) |
| **Groq** | `groq` | Cloud HTTP (BYOK) | Paid | Low-latency general tasks |
| **DeepInfra** | `deepinfra` | OpenAI-compatible Cloud API (BYOK) | Paid | High-concurrency batch (200 concurrent/model) |
| **Hyperbolic** | `hyperbolic` | OpenAI-compatible Cloud API (BYOK) | Paid | Large models (70B–405B), fast output |
| **Ollama Cloud** | `ollama-cloud` | Cloud HTTP (BYOK) | Paid | Remote Ollama-compatible endpoint (bearer-token REST) |
| **OpenRouter** | `openrouter` | Cloud HTTP (BYOK) | Free + paid | Multi-model gateway |

14 providers total. BYOK = Bring Your Own Key. All cloud-API providers start disabled; enable with `configure_provider { provider: "<name>", enabled: true }` after setting the API key env var.

## Smart Routing

When `smart_routing_enabled` is `1` (default), TORQUE automatically selects the best provider for each task.

### How Routing Works

1. Task description is analyzed against routing rules
2. Rules match by keyword, file extension, or complexity
3. If multiple candidates remain, routing scoring evaluates task type, detected language, and task complexity
4. For candidates with model-capability scoring, TORQUE uses `classifyTaskType + detectTaskLanguage + selectBestModel` to compute the best match. `selectBestModel` weights task type at 60%, detected language at 30%, and complexity at 10% before ranking models (`taskType`, `language`, `complexity`).
5. Highest-priority matching rule determines the provider
6. If no rule matches, the default provider is used

### Default Routing Rules

**Tier 1: Local LLM** (checked first)

| Rule | Keywords/Patterns | Provider |
|------|-------------------|----------|
| Documentation | readme, documentation, docs, changelog | `ollama` |
| Code comments | comment, docstring, jsdoc, tsdoc | `ollama` |
| Simple tests | write test, add test, unit test | `ollama` |
| Commit messages | commit message, git commit | `ollama` |
| Code explanation | explain, what does, how does | `ollama` |
| Simple refactoring | rename, move, extract, inline | `ollama` |
| Config edits | .json, .yaml, .yml, .toml, .ini, .env | `ollama` |
| Boilerplate | boilerplate, scaffold, template | `ollama` |

**Tier 2: Cloud Provider** (fallback for complex tasks)

| Rule | Keywords/Patterns | Provider |
|------|-------------------|----------|
| Security code | security, authentication, encryption | `claude-cli` |
| Multi-file refactor | refactor across, multiple files | `claude-cli` |
| Architecture | architecture, design pattern | `claude-cli` |
| Complex debugging | complex bug, race condition | `claude-cli` |
| API integration | api integration, oauth, webhook | `claude-cli` |
| XAML/WPF | .xaml, wpf, xaml binding | `claude-cli` |

### Testing a Route

Preview which provider a task would use without submitting:

```
test_routing { task_description: "Write unit tests for utils/parser.js" }
```

### Custom Routing Rules

Add rules to override or extend default routing:

```
add_routing_rule {
  name: "database-tasks",
  description: "Route database work to cloud",
  rule_type: "keyword",
  pattern: "database|migration|schema|sql",
  target_provider: "claude-cli",
  priority: 25,
  enabled: true
}
```

Rule types:
- `keyword` - Match task description against keywords
- `extension` - Match by file extension
- `complexity` - Route by estimated complexity score

Priority: Lower number = checked first. Tier 1 rules use 10-20, Tier 2 uses 50+.

### Managing Rules

| Tool | Description |
|------|-------------|
| `list_routing_rules` | View all routing rules |
| `add_routing_rule` | Create a new rule |
| `update_routing_rule` | Modify an existing rule |
| `delete_routing_rule` | Remove a rule |
| `test_routing` | Preview routing for a task |

## Provider Configuration

### Ollama (Default)

Ollama runs locally and provides free, unlimited LLM inference.

**Setup:**
1. Install Ollama: https://ollama.ai
2. Pull a model: `ollama pull codellama`
3. TORQUE auto-detects at `http://localhost:11434`

**Configuration:**
```
configure_provider { provider: "ollama", settings: { host: "http://localhost:11434" } }
```

### Codex

OpenAI's Codex CLI invoked as a subprocess. Best for greenfield code generation and complex multi-file tasks.

**Setup:**
1. `npm install -g @openai/codex`
2. `codex auth`
3. `export OPENAI_API_KEY=your-key`

### Codex Spark

Same Codex CLI binary, but TORQUE pins the `gpt-5.3-codex-spark` model for faster single-file edits. Shares auth + API key with Codex.

### Claude CLI

Anthropic's Claude Code CLI invoked as a raw subprocess. Best for architectural decisions and complex debugging when you want the interactive agentic loop.

**Setup:**
1. `npm install -g @anthropic-ai/claude-code`
2. `claude auth`

**Configuration:**
```
set_default_provider { provider: "claude-cli" }
```

### Claude Code SDK

Same Claude Code agentic loop, but invoked via the SDK instead of a raw subprocess. Provides structured streaming, a session store, permission-mode control, and skills loading. Shares Claude Code install + auth with `claude-cli`.

Default model: `claude-sonnet-4-20250514`. Permission modes: `auto`, `acceptEdits`, `plan`, `bypassPermissions`.

### claude-ollama (Local + Claude Code harness)

Wraps `ollama launch claude --model <local> -- -p "<prompt>"` so local Ollama models drive the Claude Code harness (Read/Edit/Bash tool loop) instead of the raw prompt-response shape used by the `ollama` provider. Disabled by default.

**Prerequisites:**
- `ollama` binary on PATH (0.20.7+)
- `claude` binary on PATH (Claude Code CLI)
- At least one healthy Ollama host with non-cloud models

Concurrency: 1 task per host (VRAM constraint).

**Not for cloud Ollama models** — cloud tags use SSH-keypair sign-in at ollama.com and can't go through the launcher bridge. Use `ollama-cloud` for those.

```
configure_provider { provider: "claude-ollama", enabled: true }
```

### Anthropic API (Direct)

Direct HTTP calls to the Anthropic API, bypassing CLI overhead.

**Setup:**
1. Set `ANTHROPIC_API_KEY` environment variable

**Configuration:**
```
configure_provider {
  provider: "anthropic",
  settings: { model: "claude-sonnet-4-5-20250929" }
}
```

### Groq

Fast LPU inference via the Groq API.

**Setup:**
1. Set `GROQ_API_KEY` environment variable

**Configuration:**
```
configure_provider {
  provider: "groq",
  settings: { model: "mixtral-8x7b-32768" }
}
```

### DeepInfra (OpenAI-compatible, disabled by default)

DeepInfra provides OpenAI-compatible API access and is provisioned but starts disabled.

- Environment key: `DEEPINFRA_API_KEY`
- Base URL: `https://api.deepinfra.com/v1/openai`
- Concurrency: 200 concurrent requests per model
- Pricing snapshot:
  - `Qwen/Qwen2.5-72B-Instruct` at `$0.13 / 1M input tokens`
  - `Llama-3.1-405B-Instruct` at `$0.80 / 1M input tokens`
- Starts disabled in provider settings.
- Streaming supported (`/chat/completions` with `stream: true`)

### Hyperbolic (OpenAI-compatible, disabled by default)

Hyperbolic provides OpenAI-compatible API access and is provisioned but starts disabled.

- Environment key: `HYPERBOLIC_API_KEY`
- Base URL: `https://api.hyperbolic.xyz/v1`
- Throughput: Pro tier currently supports `120 req/min` for 405B workloads
- Starts disabled in provider settings.
- Pricing snapshot:
  - `Llama-3.1-70B-Instruct` at `$0.40 / 1M input tokens`
- Streaming supported (`/chat/completions` with `stream: true`)

### Cerebras (disabled by default)

Low-latency LPU inference. Used as the primary speed option in the `Cloud Sprint` and `Free Speed` routing template presets.

- Environment key: `CEREBRAS_API_KEY`
- Configure via: `configure_provider { provider: "cerebras", enabled: true }`

### Google AI (disabled by default)

Gemini API access. Used for tasks needing very large context (up to 800K tokens) — `context_stuff` automatically targets `google-ai` when budget overflows other free providers.

- Environment key: `GOOGLE_AI_API_KEY`
- Configure via: `configure_provider { provider: "google-ai", enabled: true }`

### OpenRouter (disabled by default)

Multi-model gateway with a free tier and many paid options.

- Environment key: `OPENROUTER_API_KEY`
- Configure via: `configure_provider { provider: "openrouter", enabled: true }`

### Ollama Cloud (disabled by default)

Remote Ollama-compatible endpoint hosted at `api.ollama.com`. Uses bearer-token auth (distinct from `ollama` which is local HTTP).

- Environment key: `OLLAMA_CLOUD_API_KEY`
- Configure via: `configure_provider { provider: "ollama-cloud", enabled: true }`

## Fallback Chain

When a provider fails, TORQUE falls back through a configured chain:

```
Default: ollama -> codex -> claude-cli
```

Configure the chain:

```
configure_fallback_chain {
  chain: ["ollama", "codex", "claude-cli", "anthropic"]
}
```

### Fallback Triggers

- Provider health check fails
- Task execution timeout
- Rate limit exceeded
- Connection refused
- Model not available

## Model Selection

### Default Model

```
configure { key: "ollama_model", value: "codellama" }
```

### Per-Task Model Override

```
/torque-submit Write docs for auth module model=llama3
```

Or via MCP tool:

```
smart_submit_task { task: "Write docs...", model: "llama3" }
```

### Model-Specific Settings

Each model can have customized tuning:

| Model | Temperature | Top-K | Context | Notes |
|-------|------------|-------|---------|-------|
| `qwen3:8b` | 0.25 | 35 | 8192 | Best for code, balanced speed/quality |
| `codellama` | 0.2 | 30 | 8192 | Optimized for code generation |
| `deepseek-coder` | 0.2 | 30 | 8192 | Optimized for code generation |
| `llama3` | 0.4 | 40 | 8192 | General purpose, balanced |
| `mistral` | 0.5 | 50 | 8192 | Good for writing and explanations |
| `phi3` | 0.3 | 40 | 4096 | Fast, lightweight tasks |

Customize per-model:

```
set_model_settings {
  model: "codellama",
  temperature: 0.15,
  top_k: 25,
  num_ctx: 16384
}
```

### Model-Specific System Prompts

Each model gets a tailored system prompt. View and customize:

```
get_model_prompts {}
set_model_prompt { model: "codellama", prompt: "You are an expert..." }
```

## Instruction Templates

Wrap task descriptions with provider-specific instructions:

```
get_instruction_templates {}
set_instruction_template {
  provider: "ollama",
  template: "You are a code assistant. {TASK_DESCRIPTION}\nFiles: {FILES}"
}
```

Available placeholders:
- `{TASK_DESCRIPTION}` - The original task (required)
- `{FILES}` - Files to be modified
- `{PROJECT}` - Project name

Enable/disable wrapping:

```
toggle_instruction_wrapping { enabled: true }
```

## Provider Statistics

Track provider performance over time:

```
provider_stats { provider: "ollama" }
```

Returns:
- Total tasks, success/failure counts
- Success rate percentage
- Average quality score
- Average duration

### Provider Degradation Detection

Automatically detect when a provider is underperforming:

```
detect_provider_degradation {}
```

Compares recent performance against historical baselines.

## Concurrency

| Setting | Config Key | Default |
|---------|-----------|---------|
| Max concurrent tasks (global) | `max_concurrent` | 3 |
| Max concurrent Codex/Claude | `max_codex_concurrent` | 3 |
| Max concurrent per Ollama host | Per-host setting | Unlimited |

## Rate Limiting

Set rate limits per provider:

```
set_rate_limit {
  provider: "anthropic",
  max_value: 100,
  window_seconds: 60,
  limit_type: "requests",
  enabled: true
}
```

View current limits:

```
get_rate_limits {}
```
