/**
 * E2E Test Helpers for TORQUE
 *
 * Shared utilities for end-to-end tests that exercise the real startTask()
 * execution path with controlled infrastructure (mock Ollama, mock spawn).
 *
 * Uses db.resetForTest(buffer) for fast in-memory DB resets (~5-10ms)
 * instead of file copies + 40-module cache clearing.
 *
 * Still creates a temp directory for tests that need filesystem paths
 * (work dirs, file tracking, etc.) — just doesn't use it for the DB.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const hostManagement = require('../db/host-management');

const TEMPLATE_DIR = path.join(os.tmpdir(), 'torque-vitest-template');
const TEMPLATE_BUF = path.join(TEMPLATE_DIR, 'template.db.buf');

let templateBuffer = null; // Loaded once per worker process

/**
 * Set up an isolated test DB using in-memory buffer reset.
 * Creates a temp dir for filesystem operations but uses in-memory DB.
 *
 * @param {string} suiteName - Used for temp directory naming
 * @returns {{ db: object, tm: object, testDir: string, origDataDir: string }}
 */
function setupE2eDb(suiteName) {
  // Load buffer once per worker process (lazy)
  if (!templateBuffer) {
    templateBuffer = fs.readFileSync(TEMPLATE_BUF);
  }

  // Create a temp dir for tests that need filesystem paths
  const testDir = path.join(os.tmpdir(), `torque-e2e-${suiteName}-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  const db = require('../database');

  const configCore = require('../db/config-core');

  // Swap to fresh in-memory DB from buffer (~5-10ms)
  // No init() needed — resetForTest sets up the DB handle and all sub-modules
  db.resetForTest(templateBuffer);

  // Disable discovery, slow timers
  configCore.setConfig('discovery_enabled', '0');
  configCore.setConfig('health_check_interval_seconds', '99999');
  configCore.setConfig('activity_poll_interval_seconds', '99999');

  // Make all models hashline-capable for E2E tests (default allowlist
  // only includes specific production models like qwen3, codestral, etc.)
  configCore.setConfig('hashline_capable_models', '');

  // Clear task-manager state and skip git in close handlers (no real files modified in E2E tests)
  const tm = require('../task-manager');
  if (typeof tm.initEarlyDeps === 'function') {
    tm.initEarlyDeps();
  }
  if (typeof tm.initSubModules === 'function') {
    tm.initSubModules();
  }
  if (tm._testing && tm._testing.resetForTest) {
    tm._testing.resetForTest();
    tm._testing.skipGitInCloseHandler = true;
  }

  return { db, tm, testDir, origDataDir };
}

/**
 * Lightweight per-test reset for E2E tests that don't need filesystem paths.
 * Call setupE2eDb() once in beforeAll(), then resetE2eDb() in beforeEach().
 * Skips temp dir creation/cleanup — just resets the in-memory DB + task-manager state.
 */
function resetE2eDb() {
  if (!templateBuffer) {
    templateBuffer = fs.readFileSync(TEMPLATE_BUF);
  }

  const db = require('../database');
  const configCore = require('../db/config-core');
  db.resetForTest(templateBuffer);

  configCore.setConfig('discovery_enabled', '0');
  configCore.setConfig('health_check_interval_seconds', '99999');
  configCore.setConfig('activity_poll_interval_seconds', '99999');
  configCore.setConfig('hashline_capable_models', '');

  const tm = require('../task-manager');
  if (typeof tm.initEarlyDeps === 'function') {
    tm.initEarlyDeps();
  }
  if (typeof tm.initSubModules === 'function') {
    tm.initSubModules();
  }
  if (tm._testing && tm._testing.resetForTest) {
    tm._testing.resetForTest();
    tm._testing.skipGitInCloseHandler = true;
  }
}

/**
 * Clean up after E2E test.
 * Waits for any in-flight close handlers (which spawn git processes) to finish,
 * then cleans up the temp dir. This prevents orphaned git.exe processes on Windows
 * when vitest kills worker forks before close handlers complete.
 */
async function teardownE2eDb(ctx) {
  // Wait for pending close handlers to finish (fast since git is skipped)
  if (ctx.tm && ctx.tm._testing && ctx.tm._testing.waitForPendingHandlers) {
    await ctx.tm._testing.waitForPendingHandlers(3000);
  }

  if (ctx.testDir) {
    try { fs.rmSync(ctx.testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (ctx.origDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = ctx.origDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }
}

/**
 * Register a mock Ollama HTTP server as a host in the test DB.
 *
 * @param {object} db - Database module
 * @param {string} url - Mock server URL (e.g., http://127.0.0.1:12345)
 * @param {string[]} modelNames - Model names the mock supports
 * @param {object} opts - Optional overrides { name, priority, maxConcurrent }
 * @returns {object} The registered host record
 */
function registerMockHost(db, url, modelNames = ['codellama:latest'], opts = {}) {
  const name = opts.name || 'mock-ollama';
  const priority = opts.priority || 10;
  const maxConcurrent = opts.maxConcurrent || 4;
  const hostId = opts.id || `mock-${name}-${Date.now()}`;

  const host = hostManagement.addOllamaHost({
    id: hostId,
    name,
    url,
    priority,
    max_concurrent: maxConcurrent,
  });

  if (host && host.id) {
    // Set models and mark healthy using the correct API
    const models = modelNames.map(m => ({
      name: m,
      size: 4000000000,
      digest: 'mock_' + m.replace(/[^a-z0-9]/g, ''),
      modified_at: new Date().toISOString(),
    }));
    hostManagement.updateOllamaHost(host.id, {
      models_cache: JSON.stringify(models),
      models_updated_at: new Date().toISOString(),
      status: 'healthy',
      consecutive_failures: 0,
    });
  }

  return host;
}

/**
 * Create a test task in the DB ready for startTask().
 *
 * @param {object} db - Database module
 * @param {object} opts - Task options
 * @returns {string} Task ID
 */
function createTestTask(db, opts = {}) {
  const taskCore = require('../db/task-core');
  const { v4: uuidv4 } = require('uuid');
  const taskId = opts.id || uuidv4();
  const task = {
    id: taskId,
    task_description: opts.description || 'Test task for E2E testing',
    working_directory: opts.workingDirectory || os.tmpdir(),
    provider: opts.provider || 'ollama',
    model: opts.model || 'codellama:latest',
    status: opts.status || 'pending',
    priority: opts.priority || 0,
    timeout_minutes: opts.timeout || 5,
    auto_approve: opts.autoApprove || false,
    ...opts.extra,
  };

  taskCore.createTask(task);
  return taskId;
}

/**
 * Poll the DB until a task reaches one of the given statuses.
 *
 * @param {object} db - Database module
 * @param {string} taskId - Task ID
 * @param {string[]} statuses - Target statuses (e.g., ['completed', 'failed'])
 * @param {number} timeout - Max wait time in ms (default 10000)
 * @param {number} interval - Poll interval in ms (default 100)
 * @returns {object} Final task record
 */
async function waitForTaskStatus(db, taskId, statuses, timeout = 10000, interval = 15) {
  const taskCore = require('../db/task-core');
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const task = taskCore.getTask(taskId);
    if (task && statuses.includes(task.status)) {
      return task;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  const task = taskCore.getTask(taskId);
  throw new Error(`Task ${taskId} did not reach ${statuses.join('/')} within ${timeout}ms (current: ${task?.status})`);
}

module.exports = {
  setupE2eDb,
  resetE2eDb,
  teardownE2eDb,
  registerMockHost,
  createTestTask,
  waitForTaskStatus,
};
