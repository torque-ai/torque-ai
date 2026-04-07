# TORQUE

A dark software factory for Claude Code.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)

TORQUE turns Claude Code into an autonomous software factory. It discovers what needs building, plans the work, dispatches tasks across local and cloud LLM providers in parallel, verifies quality, auto-remediates failures, and cuts releases — with you as the architect at the control panel.

## Requirements

- **Claude Code** — Claude is the architect; TORQUE is the factory floor.
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

Claude Code talks to TORQUE through MCP (Model Context Protocol). The factory operates as an autonomous pipeline:

1. **Discover** — Scouts scan the codebase for issues, missing tests, security gaps, and visual regressions
2. **Plan** — Claude architects the work and TORQUE generates task DAGs with dependency ordering
3. **Route** — Smart routing analyzes each task's complexity and dispatches to the best available provider
4. **Execute** — Local LLMs, cloud APIs, and CLI tools run tasks in parallel across your infrastructure
5. **Verify** — Quality gates check for stubs, truncation, build failures, and regressions automatically
6. **Remediate** — Failures are diagnosed and resubmitted with error context — no manual intervention
7. **Release** — Version bumps, changelogs, and git tags are cut from task metadata

You set the direction. The factory runs lights-out.

## Providers

TORQUE ships with support for several provider types. What's available depends on what you have installed and configured.

| Type | Examples | Setup |
|------|----------|-------|
| **Local LLM** | Ollama (any model you've pulled) | Install Ollama, pull a model, TORQUE auto-discovers |
| **CLI Tools** | Codex, Claude Code | Install the CLI, authenticate, enable in TORQUE |
| **Cloud APIs** | DeepInfra, Groq, Cerebras, Google AI, Hyperbolic, OpenRouter | Set your API key, enable the provider |

Additional providers can be configured through Claude — ask it to run `configure_provider` or `add_ollama_host` to add new providers, models, or remote Ollama instances on your LAN. Provider routing, fallback chains, and model assignments are all configurable at runtime.

## Features

- **Scout Discovery** — Automated codebase scanning for security issues, quality gaps, missing tests, performance problems, and visual regressions
- **Smart Routing** — Analyzes task complexity and routes to the best provider based on health, capacity, cost, and capability
- **DAG Workflows** — Dependency-ordered task graphs with parallel execution and automatic output injection
- **Auto-Remediation** — Failed tasks are diagnosed, retried with error context, and re-routed through provider fallback chains
- **Quality Gates** — Stub detection, truncation checks, build verification, approval gates, and regression detection
- **Visual Verification** — Automated UI capture and analysis via `peek_ui` — the factory inspects its own output
- **Auto-Release** — Semver bumps, changelogs, and git tags generated from task metadata on completion
- **Team Pipeline** — Planner → QC → Remediation loop with streaming verdicts and dual-pass testing
- **Multi-Host** — Distribute work across LAN Ollama instances with auto-discovery and load balancing
- **Cost Tracking** — Per-provider usage tracking, budget alerts, and automatic routing downgrades
- **Policy Engine** — Rule-based governance with shadow enforcement and architecture boundaries
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
