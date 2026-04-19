'use strict';

const Database = require('better-sqlite3');
const { createAutoSeed } = require('../auto-seed');
const { createWatchlistStore, WATCHLIST_SCHEMA } = require('../watchlist-store');

afterEach(() => vi.restoreAllMocks());

function freshDb() {
  const db = new Database(':memory:');
  db.prepare(WATCHLIST_SCHEMA).run();
  return db;
}

describe('auto-seed.seedFromHosts', () => {
  it('inserts one row per family:tag discovered on any host', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const listHosts = vi.fn().mockReturnValue([
      { id: 'h1', url: 'http://host-a.test:11434' },
      { id: 'h2', url: 'http://host-b.test:11434' },
    ]);
    const fetchTags = vi.fn().mockImplementation(async (url) => {
      if (url.includes('host-a')) return ['qwen3-coder:30b', 'gemma4:latest'];
      return ['qwen3.5:latest', 'gemma4:latest']; // overlap with host-a
    });

    const seed = createAutoSeed({ watchlist, listHosts, fetchTags });
    const result = await seed.seedFromHosts();

    expect(result.added).toBe(3); // qwen3-coder:30b, gemma4:latest, qwen3.5:latest
    const rows = watchlist.listAll();
    expect(rows.map(r => `${r.family}:${r.tag}`).sort())
      .toEqual(['gemma4:latest', 'qwen3-coder:30b', 'qwen3.5:latest']);
    rows.forEach(r => expect(r.source).toBe('auto-seed'));
  });

  it('skips *-cloud tags', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const seed = createAutoSeed({
      watchlist,
      listHosts: vi.fn().mockReturnValue([{ id: 'h1', url: 'http://host-a.test:11434' }]),
      fetchTags: vi.fn().mockResolvedValue(['qwen3-coder:480b-cloud', 'qwen3-coder:30b']),
    });
    await seed.seedFromHosts();
    const rows = watchlist.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].tag).toBe('30b');
  });

  it('is idempotent — second run adds zero', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const seed = createAutoSeed({
      watchlist,
      listHosts: vi.fn().mockReturnValue([{ id: 'h1', url: 'http://host-a.test:11434' }]),
      fetchTags: vi.fn().mockResolvedValue(['qwen3-coder:30b']),
    });
    const r1 = await seed.seedFromHosts();
    const r2 = await seed.seedFromHosts();
    expect(r1.added).toBe(1);
    expect(r2.added).toBe(0);
  });

  it('tolerates an unreachable host', async () => {
    const db = freshDb();
    const watchlist = createWatchlistStore(db);
    const seed = createAutoSeed({
      watchlist,
      listHosts: vi.fn().mockReturnValue([
        { id: 'h1', url: 'http://host-a.test:11434' },
        { id: 'h2', url: 'http://host-b.test:11434' },
      ]),
      fetchTags: vi.fn().mockImplementation(async (url) => {
        if (url.includes('host-a')) throw new Error('ECONNREFUSED');
        return ['qwen3.5:latest'];
      }),
    });
    const r = await seed.seedFromHosts();
    expect(r.added).toBe(1);
  });
});
