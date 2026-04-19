'use strict';

const Database = require('better-sqlite3');
const { createHandlers } = require('../handlers');
const { createWatchlistStore, WATCHLIST_SCHEMA } = require('../watchlist-store');
const { createEventsStore, EVENTS_SCHEMA } = require('../events-store');

function freshSetup() {
  const db = new Database(':memory:');
  db.prepare(WATCHLIST_SCHEMA).run();
  db.prepare(EVENTS_SCHEMA).run();
  const watchlist = createWatchlistStore(db);
  const events = createEventsStore(db);
  const scanner = { runScan: vi.fn().mockResolvedValue({ rowsScanned: 2, eventsEmitted: 0, errors: [] }) };
  const handlers = createHandlers({ watchlist, events, scanner });
  return { handlers, watchlist, events, scanner };
}

describe('model_watchlist_add', () => {
  it('creates an entry with source=user', async () => {
    const { handlers, watchlist } = freshSetup();
    const res = await handlers.model_watchlist_add({ family: 'qwen3-coder', tag: '30b' });
    expect(res.added).toBe(true);
    expect(watchlist.getByFamilyTag('qwen3-coder', '30b').source).toBe('user');
  });

  it('rejects missing family', async () => {
    const { handlers } = freshSetup();
    await expect(handlers.model_watchlist_add({ tag: '30b' })).rejects.toThrow(/family/);
  });
});

describe('model_watchlist_remove', () => {
  it('deactivates an existing entry', async () => {
    const { handlers, watchlist } = freshSetup();
    await handlers.model_watchlist_add({ family: 'x', tag: 'y' });
    await handlers.model_watchlist_remove({ family: 'x', tag: 'y' });
    expect(watchlist.getByFamilyTag('x', 'y').active).toBe(0);
  });
});

describe('model_watchlist_list', () => {
  it('returns only active entries by default', async () => {
    const { handlers } = freshSetup();
    await handlers.model_watchlist_add({ family: 'a', tag: 'b' });
    await handlers.model_watchlist_add({ family: 'c', tag: 'd' });
    await handlers.model_watchlist_remove({ family: 'a', tag: 'b' });
    const res = await handlers.model_watchlist_list({});
    expect(res.items).toHaveLength(1);
    expect(res.items[0].family).toBe('c');
  });
});

describe('model_freshness_scan_now', () => {
  it('invokes scanner.runScan and returns the result', async () => {
    const { handlers, scanner } = freshSetup();
    const res = await handlers.model_freshness_scan_now({});
    expect(scanner.runScan).toHaveBeenCalled();
    expect(res.rowsScanned).toBe(2);
  });
});

describe('model_freshness_events', () => {
  it('returns only pending events by default', async () => {
    const { handlers, events } = freshSetup();
    events.insert({ family: 'x', tag: 'y', oldDigest: 'o', newDigest: 'n' });
    const id = events.insert({ family: 'a', tag: 'b', oldDigest: 'o', newDigest: 'n' });
    events.acknowledge(id, 'me');
    const res = await handlers.model_freshness_events({});
    expect(res.events).toHaveLength(1);
    expect(res.events[0].family).toBe('x');
  });

  it('returns all events when include_acknowledged=true', async () => {
    const { handlers, events } = freshSetup();
    const id = events.insert({ family: 'x', tag: 'y', oldDigest: 'o', newDigest: 'n' });
    events.acknowledge(id, 'me');
    const res = await handlers.model_freshness_events({ include_acknowledged: true });
    expect(res.events).toHaveLength(1);
  });
});
