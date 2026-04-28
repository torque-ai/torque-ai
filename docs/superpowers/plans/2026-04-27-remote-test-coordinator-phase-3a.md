# Remote Test Coordinator — Phase 3a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the workstation coord daemon's live state through TORQUE's existing channels — REST endpoint `/api/coord/active` and MCP tool `coord_status` — so dashboard and Claude/agent sessions can answer "what's the workstation coord daemon doing right now?" without ssh'ing in.

**Architecture:** A small `server/coord/coord-poller.js` shells out to `ssh <host> curl http://127.0.0.1:9395/active` per request (no persistent tunnel — simpler lifecycle, each request is independent). Caches the last successful response for 5 seconds to avoid hammering the workstation when the dashboard polls aggressively. The REST route and the MCP tool both consume the poller; they return the same `{active, reachable, error?, cached_at}` shape.

**Tech Stack:** Node.js (CommonJS), `child_process.spawn` for ssh, vitest, JSON over ssh-curl.

**Source spec:** `docs/superpowers/specs/2026-04-27-remote-test-coordinator-design.md` §5.5 (dashboard mirror — server-side half) + §5.7's "GET /active" endpoint contract.

**Out of scope (separate plans):**
- React dashboard panel (`dashboard/src/components/RemoteCoordPanel.jsx`) — Phase 3b, depends on this plan's REST endpoint shipping first
- Cross-machine wrapper coord (have `bin/torque-remote` ssh-tunnel to the workstation's daemon when running on a dev box) — Phase 3c, different concern

---

## File structure

```
server/coord/
  coord-poller.js              # NEW: getActiveLocks({force?}) — ssh-curl + 5s cache

server/tool-defs/
  coord-defs.js                # NEW: coord_status MCP tool definition

server/tools.js                # MODIFY: register coord-defs in TOOLS aggregate +
                               # add `case 'coord_status'` in handleToolCall switch

server/api/routes/
  coord-routes.js              # NEW: GET /api/coord/active route definition array

server/api/routes.js           # MODIFY: import COORD_ROUTES + concat into the routes
                               # array (mirror the FACTORY_V2_ROUTES pattern)

server/tests/
  coord-poller.test.js         # NEW: spawn mock + 5s cache + reachable=false on error
  coord-status-tool.test.js    # NEW: handleToolCall('coord_status') happy + degrade
  coord-routes.test.js         # NEW: GET /api/coord/active happy + degrade
```

**Workstation host discovery:** the poller reads the same `~/.torque-remote.local.json` (`host` + `user` keys) that `bin/torque-remote` already uses. Falls back to env vars `TORQUE_COORD_REMOTE_HOST` and `TORQUE_COORD_REMOTE_USER`. Returns `{reachable: false, error: 'no_workstation_configured'}` when neither is set — degrades cleanly the same way the wrapper does.

---

## Task 1: Poller module

**Files:**
- Create: `server/coord/coord-poller.js`
- Test: `server/tests/coord-poller.test.js`

The poller is the only part that talks to the workstation. Both the REST and MCP layers go through it.

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-poller.test.js`:

```javascript
'use strict';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

// Test hostnames are intentionally dotless so they don't trigger the
// repo's PII guard's email-pattern matcher when the test source is read.
const HOST_FROM_CFG = 'cfgworkstation';
const USER_FROM_CFG = 'cfguser';
const HOST_FROM_ENV = 'envworkstation';
const USER_FROM_ENV = 'envuser';

describe('coord-poller', () => {
  let tmpHome;
  let originalSpawn;
  let spawnCalls;

  beforeEach(() => {
    delete require.cache[require.resolve('../coord/coord-poller')];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-poller-home-'));
    spawnCalls = [];
    originalSpawn = child_process.spawn;
    child_process.spawn = vi.fn((cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      const { EventEmitter } = require('events');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('{"active":[]}'));
        proc.emit('close', 0);
      });
      return proc;
    });
  });

  afterEach(() => {
    child_process.spawn = originalSpawn;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeConfig(host, user) {
    fs.writeFileSync(path.join(tmpHome, '.torque-remote.local.json'),
      JSON.stringify({ host, user, default_project_path: 'C:\\\\x' }));
  }

  it('returns {reachable:false, error:"no_workstation_configured"} when neither config nor env is set', async () => {
    const { getActiveLocks } = require('../coord/coord-poller');
    const result = await getActiveLocks({ home: tmpHome, env: {} });
    expect(result.reachable).toBe(false);
    expect(result.error).toBe('no_workstation_configured');
    expect(result.active).toEqual([]);
    expect(spawnCalls).toHaveLength(0);
  });

  it('reads host/user from ~/.torque-remote.local.json and ssh-curls /active', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    const { getActiveLocks } = require('../coord/coord-poller');
    const result = await getActiveLocks({ home: tmpHome, env: {} });
    expect(result.reachable).toBe(true);
    expect(result.active).toEqual([]);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe('ssh');
    const argsJoined = spawnCalls[0].args.join(' ');
    expect(argsJoined).toContain(USER_FROM_CFG);
    expect(argsJoined).toContain(HOST_FROM_CFG);
    expect(argsJoined).toContain('http://127.0.0.1:9395/active');
  });

  it('env vars override the config file', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    const env = { TORQUE_COORD_REMOTE_HOST: HOST_FROM_ENV, TORQUE_COORD_REMOTE_USER: USER_FROM_ENV };
    const { getActiveLocks } = require('../coord/coord-poller');
    await getActiveLocks({ home: tmpHome, env });
    const argsJoined = spawnCalls[0].args.join(' ');
    expect(argsJoined).toContain(USER_FROM_ENV);
    expect(argsJoined).toContain(HOST_FROM_ENV);
    expect(argsJoined).not.toContain(USER_FROM_CFG);
    expect(argsJoined).not.toContain(HOST_FROM_CFG);
  });

  it('caches the last successful response for 5 seconds', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    const { getActiveLocks } = require('../coord/coord-poller');
    await getActiveLocks({ home: tmpHome, env: {} });
    await getActiveLocks({ home: tmpHome, env: {} });
    await getActiveLocks({ home: tmpHome, env: {} });
    expect(spawnCalls).toHaveLength(1);
  });

  it('force:true bypasses the cache', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    const { getActiveLocks } = require('../coord/coord-poller');
    await getActiveLocks({ home: tmpHome, env: {} });
    await getActiveLocks({ home: tmpHome, env: {}, force: true });
    expect(spawnCalls).toHaveLength(2);
  });

  it('returns {reachable:false} when ssh exits non-zero', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    child_process.spawn = vi.fn(() => {
      const { EventEmitter } = require('events');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => {
        proc.stderr.emit('data', Buffer.from('ssh: connect to host timed out'));
        proc.emit('close', 255);
      });
      return proc;
    });
    const { getActiveLocks } = require('../coord/coord-poller');
    const result = await getActiveLocks({ home: tmpHome, env: {} });
    expect(result.reachable).toBe(false);
    expect(result.error).toContain('ssh');
    expect(result.active).toEqual([]);
  });

  it('returns {reachable:false, error:"invalid_json"} when ssh-curl yields non-JSON', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    child_process.spawn = vi.fn(() => {
      const { EventEmitter } = require('events');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('curl: (7) Failed to connect to 127.0.0.1 port 9395'));
        proc.emit('close', 0);
      });
      return proc;
    });
    const { getActiveLocks } = require('../coord/coord-poller');
    const result = await getActiveLocks({ home: tmpHome, env: {} });
    expect(result.reachable).toBe(false);
    expect(result.error).toBe('invalid_json');
  });

  it('honors a 5s ssh timeout (kills the spawn after that long)', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    let killedProc = null;
    child_process.spawn = vi.fn(() => {
      const { EventEmitter } = require('events');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn(() => { killedProc = proc; proc.emit('close', null); });
      return proc;
    });
    const { getActiveLocks } = require('../coord/coord-poller');
    const result = await getActiveLocks({ home: tmpHome, env: {}, timeout_ms: 50 });
    expect(killedProc).not.toBeNull();
    expect(result.reachable).toBe(false);
    expect(result.error).toBe('timeout');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-poller.test.js`

Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

Create `server/coord/coord-poller.js`:

```javascript
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CACHE_TTL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 5000;
const REMOTE_URL = 'http://127.0.0.1:9395/active';

let _cache = { at: 0, value: null };

function resolveTarget({ home, env }) {
  const fromEnv = (env && env.TORQUE_COORD_REMOTE_HOST && env.TORQUE_COORD_REMOTE_USER)
    ? { host: env.TORQUE_COORD_REMOTE_HOST, user: env.TORQUE_COORD_REMOTE_USER }
    : null;
  if (fromEnv) return fromEnv;
  const cfgPath = path.join(home, '.torque-remote.local.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg && cfg.host && cfg.user) return { host: cfg.host, user: cfg.user };
  } catch (_e) { /* fall through */ }
  return null;
}

function runSshCurl(target, timeout_ms) {
  return new Promise((resolve) => {
    const args = [
      '-o', 'ConnectTimeout=2',
      '-o', 'StrictHostKeyChecking=accept-new',
      `${target.user}@${target.host}`,
      'curl', '-s', '--max-time', '3', REMOTE_URL,
    ];
    let stdout = '';
    let stderr = '';
    let settled = false;
    const proc = spawn('ssh', args, { windowsHide: true });
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch (_e) { /* best effort */ }
      resolve({ ok: false, error: 'timeout' });
    }, timeout_ms);
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const reason = stderr.trim().slice(-200) || `ssh_exit_${code}`;
        return resolve({ ok: false, error: reason });
      }
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch (_e) { return resolve({ ok: false, error: 'invalid_json' }); }
      resolve({ ok: true, body: parsed });
    });
  });
}

async function getActiveLocks(opts = {}) {
  const home = opts.home || require('os').homedir();
  const env = opts.env || process.env;
  const timeout_ms = opts.timeout_ms || DEFAULT_TIMEOUT_MS;
  const force = opts.force === true;
  const now = Date.now();

  if (!force && _cache.value && now - _cache.at < CACHE_TTL_MS) {
    return { ..._cache.value, served_from_cache: true };
  }

  const target = resolveTarget({ home, env });
  if (!target) {
    return {
      active: [],
      reachable: false,
      error: 'no_workstation_configured',
      cached_at: new Date(now).toISOString(),
    };
  }

  const result = await runSshCurl(target, timeout_ms);
  let value;
  if (!result.ok) {
    value = {
      active: [],
      reachable: false,
      error: result.error,
      cached_at: new Date(now).toISOString(),
    };
  } else {
    value = {
      active: Array.isArray(result.body && result.body.active) ? result.body.active : [],
      reachable: true,
      cached_at: new Date(now).toISOString(),
    };
  }
  _cache = { at: now, value };
  return value;
}

function _resetCacheForTests() {
  _cache = { at: 0, value: null };
}

module.exports = { getActiveLocks, _resetCacheForTests };
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-poller.test.js`

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/coord/coord-poller.js server/tests/coord-poller.test.js
git commit -m "feat(coord): coord-poller module — ssh-curl /active with 5s cache and timeout"
```

---

## Task 2: REST endpoint `/api/coord/active`

**Files:**
- Create: `server/api/routes/coord-routes.js`
- Modify: `server/api/routes.js`
- Test: `server/tests/coord-routes.test.js`

The REST endpoint is a thin pass-through to the poller. Following the FACTORY_V2_ROUTES pattern, we declare an array of route definitions and register them in `routes.js`.

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-routes.test.js`:

```javascript
'use strict';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const http = require('http');

describe('GET /api/coord/active', () => {
  let server, port;

  beforeEach(async () => {
    delete require.cache[require.resolve('../coord/coord-poller')];
    require.cache[require.resolve('../coord/coord-poller')] = {
      exports: {
        getActiveLocks: vi.fn(async () => ({
          active: [{
            lock_id: 'abc123',
            project: 'torque-public',
            sha: 'deadbeef',
            suite: 'gate',
            holder: { host: 'omenhost', pid: 1, user: 'k' },
            created_at: '2026-04-27T12:00:00.000Z',
            last_heartbeat_at: '2026-04-27T12:01:00.000Z',
          }],
          reachable: true,
          cached_at: '2026-04-27T12:01:30.000Z',
        })),
      },
    };
    const { COORD_ROUTES } = require('../api/routes/coord-routes');
    server = http.createServer((req, res) => {
      const route = COORD_ROUTES.find(r => r.method === req.method && r.path === req.url);
      if (!route) { res.writeHead(404).end(); return; }
      route.handler(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    delete require.cache[require.resolve('../coord/coord-poller')];
    delete require.cache[require.resolve('../api/routes/coord-routes')];
  });

  function get(urlPath) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }));
      }).on('error', reject);
    });
  }

  it('returns 200 with the poller payload (active + reachable + cached_at)', async () => {
    const res = await get('/api/coord/active');
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(true);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.active[0]).toMatchObject({
      project: 'torque-public', sha: 'deadbeef', suite: 'gate',
    });
    expect(res.body.cached_at).toBeDefined();
  });

  it('returns 200 with reachable:false when poller reports unreachable', async () => {
    const cordPoller = require('../coord/coord-poller');
    cordPoller.getActiveLocks = vi.fn(async () => ({
      active: [],
      reachable: false,
      error: 'no_workstation_configured',
      cached_at: '2026-04-27T12:00:00.000Z',
    }));
    const res = await get('/api/coord/active');
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(false);
    expect(res.body.error).toBe('no_workstation_configured');
    expect(res.body.active).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-routes.test.js`

Expected: FAIL — module missing.

- [ ] **Step 3: Write the route module**

Create `server/api/routes/coord-routes.js`:

```javascript
'use strict';

const COORD_ROUTES = [
  {
    method: 'GET',
    path: '/api/coord/active',
    handler: async (_req, res) => {
      const { getActiveLocks } = require('../../coord/coord-poller');
      let payload;
      try {
        payload = await getActiveLocks();
      } catch (err) {
        payload = {
          active: [],
          reachable: false,
          error: `poller_threw: ${err && err.message ? err.message : 'unknown'}`,
          cached_at: new Date().toISOString(),
        };
      }
      const body = JSON.stringify(payload);
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    },
  },
];

module.exports = { COORD_ROUTES };
```

- [ ] **Step 4: Wire COORD_ROUTES into the main routes array**

In `server/api/routes.js`, find where other route modules get composed (search for `FACTORY_V2_ROUTES` — that's the closest precedent; the file requires `./routes/factory-routes` and concatenates its exported array). Add the same pattern for COORD_ROUTES.

Concretely:

```javascript
// Near other route-module requires:
const { COORD_ROUTES } = require('./routes/coord-routes');
```

```javascript
// Wherever the final routes array is composed, concat COORD_ROUTES into it.
//   ...existingRoutes,
//   ...COORD_ROUTES,
```

If `server/api/routes.js`'s structure is incompatible with this (e.g., the array is exported by something other than `module.exports = [...]`), look at exactly how FACTORY_V2_ROUTES is wired in and copy that pattern verbatim. Don't invent a new dispatch shape.

- [ ] **Step 5: Run test — verify it passes**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-routes.test.js`

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/api/routes/coord-routes.js server/api/routes.js server/tests/coord-routes.test.js
git commit -m "feat(coord): GET /api/coord/active REST endpoint via coord-poller"
```

---

## Task 3: MCP tool `coord_status`

**Files:**
- Create: `server/tool-defs/coord-defs.js`
- Modify: `server/tools.js`
- Test: `server/tests/coord-status-tool.test.js`

The MCP tool is the second consumer of the poller. Pattern matches `ping` (defined in `server/tool-defs/core-defs.js`, dispatched in `server/tools.js`'s `handleToolCall` switch starting around `case 'ping'`).

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-status-tool.test.js`:

```javascript
'use strict';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('coord_status MCP tool', () => {
  beforeEach(() => {
    delete require.cache[require.resolve('../coord/coord-poller')];
    delete require.cache[require.resolve('../tools')];
  });

  afterEach(() => {
    delete require.cache[require.resolve('../coord/coord-poller')];
    delete require.cache[require.resolve('../tools')];
  });

  it('returns the poller payload as MCP content text (JSON-stringified)', async () => {
    require.cache[require.resolve('../coord/coord-poller')] = {
      exports: {
        getActiveLocks: vi.fn(async () => ({
          active: [{
            lock_id: 'abc123',
            project: 'torque-public',
            sha: 'deadbeef',
            suite: 'gate',
            holder: { host: 'omenhost', pid: 1, user: 'k' },
            created_at: '2026-04-27T12:00:00.000Z',
            last_heartbeat_at: '2026-04-27T12:01:00.000Z',
          }],
          reachable: true,
          cached_at: '2026-04-27T12:01:30.000Z',
        })),
      },
    };
    const { handleToolCall } = require('../tools');
    const result = await handleToolCall('coord_status', {});
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const payload = JSON.parse(result.content[0].text);
    expect(payload.reachable).toBe(true);
    expect(payload.active).toHaveLength(1);
    expect(payload.active[0].project).toBe('torque-public');
  });

  it('returns reachable:false when poller reports unreachable (still success — not an MCP error)', async () => {
    require.cache[require.resolve('../coord/coord-poller')] = {
      exports: {
        getActiveLocks: vi.fn(async () => ({
          active: [],
          reachable: false,
          error: 'no_workstation_configured',
          cached_at: '2026-04-27T12:00:00.000Z',
        })),
      },
    };
    const { handleToolCall } = require('../tools');
    const result = await handleToolCall('coord_status', {});
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.reachable).toBe(false);
    expect(payload.error).toBe('no_workstation_configured');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-status-tool.test.js`

Expected: FAIL — `handleToolCall('coord_status', ...)` falls through the switch and returns a "tool not found" error or hits the default branch.

- [ ] **Step 3: Add the tool definition**

Create `server/tool-defs/coord-defs.js`:

```javascript
'use strict';

const tools = [
  {
    name: 'coord_status',
    description: 'Query the workstation Remote Test Coordinator daemon for the current set of active locks. Returns {active:[{lock_id, project, sha, suite, holder, created_at, last_heartbeat_at}], reachable:true|false, error?:string, cached_at}. Use this to see whether tests are currently running on the workstation, who holds the lock, and how long they have held it. Cached for 5s; the response shape is identical to the GET /api/coord/active REST endpoint.',
    inputSchema: { type: 'object', properties: {} },
  },
];

module.exports = { tools };
```

- [ ] **Step 4: Wire coord-defs into the aggregate TOOLS list**

In `server/tools.js`, find where `core-defs.js` is required (search for `core-defs`). Add a parallel require for `coord-defs.js` and concat its `tools` array into the same TOOLS aggregate.

If the existing pattern is:

```javascript
const coreDefs = require('./tool-defs/core-defs');
const TOOLS = [...coreDefs.tools, ...]; // possibly more concat'd here
```

Then add:

```javascript
const coordDefs = require('./tool-defs/coord-defs');
const TOOLS = [...coreDefs.tools, ...coordDefs.tools, ...]; // existing ones too
```

If the structure is different, follow whatever pattern `core-defs` uses verbatim. Do NOT introduce a new tool-defs aggregation pattern.

- [ ] **Step 5: Add the dispatch case**

In `server/tools.js`, find the `handleToolCall` function (it has a switch starting around `case 'ping'` near line 747). Add a new case BEFORE the `default:` arm:

```javascript
    case 'coord_status': {
      const { getActiveLocks } = require('./coord/coord-poller');
      const payload = await getActiveLocks();
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
```

- [ ] **Step 6: Run test — verify it passes**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-status-tool.test.js`

Expected: 2 tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/tool-defs/coord-defs.js server/tools.js server/tests/coord-status-tool.test.js
git commit -m "feat(coord): coord_status MCP tool exposes workstation /active to agents"
```

---

## Task 4: Cutover

**Files:** none new — git operation + workstation refresh.

- [ ] **Step 1: Run the full coord test sweep as final pre-flight**

```bash
cd server && node node_modules/vitest/vitest.mjs run \
  tests/coord-config.test.js \
  tests/coord-state.test.js \
  tests/coord-state-persistence.test.js \
  tests/coord-result-store.test.js \
  tests/coord-reaper.test.js \
  tests/coord-http.test.js \
  tests/coord-integration.test.js \
  tests/coord-client-cli.test.js \
  tests/coord-torque-remote-integration.test.js \
  tests/coord-lock-hashes.test.js \
  tests/coord-poller.test.js \
  tests/coord-routes.test.js \
  tests/coord-status-tool.test.js \
  tests/pre-push-hook-staging.test.js
```

Expected: all pass (existing + new tests from this plan).

- [ ] **Step 2: Run cutover from the main checkout**

From the main checkout (parent of the worktree):

```bash
scripts/worktree-cutover.sh remote-test-coord-phase3a
```

The cutover script merges, drains TORQUE, restarts. Be ready for a `scripts/pre-push-hook` conflict if main has refactored the gate again — same playbook as Phases 1 + 2.

- [ ] **Step 3: Verify the new endpoint and tool from the dev box**

After TORQUE restarts on the new code:

```bash
curl -s http://127.0.0.1:3457/api/coord/active | head -1
# Expect: {"active":[],"reachable":true,"cached_at":"..."} or with active locks if any are live
```

The MCP tool ships automatically via TORQUE's normal tool registry — no additional install. Claude/Codex sessions in this repo will see `coord_status` in the next progressive-tool unlock.

- [ ] **Step 4: Sync user-level bin (no changes this phase, but confirm idempotency)**

This phase doesn't touch `bin/torque-remote` or `bin/torque-coord-client`, so the user-level copies need no refresh. Confirm via:

```bash
md5sum <repo>/bin/torque-coord-client <user-bin>/torque-coord-client
```

(Replace `<repo>` and `<user-bin>` with your local paths.) If the hashes differ, copy the repo version into `<user-bin>` to keep them in sync — the wrapper invokes the user-bin client by PATH.

---

## Spec coverage check

| Spec section | Implementing task |
|---|---|
| §5.5 Phase 3 dashboard mirror — server-side observability (REST `/api/coord/active`, MCP `coord_status`) | Tasks 2 + 3 |
| §5.5 SSH tunnel from dev-box TORQUE to workstation daemon | Task 1 (ssh-curl-per-request, simpler than persistent tunnel) |
| §5.5 5-second poll interval | Task 1 (5s in-process cache; the dashboard poller's network rate is independent) |
| §5.5 React `RemoteCoordPanel.jsx` | **Phase 3b** (separate plan, depends on this REST endpoint shipping) |
| Cross-machine wrapper coord (wrapper ssh-tunnels to workstation daemon when running on a dev box) | **Phase 3c** (separate plan, leverages this tunnel infra but modifies `bin/torque-remote`) |

**Phase 3a explicitly excludes:**
- React panel — separate plan; depends on the REST endpoint from this plan being live
- Persistent SSH tunnel (in-process bidirectional) — would shave ~500ms per request; revisit if dashboard needs sub-second refresh
- Cross-machine wrapper coord — different concern, modifies a different file (`bin/torque-remote`)
- Authentication/authorization on `/api/coord/active` — daemon binds to localhost; access control is whatever protects TORQUE's API surface generally

These are each 1-task follow-ups when their value justifies the work.
