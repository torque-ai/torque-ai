'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { createCodegraphPlugin } = require('../index');

describe('codegraph startup resume', () => {
  let dataDir;
  let container;
  let plugin;

  beforeEach(() => {
    process.env.TORQUE_CODEGRAPH_ENABLED = '1';
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-startup-'));

    // Pre-populate the dedicated codegraph.db with a stale repo entry. The
    // plugin's install path will open this same file and read the state.
    const seedDb = new Database(path.join(dataDir, 'codegraph.db'));
    ensureSchema(seedDb);
    seedDb.prepare(`
      INSERT INTO cg_index_state (repo_path, commit_sha, indexed_at, files, symbols, references_count)
      VALUES ('/nonexistent/repo', 'abc', '2026-01-01T00:00:00Z', 0, 0, 0)
    `).run();
    seedDb.close();

    container = {
      get(name) {
        if (name === 'db') return { getDataDir: () => dataDir };
        throw new Error('unknown service');
      },
    };
  });
  afterEach(() => {
    if (plugin) { try { plugin.uninstall(); } catch { /* ignore */ } plugin = null; }
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.TORQUE_CODEGRAPH_ENABLED;
  });

  it('install does not throw when a stored repo path is missing on disk', () => {
    plugin = createCodegraphPlugin();
    expect(() => plugin.install(container)).not.toThrow();
  });

  it('install records unreachable repos in diagnostics', () => {
    plugin = createCodegraphPlugin();
    plugin.install(container);
    const d = plugin.diagnostics();
    expect(d.unreachableRepos).toContain('/nonexistent/repo');
  });
});
