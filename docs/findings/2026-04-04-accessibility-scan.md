# Accessibility Scan - Dashboard

**Date:** 2026-04-04
**Scope:** `dashboard/src/` - React components and HTML templates
**Scanner:** accessibility variant (code-only analysis)
**Visual contrast checks:** SKIPPED (peek_ui not available)

---

## Summary

The dashboard has a solid accessibility foundation in several areas: semantic HTML landmarks (`<nav>`, `<main>`, `<aside>`), keyboard focus-visible styling via `index.css`, `aria-live="polite"` on the toast notification region, proper `role="dialog"` and `aria-modal` on most modals, and Escape key handling across drawers and modals. However, there are systemic gaps that would impact screen reader users, keyboard-only users, and users of assistive technology.

**Findings:** 14 issues across 4 severity levels
- CRITICAL: 3
- HIGH: 5
- MEDIUM: 4
- LOW: 2

---

## CRITICAL

### ACC-01: Icon-only buttons missing accessible names
**Status:** ACTIONABLE
**Files:** `views/BatchHistory.jsx:476`, `views/Hosts.jsx:1447,1457`, `views/Workflows.jsx:372`, `views/VersionControl.jsx:493`, `components/TaskDetailDrawer.jsx:359,724,940`
**WCAG:** 4.1.2 Name, Role, Value (Level A)

Multiple icon-only buttons use `title` as their only accessible label. The `title` attribute is NOT reliably announced by screen readers and is not a substitute for `aria-label`. Affected buttons include refresh, export JSON, copy output, and scan buttons.

Example pattern:
```jsx
<button onClick={loadWorkflows} title="Refresh">
  <svg ...>...</svg>
</button>
```

**Fix:** Add `aria-label` to every icon-only button. Keep `title` for tooltip if desired, but `aria-label` is required. Several components already do this correctly (e.g., `Kanban.jsx:1224` has both `title` and `aria-label`).

---

### ACC-02: Sortable table headers use `onClick` on `<th>` without keyboard support
**Status:** ACTIONABLE
**Files:** `views/Approvals.jsx:18-29` (SortHeader component), `views/BatchHistory.jsx:59`
**WCAG:** 2.1.1 Keyboard (Level A)

The `SortHeader` component renders `<th onClick={...}>` but `<th>` is not an interactive element. It receives no `tabIndex`, no `onKeyDown`, no `role="button"`, and no `aria-sort` attribute. Keyboard users cannot access sort functionality at all. Screen readers cannot discover that columns are sortable.

**Fix:** Either wrap the content in a `<button>` inside the `<th>`, or add `tabIndex={0}`, `role="columnheader button"`, `onKeyDown` (Enter/Space), and `aria-sort="ascending|descending|none"` to the `<th>`.

---

### ACC-03: ChangePasswordModal has no focus trap, no `role="dialog"`, no Escape key handler
**Status:** ACTIONABLE
**File:** `components/ChangePasswordModal.jsx`
**WCAG:** 2.4.3 Focus Order (Level A), 1.3.1 Info and Relationships (Level A)

The modal overlay div and inner container lack `role="dialog"`, `aria-modal="true"`, and `aria-label`. There is no Escape key handler to close the modal. There is no focus trap -- Tab key will move focus behind the backdrop to the main page. This contrasts with `KeyboardShortcuts.jsx` which correctly implements all of these.

**Fix:** Add `role="dialog"`, `aria-modal="true"`, `aria-label="Change password"` to the inner container. Add an Escape key handler. Implement focus trapping (move focus to first input on open, trap Tab within the dialog).

---

## HIGH

### ACC-04: Form inputs without programmatic label associations
**Status:** ACTIONABLE
**Files:** `views/Hosts.jsx:188,897,907,915,1087-1104`, `views/Budget.jsx:267-290`, `views/Schedules.jsx:221-259`, `views/StrategicConfig.jsx:590-634`, `components/ChangePasswordModal.jsx:63-88`, `components/Login.jsx:51-78`
**WCAG:** 1.3.1 Info and Relationships (Level A)

Many `<label>` elements are adjacent to their `<input>` or `<select>` but lack `htmlFor` attributes, and the inputs lack `id` attributes. While the visual proximity creates a visual association, screen readers cannot programmatically associate the label with the input. The `TaskSubmitForm.jsx` is a good counter-example, using `htmlFor="task-description"` paired with `id="task-description"`.

**Fix:** Add matching `htmlFor` and `id` pairs. Several files in Hosts.jsx partially do this (lines 726-757 have `htmlFor` on some labels) but most labels across the codebase do not.

---

### ACC-05: Search input field lacks accessible label
**Status:** ACTIONABLE
**Files:** `views/History.jsx:518-524`
**WCAG:** 1.3.1 Info and Relationships (Level A)

The search input uses `placeholder="Search tasks..."` as its only label. Placeholder text disappears on input and is not a reliable accessible name. The adjacent `<select>` elements correctly use `aria-label` (e.g., `aria-label="Filter by status"`), but the search input does not.

**Fix:** Add `aria-label="Search tasks"` to the search input. Apply the same fix to any other filter inputs that rely solely on placeholder text.

---

### ACC-06: Tables missing `scope` attributes on `<th>` elements
**Status:** ACTIONABLE
**Files:** All 19 `<table>` instances across `Approvals.jsx`, `BatchHistory.jsx`, `Coordination.jsx`, `Governance.jsx`, `History.jsx`, `Models.jsx`, `ProjectSettings.jsx`, `Schedules.jsx`, `Strategy.jsx`, `VersionControl.jsx`, `Workflows.jsx`
**WCAG:** 1.3.1 Info and Relationships (Level A)

No `<th>` element in the entire dashboard uses `scope="col"` or `scope="row"`. Screen readers rely on `scope` to associate data cells with their headers in complex tables. Additionally, no table uses `<caption>` to provide a programmatic description of the table's purpose.

**Fix:** Add `scope="col"` to column headers and `scope="row"` to row headers. Consider adding `<caption className="sr-only">` for screen reader context.

---

### ACC-07: TabBar component lacks ARIA tab pattern
**Status:** ACTIONABLE
**File:** `components/TabBar.jsx`
**WCAG:** 4.1.2 Name, Role, Value (Level A)

The TabBar renders tabs as `<a>` elements without the WAI-ARIA tabs pattern (`role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, `role="tabpanel"`). The currently active tab has no `aria-selected="true"` or `aria-current` attribute. Screen readers cannot distinguish the tab navigation from regular links.

**Fix:** Add `role="tablist"` to the container, `role="tab"` and `aria-selected={active === tab.id}` to each tab link. The associated content panels should have `role="tabpanel"` and `aria-labelledby`.

---

### ACC-08: No focus trap in most modal dialogs
**Status:** ACTIONABLE
**Files:** `views/Hosts.jsx` (credentials modal, remove confirmation modals), `views/History.jsx:788`, `views/Schedules.jsx:331`, `views/RoutingTemplates.jsx:699`, `views/Kanban.jsx:1474`, `views/PlanProjects.jsx:363,705`, `views/StrategicConfig.jsx:892`
**WCAG:** 2.4.3 Focus Order (Level A)

Multiple modal dialogs correctly use `role="dialog"` and `aria-modal="true"`, but none implement focus trapping. When a modal is open, pressing Tab will move focus behind the backdrop overlay to page content. Focus should be constrained within the dialog while it is open.

**Fix:** Implement a focus-trap utility (or use a library like `focus-trap-react`) and apply it to all modal dialogs. At minimum, on open: move focus to the first focusable element; on Tab from last element: wrap to first; on Shift+Tab from first: wrap to last.

---

## MEDIUM

### ACC-09: SVG charts completely inaccessible
**Status:** ACTIONABLE
**Files:** `components/charts/SVGBarChart.jsx`, `components/charts/SVGPieChart.jsx`, `components/charts/SVGLineChart.jsx`
**WCAG:** 1.1.1 Non-text Content (Level A)

The SVG chart components render data visualizations without any text alternative. Parent containers in some views wrap charts in `<div role="img" aria-label="...">` (e.g., `Budget.jsx:364`, `Providers.jsx:807`), which is good. However, other chart usages in `BatchHistory.jsx:263-296`, `Models.jsx:204-235`, `Providers.jsx:840-889`, `Strategy.jsx` lack the `role="img"` wrapper, making those chart instances invisible to screen readers.

**Fix:** Ensure every chart usage is wrapped in a container with `role="img"` and a descriptive `aria-label`. Consider adding `aria-hidden="true"` to the `<svg>` element itself and providing a data table alternative for complex charts.

---

### ACC-10: Color-only status indicators
**Status:** ACTIONABLE
**Files:** `components/Layout.jsx:242-246` (connection dot), `views/Hosts.jsx` (host status dots), `views/Providers.jsx` (provider status), `views/Kanban.jsx:329` (task status)
**WCAG:** 1.4.1 Use of Color (Level A)

Status indicators rely solely on color (green dot = connected, red dot = error, etc.) to convey meaning. While `Layout.jsx:239` correctly adds `aria-label` for the connection status button, many other status indicators throughout the dashboard use colored dots or badges without a text equivalent accessible to screen readers. The `Strategy.jsx:92` `sr-only` span is a good example of the correct pattern but is the only instance found.

**Fix:** Add `sr-only` text or `aria-label` to all color-only status indicators. The pattern already exists in `Strategy.jsx:92`: `<span className="sr-only">{healthStatus}</span>`.

---

### ACC-11: NavLink missing `aria-current="page"` for active route
**Status:** ACTIONABLE
**File:** `components/Layout.jsx:141-158`
**WCAG:** 4.1.2 Name, Role, Value (Level A)

React Router's `NavLink` does support `aria-current="page"` by default when active, so this may work automatically depending on the React Router version in use. However, the custom `className` callback uses only visual styling (background color, text color) to indicate the active page. If the version of React Router does not automatically add `aria-current`, it should be added explicitly.

**Fix:** Verify that `NavLink` adds `aria-current="page"` automatically. If not, add it in the active state: `aria-current={isActive ? "page" : undefined}`.

---

### ACC-12: Reduced motion preference only partially honored
**Status:** ACTIONABLE
**File:** `index.css:155-163`
**WCAG:** 2.3.3 Animation from Interactions (Level AAA)

The stylesheet includes a `prefers-reduced-motion: reduce` media query that sets `animation-duration` and `transition-duration` to near-zero. This is good. However, many components use Tailwind's `animate-spin`, `animate-pulse`, `animate-fade-in`, and custom animations (`animate-slide-in-right`) which may not be fully covered if custom animations are defined outside the CSS reset scope.

**Fix:** Verify that all custom `@keyframes` animations (slide-in-right, fade-in, pulse-dot) respect the `prefers-reduced-motion` media query. Add explicit overrides if needed.

---

## LOW

### ACC-13: Missing skip-to-content link
**Status:** ACTIONABLE
**File:** `components/Layout.jsx`
**WCAG:** 2.4.1 Bypass Blocks (Level A)

The layout has a sidebar navigation with 7+ links. There is no "Skip to main content" link to allow keyboard users to bypass the navigation and jump directly to the main content area. The `<main>` element exists but has no `id` to target.

**Fix:** Add a visually hidden (sr-only on focus: visible) skip link as the first focusable element in `Layout.jsx`: `<a href="#main-content" className="sr-only focus:not-sr-only ...">Skip to main content</a>`, and add `id="main-content"` to the `<main>` element.

---

### ACC-14: Live region for loading states
**Status:** DEFERRED
**Files:** Various (`LoadingSkeleton.jsx`, loading states in views)
**WCAG:** 4.1.3 Status Messages (Level AA)

When data is loading or refreshing, visual loading skeletons/spinners appear but there is no `aria-live` announcement. Screen reader users are not informed that content is loading or that it has finished loading. The toast system (`Toast.jsx`) correctly uses `aria-live="polite"` for notifications, but data loading/refresh cycles produce no screen reader feedback.

**Fix:** Add `aria-busy="true"` to containers while loading, and consider an `aria-live="polite"` region that announces "Loading..." and "Content loaded" state changes.

---

## Positive Findings (What Works Well)

1. **Semantic landmarks**: `<nav>`, `<main>`, `<aside>` are correctly used in `Layout.jsx`
2. **Focus-visible styles**: Global `:focus-visible` ring defined in `index.css` with proper `outline-offset`
3. **Toast notifications**: `aria-live="polite"`, proper `role="alert"/"status"`, dismiss button has `aria-label`
4. **Keyboard shortcuts system**: `KeyboardShortcuts.jsx` has `role="dialog"`, `aria-modal`, `aria-label`, Escape handler
5. **Activity panel**: Proper `aria-label`, `aria-expanded`, `aria-controls`, `aria-hidden` on decorative SVGs
6. **TaskDetailDrawer**: Has `role="dialog"`, `aria-modal`, `aria-label`, Escape handler, keyboard-accessible overlay
7. **Interactive div overlays**: Layout.jsx mobile overlay correctly adds `role="button"`, `tabIndex`, `aria-label`, `onKeyDown`
8. **Filter selects**: History view's filter dropdowns have `aria-label`
9. **TaskSubmitForm**: Proper `htmlFor`/`id` label associations throughout
10. **Toggle switches**: Governance, ProjectSettings, and StrategicConfig use `role="switch"` with `aria-checked` and `aria-label`
11. **Reduced motion**: `prefers-reduced-motion` media query exists in CSS
12. **Decorative SVGs**: Many icons use `aria-hidden="true"` correctly

---

## Recommendations (Priority Order)

1. **Add `aria-label` to all icon-only buttons** (ACC-01) -- quick fix, high impact
2. **Add `htmlFor`/`id` pairs to all label+input combos** (ACC-04) -- systematic, high impact
3. **Fix ChangePasswordModal** (ACC-03) -- add role/aria/escape/focus-trap
4. **Implement focus trapping in modals** (ACC-08) -- consider a shared utility
5. **Add ARIA tabs pattern to TabBar** (ACC-07) -- one component, used everywhere
6. **Add `scope` to table headers** (ACC-06) -- find-and-replace, medium effort
7. **Fix sortable headers** (ACC-02) -- button-in-th pattern
8. **Add skip-to-content link** (ACC-13) -- 3 lines of code
9. **Wrap remaining charts in `role="img"`** (ACC-09) -- spot fixes
10. **Add sr-only text to status indicators** (ACC-10) -- incremental
