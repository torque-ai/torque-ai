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

  it('cg_find_references emits callerKind + caller modifiers when caller has them', async () => {
    // Add a file where an async function calls beta. The fixture's b.js
    // already declares beta(); we add an async caller in c.js.
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');
    fs.writeFileSync(path.join(repo, 'c.js'), 'async function callerAsync() { return beta(); }\n');
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add async caller'],
      { cwd: repo, windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    await handlers.cg_reindex({ repo_path: repo, async: false, force: true });

    const r = data(await handlers.cg_find_references({ repo_path: repo, symbol: 'beta' }));
    const asyncRef = r.references.find((x) => x.callerSymbol === 'callerAsync');
    expect(asyncRef).toBeTruthy();
    expect(asyncRef.callerKind).toBe('function');
    expect(asyncRef.callerIsAsync).toBe(true);
    expect(asyncRef.callerIsGenerator).toBeUndefined();  // sparse — only when truthy

    const syncRef = r.references.find((x) => x.callerSymbol === 'alpha');
    expect(syncRef).toBeTruthy();
    expect(syncRef.callerKind).toBe('function');
    expect(syncRef.callerIsAsync).toBeUndefined();
  });

  it('cg_call_graph nodes carry kind + modifier flags', async () => {
    const r = data(await handlers.cg_call_graph({
      repo_path: repo, symbol: 'alpha', direction: 'callees', depth: 1,
    }));
    const alpha = r.nodes.find((n) => n.name === 'alpha');
    const beta  = r.nodes.find((n) => n.name === 'beta');
    expect(alpha).toEqual(expect.objectContaining({ name: 'alpha', kind: 'function' }));
    expect(beta).toEqual(expect.objectContaining({ name: 'beta', kind: 'function' }));
    // Neither alpha nor beta is async in the fixture — sparse fields stay absent.
    expect(alpha.is_async).toBeUndefined();
    expect(beta.is_async).toBeUndefined();
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

  it('cg_resolve_tool returns empty handlers + candidates + convention_candidates + name-not-found hint', async () => {
    const r = data(await handlers.cg_resolve_tool({ repo_path: repo, tool_name: 'no_such_tool' }));
    expect(r.tool_name).toBe('no_such_tool');
    expect(r.handlers).toEqual([]);
    expect(r.candidates).toEqual([]);
    expect(r.convention_candidates).toEqual([]);
    expect(r.hint).toMatch(/handle<PascalCase> convention match/i);
  });

  it('cg_resolve_tool surfaces same-name symbols as candidates when no dispatcher matches', async () => {
    // The fixture repo has function alpha() in a.js. Querying an "alpha" tool
    // (no dispatcher anywhere) should fall back to the same-named symbol.
    const r = data(await handlers.cg_resolve_tool({ repo_path: repo, tool_name: 'alpha' }));
    expect(r.handlers).toEqual([]);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0]).toEqual(expect.objectContaining({
      name: 'alpha',
      file: 'a.js',
    }));
    expect(r.hint).toMatch(/very likely the actual handler/i);
  });

  it('cg_resolve_tool surfaces is_async / is_generator modifiers on candidates', async () => {
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');
    fs.writeFileSync(path.join(repo, 'mods.js'),
      'async function async_tool() {}\nfunction* gen_tool() {}\n');
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add mods'],
      { cwd: repo, windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    await handlers.cg_reindex({ repo_path: repo, async: false, force: true });

    const a = data(await handlers.cg_resolve_tool({ repo_path: repo, tool_name: 'async_tool' }));
    expect(a.candidates[0].is_async).toBe(true);
    expect(a.candidates[0].is_generator).toBeUndefined();  // sparse: only emit when truthy

    const g = data(await handlers.cg_resolve_tool({ repo_path: repo, tool_name: 'gen_tool' }));
    expect(g.candidates[0].kind).toBe('generator');
    expect(g.candidates[0].is_generator).toBe(true);
  });

  it('cg_resolve_tool falls back to handle<PascalCase> convention when no exact symbol exists', async () => {
    // Add a function named handleSomeTool to the fixture so the convention
    // fallback has a target. Test directly via the test-helper repo.
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');
    fs.writeFileSync(path.join(repo, 'c.js'), 'function handleSomeTool(args) { return null; }\n');
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add handler'],
      { cwd: repo, windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    await handlers.cg_reindex({ repo_path: repo, async: false, force: true });

    const r = data(await handlers.cg_resolve_tool({ repo_path: repo, tool_name: 'some_tool' }));
    expect(r.handlers).toEqual([]);
    expect(r.candidates).toEqual([]);
    expect(r.convention_candidates.length).toBeGreaterThan(0);
    expect(r.convention_candidates[0]).toEqual(expect.objectContaining({
      name: 'handleSomeTool',
      file: 'c.js',
    }));
    expect(r.hint).toMatch(/handle<PascalCase> convention/i);
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

  it('cg_reindex with if_tracked=true skips when repo is not in cg_index_state', async () => {
    // Fresh db without any indexed repos. The post-commit hook calls with
    // if_tracked=true so it never bootstraps a brand-new index.
    const freshDb = new Database(':memory:'); ensureSchema(freshDb);
    const freshHandlers = createHandlers({ db: freshDb });
    try {
      const r = data(await freshHandlers.cg_reindex({ repo_path: repo, if_tracked: true, async: false }));
      expect(r.skipped).toBe(true);
      expect(r.reason).toBe('not_tracked');
      expect(r.repo_path).toBe(repo);
      // No state row should have been created.
      const row = freshDb.prepare('SELECT 1 FROM cg_index_state WHERE repo_path = ?').get(repo);
      expect(row).toBeUndefined();
    } finally {
      freshDb.close();
    }
  });

  it('cg_reindex with if_tracked=true refreshes when repo is already indexed', async () => {
    // beforeEach indexed `repo`. With if_tracked=true the call should proceed
    // and return skipped:true (idempotent — index already matches HEAD).
    const r = data(await handlers.cg_reindex({ repo_path: repo, if_tracked: true, async: false }));
    expect(r.reason).toBeUndefined();           // not the not_tracked branch
    expect(r.skipped).toBe(true);               // idempotent: HEAD already indexed
    expect(r.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
