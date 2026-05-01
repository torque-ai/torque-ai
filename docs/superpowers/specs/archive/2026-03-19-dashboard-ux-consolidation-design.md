# Dashboard UX Consolidation Design

**Date:** 2026-03-19
**Status:** Approved
**Scope:** Dashboard sidebar, page merges, health indicators, activity feed

## Problem

The dashboard has 13 sidebar pages — too many for the 3-4 pages users actually visit regularly. Related features are scattered across separate pages (Batches/Workflows/Projects, Hosts/Models, Strategy/Schedules/Approvals/Coordination/Budget). There's no at-a-glance system health signal, and no live activity feed showing what just happened.

## Solution

Consolidate from 13 pages to 6 by merging related pages into tab-based views. Add system health indicators to the sidebar and Kanban header. Add a collapsible activity feed panel to the Kanban page.

## New Sidebar (6 items)

| Nav Item | Contains | Tabs |
|----------|----------|------|
| **Kanban** | Task board + health bar + activity panel | — |
| **History** | Task search/filter/detail | — |
| **Workflows** | DAG workflows + batch history + plan projects | Workflows \| Batches \| Projects |
| **Providers** | Provider cards, quotas, usage charts | — (already consolidated) |
| **Infrastructure** | Ollama hosts, model registry | Hosts \| Models |
| **Operations** | Routing templates, schedules, approvals, coordination, budget | Routing \| Schedules \| Approvals \| Coordination \| Budget |

## Health Indicators

### Kanban header health bar

A horizontal strip at the top of the Kanban page showing 4 gauges:

```
┌──────────────────────────────────────────────────────────┐
│ Providers: ●●●○○ 3/5  │ Hosts: ●● 2/2  │ Queue: 3  │ Budget: $4.20/$10 │
└──────────────────────────────────────────────────────────┘
```

- **Providers**: colored dots (green/yellow/red) per provider based on quota status, count of healthy vs total
- **Hosts**: colored dots per Ollama host based on health check status
- **Queue**: number of queued + running tasks
- **Budget**: daily spend vs daily budget (from cost-tracking)

Data sources: `/api/provider-quotas`, `/api/hosts`, `/api/tasks?status=queued,running` (counts), `/api/budget/daily`

### Sidebar footer health dots

Compact row of 3 dots at the bottom of the sidebar, visible on every page:

```
● ● ●   Providers | Hosts | Budget
```

Green = all healthy. Yellow = degraded. Red = critical. Tooltip on hover shows detail. Clicking navigates to the relevant page.

## Activity Feed Panel

Collapsible right-side panel on the Kanban page. Default: collapsed (just an icon button). Expanded: 300px wide panel.

Content: reverse-chronological event stream. Event types:
- Task completed/failed (provider, duration, exit code)
- 429 rate limit hit (provider, cooldown)
- Workflow completed/failed (name, task count)
- Stall warning (task ID, seconds)
- Provider health change (up/down)
- Host health change (up/down)

Data source: SSE push notifications (already implemented via the event bus). The dashboard already receives `notifications/message` events — the activity panel just renders them in a scrolling list instead of ephemeral toasts.

Panel header: "Activity" with a clear button and collapse button.
Panel items: icon + timestamp + one-line description. Colored by severity (green/yellow/red).
Max items: 100, oldest trimmed.

## Page Merges

### Workflows page (3 tabs)

**Tab 1: Workflows** — current `Workflows.jsx` content (DAG visualization, task status grid)
**Tab 2: Batches** — current `BatchHistory.jsx` content (batch list, completion stats)
**Tab 3: Projects** — current `PlanProjects.jsx` content (plan project tracking)

Each tab renders its existing component. The tab state persists in URL hash (`/workflows#batches`).

### Infrastructure page (2 tabs)

**Tab 1: Hosts** — current `Hosts.jsx` content (Ollama host cards, VRAM, health)
**Tab 2: Models** — current `Models.jsx` content (model registry, capabilities, probing)

### Operations page (5 tabs)

**Tab 1: Routing** — current `Strategy.jsx` + `RoutingTemplates.jsx` content (template editor, chain visualization)
**Tab 2: Schedules** — current `Schedules.jsx` content
**Tab 3: Approvals** — current `Approvals.jsx` content
**Tab 4: Coordination** — current `Coordination.jsx` content
**Tab 5: Budget** — current `Budget.jsx` content

## Routing

Old routes redirect to new locations for bookmark compatibility:

| Old Route | New Route |
|-----------|-----------|
| `/batches` | `/workflows#batches` |
| `/projects` | `/workflows#projects` |
| `/models` | `/infrastructure#models` |
| `/hosts` | `/infrastructure` |
| `/budget` | `/operations#budget` |
| `/schedules` | `/operations#schedules` |
| `/approvals` | `/operations#approvals` |
| `/coordination` | `/operations#coordination` |
| `/strategy` | `/operations#routing` |

## Files

**New:**
- `dashboard/src/views/WorkflowsHub.jsx` — tabbed wrapper for Workflows + Batches + Projects
- `dashboard/src/views/InfrastructureHub.jsx` — tabbed wrapper for Hosts + Models
- `dashboard/src/views/OperationsHub.jsx` — tabbed wrapper for Routing + Schedules + Approvals + Coordination + Budget
- `dashboard/src/components/HealthBar.jsx` — Kanban header health strip
- `dashboard/src/components/HealthDots.jsx` — sidebar footer health dots
- `dashboard/src/components/ActivityPanel.jsx` — collapsible right-side event feed

**Modified:**
- `dashboard/src/App.jsx` — new routes, redirects for old routes
- `dashboard/src/components/Layout.jsx` — 6 nav items, health dots in footer
- `dashboard/src/views/Kanban.jsx` — health bar + activity panel integration

**NOT deleted:**
- Existing view files (`Workflows.jsx`, `BatchHistory.jsx`, `Hosts.jsx`, etc.) stay as-is — the hub wrappers import and render them as tab content. This avoids rewriting working components.

## Not In Scope

- Responsive/mobile layout (dashboard is a desktop developer tool)
- Dark/light theme toggle (already dark-only)
- Keyboard shortcuts for tab switching
- Persisting activity feed across page refreshes (ephemeral is fine)
- Workstations page (already redirects to hosts)
