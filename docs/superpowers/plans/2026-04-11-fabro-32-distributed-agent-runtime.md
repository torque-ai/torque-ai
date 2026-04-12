# Fabro #32: Distributed Agent Runtime (AutoGen)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Treat TORQUE workers (provider executors, MCP tool processes, remote agents) as participants in a single distributed agent runtime — one host process, N worker processes communicating over a uniform message contract — instead of three adjacent subsystems with bespoke protocols. Inspired by AutoGen v0.4's host/worker model.

**Architecture:** A new `agent-runtime/` module exposes `runtime.start()` (host) and `runtime.connect(workerSpec)` (worker). Hosts route messages to workers by `agent_id`. Messages are protobuf or JSON envelopes: `{ from, to, type, payload, correlation_id, trace_id }`. Workers register their capabilities (provider name, model, MCP tools, remote agent ID) on connect. The existing remote-agents plugin and MCP tool dispatch layer are wrapped to publish themselves as runtime workers, so they all become discoverable, routable, and replaceable through one address space.

**Tech Stack:** Node.js, WebSocket (or gRPC), better-sqlite3 for worker registry. Builds on plans 14 (events), 31 (activities).

---

## File Structure

**New files:**
- `server/migrations/0NN-runtime-workers.sql`
- `server/agent-runtime/host.js` — runs in main TORQUE process
- `server/agent-runtime/worker-client.js` — used by external workers to connect
- `server/agent-runtime/transport-ws.js` — WebSocket transport
- `server/agent-runtime/registry.js` — known workers, capabilities, last-heartbeat
- `server/agent-runtime/router.js` — route a message to a worker by capability or address
- `server/tests/agent-runtime-host.test.js`
- `server/tests/agent-runtime-router.test.js`

**Modified files:**
- `server/index.js` — start agent-runtime host
- `server/plugins/remote-agents/runner.js` — also register as runtime worker
- `server/handlers/mcp-tools.js` — also expose tools as runtime worker capabilities

---

## Task 1: Migration + registry

- [ ] **Step 1: Migration**

`server/migrations/0NN-runtime-workers.sql`:

```sql
CREATE TABLE IF NOT EXISTS runtime_workers (
  worker_id TEXT PRIMARY KEY,
  display_name TEXT,
  kind TEXT NOT NULL,            -- 'provider' | 'mcp_tool' | 'remote_agent' | 'local'
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  endpoint TEXT,                 -- ws:// URL or 'inline'
  status TEXT NOT NULL DEFAULT 'connected',  -- connected | disconnected | unhealthy
  last_heartbeat_at TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runtime_workers_kind ON runtime_workers(kind);
CREATE INDEX IF NOT EXISTS idx_runtime_workers_status ON runtime_workers(status);
```

- [ ] **Step 2: Registry tests**

Create `server/tests/agent-runtime-host.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createWorkerRegistry } = require('../agent-runtime/registry');

describe('worker registry', () => {
  let db, registry;
  beforeEach(() => {
    db = setupTestDb();
    registry = createWorkerRegistry({ db });
  });

  it('register persists worker with capabilities', () => {
    registry.register({
      workerId: 'w1', kind: 'provider', displayName: 'codex',
      capabilities: ['provider:codex', 'model:gpt-5.3-codex-spark'],
      endpoint: 'inline',
    });
    const got = registry.get('w1');
    expect(got.kind).toBe('provider');
    expect(got.capabilities).toContain('provider:codex');
  });

  it('findByCapability returns workers matching prefix', () => {
    registry.register({ workerId: 'a', kind: 'provider', capabilities: ['provider:codex'], endpoint: 'inline' });
    registry.register({ workerId: 'b', kind: 'provider', capabilities: ['provider:ollama', 'model:qwen3'], endpoint: 'inline' });
    registry.register({ workerId: 'c', kind: 'mcp_tool', capabilities: ['tool:peek_ui'], endpoint: 'inline' });

    const providers = registry.findByCapability('provider:');
    expect(providers.map(w => w.worker_id).sort()).toEqual(['a', 'b']);

    const peek = registry.findByCapability('tool:peek_ui');
    expect(peek.map(w => w.worker_id)).toEqual(['c']);
  });

  it('heartbeat updates last_heartbeat_at and status', () => {
    registry.register({ workerId: 'w1', kind: 'provider', capabilities: [], endpoint: 'inline' });
    registry.markUnhealthy('w1');
    expect(registry.get('w1').status).toBe('unhealthy');
    registry.heartbeat('w1');
    expect(registry.get('w1').status).toBe('connected');
  });

  it('reapStaleWorkers marks workers without recent heartbeat as disconnected', () => {
    registry.register({ workerId: 'fresh', kind: 'provider', capabilities: [], endpoint: 'inline' });
    registry.register({ workerId: 'stale', kind: 'provider', capabilities: [], endpoint: 'inline' });
    registry.heartbeat('fresh');
    db.prepare(`UPDATE runtime_workers SET last_heartbeat_at = datetime('now', '-2 hours') WHERE worker_id = 'stale'`).run();

    const reaped = registry.reapStaleWorkers({ thresholdSeconds: 60 });
    expect(reaped).toContain('stale');
    expect(registry.get('stale').status).toBe('disconnected');
    expect(registry.get('fresh').status).toBe('connected');
  });
});
```

- [ ] **Step 3: Implement registry**

Create `server/agent-runtime/registry.js`:

```js
'use strict';

function createWorkerRegistry({ db }) {
  function register({ workerId, displayName = null, kind, capabilities, endpoint }) {
    db.prepare(`
      INSERT INTO runtime_workers (worker_id, display_name, kind, capabilities_json, endpoint, last_heartbeat_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(worker_id) DO UPDATE SET
        display_name = excluded.display_name,
        kind = excluded.kind,
        capabilities_json = excluded.capabilities_json,
        endpoint = excluded.endpoint,
        status = 'connected',
        last_heartbeat_at = datetime('now')
    `).run(workerId, displayName, kind, JSON.stringify(capabilities || []), endpoint || 'inline');
  }

  function get(workerId) {
    const row = db.prepare('SELECT * FROM runtime_workers WHERE worker_id = ?').get(workerId);
    if (!row) return null;
    return { ...row, capabilities: JSON.parse(row.capabilities_json) };
  }

  function findByCapability(prefix) {
    const rows = db.prepare(`SELECT * FROM runtime_workers WHERE status = 'connected'`).all();
    return rows.filter(r => {
      try { return JSON.parse(r.capabilities_json).some(c => c === prefix || c.startsWith(prefix)); }
      catch { return false; }
    });
  }

  function heartbeat(workerId) {
    db.prepare(`UPDATE runtime_workers SET last_heartbeat_at = datetime('now'), status = 'connected' WHERE worker_id = ?`).run(workerId);
  }

  function markUnhealthy(workerId) {
    db.prepare(`UPDATE runtime_workers SET status = 'unhealthy' WHERE worker_id = ?`).run(workerId);
  }

  function reapStaleWorkers({ thresholdSeconds }) {
    const stale = db.prepare(`
      SELECT worker_id FROM runtime_workers
      WHERE status != 'disconnected'
        AND (julianday('now') - julianday(last_heartbeat_at)) * 86400 > ?
    `).all(thresholdSeconds).map(r => r.worker_id);
    for (const id of stale) {
      db.prepare(`UPDATE runtime_workers SET status = 'disconnected' WHERE worker_id = ?`).run(id);
    }
    return stale;
  }

  return { register, get, findByCapability, heartbeat, markUnhealthy, reapStaleWorkers };
}

module.exports = { createWorkerRegistry };
```

Run tests → PASS. Commit: `feat(runtime): worker registry table + registry module`.

---

## Task 2: Router

- [ ] **Step 1: Tests**

Create `server/tests/agent-runtime-router.test.js`:

```js
'use strict';
const { describe, it, expect, vi, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createWorkerRegistry } = require('../agent-runtime/registry');
const { createRouter } = require('../agent-runtime/router');

describe('runtime router', () => {
  let db, registry, router, sendMock;
  beforeEach(() => {
    db = setupTestDb();
    registry = createWorkerRegistry({ db });
    sendMock = vi.fn(async () => ({ ok: true }));
    router = createRouter({ registry, send: sendMock });
  });

  it('routes by exact worker_id', async () => {
    registry.register({ workerId: 'codex-1', kind: 'provider', capabilities: ['provider:codex'], endpoint: 'inline' });
    await router.dispatch({ to: 'codex-1', type: 'run_prompt', payload: { prompt: 'hi' } });
    expect(sendMock).toHaveBeenCalledWith('codex-1', expect.objectContaining({ type: 'run_prompt' }));
  });

  it('routes by capability when "to" starts with cap:', async () => {
    registry.register({ workerId: 'a', kind: 'provider', capabilities: ['provider:ollama'], endpoint: 'inline' });
    registry.register({ workerId: 'b', kind: 'provider', capabilities: ['provider:ollama'], endpoint: 'inline' });
    await router.dispatch({ to: 'cap:provider:ollama', type: 'run_prompt', payload: {} });
    // Picks one of the matching workers (deterministically — first by id)
    expect(sendMock).toHaveBeenCalledTimes(1);
    const called = sendMock.mock.calls[0][0];
    expect(['a', 'b']).toContain(called);
  });

  it('throws when no worker matches', async () => {
    await expect(router.dispatch({ to: 'cap:provider:nope', type: 'x', payload: {} }))
      .rejects.toThrow(/no worker/i);
  });
});
```

- [ ] **Step 2: Implement router**

Create `server/agent-runtime/router.js`:

```js
'use strict';

function createRouter({ registry, send }) {
  async function dispatch(msg) {
    const target = msg.to;
    if (!target) throw new Error('Message has no "to" field');

    let workerId;
    if (target.startsWith('cap:')) {
      const cap = target.slice('cap:'.length);
      const candidates = registry.findByCapability(cap);
      if (candidates.length === 0) throw new Error(`No worker with capability '${cap}'`);
      workerId = pickRoundRobin(candidates).worker_id;
    } else {
      const w = registry.get(target);
      if (!w || w.status !== 'connected') throw new Error(`Worker '${target}' not connected`);
      workerId = target;
    }
    return send(workerId, msg);
  }

  // Simple deterministic pick: smallest worker_id (stable for tests; replace with weighted later)
  let rrCursor = 0;
  function pickRoundRobin(list) {
    const sorted = [...list].sort((a, b) => a.worker_id.localeCompare(b.worker_id));
    const pick = sorted[rrCursor % sorted.length];
    rrCursor++;
    return pick;
  }

  return { dispatch };
}

module.exports = { createRouter };
```

Run tests → PASS. Commit: `feat(runtime): router with capability + direct addressing`.

---

## Task 3: WebSocket transport + host

- [ ] **Step 1: Implement host**

Create `server/agent-runtime/host.js`:

```js
'use strict';
const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const { createWorkerRegistry } = require('./registry');
const { createRouter } = require('./router');

function createHost({ db, port, logger = console }) {
  const registry = createWorkerRegistry({ db });
  const sockets = new Map();   // worker_id -> ws
  const pending = new Map();   // correlation_id -> {resolve, reject}

  function sendTo(workerId, msg) {
    const ws = sockets.get(workerId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Worker ${workerId} not connected`);
    }
    const correlationId = msg.correlation_id || randomUUID();
    ws.send(JSON.stringify({ ...msg, correlation_id: correlationId }));
    return new Promise((resolve, reject) => {
      pending.set(correlationId, { resolve, reject });
      setTimeout(() => {
        if (pending.has(correlationId)) {
          pending.delete(correlationId);
          reject(new Error(`Timeout waiting for response from ${workerId}`));
        }
      }, msg.timeout_ms || 60000);
    });
  }

  const router = createRouter({ registry, send: sendTo });

  const wss = new WebSocket.Server({ port });
  wss.on('connection', (ws) => {
    let workerId = null;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'register') {
        workerId = msg.worker_id || `w_${randomUUID().slice(0, 8)}`;
        registry.register({
          workerId, kind: msg.kind, displayName: msg.display_name,
          capabilities: msg.capabilities || [], endpoint: 'ws',
        });
        sockets.set(workerId, ws);
        ws.send(JSON.stringify({ type: 'registered', worker_id: workerId }));
        logger.info('worker registered', { workerId, kind: msg.kind });
        return;
      }

      if (msg.type === 'heartbeat' && workerId) {
        registry.heartbeat(workerId);
        return;
      }

      if (msg.type === 'response' && msg.correlation_id) {
        const p = pending.get(msg.correlation_id);
        if (p) {
          pending.delete(msg.correlation_id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.payload);
        }
        return;
      }
    });

    ws.on('close', () => {
      if (workerId) {
        sockets.delete(workerId);
        registry.markUnhealthy(workerId);
        logger.info('worker disconnected', { workerId });
      }
    });
  });

  // Periodic stale reap
  setInterval(() => {
    registry.reapStaleWorkers({ thresholdSeconds: 60 });
  }, 30000);

  return { router, registry, dispatch: router.dispatch.bind(router) };
}

module.exports = { createHost };
```

- [ ] **Step 2: Worker client (for external workers)**

Create `server/agent-runtime/worker-client.js`:

```js
'use strict';
const WebSocket = require('ws');

function createWorkerClient({ url, kind, displayName, capabilities, handlers }) {
  let ws;
  let workerId = null;

  function connect() {
    ws = new WebSocket(url);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'register', kind, display_name: displayName, capabilities }));
    });
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'registered') {
        workerId = msg.worker_id;
        return;
      }
      if (msg.correlation_id && handlers[msg.type]) {
        try {
          const result = await handlers[msg.type](msg.payload);
          ws.send(JSON.stringify({ type: 'response', correlation_id: msg.correlation_id, payload: result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'response', correlation_id: msg.correlation_id, error: err.message }));
        }
      }
    });
    ws.on('close', () => setTimeout(connect, 1000));
  }

  function heartbeat() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat' }));
    }
  }

  connect();
  setInterval(heartbeat, 15000);

  return { get workerId() { return workerId; } };
}

module.exports = { createWorkerClient };
```

Commit: `feat(runtime): WebSocket host + worker client`.

---

## Task 4: Wrap existing call sites as workers

- [ ] **Step 1: Inline provider workers**

In `server/index.js` after the host is created, register existing providers as inline workers (no socket — direct function call):

```js
const host = createHost({ db, port: config.get('runtime_port') || 3461, logger });
defaultContainer.set('agentRuntimeHost', host);

// Register inline workers for built-in providers
const providers = providerRegistry.list(); // ['codex', 'ollama', ...]
for (const p of providers) {
  host.registry.register({
    workerId: `inline:${p}`, kind: 'provider',
    displayName: p, capabilities: [`provider:${p}`], endpoint: 'inline',
  });
}
```

- [ ] **Step 2: Remote agents auto-register**

In `server/plugins/remote-agents/runner.js` when the plugin loads:

```js
const host = defaultContainer.get('agentRuntimeHost');
const agents = listRemoteAgents();
for (const a of agents) {
  host.registry.register({
    workerId: `remote:${a.id}`, kind: 'remote_agent',
    displayName: a.name, capabilities: a.capabilities || [`remote:${a.id}`],
    endpoint: a.endpoint,
  });
}
```

- [ ] **Step 3: REST inspection**

In `server/api/routes/runtime.js`:

```js
'use strict';
const express = require('express');
const router = express.Router();
const { defaultContainer } = require('../../container');

router.get('/workers', (req, res) => {
  const reg = defaultContainer.get('agentRuntimeHost').registry;
  const rows = defaultContainer.get('db').prepare('SELECT * FROM runtime_workers ORDER BY registered_at DESC').all();
  res.json({
    workers: rows.map(r => ({ ...r, capabilities: JSON.parse(r.capabilities_json) })),
  });
});

module.exports = router;
```

`await_restart`. Smoke: start TORQUE, hit `GET /api/runtime/workers` and confirm built-in providers appear as inline workers. Spawn an external test worker via `node test/runtime-worker.js`, confirm it appears in the registry within 1 second.

Commit: `feat(runtime): inline + remote workers register on startup, REST inspection`.
