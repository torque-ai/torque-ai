'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { runIndex } = require('../indexer');
const { findReferences } = require('../queries/find-references');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'tiny-repo');

describe('codegraph queries: find_references', () => {
  let db;

  beforeEach(async () => {
    db = new Database(':memory:');
    ensureSchema(db);
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
  });
  afterEach(() => db.close());

  it('finds the two callers of `beta`', () => {
    const rows = findReferences({ db, repoPath: FIXTURE, symbol: 'beta' });
    const callers = rows.map((r) => r.callerSymbol).sort();
    expect(callers).toEqual(['alpha', 'delta']);
  });

  it('returns empty array for an unknown symbol', () => {
    expect(findReferences({ db, repoPath: FIXTURE, symbol: 'nope' })).toEqual([]);
  });

  it('includes file, line, column for each reference', () => {
    const rows = findReferences({ db, repoPath: FIXTURE, symbol: 'beta' });
    for (const r of rows) {
      expect(typeof r.file).toBe('string');
      expect(typeof r.line).toBe('number');
      expect(typeof r.column).toBe('number');
    }
  });
});

const { callGraph } = require('../queries/call-graph');

describe('codegraph queries: call_graph', () => {
  let db;

  beforeEach(async () => {
    db = new Database(':memory:');
    ensureSchema(db);
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
  });
  afterEach(() => db.close());

  it('returns direct callees of `alpha` (depth 1)', () => {
    const g = callGraph({ db, repoPath: FIXTURE, symbol: 'alpha', direction: 'callees', depth: 1 });
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['alpha', 'beta']);
    expect(g.edges).toEqual([{ from: 'alpha', to: 'beta' }]);
  });

  it('returns transitive callers of `beta` at depth 2', () => {
    const g = callGraph({ db, repoPath: FIXTURE, symbol: 'beta', direction: 'callers', depth: 2 });
    const names = g.nodes.map((n) => n.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });

  it('direction=both unions callers and callees', () => {
    const g = callGraph({ db, repoPath: FIXTURE, symbol: 'alpha', direction: 'both', depth: 1 });
    const names = g.nodes.map((n) => n.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('clamps depth to a sane upper bound', () => {
    const g = callGraph({ db, repoPath: FIXTURE, symbol: 'beta', direction: 'callers', depth: 9999 });
    expect(g.nodes.length).toBeLessThanOrEqual(100);
  });
});
