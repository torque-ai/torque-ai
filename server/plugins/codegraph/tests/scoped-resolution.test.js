'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { createHandlers } = require('../handlers');
const { destroyTinyRepo, git } = require('../test-helpers');

const data = (r) => r.structuredData;

describe('scoped resolution (function calls via imports)', () => {
  let repo, db, handlers;

  beforeEach(async () => {
    db = new Database(':memory:');
    ensureSchema(db);

    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scope-'));
    fs.writeFileSync(path.join(repo, 'utils.js'),
      'function init() { return 1; }\n' +
      'function other() { return 2; }\n' +
      'module.exports = { init, other };\n');
    fs.writeFileSync(path.join(repo, 'app.js'),
      'const { init } = require("./utils");\n' +
      'function main() { return init(); }\n' +
      'module.exports = { main };\n');
    fs.writeFileSync(path.join(repo, 'unrelated.js'),
      'function init() { return 99; }\n' +
      'function caller() { return init(); }\n' +
      'module.exports = { caller };\n');
    git(repo, ['init', '--quiet']);
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);

    handlers = createHandlers({ db });
    await handlers.cg_reindex({ repo_path: repo, async: false });
  });

  afterEach(() => {
    db.close();
    destroyTinyRepo(repo);
  });

  it('reindex result reports import + resolved_reference counts', async () => {
    const r = await handlers.cg_reindex({ repo_path: repo, async: false, force: true });
    expect(data(r).imports).toBeGreaterThan(0);
    expect(data(r).resolved_references).toBeGreaterThan(0);
  });

  it('loose scope returns all identifier matches (high recall)', async () => {
    const r = await handlers.cg_find_references({ repo_path: repo, symbol: 'init' });
    const files = data(r).references.map((x) => x.file).sort();
    // app.js calls the imported init; unrelated.js calls its own local init.
    // Both have target_name=init, so loose mode surfaces both.
    expect(files).toEqual(['app.js', 'unrelated.js']);
    expect(data(r).scope).toBe('loose');
  });

  it('strict scope only returns import-resolved references', async () => {
    const r = await handlers.cg_find_references({
      repo_path: repo, symbol: 'init', scope: 'strict',
    });
    const files = data(r).references.map((x) => x.file);
    // Only app.js's init() is import-resolved; unrelated.js's init is a
    // local function call that didn't go through any import binding.
    expect(files).toEqual(['app.js']);
    expect(data(r).scope).toBe('strict');
  });

  it('rejects unknown scope values', async () => {
    await expect(handlers.cg_find_references({
      repo_path: repo, symbol: 'init', scope: 'sloppy',
    })).rejects.toThrow(/scope must be/);
  });

  it('cg_call_graph respects scope', async () => {
    // Loose: callers of init pulls in both `main` (app.js) and `caller` (unrelated.js).
    const loose = await handlers.cg_call_graph({
      repo_path: repo, symbol: 'init', direction: 'callers',
    });
    const looseCallers = data(loose).edges.map((e) => e.from).sort();
    expect(looseCallers).toEqual(['caller', 'main']);

    // Strict: only `main` (the import-resolved caller).
    const strict = await handlers.cg_call_graph({
      repo_path: repo, symbol: 'init', direction: 'callers', scope: 'strict',
    });
    const strictCallers = data(strict).edges.map((e) => e.from);
    expect(strictCallers).toEqual(['main']);
  });

  it('cg_impact_set respects scope', async () => {
    const loose = await handlers.cg_impact_set({ repo_path: repo, symbol: 'init' });
    const strict = await handlers.cg_impact_set({
      repo_path: repo, symbol: 'init', scope: 'strict',
    });
    expect(data(loose).symbols.sort()).toEqual(['caller', 'main']);
    expect(data(strict).symbols).toEqual(['main']);
  });

  it('cross-package imports do not get resolved (no false positives)', async () => {
    // Add a file that imports from a module not in the repo.
    fs.writeFileSync(path.join(repo, 'pkg-import.js'),
      'const x = require("lodash");\nfunction useIt() { return x(); }\n');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add lodash']);

    await handlers.cg_reindex({ repo_path: repo, async: false, force: true });

    // Strict-scope query for `x` should return nothing — there's no in-repo
    // symbol named `x` to resolve to, so resolved_symbol_id stays NULL.
    const strict = await handlers.cg_find_references({
      repo_path: repo, symbol: 'x', scope: 'strict',
    });
    expect(data(strict).references).toEqual([]);
  });
});
