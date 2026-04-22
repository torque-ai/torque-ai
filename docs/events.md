# Task Event Log

Every significant runtime moment is recorded as a typed, immutable event in the `task_events` table. The event log is the orchestration boundary - it survives status overwrites, restarts, and DB edits.

## Event types

`task.created` `task.queued` `task.running` `task.completed` `task.failed` `task.cancelled` `task.skipped` `task.requeued` `tool.called` `provider.routed` `provider.failover` `verify.ran` `verify.tag.assigned` `retry.scheduled` `goal_gate.evaluated` `workflow.started` `workflow.completed` `workflow.failed` `budget.breached`

## Querying

    list_task_events { task_id: "..." }
    list_task_events { workflow_id: "...", type: "provider.failover" }
    GET /api/v2/events?task_id=...&since=2026-04-11T00:00:00Z

## Use cases

- **Replay** - reconstruct exactly what happened to a task, in order
- **Debugging** - find the moment a provider switched, a verify tag was assigned, a retry fired
- **Audit** - immutable trail of who did what, when (`actor` field)
- **Sidecar services** - retros, dashboard live updates, metrics - all consume events
