'use strict';
/* global describe, it, expect, beforeEach */

const Database = require('better-sqlite3');
const { createTables: ensureSchema } = require('../../db/schema-tables');
const { createCircuitBreaker } = require('../../execution/circuit-breaker');
const { createProviderCircuitBreakerStore } = require('../../db/provider/circuit-breaker-store');
const { createParkResumeHandler } = require('../../factory/park-resume-handler');
const {
  parkWorkItemForCodex,
  setCodexFallbackPolicy,
  getCodexFallbackPolicy,
} = require('../../db/factory/intake');

// NOTE: decideCodexFallbackAction lives in factory/loop-controller.js but that
// module pulls in many heavy server-level dependencies (database singleton,
// child_process, etc.) that can cause loading issues in the integration/
// subdirectory. The unit tests in server/tests/loop-controller-codex-fallback.test.js
// cover decideCodexFallbackAction exhaustively (Task 11). Here we inline the same
// decision logic so the smoke test stays self-contained and focuses on the
// cross-module integration paths (CircuitBreaker ↔ store ↔ park-resume handler
// ↔ factory_work_items). This is explicitly the approach recommended in the
// Task 15 spec when the loop function is "not directly callable in unit tests".
function decideCodexFallbackActionInline({ db: dbArg, projectId, breaker }) {
  let codexOpen = false;
  if (breaker && typeof breaker.isOpen === 'function') {
    try { codexOpen = breaker.isOpen('codex'); } catch (_e) { void _e; }
  } else if (breaker && typeof breaker.allowRequest === 'function') {
    try { codexOpen = !breaker.allowRequest('codex'); } catch (_e) { void _e; }
  }
  if (!codexOpen) return { action: 'proceed' };

  const policy = getCodexFallbackPolicy({ db: dbArg, projectId });
  if (policy === 'wait_for_codex') {
    return { action: 'park', reason: 'wait_for_codex_policy' };
  }
  if (policy === 'manual') {
    return { action: 'proceed' };
  }
  // 'auto' — Phase 1 default
  return { action: 'proceed_with_fallback' };
}

const INSERT_PROJECT = `INSERT INTO factory_projects (id, name, path, brief, trust_level, status, config_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_ITEM = `INSERT INTO factory_work_items (project_id, source, title) VALUES (?, ?, ?)`;
const LOGGER_STUB = { debug() {}, info() {}, warn() {}, error() {} };

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

function setupDb() {
  const db = new Database(':memory:');
  ensureSchema(db, LOGGER_STUB);
  return db;
}

describe('Phase 1 integration smoke test — codex-fallback', () => {
  describe('Scenario 1: full trip → park → untrip → resume cycle', () => {
    let db, store, breaker, eventBus;

    beforeEach(() => {
      db = setupDb();
      db.prepare(INSERT_PROJECT).run('p1', 'Test', '/tmp/p1', 'b', 'cautious', 'running', '{}');
      db.prepare(INSERT_ITEM).run('p1', 'scout', 'Item A');

      store = createProviderCircuitBreakerStore({ db });
      eventBus = makeEventBus();
      breaker = createCircuitBreaker({ eventBus, store });
      createParkResumeHandler({ db, eventBus, logger: LOGGER_STUB });
    });

    it('completes the full cycle and resumes parked items on untrip', () => {
      // Initial state — breaker CLOSED, requests allowed.
      expect(breaker.allowRequest('codex')).toBe(true);

      // Trip.
      breaker.trip('codex', 'manual_disabled');
      expect(breaker.allowRequest('codex')).toBe(false);

      // Persisted DB record reflects OPEN + trip reason.
      const dbRow = store.getState('codex');
      expect(dbRow).toMatchObject({
        state: 'OPEN',
        trip_reason: 'manual_disabled',
      });

      // Park the work item.
      parkWorkItemForCodex({ db, workItemId: 1, reason: 'wait_for_codex_policy' });
      const parkedItem = db.prepare(`SELECT status FROM factory_work_items WHERE id = 1`).get();
      expect(parkedItem.status).toBe('parked_codex_unavailable');

      // Untrip — fires 'circuit:recovered', which the park-resume handler handles.
      breaker.untrip('codex', 'canary_succeeded');
      expect(breaker.allowRequest('codex')).toBe(true);

      // Item should be restored to 'pending' by the park-resume handler.
      const resumedItem = db.prepare(`SELECT status FROM factory_work_items WHERE id = 1`).get();
      expect(resumedItem.status).toBe('pending');

      // Persisted state should now be CLOSED.
      expect(store.getState('codex').state).toBe('CLOSED');
    });
  });

  describe('Scenario 2: breaker state survives recreation (DB persistence)', () => {
    it('reloads OPEN state from DB on new breaker instance', () => {
      const db = setupDb();
      const store = createProviderCircuitBreakerStore({ db });
      const eventBus = makeEventBus();
      const breaker1 = createCircuitBreaker({ eventBus, store });

      // Trip on instance 1.
      breaker1.trip('codex', 'manual_disabled');
      expect(breaker1.allowRequest('codex')).toBe(false);

      // Recreate breaker from same store — simulates server restart.
      const breaker2 = createCircuitBreaker({ eventBus, store });
      expect(breaker2.allowRequest('codex')).toBe(false);

      const state = breaker2.getState('codex');
      expect(state.state).toBe('OPEN');
    });
  });

  describe('Scenario 3: multi-project policy interactions', () => {
    let db, breaker;

    beforeEach(() => {
      db = setupDb();
      // Use distinct paths to satisfy the UNIQUE constraint on factory_projects.path.
      db.prepare(INSERT_PROJECT).run('p_auto', 'Auto', '/tmp/p_auto', 'b', 'cautious', 'running', '{}');
      db.prepare(INSERT_PROJECT).run('p_wait', 'Wait', '/tmp/p_wait', 'b', 'cautious', 'running', '{}');
      db.prepare(INSERT_PROJECT).run('p_manual', 'Manual', '/tmp/p_manual', 'b', 'cautious', 'running', '{}');
      db.prepare(INSERT_ITEM).run('p_auto', 'scout', 'Auto item');
      db.prepare(INSERT_ITEM).run('p_wait', 'scout', 'Wait item');
      db.prepare(INSERT_ITEM).run('p_manual', 'scout', 'Manual item');

      setCodexFallbackPolicy({ db, projectId: 'p_wait', policy: 'wait_for_codex' });
      setCodexFallbackPolicy({ db, projectId: 'p_manual', policy: 'manual' });

      // Stub breaker: Codex circuit is OPEN (tripped).
      breaker = {
        isOpen(provider) { return provider === 'codex'; },
      };
    });

    it('p_auto (policy=auto) returns proceed_with_fallback when breaker is tripped', () => {
      const decision = decideCodexFallbackActionInline({ db, projectId: 'p_auto', breaker });
      expect(decision.action).toBe('proceed_with_fallback');
    });

    it('p_wait (policy=wait_for_codex) returns park when breaker is tripped', () => {
      const decision = decideCodexFallbackActionInline({ db, projectId: 'p_wait', breaker });
      expect(decision.action).toBe('park');
      expect(decision.reason).toMatch(/wait_for_codex/);
    });

    it('p_manual (policy=manual) returns proceed when breaker is tripped', () => {
      const decision = decideCodexFallbackActionInline({ db, projectId: 'p_manual', breaker });
      expect(decision.action).toBe('proceed');
    });
  });

  describe('Scenario 4: PRIORITIZE branch end-to-end via helpers (closes Task 11 coverage gap)', () => {
    let db;

    beforeEach(() => {
      db = setupDb();
      db.prepare(INSERT_PROJECT).run('p_smoke', 'Smoke', '/tmp/p_smoke', 'b', 'cautious', 'running', '{}');
      db.prepare(INSERT_ITEM).run('p_smoke', 'scout', 'Smoke item');
      setCodexFallbackPolicy({ db, projectId: 'p_smoke', policy: 'wait_for_codex' });
    });

    it('tripped breaker + wait_for_codex policy → item parks at parked_codex_unavailable', () => {
      // Stub breaker: Codex circuit is OPEN.
      const breaker = { isOpen(p) { return p === 'codex'; } };

      // Step 1: decision function (mirrors decideCodexFallbackAction in loop-controller)
      // returns 'park' for wait_for_codex policy. The full decideCodexFallbackAction
      // export is exercised by server/tests/loop-controller-codex-fallback.test.js (Task 11).
      const decision = decideCodexFallbackActionInline({
        db,
        projectId: 'p_smoke',
        breaker,
      });
      expect(decision.action).toBe('park');

      // Step 2: mirror what the PRIORITIZE call site in loop-controller.js does
      // when action === 'park': call parkWorkItemForCodex.
      //
      // The actual call site also writes a factory_decisions row with
      // actor='codex_fallback' and action='parked_codex_unavailable', and clears
      // instance.work_item_id. Those side effects are covered by
      // server/tests/loop-controller-codex-fallback.test.js (Task 11).
      // This smoke test verifies the decision + park helper integration end-to-end.
      parkWorkItemForCodex({ db, workItemId: 1, reason: decision.reason });

      const row = db.prepare(`SELECT status FROM factory_work_items WHERE id = 1`).get();
      expect(row.status).toBe('parked_codex_unavailable');
    });
  });
});
