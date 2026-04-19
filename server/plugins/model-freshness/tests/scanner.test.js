'use strict';

const Database = require('better-sqlite3');
const { createScanner } = require('../scanner');
const { createWatchlistStore, WATCHLIST_SCHEMA } = require('../watchlist-store');
const { createEventsStore, EVENTS_SCHEMA } = require('../events-store');

afterEach(() => vi.restoreAllMocks());

function freshDb() {
  const db = new Database(':memory:');
  db.prepare(WATCHLIST_SCHEMA).run();
  db.prepare(EVENTS_SCHEMA).run();
  return db;
}

describe('scanner.runScan', () => {
  it('emits an event when remote digest differs from local', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const events = createEventsStore(db);

    watchlist.add({ family: 'qwen3-coder', tag: '30b', source: 'user' });
    watchlist.recordScan('qwen3-coder', '30b', 'digest-old');

    const fetchLocalDigest = vi.fn().mockResolvedValue('digest-old');
    const fetchRemoteDigest = vi.fn().mockResolvedValue('digest-new');
    const listHosts = vi.fn().mockReturnValue([{ id: 'h1' }]);
    const notify = vi.fn();

    const scanner = createScanner({ watchlist, events, fetchLocalDigest, fetchRemoteDigest, listHosts, notify });
    const result = await scanner.runScan();

    expect(result.eventsEmitted).toBe(1);
    expect(events.listPending()).toHaveLength(1);
    expect(events.listPending()[0].new_digest).toBe('digest-new');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('emits no event when digests match', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const events = createEventsStore(db);

    watchlist.add({ family: 'q', tag: 'r', source: 'user' });
    watchlist.recordScan('q', 'r', 'same-digest');

    const scanner = createScanner({
      watchlist, events,
      fetchLocalDigest: vi.fn().mockResolvedValue('same-digest'),
      fetchRemoteDigest: vi.fn().mockResolvedValue('same-digest'),
      listHosts: vi.fn().mockReturnValue([{ id: 'h1' }]),
      notify: vi.fn(),
    });

    await scanner.runScan();
    expect(events.listPending()).toHaveLength(0);
  });

  it('deactivates rows whose model is no longer installed on any host', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const events = createEventsStore(db);

    watchlist.add({ family: 'orphan', tag: 'v1', source: 'auto-seed' });

    const scanner = createScanner({
      watchlist, events,
      fetchLocalDigest: vi.fn().mockResolvedValue(null), // not found locally
      fetchRemoteDigest: vi.fn(),
      listHosts: vi.fn().mockReturnValue([{ id: 'h1' }]),
      notify: vi.fn(),
    });

    await scanner.runScan();
    const row = watchlist.getByFamilyTag('orphan', 'v1');
    expect(row.active).toBe(0);
  });

  it('tolerates registry failure on one family without killing the whole scan', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const events = createEventsStore(db);

    watchlist.add({ family: 'a', tag: 'b', source: 'user' });
    watchlist.recordScan('a', 'b', 'local-a');
    watchlist.add({ family: 'c', tag: 'd', source: 'user' });
    watchlist.recordScan('c', 'd', 'local-c');

    const scanner = createScanner({
      watchlist, events,
      fetchLocalDigest: vi.fn().mockImplementation(async (f) => (f === 'a' ? 'local-a' : 'local-c')),
      fetchRemoteDigest: vi.fn().mockImplementation(async (f) => {
        if (f === 'a') throw new Error('registry 503');
        return 'remote-c-new';
      }),
      listHosts: vi.fn().mockReturnValue([{ id: 'h1' }]),
      notify: vi.fn(),
    });

    const result = await scanner.runScan();
    expect(result.errors).toHaveLength(1);
    expect(result.eventsEmitted).toBe(1); // family c still emits
  });
});
