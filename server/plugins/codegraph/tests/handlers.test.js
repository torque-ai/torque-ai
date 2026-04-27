'use strict';

const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { createHandlers } = require('../handlers');
const { setupTinyRepo, destroyTinyRepo } = require('../test-helpers');

describe('codegraph handlers', () => {
  let db, repo, handlers;

  beforeEach(async () => {
    db = new Database(':memory:'); ensureSchema(db);
    repo = setupTinyRepo();
    handlers = createHandlers({ db });
    await handlers.cg_reindex({ repo_path: repo, async: false });
  });

  afterEach(() => { db.close(); destroyTinyRepo(repo); });

  it('cg_index_status returns commit_sha + counts', async () => {
    const r = await handlers.cg_index_status({ repo_path: repo });
    expect(r.commit_sha.length).toBe(40);
    expect(r.files).toBe(2);
    expect(r.symbols).toBe(2);
  });

  it('cg_find_references finds beta callers', async () => {
    const r = await handlers.cg_find_references({ repo_path: repo, symbol: 'beta' });
    expect(r).toEqual(expect.arrayContaining([
      expect.objectContaining({ callerSymbol: 'alpha' }),
    ]));
  });

  it('cg_call_graph returns nodes + edges', async () => {
    const r = await handlers.cg_call_graph({
      repo_path: repo, symbol: 'alpha', direction: 'callees', depth: 1,
    });
    expect(r.nodes.map((n) => n.name).sort()).toEqual(['alpha', 'beta']);
    expect(r.edges).toEqual([{ from: 'alpha', to: 'beta' }]);
  });

  it('cg_impact_set returns symbols + files', async () => {
    const r = await handlers.cg_impact_set({ repo_path: repo, symbol: 'beta', depth: 5 });
    expect(r.symbols).toEqual(['alpha']);
    expect(r.files).toEqual(['a.js']);
  });

  it('cg_dead_symbols flags alpha (alpha is not called)', async () => {
    const r = await handlers.cg_dead_symbols({ repo_path: repo });
    expect(r.map((d) => d.name)).toContain('alpha');
  });

  it('all handlers reject when repo_path is missing', async () => {
    for (const name of ['cg_index_status', 'cg_reindex', 'cg_find_references', 'cg_call_graph', 'cg_impact_set', 'cg_dead_symbols']) {
      await expect(handlers[name]({})).rejects.toThrow(/repo_path/);
    }
  });
});
