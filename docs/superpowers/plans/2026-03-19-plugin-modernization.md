# Plugin Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TORQUE a cross-platform plugin with SessionStart context injection, dispatchable agents, and support for Codex/Gemini/Cursor alongside Claude Code.

**Architecture:** New hooks, agents, and platform files — no changes to existing skills, commands, or MCP server. CLI wrapper for PATH access. All new files are markdown or bash scripts — no Node.js changes except `plugin.json`.

**Tech Stack:** Bash, jq, curl, Markdown (skills/agents), JSON (configs)

**Spec:** `docs/superpowers/specs/2026-03-19-plugin-modernization-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `hooks/hooks.json` | Create | SessionStart hook config for Claude Code |
| `hooks/hooks-cursor.json` | Create | SessionStart hook config for Cursor |
| `hooks/run-hook.cmd` | Create | Polyglot CMD/bash wrapper |
| `hooks/session-start` | Create | Status injection script |
| `agents/task-reviewer.md` | Create | Quality review agent |
| `agents/workflow-architect.md` | Create | DAG design agent |
| `agents/batch-monitor.md` | Create | Monitoring agent |
| `skills/references/tool-mapping.md` | Create | MCP → REST → CLI mapping |
| `skills/references/codex-tools.md` | Create | Codex-specific notes |
| `~/bin/torque-cli` | Create | PATH wrapper for existing Node CLI |
| `CODEX.md` | Create | Codex instructions |
| `AGENTS.md` | Create | Codex agent definitions |
| `GEMINI.md` | Create | Gemini instructions + CLI usage |
| `gemini-extension.json` | Create | Gemini plugin manifest |
| `.claude-plugin/plugin.json` | Modify | Add hooks/skills/agents paths |

---

## Task 1: SessionStart Hook

**Files:**
- Create: `hooks/hooks.json`
- Create: `hooks/hooks-cursor.json`
- Create: `hooks/run-hook.cmd`
- Create: `hooks/session-start`

- [ ] **Step 1: Create hooks directory**

```bash
mkdir -p hooks
```

- [ ] **Step 2: Create `hooks/hooks.json`**

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

- [ ] **Step 3: Create `hooks/hooks-cursor.json`**

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|clear|compact",
      "hooks": [{
        "type": "command",
        "command": "\"${CURSOR_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start"
      }]
    }]
  }
}
```

- [ ] **Step 4: Create `hooks/run-hook.cmd`**

Copy the polyglot wrapper pattern from superpowers (`~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.5/hooks/run-hook.cmd`). This is a proven cross-platform wrapper — CMD batch on Windows, bash on Unix, finds Git Bash automatically.

Read the superpowers version first, then create an identical copy adapted for TORQUE.

- [ ] **Step 5: Create `hooks/session-start`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# SessionStart hook — injects TORQUE status into conversation context

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TORQUE_API="http://127.0.0.1:3457"

# Escape string for JSON embedding
escape_for_json() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

# Try to get TORQUE status
status_text=""
if command -v curl &>/dev/null; then
  health=$(curl -s --max-time 2 "$TORQUE_API/api/health" 2>/dev/null || echo "")
  if [ -n "$health" ]; then
    # TORQUE is running — get task counts
    tasks=$(curl -s --max-time 2 "$TORQUE_API/api/tasks?status=running,queued,failed" 2>/dev/null || echo "")

    running=0
    queued=0
    failed=0
    if command -v jq &>/dev/null && [ -n "$tasks" ]; then
      running=$(echo "$tasks" | jq -r '.running // 0' 2>/dev/null || echo "0")
      queued=$(echo "$tasks" | jq -r '.queued // 0' 2>/dev/null || echo "0")
      failed=$(echo "$tasks" | jq -r '.failed // 0' 2>/dev/null || echo "0")
    fi

    # Detect project
    project="unknown"
    if [ -d "$PWD/.git" ]; then
      project=$(basename "$PWD")
    fi

    status_text="TORQUE is available. Status: ${running} running, ${queued} queued, ${failed} failed.\\nProject: ${project}\\n\\nUse /torque-submit to submit tasks, /torque-status to check progress.\\nUse await_task with heartbeat_minutes for progress check-ins."
  else
    status_text="TORQUE is installed but not running.\\nStart the server to enable task orchestration.\\n\\nSkills and commands are available but MCP tools will not work until the server starts."
  fi
else
  status_text="TORQUE plugin loaded. curl not available — cannot check server status."
fi

escaped=$(escape_for_json "$status_text")

# Output for the appropriate platform
if [ -n "${CURSOR_PLUGIN_ROOT:-}" ]; then
  printf '{\n  "additional_context": "%s"\n}\n' "$escaped"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  printf '{\n  "hookSpecificOutput": {\n    "hookEventName": "SessionStart",\n    "additionalContext": "%s"\n  }\n}\n' "$escaped"
else
  printf '{\n  "additional_context": "%s"\n}\n' "$escaped"
fi

exit 0
```

- [ ] **Step 6: Make session-start executable**

```bash
chmod +x hooks/session-start
```

- [ ] **Step 7: Test the hook manually**

```bash
CLAUDE_PLUGIN_ROOT="$(pwd)" bash hooks/session-start
```
Expected: JSON output with TORQUE status

- [ ] **Step 8: Commit**

```bash
git add hooks/
git commit -m "feat(plugin): add SessionStart hook with TORQUE status injection"
```

---

## Task 2: Agent Definitions

**Files:**
- Create: `agents/task-reviewer.md`
- Create: `agents/workflow-architect.md`
- Create: `agents/batch-monitor.md`

- [ ] **Step 1: Create agents directory**

```bash
mkdir -p agents
```

- [ ] **Step 2: Create `agents/task-reviewer.md`**

Write a full agent definition with frontmatter (name, description with trigger examples, model: sonnet). The system prompt should instruct the agent to:
- Read completed task output via `check_status` or `get_result` MCP tools
- Check for quality issues: stubs, empty methods, truncation, hallucinated APIs
- Verify file changes make sense for the task description
- Report: approve (clean) or flag with specific issues
- Reference the existing `/torque-review` skill logic for the review checklist

- [ ] **Step 3: Create `agents/workflow-architect.md`**

Agent that designs DAG workflows from feature specs. System prompt:
- Analyze a feature description for parallelizable subtasks
- Select providers per step (codex for greenfield, ollama for edits, etc.)
- Output a workflow definition using `create_workflow` + `add_workflow_task` MCP tools
- Consider the provider capability matrix from CLAUDE.md

Model: inherit (needs full reasoning).

- [ ] **Step 4: Create `agents/batch-monitor.md`**

Agent that monitors running workflows. System prompt:
- Check workflow status via `workflow_status` MCP tool
- Use `check_notifications` for completion events
- Handle stall warnings: consider cancelling and resubmitting
- Report progress to the user
- Resubmit failed tasks with provider fallback

Model: haiku (monitoring loop, low reasoning).

- [ ] **Step 5: Commit**

```bash
git add agents/
git commit -m "feat(plugin): add task-reviewer, workflow-architect, batch-monitor agents"
```

---

## Task 3: Reference Skills

**Files:**
- Create: `skills/references/tool-mapping.md`
- Create: `skills/references/codex-tools.md`

- [ ] **Step 1: Create references directory**

```bash
mkdir -p skills/references
```

- [ ] **Step 2: Create `skills/references/tool-mapping.md`**

A SKILL.md-format file mapping every MCP tool to REST API endpoint and `torque-cli` subcommand. Read the actual MCP tool list from `server/tool-defs/` and the REST routes from `server/dashboard/router.js` + `server/api/routes.js` to build an accurate mapping.

Cover at minimum: submit_task, smart_submit_task, check_status, get_result, cancel_task, await_task, await_workflow, check_ollama_health, list_tasks, create_workflow, add_workflow_task, workflow_status, subscribe_task_events, check_notifications.

Note any MCP tools that have NO REST equivalent.

- [ ] **Step 3: Create `skills/references/codex-tools.md`**

Codex-specific notes: how MCP tools are accessed (same as Claude Code since Codex has MCP), any tool naming differences, agent dispatch patterns, and how to use TORQUE agents on Codex.

- [ ] **Step 4: Commit**

```bash
git add skills/references/
git commit -m "feat(plugin): add tool mapping and Codex reference skills"
```

---

## Task 4: Cross-Platform Files

**Files:**
- Create: `CODEX.md`
- Create: `AGENTS.md`
- Create: `GEMINI.md`
- Create: `gemini-extension.json`

- [ ] **Step 1: Create `CODEX.md`**

Read the existing `CLAUDE.md` for content to adapt. `CODEX.md` should include:
- TORQUE overview (what it does, providers, routing)
- Remote workstation rules (`torque-remote` for heavy commands)
- Heartbeat await patterns
- Available skills and agents
- Reference to `AGENTS.md`

Do NOT copy `CLAUDE.md` verbatim — adapt for Codex's context and conventions.

- [ ] **Step 2: Create `AGENTS.md`**

Three agent definitions from Task 2, formatted for Codex's AGENTS.md spec. Same content as `agents/` directory but in the format Codex expects.

- [ ] **Step 3: Create `GEMINI.md`**

Content for Gemini CLI users:
- TORQUE overview
- `torque-cli` as the primary interface (with full usage examples)
- Tool mapping table (from reference skill, inlined)
- Note: MCP tools, skills, and agents not available on Gemini

- [ ] **Step 4: Create `gemini-extension.json`**

```json
{
  "name": "torque",
  "description": "AI task orchestration with multi-provider routing",
  "version": "2.2.0",
  "contextFileName": "GEMINI.md"
}
```

- [ ] **Step 5: Commit**

```bash
git add CODEX.md AGENTS.md GEMINI.md gemini-extension.json
git commit -m "feat(plugin): add cross-platform files for Codex, Gemini, Cursor"
```

---

## Task 5: CLI Wrapper + Plugin Manifest Update

**Files:**
- Create: `~/bin/torque-cli`
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Create CLI wrapper**

Create `~/bin/torque-cli`:

```bash
#!/usr/bin/env bash
# torque-cli — PATH wrapper for TORQUE Node.js CLI
# Finds the TORQUE installation and runs cli/torque-cli.js

# Try known locations
for dir in \
  "$HOME/Projects/torque-public" \
  "$HOME/Projects/torque" \
  "${CLAUDE_PLUGIN_ROOT:-}" \
  "$(cd "$(dirname "$0")/../Projects/torque-public" 2>/dev/null && pwd)"; do
  if [ -f "$dir/cli/torque-cli.js" ]; then
    exec node "$dir/cli/torque-cli.js" "$@"
  fi
done

echo "Error: TORQUE CLI not found. Set TORQUE_HOME or ensure torque-public is in ~/Projects/" >&2
exit 1
```

```bash
chmod +x ~/bin/torque-cli
```

- [ ] **Step 2: Verify CLI works**

```bash
torque-cli health
torque-cli status
```

- [ ] **Step 3: Update `plugin.json`**

Read the existing `.claude-plugin/plugin.json` and add the new fields while preserving `mcpServers`:

```json
{
  "name": "torque",
  "version": "2.2.0",
  "description": "AI task orchestration — multi-provider routing, DAG workflows, quality gates, and distributed execution",
  "mcpServers": { ... },
  "hooks": "./hooks/hooks.json",
  "skills": "./skills",
  "agents": "./agents",
  "commands": "./.claude/commands"
}
```

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "feat(plugin): update manifest with hooks, skills, agents paths"
```

---

## Dependency Graph

```
Task 1 (hooks) ─────────┐
Task 2 (agents) ─────────┼── Task 4 (cross-platform files) ── Task 5 (CLI + manifest)
Task 3 (reference skills) ┘
```

- Tasks 1, 2, 3 are independent — can run in parallel
- Task 4 depends on Tasks 2 and 3 (AGENTS.md references agents, GEMINI.md references tool mapping)
- Task 5 is last (manifest ties everything together)
