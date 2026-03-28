---
name: codex-tools
description: "Reference: how to use TORQUE tools from Codex CLI — MCP access, agent patterns, naming"
---

# TORQUE + Codex reference

- Codex has MCP support, so TORQUE tools are available from Codex in the same way they are available from Claude Code.
- Tool names are typically exposed as `mcp__torque__<tool_name>` in Claude Code; the runtime identifier may differ in other Codex MCP host implementations.
- See `AGENTS.md` in the project root for the available agent definitions before planning multi-step work.

## Agent dispatch patterns

- Submit work through `submit_task` or `smart_submit_task`.
- For workflows, use `create_workflow` and `add_workflow_task`, then start with `run_workflow`.
- For long-running actions, use `await_task` and `await_workflow` so completion arrives via streaming notifications.

### Example dispatch

    mcp__torque__smart_submit_task({ 
      task: "add a new test for the date parser",
      working_directory: "C:\\Users\\Werem\\Projects\\torque-public"
    })

    mcp__torque__await_task({ task_id: "123" })

## REST API vs MCP

- Use REST for simple queries and one-shot reads, e.g. checking status, listing tasks, workflow metadata, or project defaults.
- Use MCP for streaming and await patterns where you need event-driven completion notifications:
  - `await_task`
  - `await_workflow`
  - any notification flow from task events
