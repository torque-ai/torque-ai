import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const attemptHistory = require('../db/factory-attempt-history');
const factoryHealth = require('../db/factory-health');
const factoryDecisions = require('../db/factory-decisions');
const loopController = require('../factory/loop-controller');

describe('loop-controller — ship-noop auto-route', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE factory_projects (id TEXT PRIMARY KEY, name TEXT, trust_level TEXT, config_json TEXT);
      CREATE TABLE factory_work_items (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, status TEXT, metadata_json TEXT);
      CREATE TABLE factory_loop_instances (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_item_id INTEGER,
        batch_id TEXT, loop_state TEXT NOT NULL DEFAULT 'IDLE',
        paused_at_stage TEXT, last_action_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        terminated_at TEXT
      );
      CREATE TABLE factory_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, batch_id TEXT,
        stage TEXT, action TEXT, reasoning TEXT, outcome_json TEXT, created_at TEXT NOT NULL
      );
    `);
    runMigrations(db);
    attemptHistory.setDb(db);
    factoryHealth.setDb(db);
    factoryDecisions.setDb(db);
  });

  afterEach(() => { db.close(); });

  function insertProject({ flagOn }) {
    db.prepare('INSERT INTO factory_projects (id, name, trust_level, config_json) VALUES (?, ?, ?, ?)').run(
      'proj-1', 'test', 'dark', JSON.stringify(flagOn ? { feature_flags: { auto_ship_noop_enabled: true } } : {})
    );
  }

  function insertWorkItem(id) {
    db.prepare('INSERT INTO factory_work_items (id, project_id, status) VALUES (?, ?, ?)').run(id, 'proj-1', 'prioritized');
  }

  it('advances to LEARN with shipped_as_noop when reason=already_in_place, conf=1.0, flag=on', async () => {
    insertProject({ flagOn: true });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-n1', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'already_in_place',
      classifier_source: 'heuristic', classifier_conf: 1.0,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-n1', work_item_id: '42',
    });
    expect(result).toEqual(expect.objectContaining({ shipped_as_noop: true }));
    const decision = db.prepare("SELECT action FROM factory_decisions WHERE batch_id='batch-n1' AND action='shipped_as_noop'").get();
    expect(decision).toBeDefined();
  });

  it('does not ship-noop when flag is off', async () => {
    insertProject({ flagOn: false });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-n2', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'already_in_place',
      classifier_source: 'heuristic', classifier_conf: 1.0,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-n2', work_item_id: '42',
    });
    expect(result.shipped_as_noop).toBe(false);
  });

  it('does not ship-noop when confidence < 0.8', async () => {
    insertProject({ flagOn: true });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-n3', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'already_in_place',
      classifier_source: 'llm', classifier_conf: 0.7,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-n3', work_item_id: '42',
    });
    expect(result.shipped_as_noop).toBe(false);
  });

  it('emits paused_at_gate with paused_reason=blocked_by_codex when reason=blocked', async () => {
    insertProject({ flagOn: true });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-n4', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'blocked',
      classifier_source: 'heuristic', classifier_conf: 1.0,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-n4', work_item_id: '42',
    });
    expect(result).toEqual(expect.objectContaining({ paused: true, paused_reason: 'blocked_by_codex' }));
    const decision = db.prepare("SELECT * FROM factory_decisions WHERE batch_id='batch-n4' AND action='paused_at_gate'").get();
    const outcome = JSON.parse(decision.outcome_json);
    expect(outcome.paused_reason).toBe('blocked_by_codex');
  });
});
