---
name: torque-restart
description: Restart the TORQUE MCP server to apply code changes
argument-hint: "[reason]"
allowed-tools:
  - mcp__torque__restart_server
  - mcp__torque__check_status
  - AskUserQuestion
---

# TORQUE Restart

Restart the TORQUE MCP server to apply code changes without restarting Claude Code.

## When to Use

- After modifying TORQUE server code (task-manager.js, tools.js, etc.)
- To clear any stuck internal state
- To apply new configuration that requires server restart

## Instructions

### If running tasks exist:

1. Call `check_status` to show running tasks
2. Warn the user that restart will wait for tasks to complete or they must cancel them first
3. Use AskUserQuestion to ask if they want to:
   - Wait for tasks to complete
   - Cancel all running tasks first
   - Abort the restart
4. If they choose to cancel, call `/torque-cancel all` first

### If no running tasks:

1. Call `restart_server` with the reason (from $ARGUMENTS or "Manual restart")
2. Inform the user the server is restarting
3. Tell them to run `/mcp` to reconnect after a few seconds

## Notes

- The MCP client will automatically try to reconnect after server exit
- Running `/mcp` forces immediate reconnection
- All pending tasks in the queue will resume after restart (they're persisted in the database)
