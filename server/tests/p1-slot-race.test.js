/**
 * Slot claim race-condition regression tests
 *
 * These tests validate that atomic slot claim checks in `db.tryClaimTaskSlot`
 * enforce both global and provider limits when claims are made rapidly.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

let testDir;
let originalDataDir;
let db;
let templateBuffer = null;

function setupDbForTest() {
  testDir = path.join(os.tmpdir(), `torque-slot-race-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(testDir, { recursive: true });
  originalDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) {
    templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  }
  db.resetForTest(templateBuffer);
}

function teardownDbForTest() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
  if (testDir) {
    fs.rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  }
  if (originalDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = originalDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }
}

function createQueuedTask(overrides = {}) {
  const taskId = overrides.id || randomUUID();
  db.createTask({
    id: taskId,
    status: overrides.status || 'pending',
    task_description: overrides.task_description || 'Slot race test task',
    working_directory: overrides.working_directory || process.cwd(),
    provider: overrides.provider || 'ollama',
    model: overrides.model || 'codellama:latest',
    max_retries: overrides.max_retries || 0,
    timeout_minutes: overrides.timeout_minutes || 5,
  });
  return taskId;
}

function claimSlot(taskId, maxConcurrent, provider, providerLimit, providerGroup) {
  return db.tryClaimTaskSlot(taskId, maxConcurrent, null, provider, providerLimit, providerGroup);
}

describe('Slot claim atomicity', () => {
  beforeEach(setupDbForTest);
  afterEach(teardownDbForTest);

  it('respects global max_concurrent', () => {
    const task1 = createQueuedTask({ provider: 'ollama' });
    const task2 = createQueuedTask({ provider: 'anthropic' });

    const firstClaim = claimSlot(task1, 1, 'ollama', null, []);
    const secondClaim = claimSlot(task2, 1, 'anthropic', null, []);

    expect(firstClaim.success).toBe(true);
    expect(secondClaim.success).toBe(false);
    expect(['at_capacity', 'global_limit']).toContain(secondClaim.reason);
    expect(db.getTask(task1).status).toBe('running');
    expect(db.getTask(task2).status).toBe('pending');
    expect(db.getRunningCount()).toBe(1);
  });

  it('respects provider-specific limits', () => {
    const task1 = createQueuedTask({ provider: 'ollama' });
    const task2 = createQueuedTask({ provider: 'ollama' });
    const task3 = createQueuedTask({ provider: 'ollama' });
    const providerGroup = ['ollama', 'aider-ollama', 'hashline-ollama'];

    const firstClaim = claimSlot(task1, 10, 'ollama', 1, providerGroup);
    const secondClaim = claimSlot(task2, 10, 'ollama', 1, providerGroup);
    const thirdClaim = claimSlot(task3, 10, 'ollama', 1, providerGroup);

    expect(firstClaim.success).toBe(true);
    expect(secondClaim.success).toBe(false);
    expect(thirdClaim.success).toBe(false);
    expect(['provider_at_capacity', 'provider_limit']).toContain(secondClaim.reason);

    const providerRunning = db.getDbInstance()
      .prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider IN (?,?,?)')
      .get('running', ...providerGroup).count;
    expect(providerRunning).toBe(1);
  });

  it('sequential rapid claims do not exceed configured provider/global limits', () => {
    const configByProvider = {
      ollama: { providerLimit: 1, providerGroup: ['ollama', 'aider-ollama', 'hashline-ollama'] },
      codex: { providerLimit: 2, providerGroup: ['codex', 'claude-cli'] },
      anthropic: { providerLimit: 1, providerGroup: ['anthropic', 'groq', 'hyperbolic', 'deepinfra'] },
    };
    const tasks = [
      createQueuedTask({ provider: 'ollama' }),
      createQueuedTask({ provider: 'ollama' }),
      createQueuedTask({ provider: 'codex' }),
      createQueuedTask({ provider: 'codex' }),
      createQueuedTask({ provider: 'codex' }),
      createQueuedTask({ provider: 'anthropic' }),
      createQueuedTask({ provider: 'anthropic' }),
    ];

    const providers = [
      'ollama',
      'ollama',
      'codex',
      'codex',
      'codex',
      'anthropic',
      'anthropic',
    ];

    const claimResults = [];
    for (let i = 0; i < tasks.length; i += 1) {
      const provider = providers[i];
      const { providerLimit, providerGroup } = configByProvider[provider];
      claimResults.push(claimSlot(tasks[i], 999, provider, providerLimit, providerGroup));
    }

    const successfulClaims = claimResults.filter((r) => r.success).length;
    expect(successfulClaims).toBe(4);

    const ollamaRunning = db.getDbInstance()
      .prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider IN (?,?,?)')
      .get('running', ...configByProvider.ollama.providerGroup).count;
    const codexRunning = db.getDbInstance()
      .prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider IN (?,?)')
      .get('running', ...configByProvider.codex.providerGroup).count;
    const apiRunning = db.getDbInstance()
      .prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider IN (?,?,?,?)')
      .get('running', ...configByProvider.anthropic.providerGroup).count;

    expect(ollamaRunning).toBe(1);
    expect(codexRunning).toBe(2);
    expect(apiRunning).toBe(1);
    expect(ollamaRunning + codexRunning + apiRunning).toBe(4);
  });
});
