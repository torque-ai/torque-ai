# Remote Test Coordinator — Phase 3b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the workstation Remote Test Coordinator's live state in the TORQUE dashboard. A new React component `RemoteCoordPanel.jsx` polls `GET /api/coord/active` every 5s and displays one row per active workstation lock (project / sha / suite / host:pid / started / elapsed). Wires into the existing `views/Coordination.jsx` view as a top section.

**Architecture:** Self-contained component. On mount: `fetch('/api/coord/active')` via a thin `coord` API helper, repeats on a 5s `setInterval`, cleans up on unmount. State is `{loading, payload, error}`. Render branches: `loading` → skeleton, `payload.reachable === false` → "Workstation daemon: not reachable" subtle line, `payload.active.length === 0` → "Workstation idle" subtle line, otherwise → table with one row per active lock.

**Tech Stack:** React 18 (function components + hooks), tailwind classes (matching the rest of the dashboard's dark theme), vitest + @testing-library/react + jsdom.

**Source spec:** `docs/superpowers/specs/2026-04-27-remote-test-coordinator-design.md` §5.5. Phase 3a (REST endpoint + MCP tool) shipped at merge `a67ee218` on 2026-04-27 and the endpoint is the dependency for this plan.

**Endpoint payload contract** (already live on origin/main, do not change):

```json
{
  "active": [
    {
      "lock_id": "abc123...",
      "project": "torque-public",
      "sha": "deadbeef0123",
      "suite": "gate",
      "holder": { "host": "omenhost", "pid": 1234, "user": "k" },
      "created_at": "2026-04-27T12:00:00.000Z",
      "last_heartbeat_at": "2026-04-27T12:01:00.000Z"
    }
  ],
  "reachable": true,
  "cached_at": "2026-04-27T12:01:30.000Z",
  "served_from_cache": true
}
```

When the workstation is unreachable: `{active: [], reachable: false, error: "no_workstation_configured"|"timeout"|...}`. The component must handle all three states (active rows, reachable+empty, unreachable) without throwing.

**Out of scope (separate plans):**
- Phase 3c — Cross-machine wrapper coord (have `bin/torque-remote` ssh-tunnel to workstation daemon when running on a dev box).
- Adding "last log line" column from spec §5.5 — Phase 3a's `/active` endpoint doesn't return per-lock log tails. Display only the fields the endpoint actually exposes; defer log-tail integration to a later phase if it ever ships.
- Mount-location bikeshedding. The plan picks `views/Coordination.jsx`. If during execution a stronger fit becomes obvious, switching to `views/OperationsHub.jsx` or a new sidebar item is a one-line change.

---

## File structure

```
dashboard/src/
  api.js                         # MODIFY: add `coord` group with getActive()

  components/
    RemoteCoordPanel.jsx         # NEW: the polling + render component

  components/
    RemoteCoordPanel.test.jsx    # NEW: 3 tests (active rows, reachable+empty, unreachable)

  views/
    Coordination.jsx             # MODIFY: import + mount RemoteCoordPanel near top
```

---

## Task 1: Add `coord` API helper

**Files:**
- Modify: `dashboard/src/api.js`

The endpoint is `/api/coord/active` (NOT under `/api/v2/`). Existing `requestV2()` helper is wrong because it unwraps a `{data, meta}` envelope this endpoint doesn't use. Use plain `fetch()` instead.

- [ ] **Step 1: Read the existing `api.js` to find a non-v2 fetch pattern**

Run: `grep -n "fetch(" dashboard/src/api.js | head -10`

Most groups in the file go through `requestV2`. The `/api/coord/active` endpoint is plain (returns the JSON body directly, status 200 on both reachable and unreachable cases). Mirror the simplest non-v2 helper you see (or just use `fetch` directly inside the helper — no other indirection needed).

- [ ] **Step 2: Add the coord group near the bottom of api.js (just before the default export)**

Insert this block immediately before the existing `export default { ... }` line:

```javascript
// ─── Remote Test Coordinator (workstation lock daemon mirror) ──────────────

export const coord = {
  getActive: async (opts = {}) => {
    const ctrl = opts.signal ? null : new AbortController();
    const signal = opts.signal || ctrl?.signal;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeout_ms || 8000) : null;
    try {
      const res = await fetch('/api/coord/active', { signal, credentials: 'same-origin' });
      if (!res.ok) {
        // The endpoint always returns 200 even when the workstation is
        // unreachable. A non-200 here means the TORQUE server itself failed,
        // which is a different concern — surface it as an error.
        throw new Error(`/api/coord/active returned HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};
```

- [ ] **Step 3: Add `coord` to the default-export object**

Find the line `export default { tasks, providers, ... }` at the bottom of the file. Add `coord` to that list (alphabetical placement is fine but not required — match whatever ordering convention the existing list uses).

- [ ] **Step 4: Sanity-check the helper compiles**

Run: `cd dashboard && npx vite build 2>&1 | tail -5`

Expected: build succeeds (no syntax errors). Don't verify the runtime path — that's covered in Task 2's test.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/api.js
git commit -m "feat(dashboard): coord.getActive() API helper for /api/coord/active"
```

---

## Task 2: RemoteCoordPanel component + tests

**Files:**
- Create: `dashboard/src/components/RemoteCoordPanel.jsx`
- Create: `dashboard/src/components/RemoteCoordPanel.test.jsx`

The component owns its own polling state. Refresh interval: 5s. Cleanup on unmount.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/components/RemoteCoordPanel.test.jsx`:

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import RemoteCoordPanel from './RemoteCoordPanel';

const ACTIVE_PAYLOAD = {
  active: [
    {
      lock_id: 'abc12345deadbeef',
      project: 'torque-public',
      sha: 'deadbeef0123',
      suite: 'gate',
      holder: { host: 'omenhost', pid: 1234, user: 'k' },
      created_at: '2026-04-27T12:00:00.000Z',
      last_heartbeat_at: '2026-04-27T12:01:00.000Z',
    },
  ],
  reachable: true,
  cached_at: '2026-04-27T12:01:30.000Z',
};

const UNREACHABLE_PAYLOAD = {
  active: [],
  reachable: false,
  error: 'no_workstation_configured',
  cached_at: '2026-04-27T12:00:00.000Z',
};

const IDLE_PAYLOAD = {
  active: [],
  reachable: true,
  cached_at: '2026-04-27T12:00:00.000Z',
};

describe('RemoteCoordPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders one row per active workstation lock', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ACTIVE_PAYLOAD,
    })));
    render(<RemoteCoordPanel />);
    await waitFor(() => {
      expect(screen.getByText('torque-public')).toBeInTheDocument();
    });
    expect(screen.getByText('gate')).toBeInTheDocument();
    expect(screen.getByText(/omenhost/)).toBeInTheDocument();
    expect(screen.getByText(/1234/)).toBeInTheDocument();
    // sha rendered short (first 8 chars is the convention)
    expect(screen.getByText('deadbeef')).toBeInTheDocument();
  });

  it('shows "Workstation idle" when reachable with no active locks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => IDLE_PAYLOAD,
    })));
    render(<RemoteCoordPanel />);
    await waitFor(() => {
      expect(screen.getByText(/Workstation idle/i)).toBeInTheDocument();
    });
  });

  it('shows "not reachable" when daemon is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => UNREACHABLE_PAYLOAD,
    })));
    render(<RemoteCoordPanel />);
    await waitFor(() => {
      expect(screen.getByText(/not reachable/i)).toBeInTheDocument();
    });
    // Surface the error code for diagnostics
    expect(screen.getByText(/no_workstation_configured/)).toBeInTheDocument();
  });

  it('polls every 5s', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => IDLE_PAYLOAD,
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<RemoteCoordPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd dashboard && npx vitest run src/components/RemoteCoordPanel.test.jsx`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the component**

Create `dashboard/src/components/RemoteCoordPanel.jsx`:

```javascript
import { useEffect, useState } from 'react';

const POLL_INTERVAL_MS = 5000;

function shortSha(sha) {
  if (!sha) return '';
  return String(sha).slice(0, 8);
}

function elapsedSeconds(isoStart) {
  if (!isoStart) return null;
  const startMs = Date.parse(isoStart);
  if (Number.isNaN(startMs)) return null;
  return Math.max(0, Math.round((Date.now() - startMs) / 1000));
}

function formatElapsed(secs) {
  if (secs == null) return '—';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

export function RemoteCoordPanel() {
  const [payload, setPayload] = useState(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch('/api/coord/active', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) {
          setPayload(body);
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err && err.message ? err.message : 'fetch failed');
      }
    };

    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (loadError) {
    return (
      <div
        role="status"
        aria-label="Remote coordinator panel error"
        className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-amber-100 text-sm"
      >
        Workstation coord panel: {loadError}
      </div>
    );
  }

  if (!payload) {
    return (
      <div
        role="status"
        aria-label="Loading workstation coord state"
        className="rounded-lg border border-slate-700/40 bg-slate-800/40 px-4 py-2 text-slate-400 text-sm"
      >
        Loading workstation coord…
      </div>
    );
  }

  if (!payload.reachable) {
    return (
      <div
        role="status"
        aria-label="Workstation coord daemon not reachable"
        className="rounded-lg border border-slate-700/40 bg-slate-800/40 px-4 py-2 text-slate-400 text-sm"
      >
        Workstation coord daemon: not reachable
        {payload.error ? <span className="ml-2 font-mono text-xs text-slate-500">({payload.error})</span> : null}
      </div>
    );
  }

  if (!payload.active || payload.active.length === 0) {
    return (
      <div
        role="status"
        aria-label="Workstation idle"
        className="rounded-lg border border-slate-700/40 bg-slate-800/40 px-4 py-2 text-slate-400 text-sm"
      >
        Workstation idle — no active runs.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-700/40 bg-slate-800/40 overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-700/40 text-sm text-slate-300">
        Workstation: {payload.active.length} active run{payload.active.length === 1 ? '' : 's'}
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-900/40 text-xs text-slate-400">
          <tr>
            <th className="text-left p-2 font-medium">Project</th>
            <th className="text-left p-2 font-medium">SHA</th>
            <th className="text-left p-2 font-medium">Suite</th>
            <th className="text-left p-2 font-medium">Host</th>
            <th className="text-left p-2 font-medium">Started</th>
            <th className="text-left p-2 font-medium">Elapsed</th>
          </tr>
        </thead>
        <tbody>
          {payload.active.map((lock) => (
            <tr key={lock.lock_id} className="border-t border-slate-700/30 text-slate-200">
              <td className="p-2">{lock.project}</td>
              <td className="p-2 font-mono text-xs">{shortSha(lock.sha)}</td>
              <td className="p-2">{lock.suite}</td>
              <td className="p-2 text-xs text-slate-400">
                {lock.holder?.host || '?'}:{lock.holder?.pid ?? '?'}
              </td>
              <td className="p-2 text-xs text-slate-400">
                {lock.created_at ? new Date(lock.created_at).toLocaleTimeString() : '—'}
              </td>
              <td className="p-2 text-xs text-slate-400">
                {formatElapsed(elapsedSeconds(lock.created_at))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default RemoteCoordPanel;
```

- [ ] **Step 4: Run test — verify all 4 tests pass**

Run: `cd dashboard && npx vitest run src/components/RemoteCoordPanel.test.jsx`

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/RemoteCoordPanel.jsx dashboard/src/components/RemoteCoordPanel.test.jsx
git commit -m "feat(dashboard): RemoteCoordPanel — workstation lock daemon mirror"
```

---

## Task 3: Mount the panel in `views/Coordination.jsx`

**Files:**
- Modify: `dashboard/src/views/Coordination.jsx`

The existing `Coordination` view is for agent coordination, but conceptually "what concurrent things are happening across this workstation" fits there too. Mount as a top-of-page section, above the existing agent table.

- [ ] **Step 1: Read the top of Coordination.jsx to find the right insertion point**

Run: `head -30 dashboard/src/views/Coordination.jsx`

Look for:
- The existing import block (add the new import there).
- The first JSX element returned by the default-exported component (insert the panel right inside that, as the first child).

- [ ] **Step 2: Add the import**

Add this line near the other `from '../components/...'` imports at the top of the file:

```javascript
import RemoteCoordPanel from '../components/RemoteCoordPanel';
```

- [ ] **Step 3: Mount the panel as the first child of the main return JSX**

Find the `return (` statement in the main exported component. Insert `<RemoteCoordPanel />` as the first child of the outermost wrapper element, with a wrapping `<div className="mb-4">` so it gets vertical spacing from whatever follows. If the outermost wrapper is a fragment (`<>`), still wrap the panel in a `<div className="mb-4">` for spacing consistency.

Example structure (adapt to whatever the existing wrapper is):

```javascript
return (
  <div className="...existing classes...">
    <div className="mb-4">
      <RemoteCoordPanel />
    </div>
    {/* ... existing content ... */}
  </div>
);
```

- [ ] **Step 4: Run the dashboard test suite to confirm nothing regressed**

Run: `cd dashboard && npx vitest run src/views/Coordination.test.jsx`

Expected: existing Coordination tests still pass. The new panel is rendered at the top but the existing tests don't query for it, so they should be unaffected.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/views/Coordination.jsx
git commit -m "feat(dashboard): mount RemoteCoordPanel atop Coordination view"
```

---

## Task 4: Cutover

**Files:** none new — git operation + dashboard rebuild.

- [ ] **Step 1: Run the full dashboard test sweep as final pre-flight**

```bash
cd dashboard && npx vitest run \
  src/components/RemoteCoordPanel.test.jsx \
  src/views/Coordination.test.jsx
```

Expected: all pass.

- [ ] **Step 2: Rebuild the dashboard bundle**

```bash
cd dashboard && npx vite build
```

Expected: clean build. The cutover script also rebuilds, but doing it manually first surfaces any build error before the merge.

If `dashboard/dist/index.html` changed, stage + commit it as a separate cleanup commit (the cutover script's gate would otherwise warn):

```bash
git add dashboard/dist/index.html && git commit -m "chore(dashboard): rebuild bundle for RemoteCoordPanel"
```

- [ ] **Step 3: Run cutover from the main checkout**

From the main checkout (parent of the worktree):

```bash
scripts/worktree-cutover.sh remote-test-coord-phase3b
```

The cutover merges, drains TORQUE if running, restarts on the new code, and cleans up the worktree. Since `dashboard/src/` changed in this merge, the cutover script will auto-rebuild the bundle (idempotent rebuild).

- [ ] **Step 4: Verify the panel renders against a live TORQUE**

After TORQUE restarts:

```bash
# Confirm the underlying endpoint still works (sanity check that Phase 3a is intact)
curl -s http://127.0.0.1:3457/api/coord/active | head -1
```

Then open the dashboard at `http://127.0.0.1:3456/coordination` (or whatever path the Coordination view mounts at — check `App.jsx` routes if unsure) and visually confirm:
- Workstation row(s) appear when locks are active OR
- "Workstation idle" appears when no locks are held OR
- "not reachable" appears with the error code when the daemon is down

Use `peek_ui` to capture if needed:

```javascript
peek_ui({ title: 'TORQUE Dashboard' })
```

Or open in a browser. Per the project's UI verification policy, do not skip this step — if you can't visually verify, say so explicitly.

---

## Spec coverage check

| Spec section | Implementing task |
|---|---|
| §5.5 React `RemoteCoordPanel.jsx` — one row per active run with project/sha/suite/host:pid/started/elapsed | Tasks 2 + 3 |
| §5.5 "(not reachable)" rendering | Task 2 (Step 3 covers all three states) |
| §5.5 5s polling | Task 2 (`POLL_INTERVAL_MS = 5000`) |
| §5.5 "last log line" column | **Deferred** — endpoint doesn't expose it; revisit if/when the daemon adds per-lock log tails |

**Phase 3b explicitly excludes:**
- Cross-machine wrapper coord (Phase 3c).
- Auth on the panel — daemon binds to localhost; whatever protects TORQUE's UI generally protects this too.
- Persistent SSH tunnel for sub-second refresh — 5s cache + 5s polling = ~10s worst-case freshness, which is fine for a status mirror. Revisit only if the dashboard needs sub-second updates.
