'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { createHandlers } = require('../handlers');
const { setupTinyRepo, destroyTinyRepo, git } = require('../test-helpers');

const data = (r) => r.structuredData;

describe('cg_resolution_diagnostics', () => {
  let db, repo, handlers;

  beforeEach(async () => {
    db = new Database(':memory:'); ensureSchema(db);
    repo = setupTinyRepo();
    // Add fixtures that exercise each unresolved-reason bucket.
    fs.writeFileSync(path.join(repo, 'mod.js'),
      'export function indexedFn() {}\n' +
      'export class Animal { speak() {} }\n');
    fs.writeFileSync(path.join(repo, 'callers.js'),
      // Resolved via import: indexedFn import + call.
      "import { indexedFn } from './mod';\n" +
      "function callImported() { return indexedFn(); }\n" +
      // Unresolved — no import for the bare identifier 'noImportFn'.
      "function callBare() { return noImportFn(); }\n" +
      // Unresolved — import from a third-party module.
      "import { externalFn } from 'some-package';\n" +
      "function callExternal() { return externalFn(); }\n" +
      // Unresolved — relative import to a file that doesn't define this name.
      "import { phantom } from './mod';\n" +
      "function callPhantom() { return phantom(); }\n" +
      // Method call w/ receiver — no local-type binding.
      "function callMethodNoLocal() { return obj.speak(); }\n" +
      // Method call w/ receiver — receiver typed but type doesn't have method.
      "import { Animal } from './mod';\n" +
      "function callMethodWrongType() {\n" +
      "  const a = new Animal();\n" +
      "  return a.bark();\n" +
      "}\n");
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'fixture']);
    handlers = createHandlers({ db });
    await handlers.cg_reindex({ repo_path: repo, async: false });
  });

  afterEach(() => { db.close(); destroyTinyRepo(repo); });

  it('counts loose vs strict matches accurately', async () => {
    const r = data(await handlers.cg_resolution_diagnostics({ repo_path: repo, symbol: 'indexedFn' }));
    expect(r.symbol).toBe('indexedFn');
    expect(r.loose_count).toBeGreaterThan(0);
    expect(r.strict_count).toBeGreaterThanOrEqual(1);   // at least one resolved via import
    expect(r.loose_count).toBeGreaterThanOrEqual(r.strict_count);
  });

  it('classifies bare-identifier calls as no_import_for_target', async () => {
    const r = data(await handlers.cg_resolution_diagnostics({ repo_path: repo, symbol: 'noImportFn' }));
    expect(r.unresolved_count).toBeGreaterThanOrEqual(1);
    expect(r.reasons.no_import_for_target).toBeGreaterThanOrEqual(1);
    const sample = r.unresolved_samples.find((s) => s.callerSymbol === 'callBare');
    expect(sample).toBeTruthy();
    expect(sample.reason).toBe('no_import_for_target');
  });

  it('classifies bare-module imports as import_from_external_module', async () => {
    const r = data(await handlers.cg_resolution_diagnostics({ repo_path: repo, symbol: 'externalFn' }));
    expect(r.reasons.import_from_external_module).toBeGreaterThanOrEqual(1);
    const sample = r.unresolved_samples.find((s) => s.callerSymbol === 'callExternal');
    expect(sample.reason).toBe('import_from_external_module');
  });

  it('classifies relative imports of unindexed names as import_to_unindexed_local_file', async () => {
    const r = data(await handlers.cg_resolution_diagnostics({ repo_path: repo, symbol: 'phantom' }));
    expect(r.reasons.import_to_unindexed_local_file).toBeGreaterThanOrEqual(1);
  });

  it('records unresolved samples up to sample_size', async () => {
    const r = data(await handlers.cg_resolution_diagnostics({
      repo_path: repo, symbol: 'noImportFn', sample_size: 5,
    }));
    expect(r.sample_size).toBe(5);
    expect(r.unresolved_samples.length).toBeLessThanOrEqual(5);
  });

  it('returns empty reasons when symbol has no unresolved refs', async () => {
    // 'indexedFn' from mod.js: there's a resolved import call, so unresolved
    // for that name might still include the bare-call test above. Use a
    // symbol that doesn't appear in callers.js to exercise the empty path.
    const r = data(await handlers.cg_resolution_diagnostics({ repo_path: repo, symbol: 'completelyUnused' }));
    expect(r.unresolved_count).toBe(0);
    expect(Object.keys(r.reasons)).toHaveLength(0);
    expect(r.unresolved_samples).toHaveLength(0);
  });

  it('rejects when repo_path or symbol is missing', async () => {
    await expect(handlers.cg_resolution_diagnostics({ symbol: 'X' })).rejects.toThrow(/repo_path/);
    await expect(handlers.cg_resolution_diagnostics({ repo_path: repo })).rejects.toThrow(/symbol/);
  });

  it('caps sample_size at 200', async () => {
    const r = data(await handlers.cg_resolution_diagnostics({
      repo_path: repo, symbol: 'noImportFn', sample_size: 9999,
    }));
    expect(r.sample_size).toBe(200);
  });

  it('classifies this.X() inherited from a captured base class as inherited_method_resolution_gap', async () => {
    // Fresh repo: a Base class with method bark, a Derived subclass that
    // calls this.bark(). Pass 2 doesn't currently walk extends, so the
    // call is unresolved; the classifier must recognize the inherited
    // method instead of falsely labeling it "enclosing class lacks method".
    const repo2 = setupTinyRepo('cg-inh-');
    fs.writeFileSync(path.join(repo2, 'inh.js'),
      'class Base { bark() { return 1; } }\n' +
      'class Derived extends Base {\n' +
      '  speak() { return this.bark(); }\n' +
      '}\n');
    git(repo2, ['add', '.']);
    git(repo2, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'inh']);
    const db2 = new Database(':memory:'); ensureSchema(db2);
    const h2 = createHandlers({ db: db2 });
    await h2.cg_reindex({ repo_path: repo2, async: false });
    try {
      const r = data(await h2.cg_resolution_diagnostics({ repo_path: repo2, symbol: 'bark' }));
      // Derived.speak's call to this.bark() is unresolved (inheritance not
      // walked by pass 2). Classifier should now spot the inherited method.
      expect(r.reasons.inherited_method_resolution_gap || 0).toBeGreaterThanOrEqual(1);
      // And the wrong "enclosing class lacks method" bucket must NOT have
      // been chosen for that ref.
      const sample = r.unresolved_samples.find((s) => s.callerSymbol === 'speak');
      if (sample) {
        expect(sample.reason).toBe('inherited_method_resolution_gap');
      }
    } finally {
      db2.close();
      destroyTinyRepo(repo2);
    }
  });
});
