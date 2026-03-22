---
name: codex-tools
description: Codex CLI-specific notes for using TORQUE. MCP tools, agent dispatch, and skill differences compared to Claude Code.
---

# Using TORQUE with Codex CLI

## MCP Access

Codex supports MCP natively. TORQUE's MCP tools work the same as on Claude Code.
Tool names are prefixed with `mcp__torque__` (same convention as Claude Code).

**Example:**
```
mcp__torque__submit_task({ task: "Write unit tests for src/parser.ts", working_directory: "/my/project" })
mcp__torque__await_task({ task_id: "abc123" })
```

The full tool list is available after calling `mcp__torque__unlock_all_tools` or `mcp__torque__unlock_tier({ tier: 2 })`.

## Agents

Codex reads agent definitions from `AGENTS.md` in the project root. TORQUE provides an `AGENTS.md` at the repository root with three agents:

| Agent | Purpose | When to invoke |
|-------|---------|---------------|
| `task-reviewer` | Quality review of completed task output | After a task completes — inspect output, check for stubs, validate correctness |
| `workflow-architect` | Design DAG workflows from feature specs | Before submitting a complex batch — plan the node structure and dependencies |
| `batch-monitor` | Monitor running workflows | While waiting — track progress, handle heartbeats, surface stall alerts |

## Skills

Codex supports skills defined in `skills/`. TORQUE's 8 skills are available:

### Complex Skills (multi-step, use for full workflows)
- `torque-submit` — Submit work with auto-routing, baselines, and retry configuration
- `torque-review` — Full validation pipeline: baselines, stubs, size deltas, build check
- `torque-workflow` — DAG pipeline creation and monitoring

### Simple Skills (single-purpose operations)
- `torque-status` — Queue overview (running, queued, failed, hosts)
- `torque-cancel` — Cancel a running or queued task safely
- `torque-budget` — Cost tracking and provider performance
- `torque-config` — Configuration tuning and safeguards
- `torque-restart` — Restart TORQUE server after code changes

## Differences from Claude Code

| Behavior | Claude Code | Codex CLI |
|----------|------------|-----------|
| **Skill invocation** | `/torque-submit <task>` slash command | Invoke `torque-submit` skill from `skills/` directory |
| **Tool prefix** | `mcp__torque__` | `mcp__torque__` (same) |
| **Agent source** | `CLAUDE.md` + `.claude/` config | `AGENTS.md` in project root |
| **Push notifications** | Full SSE event bus; `await_task` wakes instantly | Same (MCP SSE transport is shared) |
| **Tool tier** | Starts at tier 1 (~25 tools) | Starts at tier 1 (~25 tools) |
| **`hashline_read`/`hashline_edit`** | Available via MCP | Available via MCP (same tool names) |

## Recommended Workflow (Codex)

1. **Before starting work:** Call `mcp__torque__scan_project` to identify gaps and priorities
2. **Submit a task:** Call `mcp__torque__smart_submit_task` or invoke the `torque-submit` skill
3. **Wait efficiently:** Call `mcp__torque__await_task` — wakes instantly via push, no polling needed
4. **Review output:** Call `mcp__torque__get_result` or invoke `torque-review` skill
5. **For batch work:** Invoke `workflow-architect` agent to design the DAG, then `torque-workflow` skill to execute

## Provider Notes for Codex

- Codex itself is a provider within TORQUE (`provider: "codex"`). Tasks submitted to TORQUE can be routed to Codex for execution.
- When running *inside* a Codex session, you are the orchestrator — use `smart_submit_task` to delegate sub-tasks to other providers (ollama, deepinfra, etc.)
- Avoid routing tasks back to `codex` provider from within a Codex session — this creates a nested execution loop

## Context Window

Codex has a large context window. TORQUE's tool-heavy tier-3 unlock (~488 tools) will consume significant context. Prefer tier 1 (default) or tier 2 (`unlock_tier({ tier: 2 })`) unless you need specific tier-3 tools.

## Quick Reference

```bash
# Check what's running
mcp__torque__list_tasks({ status: "running" })

# Submit and wait
task_id = mcp__torque__smart_submit_task({ task: "...", working_directory: "..." }).task_id
result = mcp__torque__await_task({ task_id })

# Create a feature workflow
mcp__torque__create_feature_workflow({
  feature_name: "MyFeature",
  working_directory: "/path/to/project",
  types_task: "Create TypeScript interfaces for...",
  system_task: "Implement MyFeatureSystem class...",
  tests_task: "Write vitest unit tests for...",
  auto_run: true
})
```
