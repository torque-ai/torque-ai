# Workstations Phase 3+4+Dashboard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the workstation unification by migrating all consumers from old tables (`ollama_hosts`, `peek_hosts`, `remote_agents`) to the `workstations` table, then drop old tables and add dashboard UI.

**Architecture:** Phase 3 uses the existing adapter layer (`server/workstation/adapters.js`) as the bridge — redirect read operations in `host-management.js` and `host-selection.js` through the adapters, which already query the `workstations` table. Write operations dual-write to both tables during Phase 3 for safety. Phase 4 removes the dual-write and drops old tables. Dashboard adds workstation management views.

**Tech Stack:** Node.js, SQLite, React, Vitest

**Spec:** `docs/superpowers/specs/2026-03-16-unified-workstations-design.md`

---

## File Structure

### Modified files (Phase 3)
| File | Changes |
|------|---------|
| `server/db/host-selection.js` | Redirect `listOllamaHosts()` and `getOllamaHost()` to read from workstation adapters |
| `server/db/host-management.js` | Redirect read functions to adapters; dual-write on mutations |
| `server/handlers/peek/shared.js` | Use `workstation/adapters.resolvePeekHost()` instead of `db.getPeekHost()` |
| `server/remote/remote-test-routing.js` | Look up workstation with `command_exec` capability instead of `remote_agent_id` |
| `server/handlers/task/core.js` | Look up workstation when displaying `ollama_host_id` info |
| `server/db/host-benchmarking.js` | Redirect model fetching to use workstation data |

### Modified files (Phase 4)
| File | Changes |
|------|---------|
| `server/db/schema-migrations.js` | Mark old tables as deprecated (don't drop yet — let a future release do that) |
| `server/workstation/adapters.js` | Remove — no longer needed, consumers call model.js directly |
| `server/db/host-management.js` | Remove dual-write, use workstation model only |

### New files (Dashboard)
| File | Responsibility |
|------|---------------|
| `dashboard/src/views/Workstations.jsx` | Workstation list with capability icons, health status, capacity |
| `dashboard/src/components/WorkstationWizard.jsx` | Add workstation wizard (SSH bootstrap or manual agent) |

---

## Chunk 1: Phase 3 — Consumer Migration (Core)

### Task 1: Redirect host-selection.js Reads to Workstation Adapters

**Files:**
- Modify: `server/db/host-selection.js`
- Test: run existing `server/tests/db-host-selection.test.js`

`host-selection.js` has its OWN copies of `listOllamaHosts()` and `getOllamaHost()` that query `ollama_hosts` directly. Redirect these to use the workstation adapter.

- [ ] **Step 1: Modify listOllamaHosts in host-selection.js**

At the top of `server/db/host-selection.js`, add:

```javascript
let wsAdapters = null;
function getWsAdapters() {
  if (!wsAdapters) {
    try { wsAdapters = require('../workstation/adapters'); } catch { return null; }
  }
  return wsAdapters;
}
```

Then modify the existing `listOllamaHosts(options)` function (around line 36). At the top of the function, add a workstation-first path:

```javascript
function listOllamaHosts(options = {}) {
  // Phase 3: Read from workstations table via adapter
  const adapters = getWsAdapters();
  if (adapters) {
    try {
      const wsHosts = adapters.listOllamaHosts(options);
      if (wsHosts.length > 0) return wsHosts;
    } catch { /* fall through to legacy query */ }
  }

  // Legacy: direct ollama_hosts query (fallback)
  let query = 'SELECT * FROM ollama_hosts WHERE 1=1';
  // ... rest of existing function unchanged
```

- [ ] **Step 2: Modify getOllamaHost in host-selection.js**

Modify `getOllamaHost(hostId)` (around line 417) similarly:

```javascript
function getOllamaHost(hostId) {
  // Phase 3: Try workstation adapter first
  const adapters = getWsAdapters();
  if (adapters) {
    try {
      const wsHosts = adapters.listOllamaHosts();
      const match = wsHosts.find(h => h.id === hostId);
      if (match) return match;
    } catch { /* fall through */ }
  }

  // Legacy fallback
  const stmt = db.prepare('SELECT * FROM ollama_hosts WHERE id = ?');
  // ... rest unchanged
```

- [ ] **Step 3: Run existing tests on the Omen**

```bash
ssh user@remote-gpu-host "cd /path/to\torque-public && git pull && npx vitest run server/tests/db-host-selection.test.js server/tests/host-management.test.js --reporter verbose"
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/db/host-selection.js
git commit -m "feat(workstations): phase 3 — redirect host-selection reads to workstation adapters"
```

---

### Task 2: Redirect host-management.js Reads + Dual-Write

**Files:**
- Modify: `server/db/host-management.js`
- Test: run existing `server/tests/host-management.test.js`

The main `host-management.js` has read functions that query `ollama_hosts` directly. Redirect reads to adapters. For write operations (`addOllamaHost`, `updateOllamaHost`, `removeOllamaHost`), add dual-write: write to BOTH `ollama_hosts` AND workstations.

- [ ] **Step 1: Redirect listOllamaHosts reads**

In `server/db/host-management.js`, modify `listOllamaHosts()` (around line 133) to try the adapter first:

```javascript
function listOllamaHosts(options = {}) {
  // Phase 3: Read from workstations via adapter
  try {
    const wsAdapters = require('../workstation/adapters');
    const wsHosts = wsAdapters.listOllamaHosts(options);
    if (wsHosts.length > 0) return wsHosts;
  } catch { /* fall through to legacy */ }

  // Legacy direct query
  let query = 'SELECT * FROM ollama_hosts WHERE 1=1';
  // ... rest unchanged
```

- [ ] **Step 2: Add dual-write to addOllamaHost**

In `addOllamaHost()` (around line 72), after the existing INSERT into `ollama_hosts`, add:

```javascript
  // Phase 3: Dual-write to workstations
  try {
    const wsAdapters = require('../workstation/adapters');
    wsAdapters.addOllamaHost(host);
  } catch { /* workstation write is best-effort during migration */ }
```

- [ ] **Step 3: Add dual-write to updateOllamaHost**

In `updateOllamaHost()` (around line 180), after the existing UPDATE, add workstation update:

```javascript
  // Phase 3: Sync update to workstation
  try {
    const wsModel = require('../workstation/model');
    const wsAdapters = require('../workstation/adapters');
    const wsHosts = wsAdapters.listOllamaHosts();
    const match = wsHosts.find(h => h.id === hostId);
    if (match) {
      // match.id is already the workstation id from the adapter
      wsModel.updateWorkstation(hostId, updates);
    }
  } catch { /* best-effort */ }
```

- [ ] **Step 4: Run existing tests on the Omen**

```bash
ssh user@remote-gpu-host "cd /path/to\torque-public && git pull && npx vitest run server/tests/host-management.test.js --reporter verbose"
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/db/host-management.js
git commit -m "feat(workstations): phase 3 — redirect host-management reads + dual-write"
```

---

### Task 3: Migrate peek/shared.js to Workstation Adapter

**Files:**
- Modify: `server/handlers/peek/shared.js`

- [ ] **Step 1: Replace db.getPeekHost with workstation adapter**

In `server/handlers/peek/shared.js`, find `resolvePeekHost()` (around line 99). Replace the `db.getPeekHost(args.host)` call:

```javascript
function resolvePeekHost(args) {
  // Phase 3: Use workstation adapter for peek host resolution
  try {
    const wsAdapters = require('../../workstation/adapters');
    const wsHost = wsAdapters.resolvePeekHost(args);
    if (wsHost) {
      // Return in the shape that peek handlers expect
      return {
        name: wsHost.name,
        url: `http://${wsHost.host}:9876`,
        host: wsHost.host,
        ssh: null,
        is_default: wsHost.is_default,
        enabled: wsHost.enabled,
      };
    }
  } catch { /* fall through to legacy */ }

  // Legacy: direct peek_hosts lookup
  const host = db.getPeekHost(args.host);
  // ... rest unchanged
```

- [ ] **Step 2: Run peek tests**

```bash
ssh user@remote-gpu-host "cd /path/to\torque-public && git pull && npx vitest run server/tests/contracts-peek.test.js --reporter verbose"
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/handlers/peek/shared.js
git commit -m "feat(workstations): phase 3 — migrate peek host resolution to workstation adapter"
```

---

### Task 4: Migrate remote-test-routing.js to Workstation Lookup

**Files:**
- Modify: `server/remote/remote-test-routing.js`

- [ ] **Step 1: Add workstation-based agent lookup**

In `server/remote/remote-test-routing.js`, find where `config.remote_agent_id` is used (around line 117). Add a workstation fallback:

```javascript
      // Phase 3: Try workstation lookup if remote_agent_id matches a workstation
      let agentHost = null;
      let agentPort = 3460;
      let agentSecret = null;

      try {
        const wsModel = require('../../workstation/model');
        const ws = wsModel.getWorkstationByName(config.remote_agent_id) ||
                   wsModel.getWorkstation(config.remote_agent_id);
        if (ws && ws._capabilities && ws._capabilities.command_exec) {
          agentHost = ws.host;
          agentPort = ws.agent_port || 3460;
          agentSecret = ws.secret;
        }
      } catch { /* fall through to legacy agent lookup */ }
```

- [ ] **Step 2: Commit**

```bash
git add server/remote/remote-test-routing.js
git commit -m "feat(workstations): phase 3 — migrate remote test routing to workstation lookup"
```

---

### Task 5: Update task/core.js Host Display

**Files:**
- Modify: `server/handlers/task/core.js`

- [ ] **Step 1: Add workstation fallback for ollama_host_id display**

In `server/handlers/task/core.js`, find the `ollama_host_id` display blocks (around lines 69-74 and 615-616). Add a workstation fallback:

```javascript
  if (task.ollama_host_id) {
    // Phase 3: Try workstation first
    let hostName = task.ollama_host_id;
    try {
      const wsModel = require('../../workstation/model');
      const ws = wsModel.getWorkstation(task.ollama_host_id);
      if (ws) hostName = ws.name;
    } catch { /* ignore */ }

    const host = db.getOllamaHost(task.ollama_host_id);
    if (host) hostName = host.name;
    result += `**Ollama Host:** ${hostName}\n`;
  }
```

- [ ] **Step 2: Commit**

```bash
git add server/handlers/task/core.js
git commit -m "feat(workstations): phase 3 — workstation fallback for task host display"
```

---

### Task 6: Full Test Verification on Omen

- [ ] **Step 1: Run full suite on the Omen**

```bash
ssh user@remote-gpu-host "cd /path/to\torque-public && git pull && npx vitest run"
```
Expected: 0 failures, 15,893+ passing

- [ ] **Step 2: Commit any test fixes needed**

---

## Chunk 2: Phase 4 — Remove Dual-Write, Deprecate Old Tables

### Task 7: Remove Legacy Fallbacks

**Files:**
- Modify: `server/db/host-selection.js` — remove legacy `ollama_hosts` fallback paths
- Modify: `server/db/host-management.js` — remove dual-write, reads go through adapter only
- Modify: `server/handlers/peek/shared.js` — remove legacy `peek_hosts` fallback

- [ ] **Step 1: Clean up host-selection.js**

Remove the legacy fallback blocks added in Task 1. The workstation adapter path becomes the ONLY path. If the adapter returns empty, return empty (no fallback to `ollama_hosts`).

- [ ] **Step 2: Clean up host-management.js**

Remove the dual-write blocks added in Task 2. `addOllamaHost` writes only to workstations via adapter. `updateOllamaHost` updates only the workstation record.

- [ ] **Step 3: Clean up peek/shared.js**

Remove the legacy `db.getPeekHost` fallback. Workstation adapter is the only path.

- [ ] **Step 4: Mark old tables deprecated in schema-migrations.js**

Add a comment block in `server/db/schema-migrations.js`:

```javascript
  // DEPRECATED: ollama_hosts, peek_hosts, remote_agents tables are replaced by workstations.
  // These tables are retained for data migration only. Do NOT add new queries against them.
  // They will be dropped in a future release.
```

- [ ] **Step 5: Run full suite on the Omen**

```bash
ssh user@remote-gpu-host "cd /path/to\torque-public && git pull && npx vitest run"
```
Expected: 0 failures

- [ ] **Step 6: Commit**

```bash
git add server/db/host-selection.js server/db/host-management.js server/handlers/peek/shared.js server/db/schema-migrations.js
git commit -m "feat(workstations): phase 4 — remove legacy table fallbacks, deprecate old tables"
```

---

## Chunk 3: Dashboard — Workstation Views

### Task 8: Workstation List View

**Files:**
- Create: `dashboard/src/views/Workstations.jsx`
- Modify: `dashboard/src/components/Layout.jsx` — add nav item
- Modify: `dashboard/src/api.js` — add workstation API client

- [ ] **Step 1: Add workstation API client**

In `dashboard/src/api.js`, add after the concurrency export:

```javascript
export const workstations = {
  list: () => requestV2('/workstations').then(d => d.items || d),
  add: (data) => requestV2('/workstations', { method: 'POST', body: JSON.stringify(data) }),
  remove: (name) => requestV2(`/workstations/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  probe: (name) => requestV2(`/workstations/${encodeURIComponent(name)}/probe`, { method: 'POST' }),
};
```

Note: These will route through the MCP tool passthrough (`add_workstation`, `remove_workstation`, `probe_workstation`). Add v2 routes if passthrough doesn't cover them.

- [ ] **Step 2: Create Workstations.jsx**

Create `dashboard/src/views/Workstations.jsx` showing:
- Grid of workstation cards
- Each card: name, host, status dot (green/amber/red), capability icons, GPU info
- CapacityBar for running_tasks/max_concurrent
- VramBar for GPU VRAM when available
- Probe button (re-detect capabilities)
- Remove button
- "Add Workstation" button in header

Use existing components: `CapacityBar`, `VramBar` (from Hosts.jsx — extract to shared if needed).

Fetch data: call `list_workstations` MCP tool via API or use `concurrency.get()` which already returns workstation data.

- [ ] **Step 3: Add nav item in Layout.jsx**

In `dashboard/src/components/Layout.jsx`, add to the nav items array:

```javascript
{ to: '/workstations', icon: WorkstationIcon, label: 'Workstations' },
```

Add route in the routes array.

- [ ] **Step 4: Rebuild dashboard and test**

```bash
cd dashboard && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/views/Workstations.jsx dashboard/src/components/Layout.jsx dashboard/src/api.js
git commit -m "feat(workstations): dashboard workstation list view with capability display"
```

---

### Task 9: Add Workstation Wizard

**Files:**
- Create: `dashboard/src/components/WorkstationWizard.jsx`
- Modify: `dashboard/src/views/Workstations.jsx` — integrate wizard

- [ ] **Step 1: Create WorkstationWizard.jsx**

Multi-step wizard:
1. **Choose method:** "Agent already running" or "SSH bootstrap" (future)
2. **Enter details:** host, port (default 3460), secret, name
3. **Probe:** call `probe_workstation` to detect capabilities
4. **Review:** show detected capabilities, GPU, models
5. **Confirm:** set priority, set as default (yes/no)

Use `glass-card` styling, step indicator, form inputs consistent with existing dashboard.

On submit: call `add_workstation` MCP tool via API, then `probe_workstation`.

- [ ] **Step 2: Integrate into Workstations.jsx**

Add "Add Workstation" button that opens the wizard as a modal/panel.

- [ ] **Step 3: Rebuild and test**

```bash
cd dashboard && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/WorkstationWizard.jsx dashboard/src/views/Workstations.jsx
git commit -m "feat(workstations): add workstation wizard with capability detection"
```

---

### Task 10: Dashboard v2 Routes for Workstations

**Files:**
- Modify: `server/api/routes.js` — add v2 workstation routes
- Modify: `server/api/v2-dispatch.js` — add handler wrappers

- [ ] **Step 1: Add v2 routes**

In `server/api/routes.js`, add with the concurrency/economy routes:

```javascript
  // Workstations
  { method: 'GET', path: '/api/v2/workstations', handlerName: 'handleV2CpListWorkstations', middleware: buildV2Middleware() },
  { method: 'POST', path: '/api/v2/workstations', handlerName: 'handleV2CpAddWorkstation', middleware: buildV2Middleware() },
  { method: 'DELETE', path: /^\/api\/v2\/workstations\/(.+)$/, handlerName: 'handleV2CpRemoveWorkstation', middleware: buildV2Middleware(), mapParams: ['name'] },
  { method: 'POST', path: /^\/api\/v2\/workstations\/(.+)\/probe$/, handlerName: 'handleV2CpProbeWorkstation', middleware: buildV2Middleware(), mapParams: ['name'] },
```

- [ ] **Step 2: Add v2-dispatch handlers**

In `server/api/v2-dispatch.js`, add handler wrappers that call the workstation handlers:

```javascript
  handleV2CpListWorkstations: (req, res, ctx) => {
    const wsHandlers = require('../handlers/workstation-handlers');
    const result = wsHandlers.handleListWorkstations(req.query || {});
    const text = result?.content?.[0]?.text || '{}';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: JSON.parse(text), meta: { request_id: ctx.requestId } }));
  },
  // ... similar for add, remove, probe
```

- [ ] **Step 3: Run meta-tests to verify no regressions**

```bash
ssh user@remote-gpu-host "cd /path/to\torque-public && git pull && npx vitest run server/tests/rest-control-plane-parity.test.js server/tests/v2-middleware.test.js server/tests/core-tools.test.js"
```

- [ ] **Step 4: Commit**

```bash
git add server/api/routes.js server/api/v2-dispatch.js
git commit -m "feat(workstations): v2 REST endpoints for dashboard workstation management"
```

---

## Summary

| Chunk | Tasks | Description |
|-------|-------|-------------|
| **1 (Phase 3)** | 1-6 | Consumer migration — redirect reads to adapters, dual-write on mutations |
| **2 (Phase 4)** | 7 | Remove legacy fallbacks, deprecate old tables |
| **3 (Dashboard)** | 8-10 | Workstation list view, add wizard, v2 REST routes |

**Total:** 10 tasks

**Migration strategy:** Phase 3 is non-destructive — legacy queries are fallbacks, not removed. Phase 4 removes fallbacks after Phase 3 is proven stable. Old tables are deprecated but NOT dropped (a future release can drop them after confirming no direct queries remain).
