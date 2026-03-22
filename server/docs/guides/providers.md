# Provider Guide

TORQUE routes tasks across multiple execution providers, balancing cost, speed, and quality.

## Providers

| Provider | ID | Execution | Cost | Best For |
|----------|----|-----------|------|----------|
| **Ollama (direct)** | `ollama` | Local HTTP | Free | Text generation, docs |
| **Ollama (hashline)** | `hashline-ollama` | Local HTTP | Free | Targeted file edits |
| **Claude CLI** | `claude-cli` | Cloud API | Paid | Complex tasks, architecture |
| **Codex** | `codex` | Cloud API | Paid | Multi-file refactoring |
| **Anthropic API** | `anthropic` | Cloud HTTP | Paid | Direct API access |
| **Groq** | `groq` | Cloud HTTP | Paid | Fast inference |
| **DeepInfra** | `deepinfra` | OpenAI-compatible Cloud API | Paid | High-throughput batch model routing |
| **Hyperbolic** | `hyperbolic` | OpenAI-compatible Cloud API | Paid | High-capacity 70B–405B inference |

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
| Simple tests | write test, add test, unit test | `hashline-ollama` |
| Commit messages | commit message, git commit | `ollama` |
| Code explanation | explain, what does, how does | `ollama` |
| Simple refactoring | rename, move, extract, inline | `hashline-ollama` |
| Config edits | .json, .yaml, .yml, .toml, .ini, .env | `hashline-ollama` |
| Boilerplate | boilerplate, scaffold, template | `hashline-ollama` |

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

### Claude CLI

Uses Anthropic's Claude via the `claude` CLI tool.

**Setup:**
1. Install Claude CLI
2. Set `ANTHROPIC_API_KEY` environment variable
3. No additional configuration needed

**Configuration:**
```
set_default_provider { provider: "claude-cli" }
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

## Fallback Chain

When a provider fails, TORQUE falls back through a configured chain:

```
Default: hashline-ollama -> codex -> claude-cli
```

Configure the chain:

```
configure_fallback_chain {
  chain: ["hashline-ollama", "ollama", "codex", "claude-cli", "anthropic"]
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
  provider: "hashline-ollama",
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
provider_stats { provider: "hashline-ollama" }
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
