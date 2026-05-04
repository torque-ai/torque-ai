import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const factoryFeedback = require('../db/factory/feedback');
const factoryHealth = require('../db/factory/health');
const guardrailDb = require('../db/factory/guardrails');
const feedbackAnalysis = require('../factory/feedback');
const { analyzeBatch, detectDrift, recordHumanCorrection } = feedbackAnalysis;

let db;
let projectId;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_config (provider TEXT PRIMARY KEY, config_json TEXT);
    CREATE TABLE IF NOT EXISTS ollama_hosts (id TEXT PRIMARY KEY, name TEXT, url TEXT, enabled INTEGER DEFAULT 1, last_model_used TEXT, model_loaded_at TEXT, default_model TEXT);
    CREATE TABLE IF NOT EXISTS distributed_locks (id TEXT PRIMARY KEY, owner TEXT, expires_at TEXT, last_heartbeat TEXT);
    CREATE TABLE IF NOT EXISTS provider_task_stats (id INTEGER PRIMARY KEY, provider TEXT, task_type TEXT, total_tasks INTEGER);
    CREATE TABLE IF NOT EXISTS model_family_templates (family TEXT PRIMARY KEY, tuning_json TEXT);
    CREATE TABLE IF NOT EXISTS model_registry (model_name TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE IF NOT EXISTS routing_templates (id TEXT PRIMARY KEY, rules TEXT);
  `);
  runMigrations(db);
  factoryFeedback.setDb(db);
  factoryHealth.setDb(db);
  guardrailDb.setDb(db);
  require('../database').getDbInstance = () => db;
  feedbackAnalysis.init?.({ db: require('../database') });
});

beforeEach(() => {
  db.exec('DELETE FROM factory_feedback');
  db.exec('DELETE FROM factory_guardrail_events');
  db.exec('DELETE FROM factory_health_snapshots');
  db.exec('DELETE FROM factory_health_findings');
  db.exec('DELETE FROM factory_projects');
  const project = factoryHealth.registerProject({ name: 'test-project', path: '/tmp/test-feedback' });
  projectId = project.id;
});

function timestampFor(index) {
  return `2026-01-01 00:00:${String(index).padStart(2, '0')}`;
}

function recordSnapshotAt({ dimension, score, scanned_at, batch_id }) {
  const snapshot = factoryHealth.recordSnapshot({
    project_id: projectId,
    dimension,
    score,
    batch_id,
  });

  if (scanned_at) {
    db.prepare('UPDATE factory_health_snapshots SET scanned_at = ? WHERE id = ?').run(scanned_at, snapshot.id);
  }

  return snapshot;
}

function createExecutionMetrics(overrides = {}) {
  return {
    task_count: 3,
    retry_count: 0,
    duration_seconds: 60,
    estimated_cost: 5,
    remediation_rate: 0,
    cost_per_health_point: 2,
    ...overrides,
  };
}

function createHealthDelta(dimension, delta, before = 0.5) {
  return {
    [dimension]: {
      before,
      after: before + delta,
      delta,
    },
  };
}

function recordFeedbackAt({
  batch_id,
  health_delta = createHealthDelta('structural', 0.2),
  execution_metrics = createExecutionMetrics(),
  guardrail_activity = { total: 0, pass_count: 0, warn_count: 0, fail_count: 0 },
  human_corrections = null,
  created_at,
} = {}) {
  const record = factoryFeedback.recordFeedback({
    project_id: projectId,
    batch_id,
    health_delta,
    execution_metrics,
    guardrail_activity,
    human_corrections,
  });

  if (created_at) {
    db.prepare('UPDATE factory_feedback SET created_at = ? WHERE id = ?').run(created_at, record.id);
    return factoryFeedback.getFeedback(record.id);
  }

  return record;
}

describe('factory-feedback DB module', () => {
  it('records and retrieves feedback', () => {
    const health_delta = {
      structural: { before: 0.4, after: 0.7, delta: 0.3 },
      security: { before: 0.5, after: 0.6, delta: 0.1 },
    };
    const execution_metrics = {
      task_count: 4,
      retry_count: 1,
      duration_seconds: 120,
      estimated_cost: 8,
      remediation_rate: 0.25,
      cost_per_health_point: 20,
    };
    const guardrail_activity = { total: 2, pass_count: 1, warn_count: 1, fail_count: 0 };

    const record = factoryFeedback.recordFeedback({
      project_id: projectId,
      batch_id: 'batch-1',
      health_delta,
      execution_metrics,
      guardrail_activity,
      human_corrections: [{ type: 'priority_override', description: 'Raised security priority' }],
    });

    expect(record.health_delta).toEqual(health_delta);
    expect(record.execution_metrics).toEqual(execution_metrics);
    expect(record.guardrail_activity).toEqual(guardrail_activity);
    expect(record.human_corrections).toEqual([
      expect.objectContaining({ type: 'priority_override', description: 'Raised security priority' }),
    ]);

    const fetched = factoryFeedback.getFeedback(record.id);
    expect(fetched.health_delta).toEqual(health_delta);
    expect(fetched.execution_metrics).toEqual(execution_metrics);
  });

  it('lists project feedback with pagination', () => {
    recordFeedbackAt({ batch_id: 'batch-1', created_at: timestampFor(1) });
    recordFeedbackAt({ batch_id: 'batch-2', created_at: timestampFor(2) });
    recordFeedbackAt({ batch_id: 'batch-3', created_at: timestampFor(3) });

    const all = factoryFeedback.getProjectFeedback(projectId);
    const paged = factoryFeedback.getProjectFeedback(projectId, { limit: 2, offset: 1 });

    expect(all.map((entry) => entry.batch_id)).toEqual(['batch-3', 'batch-2', 'batch-1']);
    expect(paged.map((entry) => entry.batch_id)).toEqual(['batch-2', 'batch-1']);
  });

  it('gets batch-specific feedback', () => {
    recordFeedbackAt({ batch_id: 'batch-alpha', created_at: timestampFor(1) });
    recordFeedbackAt({ batch_id: 'batch-beta', created_at: timestampFor(2) });

    const records = factoryFeedback.getBatchFeedback('batch-beta');

    expect(records).toHaveLength(1);
    expect(records[0].batch_id).toBe('batch-beta');
  });

  it('gets patterns for drift analysis', () => {
    for (let index = 1; index <= 5; index += 1) {
      recordFeedbackAt({
        batch_id: `batch-${index}`,
        created_at: timestampFor(index),
        health_delta: createHealthDelta('structural', index / 10),
      });
    }

    const patterns = factoryFeedback.getPatterns(projectId, { limit: 5 });

    expect(patterns).toHaveLength(5);
    expect(patterns.map((entry) => entry.batch_id)).toEqual([
      'batch-5',
      'batch-4',
      'batch-3',
      'batch-2',
      'batch-1',
    ]);
    expect(patterns[0].health_delta).toEqual(createHealthDelta('structural', 0.5));
  });

  it('deletes project feedback', () => {
    recordFeedbackAt({ batch_id: 'batch-1', created_at: timestampFor(1) });
    recordFeedbackAt({ batch_id: 'batch-2', created_at: timestampFor(2) });

    const deleted = factoryFeedback.deleteFeedback(projectId);

    expect(deleted).toBe(2);
    expect(factoryFeedback.getProjectFeedback(projectId)).toEqual([]);
  });
});

describe('analyzeBatch', () => {
  it('calculates health deltas from score history', () => {
    const dimensions = [...factoryHealth.VALID_DIMENSIONS];

    dimensions.forEach((dimension, index) => {
      const before = 0.1 + index * 0.01;
      const after = before + 0.2;

      recordSnapshotAt({ dimension, score: before, scanned_at: '2026-01-01 00:00:00', batch_id: 'before' });
      recordSnapshotAt({ dimension, score: after, scanned_at: '2026-01-01 00:01:00', batch_id: 'after' });
    });

    const analysis = analyzeBatch(projectId, 'batch-health', {
      task_count: 4,
      retry_count: 1,
      duration_seconds: 120,
      estimated_cost: 6,
    });

    dimensions.forEach((dimension, index) => {
      const before = 0.1 + index * 0.01;
      const after = before + 0.2;

      expect(analysis.health_delta[dimension].before).toBeCloseTo(before);
      expect(analysis.health_delta[dimension].after).toBeCloseTo(after);
      expect(analysis.health_delta[dimension].delta).toBeCloseTo(0.2);
    });
  });

  it('calculates execution metrics', () => {
    recordSnapshotAt({ dimension: 'structural', score: 0.2, scanned_at: '2026-01-01 00:00:00' });
    recordSnapshotAt({ dimension: 'structural', score: 0.8, scanned_at: '2026-01-01 00:01:00' });
    recordSnapshotAt({ dimension: 'security', score: 0.3, scanned_at: '2026-01-01 00:00:00' });
    recordSnapshotAt({ dimension: 'security', score: 0.7, scanned_at: '2026-01-01 00:01:00' });

    const analysis = analyzeBatch(projectId, 'batch-metrics', {
      task_count: 4,
      retry_count: 1,
      duration_seconds: 90,
      estimated_cost: 10,
    });

    expect(analysis.execution_metrics).toEqual(
      expect.objectContaining({
        task_count: 4,
        retry_count: 1,
        duration_seconds: 90,
        estimated_cost: 10,
      })
    );
    expect(analysis.execution_metrics.remediation_rate).toBeCloseTo(0.25);
    expect(analysis.execution_metrics.cost_per_health_point).toBeCloseTo(10);
  });

  it('includes guardrail activity', () => {
    recordSnapshotAt({ dimension: 'structural', score: 0.3, scanned_at: '2026-01-01 00:00:00' });
    recordSnapshotAt({ dimension: 'structural', score: 0.6, scanned_at: '2026-01-01 00:01:00' });

    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'scope',
      check_name: 'scope-budget',
      status: 'pass',
      batch_id: 'batch-guard',
      details: { tasks: 3 },
    });
    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'quality',
      check_name: 'test-regression',
      status: 'warn',
      batch_id: 'batch-guard',
      details: { failures: 1 },
    });
    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'security',
      check_name: 'secret-fence',
      status: 'fail',
      batch_id: 'batch-guard',
      details: { matched_files: ['.env'] },
    });
    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'conflict',
      check_name: 'file-locks',
      status: 'fail',
      batch_id: 'other-batch',
      details: { conflicts: ['src/app.js'] },
    });

    const analysis = analyzeBatch(projectId, 'batch-guard', {
      task_count: 3,
      retry_count: 0,
      duration_seconds: 45,
      estimated_cost: 3,
    });

    expect(analysis.guardrail_activity).toEqual({
      total: 3,
      pass_count: 1,
      warn_count: 1,
      fail_count: 1,
    });
  });

  it('stores feedback record', () => {
    recordSnapshotAt({ dimension: 'structural', score: 0.1, scanned_at: '2026-01-01 00:00:00' });
    recordSnapshotAt({ dimension: 'structural', score: 0.4, scanned_at: '2026-01-01 00:01:00' });

    const analysis = analyzeBatch(projectId, 'batch-store', {
      task_count: 2,
      retry_count: 0,
      duration_seconds: 30,
      estimated_cost: 2,
    });
    const stored = factoryFeedback.getFeedback(analysis.feedback_id);

    expect(stored.batch_id).toBe('batch-store');
    expect(stored.health_delta).toEqual(analysis.health_delta);
    expect(stored.execution_metrics).toEqual(analysis.execution_metrics);
    expect(stored.guardrail_activity).toEqual(analysis.guardrail_activity);
  });
});

describe('detectDrift', () => {
  it('returns insufficient history for < 3 records', () => {
    recordFeedbackAt({ batch_id: 'batch-1', created_at: timestampFor(1) });
    recordFeedbackAt({ batch_id: 'batch-2', created_at: timestampFor(2) });

    const result = detectDrift(projectId);

    expect(result).toEqual({
      drift_detected: false,
      patterns: [],
      message: 'Insufficient history (need 3+ batches)',
    });
  });

  it('detects priority oscillation', () => {
    const deltas = [0.3, -0.2, 0.4, -0.1, 0.5];

    deltas.forEach((delta, index) => {
      recordFeedbackAt({
        batch_id: `batch-${index + 1}`,
        created_at: timestampFor(index + 1),
        health_delta: createHealthDelta('structural', delta),
        execution_metrics: createExecutionMetrics({ task_count: 4, cost_per_health_point: 2 }),
      });
    });

    const result = detectDrift(projectId);
    const pattern = result.patterns.find((entry) => entry.type === 'priority_oscillation');

    expect(result.drift_detected).toBe(true);
    expect(pattern).toEqual(
      expect.objectContaining({
        type: 'priority_oscillation',
        severity: 'warning',
        dimensions: ['structural'],
      })
    );
  });

  it('detects diminishing returns', () => {
    [1.0, 0.8, 0.5, 0.2].forEach((delta, index) => {
      recordFeedbackAt({
        batch_id: `batch-${index + 1}`,
        created_at: timestampFor(index + 1),
        health_delta: createHealthDelta('security', delta),
        execution_metrics: createExecutionMetrics({ task_count: 4, cost_per_health_point: 2 }),
      });
    });

    const result = detectDrift(projectId);
    const pattern = result.patterns.find((entry) => entry.type === 'diminishing_returns');

    expect(result.drift_detected).toBe(true);
    expect(pattern).toEqual(
      expect.objectContaining({
        type: 'diminishing_returns',
        severity: 'info',
        dimensions: ['security'],
      })
    );
  });

  it('detects scope creep', () => {
    [2, 4, 6, 8].forEach((task_count, index) => {
      recordFeedbackAt({
        batch_id: `batch-${index + 1}`,
        created_at: timestampFor(index + 1),
        health_delta: createHealthDelta('documentation', 0.4),
        execution_metrics: createExecutionMetrics({ task_count, cost_per_health_point: 2 }),
      });
    });

    const result = detectDrift(projectId);

    expect(result.drift_detected).toBe(true);
    expect(result.patterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'scope_creep', severity: 'warning' }),
      ])
    );
  });

  it('detects cost creep', () => {
    [1, 2, 3, 4].forEach((cost_per_health_point, index) => {
      recordFeedbackAt({
        batch_id: `batch-${index + 1}`,
        created_at: timestampFor(index + 1),
        health_delta: createHealthDelta('build_ci', 0.4),
        execution_metrics: createExecutionMetrics({ task_count: 4, cost_per_health_point }),
      });
    });

    const result = detectDrift(projectId);

    expect(result.drift_detected).toBe(true);
    expect(result.patterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'cost_creep', severity: 'critical' }),
      ])
    );
  });

  it('returns no drift when patterns are healthy', () => {
    for (let index = 1; index <= 5; index += 1) {
      recordFeedbackAt({
        batch_id: `batch-${index}`,
        created_at: timestampFor(index),
        health_delta: createHealthDelta('performance', 0.4),
        execution_metrics: createExecutionMetrics({ task_count: 4, cost_per_health_point: 2 }),
      });
    }

    const result = detectDrift(projectId);

    expect(result).toEqual({
      drift_detected: false,
      patterns: [],
      message: 'No systemic drift detected in recent feedback history',
    });
  });
});

describe('recordHumanCorrection', () => {
  it('appends correction to existing feedback', () => {
    const existing = recordFeedbackAt({
      batch_id: 'batch-1',
      created_at: timestampFor(1),
      human_corrections: [{ type: 'scope_change', description: 'Initial correction' }],
    });

    const result = recordHumanCorrection(projectId, {
      type: 'priority_override',
      description: 'Raised security priority',
    });
    const updated = factoryFeedback.getFeedback(existing.id);

    expect(result.recorded).toBe(true);
    expect(result.feedback_id).toBe(existing.id);
    expect(updated.human_corrections).toHaveLength(2);
    expect(updated.human_corrections[0]).toEqual(
      expect.objectContaining({ type: 'scope_change', description: 'Initial correction' })
    );
    expect(updated.human_corrections[1]).toEqual(
      expect.objectContaining({ type: 'priority_override', description: 'Raised security priority' })
    );
  });

  it('creates new feedback when none exists', () => {
    const result = recordHumanCorrection(projectId, {
      type: 'trust_adjustment',
      description: 'Moved project to guided mode',
    });
    const stored = factoryFeedback.getFeedback(result.feedback_id);

    expect(result.recorded).toBe(true);
    expect(stored.project_id).toBe(projectId);
    expect(stored.human_corrections).toHaveLength(1);
    expect(stored.human_corrections[0]).toEqual(
      expect.objectContaining({ type: 'trust_adjustment', description: 'Moved project to guided mode' })
    );
  });

  it('validates correction type', () => {
    expect(() =>
      recordHumanCorrection(projectId, {
        type: 'invalid-type',
        description: 'Should fail',
      })
    ).toThrow(/correction\.type must be one of/);
  });
});
