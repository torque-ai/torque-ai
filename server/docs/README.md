# TORQUE Documentation

**T**hreaded **O**rchestration **R**outer for **Q**ueued **U**nit **E**xecution

TORQUE is an MCP (Model Context Protocol) server that enables Claude Code to delegate tasks across multiple execution providers — local LLMs via Ollama and cloud providers like Anthropic and Groq — with intelligent routing, quality safeguards, and real-time monitoring.

## Overview

| Feature | Description |
|---------|-------------|
| **Task Delegation** | Submit tasks to run in parallel while Claude continues working |
| **Smart Routing** | Automatically selects the best provider (local vs cloud) per task |
| **Multi-Host** | Distribute work across multiple Ollama instances on your LAN |
| **Quality Safeguards** | File baselines, stub detection, build checks, auto-rollback |
| **Real-Time Dashboard** | Live WebSocket UI at `http://localhost:3456` |
| **Budget Tracking** | Token usage, cost forecasting, and budget alerts |
| **Workflow Orchestration** | DAG-based pipelines with task dependencies |
| **~590 MCP Tools** | Comprehensive API for task management, validation, and monitoring |

## Quick Start

TORQUE is configured automatically when you open the project in Claude Code:

1. The MCP server starts via `.mcp.json`
2. Slash commands load from `.claude/commands/`
3. Use `/torque-submit` to submit your first task

    /torque-submit Write unit tests for src/utils/parser.js

## Commands

| Command | Purpose |
|---------|---------|
| `/torque-submit [task]` | Submit work — auto-routes provider, captures baselines, configures retry |
| `/torque-status [filter]` | Queue overview — running, queued, failed, hosts, or specific task |
| `/torque-review [task-id]` | Review output — validate, quality score, build check, approve/reject |
| `/torque-workflow [name]` | DAG pipelines — create, add tasks, monitor |
| `/torque-budget` | Cost tracking, budget status, provider performance |
| `/torque-config [setting]` | Configuration — tuning, hardware, safeguards |
| `/torque-cancel [task-id]` | Cancel running or queued tasks |
| `/torque-restart` | Restart the MCP server to apply code changes |

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](architecture.md) | System design, module layout, data flow |
| [Setup Guide](guides/setup.md) | Installation, prerequisites, configuration |
| [Provider Guide](guides/providers.md) | Provider configuration and routing |
| [Multi-Host Guide](guides/multi-host.md) | Setting up remote Ollama hosts |
| [Safeguards](safeguards.md) | Quality gates, validation, rollback |
| [Tool Reference](api/tool-reference.md) | Complete reference for all ~590 MCP tools |
| [Troubleshooting](runbooks/troubleshooting.md) | Common issues and solutions |

Maintainers: add or recategorize providers in `server/providers/registry.js`. Plugin contracts are validated in `server/plugins/plugin-contract.js`, and plugin discovery/loading is wired in `server/plugins/loader.js`.

## Version

TORQUE v2.0.0 — Node.js 24+ — SQLite (better-sqlite3)
