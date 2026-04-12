# Accessibility Sweep - Dashboard
**Date:** 2026-04-12
**Scope:** dashboard/src/
**Scanner:** accessibility variant (code-only analysis)
**Visual checks:** skipped

## Summary

This sweep excludes issues already documented in `docs/findings/2026-04-04-accessibility-scan.md` and `docs/findings/2026-04-05-accessibility-sweep.md`.

Pattern searches found no net-new `<img>`/`alt` regressions and no new click-only `<div>/<span>/<tr>/<th>` regressions in the scoped files. The remaining undiscovered issues are concentrated in overlay focus management and the newer Factory policy controls.

**Findings:** 4 new issues
- HIGH: 4

## HIGH

### ACC-NEW-05: Multiple dialogs trap focus on open but never restore it to the invoking control on close

**Files:** `dashboard/src/components/ChangePasswordModal.jsx:13-37`, `dashboard/src/components/KeyboardShortcuts.jsx:119-133`, `dashboard/src/views/History.jsx:229-243`, `dashboard/src/views/PlanProjects.jsx:322-336`, `dashboard/src/views/PlanProjects.jsx:542-556`, `dashboard/src/components/TaskDetailDrawer.jsx:284-298`, `dashboard/src/views/VersionControl.jsx:230-244`
**WCAG:** 2.4.3 Focus Order (Level A)

These overlays correctly move focus into the dialog when they open, but the effect cleanup only removes the keydown listener. None of these components stores the previously focused trigger and restores focus to it when the dialog closes.

That leaves keyboard users without a predictable return point after closing the overlay with Escape, backdrop click, or the close action. The same focus-first/no-restore pattern is also repeated in other scoped overlays that were not previously documented, including confirmation flows in `Hosts.jsx`, `Kanban.jsx`, `RoutingTemplates.jsx`, `Schedules.jsx`, and `StrategicConfig.jsx`.

**Fix direction:** capture `document.activeElement` before moving focus into the overlay, then restore focus to that element in the effect cleanup after close.

### ACC-NEW-06: Schedule and release drawers still do not move focus into the drawer or trap Tab navigation

**Files:** `dashboard/src/components/ScheduleDetailDrawer.jsx:342-349`, `dashboard/src/components/ScheduleDetailDrawer.jsx:632-668`, `dashboard/src/components/ReleaseDetailDrawer.jsx:132-148`, `dashboard/src/components/ReleaseDetailDrawer.jsx:166-191`
**WCAG:** 2.1.1 Keyboard (Level A), 2.4.3 Focus Order (Level A), 4.1.2 Name, Role, Value (Level A)

Both drawers now declare `role="dialog"` and `aria-modal="true"`, but their keyboard handling stops at a document-level Escape listener. Neither component moves focus into the drawer when it opens, and neither traps `Tab`/`Shift+Tab` within the drawer container.

Because the drawers are visually modal and block the page with a backdrop, leaving focus on the background page makes the interaction model inconsistent for keyboard and assistive-technology users. Users can keep tabbing through obscured background controls while the drawer is open.

**Fix direction:** focus the drawer or its first actionable control on open, add a local focus trap, and restore focus to the invoking element on close.

### ACC-NEW-07: Newly added icon-only close and remove buttons still have no accessible names

**Files:** `dashboard/src/components/KeyboardShortcuts.jsx:140`, `dashboard/src/components/ScheduleDetailDrawer.jsx:668`, `dashboard/src/views/Factory.jsx:889-895`, `dashboard/src/views/Factory.jsx:933-939`
**WCAG:** 4.1.2 Name, Role, Value (Level A)

These controls render only `×` or `x` and provide no `aria-label`, `aria-labelledby`, or visually hidden text. Screen readers will announce the literal character rather than the control's purpose.

This affects the close button in the keyboard shortcuts dialog, the close button in the schedule drawer, and the remove-chip buttons for restricted paths and required checks in the Factory policy editor.

**Fix direction:** add descriptive accessible names such as `aria-label="Close keyboard shortcuts"`, `aria-label="Close schedule details"`, and `aria-label="Remove restricted path"` / `aria-label="Remove required check"`.

### ACC-NEW-08: Factory policy configuration introduces multiple unlabeled text, number, and range inputs

**Files:** `dashboard/src/views/Factory.jsx:805-845`, `dashboard/src/views/Factory.jsx:862-877`, `dashboard/src/views/Factory.jsx:884-955`, `dashboard/src/views/Factory.jsx:992-1012`
**WCAG:** 1.3.1 Info and Relationships (Level A), 4.1.2 Name, Role, Value (Level A)

The new Factory policy editor uses several standalone `<label>` elements as visual captions without matching `htmlFor`/`id` pairs on the actual controls. The unlabeled cluster includes the budget ceiling field, blast-radius slider, max-task and max-file inputs, work-hours start/end fields, restricted-path and required-check entry fields, and escalation threshold inputs.

Some checkbox controls in the same section are correctly wrapped inside `<label>` elements, but the numeric and free-text controls are not. Screen readers therefore have to fall back to placeholder text or adjacent layout, which is unreliable and incomplete.

**Fix direction:** add stable `id` values to each control and connect the visible labels with `htmlFor`. For grouped controls like work-hours start/end, provide distinct programmatic labels for each field.
