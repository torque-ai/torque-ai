'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const { createConcurrencyKeys } = require('../scheduling/concurrency-keys');

describe('concurrencyKeys', () => {
  let db;
  let ck;

  beforeEach(() => {
    setupTestDbOnly('concurrency-keys');
    db = rawDb();
    ck = createConcurrencyKeys({ db });
  });

  afterEach(() => {
    teardownTestDb();
  });

  function insertTask(id, concurrencyKey, status) {
    db.prepare(`
      INSERT INTO tasks (id, task_description, concurrency_key, status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, `Task ${id}`, concurrencyKey, status, new Date().toISOString());
  }

  it('default unlimited when no limit set', () => {
    expect(ck.canReserve('tenant:acme')).toBe(true);
  });

  it('exact-match limit blocks past max', () => {
    ck.setLimit('tenant:acme', 2);
    insertTask('t1', 'tenant:acme', 'running');
    insertTask('t2', 'tenant:acme', 'running');

    expect(ck.canReserve('tenant:acme')).toBe(false);
  });

  it('wildcard pattern (*) applies to all keys with that prefix', () => {
    ck.setLimit('tenant:*', 1);
    insertTask('t1', 'tenant:acme', 'running');

    expect(ck.canReserve('tenant:acme')).toBe(false);
    expect(ck.canReserve('tenant:globex')).toBe(true);
  });

  it('exact-match takes precedence over wildcard', () => {
    ck.setLimit('tenant:*', 1);
    ck.setLimit('tenant:acme', 5);
    insertTask('t1', 'tenant:acme', 'running');
    insertTask('t2', 'tenant:acme', 'running');
    insertTask('t3', 'tenant:acme', 'running');

    expect(ck.canReserve('tenant:acme')).toBe(true);
    expect(ck.canReserve('tenant:globex')).toBe(true);

    insertTask('t4', 'tenant:globex', 'running');
    expect(ck.canReserve('tenant:globex')).toBe(false);
  });

  it('only counts running/queued; completed/failed/cancelled are released', () => {
    ck.setLimit('repo:hot', 1);
    insertTask('t1', 'repo:hot', 'completed');
    insertTask('t2', 'repo:hot', 'failed');
    insertTask('t3', 'repo:hot', 'cancelled');

    expect(ck.canReserve('repo:hot')).toBe(true);
  });

  it('countActive returns the live count', () => {
    insertTask('t1', 'k1', 'running');
    insertTask('t2', 'k1', 'queued');
    insertTask('t3', 'k1', 'completed');

    expect(ck.countActive('k1')).toBe(2);
  });

  it('listLimits returns all configured limits', () => {
    ck.setLimit('tenant:*', 5);
    ck.setLimit('repo:hot', 1);

    const all = ck.listLimits();

    expect(all.find((limit) => limit.key_pattern === 'tenant:*').max_concurrent).toBe(5);
  });

  it('removeLimit deletes a configured limit', () => {
    ck.setLimit('repo:hot', 1);
    ck.removeLimit('repo:hot');

    expect(ck.resolveLimit('repo:hot')).toBeNull();
  });
});
