'use strict';

const Database = require('better-sqlite3');
const factoryHealth = require('../db/factory-health');
const factoryFeedback = require('../db/factory-feedback');
const guardrailDb = require('../db/factory-guardrails');
const { defaultContainer } = require('../container');
const loopController = require('../factory/loop-controller');
// vitest globals (describe/it/beforeEach/afterEach/expect) are injected by the test runner.

const FEEDBACK_ANALYSIS_PATH = require.resolve('../factory/feedback');

function resetFeedbackAnalysisModule() {
  delete require.cache[FEEDBACK_ANALYSIS_PATH];
}

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      dimension TEXT NOT NULL,
      score REAL NOT NULL,
      details_json TEXT,
      scan_type TEXT NOT NULL DEFAULT 'incremental',
      batch_id TEXT,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_fhs_project_dim ON factory_health_snapshots(project_id, dimension, scanned_at)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_health_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES factory_health_snapshots(id),
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      file_path TEXT,
      details_json TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      batch_id TEXT,
      health_delta_json TEXT,
      execution_metrics_json TEXT,
      guardrail_activity_json TEXT,
      human_corrections_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ff_project_time ON factory_feedback(project_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ff_batch ON factory_feedback(batch_id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_guardrail_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      category TEXT NOT NULL,
      check_name TEXT NOT NULL,
      status TEXT NOT NULL,
      details_json TEXT,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_fge_project_time ON factory_guardrail_events(project_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_fge_category ON factory_guardrail_events(project_id, category)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_family_templates (
      family TEXT PRIMARY KEY,
      system_prompt TEXT NOT NULL,
      tuning_json TEXT NOT NULL,
      size_overrides TEXT
    )
  `);
}

let db;

function insertProject(overrides = {}) {
  const now = new Date().toISOString();
  const project = {
    id: 'p1',
    name: 'p1',
    path: '/tmp/p1',
    brief: null,
    trust_level: 'supervised',
    status: 'paused',
    config_json: null,
    loop_state: 'LEARN',
    loop_batch_id: 'batch-abc',
    loop_last_action_at: now,
    loop_paused_at_stage: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };

  db.prepare(`
    INSERT INTO factory_projects (
      id,
      name,
      path,
      brief,
      trust_level,
      status,
      config_json,
      loop_state,
      loop_batch_id,
      loop_last_action_at,
      loop_paused_at_stage,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.id,
    project.name,
    project.path,
    project.brief,
    project.trust_level,
    project.status,
    project.config_json,
    project.loop_state,
    project.loop_batch_id,
    project.loop_last_action_at,
    project.loop_paused_at_stage,
    project.created_at,
    project.updated_at
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  createFactoryTables(db);
  factoryHealth.setDb(db);
  factoryFeedback.setDb(db);
  guardrailDb.setDb(db);

  defaultContainer.resetForTest && defaultContainer.resetForTest();
  if (defaultContainer.has('db')) {
    defaultContainer.unregister && defaultContainer.unregister('db');
  }
  defaultContainer.registerValue('db', db);
  defaultContainer.boot();

  resetFeedbackAnalysisModule();
});

afterEach(() => {
  resetFeedbackAnalysisModule();
  defaultContainer.resetForTest && defaultContainer.resetForTest();

  try {
    db.close();
  } catch {
    // Some failure-injection cases intentionally leave module state pointing at invalid DB-like objects.
  }
  db = null;
});

describe('loopController.advanceLoop LEARN stage', () => {
  it('LEARN stage returns a non-null analysis when a batch_id is attached', async () => {
    insertProject();

    const result = await loopController.advanceLoop('p1');

    expect(result.stage_result).toEqual(
      expect.objectContaining({
        summary: expect.any(String),
      })
    );
    expect(result.stage_result).not.toBeNull();
    expect(result.stage_result.status).not.toBe('error');
  });

  it('LEARN stage returns a structured error status when feedback DB is unavailable', async () => {
    insertProject();

    const brokenDb = { prepare: null };
    const originalGet = defaultContainer.get;

    factoryFeedback.setDb(brokenDb);
    defaultContainer.get = () => brokenDb;
    resetFeedbackAnalysisModule();

    try {
      const result = await loopController.advanceLoop('p1');

      expect(result.stage_result.status).toBe('error');
      expect(typeof result.stage_result.error).toBe('string');
    } finally {
      defaultContainer.get = originalGet;
    }
  });
});
