# Model Freshness Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a notify-only monitor that detects when locally-pulled Ollama model tags have a newer build available in the official Ollama registry. Auto-seeds the watchlist from registered hosts, scans daily, emits events via the existing notification queue.

**Architecture:** New plugin at `server/plugins/model-freshness/`. Stores state in two SQLite tables (`model_watchlist`, `model_freshness_events`). Scanner compares local `/api/tags` digest against `HEAD registry.ollama.ai/v2/library/<family>/manifests/<tag>` → `ollama-content-digest` header. Scheduled via TORQUE's existing `schedule_task` infrastructure. Exposes 5 MCP tools. Loaded by default via `DEFAULT_PLUGIN_NAMES`.

**Tech Stack:** Node.js + vitest. Uses `better-sqlite3` (already in TORQUE) for storage, `fetch` (native) for registry HEAD requests. Follows the existing plugin contract (`server/plugins/plugin-contract.js`) with required `name`, `version`, `install`, `uninstall`, `middleware`, `mcpTools`, `eventHandlers`, `configSchema`.

**Spec:** `docs/superpowers/specs/2026-04-19-model-freshness-monitor-design.md` in this worktree.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `server/plugins/model-freshness/index.js` | **Create** | Plugin entry: schema, install/uninstall, DI wiring, scheduled-task registration |
| `server/plugins/model-freshness/watchlist-store.js` | **Create** | CRUD for `model_watchlist` table |
| `server/plugins/model-freshness/events-store.js` | **Create** | CRUD for `model_freshness_events` table |
| `server/plugins/model-freshness/registry-client.js` | **Create** | `HEAD registry.ollama.ai/v2/library/<family>/manifests/<tag>` → digest |
| `server/plugins/model-freshness/scanner.js` | **Create** | Orchestrates: local digest ← hosts, remote digest ← registry, diff, emit events |
| `server/plugins/model-freshness/auto-seed.js` | **Create** | Reads `listOllamaHosts` × `/api/tags`, seeds watchlist |
| `server/plugins/model-freshness/handlers.js` | **Create** | MCP tool handlers (5 tools) |
| `server/plugins/model-freshness/tool-defs.js` | **Create** | MCP tool definitions (input schemas) |
| `server/plugins/model-freshness/tests/watchlist-store.test.js` | **Create** | Unit tests |
| `server/plugins/model-freshness/tests/events-store.test.js` | **Create** | Unit tests |
| `server/plugins/model-freshness/tests/registry-client.test.js` | **Create** | Unit tests (mocked fetch) |
| `server/plugins/model-freshness/tests/scanner.test.js` | **Create** | Integration tests |
| `server/plugins/model-freshness/tests/auto-seed.test.js` | **Create** | Integration tests |
| `server/plugins/model-freshness/tests/handlers.test.js` | **Create** | MCP handler tests |
| `server/plugins/model-freshness/tests/plugin-contract.test.js` | **Create** | Contract-validation test |
| `server/index.js` | **Modify** | Add `'model-freshness'` to `DEFAULT_PLUGIN_NAMES` (currently line ~58) |
| `server/tool-annotations.js` | **Modify** | Add annotations for the 5 new MCP tools |
| `docs/guides/model-freshness.md` | **Create** | User guide: what it does, how to use it, how to disable |

---

## Note on SQLite schema setup

All schema-init code in this plan uses `db.prepare(SQL).run()` (single-statement form). Each schema constant holds one CREATE TABLE statement without a trailing semicolon — idiomatic for better-sqlite3's prepared-statement cache and consistent with the `version-control` plugin's `ensureSchema` pattern.

---

## Phase 1 — Storage layer

### Task 1: Watchlist store (schema + CRUD)

**Files:**
- Create: `server/plugins/model-freshness/watchlist-store.js`
- Create: `server/plugins/model-freshness/tests/watchlist-store.test.js`

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS model_watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family TEXT NOT NULL,
  tag TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,         -- 'auto-seed' | 'user' | 'leaderboard' (reserved)
  added_at TEXT NOT NULL,
  last_local_digest TEXT,
  last_scanned_at TEXT,
  UNIQUE(family, tag)
)
```

- [ ] **Step 1.1: Write failing test**

Create `server/plugins/model-freshness/tests/watchlist-store.test.js`:

```js
'use strict';

const { describe, it, expect, beforeEach } = require('vitest');
const Database = require('better-sqlite3');
const { createWatchlistStore, WATCHLIST_SCHEMA } = require('../watchlist-store');

describe('watchlist-store', () => {
  let db;
  let store;

  beforeEach(() => {
    db = new Database(':memory:');
    db.prepare(WATCHLIST_SCHEMA).run();
    store = createWatchlistStore(db);
  });

  it('adds a new entry with source=user', () => {
    const id = store.add({ family: 'qwen3-coder', tag: '30b', source: 'user' });
    expect(id).toBeGreaterThan(0);
    const row = store.getByFamilyTag('qwen3-coder', '30b');
    expect(row.source).toBe('user');
    expect(row.active).toBe(1);
  });

  it('upsert is idempotent — same family:tag returns existing row', () => {
    const a = store.add({ family: 'qwen3-coder', tag: '30b', source: 'auto-seed' });
    const b = store.add({ family: 'qwen3-coder', tag: '30b', source: 'user' });
    expect(a).toBe(b);
    // source does not overwrite on re-add
    expect(store.getByFamilyTag('qwen3-coder', '30b').source).toBe('auto-seed');
  });

  it('listActive returns only rows where active=1', () => {
    store.add({ family: 'a', tag: 'b', source: 'user' });
    store.add({ family: 'c', tag: 'd', source: 'user' });
    store.deactivate('a', 'b');
    const active = store.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].family).toBe('c');
  });

  it('deactivate marks active=0 without deleting', () => {
    store.add({ family: 'x', tag: 'y', source: 'user' });
    store.deactivate('x', 'y');
    const row = store.getByFamilyTag('x', 'y');
    expect(row.active).toBe(0);
  });

  it('recordScan updates last_local_digest and last_scanned_at', () => {
    store.add({ family: 'q', tag: 'r', source: 'user' });
    store.recordScan('q', 'r', 'digest-abc');
    const row = store.getByFamilyTag('q', 'r');
    expect(row.last_local_digest).toBe('digest-abc');
    expect(row.last_scanned_at).toBeTruthy();
  });
});
```

- [ ] **Step 1.2: Run failing test**

```bash
cd server && npx vitest run plugins/model-freshness/tests/watchlist-store.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 1.3: Implement the store**

Create `server/plugins/model-freshness/watchlist-store.js`:

```js
'use strict';

const WATCHLIST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS model_watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    family TEXT NOT NULL,
    tag TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL,
    added_at TEXT NOT NULL,
    last_local_digest TEXT,
    last_scanned_at TEXT,
    UNIQUE(family, tag)
  )
`;

function createWatchlistStore(db) {
  return {
    add({ family, tag, source }) {
      const existing = db.prepare(
        'SELECT id FROM model_watchlist WHERE family = ? AND tag = ?',
      ).get(family, tag);
      if (existing) return existing.id;
      const res = db.prepare(
        'INSERT INTO model_watchlist (family, tag, active, source, added_at) VALUES (?, ?, 1, ?, ?)',
      ).run(family, tag, source, new Date().toISOString());
      return res.lastInsertRowid;
    },

    getByFamilyTag(family, tag) {
      return db.prepare(
        'SELECT * FROM model_watchlist WHERE family = ? AND tag = ?',
      ).get(family, tag);
    },

    listActive() {
      return db.prepare(
        'SELECT * FROM model_watchlist WHERE active = 1 ORDER BY family, tag',
      ).all();
    },

    listAll() {
      return db.prepare(
        'SELECT * FROM model_watchlist ORDER BY family, tag',
      ).all();
    },

    deactivate(family, tag) {
      db.prepare(
        'UPDATE model_watchlist SET active = 0 WHERE family = ? AND tag = ?',
      ).run(family, tag);
    },

    recordScan(family, tag, localDigest) {
      db.prepare(
        'UPDATE model_watchlist SET last_local_digest = ?, last_scanned_at = ? WHERE family = ? AND tag = ?',
      ).run(localDigest, new Date().toISOString(), family, tag);
    },
  };
}

module.exports = { createWatchlistStore, WATCHLIST_SCHEMA };
```

- [ ] **Step 1.4: Run tests**

```bash
cd server && npx vitest run plugins/model-freshness/tests/watchlist-store.test.js
```

Expected: all 5 tests PASS.

- [ ] **Step 1.5: Commit**

```bash
git add server/plugins/model-freshness/watchlist-store.js server/plugins/model-freshness/tests/watchlist-store.test.js
git commit -m "feat(model-freshness): watchlist-store CRUD

Adds model_watchlist schema + add/get/list/deactivate/recordScan.
Upsert-by-(family,tag) with soft-delete via active flag. Source tag
distinguishes auto-seed vs user-added entries."
```

### Task 2: Events store (schema + CRUD)

**Files:**
- Create: `server/plugins/model-freshness/events-store.js`
- Create: `server/plugins/model-freshness/tests/events-store.test.js`

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS model_freshness_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family TEXT NOT NULL,
  tag TEXT NOT NULL,
  old_digest TEXT,
  new_digest TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT
)
```

- [ ] **Step 2.1: Write failing test**

Create `server/plugins/model-freshness/tests/events-store.test.js`:

```js
'use strict';

const { describe, it, expect, beforeEach } = require('vitest');
const Database = require('better-sqlite3');
const { createEventsStore, EVENTS_SCHEMA } = require('../events-store');

describe('events-store', () => {
  let db, store;

  beforeEach(() => {
    db = new Database(':memory:');
    db.prepare(EVENTS_SCHEMA).run();
    store = createEventsStore(db);
  });

  it('insert returns new event id', () => {
    const id = store.insert({
      family: 'qwen3-coder', tag: '30b',
      oldDigest: 'old', newDigest: 'new',
    });
    expect(id).toBeGreaterThan(0);
  });

  it('listPending returns only unacknowledged events', () => {
    const a = store.insert({ family: 'x', tag: 'y', oldDigest: 'o1', newDigest: 'n1' });
    store.insert({ family: 'a', tag: 'b', oldDigest: 'o2', newDigest: 'n2' });
    store.acknowledge(a, 'tester');
    const pending = store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].family).toBe('a');
  });

  it('listAll returns every event including acknowledged', () => {
    const a = store.insert({ family: 'x', tag: 'y', oldDigest: 'o', newDigest: 'n' });
    store.acknowledge(a, 'user');
    expect(store.listAll()).toHaveLength(1);
  });

  it('acknowledge sets acknowledged_at and acknowledged_by', () => {
    const id = store.insert({ family: 'x', tag: 'y', oldDigest: 'o', newDigest: 'n' });
    store.acknowledge(id, 'alice');
    const row = store.getById(id);
    expect(row.acknowledged_by).toBe('alice');
    expect(row.acknowledged_at).toBeTruthy();
  });

  it('insert with null oldDigest succeeds (first-seen case)', () => {
    const id = store.insert({ family: 'x', tag: 'y', oldDigest: null, newDigest: 'n' });
    expect(id).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2.2: Run — confirm fail**

```bash
cd server && npx vitest run plugins/model-freshness/tests/events-store.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 2.3: Implement the store**

Create `server/plugins/model-freshness/events-store.js`:

```js
'use strict';

const EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS model_freshness_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    family TEXT NOT NULL,
    tag TEXT NOT NULL,
    old_digest TEXT,
    new_digest TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    acknowledged_at TEXT,
    acknowledged_by TEXT
  )
`;

function createEventsStore(db) {
  return {
    insert({ family, tag, oldDigest, newDigest }) {
      const res = db.prepare(
        'INSERT INTO model_freshness_events (family, tag, old_digest, new_digest, detected_at) VALUES (?, ?, ?, ?, ?)',
      ).run(family, tag, oldDigest, newDigest, new Date().toISOString());
      return res.lastInsertRowid;
    },

    getById(id) {
      return db.prepare('SELECT * FROM model_freshness_events WHERE id = ?').get(id);
    },

    listPending() {
      return db.prepare(
        'SELECT * FROM model_freshness_events WHERE acknowledged_at IS NULL ORDER BY detected_at DESC',
      ).all();
    },

    listAll() {
      return db.prepare('SELECT * FROM model_freshness_events ORDER BY detected_at DESC').all();
    },

    acknowledge(id, who) {
      db.prepare(
        'UPDATE model_freshness_events SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?',
      ).run(new Date().toISOString(), who, id);
    },
  };
}

module.exports = { createEventsStore, EVENTS_SCHEMA };
```

- [ ] **Step 2.4: Run tests; commit**

```bash
cd server && npx vitest run plugins/model-freshness/tests/events-store.test.js
git add server/plugins/model-freshness/events-store.js server/plugins/model-freshness/tests/events-store.test.js
git commit -m "feat(model-freshness): events-store CRUD

Adds model_freshness_events schema + insert/getById/listPending/listAll/
acknowledge. Pending = acknowledged_at IS NULL. Acknowledge records
who cleared the event."
```

---

## Phase 2 — Registry client

### Task 3: Registry HEAD client

**Files:**
- Create: `server/plugins/model-freshness/registry-client.js`
- Create: `server/plugins/model-freshness/tests/registry-client.test.js`

**Context:** HEAD request to `https://registry.ollama.ai/v2/library/<family>/manifests/<tag>`. The response carries `ollama-content-digest` header with the manifest digest. A verified live example:

```
HEAD /v2/library/qwen3-coder/manifests/30b
→ 200 OK
  ollama-content-digest: 06c1097efce0431c2045fe7b2e5108366e43bee1b4603a7aded8f21689e90bca
```

- [ ] **Step 3.1: Write failing test**

Create `server/plugins/model-freshness/tests/registry-client.test.js`:

```js
'use strict';

const { describe, it, expect, vi, afterEach } = require('vitest');
const { fetchRemoteDigest, REGISTRY_BASE } = require('../registry-client');

afterEach(() => vi.restoreAllMocks());

describe('registry-client.fetchRemoteDigest', () => {
  it('returns the ollama-content-digest header on 200', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['ollama-content-digest', 'abcdef123']]),
    });
    const digest = await fetchRemoteDigest('qwen3-coder', '30b');
    expect(digest).toBe('abcdef123');
  });

  it('returns null on 404 (model removed from registry)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Map(),
    });
    expect(await fetchRemoteDigest('nonexistent', 'tag')).toBeNull();
  });

  it('throws on 5xx so caller can retry later', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Map(),
    });
    await expect(fetchRemoteDigest('f', 't')).rejects.toThrow(/503/);
  });

  it('throws on network failure', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ENOTFOUND'));
    await expect(fetchRemoteDigest('f', 't')).rejects.toThrow(/ENOTFOUND/);
  });

  it('issues a HEAD request', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: new Map([['ollama-content-digest', 'x']]),
    });
    await fetchRemoteDigest('qwen3-coder', '30b');
    const callArgs = spy.mock.calls[0];
    expect(callArgs[0]).toBe(`${REGISTRY_BASE}/v2/library/qwen3-coder/manifests/30b`);
    expect(callArgs[1].method).toBe('HEAD');
  });
});
```

- [ ] **Step 3.2: Run — confirm failure**

```bash
cd server && npx vitest run plugins/model-freshness/tests/registry-client.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement the client**

Create `server/plugins/model-freshness/registry-client.js`:

```js
'use strict';

const REGISTRY_BASE = 'https://registry.ollama.ai';

async function fetchRemoteDigest(family, tag, { timeoutMs = 10000 } = {}) {
  const url = `${REGISTRY_BASE}/v2/library/${encodeURIComponent(family)}/manifests/${encodeURIComponent(tag)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'HEAD', signal: controller.signal });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`registry.ollama.ai returned ${resp.status} for ${family}:${tag}`);
    }
    const digest = resp.headers.get
      ? resp.headers.get('ollama-content-digest')
      : resp.headers['ollama-content-digest'];
    return digest || null;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { fetchRemoteDigest, REGISTRY_BASE };
```

- [ ] **Step 3.4: Run tests; commit**

```bash
cd server && npx vitest run plugins/model-freshness/tests/registry-client.test.js
git add server/plugins/model-freshness/registry-client.js server/plugins/model-freshness/tests/registry-client.test.js
git commit -m "feat(model-freshness): registry HEAD client

Issues HEAD to registry.ollama.ai/v2/library/<family>/manifests/<tag>
and reads the ollama-content-digest header. Returns null on 404
(removed from registry), throws on 5xx and network errors so the
scanner can retry on next schedule."
```

---

## Phase 3 — Scanner and auto-seed

### Task 4: Scanner — orchestrate local ↔ remote digest diff

**Files:**
- Create: `server/plugins/model-freshness/scanner.js`
- Create: `server/plugins/model-freshness/tests/scanner.test.js`

**Context:** For each active watchlist row: find the local digest by querying each host's `/api/tags`, fetch the remote digest via the registry client, insert an event if they differ. Rows whose model is no longer installed on any host get `active = 0`.

- [ ] **Step 4.1: Write failing test**

Create `server/plugins/model-freshness/tests/scanner.test.js`:

```js
'use strict';

const { describe, it, expect, vi, afterEach } = require('vitest');
const Database = require('better-sqlite3');
const { createScanner } = require('../scanner');
const { createWatchlistStore, WATCHLIST_SCHEMA } = require('../watchlist-store');
const { createEventsStore, EVENTS_SCHEMA } = require('../events-store');

afterEach(() => vi.restoreAllMocks());

function freshDb() {
  const db = new Database(':memory:');
  db.prepare(WATCHLIST_SCHEMA).run();
  db.prepare(EVENTS_SCHEMA).run();
  return db;
}

describe('scanner.runScan', () => {
  it('emits an event when remote digest differs from local', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const events = createEventsStore(db);

    watchlist.add({ family: 'qwen3-coder', tag: '30b', source: 'user' });
    watchlist.recordScan('qwen3-coder', '30b', 'digest-old');

    const fetchLocalDigest = vi.fn().mockResolvedValue('digest-old');
    const fetchRemoteDigest = vi.fn().mockResolvedValue('digest-new');
    const listHosts = vi.fn().mockReturnValue([{ id: 'h1' }]);
    const notify = vi.fn();

    const scanner = createScanner({ watchlist, events, fetchLocalDigest, fetchRemoteDigest, listHosts, notify });
    const result = await scanner.runScan();

    expect(result.eventsEmitted).toBe(1);
    expect(events.listPending()).toHaveLength(1);
    expect(events.listPending()[0].new_digest).toBe('digest-new');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('emits no event when digests match', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const events = createEventsStore(db);

    watchlist.add({ family: 'q', tag: 'r', source: 'user' });
    watchlist.recordScan('q', 'r', 'same-digest');

    const scanner = createScanner({
      watchlist, events,
      fetchLocalDigest: vi.fn().mockResolvedValue('same-digest'),
      fetchRemoteDigest: vi.fn().mockResolvedValue('same-digest'),
      listHosts: vi.fn().mockReturnValue([{ id: 'h1' }]),
      notify: vi.fn(),
    });

    await scanner.runScan();
    expect(events.listPending()).toHaveLength(0);
  });

  it('deactivates rows whose model is no longer installed on any host', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const events = createEventsStore(db);

    watchlist.add({ family: 'orphan', tag: 'v1', source: 'auto-seed' });

    const scanner = createScanner({
      watchlist, events,
      fetchLocalDigest: vi.fn().mockResolvedValue(null), // not found locally
      fetchRemoteDigest: vi.fn(),
      listHosts: vi.fn().mockReturnValue([{ id: 'h1' }]),
      notify: vi.fn(),
    });

    await scanner.runScan();
    const row = watchlist.getByFamilyTag('orphan', 'v1');
    expect(row.active).toBe(0);
  });

  it('tolerates registry failure on one family without killing the whole scan', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const events = createEventsStore(db);

    watchlist.add({ family: 'a', tag: 'b', source: 'user' });
    watchlist.recordScan('a', 'b', 'local-a');
    watchlist.add({ family: 'c', tag: 'd', source: 'user' });
    watchlist.recordScan('c', 'd', 'local-c');

    const scanner = createScanner({
      watchlist, events,
      fetchLocalDigest: vi.fn().mockImplementation(async (f) => (f === 'a' ? 'local-a' : 'local-c')),
      fetchRemoteDigest: vi.fn().mockImplementation(async (f) => {
        if (f === 'a') throw new Error('registry 503');
        return 'remote-c-new';
      }),
      listHosts: vi.fn().mockReturnValue([{ id: 'h1' }]),
      notify: vi.fn(),
    });

    const result = await scanner.runScan();
    expect(result.errors).toHaveLength(1);
    expect(result.eventsEmitted).toBe(1); // family c still emits
  });
});
```

- [ ] **Step 4.2: Run — confirm failure**

Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement the scanner**

Create `server/plugins/model-freshness/scanner.js`:

```js
'use strict';

function createScanner({ watchlist, events, fetchLocalDigest, fetchRemoteDigest, listHosts, notify }) {
  async function runScan() {
    const rows = watchlist.listActive();
    const hosts = listHosts() || [];
    let eventsEmitted = 0;
    const errors = [];

    for (const row of rows) {
      try {
        let localDigest = null;
        for (const host of hosts) {
          const digest = await fetchLocalDigest(row.family, row.tag, host);
          if (digest) { localDigest = digest; break; }
        }
        if (!localDigest) {
          watchlist.deactivate(row.family, row.tag);
          continue;
        }

        const remoteDigest = await fetchRemoteDigest(row.family, row.tag);
        if (!remoteDigest) continue; // registry 404 — skip

        if (remoteDigest !== localDigest) {
          events.insert({
            family: row.family, tag: row.tag,
            oldDigest: localDigest, newDigest: remoteDigest,
          });
          eventsEmitted += 1;
          if (typeof notify === 'function') {
            await notify({
              type: 'model_drift',
              family: row.family,
              tag: row.tag,
              old_digest: localDigest,
              new_digest: remoteDigest,
              detected_at: new Date().toISOString(),
              suggestion: `Run 'ollama pull ${row.family}:${row.tag}' to update.`,
            });
          }
        }

        watchlist.recordScan(row.family, row.tag, localDigest);
      } catch (err) {
        errors.push({ family: row.family, tag: row.tag, error: err.message });
      }

      await new Promise(r => setTimeout(r, 500)); // polite to registry
    }

    return { rowsScanned: rows.length, eventsEmitted, errors };
  }

  return { runScan };
}

module.exports = { createScanner };
```

- [ ] **Step 4.4: Run tests; commit**

```bash
cd server && npx vitest run plugins/model-freshness/tests/scanner.test.js
git add server/plugins/model-freshness/scanner.js server/plugins/model-freshness/tests/scanner.test.js
git commit -m "feat(model-freshness): scanner orchestrates digest diff

For each active watchlist row: find local digest across hosts, HEAD
the registry for remote digest, emit an event on mismatch. Deactivates
orphaned rows, tolerates per-row errors, polite 500ms spacing."
```

### Task 5: Auto-seed from registered hosts

**Files:**
- Create: `server/plugins/model-freshness/auto-seed.js`
- Create: `server/plugins/model-freshness/tests/auto-seed.test.js`

- [ ] **Step 5.1: Failing test**

Create `server/plugins/model-freshness/tests/auto-seed.test.js`:

```js
'use strict';

const { describe, it, expect, vi, afterEach } = require('vitest');
const Database = require('better-sqlite3');
const { createAutoSeed } = require('../auto-seed');
const { createWatchlistStore, WATCHLIST_SCHEMA } = require('../watchlist-store');

afterEach(() => vi.restoreAllMocks());

function freshDb() {
  const db = new Database(':memory:');
  db.prepare(WATCHLIST_SCHEMA).run();
  return db;
}

describe('auto-seed.seedFromHosts', () => {
  it('inserts one row per family:tag discovered on any host', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const listHosts = vi.fn().mockReturnValue([
      { id: 'h1', url: 'http://host-a.test:11434' },
      { id: 'h2', url: 'http://host-b.test:11434' },
    ]);
    const fetchTags = vi.fn().mockImplementation(async (url) => {
      if (url.includes('host-a')) return ['qwen3-coder:30b', 'gemma4:latest'];
      return ['qwen3.5:latest', 'gemma4:latest']; // overlap with host-a
    });

    const seed = createAutoSeed({ watchlist, listHosts, fetchTags });
    const result = await seed.seedFromHosts();

    expect(result.added).toBe(3); // qwen3-coder:30b, gemma4:latest, qwen3.5:latest
    const rows = watchlist.listAll();
    expect(rows.map(r => `${r.family}:${r.tag}`).sort())
      .toEqual(['gemma4:latest', 'qwen3-coder:30b', 'qwen3.5:latest']);
    rows.forEach(r => expect(r.source).toBe('auto-seed'));
  });

  it('skips *-cloud tags', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const seed = createAutoSeed({
      watchlist,
      listHosts: vi.fn().mockReturnValue([{ id: 'h1', url: 'http://host-a.test:11434' }]),
      fetchTags: vi.fn().mockResolvedValue(['qwen3-coder:480b-cloud', 'qwen3-coder:30b']),
    });
    await seed.seedFromHosts();
    const rows = watchlist.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].tag).toBe('30b');
  });

  it('is idempotent — second run adds zero', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const seed = createAutoSeed({
      watchlist,
      listHosts: vi.fn().mockReturnValue([{ id: 'h1', url: 'http://host-a.test:11434' }]),
      fetchTags: vi.fn().mockResolvedValue(['qwen3-coder:30b']),
    });
    const r1 = await seed.seedFromHosts();
    const r2 = await seed.seedFromHosts();
    expect(r1.added).toBe(1);
    expect(r2.added).toBe(0);
  });

  it('tolerates an unreachable host', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const seed = createAutoSeed({
      watchlist,
      listHosts: vi.fn().mockReturnValue([
        { id: 'h1', url: 'http://host-a.test:11434' },
        { id: 'h2', url: 'http://host-b.test:11434' },
      ]),
      fetchTags: vi.fn().mockImplementation(async (url) => {
        if (url.includes('host-a')) throw new Error('ECONNREFUSED');
        return ['qwen3.5:latest'];
      }),
    });
    const r = await seed.seedFromHosts();
    expect(r.added).toBe(1);
  });
});
```

- [ ] **Step 5.2: Run — confirm failure**

Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement auto-seed**

Create `server/plugins/model-freshness/auto-seed.js`:

```js
'use strict';

function parseFamilyTag(modelName) {
  const trimmed = String(modelName || '').trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf(':');
  if (idx === -1) return null;
  const family = trimmed.slice(0, idx);
  const tag = trimmed.slice(idx + 1);
  if (!family || !tag) return null;
  return { family, tag };
}

function createAutoSeed({ watchlist, listHosts, fetchTags }) {
  async function seedFromHosts() {
    const hosts = listHosts() || [];
    const seen = new Set();
    let added = 0;

    for (const host of hosts) {
      const url = String(host.url || '').trim();
      if (!url) continue;
      let tags = [];
      try {
        tags = await fetchTags(url) || [];
      } catch {
        continue; // unreachable host — skip
      }
      for (const name of tags) {
        if (name.endsWith('-cloud')) continue;
        const parsed = parseFamilyTag(name);
        if (!parsed) continue;
        const key = `${parsed.family}:${parsed.tag}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const existed = !!watchlist.getByFamilyTag(parsed.family, parsed.tag);
        watchlist.add({ family: parsed.family, tag: parsed.tag, source: 'auto-seed' });
        if (!existed) added += 1;
      }
    }

    return { added, seen: seen.size };
  }

  return { seedFromHosts, parseFamilyTag };
}

module.exports = { createAutoSeed };
```

- [ ] **Step 5.4: Run tests; commit**

```bash
cd server && npx vitest run plugins/model-freshness/tests/auto-seed.test.js
git add server/plugins/model-freshness/auto-seed.js server/plugins/model-freshness/tests/auto-seed.test.js
git commit -m "feat(model-freshness): auto-seed from registered hosts

Reads every host's model list via injected fetchTags, splits on ':',
skips *-cloud tags, dedupes across hosts. Idempotent (re-run adds 0)
and tolerant of unreachable hosts."
```

---

## Phase 4 — MCP tools

### Task 6: MCP tool defs + handlers

**Files:**
- Create: `server/plugins/model-freshness/tool-defs.js`
- Create: `server/plugins/model-freshness/handlers.js`
- Create: `server/plugins/model-freshness/tests/handlers.test.js`

**Tools:**
1. `model_watchlist_list` — show watchlist
2. `model_watchlist_add { family, tag }` — user-add
3. `model_watchlist_remove { family, tag }` — soft-delete
4. `model_freshness_scan_now` — run scan synchronously
5. `model_freshness_events { include_acknowledged? }` — list events

- [ ] **Step 6.1: Write failing handler tests**

Create `server/plugins/model-freshness/tests/handlers.test.js`:

```js
'use strict';

const { describe, it, expect, vi } = require('vitest');
const Database = require('better-sqlite3');
const { createHandlers } = require('../handlers');
const { createWatchlistStore, WATCHLIST_SCHEMA } = require('../watchlist-store');
const { createEventsStore, EVENTS_SCHEMA } = require('../events-store');

function freshSetup() {
  const db = new Database(':memory:');
  db.prepare(WATCHLIST_SCHEMA).run();
  db.prepare(EVENTS_SCHEMA).run();
  const watchlist = createWatchlistStore(db);
  const events = createEventsStore(db);
  const scanner = { runScan: vi.fn().mockResolvedValue({ rowsScanned: 2, eventsEmitted: 0, errors: [] }) };
  const handlers = createHandlers({ watchlist, events, scanner });
  return { handlers, watchlist, events, scanner };
}

describe('model_watchlist_add', () => {
  it('creates an entry with source=user', async () => {
    const { handlers, watchlist } = freshSetup();
    const res = await handlers.model_watchlist_add({ family: 'qwen3-coder', tag: '30b' });
    expect(res.added).toBe(true);
    expect(watchlist.getByFamilyTag('qwen3-coder', '30b').source).toBe('user');
  });

  it('rejects missing family', async () => {
    const { handlers } = freshSetup();
    await expect(handlers.model_watchlist_add({ tag: '30b' })).rejects.toThrow(/family/);
  });
});

describe('model_watchlist_remove', () => {
  it('deactivates an existing entry', async () => {
    const { handlers, watchlist } = freshSetup();
    await handlers.model_watchlist_add({ family: 'x', tag: 'y' });
    await handlers.model_watchlist_remove({ family: 'x', tag: 'y' });
    expect(watchlist.getByFamilyTag('x', 'y').active).toBe(0);
  });
});

describe('model_watchlist_list', () => {
  it('returns only active entries by default', async () => {
    const { handlers } = freshSetup();
    await handlers.model_watchlist_add({ family: 'a', tag: 'b' });
    await handlers.model_watchlist_add({ family: 'c', tag: 'd' });
    await handlers.model_watchlist_remove({ family: 'a', tag: 'b' });
    const res = await handlers.model_watchlist_list({});
    expect(res.items).toHaveLength(1);
    expect(res.items[0].family).toBe('c');
  });
});

describe('model_freshness_scan_now', () => {
  it('invokes scanner.runScan and returns the result', async () => {
    const { handlers, scanner } = freshSetup();
    const res = await handlers.model_freshness_scan_now({});
    expect(scanner.runScan).toHaveBeenCalled();
    expect(res.rowsScanned).toBe(2);
  });
});

describe('model_freshness_events', () => {
  it('returns only pending events by default', async () => {
    const { handlers, events } = freshSetup();
    events.insert({ family: 'x', tag: 'y', oldDigest: 'o', newDigest: 'n' });
    const id = events.insert({ family: 'a', tag: 'b', oldDigest: 'o', newDigest: 'n' });
    events.acknowledge(id, 'me');
    const res = await handlers.model_freshness_events({});
    expect(res.events).toHaveLength(1);
    expect(res.events[0].family).toBe('x');
  });

  it('returns all events when include_acknowledged=true', async () => {
    const { handlers, events } = freshSetup();
    const id = events.insert({ family: 'x', tag: 'y', oldDigest: 'o', newDigest: 'n' });
    events.acknowledge(id, 'me');
    const res = await handlers.model_freshness_events({ include_acknowledged: true });
    expect(res.events).toHaveLength(1);
  });
});
```

- [ ] **Step 6.2: Run — confirm failure**

```bash
cd server && npx vitest run plugins/model-freshness/tests/handlers.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 6.3: Implement tool-defs and handlers**

Create `server/plugins/model-freshness/tool-defs.js`:

```js
'use strict';

module.exports = [
  {
    name: 'model_watchlist_list',
    description: 'List active (or all) entries on the model freshness watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        include_inactive: { type: 'boolean', description: 'Include deactivated entries.' },
      },
    },
  },
  {
    name: 'model_watchlist_add',
    description: 'Add a model family:tag to the freshness watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', description: 'Model family, e.g. qwen3-coder.' },
        tag: { type: 'string', description: 'Model tag, e.g. 30b.' },
      },
      required: ['family', 'tag'],
    },
  },
  {
    name: 'model_watchlist_remove',
    description: 'Soft-delete an entry from the freshness watchlist (preserves history).',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string' },
        tag: { type: 'string' },
      },
      required: ['family', 'tag'],
    },
  },
  {
    name: 'model_freshness_scan_now',
    description: 'Run a freshness scan synchronously and return pending events.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'model_freshness_events',
    description: 'List pending freshness events. Set include_acknowledged=true for full history.',
    inputSchema: {
      type: 'object',
      properties: {
        include_acknowledged: { type: 'boolean' },
      },
    },
  },
];
```

Create `server/plugins/model-freshness/handlers.js`:

```js
'use strict';

function createHandlers({ watchlist, events, scanner }) {
  return {
    async model_watchlist_list({ include_inactive = false } = {}) {
      const items = include_inactive ? watchlist.listAll() : watchlist.listActive();
      return { items };
    },

    async model_watchlist_add({ family, tag } = {}) {
      if (!family || typeof family !== 'string') throw new Error('family is required');
      if (!tag || typeof tag !== 'string') throw new Error('tag is required');
      const existed = !!watchlist.getByFamilyTag(family, tag);
      watchlist.add({ family, tag, source: 'user' });
      return { added: !existed, family, tag };
    },

    async model_watchlist_remove({ family, tag } = {}) {
      if (!family || !tag) throw new Error('family and tag are required');
      watchlist.deactivate(family, tag);
      return { removed: true, family, tag };
    },

    async model_freshness_scan_now() {
      return await scanner.runScan();
    },

    async model_freshness_events({ include_acknowledged = false } = {}) {
      const events_ = include_acknowledged ? events.listAll() : events.listPending();
      return { events: events_ };
    },
  };
}

module.exports = { createHandlers };
```

- [ ] **Step 6.4: Run tests; commit**

```bash
cd server && npx vitest run plugins/model-freshness/tests/handlers.test.js
git add server/plugins/model-freshness/tool-defs.js server/plugins/model-freshness/handlers.js server/plugins/model-freshness/tests/handlers.test.js
git commit -m "feat(model-freshness): MCP tools (5) + handlers

model_watchlist_list / add / remove, model_freshness_scan_now, and
model_freshness_events. Handlers validate required inputs, delegate to
stores and scanner. Tool defs use JSON schema; wiring happens in the
plugin index."
```

---

## Phase 5 — Plugin entry + integration

### Task 7: Plugin index with install/uninstall/contract wiring

**Files:**
- Create: `server/plugins/model-freshness/index.js`
- Create: `server/plugins/model-freshness/tests/plugin-contract.test.js`

**Context:** Wires all the modules together and exposes the plugin object per the contract defined in `server/plugins/plugin-contract.js` (required fields: `name`, `version`, `install`, `uninstall`, `middleware`, `mcpTools`, `eventHandlers`, `configSchema`).

- [ ] **Step 7.1: Write failing contract test**

Create `server/plugins/model-freshness/tests/plugin-contract.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { validatePlugin } = require('../../plugin-contract');
const createPlugin = require('../index');

describe('model-freshness plugin contract', () => {
  it('satisfies the required fields', () => {
    const plugin = createPlugin();
    const { valid, errors } = validatePlugin(plugin);
    expect(valid).toBe(true);
    if (!valid) console.log(errors);
    expect(plugin.name).toBe('model-freshness');
    expect(typeof plugin.version).toBe('string');
  });

  it('mcpTools() returns the 5 tool defs', () => {
    const plugin = createPlugin();
    const tools = plugin.mcpTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'model_freshness_events',
      'model_freshness_scan_now',
      'model_watchlist_add',
      'model_watchlist_list',
      'model_watchlist_remove',
    ]);
  });
});
```

- [ ] **Step 7.2: Run — confirm failure**

Expected: FAIL — module not found.

- [ ] **Step 7.3: Implement the plugin index**

Create `server/plugins/model-freshness/index.js`:

```js
'use strict';

const toolDefs = require('./tool-defs');
const { createWatchlistStore, WATCHLIST_SCHEMA } = require('./watchlist-store');
const { createEventsStore, EVENTS_SCHEMA } = require('./events-store');
const { fetchRemoteDigest } = require('./registry-client');
const { createScanner } = require('./scanner');
const { createAutoSeed } = require('./auto-seed');
const { createHandlers } = require('./handlers');

const PLUGIN_NAME = 'model-freshness';
const PLUGIN_VERSION = '1.0.0';

function getContainerService(container, name) {
  if (!container || typeof container.get !== 'function') return null;
  try { return container.get(name); } catch { return null; }
}

function resolveRawDb(dbService) {
  const raw = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);
  if (!raw || typeof raw.prepare !== 'function') {
    throw new Error('model-freshness requires db service with prepare()');
  }
  return raw;
}

function ensureSchema(rawDb) {
  rawDb.prepare(WATCHLIST_SCHEMA).run();
  rawDb.prepare(EVENTS_SCHEMA).run();
}

async function fetchTagsFromHost(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: controller.signal });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data?.models) ? data.models.map(m => m.name).filter(Boolean) : [];
  } finally {
    clearTimeout(t);
  }
}

async function fetchLocalDigestFromHost(family, tag, host) {
  try {
    const url = String(host.url || '').replace(/\/$/, '');
    if (!url) return null;
    const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    const match = (data?.models || []).find(m => m.name === `${family}:${tag}`);
    return match?.digest || null;
  } catch {
    return null;
  }
}

function createPlugin() {
  let handlers = null;
  let installed = false;

  function install(container) {
    let dbService = getContainerService(container, 'db');
    if (!dbService) {
      try { dbService = require('../../database'); } catch {}
    }
    const rawDb = resolveRawDb(dbService);
    ensureSchema(rawDb);

    const watchlist = createWatchlistStore(rawDb);
    const events = createEventsStore(rawDb);

    let listHosts;
    try {
      const hostMgmt = require('../../db/host-management');
      listHosts = () => hostMgmt.listOllamaHosts({ enabled: true }) || [];
    } catch {
      listHosts = () => [];
    }

    const notifier = getContainerService(container, 'notifier');
    const notify = notifier && typeof notifier.push === 'function'
      ? (evt) => notifier.push(evt)
      : () => {};

    const scanner = createScanner({
      watchlist, events,
      fetchLocalDigest: fetchLocalDigestFromHost,
      fetchRemoteDigest,
      listHosts,
      notify,
    });

    const autoSeed = createAutoSeed({
      watchlist, listHosts, fetchTags: fetchTagsFromHost,
    });

    // Best-effort initial seed
    autoSeed.seedFromHosts().catch(() => {});

    handlers = createHandlers({ watchlist, events, scanner });
    installed = true;
  }

  function uninstall() { installed = false; handlers = null; }

  function middleware() { return []; }

  function mcpTools() { return toolDefs; }

  function mcpHandlers() { return handlers || {}; }

  function eventHandlers() { return {}; }

  function configSchema() {
    return {
      type: 'object',
      properties: {
        scan_hour_local: { type: 'integer', minimum: 0, maximum: 23, default: 3 },
      },
    };
  }

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    install, uninstall, middleware, mcpTools, mcpHandlers, eventHandlers, configSchema,
  };
}

module.exports = createPlugin;
```

- [ ] **Step 7.4: Run tests; commit**

```bash
cd server && npx vitest run plugins/model-freshness/tests/plugin-contract.test.js
git add server/plugins/model-freshness/index.js server/plugins/model-freshness/tests/plugin-contract.test.js
git commit -m "feat(model-freshness): plugin entry + contract wiring

Wires watchlist, events, scanner, auto-seed, handlers. install()
resolves container DB + host-management + notifier, runs schema,
triggers a best-effort initial auto-seed. Satisfies the plugin
contract (name, version, install/uninstall/middleware/mcpTools/
eventHandlers/configSchema)."
```

### Task 8: Load plugin by default

**Files:**
- Modify: `server/index.js` at ~line 58 — add `'model-freshness'` to `DEFAULT_PLUGIN_NAMES`
- Create: `server/tests/model-freshness-load.test.js` — verify plugin loads at startup

- [ ] **Step 8.1: Failing test**

Create `server/tests/model-freshness-load.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');

describe('DEFAULT_PLUGIN_NAMES', () => {
  it('includes model-freshness', () => {
    const src = require('fs').readFileSync(require.resolve('../index.js'), 'utf8');
    expect(src).toMatch(/DEFAULT_PLUGIN_NAMES.*model-freshness/s);
  });
});
```

- [ ] **Step 8.2: Run — confirm failure**

```bash
cd server && npx vitest run tests/model-freshness-load.test.js
```

Expected: FAIL.

- [ ] **Step 8.3: Update DEFAULT_PLUGIN_NAMES**

In `server/index.js`, find the line:

```js
const DEFAULT_PLUGIN_NAMES = Object.freeze(['snapscope', 'version-control', 'remote-agents']);
```

Change to:

```js
const DEFAULT_PLUGIN_NAMES = Object.freeze(['snapscope', 'version-control', 'remote-agents', 'model-freshness']);
```

- [ ] **Step 8.4: Run tests; commit**

```bash
cd server && npx vitest run tests/model-freshness-load.test.js
git add server/index.js server/tests/model-freshness-load.test.js
git commit -m "feat(model-freshness): load plugin by default

Adds 'model-freshness' to DEFAULT_PLUGIN_NAMES so the plugin loads
automatically on server startup. Users can disable by removing the
entry and restarting."
```

### Task 9: Tool annotations

**Files:**
- Modify: `server/tool-annotations.js` — add annotations for the 5 new tools
- Create: `server/tests/model-freshness-tool-annotations.test.js`

**Context:** Per `feedback_centralized_tool_annotations.md`, all MCP tools need entries in `server/tool-annotations.js`. Annotations describe read-only vs. mutation, risk level, default visibility tier, etc.

- [ ] **Step 9.1: Failing test**

Create `server/tests/model-freshness-tool-annotations.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { TOOL_ANNOTATIONS } = require('../tool-annotations');

describe('model-freshness — tool annotations', () => {
  it.each([
    'model_watchlist_list',
    'model_watchlist_add',
    'model_watchlist_remove',
    'model_freshness_scan_now',
    'model_freshness_events',
  ])('%s is annotated', (name) => {
    expect(TOOL_ANNOTATIONS[name]).toBeDefined();
    expect(TOOL_ANNOTATIONS[name].title || TOOL_ANNOTATIONS[name].description).toBeTruthy();
  });

  it('list operations are read-only', () => {
    expect(TOOL_ANNOTATIONS['model_watchlist_list'].readOnlyHint).toBe(true);
    expect(TOOL_ANNOTATIONS['model_freshness_events'].readOnlyHint).toBe(true);
  });

  it('mutation operations are not read-only', () => {
    expect(TOOL_ANNOTATIONS['model_watchlist_add'].readOnlyHint).toBe(false);
    expect(TOOL_ANNOTATIONS['model_watchlist_remove'].readOnlyHint).toBe(false);
  });
});
```

- [ ] **Step 9.2: Run — confirm failure**

Expected: FAIL — entries not present.

- [ ] **Step 9.3: Add annotations**

Preflight — locate the annotations map (should be an exported object `TOOL_ANNOTATIONS`):

```bash
grep -n "TOOL_ANNOTATIONS" server/tool-annotations.js | head -5
```

Add five entries (inside the object):

```js
  model_watchlist_list: {
    title: 'Model watchlist (list)',
    readOnlyHint: true,
    destructiveHint: false,
    description: 'List families/tags being monitored for drift.',
  },
  model_watchlist_add: {
    title: 'Model watchlist (add)',
    readOnlyHint: false,
    destructiveHint: false,
    description: 'Track a new model family:tag for freshness.',
  },
  model_watchlist_remove: {
    title: 'Model watchlist (remove)',
    readOnlyHint: false,
    destructiveHint: false,
    description: 'Soft-delete a watchlist entry.',
  },
  model_freshness_scan_now: {
    title: 'Freshness scan (manual)',
    readOnlyHint: false,
    destructiveHint: false,
    description: 'Run the freshness scan synchronously and return pending events.',
  },
  model_freshness_events: {
    title: 'Freshness events',
    readOnlyHint: true,
    destructiveHint: false,
    description: 'List pending (or all) model drift events.',
  },
```

- [ ] **Step 9.4: Run tests; commit**

```bash
cd server && npx vitest run tests/model-freshness-tool-annotations.test.js
git add server/tool-annotations.js server/tests/model-freshness-tool-annotations.test.js
git commit -m "feat(model-freshness): centralized tool annotations

Adds readOnlyHint/destructiveHint/description for the 5 new tools.
Required by TORQUE's centralized annotations registry."
```

---

## Phase 6 — Scheduled scan

### Task 10: Register daily scheduled scan on install

**Files:**
- Modify: `server/plugins/model-freshness/index.js` — in `install()`, schedule daily scan via TORQUE's `schedule_task` infrastructure
- Create: `server/plugins/model-freshness/tests/schedule-registration.test.js`

**Context:** Use the existing scheduling primitive, not a plugin-local cron. The scheduled task invokes `model_freshness_scan_now` at 03:00 local time (configurable via `config.scan_hour_local`).

**Preflight — inspect the schedule_task API:**

```bash
grep -n "function scheduleTask\|exports.scheduleTask\|schedule_task" server/handlers/scheduling-handlers.js server/db/scheduler.js
```

(The exact export name and signature may be `scheduleTask` or similar. Use what you find; pattern below shows the intent.)

- [ ] **Step 10.1: Failing test**

Create `server/plugins/model-freshness/tests/schedule-registration.test.js`:

```js
'use strict';

const { describe, it, expect, vi } = require('vitest');
const path = require('path');

describe('model-freshness install — scheduled scan', () => {
  it('registers a daily scheduled task that targets model_freshness_scan_now', async () => {
    const scheduleCalls = [];
    // Mock the scheduler module before requiring the plugin factory
    vi.doMock(path.resolve(__dirname, '..', '..', '..', 'db', 'scheduler.js'), () => ({
      scheduleTask: (spec) => { scheduleCalls.push(spec); return { id: 'sch-1' }; },
    }));

    const createPlugin = require('../index');
    const plugin = createPlugin();
    plugin.install({ get: () => null });

    const scan = scheduleCalls.find(s =>
      (s.tool_name === 'model_freshness_scan_now') || (s.description || '').includes('model_freshness_scan_now')
    );
    expect(scan).toBeDefined();
    expect(scan.cron || scan.schedule || scan.at).toBeTruthy();
  });
});
```

- [ ] **Step 10.2: Run — confirm failure**

Expected: FAIL — install() doesn't call the scheduler.

- [ ] **Step 10.3: Add scheduler call to install()**

In `server/plugins/model-freshness/index.js`, extend `install()`:

```js
    // After handlers/autoSeed setup, register daily scan
    try {
      const scheduler = require('../../db/scheduler');
      if (scheduler && typeof scheduler.scheduleTask === 'function') {
        const hour = (container && container.config?.scan_hour_local) || 3;
        scheduler.scheduleTask({
          name: 'model-freshness-daily-scan',
          description: 'Daily drift scan: model_freshness_scan_now',
          tool_name: 'model_freshness_scan_now',
          cron: `0 ${hour} * * *`,   // 03:00 local daily
          source: 'plugin:model-freshness',
        });
      }
    } catch {
      // scheduler not available — auto-seed still runs, manual scans still work
    }
```

(If the actual scheduler API differs from `scheduleTask({...})` — use the exact API surfaced by the preflight grep above. The test should be adjusted to match.)

- [ ] **Step 10.4: Run tests; commit**

```bash
cd server && npx vitest run plugins/model-freshness/tests/schedule-registration.test.js
git add server/plugins/model-freshness/index.js server/plugins/model-freshness/tests/schedule-registration.test.js
git commit -m "feat(model-freshness): schedule daily scan on install

Registers a daily cron task via TORQUE's scheduler that invokes
model_freshness_scan_now at 03:00 local time (configurable via
config.scan_hour_local). Idempotent by scheduled-task name; safe to
reinstall."
```

---

## Phase 7 — Documentation

### Task 11: User guide

**Files:**
- Create: `docs/guides/model-freshness.md`

- [ ] **Step 11.1: Write the guide**

Create `docs/guides/model-freshness.md`:

```markdown
# Model Freshness Monitor

Ollama model tags roll over silently — `qwen3-coder:30b` today may point at a
different digest tomorrow after a new build ships. This plugin watches the
digests of models you already pulled and notifies you when the registry has a
newer build.

## What it does

- Auto-seeds a watchlist from every registered Ollama host's local model list.
- Runs a daily HEAD request against `registry.ollama.ai` for each watched
  `family:tag`.
- When the registry digest differs from your local digest, emits an event via
  the notification queue.
- **Notify-only.** Nothing ever auto-pulls. You decide when to upgrade.

## Tools

| Tool | Purpose |
|------|---------|
| `model_watchlist_list` | Show what's being tracked |
| `model_watchlist_add { family, tag }` | Add a family:tag to the watchlist |
| `model_watchlist_remove { family, tag }` | Stop watching (soft-delete) |
| `model_freshness_scan_now` | Run the scan on-demand |
| `model_freshness_events` | List pending drift events |

## Typical flow

1. Install TORQUE — plugin auto-seeds from your Ollama hosts.
2. A new build of `qwen3-coder:30b` ships at 02:00; your scan runs at 03:00.
3. Scan finds a digest mismatch → event inserted, notification queued.
4. Next time you run `check_notifications` or visit the dashboard, you see:
   "qwen3-coder:30b — new digest available. Run `ollama pull qwen3-coder:30b`."
5. You decide. The monitor never pulls on your behalf.

## Disabling

Remove `'model-freshness'` from `DEFAULT_PLUGIN_NAMES` in `server/index.js` and
restart. Data stays in the DB but no further scans run.

## Scope (what it does NOT do)

- No auto-pull.
- No discovery of entirely new model families. (Run `ollama launch claude`
  interactively to see what's available.)
- No benchmark-based recommendations.
- No cloud-tag tracking. The `ollama-cloud` provider hits `api.ollama.com`
  separately; those tags are unreachable via `registry.ollama.ai`.
```

- [ ] **Step 11.2: Commit**

```bash
git add docs/guides/model-freshness.md
git commit -m "docs: model freshness monitor user guide

Explains what the plugin does, lists the 5 tools, walks through the
typical flow (auto-seed → daily scan → notify), how to disable, and
what's intentionally out of scope (no auto-pull, no discovery, no
leaderboards, no cloud tags)."
```

---

## Final verification

- [ ] **Run the plugin's full test suite**

```bash
cd server && npx vitest run plugins/model-freshness/tests/
```

Expected: all PASS.

- [ ] **Run a live end-to-end scan via MCP**

Start TORQUE (it will auto-load the plugin). In a Claude Code session:

```
model_watchlist_list { }              → see auto-seeded entries
model_freshness_scan_now { }          → force-run scan
model_freshness_events { }            → confirm no unexpected events
```

- [ ] **Push to feature branch**

```bash
git push origin feat/model-freshness-monitor
```

(Do NOT cutover to main yet — leave the plugin enabled on the feature branch for a few scan cycles to validate the registry endpoint stays stable before graduating.)

---

## Post-implementation corrections (2026-04-19)

This plan was executed end-to-end. Seven defects were discovered during execution and should be baked into re-runs.

### 1. Vitest imports via globals, not `require('vitest')`

**Symptom:** Every test file failed with "Vitest cannot be imported in a CommonJS module using require()".

**Root cause:** The project's `vitest.config.js` sets `globals: true`. `describe`, `it`, `expect`, `vi` are injected as globals; attempting to `require('vitest')` is rejected.

**Fix:** Drop the `const { describe, it, expect, vi } = require('vitest')` line from every test file in this plan. Use the globals directly.

### 2. Plugin export shape must be `{ createPlugin }`, not a bare function

**Symptom:** Plugin contract validation failed with "plugin must be an object".

**Root cause:** The plan's Task 7 Step 7.3 ends with `module.exports = createPlugin;` (a bare function reference). `server/plugins/loader.js` does `createPluginInstance(mod)` which tests `typeof mod.createPlugin === 'function'` — a bare function fails this check.

**Fix:** Use `module.exports = { createPlugin };` — matches the pattern in `server/plugins/remote-agents/index.js`. Update the Task 7.3 code block accordingly.

### 3. Scheduler API is `createCronScheduledTask` in `cron-scheduling.js`

**Symptom:** Task 10 Step 10.3's `require('../../db/scheduler')` failed — module not found.

**Root cause:** The plan assumes `server/db/scheduler.js` with `scheduleTask({...})`. The real module is `server/db/cron-scheduling.js` and the exported function is `createCronScheduledTask({ name, cron_expression, payload_kind: 'task', task_config: { tool_name }, source })`.

**Fix:** Rewrite Task 10's install()-extension block to use `createCronScheduledTask` against the `cron-scheduling` module. Update the test expectations to match the new shape.

### 4. `vi.mock` of CJS didn't intercept the plugin's require chain

**Symptom:** Task 10 test injected a fake scheduler via `vi.doMock` (absolute path) but the plugin's `require('../../db/cron-scheduling')` still resolved to the real module. `scheduleCalls` stayed empty.

**Root cause:** In this repo's vitest/CJS harness, module-level `vi.doMock` doesn't always intercept nested `require()` inside factory functions.

**Fix:** Refactor `install()` to accept an injected scheduler via `container.get('cronScheduling')`, falling back to `require()` only when the container doesn't provide one. The test injects the fake via the container; production path uses the real module. Landed in the executed plan.

### 5. Tool annotations registry is rule-based, not a flat `TOOL_ANNOTATIONS` map

**Symptom:** Task 9 Step 9.3 assumed `server/tool-annotations.js` exports a `TOOL_ANNOTATIONS` object keyed by tool name with `title`/`description` fields. The real file exports `getAnnotations(toolName)` with an internal `OVERRIDES`/`EXACT_MATCHES`/prefix/suffix system.

**Fix:** Task 9 needs to add `OVERRIDES` entries for each of the 5 tools (READONLY-shape for list/events, IDEMPOTENT-shape for add/remove, DISPATCH-shape for scan_now) and update the test to validate via `getAnnotations()` calls rather than direct map lookups.

### 6. `install()` must tolerate DB unavailability

**Symptom:** Task 10's schedule-registration test instantiates the plugin with `{ get: () => null }` (no DB in container). Under the plan's code, `resolveRawDb()` threw before the scheduler-registration block could run.

**Fix:** Wrap `resolveRawDb(dbService)` in a try/catch so the plugin can still register its scheduled scan even without a DB. Stores and scanner will be unusable without DB, but the contract-validation test and the schedule-registration test both need to pass. Landed in the executed plan.

### 7. Vitest per-file filter unreliable on the remote workstation

**Symptom:** Commands like `npx vitest run plugins/model-freshness/tests/watchlist-store.test.js` intermittently return "No test files found". What works consistently: broader substring filters (`npx vitest run plugins/model-freshness`) or clearing the vitest cache (`rm -rf node_modules/.vite node_modules/.vitest`).

**Fix:** Update every per-task test command in this plan to use a broader filter pattern, or document the cache-clear workaround at the top of the plan.

### 8. Provider tools vs plugin tools — differing tool-exposure paths

**Process note, not a plan defect:** TORQUE exposes plugin tools via the MCP protocol (SSE `tools/list`) but **not** via the REST `/api/tools` route (which reads from `tools.routeMap`). Plugin tools don't populate routeMap. This means:
- A Claude Code session connected to TORQUE's MCP sees the 5 freshness tools (after `unlock_all_tools`).
- `curl /api/tools` does NOT list them; `curl -X POST /api/tools/model_freshness_scan_now` returns 404.

Only relevant when writing verification scripts — stick to MCP-side testing.

### 9. `tool-annotations.test.js` `getExposedToolNames()` helper needs the new plugin registered

**Symptom:** After merge + restart, the 5 `model_watchlist_*` / `model_freshness_*` `OVERRIDES` entries added in Task 9 triggered "stale override" failures in `server/tests/tool-annotations.test.js`. The helper that builds the set of "currently exposed tool names" only collected remote-agents plugin tool-defs — not freshness — so validateCoverage didn't see the tools the OVERRIDES targeted.

**Chain of events on main:** another session observed the failure, initially removed the freshness OVERRIDES thinking the plugin wasn't merged yet (commit `44a34d67`), realized the plugin WAS merged, reverted (`e5e3f434`), and then fixed the helper (`ce27b1fc`, `fix(tests): include model-freshness plugin tool-defs in getExposedToolNames`).

**Fix for re-runs:** Task 9 must include an edit to `server/tests/tool-annotations.test.js`'s `getExposedToolNames()` helper to register the plugin's tool-defs. The current fix uses a small `pluginToolNames()` factory that's extensible — follow that pattern. Or refactor the helper to auto-discover from `server/plugins/*/tool-defs.js`.

### 10. Client-side tool discovery gap (environmental, not a plan defect)

A subagent running a fresh MCP session verified all 5 freshness tools work via raw JSON-RPC `tools/list` → the plugin's server-side registration is correct. But Claude Code's `ToolSearch` deferred-tool index didn't surface them even after `unlock_all_tools`. The gap is on the MCP client/SDK side. Not blocking, but worth noting: test reproducibility may be affected if a reviewer relies on ToolSearch alone.

### 11. `add` returns `added: false` for tags that match a soft-deleted row

**Symptom noted by the verification subagent:** calling `model_watchlist_add { family, tag }` where a row with `active: 0` already exists returns `added: false` — doesn't reactivate the row, doesn't treat the call as a fresh insert.

**Not a defect per the spec** (soft-delete preserves history), but the behavior is surprising: users expect `add` after `remove` to re-enable tracking. Worth either (a) changing `add` to reactivate inactive rows, or (b) documenting the tombstone behavior in `model_watchlist_list` output (e.g., include inactive rows with a `tombstoned` flag). Leaving this as a follow-on decision.
