# Getting Started with TORQUE

This guide walks you through installing TORQUE, connecting a provider, and running your first task.

## Prerequisites

- **Node.js 20+** — [download](https://nodejs.org/)
- At least one AI provider (see [Provider Guide](providers.md) for options):
  - **Ollama** (local) — [install](https://ollama.com/)
  - **Codex CLI** or **Claude Code CLI** — installed and authenticated
  - Any cloud API key (DeepInfra, Groq, Anthropic, etc.)

## Install

### npm

```bash
npm install -g torque-ai
```

### Docker

```bash
git clone https://github.com/torque-ai/torque-ai.git
cd torque-ai
docker compose up -d
```

The Docker setup exposes:
- `localhost:3456` — Dashboard
- `localhost:3457` — REST API
- `localhost:3458` — MCP SSE transport

Skip to [Submit a Task](#submit-a-task) if using Docker.

### From Source

```bash
git clone https://github.com/torque-ai/torque-ai.git
cd torque-ai/server
npm install
```

## Initialize

Run the setup wizard in your project directory:

```bash
torque init
```

This scans your environment and generates configuration:

1. **Ollama detection** — checks `localhost:11434` for running Ollama and lists available models
2. **CLI tool detection** — looks for `codex` and `claude` on your PATH
3. **API key detection** — checks environment variables for configured cloud providers
4. **Configuration files** — generates `.mcp.json` (MCP client config) and `.env` (environment template)

Example output:

```
TORQUE — Setup

Scanning for Ollama...
  Found Ollama at http://localhost:11434 with 3 model(s)
    - qwen3-coder:30b
    - codestral:22b
    - llama3.1:8b

Scanning for CLI tools...
  codex: /usr/local/bin/codex
  claude: not found

Checking API keys...
  DeepInfra: configured
  OpenAI (Codex): configured
  Anthropic: not set (ANTHROPIC_API_KEY)
  Groq: not set (GROQ_API_KEY)

Generating configuration...
  Created .mcp.json
  Created .env

——— Setup Complete ———
Available providers: Ollama (local), Codex (CLI), DeepInfra (API)

Next steps:
  1. Start the server:   torque start
  2. Open the dashboard: torque dashboard
  3. Submit a task:      torque submit "Write unit tests for utils.js"
```

## Start the Server

```bash
# Foreground (see logs in terminal)
torque start

# Background (daemon mode)
torque start -d
```

The server starts three services:

| Service | Default Port | Purpose |
|---------|-------------|---------|
| Dashboard | 3456 | Web UI |
| REST API | 3457 | HTTP API |
| MCP SSE | 3458 | MCP client transport |

Verify it's running:

```bash
torque health
```

## Submit a Task

```bash
torque submit "Write unit tests for auth.ts"
```

TORQUE analyzes the task description, determines complexity, selects the best available provider, and dispatches. You'll get a task ID back immediately — the task runs asynchronously.

### Check status

```bash
torque status          # Queue overview
torque list            # All tasks
torque result <id>     # Task output
```

### Preview routing without running

```bash
torque submit --dry-run "Refactor the database module"
```

This shows which provider TORQUE would select and why, without actually running the task.

## Connect to MCP Clients

TORQUE works with Claude Code and any MCP-compatible client. The `torque init` command generates an `.mcp.json` file, or you can create one manually:

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

Once connected, TORQUE exposes tools progressively — starting with core task management and unlocking advanced orchestration as you need it.

## Open the Dashboard

```bash
torque dashboard
```

Or navigate to `http://localhost:3456` in your browser. The dashboard provides:

- **Kanban board** — real-time task flow across queued, running, and completed states
- **Provider health** — status, success rates, and performance for each provider
- **Budget tracking** — per-provider usage and trend analysis
- **Workflow visualization** — DAG view of dependent task chains

## Next Steps

- **[Provider Guide](providers.md)** — configure all 12 providers, set API keys, tune routing
- **[Troubleshooting](troubleshooting.md)** — common issues and solutions
- **[CLAUDE.md](../../CLAUDE.md)** — full architecture reference, workflows, policy engine, and all MCP tools
