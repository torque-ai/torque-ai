import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');

let db;
let projectId;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS provider_config (provider TEXT PRIMARY KEY, config_json TEXT);
    CREATE TABLE IF NOT EXISTS ollama_hosts (id TEXT PRIMARY KEY, name TEXT, url TEXT, enabled INTEGER DEFAULT 1, last_model_used TEXT, model_loaded_at TEXT, default_model TEXT);
    CREATE TABLE IF NOT EXISTS distributed_locks (id TEXT PRIMARY KEY, owner TEXT, expires_at TEXT, last_heartbeat TEXT);
    CREATE TABLE IF NOT EXISTS provider_task_stats (id INTEGER PRIMARY KEY, provider TEXT, task_type TEXT, total_tasks INTEGER);
    CREATE TABLE IF NOT EXISTS model_family_templates (family TEXT PRIMARY KEY, tuning_json TEXT);
    CREATE TABLE IF NOT EXISTS model_registry (model_name TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE IF NOT EXISTS routing_templates (id TEXT PRIMARY KEY, rules TEXT);
  `);
  runMigrations(db);
  factoryDecisions.setDb(db);
  factoryHealth.setDb(db);

  const project = factoryHealth.registerProject({
    name: 'factory-learn-stage',
    path: '/tmp/factory-learn-stage',
  });
  projectId = project.id;
});

afterEach(() => {
  factoryDecisions.setDb(null);
  factoryHealth.setDb(null);
  db.close();
  db = null;
});

describe('factory-decisions learn stage support', () => {
  it('recordDecision accepts the learn stage', () => {
    const record = factoryDecisions.recordDecision({
      project_id: projectId,
      stage: 'learn',
      actor: 'verifier',
      action: 'learned',
      reasoning: 'LEARN stage captured post-batch analysis.',
      inputs: {
        batch_id: 'batch-learn-1',
        signals: ['health_delta', 'guardrail_activity'],
      },
      outcome: {
        feedback_id: 42,
        summary: 'Total improvement +1.00; weakest delta none',
      },
      confidence: 1,
      batch_id: 'batch-learn-1',
    });

    expect(record).toEqual(
      expect.objectContaining({
        project_id: projectId,
        stage: 'learn',
        actor: 'verifier',
        action: 'learned',
        batch_id: 'batch-learn-1',
      })
    );
  });

  it('getDecisionStats counts learn-stage decisions', () => {
    factoryDecisions.recordDecision({
      project_id: projectId,
      stage: 'learn',
      actor: 'verifier',
      action: 'learned',
      reasoning: 'LEARN stage captured post-batch analysis.',
      inputs: {
        batch_id: 'batch-learn-2',
        signals: ['execution_metrics'],
      },
      outcome: {
        feedback_id: 43,
        summary: 'Total improvement +0.25; weakest delta structural -0.10',
      },
      confidence: 0.9,
      batch_id: 'batch-learn-2',
    });

    const stats = factoryDecisions.getDecisionStats(projectId);

    expect(stats.total).toBe(1);
    expect(stats.by_stage.learn).toBe(1);
    expect(stats.by_stage.verify).toBe(0);
  });
});
