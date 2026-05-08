'use strict';

const Database = require('better-sqlite3');
const { createAutoRecoveryEngine } = require('../factory/auto-recovery/engine');

function setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_projects (
      id INTEGER PRIMARY KEY,
      name TEXT,
      status TEXT,
      loop_state TEXT,
      loop_batch_id TEXT,
      loop_paused_at_stage TEXT,
      auto_recovery_exhausted INTEGER DEFAULT 0,
      auto_recovery_attempts INTEGER DEFAULT 0,
      auto_recovery_last_action_at TEXT,
      auto_recovery_last_strategy TEXT
    );
    CREATE TABLE factory_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      stage TEXT,
      actor TEXT,
      action TEXT,
      reasoning TEXT,
      inputs_json TEXT,
      outcome_json TEXT,
      confidence REAL,
      batch_id TEXT,
      created_at TEXT
    );
  `);
  db.prepare(`INSERT INTO factory_projects (id, name, status, loop_state) VALUES (1, 'p', 'running', 'PAUSED')`).run();
  return db;
}

describe('auto_recovery_unknown_action production guard', () => {
  it('emits auto_recovery_unknown_action when classifier returns unknown matched_rule', () => {
    const db = setupDb();
    const engine = createAutoRecoveryEngine({
      db,
      logger: { info() {}, warn() {}, error() {} },
      eventBus: null,
      rules: [],
      strategies: [],
    });

    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, outcome_json, created_at) VALUES (1, 'execute', 'system', 'novel_failure_action', '{"work_item_id": 7, "error": "boom"}', datetime('now'))`).run();

    engine.recoverOne({ id: 1 });

    const guardRow = db.prepare(`SELECT action, outcome_json FROM factory_decisions WHERE action = 'auto_recovery_unknown_action'`).get();
    expect(guardRow).toBeDefined();
    const outcome = JSON.parse(guardRow.outcome_json);
    expect(outcome.original_action).toBe('novel_failure_action');
    expect(outcome.original_stage).toBe('execute');
    expect(outcome.outcome_keys).toEqual(expect.arrayContaining(['work_item_id', 'error']));
  });

  it('does NOT emit auto_recovery_unknown_action when classifier returns a real matched_rule', () => {
    const db = setupDb();
    const engine = createAutoRecoveryEngine({
      db,
      logger: { info() {}, warn() {}, error() {} },
      eventBus: null,
      rules: [{
        name: 'always_matches',
        category: 'transient',
        match_fn: () => true,
        suggested_strategies: ['retry'],
        confidence: 1,
      }],
      strategies: [],
    });

    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, outcome_json, created_at) VALUES (1, 'execute', 'system', 'matched_action', '{}', datetime('now'))`).run();

    engine.recoverOne({ id: 1 });

    const guardRow = db.prepare(`SELECT action FROM factory_decisions WHERE action = 'auto_recovery_unknown_action'`).get();
    expect(guardRow).toBeUndefined();
  });

  it('does NOT recurse on auto_recovery_unknown_action itself (classifier short-circuit)', () => {
    const db = setupDb();
    const engine = createAutoRecoveryEngine({
      db,
      logger: { info() {}, warn() {}, error() {} },
      eventBus: null,
      rules: [],
      strategies: [],
    });

    // Insert as a non-auto-recovery actor so the engine picks it up as the latest decision.
    // The short-circuit must fire before classify() runs, preventing a second emission.
    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, outcome_json, created_at) VALUES (1, 'execute', 'system', 'auto_recovery_unknown_action', '{}', datetime('now'))`).run();

    engine.recoverOne({ id: 1 });

    const rows = db.prepare(`SELECT id FROM factory_decisions WHERE action = 'auto_recovery_unknown_action'`).all();
    expect(rows.length).toBe(1);
  });
});
