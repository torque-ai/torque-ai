# Remote Test Coordinator — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 of the `torque-coord` daemon — a per-project lock service on the workstation that serializes concurrent `torque-remote` test runs, ending the mid-stream crashes (`serv_exit=127`, `dash_exit=255`) caused by CPU/memory contention between concurrent sessions.

**Architecture:** A long-lived Node.js HTTP service on the workstation, bound to `127.0.0.1:9395`. `bin/torque-remote` shells out to a small Node CLI (`bin/torque-coord-client`) at acquire/wait/release boundaries. Coordination is best-effort with 2-second timeouts everywhere — daemon down degrades to today's uncoordinated behavior. Phase 1 ships only the lock + waiter mechanics; the result store is write-only stub and `GET /results` always returns 404 (forward compat for Phase 2).

**Tech Stack:** Node.js (CommonJS, matches existing `server/`), native `http` module (no Express), vitest for tests, bash for `bin/torque-remote`, PowerShell for the workstation install script.

**Source spec:** `docs/superpowers/specs/2026-04-27-remote-test-coordinator-design.md`

---

## File structure

```
server/coord/
  config.js          # JSON config load + hot-reload, defaults
  state.js           # in-memory lock map, atomic transitions, persistence
  result-store.js    # filesystem result writes (Phase 1: write-only stub)
  reaper.js          # periodic stale-heartbeat detection + force-release
  http.js            # native http.createServer + route table + handlers
  index.js           # daemon entry: wire pieces, listen, spawn reaper

server/tests/
  coord-config.test.js
  coord-state.test.js
  coord-state-persistence.test.js
  coord-result-store.test.js
  coord-reaper.test.js
  coord-http.test.js
  coord-integration.test.js
  coord-client-cli.test.js
  coord-torque-remote-integration.test.js

bin/
  torque-coord                 # NEW: shell wrapper that node-runs server/coord/index.js
  torque-coord-client          # NEW: Node CLI wrapping the HTTP API for bash callers
  torque-remote                # MODIFY: --suite flag + acquire/wait/release wrapper

scripts/
  install-torque-coord.ps1     # NEW: Windows Task Scheduler install for the workstation
  test-coord-e2e.sh            # NEW: manual two-session smoke test

docs/
  torque-coord.md              # NEW: ops doc (install, restart, troubleshoot)

.git/hooks/
  pre-push                     # MODIFY: add --suite gate to two torque-remote invocations
```

---

## Task 1: Config module

**Files:**
- Create: `server/coord/config.js`
- Test: `server/tests/coord-config.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-config.test.js`:

```javascript
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, expect, beforeEach, afterEach } = require('vitest');

const { loadConfig, DEFAULTS } = require('../coord/config');

describe('coord config', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', () => {
    const config = loadConfig(path.join(tmpDir, 'missing.json'));
    expect(config).toEqual(DEFAULTS);
  });

  it('overrides defaults with values from JSON file', () => {
    const file = path.join(tmpDir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({
      max_concurrent_runs: 4,
      result_ttl_seconds: 7200,
    }));
    const config = loadConfig(file);
    expect(config.max_concurrent_runs).toBe(4);
    expect(config.result_ttl_seconds).toBe(7200);
    expect(config.heartbeat_interval_ms).toBe(DEFAULTS.heartbeat_interval_ms);
    expect(config.shareable_suites).toEqual(DEFAULTS.shareable_suites);
  });

  it('rejects malformed JSON by returning defaults plus a warning flag', () => {
    const file = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(file, '{ not json');
    const config = loadConfig(file);
    expect(config).toMatchObject(DEFAULTS);
    expect(config.__load_error).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-config.test.js`

Expected: FAIL with "Cannot find module '../coord/config'".

- [ ] **Step 3: Write minimal implementation**

Create `server/coord/config.js`:

```javascript
'use strict';
const fs = require('fs');

const DEFAULTS = Object.freeze({
  port: 9395,
  bind: '127.0.0.1',
  protocol_version: 1,
  shareable_suites: ['gate', 'server', 'dashboard', 'perf'],
  result_ttl_seconds: 3600,
  max_concurrent_runs: 2,
  heartbeat_interval_ms: 30000,
  stale_lock_threshold_ms: 90000,
  reaper_tick_ms: 10000,
  state_dir: null, // resolved by index.js to ~/.torque-coord/state
  results_dir: null, // resolved by index.js to ~/.torque-coord/results
});

function loadConfig(filePath) {
  let overrides = {};
  let loadError = null;
  if (filePath && fs.existsSync(filePath)) {
    try {
      overrides = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      loadError = err.message;
    }
  }
  const merged = { ...DEFAULTS, ...overrides };
  if (loadError) {
    merged.__load_error = loadError;
  }
  return merged;
}

module.exports = { loadConfig, DEFAULTS };
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-config.test.js`

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/coord/config.js server/tests/coord-config.test.js
git commit -m "feat(coord): config loader with defaults + JSON overrides"
```

---

## Task 2: State store — acquire / release / heartbeat

**Files:**
- Create: `server/coord/state.js`
- Test: `server/tests/coord-state.test.js`

The state store owns the in-memory lock map. No HTTP, no I/O — pure logic so it's trivially testable.

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-state.test.js`:

```javascript
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { createStateStore } = require('../coord/state');

const HOLDER = { host: 'omen', pid: 1234, user: 'kenten' };

describe('coord state store', () => {
  let store;

  beforeEach(() => {
    store = createStateStore({ max_concurrent_runs: 2 });
  });

  it('acquire on a free project returns acquired:true with a lock_id', () => {
    const result = store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    expect(result.acquired).toBe(true);
    expect(typeof result.lock_id).toBe('string');
    expect(store.listActive()).toHaveLength(1);
  });

  it('second acquire on same project returns 202 wait_for the existing lock_id', () => {
    const first = store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    const second = store.acquire({ project: 'torque-public', sha: 'def', suite: 'gate', holder: HOLDER });
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe('project_held');
    expect(second.wait_for).toBe(first.lock_id);
  });

  it('acquire on a different project succeeds independently', () => {
    store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    const other = store.acquire({ project: 'dlphone', sha: 'xyz', suite: 'gate', holder: HOLDER });
    expect(other.acquired).toBe(true);
    expect(store.listActive()).toHaveLength(2);
  });

  it('global semaphore blocks the third acquire when max_concurrent_runs is 2', () => {
    store.acquire({ project: 'p1', sha: 'a', suite: 'gate', holder: HOLDER });
    store.acquire({ project: 'p2', sha: 'b', suite: 'gate', holder: HOLDER });
    const third = store.acquire({ project: 'p3', sha: 'c', suite: 'gate', holder: HOLDER });
    expect(third.acquired).toBe(false);
    expect(third.reason).toBe('global_semaphore_full');
    expect(third.wait_for).toBeNull();
  });

  it('release frees the project lock so a new acquire succeeds', () => {
    const first = store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    const released = store.release(first.lock_id, { exit_code: 0, suite_status: 'pass', output_tail: 'ok' });
    expect(released.released).toBe(true);
    expect(store.listActive()).toHaveLength(0);
    const next = store.acquire({ project: 'torque-public', sha: 'def', suite: 'gate', holder: HOLDER });
    expect(next.acquired).toBe(true);
  });

  it('heartbeat updates last_heartbeat_at and appends bounded log_chunk', () => {
    const first = store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    const before = store.getLock(first.lock_id).last_heartbeat_at;
    const fakeNow = Date.parse(before) + 1000;
    store.heartbeat(first.lock_id, { log_chunk: 'still running\n', now: fakeNow });
    const after = store.getLock(first.lock_id);
    expect(Date.parse(after.last_heartbeat_at)).toBe(fakeNow);
    expect(after.output_buffer).toContain('still running');
  });

  it('heartbeat output_buffer is bounded to ~1MB', () => {
    const first = store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    const big = 'x'.repeat(600 * 1024);
    store.heartbeat(first.lock_id, { log_chunk: big });
    store.heartbeat(first.lock_id, { log_chunk: big });
    const lock = store.getLock(first.lock_id);
    expect(lock.output_buffer.length).toBeLessThanOrEqual(1024 * 1024);
    expect(lock.output_buffer.endsWith(big)).toBe(true);
  });

  it('release on unknown lock_id returns released:false', () => {
    const result = store.release('does-not-exist', { exit_code: 0 });
    expect(result.released).toBe(false);
    expect(result.reason).toBe('unknown_lock');
  });

  it('forceRelease marks the lock crashed and frees the project slot', () => {
    const first = store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    const out = store.forceRelease(first.lock_id, { reason: 'stale_heartbeat' });
    expect(out.released).toBe(true);
    expect(out.crashed).toBe(true);
    expect(store.listActive()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-state.test.js`

Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

Create `server/coord/state.js`:

```javascript
'use strict';
const crypto = require('crypto');

const OUTPUT_BUFFER_CAP_BYTES = 1024 * 1024; // 1MB

function createStateStore(config) {
  const locks = new Map();          // lock_id -> lock
  const byProject = new Map();      // project -> lock_id
  const subscribers = new Map();    // lock_id -> Set<callback>

  function newLockId() { return crypto.randomBytes(8).toString('hex'); }
  function nowIso() { return new Date().toISOString(); }

  function acquire({ project, sha, suite, holder }) {
    if (byProject.has(project)) {
      return {
        acquired: false,
        reason: 'project_held',
        wait_for: byProject.get(project),
      };
    }
    if (locks.size >= config.max_concurrent_runs) {
      return {
        acquired: false,
        reason: 'global_semaphore_full',
        wait_for: null,
      };
    }
    const lock_id = newLockId();
    const created_at = nowIso();
    const lock = {
      lock_id, project, sha, suite, holder,
      created_at,
      last_heartbeat_at: created_at,
      output_buffer: '',
      crashed: false,
    };
    locks.set(lock_id, lock);
    byProject.set(project, lock_id);
    return { acquired: true, lock_id };
  }

  function heartbeat(lock_id, { log_chunk = '', now = null } = {}) {
    const lock = locks.get(lock_id);
    if (!lock) return { ok: false, reason: 'unknown_lock' };
    lock.last_heartbeat_at = now ? new Date(now).toISOString() : nowIso();
    if (log_chunk) {
      const combined = lock.output_buffer + log_chunk;
      lock.output_buffer = combined.length > OUTPUT_BUFFER_CAP_BYTES
        ? combined.slice(combined.length - OUTPUT_BUFFER_CAP_BYTES)
        : combined;
    }
    return { ok: true };
  }

  function release(lock_id, payload = {}) {
    const lock = locks.get(lock_id);
    if (!lock) return { released: false, reason: 'unknown_lock' };
    locks.delete(lock_id);
    byProject.delete(lock.project);
    notify(lock_id, {
      type: 'released',
      exit_code: payload.exit_code,
      suite_status: payload.suite_status,
      output_tail: payload.output_tail || lock.output_buffer.slice(-OUTPUT_BUFFER_CAP_BYTES),
      lock,
    });
    return { released: true, lock };
  }

  function forceRelease(lock_id, { reason }) {
    const lock = locks.get(lock_id);
    if (!lock) return { released: false, reason: 'unknown_lock' };
    lock.crashed = true;
    locks.delete(lock_id);
    byProject.delete(lock.project);
    notify(lock_id, { type: 'holder_crashed', reason, lock });
    return { released: true, crashed: true, lock };
  }

  function getLock(lock_id) { return locks.get(lock_id) || null; }
  function listActive() { return Array.from(locks.values()); }

  function subscribe(lock_id, cb) {
    if (!subscribers.has(lock_id)) subscribers.set(lock_id, new Set());
    subscribers.get(lock_id).add(cb);
    return () => {
      const set = subscribers.get(lock_id);
      if (set) {
        set.delete(cb);
        if (set.size === 0) subscribers.delete(lock_id);
      }
    };
  }

  function notify(lock_id, event) {
    const set = subscribers.get(lock_id);
    if (!set) return;
    for (const cb of set) {
      try { cb(event); } catch (_e) { /* swallow */ }
    }
    subscribers.delete(lock_id);
  }

  return {
    acquire, heartbeat, release, forceRelease,
    getLock, listActive, subscribe,
  };
}

module.exports = { createStateStore, OUTPUT_BUFFER_CAP_BYTES };
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-state.test.js`

Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/coord/state.js server/tests/coord-state.test.js
git commit -m "feat(coord): in-memory state store — acquire, release, heartbeat, forceRelease"
```

---

## Task 3: State persistence — active.json round-trip

**Files:**
- Modify: `server/coord/state.js`
- Test: `server/tests/coord-state-persistence.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-state-persistence.test.js`:

```javascript
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { createStateStore } = require('../coord/state');

const HOLDER = { host: 'omen', pid: 1234, user: 'kenten' };

describe('coord state persistence', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-state-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists lock state to active.json on every transition', () => {
    const file = path.join(tmpDir, 'active.json');
    const store = createStateStore({ max_concurrent_runs: 2, persist_path: file });
    store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    expect(fs.existsSync(file)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.locks).toHaveLength(1);
    expect(persisted.locks[0].project).toBe('torque-public');
  });

  it('restoreFromFile marks all restored entries as crashed and clears them', () => {
    const file = path.join(tmpDir, 'active.json');
    fs.writeFileSync(file, JSON.stringify({
      locks: [{
        lock_id: 'old',
        project: 'torque-public',
        sha: 'abc',
        suite: 'gate',
        holder: HOLDER,
        created_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        output_buffer: '',
        crashed: false,
      }],
    }));
    const store = createStateStore({ max_concurrent_runs: 2, persist_path: file });
    const reconciled = store.restoreFromFile();
    expect(reconciled.crashed_count).toBe(1);
    expect(store.listActive()).toHaveLength(0);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.locks).toHaveLength(0);
  });

  it('restoreFromFile is a no-op when the file does not exist', () => {
    const file = path.join(tmpDir, 'missing.json');
    const store = createStateStore({ max_concurrent_runs: 2, persist_path: file });
    const reconciled = store.restoreFromFile();
    expect(reconciled.crashed_count).toBe(0);
    expect(store.listActive()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-state-persistence.test.js`

Expected: FAIL — `restoreFromFile` not defined.

- [ ] **Step 3: Modify state.js to add persistence**

Replace the contents of `server/coord/state.js` with:

```javascript
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUTPUT_BUFFER_CAP_BYTES = 1024 * 1024;

function createStateStore(config) {
  const locks = new Map();
  const byProject = new Map();
  const subscribers = new Map();
  const persistPath = config.persist_path || null;

  function newLockId() { return crypto.randomBytes(8).toString('hex'); }
  function nowIso() { return new Date().toISOString(); }

  function persist() {
    if (!persistPath) return;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      const payload = JSON.stringify({
        version: 1,
        locks: Array.from(locks.values()),
      });
      fs.writeFileSync(persistPath + '.tmp', payload);
      fs.renameSync(persistPath + '.tmp', persistPath);
    } catch (_err) { /* best-effort persistence */ }
  }

  function restoreFromFile() {
    if (!persistPath || !fs.existsSync(persistPath)) {
      return { crashed_count: 0 };
    }
    try {
      const data = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
      const stale = Array.isArray(data.locks) ? data.locks : [];
      const crashed_count = stale.length;
      // Stale locks across daemon restart: never trust them. No way to verify
      // the original holder process is alive without per-host PID introspection.
      locks.clear();
      byProject.clear();
      persist();
      return { crashed_count };
    } catch (_err) {
      return { crashed_count: 0 };
    }
  }

  function acquire({ project, sha, suite, holder }) {
    if (byProject.has(project)) {
      return { acquired: false, reason: 'project_held', wait_for: byProject.get(project) };
    }
    if (locks.size >= config.max_concurrent_runs) {
      return { acquired: false, reason: 'global_semaphore_full', wait_for: null };
    }
    const lock_id = newLockId();
    const created_at = nowIso();
    const lock = {
      lock_id, project, sha, suite, holder,
      created_at, last_heartbeat_at: created_at,
      output_buffer: '', crashed: false,
    };
    locks.set(lock_id, lock);
    byProject.set(project, lock_id);
    persist();
    return { acquired: true, lock_id };
  }

  function heartbeat(lock_id, { log_chunk = '', now = null } = {}) {
    const lock = locks.get(lock_id);
    if (!lock) return { ok: false, reason: 'unknown_lock' };
    lock.last_heartbeat_at = now ? new Date(now).toISOString() : nowIso();
    if (log_chunk) {
      const combined = lock.output_buffer + log_chunk;
      lock.output_buffer = combined.length > OUTPUT_BUFFER_CAP_BYTES
        ? combined.slice(combined.length - OUTPUT_BUFFER_CAP_BYTES)
        : combined;
    }
    persist();
    return { ok: true };
  }

  function release(lock_id, payload = {}) {
    const lock = locks.get(lock_id);
    if (!lock) return { released: false, reason: 'unknown_lock' };
    locks.delete(lock_id);
    byProject.delete(lock.project);
    persist();
    notify(lock_id, {
      type: 'released',
      exit_code: payload.exit_code,
      suite_status: payload.suite_status,
      output_tail: payload.output_tail || lock.output_buffer.slice(-OUTPUT_BUFFER_CAP_BYTES),
      lock,
    });
    return { released: true, lock };
  }

  function forceRelease(lock_id, { reason }) {
    const lock = locks.get(lock_id);
    if (!lock) return { released: false, reason: 'unknown_lock' };
    lock.crashed = true;
    locks.delete(lock_id);
    byProject.delete(lock.project);
    persist();
    notify(lock_id, { type: 'holder_crashed', reason, lock });
    return { released: true, crashed: true, lock };
  }

  function getLock(lock_id) { return locks.get(lock_id) || null; }
  function listActive() { return Array.from(locks.values()); }

  function subscribe(lock_id, cb) {
    if (!subscribers.has(lock_id)) subscribers.set(lock_id, new Set());
    subscribers.get(lock_id).add(cb);
    return () => {
      const set = subscribers.get(lock_id);
      if (set) {
        set.delete(cb);
        if (set.size === 0) subscribers.delete(lock_id);
      }
    };
  }

  function notify(lock_id, event) {
    const set = subscribers.get(lock_id);
    if (!set) return;
    for (const cb of set) {
      try { cb(event); } catch (_e) { /* swallow */ }
    }
    subscribers.delete(lock_id);
  }

  return {
    acquire, heartbeat, release, forceRelease,
    getLock, listActive, subscribe, restoreFromFile,
  };
}

module.exports = { createStateStore, OUTPUT_BUFFER_CAP_BYTES };
```

- [ ] **Step 4: Run both state tests — verify all pass**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-state.test.js tests/coord-state-persistence.test.js`

Expected: 9 + 3 = 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/coord/state.js server/tests/coord-state-persistence.test.js
git commit -m "feat(coord): persist active locks to active.json with restart reconciliation"
```

---

## Task 4: Result store — Phase 1 write-only stub

**Files:**
- Create: `server/coord/result-store.js`
- Test: `server/tests/coord-result-store.test.js`

In Phase 1 the result store accepts writes (so we have a record of completed runs on disk) but `getResult` always returns `null`. Phase 2 will turn the read path on. The write-then-read test guards forward compatibility.

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-result-store.test.js`:

```javascript
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { createResultStore } = require('../coord/result-store');

describe('coord result store (Phase 1 write-only stub)', () => {
  let tmpDir, store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-results-'));
    store = createResultStore({ results_dir: tmpDir, result_ttl_seconds: 3600 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeResult creates a JSON file at <project>/<sha>/<suite>.json', () => {
    store.writeResult({
      project: 'torque-public',
      sha: 'abc123',
      suite: 'gate',
      exit_code: 0,
      suite_status: 'pass',
      output_tail: 'all green',
      package_lock_hashes: { 'server/package-lock.json': 'deadbeef' },
    });
    const file = path.join(tmpDir, 'torque-public', 'abc123', 'gate.json');
    expect(fs.existsSync(file)).toBe(true);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(record).toMatchObject({
      project: 'torque-public',
      sha: 'abc123',
      suite: 'gate',
      exit_code: 0,
      suite_status: 'pass',
      output_tail: 'all green',
    });
    expect(record.completed_at).toBeDefined();
  });

  it('writeResult is a no-op for crashed runs', () => {
    store.writeResult({
      project: 'torque-public', sha: 'abc', suite: 'gate',
      exit_code: -1, suite_status: 'crashed', crashed: true,
    });
    const file = path.join(tmpDir, 'torque-public', 'abc', 'gate.json');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('getResult always returns null in Phase 1 (stub)', () => {
    store.writeResult({
      project: 'torque-public', sha: 'abc', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'ok',
    });
    expect(store.getResult({ project: 'torque-public', sha: 'abc', suite: 'gate' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-result-store.test.js`

Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

Create `server/coord/result-store.js`:

```javascript
'use strict';
const fs = require('fs');
const path = require('path');

function createResultStore(config) {
  const root = config.results_dir;

  function writeResult(record) {
    if (record.crashed) return; // never share crashed runs
    const dir = path.join(root, record.project, record.sha);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${record.suite}.json`);
    const payload = {
      project: record.project,
      sha: record.sha,
      suite: record.suite,
      exit_code: record.exit_code,
      suite_status: record.suite_status,
      output_tail: record.output_tail || '',
      package_lock_hashes: record.package_lock_hashes || {},
      completed_at: new Date().toISOString(),
    };
    fs.writeFileSync(file + '.tmp', JSON.stringify(payload));
    fs.renameSync(file + '.tmp', file);
  }

  // Phase 1: read path stubbed. Phase 2 will check TTL + recompute hashes.
  function getResult(_query) {
    return null;
  }

  return { writeResult, getResult };
}

module.exports = { createResultStore };
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-result-store.test.js`

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/coord/result-store.js server/tests/coord-result-store.test.js
git commit -m "feat(coord): result store — Phase 1 writes records to disk, reads stubbed"
```

---

## Task 5: Reaper — stale-heartbeat detection

**Files:**
- Create: `server/coord/reaper.js`
- Test: `server/tests/coord-reaper.test.js`

The reaper periodically scans active locks. Any lock whose `last_heartbeat_at` is older than `stale_lock_threshold_ms` is force-released as crashed.

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-reaper.test.js`:

```javascript
'use strict';
const { describe, it, expect } = require('vitest');
const { createStateStore } = require('../coord/state');
const { reapStaleLocks, startReaper } = require('../coord/reaper');

const HOLDER = { host: 'omen', pid: 1, user: 'k' };

describe('coord reaper', () => {
  it('force-releases locks whose last_heartbeat_at is older than threshold', () => {
    const store = createStateStore({ max_concurrent_runs: 2 });
    const fresh = store.acquire({ project: 'p1', sha: 'a', suite: 'gate', holder: HOLDER });
    const stale = store.acquire({ project: 'p2', sha: 'b', suite: 'gate', holder: HOLDER });
    store.getLock(stale.lock_id).last_heartbeat_at =
      new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const result = reapStaleLocks(store, { stale_lock_threshold_ms: 90 * 1000, now: Date.now() });
    expect(result.reaped).toEqual([stale.lock_id]);
    expect(store.listActive().map((l) => l.lock_id)).toEqual([fresh.lock_id]);
  });

  it('reaps zero locks when all heartbeats are fresh', () => {
    const store = createStateStore({ max_concurrent_runs: 2 });
    store.acquire({ project: 'p1', sha: 'a', suite: 'gate', holder: HOLDER });
    const result = reapStaleLocks(store, { stale_lock_threshold_ms: 90 * 1000, now: Date.now() });
    expect(result.reaped).toEqual([]);
  });

  it('startReaper schedules periodic scans and stop() halts them', async () => {
    const store = createStateStore({ max_concurrent_runs: 2 });
    const stale = store.acquire({ project: 'p1', sha: 'a', suite: 'gate', holder: HOLDER });
    store.getLock(stale.lock_id).last_heartbeat_at =
      new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const handle = startReaper(store, { stale_lock_threshold_ms: 90 * 1000, reaper_tick_ms: 30 });
    await new Promise((r) => setTimeout(r, 100));
    expect(store.listActive()).toHaveLength(0);
    handle.stop();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-reaper.test.js`

Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

Create `server/coord/reaper.js`:

```javascript
'use strict';

function reapStaleLocks(store, { stale_lock_threshold_ms, now = Date.now() }) {
  const reaped = [];
  for (const lock of store.listActive()) {
    const age = now - Date.parse(lock.last_heartbeat_at);
    if (age > stale_lock_threshold_ms) {
      store.forceRelease(lock.lock_id, { reason: 'stale_heartbeat' });
      reaped.push(lock.lock_id);
    }
  }
  return { reaped };
}

function startReaper(store, { stale_lock_threshold_ms, reaper_tick_ms }) {
  const timer = setInterval(() => {
    reapStaleLocks(store, { stale_lock_threshold_ms });
  }, reaper_tick_ms);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}

module.exports = { reapStaleLocks, startReaper };
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-reaper.test.js`

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/coord/reaper.js server/tests/coord-reaper.test.js
git commit -m "feat(coord): reaper — periodic stale-heartbeat detection + force-release"
```

---

## Task 6: HTTP layer — endpoints + SSE

**Files:**
- Create: `server/coord/http.js`
- Test: `server/tests/coord-http.test.js`

Wire all 7 endpoints. Tests use a real HTTP roundtrip against an ephemeral port.

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-http.test.js`:

```javascript
'use strict';
const http = require('http');
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { createStateStore } = require('../coord/state');
const { createResultStore } = require('../coord/result-store');
const { createServer } = require('../coord/http');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: { 'content-type': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_e) { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw: text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('coord http server', () => {
  let server, port, state, results;

  beforeEach(async () => {
    state = createStateStore({ max_concurrent_runs: 2 });
    results = createResultStore({ results_dir: require('os').tmpdir(), result_ttl_seconds: 3600 });
    server = createServer({ state, results, config: { protocol_version: 1 } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it('GET /health returns ok with protocol_version', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, protocol_version: 1, active_count: 0 });
  });

  it('POST /acquire returns 200 with lock_id when project free', async () => {
    const res = await request(port, 'POST', '/acquire', {
      project: 'torque-public', sha: 'abc', suite: 'gate',
      holder: { host: 'h', pid: 1, user: 'u' },
    });
    expect(res.status).toBe(200);
    expect(res.body.acquired).toBe(true);
    expect(res.body.lock_id).toBeDefined();
  });

  it('POST /acquire returns 202 with wait_for when project held', async () => {
    const a = await request(port, 'POST', '/acquire', {
      project: 'torque-public', sha: 'abc', suite: 'gate',
      holder: { host: 'h', pid: 1, user: 'u' },
    });
    const b = await request(port, 'POST', '/acquire', {
      project: 'torque-public', sha: 'def', suite: 'gate',
      holder: { host: 'h', pid: 2, user: 'u' },
    });
    expect(b.status).toBe(202);
    expect(b.body.acquired).toBe(false);
    expect(b.body.reason).toBe('project_held');
    expect(b.body.wait_for).toBe(a.body.lock_id);
  });

  it('POST /heartbeat updates the lock and returns ok', async () => {
    const a = await request(port, 'POST', '/acquire', {
      project: 'p', sha: 'a', suite: 'gate',
      holder: { host: 'h', pid: 1, user: 'u' },
    });
    const hb = await request(port, 'POST', '/heartbeat', {
      lock_id: a.body.lock_id, log_chunk: 'progress\n',
    });
    expect(hb.status).toBe(200);
    expect(hb.body.ok).toBe(true);
  });

  it('POST /release frees the lock and a follow-up acquire succeeds', async () => {
    const a = await request(port, 'POST', '/acquire', {
      project: 'p', sha: 'a', suite: 'gate',
      holder: { host: 'h', pid: 1, user: 'u' },
    });
    const rel = await request(port, 'POST', '/release', {
      lock_id: a.body.lock_id, exit_code: 0, suite_status: 'pass', output_tail: 'ok',
    });
    expect(rel.status).toBe(200);
    expect(rel.body.released).toBe(true);
    const b = await request(port, 'POST', '/acquire', {
      project: 'p', sha: 'b', suite: 'gate',
      holder: { host: 'h', pid: 2, user: 'u' },
    });
    expect(b.body.acquired).toBe(true);
  });

  it('GET /results/:project/:sha/:suite returns 404 in Phase 1 (stub)', async () => {
    const res = await request(port, 'GET', '/results/torque-public/abc/gate');
    expect(res.status).toBe(404);
  });

  it('GET /active lists current holders', async () => {
    await request(port, 'POST', '/acquire', {
      project: 'p1', sha: 'a', suite: 'gate',
      holder: { host: 'h', pid: 1, user: 'u' },
    });
    await request(port, 'POST', '/acquire', {
      project: 'p2', sha: 'b', suite: 'server',
      holder: { host: 'h', pid: 2, user: 'u' },
    });
    const res = await request(port, 'GET', '/active');
    expect(res.status).toBe(200);
    expect(res.body.active).toHaveLength(2);
    expect(res.body.active.map((l) => l.project).sort()).toEqual(['p1', 'p2']);
  });

  it('GET /wait/:lock_id streams progress events and a terminal released event', async () => {
    const a = await request(port, 'POST', '/acquire', {
      project: 'p', sha: 'a', suite: 'gate',
      holder: { host: 'h', pid: 1, user: 'u' },
    });
    const events = [];
    const wait = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port,
        path: `/wait/${a.body.lock_id}`, method: 'GET',
        headers: { accept: 'text/event-stream' },
      }, (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (dataLine) {
              const parsed = JSON.parse(dataLine.slice(6));
              events.push(parsed);
              if (parsed.type === 'released') {
                res.destroy();
                resolve();
              }
            }
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    await new Promise((r) => setTimeout(r, 50));
    await request(port, 'POST', '/release', {
      lock_id: a.body.lock_id, exit_code: 0, suite_status: 'pass', output_tail: 'done',
    });
    await wait;
    expect(events.find((e) => e.type === 'released')).toMatchObject({
      type: 'released', exit_code: 0, suite_status: 'pass',
    });
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-http.test.js`

Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

Create `server/coord/http.js`:

```javascript
'use strict';
const http = require('http');
const url = require('url');

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function lastLine(buffer) {
  if (!buffer) return '';
  const trimmed = buffer.endsWith('\n') ? buffer.slice(0, -1) : buffer;
  const idx = trimmed.lastIndexOf('\n');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function createServer({ state, results, config }) {
  const startedAt = Date.now();

  function handleHealth(_req, res) {
    sendJson(res, 200, {
      ok: true,
      protocol_version: config.protocol_version,
      uptime_ms: Date.now() - startedAt,
      active_count: state.listActive().length,
    });
  }

  async function handleAcquire(req, res) {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJson(res, 400, { error: 'invalid_json', detail: e.message }); }
    const { project, sha, suite, holder } = body || {};
    if (!project || !sha || !suite || !holder) {
      return sendJson(res, 400, { error: 'missing_fields' });
    }
    const result = state.acquire({ project, sha, suite, holder });
    if (result.acquired) return sendJson(res, 200, result);
    return sendJson(res, 202, result);
  }

  async function handleHeartbeat(req, res) {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJson(res, 400, { error: 'invalid_json', detail: e.message }); }
    const { lock_id, log_chunk } = body || {};
    if (!lock_id) return sendJson(res, 400, { error: 'missing_lock_id' });
    const out = state.heartbeat(lock_id, { log_chunk });
    if (!out.ok) return sendJson(res, 404, out);
    return sendJson(res, 200, out);
  }

  async function handleRelease(req, res) {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJson(res, 400, { error: 'invalid_json', detail: e.message }); }
    const { lock_id, exit_code, suite_status, output_tail, package_lock_hashes } = body || {};
    if (!lock_id) return sendJson(res, 400, { error: 'missing_lock_id' });
    const out = state.release(lock_id, { exit_code, suite_status, output_tail, package_lock_hashes });
    if (!out.released) return sendJson(res, 404, out);
    if (results && typeof results.writeResult === 'function') {
      results.writeResult({
        project: out.lock.project,
        sha: out.lock.sha,
        suite: out.lock.suite,
        exit_code, suite_status, output_tail,
        package_lock_hashes,
        crashed: false,
      });
    }
    return sendJson(res, 200, { released: true });
  }

  function handleResults(_req, res, parts) {
    if (parts.length < 4) return sendJson(res, 400, { error: 'bad_path' });
    const [, , project, sha, suite] = parts;
    const hit = results.getResult({ project, sha, suite });
    if (!hit) return sendJson(res, 404, { hit: false });
    return sendJson(res, 200, hit);
  }

  function handleActive(_req, res) {
    sendJson(res, 200, { active: state.listActive() });
  }

  function handleWait(req, res, parts) {
    const lock_id = parts[2];
    if (!lock_id) return sendJson(res, 400, { error: 'missing_lock_id' });
    const lock = state.getLock(lock_id);
    if (!lock) return sendJson(res, 404, { error: 'unknown_lock' });

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    function sendEvent(payload) {
      res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
    }

    sendEvent({
      type: 'progress',
      lock_id,
      elapsed_ms: Date.now() - Date.parse(lock.created_at),
      last_log_line: lastLine(lock.output_buffer),
    });

    const tick = setInterval(() => {
      const live = state.getLock(lock_id);
      if (!live) return;
      sendEvent({
        type: 'progress',
        lock_id,
        elapsed_ms: Date.now() - Date.parse(live.created_at),
        last_log_line: lastLine(live.output_buffer),
      });
    }, 5000);
    if (typeof tick.unref === 'function') tick.unref();

    const unsubscribe = state.subscribe(lock_id, (event) => {
      sendEvent(event);
      clearInterval(tick);
      res.end();
    });

    req.on('close', () => {
      clearInterval(tick);
      unsubscribe();
    });
  }

  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const parts = parsed.pathname.split('/'); // ['', 'health'] etc.

    if (req.method === 'GET' && parts[1] === 'health') return handleHealth(req, res);
    if (req.method === 'POST' && parts[1] === 'acquire') return handleAcquire(req, res);
    if (req.method === 'POST' && parts[1] === 'heartbeat') return handleHeartbeat(req, res);
    if (req.method === 'POST' && parts[1] === 'release') return handleRelease(req, res);
    if (req.method === 'GET' && parts[1] === 'results') return handleResults(req, res, parts);
    if (req.method === 'GET' && parts[1] === 'active') return handleActive(req, res);
    if (req.method === 'GET' && parts[1] === 'wait') return handleWait(req, res, parts);
    sendJson(res, 404, { error: 'unknown_route', path: parsed.pathname });
  });

  return server;
}

module.exports = { createServer };
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-http.test.js`

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/coord/http.js server/tests/coord-http.test.js
git commit -m "feat(coord): http layer — 7 endpoints + SSE wait stream"
```

---

## Task 7: Daemon entry point + integration test

**Files:**
- Create: `server/coord/index.js`
- Test: `server/tests/coord-integration.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-integration.test.js`:

```javascript
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { startDaemon } = require('../coord/index');

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    }).on('error', reject);
  });
}

describe('coord daemon integration', () => {
  let tmpDir, daemon;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-int-'));
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts and reports healthy', async () => {
    daemon = await startDaemon({
      port: 0,
      state_dir: path.join(tmpDir, 'state'),
      results_dir: path.join(tmpDir, 'results'),
    });
    const res = await get(daemon.port, '/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.protocol_version).toBe(1);
  });

  it('persists active locks to state_dir/active.json', async () => {
    daemon = await startDaemon({
      port: 0,
      state_dir: path.join(tmpDir, 'state'),
      results_dir: path.join(tmpDir, 'results'),
    });
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: daemon.port,
        path: '/acquire', method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, (res) => res.on('end', resolve));
      req.on('error', reject);
      req.end(JSON.stringify({
        project: 'torque-public', sha: 'abc', suite: 'gate',
        holder: { host: 'h', pid: 1, user: 'u' },
      }));
    });
    await new Promise((r) => setTimeout(r, 50));
    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'active.json'), 'utf8'));
    expect(persisted.locks).toHaveLength(1);
  });

  it('on restart, reconciles stale active.json by clearing it', async () => {
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'state', 'active.json'), JSON.stringify({
      version: 1,
      locks: [{
        lock_id: 'old', project: 'p', sha: 'a', suite: 'gate',
        holder: { host: 'h', pid: 99, user: 'u' },
        created_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        output_buffer: '', crashed: false,
      }],
    }));

    daemon = await startDaemon({
      port: 0,
      state_dir: path.join(tmpDir, 'state'),
      results_dir: path.join(tmpDir, 'results'),
    });
    const res = await get(daemon.port, '/active');
    expect(res.body.active).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-integration.test.js`

Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

Create `server/coord/index.js`:

```javascript
'use strict';
const path = require('path');
const os = require('os');
const { loadConfig, DEFAULTS } = require('./config');
const { createStateStore } = require('./state');
const { createResultStore } = require('./result-store');
const { createServer } = require('./http');
const { startReaper } = require('./reaper');

function resolveDirs(config) {
  const home = os.homedir();
  const root = path.join(home, '.torque-coord');
  return {
    state_dir: config.state_dir || path.join(root, 'state'),
    results_dir: config.results_dir || path.join(root, 'results'),
  };
}

async function startDaemon(overrides = {}) {
  const fileConfig = overrides.config_file ? loadConfig(overrides.config_file) : { ...DEFAULTS };
  const config = { ...fileConfig, ...overrides };
  const { state_dir, results_dir } = resolveDirs(config);

  const state = createStateStore({
    max_concurrent_runs: config.max_concurrent_runs,
    persist_path: path.join(state_dir, 'active.json'),
  });
  const reconciled = state.restoreFromFile();
  if (reconciled.crashed_count > 0) {
    process.stdout.write(`[coord] reconciled ${reconciled.crashed_count} stale locks across restart\n`);
  }

  const results = createResultStore({
    results_dir,
    result_ttl_seconds: config.result_ttl_seconds,
  });

  const server = createServer({ state, results, config });
  const reaper = startReaper(state, {
    stale_lock_threshold_ms: config.stale_lock_threshold_ms,
    reaper_tick_ms: config.reaper_tick_ms,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bind, () => resolve());
  });

  const port = server.address().port;
  process.stdout.write(`[coord] listening on ${config.bind}:${port}\n`);

  async function stop() {
    reaper.stop();
    await new Promise((r) => server.close(r));
  }

  return { port, stop, state, results, server };
}

if (require.main === module) {
  const configFile = process.env.TORQUE_COORD_CONFIG || null;
  startDaemon({ config_file: configFile }).catch((err) => {
    process.stderr.write(`[coord] failed to start: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { startDaemon };
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-integration.test.js`

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/coord/index.js server/tests/coord-integration.test.js
git commit -m "feat(coord): daemon entry — wires state + results + http + reaper"
```

---

## Task 8: Daemon launcher script

**Files:**
- Create: `bin/torque-coord`

- [ ] **Step 1: Create the launcher**

Create `bin/torque-coord` (executable shell script):

```bash
#!/usr/bin/env bash
# torque-coord — launch the Remote Test Coordinator daemon.
#
# Run modes:
#   torque-coord                   # foreground (logs to stdout)
#   TORQUE_COORD_CONFIG=path.json torque-coord
#
# Production: invoked by Windows Task Scheduler (TorqueCoord task) on the
# workstation. The Task Scheduler entry redirects stdout/stderr to a log
# file under the user's profile.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$PROJECT_ROOT/server/coord/index.js"

if [[ ! -f "$ENTRY" ]]; then
  echo "ERROR: entry point not found: $ENTRY" >&2
  exit 1
fi

exec node "$ENTRY" "$@"
```

Make it executable:

```bash
chmod +x bin/torque-coord
```

- [ ] **Step 2: Smoke test — launch + curl /health + stop**

```bash
bin/torque-coord &
DAEMON_PID=$!
sleep 1
curl -s http://127.0.0.1:9395/health
# Expect: {"ok":true,"protocol_version":1,...}
kill $DAEMON_PID
```

- [ ] **Step 3: Commit**

```bash
git add bin/torque-coord
git commit -m "feat(coord): bin/torque-coord launcher script"
```

---

## Task 9: Coord client CLI (Node, called by bash)

**Files:**
- Create: `bin/torque-coord-client`
- Test: `server/tests/coord-client-cli.test.js`

A small Node CLI that wraps the daemon HTTP API with bash-friendly stdout JSON output. `bin/torque-remote` shells out to it. Implements the 2-second connect timeout + degradation policy.

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-client-cli.test.js`:

```javascript
'use strict';
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { describe, it, expect, afterEach } = require('vitest');

const CLIENT = path.join(__dirname, '..', '..', 'bin', 'torque-coord-client');

function makeStubDaemon(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runClient(args, port = 9395) {
  return spawnSync('node', [CLIENT, ...args], {
    env: { ...process.env, TORQUE_COORD_PORT: String(port), TORQUE_COORD_HOST: '127.0.0.1' },
    encoding: 'utf8',
  });
}

describe('torque-coord-client CLI', () => {
  let stub;

  afterEach(async () => {
    if (stub) {
      await new Promise((r) => stub.server.close(r));
      stub = null;
    }
  });

  it('health subcommand prints JSON from /health and exits 0', async () => {
    stub = await makeStubDaemon((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, protocol_version: 1 }));
        return;
      }
      res.writeHead(404).end();
    });
    const result = runClient(['health'], stub.port);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.ok).toBe(true);
  });

  it('acquire subcommand POSTs and prints response on 200', async () => {
    stub = await makeStubDaemon((req, res) => {
      if (req.url === '/acquire' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ acquired: true, lock_id: 'xyz' }));
        return;
      }
      res.writeHead(404).end();
    });
    const result = runClient([
      'acquire',
      '--project', 'torque-public', '--sha', 'abc',
      '--suite', 'gate',
    ], stub.port);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ acquired: true, lock_id: 'xyz' });
  });

  it('exits with code 2 and prints status:"unreachable" when daemon is down', () => {
    const result = runClient(['health'], 1);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'unreachable' });
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-client-cli.test.js`

Expected: FAIL — script missing.

- [ ] **Step 3: Write the CLI**

Create `bin/torque-coord-client` (executable):

```javascript
#!/usr/bin/env node
'use strict';
const http = require('http');

const HOST = process.env.TORQUE_COORD_HOST || '127.0.0.1';
const PORT = parseInt(process.env.TORQUE_COORD_PORT || '9395', 10);
const CONNECT_TIMEOUT_MS = 2000;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function unreachable(detail) {
  emit({ status: 'unreachable', detail });
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function request({ method, path, body }) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST, port: PORT, path, method,
      headers: { 'content-type': 'application/json' },
      timeout: CONNECT_TIMEOUT_MS,
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_e) { /* not json */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const [, , subcommand, ...rest] = process.argv;
  const args = parseArgs(rest);

  try {
    switch (subcommand) {
      case 'health': {
        const r = await request({ method: 'GET', path: '/health' });
        emit(r.body);
        process.exit(r.status === 200 ? 0 : 1);
        break;
      }
      case 'acquire': {
        const body = {
          project: args.project,
          sha: args.sha,
          suite: args.suite,
          holder: {
            host: args.host || require('os').hostname(),
            pid: parseInt(args.pid || String(process.pid), 10),
            user: args.user || (process.env.USER || process.env.USERNAME || 'unknown'),
          },
        };
        const r = await request({ method: 'POST', path: '/acquire', body });
        emit(r.body);
        process.exit(r.status === 200 ? 0 : (r.status === 202 ? 3 : 1));
        break;
      }
      case 'heartbeat': {
        const body = { lock_id: args['lock-id'], log_chunk: args.log || '' };
        const r = await request({ method: 'POST', path: '/heartbeat', body });
        emit(r.body);
        process.exit(r.status === 200 ? 0 : 1);
        break;
      }
      case 'release': {
        const body = {
          lock_id: args['lock-id'],
          exit_code: parseInt(args.exit || '0', 10),
          suite_status: args.status || 'unknown',
          output_tail: args.tail || '',
        };
        const r = await request({ method: 'POST', path: '/release', body });
        emit(r.body);
        process.exit(r.status === 200 ? 0 : 1);
        break;
      }
      case 'results': {
        const r = await request({
          method: 'GET',
          path: `/results/${encodeURIComponent(args.project)}/${encodeURIComponent(args.sha)}/${encodeURIComponent(args.suite)}`,
        });
        if (r.status === 404) { emit({ hit: false }); process.exit(0); }
        emit(r.body);
        process.exit(r.status === 200 ? 0 : 1);
        break;
      }
      case 'wait': {
        const opts = {
          hostname: HOST, port: PORT,
          path: `/wait/${encodeURIComponent(args['lock-id'])}`,
          method: 'GET',
          headers: { accept: 'text/event-stream' },
          timeout: CONNECT_TIMEOUT_MS,
        };
        await new Promise((resolve, reject) => {
          const req = http.request(opts, (res) => {
            res.setEncoding('utf8');
            let buf = '';
            res.on('data', (chunk) => {
              buf += chunk;
              let idx;
              while ((idx = buf.indexOf('\n\n')) >= 0) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
                if (dataLine) {
                  const parsed = JSON.parse(dataLine.slice(6));
                  emit(parsed);
                  if (parsed.type === 'released' || parsed.type === 'holder_crashed') {
                    res.destroy();
                    resolve();
                  }
                }
              }
            });
            res.on('error', reject);
            res.on('end', resolve);
          });
          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('timeout')));
          req.end();
        });
        process.exit(0);
        break;
      }
      default:
        emit({ status: 'usage_error', detail: `unknown subcommand: ${subcommand || '(none)'}` });
        process.exit(64);
    }
  } catch (err) {
    unreachable(err.message);
  }
}

main();
```

Make it executable:

```bash
chmod +x bin/torque-coord-client
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-client-cli.test.js`

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add bin/torque-coord-client server/tests/coord-client-cli.test.js
git commit -m "feat(coord): bin/torque-coord-client — Node CLI wrapping the coord HTTP API"
```

---

## Task 10: torque-remote integration — `--suite` flag + coord wrapper

**Files:**
- Modify: `bin/torque-remote`
- Test: `server/tests/coord-torque-remote-integration.test.js`

We bracket the existing `torque-remote` work with two coord calls: acquire before sync, release after exec. If the daemon is unreachable (exit 2 from the client CLI), we log a warning and fall through. If acquire returns 202 (held), we run the wait loop and re-acquire after the holder finishes.

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-torque-remote-integration.test.js`:

```javascript
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { describe, it, expect, beforeEach, afterEach } = require('vitest');

const TORQUE_REMOTE = path.join(__dirname, '..', '..', 'bin', 'torque-remote');

function makeConfig(tmpDir) {
  const cfg = path.join(tmpDir, '.torque-remote.json');
  fs.writeFileSync(cfg, JSON.stringify({
    transport: 'local',
    intercept_commands: [],
  }));
  return cfg;
}

function spawnTorqueRemote(args, env, cwd) {
  return spawnSync(TORQUE_REMOTE, args, {
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
}

describe('torque-remote coord integration', () => {
  let tmpDir, stub;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-coord-'));
  });

  afterEach(async () => {
    if (stub) { await new Promise((r) => stub.close(r)); stub = null; }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs the command uncoordinated when daemon is unreachable, with a warning', () => {
    makeConfig(tmpDir);
    const result = spawnTorqueRemote(['--suite', 'gate', 'echo', 'hello'], {
      TORQUE_COORD_PORT: '1',
      HOME: tmpDir,
    }, tmpDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.stderr).toContain('[torque-coord] unreachable');
  });

  it('acquires before run and releases after on the happy path', async () => {
    makeConfig(tmpDir);
    const calls = [];
    stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
        if (req.url === '/acquire' && req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ acquired: true, lock_id: 'lk-1' }));
        } else if (req.url === '/release' && req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ released: true }));
        } else if (req.url === '/heartbeat' && req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const port = stub.address().port;

    const result = spawnTorqueRemote(['--suite', 'gate', 'echo', 'hello'], {
      TORQUE_COORD_PORT: String(port),
      HOME: tmpDir,
    }, tmpDir);

    expect(result.status).toBe(0);
    const acquired = calls.find((c) => c.path === '/acquire');
    const released = calls.find((c) => c.path === '/release');
    expect(acquired).toBeTruthy();
    expect(released).toBeTruthy();
    expect(released.body.exit_code).toBe(0);
  });

  it('on 202 wait_for, follows /wait stream and re-acquires after holder releases', async () => {
    makeConfig(tmpDir);
    let acquireAttempts = 0;
    let waitOpened = false;
    stub = http.createServer((req, res) => {
      if (req.url === '/acquire' && req.method === 'POST') {
        acquireAttempts++;
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (acquireAttempts === 1) {
            res.writeHead(202, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              acquired: false, reason: 'project_held',
              wait_for: 'holder-lock', lock_id: 'mine',
            }));
          } else {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ acquired: true, lock_id: 'mine-2' }));
          }
        });
      } else if (req.url === '/wait/holder-lock' && req.method === 'GET') {
        waitOpened = true;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        });
        res.write('event: progress\ndata: {"type":"progress","elapsed_ms":1000}\n\n');
        setTimeout(() => {
          res.write('event: released\ndata: {"type":"released","exit_code":0}\n\n');
          res.end();
        }, 50);
      } else if (req.url === '/release' || req.url === '/heartbeat') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ released: true, ok: true }));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const port = stub.address().port;

    const result = spawnTorqueRemote(['--suite', 'gate', 'echo', 'after-wait'], {
      TORQUE_COORD_PORT: String(port),
      HOME: tmpDir,
    }, tmpDir);

    expect(result.status).toBe(0);
    expect(waitOpened).toBe(true);
    expect(acquireAttempts).toBe(2);
    expect(result.stdout).toContain('after-wait');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-torque-remote-integration.test.js`

Expected: FAIL — `--suite` flag not recognized or coord wrapper not present.

- [ ] **Step 3: Modify `bin/torque-remote`**

Open `bin/torque-remote` and make these changes:

**3a. Add a default for the new flag near the other defaults (top of the file, after `set -euo pipefail`).** Insert:

```bash
SUITE="${TORQUE_REMOTE_DEFAULT_SUITE:-custom}"
```

**3b. Add `--suite <name>` parsing in the existing argument loop.** Find the loop that handles `--branch` and add an arm for `--suite`:

```bash
    --suite)
      SUITE="$2"
      shift 2
      ;;
```

**3c. Add the coord acquire wrapper just before the existing `case "$TRANSPORT"` dispatch.** Insert the following block BEFORE that line:

```bash
# ─── Coord acquire (best-effort) ────────────────────────────────────────
COORD_ACQUIRED=0
COORD_LOCK_ID=""
COORD_PROJECT="${PROJECT_NAME:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")}"
COORD_SHA="${SYNC_REF:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"

coord_attempt_acquire() {
  local attempt_output rc
  attempt_output=$(node "$SCRIPT_DIR/torque-coord-client" acquire \
    --project "$COORD_PROJECT" --sha "$COORD_SHA" --suite "$SUITE" 2>/dev/null)
  rc=$?
  if [[ $rc -eq 2 ]]; then
    echo "[torque-coord] unreachable, running uncoordinated" >&2
    return 1
  fi
  if [[ $rc -eq 0 ]]; then
    COORD_LOCK_ID=$(echo "$attempt_output" | sed -n 's/.*"lock_id":"\([^"]*\)".*/\1/p')
    COORD_ACQUIRED=1
    return 0
  fi
  if [[ $rc -eq 3 ]]; then
    local wait_for
    wait_for=$(echo "$attempt_output" | sed -n 's/.*"wait_for":"\([^"]*\)".*/\1/p')
    if [[ -n "$wait_for" ]]; then
      echo "[torque-coord] waiting for in-flight run ($wait_for)…" >&2
      node "$SCRIPT_DIR/torque-coord-client" wait --lock-id "$wait_for" >/dev/null 2>&1 || true
      coord_attempt_acquire
      return $?
    fi
    echo "[torque-coord] queued (global semaphore full); waiting…" >&2
    sleep 5
    coord_attempt_acquire
    return $?
  fi
  echo "[torque-coord] unexpected exit $rc, running uncoordinated" >&2
  return 1
}

if [[ "$SUITE" != "custom" ]]; then
  coord_attempt_acquire || true
fi
# ────────────────────────────────────────────────────────────────────────
```

**3d. Add the coord release at the very end of the script.** Replace any existing trailing `exit` with this block:

```bash
# ─── Coord release (best-effort) ────────────────────────────────────────
EXIT_CODE=${EXIT_CODE:-$?}
if [[ "$COORD_ACQUIRED" -eq 1 && -n "$COORD_LOCK_ID" ]]; then
  node "$SCRIPT_DIR/torque-coord-client" release \
    --lock-id "$COORD_LOCK_ID" \
    --exit "$EXIT_CODE" \
    --status "$([[ $EXIT_CODE -eq 0 ]] && echo pass || echo fail)" \
    --tail "" \
    >/dev/null 2>&1 || true
fi
exit "$EXIT_CODE"
# ────────────────────────────────────────────────────────────────────────
```

Note: the existing script captures `EXIT_CODE` from its various transport branches; if it doesn't, capture it explicitly at each `exit` site by replacing `exit N` with `EXIT_CODE=N` and letting the trailing block exit.

- [ ] **Step 4: Run test — verify it passes**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-torque-remote-integration.test.js`

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add bin/torque-remote server/tests/coord-torque-remote-integration.test.js
git commit -m "feat(coord): torque-remote --suite flag + acquire/wait/release wrapper"
```

---

## Task 11: Pre-push hook — pass `--suite gate`

**Files:**
- Modify: the canonical pre-push hook source in the repo (locate via `git ls-files | grep -E 'pre-push|install-hook'`)

`.git/hooks/pre-push` invokes `torque-remote --branch $staging_branch bash -c "$cmd"` twice (once for the test gate, once for the perf gate). Both should pass `--suite gate`.

- [ ] **Step 1: Locate the canonical hook source**

```bash
git ls-files | grep -E 'pre-push|install-hook'
```

If a tracked source exists (e.g., `scripts/pre-push.sh` or `scripts/install-pre-push-hook.sh`), edit that. If only `.git/hooks/pre-push` exists (untracked), create a tracked source `scripts/pre-push.sh` from a copy of the live hook AND create `scripts/install-pre-push-hook.sh` that copies it into place.

- [ ] **Step 2: Modify the hook**

In the canonical source, find the line that runs the parallel gate:

```bash
run_with_flake_retry "Test gate" "torque-remote --branch $staging_branch bash -c $(printf %q "$remote_parallel_cmd")"
```

Change it to:

```bash
run_with_flake_retry "Test gate" "torque-remote --suite gate --branch $staging_branch bash -c $(printf %q "$remote_parallel_cmd")"
```

Find the perf-gate line:

```bash
PERF_OUT=$(torque-remote --branch "$staging_branch" bash -c "cd server && node perf/run-perf.js" 2>&1)
```

Change it to:

```bash
PERF_OUT=$(torque-remote --suite gate --branch "$staging_branch" bash -c "cd server && node perf/run-perf.js" 2>&1)
```

- [ ] **Step 3: Re-install the hook into `.git/hooks/pre-push`**

```bash
bash scripts/install-pre-push-hook.sh
# OR if you cp'd manually:
cp scripts/pre-push.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

- [ ] **Step 4: Manual verification**

```bash
git push origin HEAD --dry-run
# Expect the hook to fire and the staged command to include --suite gate.
# If the daemon isn't installed yet on the workstation, expect
# "[torque-coord] unreachable, running uncoordinated" but the gate still
# completes.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/pre-push.sh scripts/install-pre-push-hook.sh   # whichever you touched
git commit -m "feat(coord): pre-push hook passes --suite gate to torque-remote"
```

---

## Task 12: Workstation install script + ops doc

**Files:**
- Create: `scripts/install-torque-coord.ps1`
- Create: `docs/torque-coord.md`

The daemon needs to be installed on the workstation as a Windows Task Scheduler entry. Mirrors the pattern documented for `peek_server` in CLAUDE.md.

- [ ] **Step 1: Create the PowerShell installer**

Create `scripts/install-torque-coord.ps1`:

```powershell
<#
.SYNOPSIS
  Install torque-coord as a Windows Scheduled Task on the workstation.

.DESCRIPTION
  Creates a Scheduled Task named "TorqueCoord" that:
    - Runs at user logon
    - Restarts on failure with backoff
    - Captures stdout/stderr to %USERPROFILE%\.torque-coord\logs\torque-coord.log
    - Invokes node <repo>\server\coord\index.js

.PARAMETER RepoPath
  Path to the torque-public checkout on the workstation. Default: C:\trt\torque-public

.PARAMETER NodePath
  Path to node.exe. Default: from PATH.
#>

param(
  [string]$RepoPath = "C:\trt\torque-public",
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"

if (-not $NodePath) {
  $NodePath = (Get-Command node).Source
}

$entry = Join-Path $RepoPath "server\coord\index.js"
if (-not (Test-Path $entry)) {
  Write-Error "Entry point not found: $entry"
  exit 1
}

$logDir = Join-Path $env:USERPROFILE ".torque-coord\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir "torque-coord.log"

$action = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument "/c `"`"$NodePath`" `"$entry`" >> `"$logFile`" 2>&1`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 365)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask `
  -TaskName "TorqueCoord" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Torque Remote Test Coordinator daemon (port 9395, localhost only)" `
  -Force | Out-Null

Write-Host "Installed scheduled task 'TorqueCoord'."
Write-Host "Log: $logFile"
Write-Host "Start now: schtasks /run /tn TorqueCoord"
Write-Host "Health check: curl http://127.0.0.1:9395/health"
```

- [ ] **Step 2: Create the ops doc**

Create `docs/torque-coord.md`:

```markdown
# torque-coord — Operations

The Remote Test Coordinator daemon. Runs on the test workstation and
serializes concurrent `torque-remote` invocations to prevent CPU/memory
contention crashes.

## Install (workstation)

Run as the user that owns the test workstation environment:

    powershell -ExecutionPolicy Bypass -File scripts\install-torque-coord.ps1

This creates a Scheduled Task `TorqueCoord` that auto-starts at logon and
restarts on failure. Logs at `%USERPROFILE%\.torque-coord\logs\torque-coord.log`.

## Start / stop / restart

    schtasks /run /tn TorqueCoord       # start
    schtasks /end /tn TorqueCoord       # stop
    schtasks /change /tn TorqueCoord /disable
    schtasks /change /tn TorqueCoord /enable

## Health check

    curl http://127.0.0.1:9395/health
    # {"ok":true,"protocol_version":1,"uptime_ms":...,"active_count":N}

## Active locks

    curl http://127.0.0.1:9395/active

## Troubleshoot

- **`[torque-coord] unreachable` in `torque-remote` output:** daemon not
  running. Check `schtasks /query /tn TorqueCoord` and the log file.
- **Port 9395 in use:** change `port` in `~/.torque-coord/state/config.json`
  and restart. Update `TORQUE_COORD_PORT` for `bin/torque-coord-client`
  callers if you change the default.
- **Stale lock won't release:** check the daemon log for reaper activity.
  Heavy hammer: `schtasks /end /tn TorqueCoord && schtasks /run /tn TorqueCoord` —
  on restart the daemon clears the active.json (treats all entries as crashed).

## Coordination is best-effort

If the daemon is down, `torque-remote` falls through to today's
uncoordinated behavior. The 2-second connect timeout means a misconfigured
or stopped daemon does NOT block test execution; it only logs a warning.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/install-torque-coord.ps1 docs/torque-coord.md
git commit -m "docs(coord): Windows install script + ops runbook"
```

---

## Task 13: End-to-end smoke test

**Files:**
- Create: `scripts/test-coord-e2e.sh`

A manual two-session smoke test for use after Phase 1 lands and the daemon is installed on the workstation. NOT part of the pre-push gate (would be circular).

- [ ] **Step 1: Create the smoke test**

Create `scripts/test-coord-e2e.sh`:

```bash
#!/usr/bin/env bash
# torque-coord end-to-end smoke test.
#
# Runs two `torque-remote --suite gate` invocations in parallel. The second
# one should observe the first as the holder, wait, and re-acquire after
# it finishes. Total wallclock should be roughly 2× the first run's
# duration (Phase 1 — no result sharing yet).

set -euo pipefail
cd "$(dirname "$0")/.."

REF="${1:-HEAD}"
echo "[e2e] Target ref: $REF"

OUT1=$(mktemp)
OUT2=$(mktemp)

start=$(date +%s)

(time torque-remote --suite gate --branch "$REF" bash -c "echo 'session A' && sleep 30") \
  > "$OUT1" 2>&1 &
PID1=$!

sleep 2

(time torque-remote --suite gate --branch "$REF" bash -c "echo 'session B' && sleep 30") \
  > "$OUT2" 2>&1 &
PID2=$!

wait $PID1
wait $PID2

end=$(date +%s)
duration=$((end - start))

echo "[e2e] Total wallclock: ${duration}s (expected ~60s if serialized, ~30s if parallel)"
echo
echo "── Session A ────────────────────────────────────────────"
cat "$OUT1"
echo
echo "── Session B ────────────────────────────────────────────"
cat "$OUT2"

rm -f "$OUT1" "$OUT2"

if [[ $duration -lt 50 ]]; then
  echo "[e2e] FAIL: sessions appear to have run in parallel (no serialization)"
  exit 1
fi

echo "[e2e] PASS: serialization observed."
```

Make it executable:

```bash
chmod +x scripts/test-coord-e2e.sh
```

- [ ] **Step 2: Commit**

```bash
git add scripts/test-coord-e2e.sh
git commit -m "test(coord): manual end-to-end smoke for two-session serialization"
```

- [ ] **Step 3: Run the smoke (post-deploy, manual)**

After installing the daemon on the workstation:

```bash
scripts/test-coord-e2e.sh
```

Expected: PASS with wallclock around 60s (each 30s sleep serialized).

---

## Task 14: Cutover — merge worktree to main

**Files:** none new — git operation.

- [ ] **Step 1: Run the local server suite as final pre-flight**

```bash
cd server && node node_modules/vitest/vitest.mjs run tests/coord-*.test.js
```

Expected: all coord-* tests pass.

- [ ] **Step 2: Run the cutover script from the worktree's parent directory**

```bash
# From the main checkout (parent of the worktree):
scripts/worktree-cutover.sh remote-test-coord
```

The cutover script merges `feat/remote-test-coord` to main, drains TORQUE, and restarts. The pre-push gate runs as part of the merge — first push that exercises `--suite gate`.

- [ ] **Step 3: Install the daemon on the workstation**

From the main checkout, after cutover:

```bash
ssh <workstation-user>@<workstation-host> 'powershell -ExecutionPolicy Bypass -File C:\trt\torque-public\scripts\install-torque-coord.ps1'
ssh <workstation-user>@<workstation-host> 'schtasks /run /tn TorqueCoord'
ssh <workstation-user>@<workstation-host> 'curl -s http://127.0.0.1:9395/health'
```

Expected: `{"ok":true,"protocol_version":1,...}`.

(Replace `<workstation-user>@<workstation-host>` with the values from `~/.torque-remote.local.json`.)

- [ ] **Step 4: Run the e2e smoke**

```bash
scripts/test-coord-e2e.sh
```

Expected: PASS.

---

## Spec coverage check

| Spec section | Implementing task |
|---|---|
| §4 Architecture (port, bind, supervision, state layout) | Tasks 1, 7, 12 |
| §5.1 Daemon HTTP API (7 endpoints) | Task 6 |
| §5.2 `bin/torque-remote` `--suite` + wrapper | Task 10 |
| §5.3 Pre-push hook `--suite gate` | Task 11 |
| §5.4 Suite registry config | Task 1 (defaults); config.json hot-reload deferred to Phase 2 |
| §5.5 Dashboard mirror | **Phase 3** — NOT in this plan |
| §5.6 Cross-project CPU governor (semaphore) | Task 2 (basic semaphore in state store), Task 6 (HTTP); wait-transition deferred to Phase 2 |
| §5.7 Result-store invalidation tied to package-lock | **Phase 2** — write-side stub only in Task 4 |
| §6 Data flow paths 1, 6, 7 | Tasks 6, 7, 10 |
| §6 Data flow paths 2, 3, 4, 5 | **Phase 2** (consume on share-eligibility, queue position events) |
| §7 Error handling — daemon down | Task 9 (CLI exit 2), Task 10 (bash fallthrough) |
| §7 Error handling — workstation reboot | Task 3 (state.restoreFromFile clears active.json) |
| §7 Error handling — heartbeat retries | Task 9 has single attempt; retries deferred — Phase 1 ships best-effort heartbeat |
| §8 Testing | Tasks 1–10 each include their own tests; Task 13 is e2e |
| §9 Phase 1 ship list | This plan |

**Phase 1 explicitly excludes**, per spec §9: result-store reads, `consumed` SSE events, `package_lock_hashes` field on release, queue-position SSE events, heartbeat retry/backoff, dashboard mirror, MCP `coord_status` tool. Each will be a follow-up plan when Phase 2 / Phase 3 lands.
