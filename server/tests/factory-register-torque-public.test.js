'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const factoryHealth = require('../db/factory/health');

function createFactoryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      loop_state TEXT DEFAULT 'IDLE',
      loop_batch_id TEXT,
      loop_last_action_at TEXT,
      loop_paused_at_stage TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

describe('torque-public factory registration', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
  });

  afterEach(() => {
    factoryHealth.setDb(null);
    db.close();
  });

  it('uses the discovered registration module export', () => {
    expect(factoryHealth).toBeTruthy();
    expect(typeof factoryHealth.registerProject).toBe('function');
  });

  it('registers torque-public with supervised trust, IDLE loop state, and factory config', () => {
    const registerScript = require('../scripts/register-torque-public-factory');
    const repoRoot = path.resolve(__dirname, '..', '..');
    const result = registerScript.registerTorquePublicFactory({
      factoryProjects: factoryHealth,
      initDb: false,
      repoRoot,
    });

    const row = db.prepare(`
      SELECT id, name, path, trust_level, status, loop_state, config_json
      FROM factory_projects
      WHERE id = ?
    `).get(result.id);

    const normalizedRepoRoot = path.resolve(repoRoot).replace(/\\/g, '/');
    expect(row).toBeTruthy();
    expect(row.name).toBe('torque-public');
    expect(row.path).toBe(normalizedRepoRoot);
    expect(row.trust_level).toBe('supervised');
    expect(String(row.loop_state || '').toUpperCase()).toBe('IDLE');

    const config = JSON.parse(row.config_json);
    expect(config).toMatchObject({
      plans_dir: path.join(repoRoot, 'docs', 'superpowers', 'plans'),
      verify_command: 'npx vitest run',
      ui_review: false,
    });
  });
});
