# Concurrency Limits UI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose all 4 concurrency limit scopes (per-provider, per-workstation, per-host, VRAM factor) through MCP tools and dashboard UI, persisted between sessions.

**Architecture:** Two new MCP tools (`get_concurrency_limits`, `set_concurrency_limit`) provide a unified API. REST endpoints are auto-generated via the existing `routes-passthrough.js` tool-mapping pattern. The hardcoded `VRAM_OVERHEAD_FACTOR` moves to the `config` table. Dashboard extends existing Providers and Hosts pages with editable concurrency controls.

**Tech Stack:** Node.js, SQLite, React, Vitest

**Spec:** `docs/superpowers/specs/2026-03-16-concurrency-limits-ui.md`

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `server/tool-defs/concurrency-defs.js` | Tool definitions for `get_concurrency_limits` and `set_concurrency_limit` |
| `server/handlers/concurrency-handlers.js` | MCP tool handlers — reads all 4 scopes, validates and applies changes |
| `server/tests/concurrency-limits.test.js` | Unit + integration tests |

### Modified files
| File | Changes |
|------|---------|
| `server/db/host-management.js:464` | Replace hardcoded `VRAM_OVERHEAD_FACTOR` with `getVramOverheadFactor()` reading from config |
| `server/db/schema-seeds.js` | Seed `vram_overhead_factor` default |
| `server/tools.js:39,64` | Register concurrency tool-defs and handlers |
| `server/api/routes-passthrough.js` | Add passthrough routes for `get_concurrency_limits` and `set_concurrency_limit` |
| `dashboard/src/api.js` | Add `concurrency` API client |
| `dashboard/src/views/Providers.jsx` | Add editable `max_concurrent` to ProviderCard |
| `dashboard/src/views/Hosts.jsx` | Add workstation section, editable limits, VRAM slider |

---

## Chunk 1: VRAM Factor Migration + MCP Tools

### Task 1: Move VRAM_OVERHEAD_FACTOR to Config Table

**Files:**
- Modify: `server/db/host-management.js:464`
- Modify: `server/db/schema-seeds.js`
- Test: `server/tests/concurrency-limits.test.js`

- [ ] **Step 1: Write failing test for getVramOverheadFactor**

```javascript
// server/tests/concurrency-limits.test.js
'use strict';

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');

describe('concurrency limits', () => {
  let db;
  beforeAll(() => { const env = setupTestDb('concurrency-limits'); db = env.db; });
  afterAll(() => teardownTestDb());

  describe('VRAM overhead factor', () => {
    it('getVramOverheadFactor returns default 0.95 when no config set', () => {
      const hm = require('../db/host-management');
      expect(typeof hm.getVramOverheadFactor).toBe('function');
      const factor = hm.getVramOverheadFactor();
      expect(factor).toBe(0.95);
    });

    it('getVramOverheadFactor reads from config table', () => {
      rawDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('vram_overhead_factor', '0.80')").run();
      const hm = require('../db/host-management');
      const factor = hm.getVramOverheadFactor();
      expect(factor).toBe(0.80);
      // Cleanup
      rawDb().prepare("DELETE FROM config WHERE key = 'vram_overhead_factor'").run();
    });

    it('getVramOverheadFactor rejects values outside 0.5-1.0 range', () => {
      rawDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('vram_overhead_factor', '0.30')").run();
      const hm = require('../db/host-management');
      const factor = hm.getVramOverheadFactor();
      expect(factor).toBe(0.95); // falls back to default
      rawDb().prepare("DELETE FROM config WHERE key = 'vram_overhead_factor'").run();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/concurrency-limits.test.js --reporter verbose`
Expected: FAIL — `getVramOverheadFactor` not exported

- [ ] **Step 3: Implement getVramOverheadFactor and replace constant**

In `server/db/host-management.js`, replace line 464:
```javascript
const VRAM_OVERHEAD_FACTOR = 0.95; // Reserve 5% VRAM for OS/driver overhead (Ollama manages its own memory)
```

With:
```javascript
/**
 * Get VRAM overhead factor from config table. Persists between sessions.
 * Range: 0.50-1.00. Default: 0.95.
 * @returns {number}
 */
function getVramOverheadFactor() {
  const configured = getConfig('vram_overhead_factor');
  if (configured) {
    const val = parseFloat(configured);
    if (val >= 0.5 && val <= 1.0) return val;
  }
  return 0.95;
}
```

Then replace every usage of `VRAM_OVERHEAD_FACTOR` in the same file with `getVramOverheadFactor()`:
- Line ~552: `const vramBudgetMb = vramTotalMb * VRAM_OVERHEAD_FACTOR;` → `const vramBudgetMb = vramTotalMb * getVramOverheadFactor();`
- Line ~590: the template string referencing `${VRAM_OVERHEAD_FACTOR}` → `${getVramOverheadFactor()}`

Add `getVramOverheadFactor` to `module.exports` at the bottom of the file.

- [ ] **Step 4: Seed the default in schema-seeds.js**

In `server/db/schema-seeds.js`, add after the workstation defaults:
```javascript
  setConfigDefault('vram_overhead_factor', '0.95');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/concurrency-limits.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 6: Run existing tests to verify no regressions**

Run: `npx vitest run server/tests/host-management.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/db/host-management.js server/db/schema-seeds.js server/tests/concurrency-limits.test.js
git commit -m "feat: move VRAM overhead factor from hardcoded constant to config table"
```

---

### Task 2: Tool Definitions

**Files:**
- Create: `server/tool-defs/concurrency-defs.js`

- [ ] **Step 1: Write tool definitions**

```javascript
// server/tool-defs/concurrency-defs.js
const tools = [
  {
    name: 'get_concurrency_limits',
    description: 'Get a unified view of all concurrency limits across providers, workstations, hosts, and VRAM budget. Returns current settings and effective values.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_concurrency_limit',
    description: 'Set a concurrency limit by scope. Scope determines what is updated: "provider" updates provider_config.max_concurrent, "workstation" updates workstations.max_concurrent, "host" updates ollama_hosts.max_concurrent, "vram_factor" updates the global VRAM budget factor (0.50-1.00).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['provider', 'workstation', 'host', 'vram_factor'],
          description: 'What type of limit to set',
        },
        target: {
          type: 'string',
          description: 'Identifier: provider name, workstation name, or host ID. Not needed for vram_factor scope.',
        },
        max_concurrent: {
          type: 'integer',
          description: 'Maximum concurrent tasks (1-100, or 0 for unlimited on hosts). Used with provider/workstation/host scopes.',
        },
        vram_factor: {
          type: 'number',
          description: 'VRAM budget factor (0.50-1.00). 0.95 = use 95% of GPU VRAM. Used with vram_factor scope.',
        },
      },
      required: ['scope'],
    },
  },
];

module.exports = tools;
```

- [ ] **Step 2: Commit**

```bash
git add server/tool-defs/concurrency-defs.js
git commit -m "feat: tool definitions for get/set concurrency limits"
```

---

### Task 3: Tool Handlers

**Files:**
- Create: `server/handlers/concurrency-handlers.js`
- Test: `server/tests/concurrency-limits.test.js` (append)

- [ ] **Step 1: Write failing tests for handlers**

Append to `server/tests/concurrency-limits.test.js`:

```javascript
  describe('get_concurrency_limits', () => {
    let handleToolCall;
    beforeAll(() => {
      handleToolCall = require('../tools').handleToolCall;
    });

    it('returns all 4 scopes', async () => {
      const result = await handleToolCall('get_concurrency_limits', {});
      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveProperty('vram_overhead_factor');
      expect(data).toHaveProperty('providers');
      expect(data).toHaveProperty('workstations');
      expect(data).toHaveProperty('ollama_hosts');
      expect(Array.isArray(data.providers)).toBe(true);
    });
  });

  describe('set_concurrency_limit', () => {
    let handleToolCall;
    beforeAll(() => {
      handleToolCall = require('../tools').handleToolCall;
    });

    it('sets vram_factor', async () => {
      const result = await handleToolCall('set_concurrency_limit', {
        scope: 'vram_factor',
        vram_factor: 0.85,
      });
      expect(result.content[0].text).toContain('0.85');

      // Verify it persisted
      const row = rawDb().prepare("SELECT value FROM config WHERE key = 'vram_overhead_factor'").get();
      expect(row.value).toBe('0.85');

      // Cleanup
      rawDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('vram_overhead_factor', '0.95')").run();
    });

    it('rejects vram_factor outside range', async () => {
      const result = await handleToolCall('set_concurrency_limit', {
        scope: 'vram_factor',
        vram_factor: 0.30,
      });
      expect(result.content[0].text).toContain('Error');
    });

    it('rejects invalid scope', async () => {
      const result = await handleToolCall('set_concurrency_limit', {
        scope: 'invalid',
      });
      expect(result.content[0].text).toContain('Error');
    });

    it('sets provider max_concurrent', async () => {
      const result = await handleToolCall('set_concurrency_limit', {
        scope: 'provider',
        target: 'codex',
        max_concurrent: 5,
      });
      expect(result.content[0].text).toContain('5');
    });

    it('sets host max_concurrent', async () => {
      // Create an ollama host first
      rawDb().prepare(`
        INSERT OR IGNORE INTO ollama_hosts (id, name, url, enabled, status, max_concurrent, created_at)
        VALUES ('test-host', 'test-host', 'http://localhost:11434', 1, 'healthy', 3, datetime('now'))
      `).run();

      const result = await handleToolCall('set_concurrency_limit', {
        scope: 'host',
        target: 'test-host',
        max_concurrent: 2,
      });
      expect(result.content[0].text).toContain('2');

      rawDb().prepare("DELETE FROM ollama_hosts WHERE id = 'test-host'").run();
    });

    it('sets workstation max_concurrent', async () => {
      const wsModel = require('../workstation/model');
      wsModel.setDb(rawDb());
      rawDb().prepare("DELETE FROM workstations").run();

      wsModel.createWorkstation({ name: 'test-ws', host: '10.0.0.1', secret: 's' });

      const result = await handleToolCall('set_concurrency_limit', {
        scope: 'workstation',
        target: 'test-ws',
        max_concurrent: 4,
      });
      expect(result.content[0].text).toContain('4');

      const ws = wsModel.getWorkstationByName('test-ws');
      expect(ws.max_concurrent).toBe(4);

      rawDb().prepare("DELETE FROM workstations").run();
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/concurrency-limits.test.js --reporter verbose`
Expected: FAIL — handlers not found

- [ ] **Step 3: Implement handlers**

```javascript
// server/handlers/concurrency-handlers.js
'use strict';

const logger = require('../logger').child({ component: 'concurrency-handlers' });

function getConcurrencyLimits() {
  // Lazy requires to avoid circular deps
  const db = require('../database');
  const hostMgmt = require('../db/host-management');

  // VRAM factor
  const vramFactor = hostMgmt.getVramOverheadFactor();

  // Providers
  const providerRows = db.getDb().prepare(
    'SELECT provider, max_concurrent, enabled FROM provider_config ORDER BY provider'
  ).all();
  const providers = providerRows.map(p => ({
    provider: p.provider,
    max_concurrent: p.max_concurrent,
    enabled: !!p.enabled,
  }));

  // Workstations
  let workstations = [];
  try {
    const wsModel = require('../workstation/model');
    workstations = wsModel.listWorkstations({}).map(ws => ({
      name: ws.name,
      host: ws.host,
      max_concurrent: ws.max_concurrent,
      gpu_vram_mb: ws.gpu_vram_mb || null,
      effective_vram_budget_mb: ws.gpu_vram_mb ? Math.round(ws.gpu_vram_mb * vramFactor) : null,
      running_tasks: ws.running_tasks,
    }));
  } catch { /* workstation module not available */ }

  // Ollama hosts
  const ollamaHosts = hostMgmt.listOllamaHosts().map(h => ({
    id: h.id,
    name: h.name,
    max_concurrent: h.max_concurrent,
    running_tasks: h.running_tasks,
    memory_limit_mb: h.memory_limit_mb,
  }));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        vram_overhead_factor: vramFactor,
        providers,
        workstations,
        ollama_hosts: ollamaHosts,
      }, null, 2),
    }],
  };
}

function setConcurrencyLimit(args) {
  const { scope, target, max_concurrent, vram_factor } = args;

  if (!scope) {
    return { content: [{ type: 'text', text: 'Error: scope is required' }] };
  }

  const VALID_SCOPES = ['provider', 'workstation', 'host', 'vram_factor'];
  if (!VALID_SCOPES.includes(scope)) {
    return { content: [{ type: 'text', text: `Error: invalid scope '${scope}'. Must be one of: ${VALID_SCOPES.join(', ')}` }] };
  }

  if (scope === 'vram_factor') {
    if (vram_factor === undefined || vram_factor === null) {
      return { content: [{ type: 'text', text: 'Error: vram_factor is required for scope "vram_factor"' }] };
    }
    const val = parseFloat(vram_factor);
    if (isNaN(val) || val < 0.5 || val > 1.0) {
      return { content: [{ type: 'text', text: 'Error: vram_factor must be between 0.50 and 1.00' }] };
    }
    const db = require('../database');
    db.getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('vram_overhead_factor', ?)").run(String(val));
    return { content: [{ type: 'text', text: `VRAM overhead factor set to ${val} (${Math.round(val * 100)}% of GPU VRAM usable)` }] };
  }

  // All other scopes require target + max_concurrent
  if (!target) {
    return { content: [{ type: 'text', text: `Error: target is required for scope "${scope}"` }] };
  }
  if (max_concurrent === undefined || max_concurrent === null) {
    return { content: [{ type: 'text', text: `Error: max_concurrent is required for scope "${scope}"` }] };
  }
  const mc = parseInt(max_concurrent);
  if (isNaN(mc) || mc < 0 || mc > 100) {
    return { content: [{ type: 'text', text: 'Error: max_concurrent must be an integer between 0 and 100' }] };
  }

  if (scope === 'provider') {
    const db = require('../database');
    const row = db.getDb().prepare('SELECT provider FROM provider_config WHERE provider = ?').get(target);
    if (!row) {
      return { content: [{ type: 'text', text: `Error: provider '${target}' not found` }] };
    }
    db.getDb().prepare('UPDATE provider_config SET max_concurrent = ? WHERE provider = ?').run(mc, target);
    return { content: [{ type: 'text', text: `Provider '${target}' max_concurrent set to ${mc}` }] };
  }

  if (scope === 'workstation') {
    try {
      const wsModel = require('../workstation/model');
      const ws = wsModel.getWorkstationByName(target);
      if (!ws) {
        return { content: [{ type: 'text', text: `Error: workstation '${target}' not found` }] };
      }
      wsModel.updateWorkstation(ws.id, { max_concurrent: mc });
      return { content: [{ type: 'text', text: `Workstation '${target}' max_concurrent set to ${mc}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }

  if (scope === 'host') {
    const hostMgmt = require('../db/host-management');
    const host = hostMgmt.getOllamaHost(target);
    if (!host) {
      return { content: [{ type: 'text', text: `Error: host '${target}' not found` }] };
    }
    hostMgmt.updateOllamaHost(target, { max_concurrent: mc });
    return { content: [{ type: 'text', text: `Host '${host.name}' max_concurrent set to ${mc}` }] };
  }

  return { content: [{ type: 'text', text: `Error: unhandled scope '${scope}'` }] };
}

module.exports = {
  getConcurrencyLimits,
  setConcurrencyLimit,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/concurrency-limits.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/handlers/concurrency-handlers.js server/tests/concurrency-limits.test.js
git commit -m "feat: MCP handlers for get/set concurrency limits"
```

---

### Task 4: Register Tools + REST Passthrough

**Files:**
- Modify: `server/tools.js:39,64`
- Modify: `server/api/routes-passthrough.js`

- [ ] **Step 1: Register tool defs in tools.js**

In `server/tools.js`, add after the `workstation-defs` line (line 39):
```javascript
  ...require('./tool-defs/concurrency-defs'),
```

- [ ] **Step 2: Register handlers in tools.js**

In `server/tools.js`, add after the `workstation-handlers` line (line 64):
```javascript
  require('./handlers/concurrency-handlers'),
```

- [ ] **Step 3: Add REST passthrough routes**

In `server/api/routes-passthrough.js`, add to the routes array:
```javascript
  { method: 'GET', path: '/api/v2/concurrency', tool: 'get_concurrency_limits', mapQuery: true },
  { method: 'POST', path: '/api/v2/concurrency/set', tool: 'set_concurrency_limit', mapBody: true },
```

- [ ] **Step 4: Run core-tools test to verify no regressions**

Run: `npx vitest run server/tests/core-tools.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 5: Run concurrency tests end-to-end**

Run: `npx vitest run server/tests/concurrency-limits.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/tools.js server/api/routes-passthrough.js
git commit -m "feat: register concurrency tools and REST passthrough routes"
```

---

## Chunk 2: Dashboard UI

### Task 5: Dashboard API Client

**Files:**
- Modify: `dashboard/src/api.js`

- [ ] **Step 1: Add concurrency API client**

In `dashboard/src/api.js`, add after the `hosts` export (around line 198):

```javascript
// ─── Concurrency endpoints (v2) ─────────────────────────────────────────────

export const concurrency = {
  get: () => requestV2('/concurrency'),
  set: (data) => requestV2('/concurrency/set', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
};
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/api.js
git commit -m "feat: dashboard API client for concurrency limits"
```

---

### Task 6: Providers Page — Editable max_concurrent

**Files:**
- Modify: `dashboard/src/views/Providers.jsx`

- [ ] **Step 1: Add editable concurrency to ProviderCard**

In `dashboard/src/views/Providers.jsx`, modify `ProviderCard` to accept an `onUpdateConcurrency` prop and add an inline number input:

After the enable/disable toggle in `ProviderCard`, add:
```jsx
<div className="flex items-center gap-2 mt-3">
  <span className="text-xs text-slate-400">Max Concurrent:</span>
  <input
    type="number"
    min={1}
    max={100}
    value={provider.max_concurrent || 1}
    onChange={(e) => {
      const val = parseInt(e.target.value);
      if (val >= 1 && val <= 100) onUpdateConcurrency(provider.provider, val);
    }}
    className="w-16 px-2 py-1 text-sm bg-slate-800 border border-slate-600 rounded text-white"
  />
</div>
```

Add the `onUpdateConcurrency` handler in the parent component that calls:
```javascript
import { concurrency } from '../api';

const handleUpdateConcurrency = async (providerName, value) => {
  try {
    await concurrency.set({ scope: 'provider', target: providerName, max_concurrent: value });
    addToast(`${providerName} max_concurrent set to ${value}`, 'success');
    // Refresh provider list
    fetchProviders();
  } catch (err) {
    addToast(`Failed to update: ${err.message}`, 'error');
  }
};
```

Pass `onUpdateConcurrency={handleUpdateConcurrency}` to each `ProviderCard`.

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/views/Providers.jsx
git commit -m "feat: editable max_concurrent on provider cards"
```

---

### Task 7: Hosts Page — Workstation Section + VRAM Slider

**Files:**
- Modify: `dashboard/src/views/Hosts.jsx`

- [ ] **Step 1: Add VRAM Budget slider at top of Hosts page**

In `dashboard/src/views/Hosts.jsx`, add a VRAM settings section above the host list. Fetch concurrency data on mount:

```jsx
import { concurrency } from '../api';

// In the component:
const [concurrencyData, setConcurrencyData] = useState(null);

useEffect(() => {
  concurrency.get().then(setConcurrencyData).catch(() => {});
}, []);

// Render above the host cards:
{concurrencyData && (
  <div className="glass-card p-5 mb-6">
    <h3 className="text-lg font-semibold text-white mb-3">VRAM Budget</h3>
    <div className="flex items-center gap-4">
      <span className="text-sm text-slate-400">Factor:</span>
      <input
        type="range"
        min={50}
        max={100}
        value={Math.round((concurrencyData.vram_overhead_factor || 0.95) * 100)}
        onChange={(e) => {
          const val = parseInt(e.target.value) / 100;
          concurrency.set({ scope: 'vram_factor', vram_factor: val }).then(() => {
            setConcurrencyData(prev => ({ ...prev, vram_overhead_factor: val }));
            addToast(`VRAM budget set to ${e.target.value}%`, 'success');
          });
        }}
        className="flex-1"
      />
      <span className="text-sm text-white font-mono w-12">
        {Math.round((concurrencyData.vram_overhead_factor || 0.95) * 100)}%
      </span>
    </div>
    {concurrencyData.workstations?.filter(ws => ws.gpu_vram_mb).map(ws => (
      <p key={ws.name} className="text-xs text-slate-500 mt-1">
        {ws.name}: {(ws.effective_vram_budget_mb / 1024).toFixed(1)} GB of {(ws.gpu_vram_mb / 1024).toFixed(1)} GB usable
      </p>
    ))}
  </div>
)}
```

- [ ] **Step 2: Add editable max_concurrent to existing host cards**

In the host card rendering, add an inline number input next to the existing `CapacityBar`:

```jsx
<div className="flex items-center gap-2 mt-2">
  <span className="text-xs text-slate-400">Max:</span>
  <input
    type="number"
    min={0}
    max={100}
    value={host.max_concurrent || 1}
    onChange={(e) => {
      const val = parseInt(e.target.value);
      if (val >= 0 && val <= 100) {
        concurrency.set({ scope: 'host', target: host.id, max_concurrent: val }).then(() => {
          addToast(`Host max_concurrent set to ${val}`, 'success');
          fetchHosts();
        });
      }
    }}
    className="w-16 px-2 py-1 text-sm bg-slate-800 border border-slate-600 rounded text-white"
  />
</div>
```

- [ ] **Step 3: Add workstation section below hosts**

Add a "Workstations" section after the ollama hosts section:

```jsx
{concurrencyData?.workstations?.length > 0 && (
  <div className="mt-8">
    <h2 className="text-xl font-bold text-white mb-4">Workstations</h2>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {concurrencyData.workstations.map(ws => (
        <div key={ws.name} className="glass-card p-5">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-lg font-semibold text-white">{ws.name}</h3>
            <span className="text-xs text-slate-400">{ws.host}</span>
          </div>
          {ws.gpu_vram_mb && (
            <VramBar used={ws.effective_vram_budget_mb} total={ws.gpu_vram_mb} />
          )}
          <CapacityBar running={ws.running_tasks} max={ws.max_concurrent} />
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs text-slate-400">Max Concurrent:</span>
            <input
              type="number"
              min={1}
              max={100}
              value={ws.max_concurrent}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (val >= 1 && val <= 100) {
                  concurrency.set({ scope: 'workstation', target: ws.name, max_concurrent: val }).then(() => {
                    addToast(`Workstation '${ws.name}' max_concurrent set to ${val}`, 'success');
                    concurrency.get().then(setConcurrencyData);
                  });
                }
              }}
              className="w-16 px-2 py-1 text-sm bg-slate-800 border border-slate-600 rounded text-white"
            />
          </div>
        </div>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/views/Hosts.jsx
git commit -m "feat: VRAM slider, host max_concurrent inputs, and workstation section on Hosts page"
```

---

## Summary

| Chunk | Tasks | Tests | Description |
|-------|-------|-------|-------------|
| **1** | 1-4 | ~10 | VRAM migration, tool defs, handlers, wiring |
| **2** | 5-7 | 0 (visual) | Dashboard API client, Providers UI, Hosts UI |

**Total:** 7 tasks, ~10 tests, 3 new files, 7 modified files

**Key behaviors after implementation:**
- `get_concurrency_limits` → unified view of all 4 scopes
- `set_concurrency_limit scope=vram_factor vram_factor=0.90` → persists to config table, affects all VRAM gating
- `set_concurrency_limit scope=workstation target=BahumutsOmen max_concurrent=2` → persists, gates all providers
- Dashboard Hosts page shows VRAM slider + workstation cards with editable limits
- Dashboard Providers page shows editable max_concurrent per provider
- All values persist between sessions (database-backed)
