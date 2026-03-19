# TORQUE Dashboard UX Remediation (Track D)

**Date:** 2026-03-19
**Scope:** 62 validated UX issues (58 still valid + 4 updated references)
**Approach:** Batch by pattern — most issues are the same fix applied to multiple files

---

## Phase 1 — High-Impact Quick Wins (3 tasks, ~25 items)

### Task 1: Replace plain "Loading..." with LoadingSkeleton (12 views)

The `LoadingSkeleton` component exists at `components/LoadingSkeleton.jsx` but is never imported. Replace all plain `<p>Loading...</p>` with `<LoadingSkeleton />` in: Providers, Hosts, Budget, Schedules, Approvals, Coordination, Strategy, Models, TaskDetailDrawer, PlanProjects, RoutingTemplates, StrategicConfig.

### Task 2: Add confirmation dialogs to destructive actions (6 items)

Add custom confirmation modals (matching existing patterns in Hosts/PlanProjects) to:
- Kanban `handleRetryAllFailed` — "Retry N failed tasks?"
- History `handleBulkRetry` — "Retry N selected tasks?"
- History `handleBulkCancel` — "Cancel N selected tasks? This is irreversible."
- RoutingTemplates `handleDelete` — "Delete template X?"
- StrategicConfig `resetConfig` — "Reset all configuration to defaults?"
- Schedules `handleDelete` — replace `window.confirm()` with custom dialog

### Task 3: Make notification bell functional (1 item + new component)

Layout.jsx bell has no `onClick`. Options: add a dropdown showing recent failures/stuck tasks, or navigate to a filtered History view. Simplest: on click, navigate to `/history?status=failed` to show failed tasks.

---

## Phase 2 — Accessibility + Responsive (3 tasks, ~15 items)

### Task 4: Add colorblind-friendly status indicators (3 items)

Add secondary visual indicators (icons or text labels) alongside color dots:
- ✓ for completed, ✗ for failed, ◷ for running, ◌ for queued, ⊘ for cancelled
- Apply to Kanban column headers, status badges in History/Workflows, and constants.js

### Task 5: Responsive filter bars (3 items)

Add `flex-wrap` to filter bars in History, Kanban toolbar, and RoutingTemplates so controls wrap on narrow screens instead of overflowing.

### Task 6: Keyboard accessibility (2 items)

- KeyboardShortcuts: add `contentEditable` to the guard check for number keys
- WorkflowDAG: add `tabIndex` and Enter/Space handlers to SVG nodes

---

## Phase 3 — Data Quality + Consistency (4 tasks, ~22 items)

### Task 7: Missing pagination (3 views)

Add pagination to Workflows (currently loads 100), Coordination tables, Approvals history.

### Task 8: Missing table sorting (6 tables)

Add sortable headers to Coordination (agents, rules, claims), Schedules, Approvals (pending, history).

### Task 9: Error states + feedback (8 items)

Add persistent error indicators to HealthBar, HealthDots, Budget, Kanban (beyond toast). Add export success toast to History CSV.

### Task 10: Remaining fixes (12 items)

- Onboarding: convert inline styles to Tailwind
- Date formatting: standardize on date-fns across all views
- Search state in URL for Kanban and PlanProjects
- Dead code: remove Workstations.jsx
- HealthBar/HealthDots: wire real data or remove placeholders
- Hosts polling: increase from 10s to 30s
- Models: add polling or WebSocket integration

---

## Estimated Effort

| Phase | Tasks | Items | Sessions |
|-------|-------|-------|----------|
| 1 — Quick wins | 3 | ~25 | 1-2 |
| 2 — Accessibility | 3 | ~15 | 1-2 |
| 3 — Data quality | 4 | ~22 | 2-3 |
| **Total** | **10** | **~62** | **~4-7** |
