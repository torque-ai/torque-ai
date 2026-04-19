'use strict';

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
