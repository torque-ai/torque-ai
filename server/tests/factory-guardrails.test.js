import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const guardrailDb = require('../db/factory/guardrails');
const guardrails = require('../factory/guardrails');
const {
  runPreBatchChecks,
  runPostBatchChecks,
  runPreShipChecks,
  getGuardrailSummary,
} = require('../factory/guardrail-runner');
const factoryHealth = require('../db/factory/health');

let db;
let projectId;

function createTasks(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index + 1}`,
    task_description: `Task ${index + 1}`,
  }));
}

function createFiles(count) {
  return Array.from({ length: count }, (_, index) => `src/file-${index + 1}.js`);
}

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
  guardrailDb.setDb(db);
  factoryHealth.setDb(db);
});

beforeEach(() => {
  db.exec('DELETE FROM factory_guardrail_events');
  db.exec('DELETE FROM factory_projects');
  const project = factoryHealth.registerProject({ name: 'test-project', path: '/tmp/test' });
  projectId = project.id;
});

describe('guardrail check functions', () => {
  it('checkScopeBudget passes within budget', () => {
    const result = guardrails.checkScopeBudget({ tasks: createTasks(3), scope_budget: 5 });

    expect(result).toEqual({
      status: 'pass',
      details: { tasks: 3, budget: 5 },
    });
  });

  it('checkScopeBudget fails over budget', () => {
    const result = guardrails.checkScopeBudget({ tasks: createTasks(6), scope_budget: 5 });

    expect(result).toEqual({
      status: 'fail',
      details: { tasks: 6, budget: 5 },
    });
  });

  it('checkBlastRadius warns on >10 files', () => {
    const result = guardrails.checkBlastRadius(createFiles(15));

    expect(result).toEqual({
      status: 'warn',
      details: { file_count: 15 },
    });
  });

  it('checkBlastRadius fails on >20 files', () => {
    const result = guardrails.checkBlastRadius(createFiles(25));

    expect(result).toEqual({
      status: 'fail',
      details: { file_count: 25 },
    });
  });

  it('checkSecretFence fails on .env files', () => {
    const result = guardrails.checkSecretFence(['src/app.js', '.env']);

    expect(result.status).toBe('fail');
    expect(result.details.matched_files).toEqual([
      { path: '.env', patterns: ['.env'] },
    ]);
  });

  it('checkSecretFence passes on safe files', () => {
    const result = guardrails.checkSecretFence(['src/app.js', 'src/utils.js']);

    expect(result).toEqual({
      status: 'pass',
      details: { matched_files: [] },
    });
  });

  it('checkTestRegression fails on test failures', () => {
    const result = guardrails.checkTestRegression({ passed: 10, failed: 2, skipped: 0 });

    expect(result).toEqual({
      status: 'fail',
      details: { passed: 10, failed: 2, skipped: 0 },
    });
  });

  it('checkRateLimit fails when at max', () => {
    const recentBatches = Array.from({ length: 10 }, () => ({
      created_at: new Date().toISOString(),
    }));

    const result = guardrails.checkRateLimit(recentBatches, 10);

    expect(result).toEqual({
      status: 'fail',
      details: { batch_count_last_hour: 10, max_per_hour: 10 },
    });
  });

  it('checkWorkaroundPatterns warns on TODO', () => {
    const result = guardrails.checkWorkaroundPatterns([
      { path: 'src/app.js', content: '// TODO: remove this workaround' },
    ]);

    expect(result.status).toBe('warn');
    expect(result.details.matches).toEqual([
      { path: 'src/app.js', patterns: ['TODO'] },
    ]);
  });

  it('checkFileLocks fails on conflicts', () => {
    const result = guardrails.checkFileLocks([
      { batch_id: 'batch-a', files: ['src/shared.js'] },
      { batch_id: 'batch-b', files: ['src/shared.js', 'src/other.js'] },
    ]);

    expect(result).toEqual({
      status: 'fail',
      details: {
        conflicts: [
          { file: 'src/shared.js', batches: ['batch-a', 'batch-b'] },
        ],
      },
    });
  });

  it('checkHealthDelta fails on score drop', () => {
    const result = guardrails.checkHealthDelta(
      { test_coverage: 0.8 },
      { test_coverage: 0.5 },
    );

    expect(result.status).toBe('fail');
    expect(result.details.deltas.test_coverage).toBeCloseTo(-0.3);
  });

  it('checkProportionality warns when no test files changed', () => {
    const result = guardrails.checkProportionality(
      ['src/app.js', 'src/utils.js'],
      [],
    );

    expect(result).toEqual({
      status: 'warn',
      details: {
        code_file_count: 2,
        test_file_count: 0,
        total_files: 2,
      },
    });
  });
});

describe('guardrail DB module', () => {
  it('records and retrieves events', () => {
    const event = guardrailDb.recordEvent({
      project_id: projectId,
      category: 'scope',
      check_name: 'checkScopeBudget',
      status: 'pass',
      details: { tasks: 3, budget: 5 },
      batch_id: 'batch-1',
    });

    const events = guardrailDb.getEvents(projectId);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: event.id,
      project_id: projectId,
      category: 'scope',
      check_name: 'checkScopeBudget',
      status: 'pass',
      batch_id: 'batch-1',
      details: { tasks: 3, budget: 5 },
    });
  });

  it('getLatestByCategory returns most recent per category', () => {
    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'scope',
      check_name: 'checkScopeBudget',
      status: 'pass',
      details: { tasks: 3 },
    });
    const latestEvent = guardrailDb.recordEvent({
      project_id: projectId,
      category: 'scope',
      check_name: 'checkScopeBudget',
      status: 'fail',
      details: { tasks: 6 },
    });

    const latestEvents = guardrailDb.getLatestByCategory(projectId);

    expect(latestEvents).toHaveLength(1);
    expect(latestEvents[0]).toMatchObject({
      id: latestEvent.id,
      category: 'scope',
      status: 'fail',
      details: { tasks: 6 },
    });
  });

  it('getGuardrailStatus returns traffic light map', () => {
    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'scope',
      check_name: 'checkScopeBudget',
      status: 'pass',
      details: {},
    });
    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'security',
      check_name: 'checkSecretFence',
      status: 'fail',
      details: {},
    });

    const statusMap = guardrailDb.getGuardrailStatus(projectId);

    expect(statusMap).toMatchObject({
      scope: 'green',
      security: 'red',
      quality: 'green',
    });
  });

  it('filters events by category', () => {
    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'scope',
      check_name: 'checkScopeBudget',
      status: 'pass',
      details: {},
    });
    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'security',
      check_name: 'checkSecretFence',
      status: 'fail',
      details: {},
    });

    const events = guardrailDb.getEvents(projectId, { category: 'security' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'security',
      check_name: 'checkSecretFence',
      status: 'fail',
    });
  });

  it('filters events by status', () => {
    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'scope',
      check_name: 'checkScopeBudget',
      status: 'pass',
      details: {},
    });
    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'security',
      check_name: 'checkSecretFence',
      status: 'fail',
      details: {},
    });

    const events = guardrailDb.getEvents(projectId, { status: 'fail' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'security',
      status: 'fail',
    });
  });
});

describe('guardrail runner', () => {
  it('runPreBatchChecks records events and returns summary', () => {
    const result = runPreBatchChecks(projectId, {
      tasks: createTasks(3),
      scope_budget: 5,
    });

    const events = guardrailDb.getEvents(projectId);

    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.map((entry) => entry.check_name)).toEqual([
      'checkScopeBudget',
      'checkDecompositionDepth',
      'checkRateLimit',
    ]);
    expect(events).toHaveLength(3);
  });

  it('runPostBatchChecks detects secret fence violations', () => {
    const result = runPostBatchChecks(
      projectId,
      'batch-1',
      ['src/app.js', '.env'],
      { test_files_changed: ['src/app.test.js'] },
    );

    const secretFence = result.results.find((entry) => entry.check_name === 'checkSecretFence');

    expect(result.passed).toBe(false);
    expect(secretFence).toMatchObject({
      status: 'fail',
      details: {
        matched_files: [{ path: '.env', patterns: ['.env'] }],
      },
    });
  });

  it('runPreShipChecks passes with clean test results', () => {
    const result = runPreShipChecks(projectId, 'batch-1', {
      test_results: { passed: 10, failed: 0, skipped: 0 },
    });

    expect(result).toMatchObject({
      passed: true,
      batch_id: 'batch-1',
      results: [
        {
          check_name: 'checkTestRegression',
          status: 'pass',
          details: { passed: 10, failed: 0, skipped: 0 },
        },
      ],
    });
  });

  it('getGuardrailSummary returns status map and latest events', () => {
    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'scope',
      check_name: 'checkScopeBudget',
      status: 'warn',
      details: { tasks: 4, budget: 5 },
    });
    guardrailDb.recordEvent({
      project_id: projectId,
      category: 'security',
      check_name: 'checkSecretFence',
      status: 'fail',
      details: { matched_files: [{ path: '.env', patterns: ['.env'] }] },
    });

    const summary = getGuardrailSummary(projectId);

    expect(summary.status_map).toMatchObject({
      scope: 'yellow',
      security: 'red',
      quality: 'green',
    });
    expect(summary.latest_events).toHaveLength(2);
    expect(summary.latest_events).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'scope', status: 'warn' }),
      expect.objectContaining({ category: 'security', status: 'fail' }),
    ]));
  });
});
