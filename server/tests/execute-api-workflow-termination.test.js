'use strict';

const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const taskCore = require('../db/task-core');

let testDir;
let db;
let templateBuffer;
let executeApi;

function setup() {
  ({ db, testDir } = setupTestDbOnly('api-wt'));
  // Cache template buffer for beforeEach resets
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  templateBuffer = fs.readFileSync(path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf'));
  executeApi = require('../providers/execute-api');
}

function teardown() {
  teardownTestDb();
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
    taskCore.createTask({
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

    const task = taskCore.getTask(taskId);
    expect(task.status).toBe('completed');
  });

  it('calls handleWorkflowTermination on task failure (no fallback)', async () => {
    const handleWorkflowTermination = vi.fn();
    executeApi.init(makeApiDeps({ handleWorkflowTermination }));

    const taskId = randomUUID();
    taskCore.createTask({
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

    const task = taskCore.getTask(taskId);
    expect(task.status).toBe('failed');
  });

  it('does not crash if handleWorkflowTermination throws', async () => {
    const handleWorkflowTermination = vi.fn().mockImplementation(() => {
      throw new Error('workflow runtime exploded');
    });
    executeApi.init(makeApiDeps({ handleWorkflowTermination }));

    const taskId = randomUUID();
    taskCore.createTask({
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
    const task = taskCore.getTask(taskId);
    expect(task.status).toBe('completed');
  });

  it('does not call handleWorkflowTermination when not injected', async () => {
    // Init without handleWorkflowTermination
    executeApi.init(makeApiDeps());

    const taskId = randomUUID();
    taskCore.createTask({
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

    const task = taskCore.getTask(taskId);
    expect(task.status).toBe('completed');
  });
});
