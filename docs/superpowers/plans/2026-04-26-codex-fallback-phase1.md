# Codex Fallback for EXECUTE — Phase 1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundation layer for Codex unavailability detection: DB-persisted circuit-breaker state, manual trip/untrip operator controls, per-project `codex_fallback_policy` field, `parked_codex_unavailable` work-item state, and park-resume on circuit recovery. After this phase: when Codex goes down, the factory loop stops erroring and starts explicitly parking work that depends on Codex; operators see breaker state in dashboard and CLI; resume happens automatically when Codex returns.

**Architecture:** Extends the existing `CircuitBreaker` class (`server/execution/circuit-breaker.js`, already wired into the DI container as `circuitBreaker`) with DB persistence, Codex-aware error-code recording, and manual trip/untrip API. Adds new `factory_work_items.status` values and a park-resume handler subscribed to the existing `circuit:recovered` event. Adds two new MCP handlers (`configure-codex-breaker`, `configure-codex-policy`) plus their slash command surface.

**Tech Stack:** Node.js + better-sqlite3 (server); React (dashboard panel); vitest for tests; existing event-bus + DI container patterns; `torque-remote` for test execution.

**Phase scope:** Components A + F + G + H from the design spec at `docs/superpowers/specs/2026-04-26-codex-fallback-execute-design.md`. Component B (eligibility classifier), D (failover routing template), C (auto-augmenter), E (decompose-on-park) are explicitly OUT of this phase.

**Prerequisites:**
- Worktree: `.worktrees/feat-codex-fallback-phase1` (already created on branch `feat/codex-fallback-phase1`).
- Spec: `docs/superpowers/specs/2026-04-26-codex-fallback-execute-design.md` (lives in this worktree).
- TORQUE running on main during development; this worktree's tests run remote via `torque-remote` (push branch first per `feedback_push_before_remote_test`).

---

## File Map

**Created:**
- `server/db/provider-circuit-breaker-store.js` — DB read/write for breaker state (~80 lines).
- `server/factory/park-resume-handler.js` — listens to `circuit:recovered`, resumes parked items (~60 lines).
- `server/tests/provider-circuit-breaker-store.test.js`
- `server/tests/park-resume-handler.test.js`
- `server/tests/factory-intake-park.test.js`
- `server/tests/factory-intake-policy.test.js`
- `server/tests/loop-controller-codex-fallback.test.js`
- `server/tests/container-circuit-breaker.test.js`
- `server/tests/container-park-resume.test.js`
- `server/tests/integration/codex-fallback-phase1-smoke.test.js`
- `dashboard/src/pages/Operations/CodexBreakerPanel.jsx` (or matching project convention)

**Modified:**
- `server/db/schema-tables.js` — add `provider_circuit_breaker` table create.
- `server/execution/circuit-breaker.js` — add persistence layer, manual trip/untrip API, Codex-aware failure-code path.
- `server/tests/circuit-breaker.test.js` — extend tests for new methods.
- `server/container.js` — wire `providerCircuitBreakerStore`; pass to `createCircuitBreaker`; register `parkResumeHandler`.
- `server/handlers/circuit-breaker-handlers.js` — add `handleTripCodexBreaker`, `handleUntripCodexBreaker`, `handleConfigureCodexPolicy`.
- `server/tests/circuit-breaker-handlers.test.js` — test new handlers.
- `server/tool-defs/circuit-breaker-defs.js` — add new tool definitions.
- `server/tool-annotations.js` — add annotations for new tools.
- `server/tools.js` — register new handlers in dispatcher.
- `server/factory/loop-controller.js` — PRIORITIZE branch reads breaker + policy, parks selected items in `wait_for_codex` mode.
- `server/db/factory-intake.js` — accessor for `codex_fallback_policy` from `config_json`; helper to set work item status to parked.
- `.claude/commands/torque-config.md` — extend with `codex-breaker` and `codex-policy` subcommands.
- `dashboard/src/pages/Operations/index.jsx` (or routing file) — add Codex Breaker panel route.

---

## Conventions for this plan

- **Tests live next to the source under `server/tests/`** (same pattern as existing `circuit-breaker.test.js`).
- **Test runner:** `torque-remote npx vitest run <path>` from the worktree directory. Do NOT run vitest locally (per `feedback_push_before_remote_test`); push branch first if running remote tests.
- **DI usage:** new code accesses services via `defaultContainer.get(...)` per project DI rules; never `require('./database')`.
- **DB API:** test fixtures use `db.prepare(SQL).run(args)`; the schema-tables migration uses the existing `CREATE TABLE IF NOT EXISTS` pattern in that file. Avoid the multi-statement DDL helper in test files.
- **Commit style:** one concern per commit (`feedback_atomic_commits`). Prefix tasks with `feat(codex-fallback):`, `test(codex-fallback):`, etc. Each task ends with a commit.
- **Worktree discipline:** all commits land on `feat/codex-fallback-phase1`. Never commit to main directly. Push to origin before remote tests.

---

## Task 1: Add `provider_circuit_breaker` schema table

**Files:**
- Modify: `server/db/schema-tables.js` (add table create alongside existing tables)
- Create: `server/tests/provider-circuit-breaker-store.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/provider-circuit-breaker-store.test.js`:

```javascript
'use strict';
/* global describe, it, expect, beforeEach */

const Database = require('better-sqlite3');
const { ensureSchema } = require('../db/schema-tables');

describe('provider_circuit_breaker schema', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
  });

  it('creates provider_circuit_breaker table with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info('provider_circuit_breaker')").all();
    const colNames = cols.map((c) => c.name).sort();
    expect(colNames).toEqual([
      'last_canary_at',
      'last_canary_status',
      'provider_id',
      'state',
      'trip_reason',
      'tripped_at',
      'untripped_at',
    ]);
  });

  it('provider_id is the primary key', () => {
    const cols = db.prepare("PRAGMA table_info('provider_circuit_breaker')").all();
    const pk = cols.find((c) => c.pk === 1);
    expect(pk.name).toBe('provider_id');
  });
});
```

- [ ] **Step 2: Run the test, confirm failure**

Push branch: `git push -u origin feat/codex-fallback-phase1`
Run: `torque-remote npx vitest run server/tests/provider-circuit-breaker-store.test.js`
Expected: FAIL — `no such table: provider_circuit_breaker`.

- [ ] **Step 3: Add the table to schema-tables.js**

In `server/db/schema-tables.js`, locate the section that creates other infrastructure tables (search for `CREATE TABLE IF NOT EXISTS factory_projects` to anchor a logical insertion point — the new table is provider infrastructure, similar in scope). Use the same `db.prepare(...).run()` shape that the file uses elsewhere, or match whatever the surrounding pattern is. Add a single statement that creates this table:

```javascript
db.prepare(`
  CREATE TABLE IF NOT EXISTS provider_circuit_breaker (
    provider_id        TEXT PRIMARY KEY,
    state              TEXT NOT NULL DEFAULT 'CLOSED',
    tripped_at         TEXT,
    untripped_at       TEXT,
    trip_reason        TEXT,
    last_canary_at     TEXT,
    last_canary_status TEXT
  )
`).run();
```

(If the surrounding code uses `.exec()` for the DDL pattern, follow that — both are valid.)

Note: timestamps use TEXT (ISO strings), matching the convention used by `factory_work_items` (`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).

- [ ] **Step 4: Run the test, confirm pass**

Run: `torque-remote npx vitest run server/tests/provider-circuit-breaker-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema-tables.js server/tests/provider-circuit-breaker-store.test.js
git commit -m "feat(codex-fallback): add provider_circuit_breaker schema table"
```

---

## Task 2: Build `provider-circuit-breaker-store.js` (DB read/write)

**Files:**
- Create: `server/db/provider-circuit-breaker-store.js`
- Modify: `server/tests/provider-circuit-breaker-store.test.js` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/provider-circuit-breaker-store.test.js`:

```javascript
const { createProviderCircuitBreakerStore } = require('../db/provider-circuit-breaker-store');

describe('createProviderCircuitBreakerStore', () => {
  let db;
  let store;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    store = createProviderCircuitBreakerStore({ db });
  });

  it('returns null for unknown provider', () => {
    expect(store.getState('codex')).toBeNull();
  });

  it('persists tripped state with reason', () => {
    store.persist('codex', {
      state: 'OPEN',
      trippedAt: '2026-04-26T20:00:00.000Z',
      tripReason: 'manual_disabled',
    });
    expect(store.getState('codex')).toEqual({
      provider_id: 'codex',
      state: 'OPEN',
      tripped_at: '2026-04-26T20:00:00.000Z',
      untripped_at: null,
      trip_reason: 'manual_disabled',
      last_canary_at: null,
      last_canary_status: null,
    });
  });

  it('persist is upsert — repeated calls update existing row', () => {
    store.persist('codex', { state: 'OPEN', trippedAt: '2026-04-26T20:00:00.000Z' });
    store.persist('codex', { state: 'CLOSED', untrippedAt: '2026-04-26T20:30:00.000Z' });
    const row = store.getState('codex');
    expect(row.state).toBe('CLOSED');
    expect(row.untripped_at).toBe('2026-04-26T20:30:00.000Z');
  });

  it('listAll returns rows for all known providers', () => {
    store.persist('codex', { state: 'OPEN' });
    store.persist('groq', { state: 'CLOSED' });
    const rows = store.listAll();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.provider_id).sort()).toEqual(['codex', 'groq']);
  });
});
```

- [ ] **Step 2: Run the tests, confirm failure**

Run: `torque-remote npx vitest run server/tests/provider-circuit-breaker-store.test.js`
Expected: FAIL — `Cannot find module '../db/provider-circuit-breaker-store'`.

- [ ] **Step 3: Implement the store**

Create `server/db/provider-circuit-breaker-store.js`:

```javascript
'use strict';

function createProviderCircuitBreakerStore({ db }) {
  if (!db) throw new Error('createProviderCircuitBreakerStore requires db');

  const upsertStmt = db.prepare(`
    INSERT INTO provider_circuit_breaker
      (provider_id, state, tripped_at, untripped_at, trip_reason, last_canary_at, last_canary_status)
    VALUES (@provider_id, @state, @tripped_at, @untripped_at, @trip_reason, @last_canary_at, @last_canary_status)
    ON CONFLICT(provider_id) DO UPDATE SET
      state              = COALESCE(excluded.state, provider_circuit_breaker.state),
      tripped_at         = COALESCE(excluded.tripped_at, provider_circuit_breaker.tripped_at),
      untripped_at       = COALESCE(excluded.untripped_at, provider_circuit_breaker.untripped_at),
      trip_reason        = COALESCE(excluded.trip_reason, provider_circuit_breaker.trip_reason),
      last_canary_at     = COALESCE(excluded.last_canary_at, provider_circuit_breaker.last_canary_at),
      last_canary_status = COALESCE(excluded.last_canary_status, provider_circuit_breaker.last_canary_status)
  `);

  const getStmt = db.prepare(`SELECT * FROM provider_circuit_breaker WHERE provider_id = ?`);
  const listStmt = db.prepare(`SELECT * FROM provider_circuit_breaker`);

  return {
    persist(providerId, patch = {}) {
      upsertStmt.run({
        provider_id: providerId,
        state: patch.state ?? null,
        tripped_at: patch.trippedAt ?? null,
        untripped_at: patch.untrippedAt ?? null,
        trip_reason: patch.tripReason ?? null,
        last_canary_at: patch.lastCanaryAt ?? null,
        last_canary_status: patch.lastCanaryStatus ?? null,
      });
    },
    getState(providerId) {
      return getStmt.get(providerId) ?? null;
    },
    listAll() {
      return listStmt.all();
    },
  };
}

module.exports = { createProviderCircuitBreakerStore };
```

- [ ] **Step 4: Run the tests, confirm pass**

Run: `torque-remote npx vitest run server/tests/provider-circuit-breaker-store.test.js`
Expected: PASS (4 tests in this describe block, plus 2 from Task 1 = 6 total).

- [ ] **Step 5: Commit**

```bash
git add server/db/provider-circuit-breaker-store.js server/tests/provider-circuit-breaker-store.test.js
git commit -m "feat(codex-fallback): add provider-circuit-breaker DB store"
```

---

## Task 3: Extend CircuitBreaker with persistence (load on init, write-through on state change)

**Files:**
- Modify: `server/execution/circuit-breaker.js`
- Modify: `server/tests/circuit-breaker.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/circuit-breaker.test.js` (at the bottom, before `});` of the outer `describe`):

```javascript
  describe('persistence', () => {
    let store;
    beforeEach(() => {
      const persisted = new Map();
      store = {
        getState: vi.fn((id) => persisted.get(id) ?? null),
        persist: vi.fn((id, patch) => {
          persisted.set(id, { provider_id: id, ...persisted.get(id), ...patch });
        }),
        listAll: vi.fn(() => Array.from(persisted.values())),
      };
    });

    it('loads persisted OPEN state on construction', () => {
      store.persist('codex', {
        state: 'OPEN',
        trippedAt: new Date('2026-04-26T19:55:00.000Z').toISOString(),
        tripReason: 'manual_disabled',
      });
      const breaker = createCircuitBreaker({ eventBus, config: TEST_CONFIG, store });
      expect(breaker.getState('codex').state).toBe(STATES.OPEN);
      expect(store.listAll).toHaveBeenCalled();
    });

    it('writes through to store on trip', () => {
      const breaker = createCircuitBreaker({ eventBus, config: TEST_CONFIG, store });
      tripCircuit(breaker, 'codex');
      expect(store.persist).toHaveBeenCalledWith('codex', expect.objectContaining({
        state: 'OPEN',
      }));
    });

    it('survives breaker recreation (state loaded from store)', () => {
      const breaker1 = createCircuitBreaker({ eventBus, config: TEST_CONFIG, store });
      tripCircuit(breaker1, 'codex');
      const breaker2 = createCircuitBreaker({ eventBus, config: TEST_CONFIG, store });
      expect(breaker2.getState('codex').state).toBe(STATES.OPEN);
    });
  });
```

- [ ] **Step 2: Run the test, confirm failure**

Run: `torque-remote npx vitest run server/tests/circuit-breaker.test.js`
Expected: FAIL — store argument not accepted; persisted state not loaded.

- [ ] **Step 3: Modify CircuitBreaker class**

Edit `server/execution/circuit-breaker.js`. Modify the constructor to accept and load from the store:

```javascript
class CircuitBreaker {
  constructor({ eventBus, config, store }) {
    this._eventBus = eventBus || createNoopEventBus();
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._providers = new Map();
    this._store = store || null;

    if (this._store && typeof this._store.listAll === 'function') {
      for (const row of this._store.listAll()) {
        const entry = createProviderState(this._config.baseRecoveryTimeoutMs);
        entry.state = row.state;
        entry.trippedAt = row.tripped_at ? new Date(row.tripped_at).getTime() : null;
        // consecutiveFailures intentionally not persisted — counter resets on restart.
        this._providers.set(row.provider_id, entry);
      }
    }
  }

  // ... existing methods ...

  _persist(provider, patch) {
    if (!this._store) return;
    try {
      this._store.persist(provider, patch);
    } catch (err) {
      // Don't let persistence errors break the breaker.
    }
  }
}
```

In `_tripCircuit`, after `this._emit('circuit:tripped', ...)`, add:

```javascript
this._persist(provider, {
  state: 'OPEN',
  trippedAt: new Date(entry.trippedAt).toISOString(),
});
```

In `recordSuccess`, where the state transitions to CLOSED (search for `entry.state = STATES.CLOSED`), add after the assignment:

```javascript
this._persist(provider, {
  state: 'CLOSED',
  untrippedAt: new Date().toISOString(),
});
```

Update the factory function:

```javascript
function createCircuitBreaker({ eventBus, config, store } = {}) {
  return new CircuitBreaker({ eventBus, config, store });
}
```

- [ ] **Step 4: Run the test, confirm pass**

Run: `torque-remote npx vitest run server/tests/circuit-breaker.test.js`
Expected: PASS (existing tests + 3 new persistence tests).

- [ ] **Step 5: Commit**

```bash
git add server/execution/circuit-breaker.js server/tests/circuit-breaker.test.js
git commit -m "feat(codex-fallback): persist circuit-breaker state to DB"
```

---

## Task 4: Add Codex-aware error-code path to CircuitBreaker

**Files:**
- Modify: `server/execution/circuit-breaker.js`
- Modify: `server/tests/circuit-breaker.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/circuit-breaker.test.js`:

```javascript
  describe('recordFailureByCode', () => {
    it('classifies quota_exceeded as rate_limit category', () => {
      const breaker = createCircuitBreaker({ eventBus, config: TEST_CONFIG });
      breaker.recordFailureByCode('codex', { errorCode: 'quota_exceeded' });
      expect(breaker.getState('codex').lastFailureCategory).toBe('rate_limit');
    });

    it('classifies auth_failed as auth category', () => {
      const breaker = createCircuitBreaker({ eventBus, config: TEST_CONFIG });
      breaker.recordFailureByCode('codex', { errorCode: 'auth_failed' });
      expect(breaker.getState('codex').lastFailureCategory).toBe('auth');
    });

    it('classifies sentinel exit codes as resource', () => {
      const breaker = createCircuitBreaker({ eventBus, config: TEST_CONFIG });
      breaker.recordFailureByCode('codex', { exitCode: -101 });
      expect(breaker.getState('codex').lastFailureCategory).toBe('resource');
    });

    it('3 codex-coded failures trip the circuit', () => {
      const breaker = createCircuitBreaker({ eventBus, config: TEST_CONFIG });
      breaker.recordFailureByCode('codex', { errorCode: 'rate_limit' });
      breaker.recordFailureByCode('codex', { errorCode: 'rate_limit' });
      breaker.recordFailureByCode('codex', { errorCode: 'rate_limit' });
      expect(breaker.getState('codex').state).toBe(STATES.OPEN);
    });
  });
```

- [ ] **Step 2: Run the test, confirm failure**

Run: `torque-remote npx vitest run server/tests/circuit-breaker.test.js`
Expected: FAIL — `breaker.recordFailureByCode is not a function`.

- [ ] **Step 3: Implement `recordFailureByCode`**

In `server/execution/circuit-breaker.js`, add a constant near `FAILURE_PATTERNS`:

```javascript
const ERROR_CODE_TO_CATEGORY = {
  quota_exceeded: 'rate_limit',
  rate_limit: 'rate_limit',
  auth_failed: 'auth',
};

const SENTINEL_EXIT_CODES = new Set([-101, -102, -103]);
```

Refactor `recordFailure(provider, errorOutput)` to extract its body into `_recordFailureWithCategory(provider, category)`. The existing `recordFailure` stays as the public API for callers that pass raw error output:

```javascript
recordFailure(provider, errorOutput) {
  const category = classifyFailure(errorOutput);
  this._recordFailureWithCategory(provider, category);
}

recordFailureByCode(provider, { errorCode, exitCode } = {}) {
  let category = null;
  if (errorCode && ERROR_CODE_TO_CATEGORY[errorCode]) {
    category = ERROR_CODE_TO_CATEGORY[errorCode];
  } else if (typeof exitCode === 'number' && SENTINEL_EXIT_CODES.has(exitCode)) {
    category = 'resource';
  } else {
    category = 'unknown';
  }
  this._recordFailureWithCategory(provider, category);
}

_recordFailureWithCategory(provider, category) {
  // existing body of recordFailure, but using `category` instead of the
  // local `classifyFailure(errorOutput)` call
}
```

- [ ] **Step 4: Run the test, confirm pass**

Run: `torque-remote npx vitest run server/tests/circuit-breaker.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/execution/circuit-breaker.js server/tests/circuit-breaker.test.js
git commit -m "feat(codex-fallback): add recordFailureByCode for normalized provider errors"
```

---

## Task 5: Add manual `trip(provider, reason)` and `untrip(provider, reason)` API

**Files:**
- Modify: `server/execution/circuit-breaker.js`
- Modify: `server/tests/circuit-breaker.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/circuit-breaker.test.js`:

```javascript
  describe('manual trip/untrip', () => {
    it('trip() forces OPEN state with reason', () => {
      const breaker = createCircuitBreaker({ eventBus, config: TEST_CONFIG });
      breaker.trip('codex', 'manual_disabled');
      expect(breaker.getState('codex').state).toBe(STATES.OPEN);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'circuit:tripped',
        expect.objectContaining({ provider: 'codex', reason: 'manual_disabled' })
      );
    });

    it('untrip() forces CLOSED state and resets counters', () => {
      const breaker = createCircuitBreaker({ eventBus, config: TEST_CONFIG });
      tripCircuit(breaker, 'codex');
      breaker.untrip('codex', 'operator_override');
      const state = breaker.getState('codex');
      expect(state.state).toBe(STATES.CLOSED);
      expect(state.consecutiveFailures).toBe(0);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'circuit:recovered',
        expect.objectContaining({ provider: 'codex', reason: 'operator_override' })
      );
    });

    it('trip() persists reason via store', () => {
      const persisted = new Map();
      const store = {
        getState: vi.fn((id) => persisted.get(id) ?? null),
        persist: vi.fn((id, patch) => persisted.set(id, { ...persisted.get(id), ...patch })),
        listAll: vi.fn(() => []),
      };
      const breaker = createCircuitBreaker({ eventBus, config: TEST_CONFIG, store });
      breaker.trip('codex', 'manual_disabled');
      expect(store.persist).toHaveBeenCalledWith('codex', expect.objectContaining({
        state: 'OPEN',
        tripReason: 'manual_disabled',
      }));
    });
  });
```

- [ ] **Step 2: Run the test, confirm failure**

Run: `torque-remote npx vitest run server/tests/circuit-breaker.test.js`
Expected: FAIL — `breaker.trip is not a function`.

- [ ] **Step 3: Implement `trip` and `untrip`**

Add to the `CircuitBreaker` class in `server/execution/circuit-breaker.js`:

```javascript
trip(provider, reason) {
  const normalizedProvider = normalizeProvider(provider);
  const entry = this._getStateEntry(normalizedProvider);
  entry.state = STATES.OPEN;
  entry.trippedAt = Date.now();
  entry.lastFailureCategory = entry.lastFailureCategory || 'manual';
  this._emit('circuit:tripped', {
    provider: normalizedProvider,
    category: entry.lastFailureCategory,
    consecutiveFailures: entry.consecutiveFailures,
    recoveryTimeoutMs: entry.recoveryTimeoutMs,
    reason: reason || 'manual',
  });
  this._persist(normalizedProvider, {
    state: 'OPEN',
    trippedAt: new Date(entry.trippedAt).toISOString(),
    tripReason: reason || 'manual',
  });
}

untrip(provider, reason) {
  const normalizedProvider = normalizeProvider(provider);
  const entry = this._getStateEntry(normalizedProvider);
  entry.state = STATES.CLOSED;
  entry.consecutiveFailures = 0;
  entry.lastFailureCategory = null;
  entry.recoveryTimeoutMs = this._config.baseRecoveryTimeoutMs;
  entry.currentProbeAllowed = false;
  this._emit('circuit:recovered', {
    provider: normalizedProvider,
    reason: reason || 'manual',
  });
  this._persist(normalizedProvider, {
    state: 'CLOSED',
    untrippedAt: new Date().toISOString(),
  });
}
```

- [ ] **Step 4: Run the test, confirm pass**

Run: `torque-remote npx vitest run server/tests/circuit-breaker.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/execution/circuit-breaker.js server/tests/circuit-breaker.test.js
git commit -m "feat(codex-fallback): add manual trip/untrip API to CircuitBreaker"
```

---

## Task 6: Wire `providerCircuitBreakerStore` into the DI container

**Files:**
- Modify: `server/container.js`
- Create: `server/tests/container-circuit-breaker.test.js`

- [ ] **Step 1: Write the failing assertion**

Create `server/tests/container-circuit-breaker.test.js`:

```javascript
'use strict';
/* global describe, it, expect */

const { defaultContainer } = require('../container');

describe('container — circuit breaker wiring', () => {
  it('exposes providerCircuitBreakerStore', () => {
    expect(defaultContainer.has('providerCircuitBreakerStore')).toBe(true);
    const store = defaultContainer.get('providerCircuitBreakerStore');
    expect(typeof store.persist).toBe('function');
    expect(typeof store.getState).toBe('function');
    expect(typeof store.listAll).toBe('function');
  });

  it('circuitBreaker is constructed with the store', () => {
    const cb = defaultContainer.get('circuitBreaker');
    const store = defaultContainer.get('providerCircuitBreakerStore');
    cb.trip('codex-test-trip-only', 'unit_test');
    expect(store.getState('codex-test-trip-only')).toMatchObject({
      state: 'OPEN',
      trip_reason: 'unit_test',
    });
    cb.untrip('codex-test-trip-only', 'unit_test_cleanup');
  });
});
```

- [ ] **Step 2: Run the test, confirm failure**

Run: `torque-remote npx vitest run server/tests/container-circuit-breaker.test.js`
Expected: FAIL — `defaultContainer.has('providerCircuitBreakerStore') === false`.

- [ ] **Step 3: Wire the store into the container**

Read `server/container.js` to find the existing `circuitBreaker` registration. Add a new factory before it:

```javascript
container.factory('providerCircuitBreakerStore', (c) => {
  const { createProviderCircuitBreakerStore } = require('./db/provider-circuit-breaker-store');
  return createProviderCircuitBreakerStore({ db: c.get('db') });
});
```

Then modify the existing `circuitBreaker` factory to accept the store:

```javascript
container.factory('circuitBreaker', (c) => {
  const { createCircuitBreaker } = require('./execution/circuit-breaker');
  return createCircuitBreaker({
    eventBus: c.get('eventBus'),
    store: c.get('providerCircuitBreakerStore'),
  });
});
```

If the container uses a different registration shape (e.g., `register`, `bind`, `set`), match the existing pattern. Read the file first; don't blindly apply this snippet.

- [ ] **Step 4: Run the test, confirm pass**

Run: `torque-remote npx vitest run server/tests/container-circuit-breaker.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/container.js server/tests/container-circuit-breaker.test.js
git commit -m "feat(codex-fallback): wire providerCircuitBreakerStore into DI container"
```

---

## Task 7: Add park work-item statuses + helpers

**Files:**
- Modify: `server/db/factory-intake.js`
- Create: `server/tests/factory-intake-park.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/factory-intake-park.test.js`:

```javascript
'use strict';
/* global describe, it, expect, beforeEach */

const Database = require('better-sqlite3');
const { ensureSchema } = require('../db/schema-tables');
const {
  parkWorkItemForCodex,
  resumeAllCodexParked,
  isParkedStatus,
  PARK_STATUSES,
} = require('../db/factory-intake');

const INSERT_PROJECT = `INSERT INTO factory_projects (id, name, path, brief, trust_level, status)
                       VALUES (?, ?, ?, ?, ?, ?)`;
const INSERT_ITEM = `INSERT INTO factory_work_items (project_id, source, title) VALUES (?, ?, ?)`;

describe('park work-item helpers', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    db.prepare(INSERT_PROJECT).run('p1', 'TestProj', '/tmp', 'brief', 'cautious', 'running');
    db.prepare(INSERT_ITEM).run('p1', 'scout', 'Item A');
    db.prepare(INSERT_ITEM).run('p1', 'scout', 'Item B');
    db.prepare(INSERT_ITEM).run('p1', 'scout', 'Item C');
  });

  it('PARK_STATUSES exposes the new vocabulary', () => {
    expect(PARK_STATUSES).toContain('parked_codex_unavailable');
    expect(PARK_STATUSES).toContain('parked_chain_exhausted');
  });

  it('isParkedStatus identifies park values', () => {
    expect(isParkedStatus('parked_codex_unavailable')).toBe(true);
    expect(isParkedStatus('parked_chain_exhausted')).toBe(true);
    expect(isParkedStatus('pending')).toBe(false);
    expect(isParkedStatus('completed')).toBe(false);
  });

  it('parkWorkItemForCodex sets status', () => {
    parkWorkItemForCodex({ db, workItemId: 1, reason: 'wait_for_codex_policy' });
    const row = db.prepare(`SELECT status FROM factory_work_items WHERE id = 1`).get();
    expect(row.status).toBe('parked_codex_unavailable');
  });

  it('resumeAllCodexParked promotes parked items to pending', () => {
    parkWorkItemForCodex({ db, workItemId: 1, reason: 'a' });
    parkWorkItemForCodex({ db, workItemId: 2, reason: 'b' });
    const resumed = resumeAllCodexParked({ db });
    expect(resumed).toBe(2);
    const rows = db.prepare(`SELECT id, status FROM factory_work_items ORDER BY id`).all();
    expect(rows).toEqual([
      { id: 1, status: 'pending' },
      { id: 2, status: 'pending' },
      { id: 3, status: 'pending' },
    ]);
  });

  it('resumeAllCodexParked does NOT resume parked_chain_exhausted items', () => {
    db.prepare(`UPDATE factory_work_items SET status = 'parked_chain_exhausted' WHERE id = 1`).run();
    parkWorkItemForCodex({ db, workItemId: 2, reason: 'a' });
    const resumed = resumeAllCodexParked({ db });
    expect(resumed).toBe(1);
    const row1 = db.prepare(`SELECT status FROM factory_work_items WHERE id = 1`).get();
    expect(row1.status).toBe('parked_chain_exhausted');
  });
});
```

- [ ] **Step 2: Run the test, confirm failure**

Run: `torque-remote npx vitest run server/tests/factory-intake-park.test.js`
Expected: FAIL — `parkWorkItemForCodex is not a function` (or similar).

- [ ] **Step 3: Implement helpers**

Read `server/db/factory-intake.js` to find the existing `module.exports`. Append new constants and helpers, then merge them into the existing exports object (don't overwrite existing ones):

```javascript
const PARK_STATUSES = Object.freeze([
  'parked_codex_unavailable',
  'parked_chain_exhausted',
]);

function isParkedStatus(status) {
  return PARK_STATUSES.includes(status);
}

function parkWorkItemForCodex({ db, workItemId, reason }) {
  if (!db) throw new Error('parkWorkItemForCodex requires db');
  if (!Number.isInteger(workItemId)) throw new Error('workItemId must be integer');
  db.prepare(`
    UPDATE factory_work_items
    SET status = 'parked_codex_unavailable',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(workItemId);
}

function resumeAllCodexParked({ db }) {
  if (!db) throw new Error('resumeAllCodexParked requires db');
  const result = db.prepare(`
    UPDATE factory_work_items
    SET status = 'pending',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status = 'parked_codex_unavailable'
  `).run();
  return result.changes;
}
```

Add these names to the existing `module.exports = { ... }` at the bottom of the file. Reason discarded (`reason` arg) is intentional in Phase 1 — Phase 2 will use it for decision-log context.

- [ ] **Step 4: Run the test, confirm pass**

Run: `torque-remote npx vitest run server/tests/factory-intake-park.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/factory-intake.js server/tests/factory-intake-park.test.js
git commit -m "feat(codex-fallback): add work-item park status vocabulary and helpers"
```

---

## Task 8: Add `codex_fallback_policy` config_json accessor

**Files:**
- Modify: `server/db/factory-intake.js`
- Create: `server/tests/factory-intake-policy.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/factory-intake-policy.test.js`:

```javascript
'use strict';
/* global describe, it, expect, beforeEach */

const Database = require('better-sqlite3');
const { ensureSchema } = require('../db/schema-tables');
const {
  getCodexFallbackPolicy,
  setCodexFallbackPolicy,
  CODEX_FALLBACK_POLICIES,
} = require('../db/factory-intake');

const INSERT_PROJECT = `INSERT INTO factory_projects (id, name, path, brief, trust_level, status, config_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;

describe('codex_fallback_policy accessor', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    db.prepare(INSERT_PROJECT).run('p1', 'TestProj', '/tmp', 'brief', 'cautious', 'running', '{}');
  });

  it('CODEX_FALLBACK_POLICIES enumerates valid values', () => {
    expect(CODEX_FALLBACK_POLICIES).toEqual(['auto', 'manual', 'wait_for_codex']);
  });

  it('returns "auto" by default when field absent', () => {
    expect(getCodexFallbackPolicy({ db, projectId: 'p1' })).toBe('auto');
  });

  it('reads explicit policy from config_json', () => {
    db.prepare(`UPDATE factory_projects SET config_json = ? WHERE id = ?`)
      .run('{"codex_fallback_policy":"wait_for_codex"}', 'p1');
    expect(getCodexFallbackPolicy({ db, projectId: 'p1' })).toBe('wait_for_codex');
  });

  it('setCodexFallbackPolicy persists value into config_json', () => {
    setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'manual' });
    expect(getCodexFallbackPolicy({ db, projectId: 'p1' })).toBe('manual');
  });

  it('setCodexFallbackPolicy preserves other config_json fields', () => {
    db.prepare(`UPDATE factory_projects SET config_json = ? WHERE id = ?`)
      .run('{"verify_command":"npm test"}', 'p1');
    setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'manual' });
    const row = db.prepare(`SELECT config_json FROM factory_projects WHERE id = 'p1'`).get();
    const cfg = JSON.parse(row.config_json);
    expect(cfg.verify_command).toBe('npm test');
    expect(cfg.codex_fallback_policy).toBe('manual');
  });

  it('rejects invalid policy values', () => {
    expect(() => setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'bogus' }))
      .toThrow(/invalid policy/i);
  });
});
```

- [ ] **Step 2: Run the test, confirm failure**

Run: `torque-remote npx vitest run server/tests/factory-intake-policy.test.js`
Expected: FAIL — `getCodexFallbackPolicy is not a function`.

- [ ] **Step 3: Implement accessors**

Append to `server/db/factory-intake.js`:

```javascript
const CODEX_FALLBACK_POLICIES = Object.freeze(['auto', 'manual', 'wait_for_codex']);
const DEFAULT_CODEX_FALLBACK_POLICY = 'auto';

function getCodexFallbackPolicy({ db, projectId }) {
  if (!db) throw new Error('getCodexFallbackPolicy requires db');
  const row = db.prepare(`SELECT config_json FROM factory_projects WHERE id = ?`).get(projectId);
  if (!row) return DEFAULT_CODEX_FALLBACK_POLICY;
  try {
    const cfg = row.config_json ? JSON.parse(row.config_json) : {};
    if (CODEX_FALLBACK_POLICIES.includes(cfg.codex_fallback_policy)) {
      return cfg.codex_fallback_policy;
    }
  } catch (_) {
    // Fall through to default.
  }
  return DEFAULT_CODEX_FALLBACK_POLICY;
}

function setCodexFallbackPolicy({ db, projectId, policy }) {
  if (!db) throw new Error('setCodexFallbackPolicy requires db');
  if (!CODEX_FALLBACK_POLICIES.includes(policy)) {
    throw new Error(`invalid policy: ${policy}`);
  }
  const row = db.prepare(`SELECT config_json FROM factory_projects WHERE id = ?`).get(projectId);
  if (!row) throw new Error(`project not found: ${projectId}`);
  const cfg = row.config_json ? JSON.parse(row.config_json) : {};
  cfg.codex_fallback_policy = policy;
  db.prepare(`UPDATE factory_projects SET config_json = ? WHERE id = ?`)
    .run(JSON.stringify(cfg), projectId);
}
```

Add `CODEX_FALLBACK_POLICIES`, `DEFAULT_CODEX_FALLBACK_POLICY`, `getCodexFallbackPolicy`, `setCodexFallbackPolicy` to the existing `module.exports`.

- [ ] **Step 4: Run the test, confirm pass**

Run: `torque-remote npx vitest run server/tests/factory-intake-policy.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/factory-intake.js server/tests/factory-intake-policy.test.js
git commit -m "feat(codex-fallback): add codex_fallback_policy config accessor"
```

---

## Task 9: Park-resume handler

**Files:**
- Create: `server/factory/park-resume-handler.js`
- Create: `server/tests/park-resume-handler.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/park-resume-handler.test.js`:

```javascript
'use strict';
/* global describe, it, expect, beforeEach, vi */

const Database = require('better-sqlite3');
const { ensureSchema } = require('../db/schema-tables');
const { parkWorkItemForCodex } = require('../db/factory-intake');
const { createParkResumeHandler } = require('../factory/park-resume-handler');

const INSERT_PROJECT = `INSERT INTO factory_projects (id, name, path, brief, trust_level, status)
                       VALUES (?, ?, ?, ?, ?, ?)`;
const INSERT_ITEM = `INSERT INTO factory_work_items (project_id, source, title) VALUES (?, ?, ?)`;

function makeEventBus() {
  const subscribers = new Map();
  return {
    on(event, fn) {
      const arr = subscribers.get(event) || [];
      arr.push(fn);
      subscribers.set(event, arr);
    },
    emit(event, payload) {
      (subscribers.get(event) || []).forEach((fn) => fn(payload));
    },
  };
}

describe('park-resume-handler', () => {
  let db;
  let eventBus;
  let logger;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    db.prepare(INSERT_PROJECT).run('p1', 'TestProj', '/tmp', 'brief', 'cautious', 'running');
    db.prepare(INSERT_ITEM).run('p1', 'scout', 'A');
    parkWorkItemForCodex({ db, workItemId: 1, reason: 'test' });
    eventBus = makeEventBus();
    logger = { info: vi.fn(), warn: vi.fn() };
  });

  it('subscribes to circuit:recovered and resumes parked items when codex recovers', () => {
    createParkResumeHandler({ db, eventBus, logger });
    eventBus.emit('circuit:recovered', { provider: 'codex', reason: 'canary_succeeded' });
    const row = db.prepare(`SELECT status FROM factory_work_items WHERE id = 1`).get();
    expect(row.status).toBe('pending');
  });

  it('ignores circuit:recovered for non-codex providers', () => {
    createParkResumeHandler({ db, eventBus, logger });
    eventBus.emit('circuit:recovered', { provider: 'groq' });
    const row = db.prepare(`SELECT status FROM factory_work_items WHERE id = 1`).get();
    expect(row.status).toBe('parked_codex_unavailable');
  });

  it('logs resume count', () => {
    createParkResumeHandler({ db, eventBus, logger });
    eventBus.emit('circuit:recovered', { provider: 'codex' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('park-resume'),
      expect.objectContaining({ resumed: 1 })
    );
  });
});
```

- [ ] **Step 2: Run the test, confirm failure**

Run: `torque-remote npx vitest run server/tests/park-resume-handler.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement handler**

Create `server/factory/park-resume-handler.js`:

```javascript
'use strict';

const { resumeAllCodexParked } = require('../db/factory-intake');

function createParkResumeHandler({ db, eventBus, logger }) {
  if (!db) throw new Error('createParkResumeHandler requires db');
  if (!eventBus) throw new Error('createParkResumeHandler requires eventBus');
  const log = logger || { info() {}, warn() {} };

  eventBus.on('circuit:recovered', (payload) => {
    if (!payload || payload.provider !== 'codex') return;
    try {
      const resumed = resumeAllCodexParked({ db });
      log.info('[codex-fallback] park-resume completed', { resumed, reason: payload.reason });
    } catch (err) {
      log.warn('[codex-fallback] park-resume failed', { error: err.message });
    }
  });

  return {};
}

module.exports = { createParkResumeHandler };
```

- [ ] **Step 4: Run the test, confirm pass**

Run: `torque-remote npx vitest run server/tests/park-resume-handler.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/park-resume-handler.js server/tests/park-resume-handler.test.js
git commit -m "feat(codex-fallback): add park-resume handler for circuit:recovered"
```

---

## Task 10: Wire park-resume handler into container startup

**Files:**
- Modify: `server/container.js` (and possibly `server/index.js` if eager construction needed)
- Create: `server/tests/container-park-resume.test.js`

- [ ] **Step 1: Write the failing assertion**

Create `server/tests/container-park-resume.test.js`:

```javascript
'use strict';
/* global describe, it, expect */

const { defaultContainer } = require('../container');

describe('container — park-resume handler wiring', () => {
  it('exposes parkResumeHandler', () => {
    expect(defaultContainer.has('parkResumeHandler')).toBe(true);
  });

  it('a circuit:recovered for codex does not throw (subscription wired)', () => {
    defaultContainer.get('parkResumeHandler');
    const eventBus = defaultContainer.get('eventBus');
    expect(() => eventBus.emit('circuit:recovered', { provider: 'codex', reason: 'smoke' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test, confirm failure**

Run: `torque-remote npx vitest run server/tests/container-park-resume.test.js`
Expected: FAIL — `parkResumeHandler` not registered.

- [ ] **Step 3: Wire handler into container**

In `server/container.js`, add registration alongside other factory wirings:

```javascript
container.factory('parkResumeHandler', (c) => {
  const { createParkResumeHandler } = require('./factory/park-resume-handler');
  return createParkResumeHandler({
    db: c.get('db'),
    eventBus: c.get('eventBus'),
    logger: c.get('logger'),
  });
});
```

The handler subscribes on construction. Ensure something *constructs* it at startup. Check `server/index.js` for an "eager wiring" call list. If nothing forces construction, add `defaultContainer.get('parkResumeHandler');` in `server/index.js` after the container is fully wired but before the MCP server starts accepting requests.

- [ ] **Step 4: Run the test, confirm pass**

Run: `torque-remote npx vitest run server/tests/container-park-resume.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/container.js server/index.js server/tests/container-park-resume.test.js
git commit -m "feat(codex-fallback): wire park-resume handler at container startup"
```

---

## Task 11: PRIORITIZE branch — consult breaker + policy + park

**Files:**
- Modify: `server/factory/loop-controller.js`
- Create: `server/tests/loop-controller-codex-fallback.test.js`

- [ ] **Step 1: Find the PRIORITIZE branch**

In `server/factory/loop-controller.js`, the PRIORITIZE stage emits decision logs with `actor: 'architect'` and `action: 'selected_work_item'` / `entered_starved` / `short_circuit_to_idle`. Find the function that handles "after we selected a work item, decide what to do next." Look for the call site that advances to PLAN.

This is a 9578-line file — use grep to navigate:
- `grep -n "selected_work_item\|advance_from_prioritize\|advanceFromPrioritize" server/factory/loop-controller.js`

The branch we're modifying: after the work item is selected, *before* advancing to PLAN, consult the breaker and policy.

- [ ] **Step 2: Write the failing test**

Create `server/tests/loop-controller-codex-fallback.test.js`:

```javascript
'use strict';
/* global describe, it, expect, beforeEach */

const Database = require('better-sqlite3');
const { ensureSchema } = require('../db/schema-tables');
const { setCodexFallbackPolicy } = require('../db/factory-intake');
const { decideCodexFallbackAction } = require('../factory/loop-controller');

const INSERT_PROJECT = `INSERT INTO factory_projects (id, name, path, brief, trust_level, status, config_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_ITEM = `INSERT INTO factory_work_items (project_id, source, title) VALUES (?, ?, ?)`;

describe('decideCodexFallbackAction', () => {
  let db;
  let breaker;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    db.prepare(INSERT_PROJECT).run('p1', 'TestProj', '/tmp', 'brief', 'cautious', 'running', '{}');
    db.prepare(INSERT_ITEM).run('p1', 'scout', 'A');
    breaker = {
      _open: false,
      isOpen(provider) { return provider === 'codex' && this._open; },
      _trip() { this._open = true; },
    };
  });

  it('breaker untripped → returns "proceed"', () => {
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker });
    expect(decision.action).toBe('proceed');
  });

  it('breaker tripped + policy=auto → returns "proceed_with_fallback"', () => {
    breaker._trip();
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker });
    expect(decision.action).toBe('proceed_with_fallback');
  });

  it('breaker tripped + policy=wait_for_codex → returns "park"', () => {
    breaker._trip();
    setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'wait_for_codex' });
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker });
    expect(decision.action).toBe('park');
    expect(decision.reason).toMatch(/wait_for_codex/);
  });

  it('breaker tripped + policy=manual → returns "proceed"', () => {
    breaker._trip();
    setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'manual' });
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker });
    expect(decision.action).toBe('proceed');
  });
});
```

- [ ] **Step 3: Run the test, confirm failure**

Run: `torque-remote npx vitest run server/tests/loop-controller-codex-fallback.test.js`
Expected: FAIL — `decideCodexFallbackAction is not a function`.

- [ ] **Step 4: Implement the decision function**

In `server/factory/loop-controller.js`, add a new exported function:

```javascript
function decideCodexFallbackAction({ db, projectId, workItemId, breaker }) {
  const isOpen = typeof breaker?.isOpen === 'function'
    ? breaker.isOpen('codex')
    : (typeof breaker?.allowRequest === 'function' ? !breaker.allowRequest('codex') : false);
  if (!isOpen) return { action: 'proceed' };

  const { getCodexFallbackPolicy } = require('../db/factory-intake');
  const policy = getCodexFallbackPolicy({ db, projectId });

  if (policy === 'wait_for_codex') {
    return { action: 'park', reason: 'wait_for_codex_policy' };
  }
  if (policy === 'manual') {
    return { action: 'proceed' };
  }
  return { action: 'proceed_with_fallback' };
}
```

Add `decideCodexFallbackAction` to the existing `module.exports` at the bottom of `loop-controller.js`.

- [ ] **Step 5: Wire the decision into the PRIORITIZE branch**

Find the call site that advances from PRIORITIZE to PLAN after a work item is selected (use the grep guidance from Step 1). Insert this branch:

```javascript
const cb = defaultContainer.get('circuitBreaker');
const fallbackDecision = decideCodexFallbackAction({
  db,
  projectId: project_id,
  workItemId: selectedItem.id,
  breaker: cb,
});

if (fallbackDecision.action === 'park') {
  const { parkWorkItemForCodex } = require('../db/factory-intake');
  parkWorkItemForCodex({ db, workItemId: selectedItem.id, reason: fallbackDecision.reason });
  recordDecision({
    projectId: project_id,
    stage: 'prioritize',
    actor: 'codex_fallback',
    action: 'parked_codex_unavailable',
    reasoning: `Codex unavailable and project policy=wait_for_codex; parking item ${selectedItem.id}`,
    outcome: { work_item_id: selectedItem.id, reason: fallbackDecision.reason },
  });
  // Skip PLAN, advance to IDLE for this cycle.
  return { state: 'IDLE', reason: 'parked_codex_unavailable' };
}
// `proceed` and `proceed_with_fallback` fall through to existing PLAN path.
```

Match the exact `recordDecision` shape used elsewhere in the file (search for `record_decision\|recordDecision` to find the helper signature). The variable names (`project_id`, `selectedItem`) must match the surrounding code at the insertion point — use whatever is in scope there.

- [ ] **Step 6: Run the test, confirm pass**

Run: `torque-remote npx vitest run server/tests/loop-controller-codex-fallback.test.js`
Expected: PASS.

Run any existing loop-controller test to confirm no regression:
`torque-remote npx vitest run server/tests/factory-loop-controller.test.js` (if exists)

- [ ] **Step 7: Commit**

```bash
git add server/factory/loop-controller.js server/tests/loop-controller-codex-fallback.test.js
git commit -m "feat(codex-fallback): consult breaker+policy at PRIORITIZE; park on wait_for_codex"
```

---

## Task 12: MCP handlers for `codex-breaker trip/untrip/status` and `codex-policy`

**Files:**
- Modify: `server/handlers/circuit-breaker-handlers.js`
- Modify: `server/tool-defs/circuit-breaker-defs.js`
- Modify: `server/tool-annotations.js`
- Modify: `server/tools.js`
- Create: `server/tests/circuit-breaker-handlers.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/circuit-breaker-handlers.test.js`:

```javascript
'use strict';
/* global describe, it, expect, beforeEach */

const {
  handleTripCodexBreaker,
  handleUntripCodexBreaker,
  handleGetCodexBreakerStatus,
  handleConfigureCodexPolicy,
} = require('../handlers/circuit-breaker-handlers');
const { defaultContainer } = require('../container');

describe('codex-breaker MCP handlers', () => {
  beforeEach(() => {
    const cb = defaultContainer.get('circuitBreaker');
    cb.untrip('codex', 'test_setup');
  });

  it('handleTripCodexBreaker trips and reports OPEN', async () => {
    const out = await handleTripCodexBreaker({ reason: 'test_trip' });
    const text = out.content[0].text;
    expect(text).toMatch(/OPEN/);
    expect(text).toMatch(/test_trip/);
  });

  it('handleUntripCodexBreaker untrips', async () => {
    await handleTripCodexBreaker({ reason: 'test_trip' });
    const out = await handleUntripCodexBreaker({ reason: 'test_untrip' });
    expect(out.content[0].text).toMatch(/CLOSED/);
  });

  it('handleGetCodexBreakerStatus returns current state', async () => {
    const out = await handleGetCodexBreakerStatus({});
    expect(out.content[0].text).toMatch(/codex/);
  });

  it('handleConfigureCodexPolicy persists policy', async () => {
    const db = defaultContainer.get('db');
    const project = db.prepare(`SELECT id FROM factory_projects WHERE status = 'running' LIMIT 1`).get();
    if (!project) return;
    const out = await handleConfigureCodexPolicy({ project_id: project.id, mode: 'manual' });
    expect(out.content[0].text).toMatch(/manual/);
    await handleConfigureCodexPolicy({ project_id: project.id, mode: 'auto' });
  });
});
```

- [ ] **Step 2: Run the test, confirm failure**

Run: `torque-remote npx vitest run server/tests/circuit-breaker-handlers.test.js`
Expected: FAIL — handlers not exported.

- [ ] **Step 3: Implement handlers**

Modify `server/handlers/circuit-breaker-handlers.js` — add new handlers alongside the existing one:

```javascript
async function handleTripCodexBreaker(args) {
  try {
    const cb = defaultContainer.get('circuitBreaker');
    cb.trip('codex', args.reason || 'manual');
    const state = cb.getState('codex');
    return { content: [{ type: 'text', text: `Codex breaker tripped (state=${state.state}, reason=${args.reason || 'manual'})` }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `trip failed: ${err.message}` }] };
  }
}

async function handleUntripCodexBreaker(args) {
  try {
    const cb = defaultContainer.get('circuitBreaker');
    cb.untrip('codex', args.reason || 'manual');
    const state = cb.getState('codex');
    return { content: [{ type: 'text', text: `Codex breaker untripped (state=${state.state})` }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `untrip failed: ${err.message}` }] };
  }
}

async function handleGetCodexBreakerStatus(args) {
  try {
    const cb = defaultContainer.get('circuitBreaker');
    const state = cb.getState('codex');
    const store = defaultContainer.get('providerCircuitBreakerStore');
    const persisted = store.getState('codex');
    return { content: [{ type: 'text', text: JSON.stringify({ state, persisted }, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `status failed: ${err.message}` }] };
  }
}

async function handleConfigureCodexPolicy(args) {
  try {
    const { setCodexFallbackPolicy } = require('../db/factory-intake');
    const db = defaultContainer.get('db');
    setCodexFallbackPolicy({ db, projectId: args.project_id, policy: args.mode });
    return { content: [{ type: 'text', text: `Codex fallback policy for ${args.project_id}: ${args.mode}` }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `policy update failed: ${err.message}` }] };
  }
}

module.exports = {
  handleGetCircuitBreakerStatus,
  handleTripCodexBreaker,
  handleUntripCodexBreaker,
  handleGetCodexBreakerStatus,
  handleConfigureCodexPolicy,
};
```

- [ ] **Step 4: Add tool definitions**

In `server/tool-defs/circuit-breaker-defs.js`, append:

```javascript
{
  name: 'trip_codex_breaker',
  description: 'Manually trip the Codex circuit breaker (mark Codex unavailable). Causes the factory to fall back per project policy.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Operator-supplied reason for the trip.' },
    },
  },
},
{
  name: 'untrip_codex_breaker',
  description: 'Manually untrip the Codex circuit breaker (mark Codex available again). Resumes parked work.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string' },
    },
  },
},
{
  name: 'get_codex_breaker_status',
  description: 'Get the current Codex circuit breaker state and persisted record.',
  inputSchema: { type: 'object', properties: {} },
},
{
  name: 'configure_codex_policy',
  description: 'Set a project codex_fallback_policy (auto | manual | wait_for_codex).',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      mode: { type: 'string', enum: ['auto', 'manual', 'wait_for_codex'] },
    },
    required: ['project_id', 'mode'],
  },
},
```

- [ ] **Step 5: Add tool annotations**

In `server/tool-annotations.js`, add corresponding annotation entries (match the shape used by the existing `get_circuit_breaker_status` annotation).

- [ ] **Step 6: Wire dispatch**

In `server/tools.js`, find the dispatch table for circuit-breaker handlers (search `handleGetCircuitBreakerStatus`) and add cases for the new tool names mapping to the new handlers.

- [ ] **Step 7: Run the test, confirm pass**

Run: `torque-remote npx vitest run server/tests/circuit-breaker-handlers.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/handlers/circuit-breaker-handlers.js server/tool-defs/circuit-breaker-defs.js server/tool-annotations.js server/tools.js server/tests/circuit-breaker-handlers.test.js
git commit -m "feat(codex-fallback): MCP handlers for codex-breaker and codex-policy"
```

---

## Task 13: Slash command extension for `/torque-config`

**Files:**
- Modify: `.claude/commands/torque-config.md`

- [ ] **Step 1: Read the existing command**

Read `.claude/commands/torque-config.md` end-to-end to understand the command structure.

- [ ] **Step 2: Add codex-breaker and codex-policy subcommands**

Append a new section to `.claude/commands/torque-config.md`:

````markdown
### Codex breaker / fallback policy

`/torque-config codex-breaker status` — get current Codex circuit breaker state.

Maps to `get_codex_breaker_status`.

`/torque-config codex-breaker trip [--reason="..."]` — manually trip the Codex breaker.

Maps to `trip_codex_breaker { reason: "..." }`.

`/torque-config codex-breaker untrip [--reason="..."]` — manually untrip; resumes parked work.

Maps to `untrip_codex_breaker { reason: "..." }`.

`/torque-config codex-policy --project=<name> --mode={auto|manual|wait_for_codex}` — set a project Codex fallback policy.

Maps to `configure_codex_policy { project_id: "<id>", mode: "<mode>" }`. The command should resolve `<name>` to `project_id` via `list_factory_projects` first, then call the tool.
````

- [ ] **Step 3: Smoke test the command**

Open Claude Code in the worktree directory and try `/torque-config codex-breaker status`. Confirm the slash command parses and dispatches.

(There is no automated test for slash command files; this is a manual smoke test.)

- [ ] **Step 4: Commit**

```bash
git add .claude/commands/torque-config.md
git commit -m "docs(codex-fallback): document codex-breaker and codex-policy subcommands"
```

---

## Task 14: Dashboard panel — Codex Breaker status + parked items

**Files:**
- Create: `dashboard/src/pages/Operations/CodexBreakerPanel.jsx` (or matching path)
- Modify: dashboard route file to include the new panel

- [ ] **Step 1: Read the existing Operations panel layout**

Read `dashboard/src/pages/Operations/` (or wherever Operations lives) to find:
1. The route file that lists Operations sub-pages.
2. An existing panel component to use as a template (for styling and API conventions).

- [ ] **Step 2: Build the panel**

Create `dashboard/src/pages/Operations/CodexBreakerPanel.jsx`:

```jsx
import React, { useEffect, useState } from 'react';

export function CodexBreakerPanel() {
  const [status, setStatus] = useState(null);
  const [parkedItems, setParkedItems] = useState([]);
  const [error, setError] = useState(null);

  async function loadStatus() {
    try {
      const res = await fetch('/api/v1/tools/get_codex_breaker_status', { method: 'POST' });
      const json = await res.json();
      setStatus(json);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadParkedItems() {
    try {
      const res = await fetch('/api/v1/factory/work-items?status=parked_codex_unavailable');
      const json = await res.json();
      setParkedItems(json?.items || []);
    } catch (err) {
      // Soft-fail; not blocking.
    }
  }

  useEffect(() => {
    loadStatus();
    loadParkedItems();
    const t = setInterval(() => { loadStatus(); loadParkedItems(); }, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="codex-breaker-panel">
      <h2>Codex Circuit Breaker</h2>
      {error && <div className="error">{error}</div>}
      {status && <pre>{JSON.stringify(status, null, 2)}</pre>}
      <h3>Parked items ({parkedItems.length})</h3>
      <ul>
        {parkedItems.map((item) => (
          <li key={item.id}>
            #{item.id} [{item.project_name}] {item.title} — priority {item.priority}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

(If the dashboard's API conventions differ — JSON-RPC vs REST, auth headers, etc. — match what the existing Operations panels do.)

- [ ] **Step 3: Add route**

Register the panel in the Operations route file (search `Operations` to find existing routes). Match existing patterns.

- [ ] **Step 4: Smoke test**

Run the dashboard in dev mode (per existing conventions); navigate to Operations > Codex Breaker; trip the breaker via `/torque-config codex-breaker trip`; verify the panel updates within 5 seconds.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/pages/Operations/CodexBreakerPanel.jsx dashboard/src/pages/Operations/index.jsx
git commit -m "feat(codex-fallback): dashboard panel for Codex breaker + parked items"
```

---

## Task 15: Phase 1 smoke test — full trip → park → untrip → resume cycle

**Files:**
- Create: `server/tests/integration/codex-fallback-phase1-smoke.test.js`

- [ ] **Step 1: Write the smoke test**

Create `server/tests/integration/codex-fallback-phase1-smoke.test.js`:

```javascript
'use strict';
/* global describe, it, expect, beforeEach */

const Database = require('better-sqlite3');
const { ensureSchema } = require('../../db/schema-tables');
const { createCircuitBreaker } = require('../../execution/circuit-breaker');
const { createProviderCircuitBreakerStore } = require('../../db/provider-circuit-breaker-store');
const { createParkResumeHandler } = require('../../factory/park-resume-handler');
const {
  parkWorkItemForCodex,
  setCodexFallbackPolicy,
  getCodexFallbackPolicy,
} = require('../../db/factory-intake');

const INSERT_PROJECT = `INSERT INTO factory_projects (id, name, path, brief, trust_level, status, config_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_ITEM = `INSERT INTO factory_work_items (project_id, source, title) VALUES (?, ?, ?)`;

function makeEventBus() {
  const subscribers = new Map();
  return {
    on(event, fn) {
      const arr = subscribers.get(event) || [];
      arr.push(fn);
      subscribers.set(event, arr);
    },
    emit(event, payload) {
      (subscribers.get(event) || []).forEach((fn) => fn(payload));
    },
  };
}

describe('Phase 1 integration smoke test', () => {
  let db, store, breaker, eventBus;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    db.prepare(INSERT_PROJECT).run('p_auto', 'Auto', '/tmp', 'b', 'cautious', 'running', '{}');
    db.prepare(INSERT_PROJECT).run('p_wait', 'Wait', '/tmp', 'b', 'cautious', 'running', '{}');
    db.prepare(INSERT_PROJECT).run('p_manual', 'Manual', '/tmp', 'b', 'cautious', 'running', '{}');
    db.prepare(INSERT_ITEM).run('p_auto', 'scout', 'Auto item');
    db.prepare(INSERT_ITEM).run('p_wait', 'scout', 'Wait item');
    db.prepare(INSERT_ITEM).run('p_manual', 'scout', 'Manual item');

    setCodexFallbackPolicy({ db, projectId: 'p_wait', policy: 'wait_for_codex' });
    setCodexFallbackPolicy({ db, projectId: 'p_manual', policy: 'manual' });

    store = createProviderCircuitBreakerStore({ db });
    eventBus = makeEventBus();
    breaker = createCircuitBreaker({ eventBus, store });
    createParkResumeHandler({ db, eventBus, logger: { info() {}, warn() {} } });
  });

  it('full trip → park → untrip → resume cycle', () => {
    expect(breaker.allowRequest('codex')).toBe(true);
    expect(getCodexFallbackPolicy({ db, projectId: 'p_auto' })).toBe('auto');

    breaker.trip('codex', 'manual_disabled');
    expect(breaker.allowRequest('codex')).toBe(false);

    expect(store.getState('codex')).toMatchObject({
      state: 'OPEN',
      trip_reason: 'manual_disabled',
    });

    parkWorkItemForCodex({ db, workItemId: 2, reason: 'wait_for_codex_policy' });

    breaker.untrip('codex', 'canary_succeeded');
    expect(breaker.allowRequest('codex')).toBe(true);

    const item2 = db.prepare(`SELECT status FROM factory_work_items WHERE id = 2`).get();
    expect(item2.status).toBe('pending');

    expect(store.getState('codex').state).toBe('CLOSED');
  });

  it('survives breaker recreation (state loaded from DB)', () => {
    breaker.trip('codex', 'manual_disabled');
    const breaker2 = createCircuitBreaker({ eventBus, store });
    expect(breaker2.allowRequest('codex')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `torque-remote npx vitest run server/tests/integration/codex-fallback-phase1-smoke.test.js`
Expected: PASS (both smoke tests).

- [ ] **Step 3: Run the full Phase 1 test surface**

Run: `torque-remote npx vitest run server/tests/provider-circuit-breaker-store.test.js server/tests/circuit-breaker.test.js server/tests/factory-intake-park.test.js server/tests/factory-intake-policy.test.js server/tests/park-resume-handler.test.js server/tests/loop-controller-codex-fallback.test.js server/tests/circuit-breaker-handlers.test.js server/tests/integration/codex-fallback-phase1-smoke.test.js`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add server/tests/integration/codex-fallback-phase1-smoke.test.js
git commit -m "test(codex-fallback): Phase 1 integration smoke test"
```

---

## Final Pre-Merge Checks

- [ ] **Run the full server test suite remotely**

Run: `torque-remote npx vitest run` (in the worktree)
Expected: full suite green; no regressions in existing breaker tests, factory-intake tests, container tests.

- [ ] **Manually exercise via running TORQUE**

With the worktree merged to main (or via dev-mode swap), perform the following sequence and verify each step's effect on the dashboard:

1. `/torque-config codex-breaker status` → expect CLOSED.
2. `/torque-config codex-policy --project=DLPhone --mode=wait_for_codex` → expect "Codex fallback policy for ... wait_for_codex".
3. `/torque-config codex-breaker trip --reason=manual_test` → expect OPEN.
4. Wait for DLPhone PRIORITIZE cycle → check decision-log for `parked_codex_unavailable` entry.
5. `/torque-config codex-breaker untrip` → expect CLOSED; parked item resumes to `pending`.
6. `/torque-config codex-policy --project=DLPhone --mode=auto` → restore default.

- [ ] **Cutover**

When tests pass and manual smoke is clean, run `scripts/worktree-cutover.sh codex-fallback-phase1` (per CLAUDE.md). This merges the branch to main, drains the queue, restarts TORQUE, and cleans the worktree.

---

## Self-Review Notes

**Spec coverage check:**
- ✓ Component A (Codex Circuit Breaker) — Tasks 3-6 (extension, persistence, codex-aware codes, manual API, DI)
- ✓ Component F (codex_fallback_policy) — Task 8 (config_json accessor)
- ✓ Component G (CLI/dashboard) — Tasks 12-14 (MCP handlers, slash command, dashboard panel)
- ✓ Component H (park state) — Tasks 7, 9-11 (status vocabulary, helpers, park-resume handler, PRIORITIZE branch)
- ✗ Components B, C, D, E are explicitly Phase 2/3 — out of scope for this plan

**Gaps acknowledged:**
- Phase 1 has no auto-trip on Codex failure events. Task 4 `recordFailureByCode` is plumbed but no caller wires it yet (close-handler call site comes in Phase 2). Phase 1 only gives operators *manual* trip/untrip and DB persistence.
- Phase 1 `auto` policy returns `proceed_with_fallback` from the decision function, but EXECUTE handler still tries Codex (no failover chain yet). Result: `auto` projects continue to error on EXECUTE during a tripped state in Phase 1, same as today. This is intentional — Phase 2 fixes the EXECUTE path. Phase 1 value is *visibility and operator control*, plus the ability to use `wait_for_codex` to silence the error spam.
- Canary task automation is deferred — Phase 1 has no scheduled canary; operators untrip manually. Auto-canary slots into Phase 2 alongside the routing changes.

**Type/method consistency check:**
- `breaker.trip(provider, reason)` and `breaker.untrip(provider, reason)` — used identically in Tasks 5, 11, 12.
- `getCodexFallbackPolicy({ db, projectId })` and `setCodexFallbackPolicy({ db, projectId, policy })` — used identically in Tasks 8, 11, 12.
- `parkWorkItemForCodex({ db, workItemId, reason })` and `resumeAllCodexParked({ db })` — used identically in Tasks 7, 9, 11, 15.
- `decideCodexFallbackAction({ db, projectId, workItemId, breaker })` returns `{ action, reason? }` — used in Task 11.

**No placeholders:** every test body is concrete; every implementation step gives the actual code. The exception is Task 14 (dashboard) which says "match existing API conventions" — this is intentional because dashboard conventions vary; the implementer must read the existing panels first.
