import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const Database = require('better-sqlite3');
const database = require('../database');
const factoryHealth = require('../db/factory-health');
const factoryFeedback = require('../db/factory-feedback');
const costTracking = require('../db/cost-tracking');
const handlers = require('../handlers/factory-handlers');
const {
  getCostPerCycle,
  getCostPerHealthPoint,
  getProviderEfficiency,
} = require('../factory/cost-metrics');

function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      batch_id TEXT,
      health_delta_json TEXT,
      execution_metrics_json TEXT,
      guardrail_activity_json TEXT,
      human_corrections_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      provider TEXT,
      workflow_id TEXT,
      tags TEXT
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      model TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      project TEXT
    );

    CREATE TABLE IF NOT EXISTS cost_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT,
      task_id TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      model TEXT,
      tracked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function insertTask(db, { id, provider, workflow_id = null, tags = [] }) {
  db.prepare(`
    INSERT INTO tasks (id, provider, workflow_id, tags)
    VALUES (?, ?, ?, ?)
  `).run(id, provider, workflow_id, JSON.stringify(tags));
}

function insertTokenUsage(db, taskId, estimatedCostUsd) {
  db.prepare(`
    INSERT INTO token_usage (
      task_id, input_tokens, output_tokens, total_tokens,
      estimated_cost_usd, model, recorded_at, project
    )
    VALUES (?, 0, 0, 0, ?, 'codex', datetime('now'), NULL)
  `).run(taskId, estimatedCostUsd);
}

function recordFeedback(projectId, batchId, healthDelta, createdAt) {
  const record = factoryFeedback.recordFeedback({
    project_id: projectId,
    batch_id: batchId,
    health_delta: healthDelta,
    execution_metrics: {
      task_count: 1,
      retry_count: 0,
      duration_seconds: 30,
      estimated_cost: 0,
      remediation_rate: 0,
      cost_per_health_point: 0,
    },
    guardrail_activity: {
      total: 0,
      pass_count: 0,
      warn_count: 0,
      fail_count: 0,
    },
  });

  if (createdAt) {
    db.prepare('UPDATE factory_feedback SET created_at = ? WHERE id = ?').run(createdAt, record.id);
  }
}

describe('factory cost metrics', () => {
  let db;
  let project;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    factoryHealth.setDb(db);
    factoryFeedback.setDb(db);
    costTracking.setDb(db);
    database.getDbInstance = () => db;

    project = factoryHealth.registerProject({
      name: 'Factory Cost Test',
      path: '/tmp/factory-cost-test',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('calculates project cost metrics from factory batches', async () => {
    recordFeedback(project.id, 'batch-alpha', {
      security: { before: 50, after: 52, delta: 2 },
      structural: { before: 60, after: 61, delta: 1 },
    }, '2026-01-01T00:00:01.000Z');
    recordFeedback(project.id, 'batch-beta', {
      documentation: { before: 70, after: 71, delta: 1 },
    }, '2026-01-01T00:00:02.000Z');

    insertTask(db, { id: 'task-alpha', provider: 'codex', workflow_id: 'batch-alpha' });
    insertTask(db, { id: 'task-beta', provider: 'codex', tags: ['batch-beta'] });
    insertTask(db, { id: 'task-gamma', provider: 'ollama', tags: ['batch:batch-beta'] });
    insertTask(db, { id: 'task-other', provider: 'claude-cli', workflow_id: 'other-batch' });

    insertTokenUsage(db, 'task-alpha', 6);
    insertTokenUsage(db, 'task-beta', 3);
    insertTokenUsage(db, 'task-gamma', 1);
    insertTokenUsage(db, 'task-other', 99);

    expect(getCostPerCycle(project.id)).toBe(5);
    expect(getCostPerHealthPoint(project.id)).toBe(2.5);
    expect(getProviderEfficiency(project.id)).toEqual([
      {
        provider: 'codex',
        total_cost: 9,
        task_count: 2,
        cost_per_task: 4.5,
      },
      {
        provider: 'ollama',
        total_cost: 1,
        task_count: 1,
        cost_per_task: 1,
      },
    ]);

    const result = await handlers.handleFactoryCostMetrics({ project: project.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.project).toEqual({
      id: project.id,
      name: 'Factory Cost Test',
      path: '/tmp/factory-cost-test',
    });
    expect(data.cost_per_cycle).toBe(5);
    expect(data.cost_per_health_point).toBe(2.5);
    expect(data.provider_efficiency).toHaveLength(2);
  });

  it('returns zero or empty metrics when no cost data exists', () => {
    recordFeedback(project.id, 'batch-empty', {
      security: { before: 50, after: 52, delta: 2 },
    }, '2026-01-01T00:00:01.000Z');

    expect(getCostPerCycle(project.id)).toBe(0);
    expect(getCostPerHealthPoint(project.id)).toBe(0);
    expect(getProviderEfficiency(project.id)).toEqual([]);
  });
});
