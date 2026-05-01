# TORQUE Plugin Modernization — Cross-Platform Skills, Agents, and CLI

**Date:** 2026-03-19
**Status:** Draft

## Problem

TORQUE works primarily on Claude Code via MCP SSE. Other platforms (Codex, Gemini CLI, Cursor) can't use it or have limited access. TORQUE lacks modern plugin patterns — no SessionStart context injection, no dispatchable agents, and no cross-platform instruction files. Users start conversations blind (no task status), and there's no way to use TORQUE from Gemini CLI or other non-MCP platforms.

## Current State

Before defining work, here's what already exists:

| Component | Status | Location |
|-----------|--------|----------|
| MCP Server | Complete | `server/index.js` (SSE on 3458, REST on 3457) |
| Node.js CLI | Complete | `cli/torque-cli.js` + `cli/commands.js` + `cli/api-client.js` |
| 8 Skills | Complete | `skills/torque-{submit,review,workflow,status,cancel,budget,config,restart}/SKILL.md` |
| 8 Slash Commands | Complete | `.claude/commands/torque-{submit,review,workflow,status,cancel,budget,config,restart}.md` |
| Plugin Manifest | Complete | `.claude-plugin/plugin.json` with MCP server config |
| Hooks | Missing | No `hooks/` directory |
| Agents | Missing | No `agents/` directory |
| Cross-platform files | Missing | No `CODEX.md`, `AGENTS.md`, `GEMINI.md` |
| SessionStart injection | Missing | No conversation context injection |
| Tool mapping references | Missing | No cross-platform tool mapping docs |

## Solution — Delta Work Only

Five components, scoped to what's genuinely new:

1. **CLI exposure** — ensure existing Node.js CLI is on PATH and documented for non-MCP platforms
2. **SessionStart hook** — inject orientation + live status at conversation start
3. **Agent definitions** — TORQUE-aware dispatchable agents (new)
4. **Reference skills** — tool mapping and Codex equivalents (new)
5. **Cross-platform files** — `CODEX.md`, `AGENTS.md`, `GEMINI.md` (new)

## Design Decisions

- **Parallel cross-platform design.** All new content works on Claude Code, Codex, and Gemini from the start.
- **Reuse existing CLI for non-MCP platforms.** The Node.js CLI (`cli/torque-cli.js`) already wraps the REST API with proper error handling. No bash+curl reimplementation needed. Just ensure it's on PATH.
- **Existing skills stay as-is.** All 8 skills already exist and work. Add 2 reference skills for tool mapping.
- **Superpowers patterns for hooks and agents.** Polyglot `run-hook.cmd` wrapper, extensionless scripts, frontmatter-based agent definitions.

## Platform Compatibility Matrix

| Platform | MCP | Skills | Agents | Hooks | Commands | Instructions | TORQUE Access |
|----------|-----|--------|--------|-------|----------|-------------|---------------|
| Claude Code | Yes | Yes | Yes | Yes | Yes | `CLAUDE.md` | MCP (native) |
| Codex | Yes | Yes | Yes | Yes | Yes | `CODEX.md` / `AGENTS.md` | MCP (native) |
| Gemini CLI | No | No | No | No | No | `GEMINI.md` | `torque-cli` (REST) |
| Cursor | Yes | Partial* | Partial* | Yes | Partial* | `CLAUDE.md` | MCP (native) |
| Shell / CI | No | No | No | No | No | N/A | `torque-cli` (REST) |

*Cursor: MCP tools work. Skills, agents, and commands may not load depending on Cursor's Claude Code compatibility layer. TORQUE degrades to MCP-only on Cursor.

## 1. CLI Exposure

### Current State

The Node.js CLI at `cli/torque-cli.js` already implements:
- `submit`, `status`, `cancel`, `health`, `await`, `workflow`, `list`, `result`, `decompose`, `diagnose`, `review`, `benchmark`
- Proper API client (`cli/api-client.js`) with timeout handling and structured errors
- Entry point at `bin/torque.js`

### What's Needed

1. **Symlink or PATH entry** — ensure `torque-cli` is callable from any directory. Add `~/bin/torque-cli` that invokes `node <path>/cli/torque-cli.js "$@"`.
2. **Verify REST endpoints** — audit `cli/commands.js` against actual Express routes to confirm all subcommands work. Document any MCP tools that lack REST equivalents.
3. **Document in `GEMINI.md`** — the CLI is the primary TORQUE interface for Gemini users.

### SSE-based `await`

The existing CLI is Node.js (not bash), so it can use SSE subscription for the `await` subcommand instead of polling. If the current implementation polls, consider adding `--sse` mode that subscribes to the SSE endpoint for instant wakeup. This is a nice-to-have, not blocking.

## 2. SessionStart Hook

### Hook Structure

```
hooks/
  hooks.json           — hook configuration for Claude Code
  hooks-cursor.json    — Cursor-specific hook config
  run-hook.cmd         — polyglot CMD/bash wrapper (superpowers pattern)
  session-start        — extensionless bash script
```

### `hooks.json`

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|clear|compact",
      "hooks": [{
        "type": "command",
        "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start"
      }]
    }]
  }
}
```

Matcher rationale: `startup` = new session, `clear` = conversation cleared, `compact` = context compacted. All three benefit from re-injecting TORQUE state since prior context is gone.

### `session-start` Script

1. Determine script location via `dirname "$0"` (works even when `CLAUDE_PLUGIN_ROOT` is unset, e.g., git clone installs)
2. Call `curl -s --max-time 2 http://127.0.0.1:3457/api/health` for provider status
3. Call `curl -s --max-time 2 http://127.0.0.1:3457/api/tasks?status=running,queued` for task counts
4. Detect project from `$PWD`
5. Format brief context summary
6. Output JSON: `hookSpecificOutput.additionalContext` for Claude Code, `additional_context` for Cursor

### Injected Context (TORQUE running)

```
TORQUE is available. Status: 3 tasks running, 2 queued, 0 failed.
Providers: ollama (remote-gpu-host, healthy), codex (ready).
Project: torque-public | Verify: npx vitest run

Use /torque-submit to submit tasks, /torque-status to check progress.
Use await_task with heartbeat_minutes for progress check-ins.
```

### Injected Context (TORQUE not running)

```
TORQUE is installed but not running.
Start with: <start command from project config>

Skills and commands are available but MCP tools will not work until the server starts.
```

### Polyglot Wrapper

`run-hook.cmd` — copied from superpowers pattern. Single file that works as CMD batch + bash script. Finds Git Bash on Windows, runs extensionless scripts portably.

## 3. Agent Definitions

### Agents to Create

| Agent | File | Model | Purpose |
|-------|------|-------|---------|
| `task-reviewer` | `agents/task-reviewer.md` | sonnet | Review completed task output — quality check, stub detection, approve/flag. Uses sonnet for nuanced quality judgment. |
| `workflow-architect` | `agents/workflow-architect.md` | inherit | Design DAG workflows from specs — dependency analysis, task splitting, provider selection. Inherits parent model for full reasoning. |
| `batch-monitor` | `agents/batch-monitor.md` | haiku | Monitor running workflows — heartbeat checks, stall handling, failure resubmission. Fast model for monitoring loops. |

Model rationale: `task-reviewer` needs quality judgment (sonnet). `workflow-architect` needs full reasoning (inherit = parent's model). `batch-monitor` is a monitoring loop (haiku = fast/cheap). On Codex, the `model` field may be handled differently — agents should work regardless of whether the platform respects model hints.

### Agent Format

Markdown with frontmatter (same as superpowers):

```markdown
---
name: task-reviewer
description: |
  Use when a TORQUE task has completed and needs quality review.
  Examples: "review task abc123", "check the output of that task"
model: sonnet
---

You are a TORQUE Task Reviewer. [System prompt...]
```

### Cross-Platform

- **Claude Code** — `agents/` directory, dispatched via `Agent` tool
- **Codex** — same agents replicated in `AGENTS.md` for Codex's agent system
- **Gemini** — agents not available (no dispatch mechanism)

## 4. Reference Skills

Two new skills for cross-platform tool mapping:

### `skills/references/tool-mapping.md`

Maps every MCP tool to its REST API equivalent and `torque-cli` subcommand:

```markdown
| MCP Tool | REST Endpoint | torque-cli |
|----------|--------------|------------|
| submit_task | POST /api/tasks | torque-cli submit |
| smart_submit_task | POST /api/tasks (auto_route) | torque-cli submit |
| check_status | GET /api/tasks/:id | torque-cli status <id> |
| get_result | GET /api/tasks/:id | torque-cli result <id> |
| cancel_task | DELETE /api/tasks/:id | torque-cli cancel <id> |
| await_task | GET /api/tasks/:id (poll) | torque-cli await <id> |
| check_ollama_health | GET /api/health | torque-cli health |
| list_tasks | GET /api/tasks | torque-cli list |
| create_workflow | POST /api/workflows | torque-cli workflow create |
| workflow_status | GET /api/workflows/:id | torque-cli workflow status <id> |
```

### `skills/references/codex-tools.md`

Codex-specific notes: tool name mapping (Codex may prefix MCP tools differently), agent dispatch differences, any Codex-specific limitations or advantages.

## 5. Cross-Platform Files

### `CODEX.md`

Contents:
- TORQUE overview (purpose, architecture)
- MCP tools available (same as Claude Code — Codex has MCP)
- Remote workstation rules (`torque-remote` for heavy commands)
- Heartbeat await patterns (`heartbeat_minutes`)
- Reference to skills and agents
- Project-specific defaults

Maintained separately from `CLAUDE.md` to allow Codex-specific instructions. Core rules (remote workstation, heartbeat patterns) are duplicated — accepted tradeoff for platform independence.

### `AGENTS.md`

Three agent definitions from Section 3, formatted for Codex's agent spec. Same content as `agents/` markdown files but in Codex's expected format.

### `GEMINI.md`

Contents:
- TORQUE overview
- `torque-cli` usage for all operations (primary interface)
- Tool mapping table (from reference skill)
- Note: MCP tools, skills, and agents not available on Gemini

### `gemini-extension.json`

```json
{
  "name": "torque",
  "description": "AI task orchestration with multi-provider routing",
  "version": "2.1.0",
  "contextFileName": "GEMINI.md"
}
```

Note: Gemini CLI extension support is evolving. This file follows the superpowers pattern. If the format changes, update accordingly.

### Plugin Manifest Update

Add hooks, skills, and agents paths to `.claude-plugin/plugin.json`. Preserve the existing `mcpServers` section:

```json
{
  "name": "torque",
  "version": "2.2.0",
  "mcpServers": { ... },
  "hooks": "./hooks/hooks.json",
  "skills": "./skills",
  "agents": "./agents",
  "commands": "./.claude/commands"
}
```

## Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `~/bin/torque-cli` | Create | Wrapper that invokes existing Node CLI |
| `hooks/hooks.json` | Create | SessionStart hook config |
| `hooks/hooks-cursor.json` | Create | Cursor hook config |
| `hooks/run-hook.cmd` | Create | Polyglot wrapper |
| `hooks/session-start` | Create | Status injection script |
| `agents/task-reviewer.md` | Create | Quality review agent |
| `agents/workflow-architect.md` | Create | DAG design agent |
| `agents/batch-monitor.md` | Create | Monitoring agent |
| `skills/references/tool-mapping.md` | Create | Cross-platform tool mapping |
| `skills/references/codex-tools.md` | Create | Codex-specific notes |
| `CODEX.md` | Create | Codex instructions |
| `AGENTS.md` | Create | Codex agent definitions |
| `GEMINI.md` | Create | Gemini instructions + CLI usage |
| `gemini-extension.json` | Create | Gemini plugin manifest |
| `.claude-plugin/plugin.json` | Modify | Add hooks/skills/agents/commands paths |

Existing skills and commands are NOT modified — they already work.

## Testing Strategy

### CLI exposure
- `torque-cli` wrapper invokes the Node CLI correctly
- `torque-cli health` returns provider status when TORQUE is running
- `torque-cli health` shows clear error when TORQUE is not running

### SessionStart hook
- TORQUE running → injects status with task counts and provider info
- TORQUE not running → injects orientation with start instructions
- Output format correct for Claude Code (`hookSpecificOutput`)
- Output format correct for Cursor (`additional_context`)
- API timeout (2s max) doesn't block conversation start
- Works from git clone install (no `CLAUDE_PLUGIN_ROOT`)

### Agents
- Agent frontmatter has correct fields (name, description, model)
- Agent descriptions include trigger examples
- Agents reference correct MCP tools
- `AGENTS.md` content matches `agents/` directory

### Reference skills
- Tool mapping covers all MCP tools with REST equivalents
- Missing REST endpoints (if any) are documented

### Cross-platform files
- `CODEX.md` contains all necessary TORQUE instructions
- `AGENTS.md` contains all three agent definitions
- `GEMINI.md` references `torque-cli` for all operations
- `gemini-extension.json` is valid JSON
- `plugin.json` has hooks/skills/agents/commands and preserves mcpServers
