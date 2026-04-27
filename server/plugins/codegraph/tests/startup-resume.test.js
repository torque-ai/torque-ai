'use strict';

const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { createCodegraphPlugin } = require('../index');

describe('codegraph startup resume', () => {
  let db;
  let container;

  beforeEach(() => {
    process.env.TORQUE_CODEGRAPH_ENABLED = '1';
    db = new Database(':memory:');
    ensureSchema(db);
    db.prepare(`
      INSERT INTO cg_index_state (repo_path, commit_sha, indexed_at, files, symbols, references_count)
      VALUES ('/nonexistent/repo', 'abc', '2026-01-01T00:00:00Z', 0, 0, 0)
    `).run();
    container = {
      get(name) {
        if (name === 'db') return { getDbInstance: () => db };
        throw new Error('unknown service');
      },
    };
  });
  afterEach(() => { db.close(); delete process.env.TORQUE_CODEGRAPH_ENABLED; });

  it('install does not throw when a stored repo path is missing on disk', () => {
    const plugin = createCodegraphPlugin();
    expect(() => plugin.install(container)).not.toThrow();
  });

  it('install records unreachable repos in diagnostics', () => {
    const plugin = createCodegraphPlugin();
    plugin.install(container);
    const d = plugin.diagnostics();
    expect(d.unreachableRepos).toContain('/nonexistent/repo');
  });
});
