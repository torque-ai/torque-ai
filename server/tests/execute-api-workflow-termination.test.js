'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir;
let origDataDir;
let db;
let templateBuffer;
let executeApi;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-api-wt-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);

  executeApi = require('../providers/execute-api');
}

function teardown() {
  try { if (db) db.close(); } catch { /* ok */ }
  if (origDataDir !== undefined) process.env.TORQUE_DATA_DIR = origDataDir;
  else delete process.env.TORQUE_DATA_DIR;
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
}

function makeApiDeps(overrides = {}) {
  return {
    db,
    dashboard: {
      broadcast: vi.fn(),
      broadcastTaskUpdate: vi.fn(),
      notifyTaskUpdated: vi.fn(),
      notifyTaskOutput: vi.fn(),
    },
    apiAbortControllers: overrides.apiAbortControllers || new Map(),
    processQueue: vi.fn(),
    ...overrides,
  };
}

describe('execute-api handleWorkflowTermination integration', () => {
  beforeAll(setup);
  afterAll(teardown);

  beforeEach(() => {
    db.resetForTest(templateBuffer);
  });

  it('calls handleWorkflowTermination on successful task completion', async () => {
    const handleWorkflowTermination = vi.fn();
    executeApi.init(makeApiDeps({ handleWorkflowTermination }));

    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'Test workflow termination on completion',
      status: 'running',
      provider: 'test-provider',
      working_directory: testDir,
    });

    const provider = {
      name: 'test-provider',
      submit: vi.fn().mockResolvedValue({ output: 'done', usage: null }),
    };

    await executeApi.executeApiProvider({
      id: taskId,
      task_description: 'Test workflow termination on completion',
      model: 'test-model',
      timeout_minutes: 5,
    }, provider);

    expect(handleWorkflowTermination).toHaveBeenCalledWith(taskId);
    expect(handleWorkflowTermination).toHaveBeenCalledTimes(1);

    const task = db.getTask(taskId);
    expect(task.status).toBe('completed');
  });

  it('calls handleWorkflowTermination on task failure (no fallback)', async () => {
    const handleWorkflowTermination = vi.fn();
    executeApi.init(makeApiDeps({ handleWorkflowTermination }));

    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'Test workflow termination on failure',
      status: 'running',
      provider: 'test-provider',
      working_directory: testDir,
    });

    const provider = {
      name: 'test-provider',
      submit: vi.fn().mockRejectedValue(new Error('provider crashed')),
    };

    await executeApi.executeApiProvider({
      id: taskId,
      task_description: 'Test workflow termination on failure',
      model: 'test-model',
      timeout_minutes: 5,
    }, provider);

    expect(handleWorkflowTermination).toHaveBeenCalledWith(taskId);
    expect(handleWorkflowTermination).toHaveBeenCalledTimes(1);

    const task = db.getTask(taskId);
    expect(task.status).toBe('failed');
  });

  it('does not crash if handleWorkflowTermination throws', async () => {
    const handleWorkflowTermination = vi.fn().mockImplementation(() => {
      throw new Error('workflow runtime exploded');
    });
    executeApi.init(makeApiDeps({ handleWorkflowTermination }));

    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'Test resilience',
      status: 'running',
      provider: 'test-provider',
      working_directory: testDir,
    });

    const provider = {
      name: 'test-provider',
      submit: vi.fn().mockResolvedValue({ output: 'ok', usage: null }),
    };

    // Should not throw even though handleWorkflowTermination throws
    await executeApi.executeApiProvider({
      id: taskId,
      task_description: 'Test resilience',
      model: 'test-model',
      timeout_minutes: 5,
    }, provider);

    expect(handleWorkflowTermination).toHaveBeenCalledWith(taskId);
    const task = db.getTask(taskId);
    expect(task.status).toBe('completed');
  });

  it('does not call handleWorkflowTermination when not injected', async () => {
    // Init without handleWorkflowTermination
    executeApi.init(makeApiDeps());

    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'No termination handler',
      status: 'running',
      provider: 'test-provider',
      working_directory: testDir,
    });

    const provider = {
      name: 'test-provider',
      submit: vi.fn().mockResolvedValue({ output: 'ok', usage: null }),
    };

    // Should complete without errors
    await executeApi.executeApiProvider({
      id: taskId,
      task_description: 'No termination handler',
      model: 'test-model',
      timeout_minutes: 5,
    }, provider);

    const task = db.getTask(taskId);
    expect(task.status).toBe('completed');
  });
});
