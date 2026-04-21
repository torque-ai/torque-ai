'use strict';
const Database = require('better-sqlite3');
const { runSchemaMigrations } = require('../db/schema-migrations');

describe('factory_projects auto-recovery columns', () => {
  let db;
  beforeAll(() => {
    db = new Database(':memory:');
    db.prepare(`CREATE TABLE factory_projects (
      id TEXT PRIMARY KEY, name TEXT, status TEXT,
      loop_state TEXT, loop_paused_at_stage TEXT, loop_last_action_at TEXT
    )`).run();
    runSchemaMigrations(db);
  });

  const expected = [
    { name: 'auto_recovery_attempts', type: 'INTEGER', dflt: '0' },
    { name: 'auto_recovery_last_action_at', type: 'TEXT', dflt: null },
    { name: 'auto_recovery_exhausted', type: 'INTEGER', dflt: '0' },
    { name: 'auto_recovery_last_strategy', type: 'TEXT', dflt: null },
  ];

  for (const col of expected) {
    it(`adds column ${col.name}`, () => {
      const columns = db.prepare('PRAGMA table_info(factory_projects)').all();
      const found = columns.find(c => c.name === col.name);
      expect(found).toBeTruthy();
      expect(String(found.type).toUpperCase()).toBe(col.type);
      if (col.dflt === null) {
        expect(found.dflt_value).toBeNull();
      } else {
        expect(String(found.dflt_value)).toBe(col.dflt);
      }
    });
  }

  it('is idempotent (running again does not throw)', () => {
    expect(() => runSchemaMigrations(db)).not.toThrow();
  });
});

describe('factory-decisions VALID_ACTORS', () => {
  it('accepts auto-recovery as a valid actor', () => {
    const { recordDecision, setDb } = require('../db/factory-decisions');
    const db = new Database(':memory:');
    db.prepare(`CREATE TABLE factory_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      stage TEXT, actor TEXT, action TEXT,
      reasoning TEXT, inputs_json TEXT, outcome_json TEXT,
      confidence REAL, batch_id TEXT, created_at TEXT
    )`).run();
    setDb(db);
    expect(() => recordDecision({
      project_id: 'p1', stage: 'verify', actor: 'auto-recovery',
      action: 'auto_recovery_classified', confidence: 1,
    })).not.toThrow();
  });
});
