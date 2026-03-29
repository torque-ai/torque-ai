# TORQUE

Your AI providers are specialists. TORQUE is the control tower.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)

Route coding tasks to the right model, validate the output, retry on failure, track costs — all from one command. Run 10 tasks in parallel across every provider you have instead of juggling terminal tabs.

## Why TORQUE?

If you use AI coding tools, you already know the problem: you have Claude Code for hard architecture decisions, Codex for fast multi-file edits, a local Ollama instance for free private tasks, and maybe a DeepInfra or Groq key for cheap batch work. But you're the router — manually deciding which tool to use, copy-pasting context between them, and losing track of what's running where.

TORQUE sits between you and all of your AI providers. You describe the task, TORQUE figures out which provider handles it best, dispatches it, monitors the output for quality issues, and retries on a different provider if something fails. Instead of running one task at a time in your terminal, you can queue up 10 tasks and let them execute in parallel across every provider you have.

**What that looks like in practice:**

- "Write tests for auth.ts" → routes to Codex (multi-file generation), validates output, verifies build
- "Add a docstring to utils.py" → routes to your local Ollama (free, fast, private)
- "Refactor the payment module" → routes to Claude Code (complex reasoning), captures file baselines, checks for regressions
- All three run simultaneously. You review when they're done.

**You don't need all 12 providers to start.** TORQUE works with just Ollama, or just one cloud API key, or just Codex. Add more providers later and smart routing adapts automatically.

## Quick Start

### npm (recommended)

```bash
npm install -g torque-ai
torque init
torque start
```

### Docker

```bash
docker compose up -d
```

### From Source

```bash
git clone https://github.com/torque-ai/torque-ai.git
cd torque-ai/server && npm install
node index.js
```

### Submit your first task

```bash
torque submit "Write unit tests for auth.ts"
```

TORQUE analyzes the task, selects the best available provider, and dispatches. While it executes, output is monitored for stubs, truncation, and quality regressions. If the provider fails, TORQUE retries on the next one in the fallback chain. You get verified results — or a clear explanation of what went wrong.

## Features

- **12 Execution Providers** — Local LLMs (Ollama), CLI tools (Codex, Claude Code), and cloud APIs (DeepInfra, Anthropic, Groq, and more)
- **Smart Routing** — Automatically picks the best provider based on task complexity, provider health, and available capacity
- **Quality Safeguards** — Stub detection, truncation checks, build verification, approval gates, and auto-retry with provider fallback
- **DAG Workflows** — Chain dependent tasks with parallel execution and automatic output injection
- **Cost Tracking** — Per-provider usage tracking, budget alerts, and trend analysis
- **Web Dashboard** — Real-time Kanban board, provider health monitoring, workflow DAG visualization
- **Multi-Host** — Distribute work across LAN Ollama instances with auto-discovery and load balancing
- **Policy Engine** — Rule-based governance with shadow enforcement, architecture boundaries, and release gates
- **MCP Native** — Works with Claude Code and any MCP-compatible client via stdio or SSE transport
- **REST API** — Full HTTP API with OpenAPI documentation
- **CLI** — Complete command-line interface for all operations

## Providers

TORQUE routes between 12 execution providers. Smart routing picks the best one automatically — you rarely need to choose manually.

| Provider | Type | Best For |
|----------|------|----------|
| **Ollama** | Local | General prompts, documentation, brainstorming |
| **Hashline-Ollama** | Local | Targeted single-file edits (highest precision) |
| **Codex** | CLI | Complex multi-file tasks, greenfield code generation |
| **Codex Spark** | CLI | Fast single-file edits |
| **Claude Code** | CLI | Architectural decisions, complex debugging |
| **Anthropic** | API (BYOK) | Direct Claude API tasks |
| **DeepInfra** | API (BYOK) | High-concurrency batch work |
| **Hyperbolic** | API (BYOK) | Large models (70B–405B), fast output |
| **Groq** | API (BYOK) | Low-latency general tasks |
| **Cerebras** | API (BYOK) | Fast inference |
| **Google AI** | API (BYOK) | Large context windows (800K+ tokens) |
| **OpenRouter** | API (BYOK) | Multi-model gateway |

**BYOK** = Bring Your Own Key. Set your API key as an environment variable and enable the provider.

## CLI Commands

```bash
# Task management
torque submit "Write tests for auth.ts"     # Submit and route automatically
torque submit --dry-run "Refactor db.js"    # Preview routing without running
torque status                                # Server status and queue overview
torque list --status=running                 # Filter tasks by status
torque result <task-id>                      # View task output
torque cancel <task-id>                      # Cancel a task

# Workflows
torque workflow create "Feature" --task "types" --task "impl" --task "tests"
torque decompose "Build user auth system"    # AI-powered task decomposition

# Providers
torque health                                # Check provider connectivity

# Cost tracking
torque budget                                # Usage overview
torque budget --forecast                     # Trend analysis

# Server
torque init                                  # Setup wizard
torque start                                 # Start server (foreground)
torque start -d                              # Start server (background)
torque stop                                  # Stop server
torque dashboard                             # Open web dashboard
```

## Dashboard

The web dashboard at `http://localhost:3456` provides:

- **Kanban** — Real-time task flow (queued → running → completed)
- **Providers** — Health, success rates, performance comparison
- **Budget** — Usage tracking, monthly trends, budget alerts
- **Workflows** — DAG visualization, dependency tracking
- **Hosts** — Multi-host Ollama management
- **Routing Templates** — Configure provider routing rules per task category

## MCP Integration

TORQUE speaks [MCP](https://modelcontextprotocol.io/) natively. To use it with Claude Code or any MCP client, add this to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "torque": {
      "type": "sse",
      "url": "http://127.0.0.1:3458/sse",
      "description": "TORQUE — Distributed AI task orchestration"
    }
  }
}
```

Or use the setup wizard to generate it automatically:

```bash
torque init
```

Once connected, TORQUE exposes its tools progressively — starting with core task management and unlocking advanced orchestration as needed.

## Documentation

- [Getting Started](docs/guides/getting-started.md) — install, configure, submit your first task
- [Provider Guide](docs/guides/providers.md) — all 12 providers, setup, routing, multi-host
- [Troubleshooting](docs/guides/troubleshooting.md) — common issues and solutions
- [Architecture](docs/architecture.md) — system design and internals
- [CLAUDE.md](CLAUDE.md) — full reference for MCP tools, workflows, and configuration

## Recommended Companion: Superpowers

TORQUE handles orchestration — where and how your tasks execute. For the best development workflow, pair it with [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent for brainstorming, TDD, systematic debugging, and code review.

Together: Superpowers helps you plan and structure work. TORQUE executes it across your providers in parallel.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and PR process.

## License

[MIT](LICENSE)

## Community

- [GitHub Discussions](https://github.com/torque-ai/torque-ai/discussions)
- [Discord](https://discord.gg/torque-ai)
