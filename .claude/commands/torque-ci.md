---
name: torque-ci
description: Monitor CI runs — watch repos, diagnose failures, view history
argument-hint: "[watch | stop | diagnose <run-id> | history | status]"
allowed-tools:
  - mcp__torque__watch_ci_repo
  - mcp__torque__stop_ci_watch
  - mcp__torque__await_ci_run
  - mcp__torque__diagnose_ci_failure
  - mcp__torque__list_ci_runs
  - mcp__torque__ci_run_status
  - mcp__torque__configure_ci_provider
  - mcp__torque__check_notifications
---

# TORQUE CI Monitor

Monitor GitHub Actions CI runs, diagnose failures, and manage repo watches.

## Instructions

Based on the argument provided, take the appropriate action:

### No argument or "status"
Show the current CI watch status:
1. Call `list_ci_runs` to show recent runs
2. Call `check_notifications` to show any pending CI failure notifications
3. Report which repos are being watched and their last check time

### "watch"
Activate CI watching for the current project:
1. Detect the repo from the git remote in the current working directory
2. Call `watch_ci_repo` with the detected repo
3. Confirm the watch is active

### "stop"
Stop watching CI for the current project:
1. Call `stop_ci_watch` for the current repo

### "diagnose <run-id>"
Get full diagnosis of a specific CI run:
1. Call `diagnose_ci_failure` with the provided run ID
2. Present the structured failure categories and suggested actions
3. Offer to fix the issues based on the diagnosis

### "history"
Show recent CI run history:
1. Call `list_ci_runs` with default filters
2. Format as a table showing run ID, status, branch, commit, and timestamp

## Context
- The CI watcher polls GitHub Actions every 30s for new failed runs
- Failed runs are automatically diagnosed into categories: lint, test_schema, test_logic, test_platform, build, infra
- Notifications are pushed to all connected sessions when failures are detected
- Use `diagnose_ci_failure` to get the full structured breakdown of any failure
