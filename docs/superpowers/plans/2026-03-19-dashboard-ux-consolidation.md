# Dashboard UX Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the dashboard from 13 sidebar pages to 6 by merging related pages, adding system health indicators, and adding a live activity feed panel.

**Architecture:** Create 3 hub wrapper components (WorkflowsHub, InfrastructureHub, OperationsHub) that render existing views as tab content — no rewriting working components. Add HealthBar/HealthDots/ActivityPanel as new components. Update Layout sidebar and App routes.

**Tech Stack:** React (JSX), React Router, existing dashboard components, SSE for activity feed

**Spec:** `docs/superpowers/specs/2026-03-19-dashboard-ux-consolidation-design.md`

---

### Task 1: Create tabbed hub wrappers (WorkflowsHub, InfrastructureHub, OperationsHub)

**Files:**
- Create: `dashboard/src/views/WorkflowsHub.jsx`
- Create: `dashboard/src/views/InfrastructureHub.jsx`
- Create: `dashboard/src/views/OperationsHub.jsx`
- Create: `dashboard/src/components/TabBar.jsx` (shared tab component)

Create a reusable TabBar component and 3 hub wrappers that render existing views as tabs. Tab state syncs with URL hash for deep linking.

- [ ] **Step 1: Create TabBar component**

Create `dashboard/src/components/TabBar.jsx` — a simple horizontal tab bar:

```jsx
import { useState, useEffect } from 'react';

export default function TabBar({ tabs, defaultTab, onTabChange }) {
  const hash = window.location.hash.slice(1);
  const [active, setActive] = useState(hash || defaultTab || tabs[0]?.id);

  useEffect(() => {
    const onHash = () => setActive(window.location.hash.slice(1) || defaultTab);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [defaultTab]);

  useEffect(() => {
    if (onTabChange) onTabChange(active);
  }, [active, onTabChange]);

  return (
    <div className="flex gap-1 border-b border-slate-700 mb-6">
      {tabs.map(tab => (
        <a
          key={tab.id}
          href={`#${tab.id}`}
          onClick={(e) => { e.preventDefault(); window.location.hash = tab.id; setActive(tab.id); }}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            active === tab.id
              ? 'bg-slate-700 text-white border-b-2 border-blue-500'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
          }`}
        >
          {tab.label}
        </a>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create WorkflowsHub**

Create `dashboard/src/views/WorkflowsHub.jsx`:

```jsx
import { lazy, Suspense, useState } from 'react';
import TabBar from '../components/TabBar';

const Workflows = lazy(() => import('./Workflows'));
const BatchHistory = lazy(() => import('./BatchHistory'));
const PlanProjects = lazy(() => import('./PlanProjects'));

const TABS = [
  { id: 'workflows', label: 'Workflows' },
  { id: 'batches', label: 'Batches' },
  { id: 'projects', label: 'Projects' },
];

export default function WorkflowsHub() {
  const [tab, setTab] = useState('workflows');
  return (
    <div className="p-6">
      <h2 className="heading-lg text-white mb-4">Workflows</h2>
      <TabBar tabs={TABS} defaultTab="workflows" onTabChange={setTab} />
      <Suspense fallback={<div className="text-slate-400 p-4">Loading...</div>}>
        {tab === 'workflows' && <Workflows />}
        {tab === 'batches' && <BatchHistory />}
        {tab === 'projects' && <PlanProjects />}
      </Suspense>
    </div>
  );
}
```

- [ ] **Step 3: Create InfrastructureHub**

Same pattern with tabs: Hosts | Models.

- [ ] **Step 4: Create OperationsHub**

Same pattern with 5 tabs: Routing (renders Strategy + RoutingTemplates) | Schedules | Approvals | Coordination | Budget.

- [ ] **Step 5: Build and verify**

Run: `cd dashboard && npm run build`

- [ ] **Step 6: Commit**

```
git add dashboard/src/components/TabBar.jsx dashboard/src/views/WorkflowsHub.jsx dashboard/src/views/InfrastructureHub.jsx dashboard/src/views/OperationsHub.jsx
git commit -m "feat(dashboard): tabbed hub wrappers for Workflows, Infrastructure, Operations"
```

---

### Task 2: Update sidebar and routes

**Files:**
- Modify: `dashboard/src/components/Layout.jsx` — cut sidebar from 13 to 6 items
- Modify: `dashboard/src/App.jsx` — new routes + redirects for old URLs

- [ ] **Step 1: Update sidebar nav items**

In `Layout.jsx`, replace the 13-item NAV_LINKS with 6 items:

```jsx
const NAV_LINKS = [
  { to: '/', icon: KanbanIcon, label: 'Kanban' },
  { to: '/history', icon: HistoryIcon, label: 'History' },
  { to: '/workflows', icon: WorkflowIcon, label: 'Workflows' },
  { to: '/providers', icon: ChartIcon, label: 'Providers' },
  { to: '/infrastructure', icon: HostIcon, label: 'Infrastructure' },
  { to: '/operations', icon: StrategicIcon, label: 'Operations' },
];
```

Update `ROUTE_NAMES` to match.

Remove unused icon components that were only used by removed nav items.

- [ ] **Step 2: Update App.jsx routes**

Replace individual routes with hub routes and add redirects:

```jsx
<Route path="workflows" element={<WorkflowsHub />} />
<Route path="infrastructure" element={<InfrastructureHub />} />
<Route path="operations" element={<OperationsHub />} />

{/* Redirects for old bookmarks */}
<Route path="batches" element={<Navigate to="/workflows#batches" replace />} />
<Route path="projects" element={<Navigate to="/workflows#projects" replace />} />
<Route path="models" element={<Navigate to="/infrastructure#models" replace />} />
<Route path="hosts" element={<Navigate to="/infrastructure" replace />} />
<Route path="budget" element={<Navigate to="/operations#budget" replace />} />
<Route path="schedules" element={<Navigate to="/operations#schedules" replace />} />
<Route path="approvals" element={<Navigate to="/operations#approvals" replace />} />
<Route path="coordination" element={<Navigate to="/operations#coordination" replace />} />
<Route path="strategy" element={<Navigate to="/operations#routing" replace />} />
```

Remove old lazy imports that are now loaded within hub wrappers.

- [ ] **Step 3: Build and verify**

Run: `cd dashboard && npm run build`

- [ ] **Step 4: Commit**

```
git add dashboard/src/components/Layout.jsx dashboard/src/App.jsx
git commit -m "feat(dashboard): consolidate sidebar from 13 to 6 items with redirects"
```

---

### Task 3: Health indicators (HealthBar + HealthDots)

**Files:**
- Create: `dashboard/src/components/HealthBar.jsx` — Kanban header health strip
- Create: `dashboard/src/components/HealthDots.jsx` — sidebar footer dots
- Modify: `dashboard/src/views/Kanban.jsx` — add HealthBar at top
- Modify: `dashboard/src/components/Layout.jsx` — add HealthDots in sidebar footer

- [ ] **Step 1: Create HealthDots component**

A row of 3 dots at the bottom of the sidebar. Fetches `/api/provider-quotas` and `/api/hosts` on mount and every 30 seconds.

```jsx
// Props: none (self-fetching)
// Renders: 3 dots (Providers, Hosts, Budget) with tooltips
// Green = all healthy, Yellow = degraded, Red = critical
// Click navigates to relevant page
```

- [ ] **Step 2: Create HealthBar component**

A horizontal strip with 4 sections: Providers (count + dots), Hosts (count + dots), Queue depth, Budget gauge.

```jsx
// Props: none (self-fetching)
// Fetches: /api/provider-quotas, /api/hosts, task counts, budget
// Renders: inline row of 4 stat boxes with colored indicators
```

- [ ] **Step 3: Wire into Layout and Kanban**

In `Layout.jsx`, add `<HealthDots />` in the sidebar footer (below nav links, above the collapse area).

In `Kanban.jsx`, add `<HealthBar />` above the stat cards row.

- [ ] **Step 4: Build and verify**

Run: `cd dashboard && npm run build`

- [ ] **Step 5: Commit**

```
git add dashboard/src/components/HealthBar.jsx dashboard/src/components/HealthDots.jsx dashboard/src/views/Kanban.jsx dashboard/src/components/Layout.jsx
git commit -m "feat(dashboard): system health indicators in sidebar and Kanban header"
```

---

### Task 4: Activity feed panel

**Files:**
- Create: `dashboard/src/components/ActivityPanel.jsx` — collapsible right-side event feed
- Modify: `dashboard/src/views/Kanban.jsx` — integrate activity panel

- [ ] **Step 1: Create ActivityPanel component**

A collapsible right-side panel (300px wide when expanded). Shows reverse-chronological event stream.

```jsx
// Props: events (array), isOpen, onToggle
// Events: { type, message, timestamp, severity }
// Renders: scrollable list of event items with icon + timestamp + description
// Header: "Activity" with clear button and collapse button
// Max 100 items, oldest trimmed
```

Event types and their display:
- `task_complete` → green checkmark + "cerebras completed task X (2s)"
- `task_fail` → red X + "groq failed task Y: timeout"
- `rate_limit` → yellow warning + "groq hit 429 — cooldown 60s"
- `workflow_complete` → blue flag + "workflow Z finished (5/5)"
- `stall_warning` → orange clock + "task X stalled (180s)"
- `host_down` → red dot + "BahumutsOmen went offline"

- [ ] **Step 2: Wire SSE events into Kanban**

The dashboard already receives SSE push events via WebSocket. In Kanban.jsx, collect incoming events into an `activityLog` state array. Pass to ActivityPanel.

```jsx
const [activityLog, setActivityLog] = useState([]);
const [activityOpen, setActivityOpen] = useState(false);

// In the existing WebSocket/SSE handler:
// Push new events to activityLog (prepend, cap at 100)
```

- [ ] **Step 3: Layout integration**

Adjust Kanban layout to accommodate the panel:
- When closed: full-width kanban + a small toggle button on the right edge
- When open: kanban shrinks by 300px, panel slides in from right

```jsx
<div className="flex h-full">
  <div className={`flex-1 overflow-auto ${activityOpen ? 'mr-[300px]' : ''}`}>
    {/* existing kanban content */}
  </div>
  <ActivityPanel events={activityLog} isOpen={activityOpen} onToggle={() => setActivityOpen(!activityOpen)} />
</div>
```

- [ ] **Step 4: Build and verify**

Run: `cd dashboard && npm run build`

- [ ] **Step 5: Commit**

```
git add dashboard/src/components/ActivityPanel.jsx dashboard/src/views/Kanban.jsx
git commit -m "feat(dashboard): collapsible activity feed panel on Kanban page"
```

---

### Task 5: Final build + cleanup

**Files:**
- Modify: `dashboard/dist/` — rebuild

- [ ] **Step 1: Full dashboard build**

```
cd dashboard && npm run build
```

- [ ] **Step 2: Verify all routes work**

Manually check (or use the test suite):
- `/` → Kanban with health bar + activity panel
- `/history` → History page
- `/workflows` → WorkflowsHub with 3 tabs
- `/workflows#batches` → Batches tab
- `/providers` → Providers with quotas
- `/infrastructure` → Hosts tab
- `/infrastructure#models` → Models tab
- `/operations` → Routing tab
- `/operations#budget` → Budget tab
- `/batches` → redirects to `/workflows#batches`
- `/strategy` → redirects to `/operations#routing`

- [ ] **Step 3: Commit build**

```
git add -A
git commit -m "build: dashboard rebuild with UX consolidation — 13 pages to 6"
```
