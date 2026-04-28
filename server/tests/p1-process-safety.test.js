/**
 * Regression tests for process safety and correctness fixes:
 * - TOCTOU-safe stale PID kill
 * - routing file-size traversal guard
 * - idempotent analytics rollups
 * - regex ReDoS protection in validation/rule matching
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { randomUUID } = require('crypto');

const taskManager = require('../task-manager');
const providerRoutingCore = require('../db/provider-routing-core');
const { setupTestDbOnly, teardownTestDb, getText } = require('./vitest-setup');

// Use real modules for index and routing tests, with temporary DB roots per test.

describe('index.killStaleInstance process safety', () => {
  let index;
  let tempDir;
  let originalDataDir;

  function loadIndexForTempDir() {
    return require('../index');
  }

  function clearSystemBarriers() {
    try {
      const pidFile = index && index._testing && index._testing.PID_FILE;
      if (!pidFile) return;
      const Database = require('better-sqlite3');
      const sql = new Database(path.join(path.dirname(pidFile), 'tasks.db'));
      sql.prepare("DELETE FROM tasks WHERE provider = 'system'").run();
      sql.close();
    } catch { /* test database may not be initialized yet */ }
    try {
      const pidFile = index && index._testing && index._testing.PID_FILE;
      if (!pidFile) return;
      const handoffPath = path.join(path.dirname(pidFile), 'restart-handoff.json');
      if (fs.existsSync(handoffPath)) fs.unlinkSync(handoffPath);
    } catch { /* cleanup best-effort */ }
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-p1-index-'));
    originalDataDir = process.env.TORQUE_DATA_DIR;
    process.env.TORQUE_DATA_DIR = tempDir;
    index = loadIndexForTempDir();
    // The "blocks competing startup" test below writes a barrier row to
    // tasks.db at PID_FILE's dirname. PID_FILE is bound at module load
    // time (cached via getDataDir), so depending on which tests ran first
    // in this worker that path may or may not have a tasks.db with schema.
    // In true isolation the path is a fresh temp dir with no schema, and
    // the test's `DELETE FROM tasks` raises "no such table: tasks". Copy
    // the global-setup template buffer (which has the full schema applied
    // including the provider column the test relies on) into place if
    // tasks.db is missing or empty.
    try {
      const pidFile = index && index._testing && index._testing.PID_FILE;
      if (pidFile) {
        const tasksDb = path.join(path.dirname(pidFile), 'tasks.db');
        const needsSeed = !fs.existsSync(tasksDb) || fs.statSync(tasksDb).size === 0;
        if (needsSeed) {
          const templateBuf = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
          if (fs.existsSync(templateBuf)) {
            fs.copyFileSync(templateBuf, tasksDb);
          }
        }
      }
    } catch { /* best-effort; the affected test will surface a clearer error */ }
    clearSystemBarriers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      const pidFile = index && index._testing && index._testing.PID_FILE;
      if (pidFile && fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
    } catch { /* ignore */ }
    clearSystemBarriers();
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (originalDataDir !== undefined) {
      process.env.TORQUE_DATA_DIR = originalDataDir;
    } else {
      delete process.env.TORQUE_DATA_DIR;
    }
  });

  it('skips termination when a stale PID now maps to a different (non-TORQUE) process', () => {
    const oldPid = 98765;
    const pidPath = index._testing.PID_FILE;
    fs.writeFileSync(pidPath, JSON.stringify({
      pid: oldPid,
      startedAt: new Date(Date.now() - 120000).toISOString(),
      heartbeatAt: new Date(Date.now() - 40000).toISOString(),
    }), 'utf8');

    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(childProcess, 'execSync').mockReturnValue('python -m simple_server');
    vi.spyOn(childProcess, 'execFileSync').mockReturnValue('python -m simple_server');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    index.killStaleInstance();

    expect(processKillSpy).toHaveBeenCalledWith(oldPid, 0);
    expect(processKillSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(pidPath)).toBe(true);
  });

  it('terminates stale PID when command line still matches TORQUE process signature', () => {
    const oldPid = 98766;
    const pidPath = index._testing.PID_FILE;
    fs.writeFileSync(pidPath, JSON.stringify({
      pid: oldPid,
      startedAt: new Date(Date.now() - 120000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60000).toISOString(),
    }), 'utf8');

    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(childProcess, 'execSync').mockReturnValue(`node ${path.join(tempDir, 'torque.js')} --worker`);
    vi.spyOn(childProcess, 'execFileSync').mockReturnValue(`node ${path.join(tempDir, 'torque.js')} --worker`);

    index.killStaleInstance();

    expect(processKillSpy).toHaveBeenCalledWith(oldPid, 0);
    if (process.platform === 'win32') {
      expect(processKillSpy).not.toHaveBeenCalledWith(oldPid, 'SIGTERM');
    } else {
      expect(processKillSpy).toHaveBeenCalledWith(oldPid, 'SIGTERM');
      expect(processKillSpy).toHaveBeenCalledTimes(2);
    }
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('blocks competing startup instead of killing a stale PID during an undrained restart barrier', () => {
    const oldPid = 98767;
    const pidPath = index._testing.PID_FILE;
    fs.writeFileSync(pidPath, JSON.stringify({
      pid: oldPid,
      startedAt: new Date(Date.now() - 120000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60000).toISOString(),
    }), 'utf8');

    const Database = require('better-sqlite3');
    const sql = new Database(path.join(path.dirname(pidPath), 'tasks.db'));
    sql.prepare("DELETE FROM tasks WHERE provider = 'system'").run();
    sql.prepare(`
      INSERT INTO tasks (id, status, task_description, provider, created_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'barrier-active',
      'running',
      'Restart barrier: test',
      'system',
      new Date().toISOString(),
      new Date().toISOString()
    );
    sql.close();

    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const execFileSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((cmd) => {
      if (cmd === 'wmic') return `node ${path.join(tempDir, 'torque.js')} --worker`;
      if (cmd === 'taskkill') throw new Error('taskkill should not be called');
      return '';
    });
    vi.spyOn(childProcess, 'execSync').mockReturnValue(`node ${path.join(tempDir, 'torque.js')} --worker`);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = index.killStaleInstance();

    expect(result).toMatchObject({
      action: 'blocked',
      reason: 'undrained_restart_barrier_without_handoff',
      blockStartup: true,
      pid: oldPid,
      barrier_id: 'barrier-active',
    });
    expect(processKillSpy).toHaveBeenCalledWith(oldPid, 0);
    expect(processKillSpy).toHaveBeenCalledTimes(1);
    expect(execFileSpy.mock.calls.filter(([cmd]) => cmd === 'taskkill')).toHaveLength(0);
    expect(fs.existsSync(pidPath)).toBe(true);
  });
});

describe('integration-routing file-size probing guards traversal', () => {
  let db;
  let routing;

  beforeAll(() => {
    const env = setupTestDbOnly('p1-routing');
    db = env.db;
    routing = require('../handlers/integration/routing');
    providerRoutingCore.checkOllamaHealth = async () => true;
  });

  afterAll(() => { teardownTestDb(); });

  beforeEach(() => {
    const tables = ['tasks', 'success_metrics', 'validation_rules', 'retry_rules', 'pending_approvals', 'failure_patterns', 'validation_results'];
    const conn = db.getDb ? db.getDb() : db.getDbInstance();
    for (const table of tables) {
      try { conn.prepare(`DELETE FROM ${table}`).run(); } catch { /* ignore */ }
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects resolved files that escape the configured working directory during size checks', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-routing-workdir-'));
    const outsidePath = path.join(os.tmpdir(), 'p1-routing-traversal', 'outside.ts');
    const traversalSource = path.join(workDir, 'src');
    fs.mkdirSync(traversalSource, { recursive: true });
    fs.writeFileSync(path.join(traversalSource, 'safe.ts'), 'const x = 1;');
    fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
    fs.writeFileSync(outsidePath, 'secret payload');

    vi.spyOn(providerRoutingCore, 'analyzeTaskForRouting').mockReturnValue({
      provider: 'ollama',
      complexity: 'normal',
      reason: 'test',
      rule: null,
      fallbackApplied: false,
    });
    vi.spyOn(providerRoutingCore, 'getProvider').mockReturnValue({ enabled: 1, name: 'ollama' });
    vi.spyOn(taskManager, 'resolveFileReferences').mockReturnValue({
      resolved: [{ actual: outsidePath }],
      missing: [],
      suggestions: [],
    });

    const result = await routing.handleSmartSubmitTask({
      task: 'Refactor safe.ts with a minor change',
      files: ['safe.ts'],
      working_directory: workDir,
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
    expect(getText(result).toLowerCase()).toContain('path traversal');
  });
});

describe('event-tracking rollups are idempotent', () => {
  let db;
  let tracking;
  let conn;

  beforeAll(() => {
    const env = setupTestDbOnly('p1-analytics');
    db = env.db;
    tracking = require('../db/event-tracking');
    conn = db.getDb ? db.getDb() : db.getDbInstance();
    tracking.setDb(conn);
  });

  afterAll(() => { teardownTestDb(); });

  beforeEach(() => {
    for (const table of ['tasks', 'success_metrics']) {
      try { conn.prepare(`DELETE FROM ${table}`).run(); } catch { /* ignore */ }
    }
  });

  function createTask(opts = {}) {
    const payload = {
      id: randomUUID(),
      task_description: opts.task_description || `event task ${randomUUID()}`,
      working_directory: opts.working_directory || os.tmpdir(),
      status: opts.status || 'queued',
      provider: opts.provider || 'codex',
      project: opts.project || 'default',
      ...opts
    };
    db.createTask(payload);
    return db.getTask(payload.id);
  }

  it('replaces existing aggregate rows when rerunning aggregateSuccessMetrics', () => {
    createTask({ project: 'rollup-proj', status: 'completed' });
    createTask({ project: 'rollup-proj', status: 'failed' });

    tracking.aggregateSuccessMetrics('day');
    const rowsFirst = conn.prepare(`
      SELECT period_start, project, total_tasks, successful_tasks, failed_tasks
      FROM success_metrics
      WHERE period_type = 'day' AND project = 'rollup-proj'
    `).all();

    expect(rowsFirst).toHaveLength(1);
    expect(rowsFirst[0].total_tasks).toBe(2);
    expect(rowsFirst[0].successful_tasks).toBe(1);
    expect(rowsFirst[0].failed_tasks).toBe(1);

    tracking.aggregateSuccessMetrics('day');
    const rowsSecond = conn.prepare(`
      SELECT period_start, project, total_tasks, successful_tasks, failed_tasks
      FROM success_metrics
      WHERE period_type = 'day' AND project = 'rollup-proj'
    `).all();

    expect(rowsSecond).toHaveLength(1);
    expect(rowsSecond[0].total_tasks).toBe(2);
    expect(rowsSecond[0].successful_tasks).toBe(1);
    expect(rowsSecond[0].failed_tasks).toBe(1);
  });
});

describe('validation-rules regex safety', () => {
  let db;
  let validation;
  let conn;

  beforeAll(() => {
    const env = setupTestDbOnly('p1-validation');
    db = env.db;
    validation = require('../db/validation-rules');
    conn = db.getDb ? db.getDb() : db.getDbInstance();
    validation.setDb(conn);
    validation.setGetTask((id) => db.getTask(id));
  });

  afterAll(() => { teardownTestDb(); });

  beforeEach(() => {
    for (const table of ['tasks', 'validation_rules', 'retry_rules', 'retry_attempts']) {
      try { conn.prepare(`DELETE FROM ${table}`).run(); } catch { /* ignore */ }
    }
  });

  function createTask(overrides = {}) {
    const payload = {
      id: randomUUID(),
      task_description: overrides.task_description || 'Validation task',
      working_directory: os.tmpdir(),
      status: overrides.status || 'completed',
      provider: overrides.provider || 'ollama',
      ...overrides,
    };
    db.createTask(payload);
    return db.getTask(payload.id);
  }

  it('skips overly long validation regex patterns to avoid unsafe compile behavior', () => {
    const task = createTask();
    validation.saveValidationRule({
      id: randomUUID(),
      name: 'Long regex rule',
      rule_type: 'pattern',
      pattern: 'a'.repeat(5000),
      severity: 'error',
      enabled: true,
    });

    const matches = validation.validateTaskOutput(task.id, [
      { path: '/tmp/validation.js', content: 'aaaa', size: 4 },
    ]);

    expect(matches).toEqual([]);
  });

  it('does not retry on ReDoS-style pattern conditions that fail safety checks', () => {
    const task = createTask({ provider: 'ollama' });
    validation.saveRetryRule({
      id: randomUUID(),
      name: 'Retry on nested quantifier',
      trigger_type: 'pattern',
      trigger_condition: '(a+)+$',
      fallback_provider: 'claude-cli',
      max_retries: 1,
    });

    const retry = validation.shouldRetryWithCloud(task.id, 'aaaaaa');

    expect(retry.shouldRetry).toBe(false);
  });
});
