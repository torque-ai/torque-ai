# TORQUE

Stop babysitting your AI coding tools.

[![License: BSL-1.1](https://img.shields.io/badge/License-BSL--1.1-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

Submit coding tasks, walk away, come back to verified results. TORQUE picks the right AI, validates the output, retries on failure, and tracks costs — so you can focus on the work that matters.

## Quick Start

```bash
npm install -g torque-ai
torque init
torque start
torque submit "Create a REST API for user management"
```

## What Just Happened?

TORQUE analyzed your task, routed it to the best available AI provider, watched it execute, checked the output for stubs and truncation, scored the quality, and showed you the result. If it had failed, it would have retried on a different provider automatically.

## Features

- **10 Execution Providers** — Ollama (free, local), Codex, Claude CLI, Anthropic, DeepInfra, Hyperbolic, Groq, and more
- **Smart Routing** — Automatically picks the best provider based on task complexity
- **77 Quality Safeguards** — Stub detection, truncation checks, build verification, auto-retry
- **DAG Workflows** — Chain dependent tasks with parallel execution
- **Cost Tracking** — See where every dollar goes, set budgets, get alerts
- **Web Dashboard** — Real-time Kanban board, provider health, budget analytics
- **Multi-Host** — Distribute work across LAN Ollama instances with auto-discovery
- **Strategic Brain** — AI-powered feature decomposition and failure diagnosis
- **MCP Native** — Works with Claude Code and other MCP clients
- **REST API** — 580 endpoints with OpenAPI documentation
- **CLI** — Full command-line interface for all operations

## Works With

| Provider | Type | Cost |
|----------|------|------|
| Ollama | Local (free) | $0 |
| Codex | Cloud | Per-token |
| Claude CLI | Cloud | Per-token |
| DeepInfra | Cloud | $0.13-1.00/M tokens |
| Groq | Cloud | Free tier available |
| Anthropic | Cloud | Per-token |
| Hyperbolic | Cloud | $0.40-4.00/M tokens |

Bring your own API keys. TORQUE routes to the right one.

## Installation

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
```

## CLI Commands

```bash
# Task management
torque submit "Write tests for auth.ts"     # Submit and watch
torque submit --dry-run "Refactor db.js"    # Preview routing without running
torque status                                # Queue overview
torque list --status=running                 # Filter tasks
torque result <task-id>                      # View output
torque cancel <task-id>                      # Cancel task

# Workflows
torque workflow create "Feature" --task "types" --task "impl" --task "tests"
torque decompose "Build user auth system"    # AI-powered task splitting

# Providers
torque provider list                         # Show all providers
torque health                                # Check connectivity

# Cost & budget
torque budget                                # Cost overview
torque budget --forecast                     # Trend analysis

# Server
torque init                                  # Setup wizard
torque start                                 # Start server
torque stop                                  # Stop server
torque dashboard                             # Open web UI
```

## Dashboard

The web dashboard at `http://localhost:3456` provides:
- **Kanban** — Real-time task flow (queued → running → completed)
- **Providers** — Health, success rates, performance comparison
- **Budget** — Cost tracking, monthly trends, budget alerts
- **Workflows** — DAG visualization, dependency tracking
- **Hosts** — Multi-host Ollama management

## Documentation

- [Getting Started](docs/guides/getting-started.md)
- [Provider Guide](docs/guides/providers.md)
- [Workflow Guide](docs/tools/workflows.md)
- [Configuration](docs/configuration-reference.md)
- [Troubleshooting](docs/guides/troubleshooting.md)
- [API Reference](docs/api/) — also at `GET /api/openapi.json`

## Pricing

**Free forever** for individual use with local Ollama. Pro ($9/mo) removes scale limits.

| | Free | Pro |
|---|---|---|
| All providers (BYOK) | ✓ | ✓ |
| Smart routing | ✓ | ✓ |
| Dashboard | ✓ | ✓ |
| Concurrent tasks | 5 | Unlimited |
| Ollama hosts | 1 | Unlimited |
| Workflow nodes | 5 | Unlimited |
| Multi-host LB | — | ✓ |
| Scheduling | — | ✓ |
| All safeguards | — | ✓ |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and PR process.

## License

[Business Source License 1.1](LICENSE) — free for any purpose except offering as a commercial hosted service. Converts to Apache 2.0 after 3 years.

## Community

- [GitHub Discussions](https://github.com/torque-ai/torque-ai/discussions)
- [Discord](https://discord.gg/torque-ai)
