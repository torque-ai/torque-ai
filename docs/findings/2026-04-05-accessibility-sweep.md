# Accessibility Sweep - Dashboard

**Date:** 2026-04-05
**Scope:** `dashboard/src/`
**Scanner:** accessibility variant (code-only analysis)
**Visual checks:** skipped

## Summary

This sweep excluded the accessibility issues already documented on 2026-04-04 and the fix areas called out as completed in the current session. Four new issues remain in the dashboard JSX.

**Findings:** 4 new issues
- HIGH: 4

## HIGH

### ACC-NEW-01: Coordination sortable headers are still mouse-only

**Files:** `dashboard/src/views/Coordination.jsx:24-39`, `dashboard/src/views/Coordination.jsx:205-208`, `dashboard/src/views/Coordination.jsx:274-277`, `dashboard/src/views/Coordination.jsx:337-341`
**WCAG:** 2.1.1 Keyboard (Level A), 4.1.2 Name, Role, Value (Level A)

`Coordination.jsx` still uses a local `SortHeader` that renders `<th onClick={...}>` without `tabIndex`, keyboard handlers, or `aria-sort`. Other tables in the dashboard were updated this session, but this view was missed. Keyboard users cannot trigger sorting in the agents, rules, or claims tables, and assistive tech does not get sortable-state information.

**Fix direction:** align this `SortHeader` with the remediated versions already used in `History.jsx`, `Schedules.jsx`, and `BatchHistory.jsx`.

### ACC-NEW-02: Multiple click-to-open rows and cards remain inaccessible from the keyboard

**Files:** `dashboard/src/views/BatchHistory.jsx:90-93`, `dashboard/src/views/BatchHistory.jsx:564-569`, `dashboard/src/views/Workflows.jsx:77-80`, `dashboard/src/views/Schedules.jsx:318-318`, `dashboard/src/views/PlanProjects.jsx:55-57`, `dashboard/src/views/Providers.jsx:206-209`, `dashboard/src/views/Kanban.jsx:605-607`
**WCAG:** 2.1.1 Keyboard (Level A), 4.1.2 Name, Role, Value (Level A)

Several primary interactions still rely on clickable `<tr>` or `<div>` containers with no focusability, no keyboard activation, and no interactive role. Examples include opening batch task details, expanding batch/workflow rows, opening a schedule drawer, selecting a plan project, expanding provider rows, and opening the Kanban "Needs Attention" task card. These controls work with a mouse only.

The pattern is inconsistent across the app: some similar surfaces were fixed correctly, such as Kanban task cards (`tabIndex` plus Enter/Space handling) and the main workflow rows in `Workflows.jsx` (`role="button"` plus keyboard handlers).

**Fix direction:** use a real `<button>` for the clickable region when possible, or add `tabIndex={0}`, Enter/Space handling, and an explicit interactive role to the current container.

### ACC-NEW-03: Several confirm dialogs still have no accessible name

**Files:** `dashboard/src/views/History.jsx:817-824`, `dashboard/src/views/Kanban.jsx:1504-1508`, `dashboard/src/views/RoutingTemplates.jsx:724-728`, `dashboard/src/views/Schedules.jsx:359-361`, `dashboard/src/views/StrategicConfig.jsx:936-940`
**WCAG:** 1.3.1 Info and Relationships (Level A), 4.1.2 Name, Role, Value (Level A)

These confirmation modals set `role="dialog"` and `aria-modal="true"` but do not provide `aria-label` or `aria-labelledby`. Each dialog has a visible `<h3>` heading, but it is not programmatically tied to the dialog container, so screen readers announce an unnamed dialog.

This is inconsistent with correctly named dialogs elsewhere in the dashboard, such as `Hosts.jsx:1627-1633` and `PlanProjects.jsx:738-743`.

**Fix direction:** add `aria-labelledby` on each dialog container and give the visible heading a stable `id`, or provide an equivalent `aria-label`.

### ACC-NEW-04: Schedule and release drawers are still not exposed as dialogs

**Files:** `dashboard/src/components/ScheduleDetailDrawer.jsx:239-245`, `dashboard/src/components/ReleaseDetailDrawer.jsx:166-169`
**WCAG:** 1.3.1 Info and Relationships (Level A), 2.4.3 Focus Order (Level A), 4.1.2 Name, Role, Value (Level A)

Both side drawers render a page-blocking backdrop and a fixed-position panel, but neither panel declares `role="dialog"` or `aria-modal`, and neither panel has an accessible name. `ScheduleDetailDrawer` and `ReleaseDetailDrawer` do listen for Escape, but screen readers are never told that focus has moved into a modal context, and focus can still remain conceptually tied to the background page.

This leaves the drawer pattern behind the modal accessibility baseline already applied to `TaskDetailDrawer`, `ChangePasswordModal`, and other remediated overlays.

**Fix direction:** treat both drawers as dialogs: add `role="dialog"`, `aria-modal="true"`, and a programmatic label, then keep focus inside the drawer while it is open.
