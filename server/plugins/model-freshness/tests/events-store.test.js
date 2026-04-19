'use strict';

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
