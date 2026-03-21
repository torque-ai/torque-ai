# Dashboard Sidebar UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the sidebar so the collapse button and connection indicator are at the top (not buried at the bottom), remove the HealthDots component, and rewrite HealthBar on the Kanban page to show all providers from the V2 API with a click-to-expand popover.

**Architecture:** Three independent changes: (1) Layout.jsx sidebar restructure, (2) HealthBar.jsx rewrite with new data source and expandable UI, (3) HealthDots.jsx deletion. No backend changes needed — the `/api/v2/providers` endpoint already returns all provider statuses.

**Tech Stack:** React, Tailwind CSS, Vitest, React Testing Library

**Spec:** `docs/superpowers/specs/2026-03-21-dashboard-sidebar-ux-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `dashboard/src/components/Layout.jsx` | Modify | Move collapse button + connection indicator into header row; remove HealthDots usage and bottom sections |
| `dashboard/src/components/Layout.test.jsx` | Modify | Update assertions for new header structure; add collapse button aria-label test |
| `dashboard/src/components/HealthBar.jsx` | Rewrite | New data source (`providers.list()`), click-to-expand popover, all-provider grid |
| `dashboard/src/components/HealthBar.test.jsx` | Create | Test compact/expanded states, status dot colors, error/empty edge cases |
| `dashboard/src/components/HealthDots.jsx` | Delete | No longer used anywhere |

---

### Task 1: Rewrite HealthBar with V2 provider data and expandable popover

**Files:**
- Rewrite: `dashboard/src/components/HealthBar.jsx`
- Create: `dashboard/src/components/HealthBar.test.jsx`

**Context:** The existing HealthBar fetches `/api/provider-quotas` (only quota-tracked providers) and renders a static compact bar. The rewrite switches to `providers.list()` from `dashboard/src/api.js` (which calls `requestV2('/providers').then(d => d.items || d)`). **Important:** the V2 envelope unwraps to `{ providers: [...] }`, which has no `.items` key, so the `.then` fallback returns the object itself — NOT an array. The HealthBar must extract `result.providers` or handle both shapes. Each provider object has `{ id, name, enabled, status }` where status is one of: `healthy`, `degraded`, `unavailable`, `disabled`.

- [ ] **Step 1: Write failing tests for the new HealthBar**

Create `dashboard/src/components/HealthBar.test.jsx`:

```jsx
import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock the api module
vi.mock('../api', () => ({
  providers: { list: vi.fn() },
  request: vi.fn(),
}));

import HealthBar from './HealthBar';
import { providers, request } from '../api';

const MOCK_PROVIDERS = [
  { id: 'codex', name: 'Codex', enabled: true, status: 'healthy' },
  { id: 'ollama', name: 'Ollama', enabled: true, status: 'healthy' },
  { id: 'deepinfra', name: 'DeepInfra', enabled: true, status: 'degraded' },
  { id: 'hyperbolic', name: 'Hyperbolic', enabled: true, status: 'unavailable' },
  { id: 'anthropic', name: 'Anthropic', enabled: false, status: 'disabled' },
];

describe('HealthBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    providers.list.mockResolvedValue(MOCK_PROVIDERS);
    request.mockResolvedValue({ tasks: [{ id: '1' }, { id: '2' }] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders compact bar with healthy count', async () => {
    await act(async () => { render(<HealthBar />); });
    expect(screen.getByText('2/5')).toBeInTheDocument();
  });

  it('fetches from providers.list not provider-quotas', async () => {
    await act(async () => { render(<HealthBar />); });
    expect(providers.list).toHaveBeenCalled();
  });

  it('shows provider grid when clicked', async () => {
    await act(async () => { render(<HealthBar />); });
    const providerSection = screen.getByText('Providers:').closest('button');
    fireEvent.click(providerSection);
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('deepinfra')).toBeInTheDocument();
    expect(screen.getByText('anthropic')).toBeInTheDocument();
  });

  it('shows status labels for non-healthy providers', async () => {
    await act(async () => { render(<HealthBar />); });
    const providerSection = screen.getByText('Providers:').closest('button');
    fireEvent.click(providerSection);
    expect(screen.getByText('degraded')).toBeInTheDocument();
    expect(screen.getByText('unavailable')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('closes popover when clicking outside', async () => {
    await act(async () => { render(<HealthBar />); });
    const providerSection = screen.getByText('Providers:').closest('button');
    fireEvent.click(providerSection);
    expect(screen.getByText('codex')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('codex')).toBeNull();
  });

  it('shows "none" when zero providers returned', async () => {
    providers.list.mockResolvedValue([]);
    await act(async () => { render(<HealthBar />); });
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('shows "err" when API fails', async () => {
    providers.list.mockRejectedValue(new Error('Network error'));
    await act(async () => { render(<HealthBar />); });
    expect(screen.getByText('err')).toBeInTheDocument();
  });

  it('polls every 30 seconds', async () => {
    await act(async () => { render(<HealthBar />); });
    expect(providers.list).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(providers.list).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && npx vitest run src/components/HealthBar.test.jsx`
Expected: FAIL — tests reference new behavior not yet implemented.

- [ ] **Step 3: Rewrite HealthBar.jsx**

Replace `dashboard/src/components/HealthBar.jsx` with:

```jsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { providers as providersApi, request } from '../api';

const STATUS_DOT = {
  healthy: 'bg-green-500',
  degraded: 'bg-yellow-500',
  unavailable: 'bg-red-500',
  disabled: 'bg-slate-600',
};

const STATUS_TEXT = {
  healthy: 'text-slate-200',
  degraded: 'text-slate-200',
  unavailable: 'text-slate-200',
  disabled: 'text-slate-500',
};

function getRunningTaskCount(raw) {
  if (Array.isArray(raw?.tasks)) return raw.tasks.length;
  const total = Number(raw?.pagination?.total);
  return Number.isFinite(total) ? total : 0;
}

export default function HealthBar() {
  const [providerList, setProviderList] = useState([]);
  const [runningCount, setRunningCount] = useState(0);
  const [providerError, setProviderError] = useState(null);
  const [tasksError, setTasksError] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef(null);

  const refresh = useCallback(async (active = { current: true }) => {
    const [provResult, runResult] = await Promise.allSettled([
      providersApi.list(),
      request('/tasks?status=running'),
    ]);

    if (!active.current) return;

    if (provResult.status === 'fulfilled') {
      const raw = provResult.value;
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.providers) ? raw.providers : [];
      setProviderList(list);
      setProviderError(null);
    } else {
      setProviderError(provResult.reason?.message || 'Failed to load providers');
    }

    if (runResult.status === 'fulfilled') {
      setRunningCount(getRunningTaskCount(runResult.value));
      setTasksError(null);
    } else {
      setTasksError(runResult.reason?.message || 'Failed to load tasks');
    }
  }, []);

  useEffect(() => {
    const active = { current: true };
    refresh(active);
    const id = window.setInterval(() => refresh(active), 30000);
    return () => { active.current = false; window.clearInterval(id); };
  }, [refresh]);

  // Click outside to close
  useEffect(() => {
    if (!expanded) return;
    function handleMouseDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setExpanded(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [expanded]);

  const healthyCount = useMemo(
    () => providerList.filter((p) => p.status === 'healthy').length,
    [providerList],
  );

  const providerSummary = providerList.length === 0
    ? 'none'
    : `${healthyCount}/${providerList.length}`;

  return (
    <div ref={containerRef} className="glass-card mb-4 relative">
      {/* Compact bar */}
      <div className="flex flex-wrap items-center gap-6 p-3 text-xs text-slate-400">
        <button
          onClick={() => !providerError && setExpanded((s) => !s)}
          className="flex items-center gap-2 hover:text-slate-200 transition-colors"
        >
          <span>Providers:</span>
          {providerError ? (
            <span className="font-medium tabular-nums text-red-400" title={providerError}>err</span>
          ) : (
            <>
              <span className="font-medium tabular-nums text-slate-200">{providerSummary}</span>
              {providerList.length > 0 && <span className="text-[10px]">healthy</span>}
              <span className="text-[10px] text-slate-500">{expanded ? '▴' : '▾'}</span>
            </>
          )}
        </button>
        <div className="flex items-center gap-2">
          <span>Queue:</span>
          {tasksError ? (
            <span className="font-medium tabular-nums text-red-400" title={tasksError}>err</span>
          ) : (
            <span className="font-medium tabular-nums text-slate-200">{runningCount}</span>
          )}
        </div>
      </div>

      {/* Expanded popover */}
      {expanded && providerList.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-slate-800/95 border border-slate-700 rounded-lg p-3 shadow-lg z-50 max-h-64 overflow-y-auto">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
            {providerList.map((p) => (
              <div key={p.id} className="flex items-center gap-2 py-0.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[p.status] || STATUS_DOT.disabled}`} />
                <span className={STATUS_TEXT[p.status] || STATUS_TEXT.disabled}>{p.id}</span>
                {p.status !== 'healthy' && (
                  <span className={`text-[10px] ${
                    p.status === 'degraded' ? 'text-yellow-500' :
                    p.status === 'unavailable' ? 'text-red-500' :
                    'text-slate-500'
                  }`}>
                    {p.status}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && npx vitest run src/components/HealthBar.test.jsx`
Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/HealthBar.jsx dashboard/src/components/HealthBar.test.jsx
git commit -m "feat(dashboard): rewrite HealthBar to show all providers via V2 API with expandable popover"
```

---

### Task 2: Reorganize sidebar header in Layout.jsx

**Files:**
- Modify: `dashboard/src/components/Layout.jsx`
- Modify: `dashboard/src/components/Layout.test.jsx`

**Context:** Currently the sidebar has: logo header → nav → HealthDots → collapse button → connection indicator (at very bottom with `border-t`). We need to move the collapse button and connection indicator into the logo header area, and remove HealthDots entirely. The `showStatus` state and status panel popover move with the connection indicator. In the new layout, the status panel should appear *below* the header (absolute positioned downward) instead of the current `bottom-full` positioning.

- [ ] **Step 1: Write failing test for collapse button in header**

Add to `dashboard/src/components/Layout.test.jsx`:

```jsx
it('renders collapse button with aria-label in sidebar header', () => {
  renderLayout();
  const collapseBtn = screen.getByLabelText('Collapse sidebar');
  // Should be inside the sidebar header (border-b parent), not at the bottom
  const header = collapseBtn.closest('[data-testid="sidebar-header"]');
  expect(header).toBeInTheDocument();
});

it('renders connection indicator in sidebar header', () => {
  renderLayout({ isConnected: true });
  const header = screen.getByTestId('sidebar-header');
  expect(header).toContainElement(screen.getByLabelText('Connection status: connected'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/components/Layout.test.jsx`
Expected: FAIL — `sidebar-header` test ID doesn't exist yet.

- [ ] **Step 3: Modify Layout.jsx — move controls to header, remove bottom sections**

In `dashboard/src/components/Layout.jsx`:

**3a. Remove the HealthDots import (line 6):**
Delete `import HealthDots from './HealthDots';`

**3b. Replace the logo header section (lines 199-210) with the new header that includes collapse button and connection indicator:**

Replace:
```jsx
        {/* Logo */}
        <div className={`p-5 ${collapsed ? 'md:p-3 md:flex md:justify-center' : ''} border-b border-slate-800`}>
          <div className={collapsed ? 'md:hidden' : ''}>
            <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent tracking-tight">
              TORQUE
            </h1>
            <p className="text-[11px] text-slate-500 mt-0.5 tracking-wide">Task Orchestration</p>
          </div>
          {collapsed && (
            <span className="hidden md:block text-lg font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">T</span>
          )}
        </div>
```

With:
```jsx
        {/* Header: Logo + Connection + Collapse */}
        <div data-testid="sidebar-header" className={`p-4 ${collapsed ? 'md:p-3' : ''} border-b border-slate-800 relative`}>
          <div className={`flex items-center ${collapsed ? 'md:flex-col md:gap-2' : 'justify-between'}`}>
            <div className={collapsed ? 'md:hidden' : ''}>
              <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent tracking-tight">
                TORQUE
              </h1>
              <p className="text-[11px] text-slate-500 mt-0.5 tracking-wide">Task Orchestration</p>
            </div>
            {collapsed && (
              <span className="hidden md:block text-lg font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">T</span>
            )}
            <div className={`flex items-center gap-2 ${collapsed ? 'md:gap-1.5' : ''}`}>
              <button
                onClick={() => setShowStatus((s) => !s)}
                title={isConnected ? 'Connected' : isReconnecting ? 'Reconnecting' : 'Disconnected'}
                aria-label={isConnected ? 'Connection status: connected' : isReconnecting ? 'Connection status: reconnecting' : 'Connection status: disconnected'}
                className="p-1 rounded hover:bg-slate-700/50 transition-colors"
              >
                <span
                  className={`block w-2 h-2 rounded-full shrink-0 ${
                    isConnected ? 'bg-green-500 pulse-dot' : isReconnecting ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'
                  }`}
                />
              </button>
              <button
                onClick={toggleCollapsed}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors hidden md:flex items-center justify-center"
                title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                <CollapseIcon collapsed={collapsed} />
              </button>
            </div>
          </div>
          {/* Connection status text - expanded sidebar only */}
          <span className={`text-slate-400 text-xs mt-1 block ${collapsed ? 'md:hidden' : ''}`}>
            {isConnected ? 'Connected' : isReconnecting ? 'Reconnecting...' : 'Disconnected'}
          </span>
          {/* Status panel popover - now drops down from header */}
          {showStatus && (
            <div className="absolute top-full left-2 right-2 mt-2 bg-slate-800 border border-slate-700 rounded-lg p-3 shadow-lg z-50">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-white">System Status</h4>
                <button onClick={() => setShowStatus(false)} className="text-slate-500 hover:text-white" aria-label="Close status panel">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">WebSocket</span>
                  <span className={isConnected ? 'text-green-400' : isReconnecting ? 'text-yellow-400' : 'text-red-400'}>
                    {isConnected ? 'Connected' : isReconnecting ? 'Reconnecting' : 'Disconnected'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Failed tasks</span>
                  <span className={failedCount > 0 ? 'text-red-400' : 'text-slate-300'}>{failedCount}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Stuck tasks</span>
                  <span className={stuckCount > 0 ? 'text-amber-400' : 'text-slate-300'}>{stuckCount}</span>
                </div>
              </div>
            </div>
          )}
        </div>
```

**3c. Remove the HealthDots section (lines 219-221):**
Delete:
```jsx
        <div className={`px-3 ${collapsed ? 'md:px-1.5' : ''}`}>
          <HealthDots />
        </div>
```

**3d. Remove the collapse toggle button (lines 223-231):**
Delete:
```jsx
        {/* Collapse toggle - desktop only */}
        <button
          onClick={toggleCollapsed}
          className="mx-3 mb-2 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors hidden md:flex items-center justify-center"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <CollapseIcon collapsed={collapsed} />
        </button>
```

**3e. Remove the entire bottom status section (lines 233-276):**
Delete from `{/* Status */}` through its closing `</div>`.

- [ ] **Step 4: Update existing Layout tests**

In `dashboard/src/components/Layout.test.jsx`, the existing connection status tests (lines 50-63) check for text like "Connected", "Reconnecting...", "Disconnected". These still render in the header, but the text is now inside the header area conditionally. Update the tests:

Replace the three status tests:
```jsx
  it('shows connected status', () => {
    renderLayout({ isConnected: true });
    expect(screen.getByLabelText('Connection status: connected')).toBeInTheDocument();
  });

  it('shows reconnecting status', () => {
    renderLayout({ isConnected: false, isReconnecting: true });
    expect(screen.getByLabelText('Connection status: reconnecting')).toBeInTheDocument();
  });

  it('shows disconnected status', () => {
    renderLayout({ isConnected: false, isReconnecting: false });
    expect(screen.getByLabelText('Connection status: disconnected')).toBeInTheDocument();
  });
```

- [ ] **Step 5: Run all Layout tests**

Run: `cd dashboard && npx vitest run src/components/Layout.test.jsx`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/Layout.jsx dashboard/src/components/Layout.test.jsx
git commit -m "feat(dashboard): move collapse button and connection indicator to sidebar header"
```

---

### Task 3: Delete HealthDots component

**Files:**
- Delete: `dashboard/src/components/HealthDots.jsx`

**Context:** HealthDots is no longer imported anywhere after Task 2 removed it from Layout.jsx. Verify no other files import it before deleting.

- [ ] **Step 1: Verify no remaining imports of HealthDots**

Run: `cd dashboard && grep -r "HealthDots" src/ --include="*.jsx" --include="*.js"`
Expected: Zero matches (Layout.jsx import was removed in Task 2).

- [ ] **Step 2: Delete the file**

```bash
rm dashboard/src/components/HealthDots.jsx
```

- [ ] **Step 3: Run full dashboard test suite to confirm nothing breaks**

Run: `cd dashboard && npx vitest run`
Expected: All tests PASS. No test imports HealthDots directly.

- [ ] **Step 4: Commit**

```bash
git add -u dashboard/src/components/HealthDots.jsx
git commit -m "chore(dashboard): remove unused HealthDots component"
```
