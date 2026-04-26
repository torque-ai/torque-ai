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
