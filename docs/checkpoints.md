# Task Checkpoints

After every task completes, TORQUE snapshots the working tree into a *shadow* git repo at `<project>/.torque-checkpoints/`. The shadow repo is automatically gitignored from your main repo; it never touches your real history.

## Why

- Roll back a single task without disturbing other tasks' work
- Inspect what each task changed via `git diff` on the shadow repo
- Recover from rogue agent behavior even after the task is marked completed

## MCP tools

    list_checkpoints { project_root: "..." }
    rollback_task { project_root: "...", task_id: "..." }

## Storage

Each task = one tagged commit in `.torque-checkpoints/`. Tags are `task-<task_id>`. The shadow repo is a regular git repo; you can `cd .torque-checkpoints` and run `git log` to inspect.

## Caveats

- Shadow repo grows over time. Garbage-collection / pruning is not yet automated.
- Rollback restores files but does NOT undo other side effects (DB writes, external API calls, etc.). It only touches the working tree.
