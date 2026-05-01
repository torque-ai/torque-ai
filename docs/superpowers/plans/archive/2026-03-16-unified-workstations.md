# Unified Workstations Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify TORQUE's three separate remote machine systems (peek hosts, remote agents, Ollama hosts) into a single "workstation" concept with auto-detected capabilities, unified health monitoring, and transparent failover.

**Architecture:** A single `workstations` table replaces `peek_hosts`, `remote_agents`, and `ollama_hosts`. A strangler fig adapter layer lets existing code read from the new table during migration. A unified TORQUE agent runs on each workstation, exposing `/health`, `/probe`, `/run`, `/sync`, `/peek/*`, and `/certs` endpoints. Registration supports SSH bootstrap or manual install. mTLS provides mutual authentication.

**Tech Stack:** Node.js, SQLite (better-sqlite3), React (dashboard), mTLS (node:crypto), Vitest

**Spec:** `docs/superpowers/specs/2026-03-16-unified-workstations-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `server/workstation/model.js` | Workstation CRUD, capabilities JSON parsing, validation |
| `server/workstation/adapters.js` | Backward-compat wrappers: `listOllamaHosts()`, `resolvePeekHost()`, `getAvailableAgents()` |
| `server/workstation/probe.js` | Capability detection — parse `/probe` response into capabilities JSON |
| `server/workstation/certs.js` | mTLS cert generation (self-signed), pinning, verification, expiry tracking |
| `server/workstation/routing.js` | Capability-based task routing — match task signals to workstation capabilities |
| `server/workstation/failover.js` | Transparent failover — re-route queued tasks when workstation goes down |
| `server/workstation/migration.js` | Phase 2 data migration — copy existing host records into workstations |
| `server/handlers/workstation-handlers.js` | MCP tool handlers for workstation management |
| `server/tool-defs/workstation-defs.js` | Tool definitions (JSON schemas) for workstation tools |
| `server/tests/workstation-model.test.js` | Unit tests for model, adapters, routing, certs |
| `server/tests/workstation-integration.test.js` | Integration tests for registration, health, failover |
| `server/tests/workstation-handlers.test.js` | Handler tests for MCP tool responses |

### Modified files
| File | Changes |
|------|---------|
| `server/db/schema-migrations.js` | Create `workstations` table, migrate existing data, update `host_credentials` constraint |
| `server/db/schema-seeds.js` | Seed default workstation config keys |
| `server/utils/host-monitoring.js` | Add `checkAllWorkstations()` after `runHostHealthChecks()` in health check interval (line ~751) |
| `server/db/host-management.js` | Initialize workstation model in `setDb()` |
| `server/mcp-sse.js` | Push `workstation_status` after `initialize` response (line ~1073 in `handleMcpRequest`) |
| `server/tools.js` | Register workstation handlers and tool defs |
| `agent/index.js` | Add `/probe`, `/certs`, `/peek/*` endpoints to existing ESM agent |

### Explicitly deferred to separate plans
| Feature | Reason |
|---------|--------|
| Dashboard views (`Workstations.jsx`, `WorkstationWizard.jsx`) | Dashboard is a separate concern — needs its own spec/plan for React components |
| Dashboard E2E tests (`workstations.spec.js`) | Depends on dashboard views |
| `complexity_routing.target_host` migration | Phase 3 consumer migration — after adapters proven stable |
| Consumer file modifications (`host-selection.js`, `peek/shared.js`, `agent-client.js`, `remote-test-routing.js`, `task/core.js`) | Phase 3 — each consumer migrated individually to query `workstations` directly |

---

## Chunk 1: Data Model, CRUD & Adapter Layer (Phase 1)

### Task 1: Schema Migration — Create `workstations` Table

**Files:**
- Modify: `server/db/schema-migrations.js`
- Test: `server/tests/workstation-model.test.js`

- [ ] **Step 1: Write failing test for workstations table existence**

```javascript
// server/tests/workstation-model.test.js
'use strict';

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');

describe('workstation model', () => {
  let db;
  beforeAll(() => { const env = setupTestDb('workstation-model'); db = env.db; });
  afterAll(() => teardownTestDb());

  describe('schema', () => {
    it('workstations table exists with all required columns', () => {
      const columns = rawDb()
        .prepare("PRAGMA table_info('workstations')")
        .all()
        .map(c => c.name);

      expect(columns).toContain('id');
      expect(columns).toContain('name');
      expect(columns).toContain('host');
      expect(columns).toContain('agent_port');
      expect(columns).toContain('capabilities');
      expect(columns).toContain('ollama_port');
      expect(columns).toContain('status');
      expect(columns).toContain('tls_cert');
      expect(columns).toContain('tls_fingerprint');
      expect(columns).toContain('secret');
      expect(columns).toContain('gpu_name');
      expect(columns).toContain('gpu_vram_mb');
      expect(columns).toContain('max_concurrent');
      expect(columns).toContain('running_tasks');
      expect(columns).toContain('priority');
      expect(columns).toContain('enabled');
      expect(columns).toContain('is_default');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: FAIL — `workstations` table does not exist

- [ ] **Step 3: Add workstations table creation to schema-migrations.js**

Add the following at the end of `runMigrations()` in `server/db/schema-migrations.js`:

```javascript
  // Unified workstations table — replaces peek_hosts, remote_agents, ollama_hosts
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workstations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        host TEXT NOT NULL,
        agent_port INTEGER DEFAULT 3460,
        platform TEXT,
        arch TEXT,
        tls_cert TEXT,
        tls_fingerprint TEXT,
        secret TEXT,
        capabilities TEXT,
        ollama_port INTEGER DEFAULT 11434,
        models_cache TEXT,
        memory_limit_mb INTEGER,
        settings TEXT,
        last_model_used TEXT,
        model_loaded_at TEXT,
        gpu_metrics_port INTEGER,
        models_updated_at TEXT,
        gpu_name TEXT,
        gpu_vram_mb INTEGER,
        status TEXT DEFAULT 'unknown',
        consecutive_failures INTEGER DEFAULT 0,
        last_health_check TEXT,
        last_healthy TEXT,
        max_concurrent INTEGER DEFAULT 3,
        running_tasks INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 10,
        enabled INTEGER DEFAULT 1,
        is_default INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    logger.debug(`Schema migration (workstations): ${e.message}`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/db/schema-migrations.js server/tests/workstation-model.test.js
git commit -m "feat(workstations): create workstations table in schema migrations"
```

---

### Task 2: Workstation CRUD Module

**Files:**
- Create: `server/workstation/model.js`
- Test: `server/tests/workstation-model.test.js` (append)

- [ ] **Step 1: Write failing tests for CRUD operations**

Append to `server/tests/workstation-model.test.js`:

```javascript
  describe('CRUD', () => {
    let model;
    beforeAll(() => {
      model = require('../workstation/model');
      model.setDb(rawDb());
    });

    beforeEach(() => {
      rawDb().exec("DELETE FROM workstations");
    });

    it('createWorkstation inserts and returns record', () => {
      const ws = model.createWorkstation({
        name: 'gpu-box',
        host: '192.168.1.100',
        secret: 'test-secret-123',
      });
      expect(ws.id).toBeTruthy();
      expect(ws.name).toBe('gpu-box');
      expect(ws.host).toBe('192.168.1.100');
      expect(ws.agent_port).toBe(3460);
      expect(ws.status).toBe('unknown');
    });

    it('createWorkstation rejects record with neither tls_cert nor secret', () => {
      expect(() => model.createWorkstation({
        name: 'bad-ws',
        host: '192.168.1.200',
      })).toThrow(/security/i);
    });

    it('getWorkstation returns null for missing id', () => {
      expect(model.getWorkstation('nonexistent')).toBeNull();
    });

    it('listWorkstations filters by capability', () => {
      model.createWorkstation({
        name: 'ollama-box',
        host: '192.168.1.101',
        secret: 's1',
        capabilities: JSON.stringify({ ollama: { detected: true } }),
      });
      model.createWorkstation({
        name: 'plain-box',
        host: '192.168.1.102',
        secret: 's2',
        capabilities: JSON.stringify({ command_exec: true }),
      });
      const ollamaHosts = model.listWorkstations({ capability: 'ollama' });
      expect(ollamaHosts).toHaveLength(1);
      expect(ollamaHosts[0].name).toBe('ollama-box');
    });

    it('updateWorkstation updates fields', () => {
      const ws = model.createWorkstation({ name: 'ws1', host: '10.0.0.1', secret: 's' });
      const updated = model.updateWorkstation(ws.id, { status: 'healthy', priority: 5 });
      expect(updated.status).toBe('healthy');
      expect(updated.priority).toBe(5);
    });

    it('removeWorkstation deletes record', () => {
      const ws = model.createWorkstation({ name: 'ws2', host: '10.0.0.2', secret: 's' });
      const removed = model.removeWorkstation(ws.id);
      expect(removed.name).toBe('ws2');
      expect(model.getWorkstation(ws.id)).toBeNull();
    });

    it('listWorkstations with enabled filter', () => {
      model.createWorkstation({ name: 'en', host: '10.0.0.3', secret: 's', enabled: true });
      model.createWorkstation({ name: 'dis', host: '10.0.0.4', secret: 's', enabled: false });
      const enabled = model.listWorkstations({ enabled: true });
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('en');
    });

    it('tryReserveSlot acquires when under capacity', () => {
      const ws = model.createWorkstation({ name: 'slot-ws', host: '10.0.0.5', secret: 's', max_concurrent: 2 });
      const result = model.tryReserveSlot(ws.id);
      expect(result.acquired).toBe(true);
      expect(result.currentLoad).toBe(1);
    });

    it('tryReserveSlot rejects when at capacity', () => {
      const ws = model.createWorkstation({ name: 'full-ws', host: '10.0.0.6', secret: 's', max_concurrent: 1 });
      model.tryReserveSlot(ws.id);
      const result = model.tryReserveSlot(ws.id);
      expect(result.acquired).toBe(false);
    });

    it('releaseSlot decrements running_tasks', () => {
      const ws = model.createWorkstation({ name: 'release-ws', host: '10.0.0.7', secret: 's', max_concurrent: 3 });
      model.tryReserveSlot(ws.id);
      model.releaseSlot(ws.id);
      const updated = model.getWorkstation(ws.id);
      expect(updated.running_tasks).toBe(0);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement workstation model**

```javascript
// server/workstation/model.js
'use strict';

const { randomUUID } = require('crypto');
const logger = require('../logger').child({ component: 'workstation-model' });

let db;

function setDb(dbInstance) { db = dbInstance; }

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function parseCapabilities(ws) {
  if (ws && ws.capabilities) {
    ws._capabilities = safeJsonParse(ws.capabilities, {});
  } else if (ws) {
    ws._capabilities = {};
  }
  if (ws && ws.models_cache) {
    ws.models = safeJsonParse(ws.models_cache, []);
  } else if (ws) {
    ws.models = [];
  }
  return ws;
}

function createWorkstation(opts) {
  if (!opts.tls_cert && !opts.secret) {
    throw new Error('Security validation failed: workstation must have tls_cert or secret');
  }

  const id = opts.id || randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO workstations (id, name, host, agent_port, platform, arch,
      tls_cert, tls_fingerprint, secret, capabilities,
      ollama_port, models_cache, memory_limit_mb, settings,
      gpu_name, gpu_vram_mb, gpu_metrics_port,
      max_concurrent, priority, enabled, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, opts.name, opts.host, opts.agent_port || 3460,
    opts.platform || null, opts.arch || null,
    opts.tls_cert || null, opts.tls_fingerprint || null, opts.secret || null,
    opts.capabilities || null,
    opts.ollama_port || 11434, opts.models_cache || null,
    opts.memory_limit_mb || null, opts.settings || null,
    opts.gpu_name || null, opts.gpu_vram_mb || null, opts.gpu_metrics_port || null,
    opts.max_concurrent || 3, opts.priority || 10,
    opts.enabled !== false ? 1 : 0, opts.is_default ? 1 : 0,
    now, now
  );

  return getWorkstation(id);
}

function getWorkstation(id) {
  const ws = db.prepare('SELECT * FROM workstations WHERE id = ?').get(id);
  return ws ? parseCapabilities(ws) : null;
}

function getWorkstationByName(name) {
  const ws = db.prepare('SELECT * FROM workstations WHERE name = ?').get(name);
  return ws ? parseCapabilities(ws) : null;
}

function listWorkstations(filters = {}) {
  let query = 'SELECT * FROM workstations WHERE 1=1';
  const values = [];

  if (filters.enabled !== undefined) {
    query += ' AND enabled = ?';
    values.push(filters.enabled ? 1 : 0);
  }
  if (filters.status) {
    query += ' AND status = ?';
    values.push(filters.status);
  }
  if (filters.capability) {
    // Filter by top-level key in capabilities JSON
    query += " AND json_extract(capabilities, '$.' || ?) IS NOT NULL";
    values.push(filters.capability);
  }

  query += ' ORDER BY priority DESC, running_tasks ASC, name ASC';

  return db.prepare(query).all(...values).map(parseCapabilities);
}

function updateWorkstation(id, updates) {
  const allowedFields = [
    'name', 'host', 'agent_port', 'platform', 'arch',
    'tls_cert', 'tls_fingerprint', 'secret', 'capabilities',
    'ollama_port', 'models_cache', 'memory_limit_mb', 'settings',
    'last_model_used', 'model_loaded_at', 'gpu_metrics_port', 'models_updated_at',
    'gpu_name', 'gpu_vram_mb',
    'status', 'consecutive_failures', 'last_health_check', 'last_healthy',
    'max_concurrent', 'running_tasks', 'priority', 'enabled', 'is_default',
  ];

  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return getWorkstation(id);

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE workstations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getWorkstation(id);
}

function removeWorkstation(id) {
  const ws = getWorkstation(id);
  if (!ws) return null;
  db.prepare('DELETE FROM workstations WHERE id = ?').run(id);
  return ws;
}

function tryReserveSlot(id) {
  const ws = getWorkstation(id);
  if (!ws) return { acquired: false, error: 'Workstation not found' };
  const max = ws.max_concurrent || 0;
  if (max <= 0) {
    db.prepare('UPDATE workstations SET running_tasks = running_tasks + 1 WHERE id = ?').run(id);
    return { acquired: true, currentLoad: ws.running_tasks + 1, maxCapacity: 0 };
  }
  const result = db.prepare(
    'UPDATE workstations SET running_tasks = running_tasks + 1 WHERE id = ? AND running_tasks < max_concurrent'
  ).run(id);
  if (result.changes > 0) {
    return { acquired: true, currentLoad: ws.running_tasks + 1, maxCapacity: max };
  }
  return { acquired: false, currentLoad: ws.running_tasks, maxCapacity: max };
}

function releaseSlot(id) {
  db.prepare('UPDATE workstations SET running_tasks = MAX(0, running_tasks - 1) WHERE id = ?').run(id);
}

function recordHealthCheck(id, healthy, models = null) {
  const now = new Date().toISOString();
  const ws = getWorkstation(id);
  if (!ws) return null;

  const updates = { last_health_check: now };
  if (healthy) {
    updates.status = 'healthy';
    updates.consecutive_failures = 0;
    updates.last_healthy = now;
    if (models) {
      updates.models_cache = JSON.stringify(models);
      updates.models_updated_at = now;
    }
  } else {
    const newFailures = (ws.consecutive_failures || 0) + 1;
    updates.consecutive_failures = newFailures;
    updates.status = newFailures >= 3 ? 'down' : 'degraded';
  }

  return updateWorkstation(id, updates);
}

function getDefaultWorkstation() {
  const ws = db.prepare('SELECT * FROM workstations WHERE is_default = 1 AND enabled = 1 LIMIT 1').get();
  return ws ? parseCapabilities(ws) : null;
}

function hasCapability(ws, capName) {
  if (!ws || !ws._capabilities) return false;
  const val = ws._capabilities[capName];
  if (val === true) return true;
  if (val && typeof val === 'object' && val.detected) return true;
  // Check arrays (build_tools, test_runners)
  if (Array.isArray(val) && val.length > 0) return true;
  return false;
}

/**
 * Build a workstation_status notification payload for session-start push.
 */
function buildWorkstationStatusNotification() {
  const workstations = listWorkstations({ enabled: true })
    .filter(ws => ws.status === 'healthy');

  if (workstations.length === 0) return null;

  return {
    type: 'workstation_status',
    workstations: workstations.map(ws => {
      const caps = ws._capabilities || {};
      const capList = Object.keys(caps).filter(k => {
        const v = caps[k];
        return v === true || (v && typeof v === 'object' && v.detected) || Array.isArray(v);
      });

      return {
        name: ws.name,
        host: ws.host,
        status: ws.status,
        capabilities: capList,
        gpu: ws.gpu_name ? `${ws.gpu_name} (${Math.round((ws.gpu_vram_mb || 0) / 1024)}GB)` : null,
        is_default: !!ws.is_default,
      };
    }),
    hint: 'Remote workstations available. Use them for testing, builds, and UI verification instead of running locally.',
  };
}

module.exports = {
  setDb,
  createWorkstation,
  getWorkstation,
  getWorkstationByName,
  listWorkstations,
  updateWorkstation,
  removeWorkstation,
  tryReserveSlot,
  releaseSlot,
  recordHealthCheck,
  getDefaultWorkstation,
  hasCapability,
  buildWorkstationStatusNotification,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/workstation/model.js server/tests/workstation-model.test.js
git commit -m "feat(workstations): workstation CRUD model with security validation"
```

---

### Task 3: Adapter Layer

**Files:**
- Create: `server/workstation/adapters.js`
- Test: `server/tests/workstation-model.test.js` (append)

- [ ] **Step 1: Write failing tests for adapter functions**

Append to `server/tests/workstation-model.test.js`:

```javascript
  describe('adapters', () => {
    let adapters, model;
    beforeAll(() => {
      model = require('../workstation/model');
      adapters = require('../workstation/adapters');
      model.setDb(rawDb());
      adapters.setDb(rawDb());
    });

    beforeEach(() => {
      rawDb().exec("DELETE FROM workstations");
    });

    it('listOllamaHosts returns workstations with ollama capability in old shape', () => {
      model.createWorkstation({
        name: 'ollama-ws',
        host: '192.168.1.100',
        secret: 's',
        ollama_port: 11434,
        capabilities: JSON.stringify({ ollama: { detected: true, port: 11434, models: ['qwen3:8b'] } }),
        models_cache: JSON.stringify(['qwen3:8b']),
        max_concurrent: 3,
        priority: 8,
        memory_limit_mb: 24576,
      });

      const hosts = adapters.listOllamaHosts();
      expect(hosts).toHaveLength(1);
      const h = hosts[0];
      expect(h.url).toBe('http://192.168.1.100:11434');
      expect(h.memory_limit_mb).toBe(24576);
      expect(h.max_concurrent).toBe(3);
      expect(h.priority).toBe(8);
      expect(h.models).toEqual(['qwen3:8b']);
    });

    it('resolvePeekHost returns workstation with ui_capture capability', () => {
      model.createWorkstation({
        name: 'peek-ws',
        host: '192.0.2.100',
        secret: 's',
        capabilities: JSON.stringify({ ui_capture: { detected: true, has_display: true, peek_server: 'running' } }),
      });

      const host = adapters.resolvePeekHost();
      expect(host).toBeTruthy();
      expect(host.host).toBe('192.0.2.100');
    });

    it('getAvailableAgents returns workstations with command_exec capability and capacity', () => {
      model.createWorkstation({
        name: 'agent-ws',
        host: '192.168.1.50',
        secret: 's',
        max_concurrent: 3,
        capabilities: JSON.stringify({ command_exec: true }),
      });

      const agents = adapters.getAvailableAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('agent-ws');
    });

    it('addOllamaHost creates workstation with ollama capability', () => {
      const ws = adapters.addOllamaHost({
        name: 'new-ollama',
        url: 'http://192.168.1.200:11434',
        memory_limit_mb: 8192,
      });
      expect(ws).toBeTruthy();

      const found = model.getWorkstationByName('new-ollama');
      expect(found).toBeTruthy();
      expect(found.host).toBe('192.168.1.200');
      expect(found.ollama_port).toBe(11434);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement adapter layer**

```javascript
// server/workstation/adapters.js
'use strict';

const logger = require('../logger').child({ component: 'workstation-adapters' });
const model = require('./model');

let db;

function setDb(dbInstance) {
  db = dbInstance;
  model.setDb(dbInstance);
}

/**
 * Adapter: listOllamaHosts — returns workstations with ollama capability
 * in the old ollama_hosts shape that host-selection.js expects.
 */
function listOllamaHosts(options = {}) {
  const filters = { capability: 'ollama' };
  if (options.enabled !== undefined) filters.enabled = options.enabled;
  if (options.status) filters.status = options.status;

  const workstations = model.listWorkstations(filters);

  return workstations.map(ws => ({
    id: ws.id,
    name: ws.name,
    url: `http://${ws.host}:${ws.ollama_port || 11434}`,
    enabled: ws.enabled,
    status: ws.status,
    consecutive_failures: ws.consecutive_failures,
    last_health_check: ws.last_health_check,
    last_healthy: ws.last_healthy,
    running_tasks: ws.running_tasks,
    models_cache: ws.models_cache,
    models_updated_at: ws.models_updated_at,
    models: ws.models || [],
    memory_limit_mb: ws.memory_limit_mb,
    max_concurrent: ws.max_concurrent,
    priority: ws.priority,
    settings: ws.settings,
    gpu_metrics_port: ws.gpu_metrics_port,
    last_model_used: ws.last_model_used,
    model_loaded_at: ws.model_loaded_at,
    created_at: ws.created_at,
  }));
}

/**
 * Adapter: resolvePeekHost — returns workstation with ui_capture capability
 */
function resolvePeekHost(options = {}) {
  const workstations = model.listWorkstations({ capability: 'ui_capture', enabled: true });

  if (options.name) {
    return workstations.find(ws => ws.name === options.name) || null;
  }

  const defaultWs = workstations.find(ws => ws.is_default);
  if (defaultWs) return defaultWs;
  return workstations.find(ws => ws.status === 'healthy') || workstations[0] || null;
}

/**
 * Adapter: getAvailableAgents — returns workstations with command_exec and capacity
 */
function getAvailableAgents() {
  return model.listWorkstations({ capability: 'command_exec', enabled: true })
    .filter(ws => ws.status !== 'down' && ws.running_tasks < ws.max_concurrent);
}

/**
 * Adapter: addOllamaHost — creates workstation with ollama capability
 */
function addOllamaHost(host) {
  let parsedHost = host.url || host.host || 'localhost';
  let ollamaPort = 11434;

  if (host.url) {
    try {
      const u = new URL(host.url);
      parsedHost = u.hostname;
      ollamaPort = parseInt(u.port) || 11434;
    } catch {
      // Not a URL, treat as hostname
    }
  }

  const capabilities = { ollama: { detected: true, port: ollamaPort } };

  return model.createWorkstation({
    id: host.id || undefined,
    name: host.name,
    host: parsedHost,
    ollama_port: ollamaPort,
    memory_limit_mb: host.memory_limit_mb || 8192,
    max_concurrent: host.max_concurrent || 1,
    capabilities: JSON.stringify(capabilities),
    secret: host.secret || `legacy-ollama-${Date.now()}`,
  });
}

/**
 * Adapter: registerPeekHost — creates workstation with ui_capture capability
 */
function registerPeekHost(host) {
  const capabilities = { ui_capture: { detected: true, has_display: true } };

  return model.createWorkstation({
    name: host.name,
    host: host.host || host.url,
    capabilities: JSON.stringify(capabilities),
    secret: host.secret || `legacy-peek-${Date.now()}`,
    is_default: host.is_default || false,
  });
}

/**
 * Adapter: registerRemoteAgent — creates workstation with command_exec capability
 */
function registerRemoteAgent(agent) {
  const capabilities = { command_exec: true, git_sync: true };

  return model.createWorkstation({
    name: agent.name,
    host: agent.host,
    agent_port: agent.port || 3460,
    capabilities: JSON.stringify(capabilities),
    secret: agent.secret,
    max_concurrent: agent.max_concurrent || 3,
  });
}

module.exports = {
  setDb,
  listOllamaHosts,
  resolvePeekHost,
  getAvailableAgents,
  addOllamaHost,
  registerPeekHost,
  registerRemoteAgent,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/workstation/adapters.js server/tests/workstation-model.test.js
git commit -m "feat(workstations): adapter layer for backward-compat with old host APIs"
```

---

## Chunk 2: mTLS Certificates & Capability Detection

### Task 4: mTLS Certificate Module

**Files:**
- Create: `server/workstation/certs.js`
- Test: `server/tests/workstation-model.test.js` (append)

- [ ] **Step 1: Write failing tests for cert generation and fingerprinting**

Append to `server/tests/workstation-model.test.js`:

```javascript
  describe('certs', () => {
    const certs = require('../workstation/certs');

    it('getCertFingerprint extracts SHA-256 fingerprint from PEM data', () => {
      const fp = certs.getCertFingerprint('test-cert-data-for-hashing');
      expect(fp).toMatch(/^[A-Fa-f0-9:]+$/);
    });

    it('isCertExpiringSoon returns true when within warning window', () => {
      const soon = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
      expect(certs.isCertExpiringSoon(soon, 30)).toBe(true);
      expect(certs.isCertExpiringSoon(soon, 10)).toBe(false);
    });

    it('isCertExpiringSoon returns true for already-expired cert', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      expect(certs.isCertExpiringSoon(past, 30)).toBe(true);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: FAIL

- [ ] **Step 3: Implement certs module**

```javascript
// server/workstation/certs.js
'use strict';

const crypto = require('crypto');

const DEFAULT_LIFETIME_DAYS = 365;
const EXPIRY_WARNING_DAYS = 30;

/**
 * Extract SHA-256 fingerprint from a PEM certificate or arbitrary data.
 */
function getCertFingerprint(certPem) {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    return x509.fingerprint256;
  } catch {
    // Fallback for non-cert PEM (e.g., public key, or plain text during testing)
    const hash = crypto.createHash('sha256').update(certPem).digest('hex');
    return hash.match(/.{2}/g).join(':').toUpperCase();
  }
}

/**
 * Check if a certificate is expiring within the warning window.
 */
function isCertExpiringSoon(expiresAt, warningDays = EXPIRY_WARNING_DAYS) {
  const expiry = new Date(expiresAt);
  const warningDate = new Date(Date.now() + warningDays * 24 * 60 * 60 * 1000);
  return expiry <= warningDate;
}

module.exports = {
  getCertFingerprint,
  isCertExpiringSoon,
  DEFAULT_LIFETIME_DAYS,
  EXPIRY_WARNING_DAYS,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/workstation/certs.js server/tests/workstation-model.test.js
git commit -m "feat(workstations): mTLS certificate fingerprinting and expiry checks"
```

---

### Task 5: Capability Probe Parser

**Files:**
- Create: `server/workstation/probe.js`
- Test: `server/tests/workstation-model.test.js` (append)

- [ ] **Step 1: Write failing tests for probe parsing**

Append to `server/tests/workstation-model.test.js`:

```javascript
  describe('probe', () => {
    const probe = require('../workstation/probe');

    it('parseProbeResponse extracts capabilities JSON from probe payload', () => {
      const probeResponse = {
        platform: 'windows',
        arch: 'x64',
        capabilities: {
          command_exec: true,
          git_sync: true,
          ollama: { detected: true, port: 11434, models: ['qwen3:8b'] },
          gpu: { detected: true, name: 'RTX 3090', vram_mb: 24576 },
          ui_capture: { detected: true, has_display: true, peek_server: 'running' },
          build_tools: ['npm', 'dotnet'],
          test_runners: ['vitest', 'jest'],
        },
      };

      const result = probe.parseProbeResponse(probeResponse);
      expect(result.platform).toBe('windows');
      expect(result.arch).toBe('x64');
      expect(result.capabilities.ollama.detected).toBe(true);
      expect(result.capabilities.gpu.name).toBe('RTX 3090');
      expect(result.gpuName).toBe('RTX 3090');
      expect(result.gpuVramMb).toBe(24576);
      expect(result.ollamaPort).toBe(11434);
    });

    it('parseProbeResponse handles minimal response', () => {
      const result = probe.parseProbeResponse({ platform: 'linux', arch: 'arm64', capabilities: {} });
      expect(result.platform).toBe('linux');
      expect(result.gpuName).toBeNull();
    });

    it('probeToWorkstationUpdates builds update fields', () => {
      const parsed = probe.parseProbeResponse({
        platform: 'linux', arch: 'x64',
        capabilities: { gpu: { detected: true, name: 'A100', vram_mb: 40960 }, ollama: { detected: true, port: 11434, models: ['llama3:8b'] } },
      });
      const updates = probe.probeToWorkstationUpdates(parsed);
      expect(updates.platform).toBe('linux');
      expect(updates.gpu_name).toBe('A100');
      expect(updates.gpu_vram_mb).toBe(40960);
      expect(updates.ollama_port).toBe(11434);
      expect(JSON.parse(updates.models_cache)).toContain('llama3:8b');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: FAIL

- [ ] **Step 3: Implement probe parser**

```javascript
// server/workstation/probe.js
'use strict';

/**
 * Parse a /probe response from a TORQUE agent into workstation update fields.
 */
function parseProbeResponse(probeResponse) {
  const caps = probeResponse.capabilities || {};

  const gpuInfo = caps.gpu || {};
  const ollamaInfo = caps.ollama || {};

  return {
    platform: probeResponse.platform || null,
    arch: probeResponse.arch || null,
    capabilities: caps,
    capabilitiesJson: JSON.stringify(caps),
    gpuName: gpuInfo.detected ? (gpuInfo.name || null) : null,
    gpuVramMb: gpuInfo.detected ? (gpuInfo.vram_mb || null) : null,
    ollamaPort: ollamaInfo.detected ? (ollamaInfo.port || 11434) : null,
    models: ollamaInfo.models || [],
  };
}

/**
 * Build workstation update fields from a parsed probe result.
 */
function probeToWorkstationUpdates(parsed) {
  const updates = {
    platform: parsed.platform,
    arch: parsed.arch,
    capabilities: parsed.capabilitiesJson,
    gpu_name: parsed.gpuName,
    gpu_vram_mb: parsed.gpuVramMb,
  };

  if (parsed.ollamaPort) {
    updates.ollama_port = parsed.ollamaPort;
  }
  if (parsed.models.length > 0) {
    updates.models_cache = JSON.stringify(parsed.models);
    updates.models_updated_at = new Date().toISOString();
  }

  return updates;
}

module.exports = {
  parseProbeResponse,
  probeToWorkstationUpdates,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/workstation/probe.js server/tests/workstation-model.test.js
git commit -m "feat(workstations): probe response parser for capability detection"
```

---

## Chunk 3: Capability Routing & Failover

### Task 6: Capability-Based Task Routing

**Files:**
- Create: `server/workstation/routing.js`
- Test: `server/tests/workstation-model.test.js` (append)

- [ ] **Step 1: Write failing tests for task routing**

Append to `server/tests/workstation-model.test.js`:

```javascript
  describe('routing', () => {
    let routing, model;
    beforeAll(() => {
      model = require('../workstation/model');
      routing = require('../workstation/routing');
      model.setDb(rawDb());
      routing.setDb(rawDb());
    });

    beforeEach(() => {
      rawDb().exec("DELETE FROM workstations");
    });

    it('routes task with test runner to workstation with test_runners capability', () => {
      const ws = model.createWorkstation({
        name: 'test-runner',
        host: '10.0.0.1',
        secret: 's',
        capabilities: JSON.stringify({ command_exec: true, test_runners: ['vitest', 'pytest'] }),
      });
      model.updateWorkstation(ws.id, { status: 'healthy' });

      const match = routing.findWorkstationForTask({ verify_command: 'npx vitest run' });
      expect(match).toBeTruthy();
      expect(match.name).toBe('test-runner');
    });

    it('routes ollama task to workstation with ollama capability and requested model', () => {
      const ws = model.createWorkstation({
        name: 'ollama-box',
        host: '10.0.0.2',
        secret: 's',
        capabilities: JSON.stringify({ ollama: { detected: true } }),
        models_cache: JSON.stringify(['qwen3:8b']),
      });
      model.updateWorkstation(ws.id, { status: 'healthy' });

      const match = routing.findWorkstationForTask({ provider: 'ollama', model: 'qwen3:8b' });
      expect(match).toBeTruthy();
      expect(match.name).toBe('ollama-box');
    });

    it('falls back to default workstation when no signal matches', () => {
      const ws = model.createWorkstation({
        name: 'default-ws',
        host: '10.0.0.3',
        secret: 's',
        is_default: true,
        capabilities: JSON.stringify({ command_exec: true }),
      });
      model.updateWorkstation(ws.id, { status: 'healthy' });

      const match = routing.findWorkstationForTask({});
      expect(match).toBeTruthy();
      expect(match.name).toBe('default-ws');
    });

    it('returns null when no workstations match and no default', () => {
      const match = routing.findWorkstationForTask({ verify_command: 'cargo test' });
      expect(match).toBeNull();
    });

    it('skips workstations at capacity', () => {
      const ws = model.createWorkstation({
        name: 'full-ws',
        host: '10.0.0.4',
        secret: 's',
        max_concurrent: 1,
        capabilities: JSON.stringify({ command_exec: true, test_runners: ['vitest'] }),
      });
      model.updateWorkstation(ws.id, { status: 'healthy', running_tasks: 1 });

      const match = routing.findWorkstationForTask({ verify_command: 'npx vitest run' });
      expect(match).toBeNull();
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: FAIL

- [ ] **Step 3: Implement routing module**

```javascript
// server/workstation/routing.js
'use strict';

const logger = require('../logger').child({ component: 'workstation-routing' });
const model = require('./model');

let db;

function setDb(dbInstance) {
  db = dbInstance;
  model.setDb(dbInstance);
}

const TEST_RUNNER_PATTERNS = ['vitest', 'jest', 'pytest', 'cargo test', 'go test', 'dotnet test', 'mocha'];
const BUILD_TOOL_PATTERNS = ['npm run build', 'dotnet build', 'cargo build', 'go build', 'gradle', 'maven', 'make'];
const OLLAMA_PROVIDERS = ['ollama', 'hashline-ollama', 'aider-ollama'];

/**
 * Find the best workstation for a task based on its characteristics.
 * Returns a workstation record or null.
 */
function findWorkstationForTask(taskArgs) {
  const workstations = model.listWorkstations({ enabled: true })
    .filter(ws => ws.status !== 'down' && ws.running_tasks < ws.max_concurrent);

  if (workstations.length === 0) return null;

  const verifyCmd = (taskArgs.verify_command || '').toLowerCase();
  const provider = (taskArgs.provider || '').toLowerCase();

  // Signal 1: test runner in verify_command
  if (verifyCmd) {
    const hasTestRunner = TEST_RUNNER_PATTERNS.some(p => verifyCmd.includes(p));
    if (hasTestRunner) {
      const match = workstations.find(ws => model.hasCapability(ws, 'test_runners'));
      if (match) return match;
    }

    const hasBuildTool = BUILD_TOOL_PATTERNS.some(p => verifyCmd.includes(p));
    if (hasBuildTool) {
      const match = workstations.find(ws => model.hasCapability(ws, 'build_tools'));
      if (match) return match;
    }
  }

  // Signal 2: Ollama provider
  if (OLLAMA_PROVIDERS.includes(provider)) {
    const ollamaWs = workstations.filter(ws => model.hasCapability(ws, 'ollama'));
    if (taskArgs.model) {
      const modelLower = taskArgs.model.toLowerCase();
      const withModel = ollamaWs.find(ws =>
        ws.models && ws.models.some(m => {
          const name = typeof m === 'string' ? m : m.name || '';
          return name.toLowerCase() === modelLower;
        })
      );
      if (withModel) return withModel;
    }
    if (ollamaWs.length > 0) return ollamaWs[0];
  }

  // Signal 3: peek_ui tool call
  if (taskArgs.tool === 'peek_ui') {
    const match = workstations.find(ws => model.hasCapability(ws, 'ui_capture'));
    if (match) return match;
  }

  // Fallback: default workstation
  const defaultWs = model.getDefaultWorkstation();
  if (defaultWs && defaultWs.status !== 'down' && defaultWs.running_tasks < defaultWs.max_concurrent) {
    return defaultWs;
  }

  return null;
}

module.exports = {
  setDb,
  findWorkstationForTask,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/workstation/routing.js server/tests/workstation-model.test.js
git commit -m "feat(workstations): capability-based task routing to workstations"
```

---

### Task 7: Failover Logic

**Files:**
- Create: `server/workstation/failover.js`
- Test: `server/tests/workstation-model.test.js` (append)

- [ ] **Step 1: Write failing tests for failover**

Append to `server/tests/workstation-model.test.js`:

```javascript
  describe('failover', () => {
    let failover, model;
    beforeAll(() => {
      model = require('../workstation/model');
      failover = require('../workstation/failover');
      model.setDb(rawDb());
      failover.setDb(rawDb());
    });

    beforeEach(() => {
      rawDb().exec("DELETE FROM workstations");
    });

    it('findFailoverWorkstation returns workstation with matching capability', () => {
      const ws = model.createWorkstation({
        name: 'backup-ws',
        host: '10.0.0.10',
        secret: 's',
        capabilities: JSON.stringify({ ollama: { detected: true } }),
      });
      model.updateWorkstation(ws.id, { status: 'healthy' });

      const backup = failover.findFailoverWorkstation('ollama', 'nonexistent-ws-id');
      expect(backup).toBeTruthy();
      expect(backup.name).toBe('backup-ws');
    });

    it('findFailoverWorkstation excludes the downed workstation', () => {
      const ws = model.createWorkstation({
        name: 'only-ws',
        host: '10.0.0.11',
        secret: 's',
        capabilities: JSON.stringify({ ollama: { detected: true } }),
      });
      model.updateWorkstation(ws.id, { status: 'healthy' });

      const backup = failover.findFailoverWorkstation('ollama', ws.id);
      expect(backup).toBeNull();
    });

    it('findFailoverWorkstation picks least loaded when multiple candidates', () => {
      const ws1 = model.createWorkstation({
        name: 'busy-ws',
        host: '10.0.0.12',
        secret: 's',
        capabilities: JSON.stringify({ command_exec: true }),
      });
      model.updateWorkstation(ws1.id, { status: 'healthy', running_tasks: 2 });

      const ws2 = model.createWorkstation({
        name: 'idle-ws',
        host: '10.0.0.13',
        secret: 's',
        capabilities: JSON.stringify({ command_exec: true }),
      });
      model.updateWorkstation(ws2.id, { status: 'healthy', running_tasks: 0 });

      const backup = failover.findFailoverWorkstation('command_exec', 'some-other-id');
      expect(backup.name).toBe('idle-ws');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: FAIL

- [ ] **Step 3: Implement failover module**

```javascript
// server/workstation/failover.js
'use strict';

const logger = require('../logger').child({ component: 'workstation-failover' });
const model = require('./model');

let db;

function setDb(dbInstance) {
  db = dbInstance;
  model.setDb(dbInstance);
}

/**
 * Find a healthy workstation with matching capability to replace a downed one.
 * @param {string} capability - Required capability (e.g., 'ollama', 'command_exec')
 * @param {string} excludeId - ID of the downed workstation to exclude
 * @returns {object|null} Replacement workstation or null
 */
function findFailoverWorkstation(capability, excludeId) {
  const candidates = model.listWorkstations({ capability, enabled: true })
    .filter(ws =>
      ws.id !== excludeId &&
      ws.status === 'healthy' &&
      ws.running_tasks < ws.max_concurrent
    );

  if (candidates.length === 0) return null;

  // Pick least loaded
  candidates.sort((a, b) => a.running_tasks - b.running_tasks);
  return candidates[0];
}

/**
 * Handle a workstation going down.
 * Re-routes queued tasks to alternative workstations; marks running tasks as failed.
 * @param {string} workstationId - The downed workstation ID
 * @param {function} getTasksByWorkstation - fn(wsId) => tasks assigned to this workstation
 * @param {function} updateTask - fn(taskId, updates) => update task record
 */
function handleWorkstationDown(workstationId, getTasksByWorkstation, updateTask) {
  const ws = model.getWorkstation(workstationId);
  if (!ws) return { rerouted: 0, failed: 0 };

  const tasks = getTasksByWorkstation(workstationId);
  let rerouted = 0;
  let failed = 0;

  for (const task of tasks) {
    if (task.status === 'queued') {
      const caps = ws._capabilities || {};
      const primaryCap = Object.keys(caps).find(k => {
        const v = caps[k];
        return v === true || (v && typeof v === 'object' && v.detected);
      }) || 'command_exec';

      const replacement = findFailoverWorkstation(primaryCap, workstationId);
      if (replacement) {
        updateTask(task.id, { workstation_id: replacement.id });
        logger.info(`[Failover] Task ${task.id} re-routed from '${ws.name}' to '${replacement.name}'`);
        rerouted++;
      } else {
        updateTask(task.id, { status: 'failed', error: `workstation_down: ${ws.name}` });
        failed++;
      }
    } else if (task.status === 'running') {
      updateTask(task.id, { status: 'failed', error: `workstation_down: ${ws.name}` });
      logger.warn(`[Failover] Running task ${task.id} marked failed — workstation '${ws.name}' is down`);
      failed++;
    }
  }

  return { rerouted, failed };
}

module.exports = {
  setDb,
  findFailoverWorkstation,
  handleWorkstationDown,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/workstation-model.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/workstation/failover.js server/tests/workstation-model.test.js
git commit -m "feat(workstations): failover logic for downed workstations"
```

---

## Chunk 4: MCP Tools, Handlers & Session Notifications

### Task 8: Workstation Tool Definitions

**Files:**
- Create: `server/tool-defs/workstation-defs.js`

- [ ] **Step 1: Write tool definitions**

```javascript
// server/tool-defs/workstation-defs.js
const tools = [
  {
    name: 'list_workstations',
    description: 'List all registered workstations with status, capabilities, and health. Workstations are remote or local machines that TORQUE can route work to.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string', description: 'Filter by capability (e.g., "ollama", "ui_capture", "command_exec", "gpu")' },
        status: { type: 'string', description: 'Filter by status (e.g., "healthy", "down", "degraded")' },
        enabled: { type: 'boolean', description: 'Filter by enabled state (default: all)' },
      },
    },
  },
  {
    name: 'add_workstation',
    description: 'Register a new workstation with TORQUE. The machine must be running the TORQUE agent, or SSH credentials must be provided for bootstrap.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable name (e.g., "gpu-box", "build-server")' },
        host: { type: 'string', description: 'Hostname or IP address' },
        agent_port: { type: 'integer', description: 'Agent port (default: 3460)', default: 3460 },
        secret: { type: 'string', description: 'Shared secret for authentication (alternative to mTLS cert)' },
        max_concurrent: { type: 'integer', description: 'Max concurrent tasks (default: 3)', default: 3 },
        priority: { type: 'integer', description: 'Routing priority — higher = preferred (default: 10)', default: 10 },
        is_default: { type: 'boolean', description: 'Set as default workstation (default: false)', default: false },
      },
      required: ['name', 'host', 'secret'],
    },
  },
  {
    name: 'remove_workstation',
    description: 'Remove a registered workstation by name or ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workstation name to remove' },
        id: { type: 'string', description: 'Workstation ID to remove (alternative to name)' },
      },
    },
  },
  {
    name: 'probe_workstation',
    description: 'Re-detect capabilities of a workstation by calling its /probe endpoint. Updates GPU info, models, and capabilities.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workstation name to probe' },
      },
      required: ['name'],
    },
  },
  {
    name: 'check_workstation_health',
    description: 'Check health of one or all workstations. Returns status, load, capabilities, GPU metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Specific workstation name (omit to check all)' },
      },
    },
  },
];

module.exports = tools;
```

- [ ] **Step 2: Commit**

```bash
git add server/tool-defs/workstation-defs.js
git commit -m "feat(workstations): MCP tool definitions for workstation management"
```

---

### Task 9: Workstation Handlers

**Files:**
- Create: `server/handlers/workstation-handlers.js`

- [ ] **Step 1: Write handler implementations**

```javascript
// server/handlers/workstation-handlers.js
'use strict';

const logger = require('../logger').child({ component: 'workstation-handlers' });
const model = require('../workstation/model');
const probeModule = require('../workstation/probe');
const http = require('http');
const https = require('https');

function listWorkstations(args = {}) {
  const filters = {};
  if (args.capability) filters.capability = args.capability;
  if (args.status) filters.status = args.status;
  if (args.enabled !== undefined) filters.enabled = args.enabled;

  const workstations = model.listWorkstations(filters);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        workstations: workstations.map(ws => ({
          id: ws.id,
          name: ws.name,
          host: ws.host,
          agent_port: ws.agent_port,
          status: ws.status,
          capabilities: ws._capabilities || {},
          gpu: ws.gpu_name ? { name: ws.gpu_name, vram_mb: ws.gpu_vram_mb } : null,
          load: { running_tasks: ws.running_tasks, max_concurrent: ws.max_concurrent },
          is_default: !!ws.is_default,
          last_health_check: ws.last_health_check,
        })),
        count: workstations.length,
      }, null, 2),
    }],
  };
}

function addWorkstation(args) {
  if (!args.name || !args.host) {
    return { content: [{ type: 'text', text: 'Error: name and host are required' }] };
  }

  const existing = model.getWorkstationByName(args.name);
  if (existing) {
    return { content: [{ type: 'text', text: `Error: workstation '${args.name}' already exists (id: ${existing.id})` }] };
  }

  if (!args.secret) {
    return { content: [{ type: 'text', text: 'Error: secret is required (workstation must have authentication)' }] };
  }

  try {
    const ws = model.createWorkstation({
      name: args.name,
      host: args.host,
      agent_port: args.agent_port || 3460,
      secret: args.secret,
      max_concurrent: args.max_concurrent || 3,
      priority: args.priority || 10,
      is_default: args.is_default || false,
    });

    return {
      content: [{
        type: 'text',
        text: `Workstation '${ws.name}' registered (id: ${ws.id}). Run probe_workstation to detect capabilities.`,
      }],
    };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
}

function removeWorkstation(args) {
  let ws;
  if (args.id) {
    ws = model.removeWorkstation(args.id);
  } else if (args.name) {
    const found = model.getWorkstationByName(args.name);
    if (found) ws = model.removeWorkstation(found.id);
  }

  if (!ws) {
    return { content: [{ type: 'text', text: 'Workstation not found' }] };
  }
  return { content: [{ type: 'text', text: `Workstation '${ws.name}' removed` }] };
}

async function probeWorkstation(args) {
  const ws = model.getWorkstationByName(args.name);
  if (!ws) {
    return { content: [{ type: 'text', text: `Workstation '${args.name}' not found` }] };
  }

  try {
    const probeUrl = `http://${ws.host}:${ws.agent_port}/probe`;
    const response = await fetchJson(probeUrl, 10000);
    const parsed = probeModule.parseProbeResponse(response);
    const updates = probeModule.probeToWorkstationUpdates(parsed);

    model.updateWorkstation(ws.id, updates);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          name: ws.name,
          platform: parsed.platform,
          arch: parsed.arch,
          capabilities: parsed.capabilities,
          gpu: parsed.gpuName ? { name: parsed.gpuName, vram_mb: parsed.gpuVramMb } : null,
          models: parsed.models,
        }, null, 2),
      }],
    };
  } catch (err) {
    return { content: [{ type: 'text', text: `Probe failed for '${args.name}': ${err.message}` }] };
  }
}

async function checkWorkstationHealth(args) {
  const workstations = args.name
    ? [model.getWorkstationByName(args.name)].filter(Boolean)
    : model.listWorkstations({ enabled: true });

  const results = [];
  for (const ws of workstations) {
    try {
      const healthUrl = `http://${ws.host}:${ws.agent_port}/health`;
      const response = await fetchJson(healthUrl, 5000);
      model.recordHealthCheck(ws.id, true, response.ollama?.models);
      results.push({ name: ws.name, status: 'healthy', ...response });
    } catch (err) {
      model.recordHealthCheck(ws.id, false);
      results.push({ name: ws.name, status: 'unreachable', error: err.message });
    }
  }

  return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

module.exports = {
  listWorkstations,
  addWorkstation,
  removeWorkstation,
  probeWorkstation,
  checkWorkstationHealth,
};
```

- [ ] **Step 2: Commit**

```bash
git add server/handlers/workstation-handlers.js
git commit -m "feat(workstations): MCP tool handlers for workstation management"
```

---

### Task 10: Register Tools & Handlers in tools.js

**Files:**
- Modify: `server/tools.js`

- [ ] **Step 1: Add workstation-defs to TOOLS array**

In `server/tools.js`, add after the last `...require('./tool-defs/...')` line:

```javascript
  ...require('./tool-defs/workstation-defs'),
```

- [ ] **Step 2: Add workstation-handlers to HANDLER_MODULES array**

In `server/tools.js`, add after the last `require('./handlers/...')` line:

```javascript
  require('./handlers/workstation-handlers'),
```

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `npx vitest run server/tests/core-tools.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/tools.js
git commit -m "feat(workstations): register workstation tools and handlers"
```

---

### Task 11: Session-Start Workstation Notification

**Files:**
- Modify: `server/mcp-sse.js`
- Test: `server/tests/workstation-integration.test.js`

- [ ] **Step 1: Write failing integration test for session notification**

```javascript
// server/tests/workstation-integration.test.js
'use strict';

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');

describe('workstation integration', () => {
  let db;
  beforeAll(() => { const env = setupTestDb('workstation-integration'); db = env.db; });
  afterAll(() => teardownTestDb());

  describe('session notification', () => {
    it('buildWorkstationStatusNotification returns workstation summary', () => {
      const model = require('../workstation/model');
      model.setDb(rawDb());
      rawDb().exec("DELETE FROM workstations");

      const ws = model.createWorkstation({
        name: 'test-gpu',
        host: '192.168.1.100',
        secret: 's',
        capabilities: JSON.stringify({
          command_exec: true,
          gpu: { detected: true, name: 'RTX 3090', vram_mb: 24576 },
          ollama: { detected: true },
        }),
      });
      model.updateWorkstation(ws.id, { status: 'healthy', is_default: 1 });

      const notification = model.buildWorkstationStatusNotification();

      expect(notification).toBeTruthy();
      expect(notification.type).toBe('workstation_status');
      expect(notification.workstations).toHaveLength(1);
      expect(notification.workstations[0].name).toBe('test-gpu');
      expect(notification.workstations[0].capabilities).toContain('command_exec');
      expect(notification.workstations[0].is_default).toBe(true);
    });

    it('buildWorkstationStatusNotification returns null when no healthy workstations', () => {
      const model = require('../workstation/model');
      model.setDb(rawDb());
      rawDb().exec("DELETE FROM workstations");

      const notification = model.buildWorkstationStatusNotification();
      expect(notification).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (logic already in model.js)

Run: `npx vitest run server/tests/workstation-integration.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 3: Wire notification into mcp-sse.js session connect**

In `server/mcp-sse.js`, find where `handleInitialize` sends the initialization response. After the initialization is complete, add:

```javascript
// Push workstation status notification if workstations are available
try {
  const wsModel = require('./workstation/model');
  const wsNotification = wsModel.buildWorkstationStatusNotification();
  if (wsNotification) {
    sendJsonRpcNotification(session, 'notifications/message', {
      level: 'info',
      logger: 'torque',
      data: wsNotification,
    });
  }
} catch (err) {
  logger.debug(`Workstation notification skipped: ${err.message}`);
}
```

- [ ] **Step 4: Commit**

```bash
git add server/mcp-sse.js server/tests/workstation-integration.test.js
git commit -m "feat(workstations): push workstation_status on MCP session connect"
```

---

## Chunk 5: Data Migration & Health Integration

### Task 12: Unified Health Check Loop

**Files:**
- Modify: `server/utils/host-monitoring.js`
- Test: `server/tests/workstation-integration.test.js` (append)

- [ ] **Step 1: Write test for health check state transitions**

Append to `server/tests/workstation-integration.test.js`:

```javascript
  describe('health check lifecycle', () => {
    it('healthy → 3 failures → down → recovery → healthy', () => {
      const model = require('../workstation/model');
      model.setDb(rawDb());
      rawDb().exec("DELETE FROM workstations");

      const ws = model.createWorkstation({
        name: 'health-test',
        host: '10.0.0.99',
        secret: 's',
      });

      // Healthy
      model.recordHealthCheck(ws.id, true, ['qwen3:8b']);
      expect(model.getWorkstation(ws.id).status).toBe('healthy');

      // 3 failures → down
      model.recordHealthCheck(ws.id, false);
      expect(model.getWorkstation(ws.id).status).toBe('degraded');
      model.recordHealthCheck(ws.id, false);
      expect(model.getWorkstation(ws.id).status).toBe('degraded');
      model.recordHealthCheck(ws.id, false);
      expect(model.getWorkstation(ws.id).status).toBe('down');
      expect(model.getWorkstation(ws.id).consecutive_failures).toBe(3);

      // Recovery
      model.recordHealthCheck(ws.id, true);
      expect(model.getWorkstation(ws.id).status).toBe('healthy');
      expect(model.getWorkstation(ws.id).consecutive_failures).toBe(0);
    });
  });
```

- [ ] **Step 2: Run test**

Run: `npx vitest run server/tests/workstation-integration.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 3: Add checkAllWorkstations to host-monitoring.js**

Add to `server/utils/host-monitoring.js`:

```javascript
/**
 * Run unified health checks on all enabled workstations.
 * Calls GET /health on each workstation's agent port.
 */
async function checkAllWorkstations() {
  try {
    const wsModel = require('../workstation/model');
    const workstations = wsModel.listWorkstations({ enabled: true });

    for (const ws of workstations) {
      try {
        const data = await new Promise((resolve, reject) => {
          const req = http.get(`http://${ws.host}:${ws.agent_port}/health`, { timeout: 5000 }, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });
        wsModel.recordHealthCheck(ws.id, true, data.ollama?.models);
      } catch {
        wsModel.recordHealthCheck(ws.id, false);
      }
    }
  } catch (err) {
    logger.debug(`Workstation health check error: ${err.message}`);
  }
}
```

Wire into the existing health check interval at `server/utils/host-monitoring.js:751` — add `checkAllWorkstations()` call after `runHostHealthChecks()` inside the `setInterval` callback on line 746-763.

- [ ] **Step 4: Commit**

```bash
git add server/utils/host-monitoring.js server/tests/workstation-integration.test.js
git commit -m "feat(workstations): unified health check loop for all workstations"
```

---

### Task 13: Data Migration — Existing Hosts → Workstations (Phase 2)

**Files:**
- Create: `server/workstation/migration.js`
- Modify: `server/db/schema-migrations.js`
- Test: `server/tests/workstation-integration.test.js` (append)

- [ ] **Step 1: Write failing test for data migration**

Append to `server/tests/workstation-integration.test.js`:

```javascript
  describe('data migration', () => {
    it('migrateExistingHostsToWorkstations copies ollama_hosts into workstations', () => {
      const model = require('../workstation/model');
      model.setDb(rawDb());
      rawDb().exec("DELETE FROM workstations");
      rawDb().exec("DELETE FROM ollama_hosts");

      rawDb().prepare(`
        INSERT INTO ollama_hosts (id, name, url, enabled, status, memory_limit_mb, max_concurrent, created_at)
        VALUES ('oh-1', 'legacy-gpu', 'http://192.168.1.100:11434', 1, 'healthy', 24576, 3, datetime('now'))
      `).run();

      const { migrateExistingHostsToWorkstations } = require('../workstation/migration');
      const result = migrateExistingHostsToWorkstations(rawDb());
      expect(result.migrated).toBeGreaterThan(0);

      const ws = model.getWorkstationByName('legacy-gpu');
      expect(ws).toBeTruthy();
      expect(ws.host).toBe('192.168.1.100');
      expect(ws.ollama_port).toBe(11434);
      expect(ws.memory_limit_mb).toBe(24576);
    });

    it('migrateExistingHostsToWorkstations is idempotent', () => {
      const model = require('../workstation/model');
      model.setDb(rawDb());

      const { migrateExistingHostsToWorkstations } = require('../workstation/migration');
      const result = migrateExistingHostsToWorkstations(rawDb());
      expect(result.migrated).toBe(0); // already migrated above
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/workstation-integration.test.js --reporter verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement migration module**

```javascript
// server/workstation/migration.js
'use strict';

const { randomUUID } = require('crypto');
const logger = require('../logger').child({ component: 'workstation-migration' });

/**
 * Migrate existing ollama_hosts, peek_hosts, and remote_agents into workstations.
 * Idempotent — skips records that already have a matching workstation by name.
 */
function migrateExistingHostsToWorkstations(db) {
  let migrated = 0;
  const now = new Date().toISOString();

  // Migrate ollama_hosts
  try {
    const ollamaHosts = db.prepare('SELECT * FROM ollama_hosts').all();
    for (const host of ollamaHosts) {
      const existing = db.prepare('SELECT id FROM workstations WHERE name = ?').get(host.name);
      if (existing) continue;

      let parsedHost = 'localhost';
      let ollamaPort = 11434;
      try {
        const u = new URL(host.url);
        parsedHost = u.hostname;
        ollamaPort = parseInt(u.port) || 11434;
      } catch { /* keep defaults */ }

      const capabilities = { ollama: { detected: true, port: ollamaPort } };

      db.prepare(`
        INSERT INTO workstations (id, name, host, ollama_port, capabilities,
          models_cache, memory_limit_mb, settings, gpu_metrics_port,
          last_model_used, model_loaded_at, models_updated_at,
          status, consecutive_failures, last_health_check, last_healthy,
          max_concurrent, running_tasks, priority, enabled,
          secret, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), host.name, parsedHost, ollamaPort,
        JSON.stringify(capabilities),
        host.models_cache, host.memory_limit_mb, host.settings, host.gpu_metrics_port,
        host.last_model_used, host.model_loaded_at, host.models_updated_at,
        host.status, host.consecutive_failures, host.last_health_check, host.last_healthy,
        host.max_concurrent || 1, host.running_tasks || 0, host.priority || 10,
        host.enabled != null ? host.enabled : 1,
        `migrated-ollama-${Date.now()}`,
        host.created_at || now, now
      );
      migrated++;
    }
  } catch (e) { logger.debug(`ollama_hosts migration: ${e.message}`); }

  // Migrate peek_hosts
  try {
    const peekHosts = db.prepare('SELECT * FROM peek_hosts').all();
    for (const host of peekHosts) {
      const existing = db.prepare('SELECT id FROM workstations WHERE name = ?').get(host.name);
      if (existing) continue;

      let parsedHost = host.url || 'localhost';
      try { parsedHost = new URL(host.url).hostname; } catch { /* keep as-is */ }

      db.prepare(`
        INSERT INTO workstations (id, name, host, capabilities, is_default, enabled, secret, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), host.name, parsedHost,
        JSON.stringify({ ui_capture: { detected: true, has_display: true } }),
        host.is_default || 0, host.enabled != null ? host.enabled : 1,
        `migrated-peek-${Date.now()}`, host.created_at || now, now
      );
      migrated++;
    }
  } catch (e) { logger.debug(`peek_hosts migration: ${e.message}`); }

  // Migrate remote_agents
  try {
    const agents = db.prepare('SELECT * FROM remote_agents').all();
    for (const agent of agents) {
      const existing = db.prepare('SELECT id FROM workstations WHERE name = ?').get(agent.name);
      if (existing) continue;

      db.prepare(`
        INSERT INTO workstations (id, name, host, agent_port, capabilities, secret,
          max_concurrent, status, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), agent.name, agent.host, agent.port || 3460,
        JSON.stringify({ command_exec: true, git_sync: true }),
        agent.secret || `migrated-agent-${Date.now()}`,
        agent.max_concurrent || 3, agent.status || 'unknown',
        agent.enabled != null ? agent.enabled : 1,
        agent.created_at || now, now
      );
      migrated++;
    }
  } catch (e) { logger.debug(`remote_agents migration: ${e.message}`); }

  // Relax host_credentials constraint to include 'workstation' type
  try {
    // SQLite doesn't support ALTER CHECK constraints, so recreate the table
    const existingCreds = db.prepare('SELECT * FROM host_credentials').all();
    db.exec('DROP TABLE IF EXISTS host_credentials_backup');
    db.exec('ALTER TABLE host_credentials RENAME TO host_credentials_backup');
    db.exec(`
      CREATE TABLE host_credentials (
        id TEXT PRIMARY KEY,
        host_name TEXT NOT NULL,
        host_type TEXT NOT NULL CHECK(host_type IN ('ollama', 'peek', 'workstation')),
        credential_type TEXT NOT NULL CHECK(credential_type IN ('ssh', 'http_auth', 'windows')),
        label TEXT,
        encrypted_value TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_host_credentials_unique
      ON host_credentials (host_name, host_type, credential_type)`);
    // Copy data back
    for (const cred of existingCreds) {
      db.prepare(`INSERT INTO host_credentials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(cred.id, cred.host_name, cred.host_type, cred.credential_type,
          cred.label, cred.encrypted_value, cred.iv, cred.auth_tag,
          cred.created_at, cred.updated_at);
    }
    db.exec('DROP TABLE host_credentials_backup');
  } catch (e) { logger.debug(`host_credentials constraint migration: ${e.message}`); }

  if (migrated > 0) logger.info(`[Migration] Migrated ${migrated} hosts to workstations table`);
  return { migrated };
}

module.exports = { migrateExistingHostsToWorkstations };
```

- [ ] **Step 4: Wire migration into schema-migrations.js**

Add at the end of `runMigrations()` in `server/db/schema-migrations.js`:

```javascript
  // Phase 2: Migrate existing host data to workstations
  try {
    const { migrateExistingHostsToWorkstations } = require('../workstation/migration');
    migrateExistingHostsToWorkstations(db);
  } catch (e) {
    logger.debug(`Schema migration (workstation data migration): ${e.message}`);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/tests/workstation-integration.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/workstation/migration.js server/db/schema-migrations.js server/tests/workstation-integration.test.js
git commit -m "feat(workstations): migrate existing ollama/peek/agent hosts to workstations table"
```

---

## Chunk 6: Agent Process, Wiring & Seeds

### Task 14: Extend Existing TORQUE Agent with `/probe`, `/certs`, `/peek/*`

**Files:**
- Modify: `agent/index.js` (existing ESM module — already has `/health`, `/run`, `/sync`)

The existing agent at `agent/index.js` uses ESM (`import`/`export`) and already implements:
- `GET /health` — system metrics, load, uptime
- `POST /run` — command execution with NDJSON streaming (with command whitelist + auth)
- `POST /sync` — git clone/pull

We need to add three new endpoints:
- `GET /probe` — one-time full capability detection (GPU, Ollama, peek, build tools, test runners)
- `GET /certs` — return agent's TLS certificate from `~/.torque-agent/certs/`
- `/peek/*` — proxy to local peek_server (port 9876) if running

- [ ] **Step 1: Add `/probe` endpoint to agent**

Add a `handleProbe(req, res)` function that detects capabilities using `execFileSync` (not `execSync` — hardcoded commands only):
- Ollama: HTTP GET to `http://127.0.0.1:11434/api/tags`
- GPU: `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` (Linux) or `wmic path win32_videocontroller get name,adapterram /format:csv` (Windows)
- Peek: HTTP GET to `http://127.0.0.1:9876/`
- Build tools: `execFileSync('which', ['npm'])` etc. (or `where` on Windows)
- Test runners: same pattern for `vitest`, `jest`, `pytest`, `mocha`

Wire into `serverHandleRequest`: `if (req.method === 'GET' && pathname === '/probe')` → `handleProbe(req, res)`

- [ ] **Step 2: Add `/certs` endpoint to agent**

Add a `handleCerts(req, res)` function:
- Read `~/.torque-agent/certs/agent.crt` if it exists
- Return `{ cert: <pem string> }` or 404 with instructions

Wire into `serverHandleRequest`: `if (req.method === 'GET' && pathname === '/certs')` → `handleCerts(req, res)`

- [ ] **Step 3: Add `/peek/*` proxy to agent**

Add a `handlePeekProxy(req, res, url)` function:
- Proxy to `http://127.0.0.1:${PEEK_PORT}/` stripping the `/peek` prefix
- Return 404 if peek_server is not running

Wire into `serverHandleRequest`: `if (pathname.startsWith('/peek/'))` → `handlePeekProxy(req, res, parsedUrl)`

Note: `/probe` and `/certs` should be accessible WITHOUT the `X-Torque-Secret` auth header (they are used during registration before secrets are exchanged). Move the `serverAuthenticate` call below the public endpoint checks.

- [ ] **Step 4: Run existing agent tests**

Run: `npx vitest run agent/ --reporter verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/index.js
git commit -m "feat(workstations): add /probe, /certs, /peek/* endpoints to existing agent"
```

---

### Task 15: Wire Workstation Model into Host Management Init

**Files:**
- Modify: `server/db/host-management.js`

- [ ] **Step 1: Initialize workstation model in setDb**

In `server/db/host-management.js`, add to `setDb()`:

```javascript
  // Initialize workstation model for unified access
  try {
    const wsModel = require('../workstation/model');
    wsModel.setDb(dbInstance);
  } catch (err) {
    logger.debug(`Workstation model init deferred: ${err.message}`);
  }
```

- [ ] **Step 2: Run existing tests to verify no regressions**

Run: `npx vitest run server/tests/db-host-selection.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/db/host-management.js
git commit -m "feat(workstations): wire workstation model into host-management initialization"
```

---

### Task 16: Seed Default Workstation Config

**Files:**
- Modify: `server/db/schema-seeds.js`

- [ ] **Step 1: Add workstation config seeds**

Add to `seedDefaults()` in `server/db/schema-seeds.js`:

```javascript
  // Workstation defaults
  setConfigDefault('workstation_health_check_interval_seconds', '30');
  setConfigDefault('workstation_agent_port', '3460');
  setConfigDefault('workstation_cert_warning_days', '30');
```

- [ ] **Step 2: Commit**

```bash
git add server/db/schema-seeds.js
git commit -m "feat(workstations): seed default workstation config values"
```

---

### Task 17: Handler Tests

**Files:**
- Create: `server/tests/workstation-handlers.test.js`

- [ ] **Step 1: Write handler tests**

```javascript
// server/tests/workstation-handlers.test.js
'use strict';

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');

describe('workstation handlers', () => {
  let db, handleToolCall;
  beforeAll(() => {
    const env = setupTestDb('workstation-handlers');
    db = env.db;
    handleToolCall = env.handleToolCall;
  });
  afterAll(() => teardownTestDb());

  beforeEach(() => {
    rawDb().exec("DELETE FROM workstations");
  });

  it('add_workstation creates a workstation and returns confirmation', async () => {
    const result = await handleToolCall('add_workstation', {
      name: 'test-ws',
      host: '10.0.0.1',
      secret: 'secure-secret-123',
    });
    expect(result.content[0].text).toContain("registered");
    expect(result.content[0].text).toContain("test-ws");
  });

  it('add_workstation rejects missing name', async () => {
    const result = await handleToolCall('add_workstation', { host: '10.0.0.1' });
    expect(result.content[0].text).toContain('Error');
  });

  it('add_workstation rejects duplicate name', async () => {
    await handleToolCall('add_workstation', { name: 'dup', host: '10.0.0.1', secret: 's' });
    const result = await handleToolCall('add_workstation', { name: 'dup', host: '10.0.0.2', secret: 's' });
    expect(result.content[0].text).toContain('already exists');
  });

  it('list_workstations returns empty list initially', async () => {
    const result = await handleToolCall('list_workstations', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(0);
  });

  it('list_workstations returns added workstation', async () => {
    await handleToolCall('add_workstation', { name: 'listed-ws', host: '10.0.0.3', secret: 's' });
    const result = await handleToolCall('list_workstations', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(1);
    expect(data.workstations[0].name).toBe('listed-ws');
  });

  it('remove_workstation by name', async () => {
    await handleToolCall('add_workstation', { name: 'rm-ws', host: '10.0.0.4', secret: 's' });
    const result = await handleToolCall('remove_workstation', { name: 'rm-ws' });
    expect(result.content[0].text).toContain('removed');

    const list = await handleToolCall('list_workstations', {});
    expect(JSON.parse(list.content[0].text).count).toBe(0);
  });

  it('remove_workstation returns not found for missing', async () => {
    const result = await handleToolCall('remove_workstation', { name: 'nonexistent' });
    expect(result.content[0].text).toContain('not found');
  });
});
```

- [ ] **Step 2: Run handler tests**

Run: `npx vitest run server/tests/workstation-handlers.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/tests/workstation-handlers.test.js
git commit -m "test(workstations): handler tests for add, list, remove workstation tools"
```

---

### Task 18: Full Integration Test Suite

**Files:**
- Modify: `server/tests/workstation-integration.test.js`

- [ ] **Step 1: Add adapter compatibility and routing integration tests**

Append to `server/tests/workstation-integration.test.js`:

```javascript
  describe('adapter compatibility', () => {
    it('old add_ollama_host creates workstation record', () => {
      const adapters = require('../workstation/adapters');
      const model = require('../workstation/model');
      adapters.setDb(rawDb());
      model.setDb(rawDb());
      rawDb().exec("DELETE FROM workstations");

      adapters.addOllamaHost({
        name: 'compat-test',
        url: 'http://192.168.1.50:11434',
        memory_limit_mb: 8192,
        max_concurrent: 2,
      });

      const found = model.getWorkstationByName('compat-test');
      expect(found).toBeTruthy();
      expect(found.host).toBe('192.168.1.50');
      expect(found.ollama_port).toBe(11434);
    });
  });

  describe('routing integration', () => {
    it('findWorkstationForTask matches ollama provider', () => {
      const routing = require('../workstation/routing');
      const model = require('../workstation/model');
      routing.setDb(rawDb());
      model.setDb(rawDb());
      rawDb().exec("DELETE FROM workstations");

      const ws = model.createWorkstation({
        name: 'route-test',
        host: '10.0.0.5',
        secret: 's',
        capabilities: JSON.stringify({ ollama: { detected: true } }),
        models_cache: JSON.stringify(['qwen3:8b']),
      });
      model.updateWorkstation(ws.id, { status: 'healthy' });

      const match = routing.findWorkstationForTask({ provider: 'hashline-ollama', model: 'qwen3:8b' });
      expect(match).toBeTruthy();
      expect(match.name).toBe('route-test');
    });
  });

  describe('failover integration', () => {
    it('handleWorkstationDown re-routes queued tasks and fails running tasks', () => {
      const model = require('../workstation/model');
      const failover = require('../workstation/failover');
      model.setDb(rawDb());
      failover.setDb(rawDb());
      rawDb().exec("DELETE FROM workstations");

      const downWs = model.createWorkstation({
        name: 'down-ws',
        host: '10.0.0.20',
        secret: 's',
        capabilities: JSON.stringify({ command_exec: true }),
      });
      model.updateWorkstation(downWs.id, { status: 'down' });

      const backupWs = model.createWorkstation({
        name: 'backup-ws',
        host: '10.0.0.21',
        secret: 's',
        capabilities: JSON.stringify({ command_exec: true }),
      });
      model.updateWorkstation(backupWs.id, { status: 'healthy' });

      const mockTasks = [
        { id: 't1', status: 'queued' },
        { id: 't2', status: 'running' },
      ];
      const updates = {};
      const result = failover.handleWorkstationDown(
        downWs.id,
        () => mockTasks,
        (taskId, upd) => { updates[taskId] = upd; }
      );

      expect(result.rerouted).toBe(1);
      expect(result.failed).toBe(1);
      expect(updates.t1.workstation_id).toBe(backupWs.id);
      expect(updates.t2.status).toBe('failed');
    });
  });
```

- [ ] **Step 2: Run all workstation tests**

Run: `npx vitest run server/tests/workstation-model.test.js server/tests/workstation-integration.test.js --reporter verbose`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run --reporter verbose`
Expected: PASS (no regressions)

- [ ] **Step 4: Commit**

```bash
git add server/tests/workstation-integration.test.js
git commit -m "test(workstations): comprehensive integration tests for adapters, routing, health, and failover"
```

---

## Summary

| Chunk | Tasks | Tests | Description |
|-------|-------|-------|-------------|
| **1** | 1-3 | ~15 unit | Schema, CRUD model (incl. slot reservation), adapter layer |
| **2** | 4-5 | ~6 unit | mTLS cert helpers, probe parser |
| **3** | 6-7 | ~8 unit | Capability routing, failover |
| **4** | 8-11 | ~3 integration | Tool defs, handlers, registration, session notifications |
| **5** | 12-13 | ~4 integration | Unified health checks, data migration, `host_credentials` constraint |
| **6** | 14-18 | ~11 handler+integration | Agent endpoints, wiring, seeds, handler tests, full integration suite |

**Total:** 18 tasks, ~47 tests, 12 new files, 7 modified files

**Phase coverage:**
- **Phase 1** (workstations table + adapters): Chunks 1-4
- **Phase 2** (data migration): Chunk 5, Task 13
- **Phase 3** (consumer migration to direct queries): Future plan — each consumer (`host-selection.js`, `host-monitoring.js`, peek handlers, agent-client) migrated individually to query `workstations` directly, removing adapter indirection
- **Phase 4** (drop old tables): Future plan — after all Phase 3 consumers migrated, remove old tables and adapter layer
