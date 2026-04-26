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
