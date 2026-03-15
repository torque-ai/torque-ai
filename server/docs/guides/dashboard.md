# Dashboard Guide

TORQUE includes a real-time web dashboard for monitoring tasks, hosts, and system health.

## Accessing the Dashboard

Open your browser to:

```
http://localhost:3456
```

The dashboard starts automatically when the MCP server launches. No setup required.

## Features

### Task Overview

The main view shows all tasks with:

- **Status** — queued, running, completed, failed
- **Provider** — which LLM provider is executing the task
- **Model** — the specific model being used
- **Duration** — elapsed time for running tasks, total time for completed
- **Progress** — real-time output streaming for running tasks
- **Host** — which Ollama host is running the task (for multi-host setups)

### Task Actions

From the dashboard you can:

| Action | Description |
|--------|-------------|
| **Retry** | Re-queue a failed task |
| **Cancel** | Stop a running or queued task |
| **Approve Switch** | Approve a pending provider switch |
| **Reject Switch** | Reject a pending provider switch |
| **View Output** | See the full task output |
| **View Logs** | See stdout/stderr logs |

### Host Status

Shows all registered Ollama hosts with:

- **Health** — online/offline indicator
- **Models** — available models on each host
- **GPU Metrics** — VRAM usage bar, GPU utilization percentage
- **Active Model** — which model is currently loaded
- **Task Load** — number of running tasks per host

The GPU metrics update in real-time when nvidia-smi is available. Remote hosts display VRAM bars when the GPU metrics server is running.

### Provider Statistics

Displays per-provider metrics:

- Task count (total, success, failed)
- Success rate percentage
- Average quality score
- Average duration
- Time series chart of task activity

### Budget Summary

Shows current spending vs budget:

- Total spent in the current period
- Remaining budget
- Per-provider cost breakdown
- Cost trend over time

### Queue Preview

Shows the current priority queue:

- Tasks ordered by priority score
- Dependency status for workflow tasks
- Provider assignment for each queued task

## Real-Time Updates

The dashboard uses WebSocket connections for live updates:

- **Task status changes** — updated within 500ms (debounced to prevent flooding)
- **Stats refresh** — updated every 2 seconds (throttled)
- **Host health** — updated on each health check cycle (every 60 seconds)
- **GPU activity** — polled on-demand when viewing the host panel

No manual refresh needed — the dashboard stays current automatically.

## Configuration

### Changing the Port

```
configure { key: "dashboard_port", value: "3460" }
```

Restart the server for the change to take effect.

### Starting/Stopping Manually

```
start_dashboard {}
stop_dashboard {}
```

The dashboard auto-starts with the MCP server. Use these tools only if you need to restart it independently.

## SPA Routing

The dashboard supports single-page application routing. If you build a custom React dashboard, place the build output in `dashboard/dist/` — the server serves it automatically with SPA fallback (unmatched routes serve `index.html`).

The built-in lightweight dashboard is served from `server/dashboard/` as a fallback when no React build exists.

## Caching

- `index.html` — never cached (`no-cache, no-store, must-revalidate`)
- Static assets (JS, CSS, images) — cached with `public, max-age=31536000, immutable` (assumed to have content hashes in filenames)

## Multi-Session Support

The dashboard supports multiple Claude Code sessions running simultaneously. The `/api/instances` endpoint shows all active MCP server instances with their session info, enabling the dashboard to display cross-session status.

## Tools Reference

| Tool | Description |
|------|-------------|
| `start_dashboard` | Start the dashboard server |
| `stop_dashboard` | Stop the dashboard server |
