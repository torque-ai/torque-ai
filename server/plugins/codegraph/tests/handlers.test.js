'use strict';

const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { createHandlers } = require('../handlers');
const { setupTinyRepo, destroyTinyRepo } = require('../test-helpers');

// Handlers return MCP tool envelopes: { content: [{type, text}], structuredData }.
// Read structuredData for typed access; the REST passthrough re-parses
// content[0].text on the way out.
const data = (r) => r.structuredData;

describe('codegraph handlers', () => {
  let db, repo, handlers;

  beforeEach(async () => {
    db = new Database(':memory:'); ensureSchema(db);
    repo = setupTinyRepo();
    handlers = createHandlers({ db });
    await handlers.cg_reindex({ repo_path: repo, async: false });
  });

  afterEach(() => { db.close(); destroyTinyRepo(repo); });

  it('handlers return MCP envelope shape (content + structuredData)', async () => {
    const r = await handlers.cg_index_status({ repo_path: repo });
    expect(r.content).toBeInstanceOf(Array);
    expect(r.content[0].type).toBe('text');
    expect(typeof r.content[0].text).toBe('string');
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredData);
  });

  it('cg_index_status returns commit_sha + counts + staleness', async () => {
    const r = data(await handlers.cg_index_status({ repo_path: repo }));
    expect(r.commit_sha.length).toBe(40);
    expect(r.files).toBe(2);
    expect(r.symbols).toBe(2);
    expect(r.staleness.indexed).toBe(true);
    expect(r.staleness.stale).toBe(false);
    expect(r.staleness.indexed_sha).toBe(r.staleness.current_sha);
  });

  it('cg_find_references returns {references, staleness}', async () => {
    const r = data(await handlers.cg_find_references({ repo_path: repo, symbol: 'beta' }));
    expect(r.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ callerSymbol: 'alpha' }),
    ]));
    expect(r.staleness.stale).toBe(false);
  });

  it('cg_call_graph returns {nodes, edges, staleness}', async () => {
    const r = data(await handlers.cg_call_graph({
      repo_path: repo, symbol: 'alpha', direction: 'callees', depth: 1,
    }));
    expect(r.nodes.map((n) => n.name).sort()).toEqual(['alpha', 'beta']);
    expect(r.edges).toEqual([{ from: 'alpha', to: 'beta' }]);
    expect(r.staleness.stale).toBe(false);
  });

  it('cg_impact_set returns {symbols, files, staleness}', async () => {
    const r = data(await handlers.cg_impact_set({ repo_path: repo, symbol: 'beta', depth: 5 }));
    expect(r.symbols).toEqual(['alpha']);
    expect(r.files).toEqual(['a.js']);
    expect(r.staleness.stale).toBe(false);
  });

  it('cg_dead_symbols returns {dead_symbols, filter, staleness, caveat}', async () => {
    const r = data(await handlers.cg_dead_symbols({ repo_path: repo }));
    expect(r.dead_symbols.map((d) => d.name)).toContain('alpha');
    expect(r.staleness.stale).toBe(false);
    expect(typeof r.caveat).toBe('string');
    expect(r.caveat).toMatch(/dispatch/i);
    expect(r.filter).toEqual({ include_exported: false, include_likely_dispatched: false });
  });

  it('cg_dead_symbols include_likely_dispatched=true switches to permissive caveat', async () => {
    const r = data(await handlers.cg_dead_symbols({ repo_path: repo, include_likely_dispatched: true }));
    expect(r.filter.include_likely_dispatched).toBe(true);
    expect(r.caveat).toMatch(/permissive/i);
  });

  it('cg_resolve_tool returns empty handlers + hint when no dispatcher matches', async () => {
    const r = data(await handlers.cg_resolve_tool({ repo_path: repo, tool_name: 'no_such_tool' }));
    expect(r.tool_name).toBe('no_such_tool');
    expect(r.handlers).toEqual([]);
    expect(typeof r.hint).toBe('string');
  });

  it('staleness reports stale=true after a new commit lands without reindex', async () => {
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');
    fs.writeFileSync(path.join(repo, 'c.js'), 'function gamma() {}\n');
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add c.js'],
      { cwd: repo, windowsHide: true, stdio: ['ignore','ignore','pipe'] });

    const r = data(await handlers.cg_find_references({ repo_path: repo, symbol: 'beta' }));
    expect(r.staleness.stale).toBe(true);
    expect(r.staleness.indexed_sha).not.toBe(r.staleness.current_sha);
    expect(r.staleness.message).toMatch(/cg_reindex/);
  });

  it('all handlers reject when repo_path is missing', async () => {
    for (const name of ['cg_index_status', 'cg_reindex', 'cg_find_references', 'cg_call_graph', 'cg_impact_set', 'cg_dead_symbols']) {
      await expect(handlers[name]({})).rejects.toThrow(/repo_path/);
    }
  });
});
