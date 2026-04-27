'use strict';
/* global describe, it, expect, beforeEach */

const Database = require('better-sqlite3');
const { createTables: ensureSchema } = require('../db/schema-tables');
const { setCodexFallbackPolicy } = require('../db/factory-intake');
const {
  decideCodexFallbackAction,
  markInstanceFallbackRouting,
  consumeInstanceFallbackRouting,
  isInstanceFallbackRoutingPending,
  clearInstanceFallbackRouting,
} = require('../factory/loop-controller');

const INSERT_PROJECT = `INSERT INTO factory_projects (id, name, path, brief, trust_level, status, config_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_ITEM = `INSERT INTO factory_work_items (project_id, source, title) VALUES (?, ?, ?)`;
const LOGGER_STUB = { debug() {}, info() {}, warn() {}, error() {} };

describe('decideCodexFallbackAction', () => {
  let db;
  let breaker;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db, LOGGER_STUB);
    db.prepare(INSERT_PROJECT).run('p1', 'TestProj', '/tmp', 'brief', 'cautious', 'running', '{}');
    db.prepare(INSERT_ITEM).run('p1', 'scout', 'A');
    breaker = {
      _open: false,
      isOpen(provider) { return provider === 'codex' && this._open; },
      _trip() { this._open = true; },
    };
  });

  it('breaker untripped returns "proceed"', () => {
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker });
    expect(decision.action).toBe('proceed');
  });

  it('breaker tripped + policy=auto returns "proceed_with_fallback"', () => {
    breaker._trip();
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker });
    expect(decision.action).toBe('proceed_with_fallback');
  });

  it('breaker tripped + policy=wait_for_codex returns "park"', () => {
    breaker._trip();
    setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'wait_for_codex' });
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker });
    expect(decision.action).toBe('park');
    expect(decision.reason).toMatch(/wait_for_codex/);
  });

  it('breaker tripped + policy=manual returns "proceed"', () => {
    breaker._trip();
    setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'manual' });
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker });
    expect(decision.action).toBe('proceed');
  });

  it('null breaker returns "proceed"', () => {
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker: null });
    expect(decision.action).toBe('proceed');
  });

  it('breaker with allowRequest only (no isOpen) — works via fallback', () => {
    const oldStyleBreaker = {
      _open: false,
      allowRequest(provider) { return provider === 'codex' ? !this._open : true; },
    };
    oldStyleBreaker._open = true;
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker: oldStyleBreaker });
    expect(decision.action).toBe('proceed_with_fallback');
  });
});

// Phase 2 Task 6 — proceed_with_fallback marks the instance for failover
// routing via an in-memory Set keyed by instance.id. Task 7 (smart-routing
// chain walker) will consume the marker at EXECUTE submit time. Here we
// validate the helper API the consumer will use — the actual call site in
// `handlePrioritizeTransition` is integration-tested via the broader
// loop-controller suite.
describe('instance fallback routing markers', () => {
  const INSTANCE_A = 'instance-aaa';
  const INSTANCE_B = 'instance-bbb';

  beforeEach(() => {
    // Defensive cleanup so tests are order-independent — the in-memory Set
    // lives at module scope.
    clearInstanceFallbackRouting(INSTANCE_A);
    clearInstanceFallbackRouting(INSTANCE_B);
  });

  it('marker starts unset for any instance id', () => {
    expect(isInstanceFallbackRoutingPending(INSTANCE_A)).toBe(false);
    expect(isInstanceFallbackRoutingPending(INSTANCE_B)).toBe(false);
  });

  it('markInstanceFallbackRouting flags the instance as pending', () => {
    markInstanceFallbackRouting(INSTANCE_A);
    expect(isInstanceFallbackRoutingPending(INSTANCE_A)).toBe(true);
    // Marking one instance must not leak to another.
    expect(isInstanceFallbackRoutingPending(INSTANCE_B)).toBe(false);
  });

  it('consumeInstanceFallbackRouting returns true once and clears the marker', () => {
    markInstanceFallbackRouting(INSTANCE_A);
    expect(consumeInstanceFallbackRouting(INSTANCE_A)).toBe(true);
    // Consuming a second time returns false — the marker is one-shot
    // so the chain walker can't accidentally apply failover routing
    // to a follow-on task that should ride the normal chain.
    expect(consumeInstanceFallbackRouting(INSTANCE_A)).toBe(false);
    expect(isInstanceFallbackRoutingPending(INSTANCE_A)).toBe(false);
  });

  it('consumeInstanceFallbackRouting on an unmarked instance returns false', () => {
    expect(consumeInstanceFallbackRouting(INSTANCE_A)).toBe(false);
  });

  it('clearInstanceFallbackRouting drops the marker without consuming it', () => {
    markInstanceFallbackRouting(INSTANCE_A);
    clearInstanceFallbackRouting(INSTANCE_A);
    expect(isInstanceFallbackRoutingPending(INSTANCE_A)).toBe(false);
    expect(consumeInstanceFallbackRouting(INSTANCE_A)).toBe(false);
  });

  it('helpers are no-ops for falsy instance ids', () => {
    expect(() => markInstanceFallbackRouting(null)).not.toThrow();
    expect(() => markInstanceFallbackRouting(undefined)).not.toThrow();
    expect(() => clearInstanceFallbackRouting('')).not.toThrow();
    expect(consumeInstanceFallbackRouting(null)).toBe(false);
    expect(isInstanceFallbackRoutingPending(undefined)).toBe(false);
  });

  it('proceed_with_fallback decision pairs with marker for the chain walker', () => {
    // This is the integration shape the chain walker (Task 7) will use:
    // PRIORITIZE calls decideCodexFallbackAction; if action is
    // 'proceed_with_fallback', mark the instance; later EXECUTE submit
    // path consumes the marker to apply the failover routing template.
    const localDb = new Database(':memory:');
    ensureSchema(localDb, LOGGER_STUB);
    localDb.prepare(INSERT_PROJECT).run('p1', 'TestProj', '/tmp', 'brief', 'cautious', 'running', '{}');
    localDb.prepare(INSERT_ITEM).run('p1', 'scout', 'A');
    const trippedBreaker = {
      _open: true,
      isOpen(p) { return p === 'codex'; },
    };
    const decision = decideCodexFallbackAction({
      db: localDb,
      projectId: 'p1',
      workItemId: 1,
      breaker: trippedBreaker,
    });
    expect(decision.action).toBe('proceed_with_fallback');

    // Simulate the PRIORITIZE branch's marker write.
    markInstanceFallbackRouting(INSTANCE_A);

    // Simulate the EXECUTE submit path's marker read + consume.
    expect(consumeInstanceFallbackRouting(INSTANCE_A)).toBe(true);
    expect(consumeInstanceFallbackRouting(INSTANCE_A)).toBe(false);
  });
});
