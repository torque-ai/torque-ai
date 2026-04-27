'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { runIndex } = require('../indexer');
const { resolveTool } = require('../queries/resolve-tool');
const { extractFromSource } = require('../extractors/javascript');

describe('codegraph dispatch-edge capture', () => {
  it('extractor captures case-string → handler-name from a switch dispatcher', async () => {
    const src = `
      function dispatch(name, args) {
        switch (name) {
          case 'foo': return handleFoo(args);
          case 'bar': return handleBar(args);
          case 'baz': { return handleBaz(args); }
        }
      }
    `;
    const result = await extractFromSource(src, 'javascript');
    const edges = result.dispatchEdges;
    const map = Object.fromEntries(edges.map((e) => [e.caseString, e.handlerName]));
    expect(map).toEqual({ foo: 'handleFoo', bar: 'handleBar', baz: 'handleBaz' });
  });

  it('extractor skips coercion built-ins in the case body and prefers return-position calls', async () => {
    const src = `
      function dispatch(name, args) {
        switch (name) {
          case 'init': { const x = Boolean(args); return realHandler(x); }
          case 'parse': return parseInt(args, 10);
          case 'wrap': return helper(Number(args));
        }
      }
    `;
    const result = await extractFromSource(src, 'javascript');
    const map = Object.fromEntries(result.dispatchEdges.map((e) => [e.caseString, e.handlerName]));
    expect(map.init).toBe('realHandler');
    expect(map.parse).toBeUndefined();
    expect(map.wrap).toBe('helper');
  });

  it('extractor captures member-expression handlers (handlers.foo())', async () => {
    const src = `
      function dispatch(name, args) {
        switch (name) {
          case 'foo': return handlers.handleFoo(args);
        }
      }
    `;
    const result = await extractFromSource(src, 'javascript');
    expect(result.dispatchEdges).toEqual([
      expect.objectContaining({ caseString: 'foo', handlerName: 'handleFoo' }),
    ]);
  });

  it('extractor captures CommonJS module.exports = { ... } as exported names', async () => {
    const src = `
      function publicFn() {}
      function privateFn() {}
      module.exports = { publicFn };
    `;
    const result = await extractFromSource(src, 'javascript');
    expect(result.exportedNames.sort()).toEqual(['publicFn']);
    const map = Object.fromEntries(result.symbols.map((s) => [s.name, s.isExported]));
    expect(map.publicFn).toBe(true);
    expect(map.privateFn).toBe(false);
  });

  it('extractor captures ESM `export function X() {}` as exported', async () => {
    const src = `
      export function exported() {}
      function notExported() {}
    `;
    const result = await extractFromSource(src, 'tsx');
    expect(result.exportedNames).toContain('exported');
    expect(result.exportedNames).not.toContain('notExported');
  });

  it('end-to-end: indexer persists dispatch_edges + resolveTool returns handler', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dispatch-'));
    fs.writeFileSync(path.join(tmpRepo, 'tools.js'), `
      function handleAlpha(args) { return 1; }
      function handleBeta(args)  { return 2; }
      function dispatch(name, args) {
        switch (name) {
          case 'alpha_tool': return handleAlpha(args);
          case 'beta_tool':  return handleBeta(args);
        }
      }
    `);
    const db = new Database(':memory:');
    ensureSchema(db);
    return runIndex({ db, repoPath: tmpRepo, files: ['tools.js'] }).then((r) => {
      expect(r.dispatch_edges).toBe(2);
      const handlers = resolveTool({ db, repoPath: tmpRepo, toolName: 'alpha_tool' });
      expect(handlers).toEqual([
        expect.objectContaining({ toolName: 'alpha_tool', handlerName: 'handleAlpha', file: 'tools.js' }),
      ]);
      const empty = resolveTool({ db, repoPath: tmpRepo, toolName: 'no_such' });
      expect(empty).toEqual([]);
      db.close();
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    });
  });

  it('dead-symbols default mode hides dispatch handlers', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dead-'));
    fs.writeFileSync(path.join(tmpRepo, 'tools.js'), `
      function handleFoo(args) {}
      function dispatch(name, args) {
        switch (name) {
          case 'foo': return handleFoo(args);
        }
      }
    `);
    const db = new Database(':memory:');
    ensureSchema(db);
    return runIndex({ db, repoPath: tmpRepo, files: ['tools.js'] }).then(() => {
      const { deadSymbols } = require('../queries/dead-symbols');
      const dead = deadSymbols({ db, repoPath: tmpRepo });
      // handleFoo IS called from the dispatcher case. Without dispatch-edge
      // tracking it would appear dead because cg_references has no row for
      // it (the call site is inside the case body — captured as BOTH a
      // regular reference AND a dispatch edge). Either way handleFoo is
      // not in the dead list.
      const names = dead.map((d) => d.name);
      expect(names).not.toContain('handleFoo');
      db.close();
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    });
  });
});
