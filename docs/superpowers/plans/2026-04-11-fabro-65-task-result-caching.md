# Fabro #65: Task Result Caching (Flyte)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Cache task outputs by a hash of `(task_signature, inputs, cache_version)`. Repeated calls with identical inputs return the stored result without re-invoking the provider. Authors bump `cache_version` when the logic changes meaningfully — so caching survives code churn that doesn't affect behavior. Inspired by Flyte.

**Architecture:** A new `task_cache` table stores `(cache_key, output, completed_at, hit_count)`. When a task starts with `cacheable: true`, the runtime computes the cache key from `hash(provider + model + prompt_template + cache_version + canonicalJSON(inputs))` and checks for a hit. Hit → mark task completed immediately with cached output + emit `cache_hit` event. Miss → run normally, then store the result. A single-flight guard prevents duplicate in-flight computations with the same key.

**Tech Stack:** Node.js, crypto (SHA-256), better-sqlite3. Builds on plans 14 (events), 23 (typed signatures), 31 (activities).

---

## File Structure

**New files:**
- `server/migrations/0NN-task-cache.sql`
- `server/caching/cache-key.js`
- `server/caching/task-cache.js`
- `server/caching/single-flight.js` — dedupe concurrent identical computations
- `server/tests/cache-key.test.js`
- `server/tests/task-cache.test.js`
- `server/tests/single-flight.test.js`

**Modified files:**
- `server/execution/task-startup.js` — check cache before provider dispatch
- `server/execution/task-finalizer.js` — write cache on success
- `server/tool-defs/task-defs.js` — accept `cacheable` + `cache_version` + `cache_ttl_seconds`

---

## Task 1: Cache key

- [ ] **Step 1: Tests**

Create `server/tests/cache-key.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { computeCacheKey } = require('../caching/cache-key');

describe('computeCacheKey', () => {
  it('same inputs produce same key', () => {
    const a = computeCacheKey({ provider: 'codex', model: 'gpt-5.3', prompt: 'x', inputs: { a: 1 }, cache_version: '1.0' });
    const b = computeCacheKey({ provider: 'codex', model: 'gpt-5.3', prompt: 'x', inputs: { a: 1 }, cache_version: '1.0' });
    expect(a).toBe(b);
  });

  it('different prompt produces different key', () => {
    const a = computeCacheKey({ provider: 'codex', model: 'x', prompt: 'one', inputs: {}, cache_version: '1' });
    const b = computeCacheKey({ provider: 'codex', model: 'x', prompt: 'two', inputs: {}, cache_version: '1' });
    expect(a).not.toBe(b);
  });

  it('different cache_version produces different key (bump to invalidate)', () => {
    const a = computeCacheKey({ provider: 'x', model: 'y', prompt: 'p', inputs: {}, cache_version: '1' });
    const b = computeCacheKey({ provider: 'x', model: 'y', prompt: 'p', inputs: {}, cache_version: '2' });
    expect(a).not.toBe(b);
  });

  it('input key order does not affect key (canonical JSON)', () => {
    const a = computeCacheKey({ provider: 'x', model: 'y', prompt: 'p', inputs: { a: 1, b: 2 }, cache_version: '1' });
    const b = computeCacheKey({ provider: 'x', model: 'y', prompt: 'p', inputs: { b: 2, a: 1 }, cache_version: '1' });
    expect(a).toBe(b);
  });

  it('nested object key order does not affect key', () => {
    const a = computeCacheKey({ provider: 'x', model: 'y', prompt: 'p', inputs: { x: { c: 3, a: 1 } }, cache_version: '1' });
    const b = computeCacheKey({ provider: 'x', model: 'y', prompt: 'p', inputs: { x: { a: 1, c: 3 } }, cache_version: '1' });
    expect(a).toBe(b);
  });

  it('returns a 64-char hex string (SHA-256)', () => {
    const k = computeCacheKey({ provider: 'x', model: 'y', prompt: 'p', inputs: {}, cache_version: '1' });
    expect(k).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/caching/cache-key.js`:

```js
'use strict';
const crypto = require('crypto');

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function computeCacheKey({ provider, model, prompt, inputs, cache_version }) {
  const payload = canonicalJson({ provider, model, prompt, inputs, cache_version });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = { computeCacheKey, canonicalJson };
```

Run tests → PASS. Commit: `feat(cache): deterministic cache key from canonical JSON`.

---

## Task 2: Task cache store

- [ ] **Step 1: Migration**

`server/migrations/0NN-task-cache.sql`:

```sql
CREATE TABLE IF NOT EXISTS task_cache (
  cache_key TEXT PRIMARY KEY,
  output TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  cache_version TEXT,
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  original_task_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_cache_expires ON task_cache(expires_at);
```

- [ ] **Step 2: Tests**

Create `server/tests/task-cache.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createTaskCache } = require('../caching/task-cache');

describe('taskCache', () => {
  let db, cache;
  beforeEach(() => {
    db = setupTestDb();
    cache = createTaskCache({ db });
  });

  it('miss returns null', () => {
    expect(cache.get('k-never-seen')).toBeNull();
  });

  it('put then get returns the output + increments hit_count', () => {
    cache.put({ cacheKey: 'k1', output: 'hello world', provider: 'codex', model: 'x', originalTaskId: 't1' });
    const r = cache.get('k1');
    expect(r.output).toBe('hello world');
    expect(r.hit_count).toBe(1);
    const r2 = cache.get('k1');
    expect(r2.hit_count).toBe(2);
  });

  it('honors ttl — expired entries return null', () => {
    cache.put({ cacheKey: 'k2', output: 'x', ttlSeconds: -1 });
    expect(cache.get('k2')).toBeNull();
  });

  it('put is idempotent — overwrites existing entry', () => {
    cache.put({ cacheKey: 'k3', output: 'v1' });
    cache.put({ cacheKey: 'k3', output: 'v2' });
    expect(cache.get('k3').output).toBe('v2');
  });

  it('invalidate removes entry', () => {
    cache.put({ cacheKey: 'k4', output: 'x' });
    cache.invalidate('k4');
    expect(cache.get('k4')).toBeNull();
  });

  it('sweepExpired deletes expired rows', () => {
    cache.put({ cacheKey: 'fresh', output: 'x', ttlSeconds: 3600 });
    cache.put({ cacheKey: 'stale', output: 'y', ttlSeconds: -1 });
    const n = cache.sweepExpired();
    expect(n).toBe(1);
    expect(cache.get('fresh')).not.toBeNull();
  });
});
```

- [ ] **Step 3: Implement**

Create `server/caching/task-cache.js`:

```js
'use strict';

function createTaskCache({ db }) {
  function put({ cacheKey, output, provider = null, model = null, cacheVersion = null, ttlSeconds = null, originalTaskId = null }) {
    const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
    db.prepare(`
      INSERT OR REPLACE INTO task_cache (cache_key, output, provider, model, cache_version, completed_at, expires_at, original_task_id, hit_count)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, 0)
    `).run(cacheKey, output, provider, model, cacheVersion, expiresAt, originalTaskId);
  }

  function get(cacheKey) {
    const row = db.prepare('SELECT * FROM task_cache WHERE cache_key = ?').get(cacheKey);
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    db.prepare('UPDATE task_cache SET hit_count = hit_count + 1 WHERE cache_key = ?').run(cacheKey);
    return { ...row, hit_count: row.hit_count + 1 };
  }

  function invalidate(cacheKey) {
    db.prepare('DELETE FROM task_cache WHERE cache_key = ?').run(cacheKey);
  }

  function sweepExpired() {
    const r = db.prepare(`DELETE FROM task_cache WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
    return r.changes;
  }

  function stats() {
    const total = db.prepare('SELECT COUNT(*) AS n, SUM(hit_count) AS hits FROM task_cache').get();
    return { entries: total.n, total_hits: total.hits || 0 };
  }

  return { put, get, invalidate, sweepExpired, stats };
}

module.exports = { createTaskCache };
```

Run tests → PASS. Commit: `feat(cache): task-cache store with TTL + hit counter`.

---

## Task 3: Single-flight + wiring

- [ ] **Step 1: Single-flight tests + impl**

Create `server/tests/single-flight.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { createSingleFlight } = require('../caching/single-flight');

describe('singleFlight', () => {
  it('dedupe concurrent calls with same key — fn runs once', async () => {
    const sf = createSingleFlight();
    const fn = vi.fn(async () => { await new Promise(r => setTimeout(r, 30)); return 'result'; });
    const [a, b, c] = await Promise.all([sf.do('k', fn), sf.do('k', fn), sf.do('k', fn)]);
    expect(a).toBe('result'); expect(b).toBe('result'); expect(c).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('different keys run independently', async () => {
    const sf = createSingleFlight();
    const fn = vi.fn(async (k) => k);
    await Promise.all([sf.do('a', () => fn('a')), sf.do('b', () => fn('b'))]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('subsequent call after completion re-runs (no caching here)', async () => {
    const sf = createSingleFlight();
    const fn = vi.fn(async () => 'x');
    await sf.do('k', fn);
    await sf.do('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejections propagate to all waiters', async () => {
    const sf = createSingleFlight();
    const fn = vi.fn(async () => { throw new Error('boom'); });
    const p1 = sf.do('k', fn).catch(e => e.message);
    const p2 = sf.do('k', fn).catch(e => e.message);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe('boom');
    expect(b).toBe('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

Create `server/caching/single-flight.js`:

```js
'use strict';

function createSingleFlight() {
  const inFlight = new Map();
  async function doOp(key, fn) {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = (async () => {
      try { return await fn(); }
      finally { inFlight.delete(key); }
    })();
    inFlight.set(key, promise);
    return promise;
  }
  return { do: doOp };
}

module.exports = { createSingleFlight };
```

Run tests → PASS. Commit: `feat(cache): single-flight deduper for concurrent identical computations`.

---

## Task 4: Wire into task lifecycle

- [ ] **Step 1: Tool def**

In `server/tool-defs/task-defs.js`:

```js
cacheable: { type: 'boolean', default: false, description: 'Cache this task output keyed by inputs + prompt + provider. Repeats return stored result.' },
cache_version: { type: 'string', default: '1', description: 'Bump when task logic changes meaningfully to invalidate the cache.' },
cache_ttl_seconds: { type: 'integer', description: 'Optional TTL. Omit for indefinite cache.' },
```

- [ ] **Step 2: Startup hook**

In `server/execution/task-startup.js` before provider dispatch, for cacheable tasks:

```js
const meta = parseTaskMetadata(task);
if (meta.cacheable) {
  const { computeCacheKey } = require('../caching/cache-key');
  const cache = defaultContainer.get('taskCache');
  const key = computeCacheKey({
    provider: task.provider,
    model: task.model,
    prompt: task.task_description,
    inputs: meta.inputs || {},
    cache_version: meta.cache_version || '1',
  });

  const hit = cache.get(key);
  if (hit) {
    db.prepare(`UPDATE tasks SET status = 'completed', output = ?, completed_at = datetime('now') WHERE task_id = ?`).run(hit.output, taskId);
    defaultContainer.get('journalWriter').write({
      workflowId: task.workflow_id, taskId, type: 'cache_hit',
      payload: { cache_key: key, original_task_id: hit.original_task_id },
    });
    addTaskTag(taskId, 'cache:hit');
    return { cached: true };
  }

  // Single-flight: if an identical task is in flight, wait for it
  const sf = defaultContainer.get('singleFlight');
  task.__cache_key = key;
  return await sf.do(key, async () => {
    // Proceed with normal provider dispatch; finalizer will write cache
    return dispatchToProvider(task);
  });
}
```

- [ ] **Step 3: Finalizer writes cache**

In `server/execution/task-finalizer.js` on success, when `task.__cache_key`:

```js
if (task.__cache_key && finalOutput) {
  const meta = parseTaskMetadata(task);
  defaultContainer.get('taskCache').put({
    cacheKey: task.__cache_key,
    output: typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput),
    provider: task.provider, model: task.model,
    cacheVersion: meta.cache_version,
    ttlSeconds: meta.cache_ttl_seconds || null,
    originalTaskId: taskId,
  });
  addTaskTag(taskId, 'cache:miss_stored');
}
```

- [ ] **Step 4: Container + sweep tick**

```js
container.factory('taskCache', (c) => require('./caching/task-cache').createTaskCache({ db: c.get('db') }));
container.factory('singleFlight', () => require('./caching/single-flight').createSingleFlight());

setInterval(() => defaultContainer.get('taskCache').sweepExpired(), 60 * 60 * 1000);
```

Add `cache_hit` to `VALID_EVENT_TYPES`.

`await_restart`. Smoke: submit task with `cacheable: true, cache_version: '1'`. Confirm runs, gets tag `cache:miss_stored`. Submit identical task again — confirm `cache:hit` tag and much faster completion. Bump `cache_version: '2'` — confirm re-runs.

Commit: `feat(cache): wire caching into task-startup + finalizer with single-flight`.
