# TORQUE

A Claude Code plugin for distributed AI task execution.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)

TORQUE adds multi-provider task orchestration to Claude Code. Instead of running one task at a time in your terminal, Claude can dispatch work to local LLMs, cloud APIs, and CLI tools in parallel — then monitor the output, check for quality issues, and retry on a different provider if something fails.

## Requirements

- **Claude Code** — TORQUE is a Claude Code plugin. Claude is the orchestrator; TORQUE is the execution layer.
- **Node.js 20+**
- **At least one execution provider** — Ollama (free, local), Codex CLI, or any supported cloud API key

## Quick Start

```bash
# Install
git clone https://github.com/torque-ai/torque-ai.git
cd torque-ai/server && npm install

# Start the server
node index.js
```

On first startup, TORQUE registers itself as an MCP server in your Claude Code configuration. Open any Claude Code session and TORQUE's tools are available immediately.

### Your first task through Claude

Tell Claude what you need. Claude decides when to use TORQUE:

> "Write unit tests for auth.ts"

Claude analyzes the task, calls TORQUE's `smart_submit_task` tool, and TORQUE selects the best available provider, dispatches the work, monitors the output for stubs and truncation, verifies the build, and returns the result. If the provider fails, TORQUE retries on the next one in the fallback chain.

> "Refactor the payment module and write tests for it — run both in parallel"

Claude creates a TORQUE workflow with two tasks, routes each to the appropriate provider, and monitors both simultaneously.

## How It Works

Claude Code talks to TORQUE through MCP (Model Context Protocol). When Claude needs to execute a coding task, it calls TORQUE's tools:

1. **Claude submits a task** — via `smart_submit_task` or `create_workflow`
2. **TORQUE routes it** — analyzes complexity, checks provider health, picks the best available option
3. **The provider executes** — Ollama, Codex, a cloud API, whatever is available and appropriate
4. **TORQUE monitors** — watches for stubs, truncation, quality regressions, and build failures
5. **Results come back to Claude** — who reviews them and decides what to do next

Claude stays in the driver seat. TORQUE handles the infrastructure.

## Providers

TORQUE ships with support for several provider types. What's available depends on what you have installed and configured.

| Type | Examples | Setup |
|------|----------|-------|
| **Local LLM** | Ollama (any model you've pulled) | Install Ollama, pull a model, TORQUE auto-discovers |
| **CLI Tools** | Codex, Claude Code | Install the CLI, authenticate, enable in TORQUE |
| **Cloud APIs** | DeepInfra, Groq, Cerebras, Google AI, Hyperbolic, OpenRouter | Set your API key, enable the provider |

Additional providers can be configured through Claude — ask it to run `configure_provider` or `add_ollama_host` to add new providers, models, or remote Ollama instances on your LAN. Provider routing, fallback chains, and model assignments are all configurable at runtime.

## Features

- **Smart Routing** — Automatically picks the best provider based on task complexity, provider health, and capacity
- **Quality Safeguards** — Stub detection, truncation checks, build verification, approval gates, and auto-retry with provider fallback
- **DAG Workflows** — Chain dependent tasks with parallel execution and automatic output injection
- **Cost Tracking** — Per-provider usage tracking, budget alerts, and automatic routing downgrades when budgets are hit
- **Multi-Host** — Distribute work across LAN Ollama instances with auto-discovery and load balancing
- **Policy Engine** — Rule-based governance with shadow enforcement and architecture boundaries
- **Provider Scoring** — Tracks reliability, speed, cost, and quality per provider to improve routing over time
- **Circuit Breaker** — Detects systemic provider failures and auto-disables affected providers with recovery probes
- **Web Dashboard** — Real-time Kanban board, provider health, workflow visualization at `http://localhost:3456`

## Dashboard

The web dashboard at `http://localhost:3456` provides:

- **Kanban** — Real-time task flow (queued, running, completed)
- **Providers** — Health, success rates, performance comparison
- **Budget** — Usage tracking, monthly trends, budget alerts
- **Workflows** — DAG visualization, dependency tracking
- **Hosts** — Multi-host Ollama management
- **Routing** — Configure provider routing rules per task category

## Configuration

Most configuration happens through Claude. Ask Claude to:

- `set_project_defaults` — Configure default provider, verify command, auto-fix settings per project
- `configure_provider` — Enable/disable providers, set API keys
- `add_ollama_host` — Register additional Ollama instances on your LAN
- `activate_routing_template` — Switch between routing strategies (Quality First, Cost Saver, etc.)

TORQUE also has a REST API on port 3457 and a direct CLI (`torque-cli`) for scripting, but normal usage is through Claude Code.

## Documentation

- [CLAUDE.md](CLAUDE.md) — Full reference for MCP tools, providers, workflows, and configuration
- [CONTRIBUTING.md](CONTRIBUTING.md) — Development setup, code style, and PR process

## License

[MIT](LICENSE)

## Community

- [GitHub Discussions](https://github.com/torque-ai/torque-ai/discussions)
- [Discord](https://discord.gg/torque-ai)
