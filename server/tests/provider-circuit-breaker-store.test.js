'use strict';
/* global describe, it, expect, beforeEach */

const Database = require('better-sqlite3');
const { createTables: ensureSchema } = require('../db/schema/tables');

describe('provider_circuit_breaker schema', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db, { debug() {}, info() {}, warn() {}, error() {} });
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

const { createProviderCircuitBreakerStore } = require('../db/provider/circuit-breaker-store');

describe('createProviderCircuitBreakerStore', () => {
  let db;
  let store;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db, { debug() {}, info() {}, warn() {}, error() {} });
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
    expect(row.tripped_at).toBe('2026-04-26T20:00:00.000Z');
    expect(row.trip_reason).toBeNull();
  });

  it('persist defaults state to CLOSED when not provided in patch', () => {
    // Should NOT throw NOT NULL constraint error.
    expect(() => store.persist('codex', { trippedAt: '2026-04-26T20:00:00.000Z' })).not.toThrow();
    expect(store.getState('codex').state).toBe('CLOSED');
  });

  it('listAll returns rows for all known providers', () => {
    store.persist('codex', { state: 'OPEN' });
    store.persist('groq', { state: 'CLOSED' });
    const rows = store.listAll();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.provider_id).sort()).toEqual(['codex', 'groq']);
  });
});
