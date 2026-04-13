import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const { randomUUID } = require('crypto');
const {
  setupTestDbOnly,
  teardownTestDb,
  resetTables,
} = require('./vitest-setup');
const taskCore = require('../db/task-core');
const eventBus = require('../event-bus');

const SUBJECT_MODULE = '../api/v2-task-handlers';
const CONTROL_PLANE_MODULE = '../api/v2-control-plane';
const MIDDLEWARE_MODULE = '../api/middleware';

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module may not have been loaded in this worker yet.
  }
}

function loadHandlers(controlPlaneMock, middlewareMock) {
  clearModule(SUBJECT_MODULE);
  clearModule(CONTROL_PLANE_MODULE);
  clearModule(MIDDLEWARE_MODULE);
  installCjsModuleMock(CONTROL_PLANE_MODULE, controlPlaneMock);
  installCjsModuleMock(MIDDLEWARE_MODULE, middlewareMock);
  return require(SUBJECT_MODULE);
}

function createReq(overrides = {}) {
  return {
    params: {},
    query: {},
    headers: {},
    requestId: 'req-task-approval',
    ...overrides,
  };
}

function createRes() {
  return {};
}

function createTask(testDir, overrides = {}) {
  return taskCore.createTask({
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'task approval handler test',
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'pending_approval',
    tags: overrides.tags || [],
    provider: overrides.provider || 'codex',
    metadata: overrides.metadata || null,
  });
}

describe('api/v2 task approval handlers', () => {
  let handlers;
  let testDir;
  let controlPlaneMock;
  let middlewareMock;
  let emitQueueChangedSpy;
  let emitTaskUpdatedSpy;

  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`task-approve-handler-${Date.now()}`));
    resetTables(['tasks']);

    controlPlaneMock = {
      sendSuccess: vi.fn(),
      sendError: vi.fn(),
      sendList: vi.fn(),
      resolveRequestId: vi.fn((req) => req?.requestId || 'req-task-approval'),
      buildTaskResponse: vi.fn((task) => ({
        id: task.id,
        status: task.status,
        tags: task.tags || [],
      })),
      buildTaskDetailResponse: vi.fn((task) => ({
        id: task.id,
        status: task.status,
        cancel_reason: task.cancel_reason || null,
        tags: task.tags || [],
      })),
    };
    middlewareMock = {
      parseBody: vi.fn(async () => ({})),
    };
    handlers = loadHandlers(controlPlaneMock, middlewareMock);
    emitQueueChangedSpy = vi.spyOn(eventBus, 'emitQueueChanged');
    emitTaskUpdatedSpy = vi.spyOn(eventBus, 'emitTaskUpdated');
  });

  afterEach(() => {
    emitQueueChangedSpy.mockRestore();
    emitTaskUpdatedSpy.mockRestore();
    clearModule(SUBJECT_MODULE);
    clearModule(CONTROL_PLANE_MODULE);
    clearModule(MIDDLEWARE_MODULE);
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('approves a pending_approval task by moving it back to queued and notifying the scheduler', async () => {
    const task = createTask(testDir);

    await handlers.handleApproveTask(
      createReq({ params: { task_id: task.id } }),
      createRes(),
    );

    expect(taskCore.getTask(task.id)).toMatchObject({
      id: task.id,
      status: 'queued',
    });
    expect(emitQueueChangedSpy).toHaveBeenCalledTimes(1);
    expect(emitTaskUpdatedSpy).toHaveBeenCalledWith({
      taskId: task.id,
      status: 'queued',
    });
    expect(controlPlaneMock.sendSuccess).toHaveBeenCalledWith(
      expect.anything(),
      'req-task-approval',
      expect.objectContaining({
        approved: true,
        task_id: task.id,
        status: 'queued',
      }),
      200,
      expect.anything(),
    );
  });

  it('rejects approve requests for tasks that are not pending_approval', async () => {
    const task = createTask(testDir, { status: 'completed' });

    await handlers.handleApproveTask(
      createReq({ params: { task_id: task.id } }),
      createRes(),
    );

    expect(controlPlaneMock.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'req-task-approval',
      'invalid_status',
      'Cannot approve task with status: completed',
      409,
      {},
      expect.anything(),
    );
    expect(taskCore.getTask(task.id).status).toBe('completed');
  });

  it('rejects a pending_approval task by cancelling it with a human_rejected reason', async () => {
    const task = createTask(testDir);

    await handlers.handleRejectTask(
      createReq({ params: { task_id: task.id } }),
      createRes(),
    );

    expect(taskCore.getTask(task.id)).toMatchObject({
      id: task.id,
      status: 'cancelled',
      cancel_reason: 'human_rejected',
    });
    expect(emitQueueChangedSpy).toHaveBeenCalledTimes(1);
    expect(emitTaskUpdatedSpy).toHaveBeenCalledWith({
      taskId: task.id,
      status: 'cancelled',
    });
    expect(controlPlaneMock.sendSuccess).toHaveBeenCalledWith(
      expect.anything(),
      'req-task-approval',
      expect.objectContaining({
        rejected: true,
        task_id: task.id,
        cancel_reason: 'human_rejected',
        status: 'cancelled',
      }),
      200,
      expect.anything(),
    );
  });

  it('bulk-approves pending tasks by batch_id', async () => {
    const batchId = 'batch-42';
    const first = createTask(testDir, { tags: [`factory:batch_id=${batchId}`] });
    const second = createTask(testDir, { tags: [`factory:batch_id=${batchId}`, 'factory:plan_task_number=2'] });

    await handlers.handleApproveTaskBatch(
      createReq({ body: { batch_id: batchId } }),
      createRes(),
    );

    expect(taskCore.getTask(first.id).status).toBe('queued');
    expect(taskCore.getTask(second.id).status).toBe('queued');
    expect(emitQueueChangedSpy).toHaveBeenCalledTimes(2);
    expect(controlPlaneMock.sendSuccess).toHaveBeenCalledWith(
      expect.anything(),
      'req-task-approval',
      expect.objectContaining({
        batch_id: batchId,
        approved_count: 2,
        approved_task_ids: expect.arrayContaining([first.id, second.id]),
        skipped: [],
      }),
      200,
      expect.anything(),
    );
  });

  it('bulk-approves explicit task_ids and reports skipped tasks', async () => {
    const approvable = createTask(testDir);
    const completed = createTask(testDir, { status: 'completed' });

    await handlers.handleApproveTaskBatch(
      createReq({
        body: {
          task_ids: [approvable.id, completed.id, 'missing-task-id'],
        },
      }),
      createRes(),
    );

    expect(taskCore.getTask(approvable.id).status).toBe('queued');
    expect(taskCore.getTask(completed.id).status).toBe('completed');
    expect(controlPlaneMock.sendSuccess).toHaveBeenCalledWith(
      expect.anything(),
      'req-task-approval',
      expect.objectContaining({
        requested_task_ids: [approvable.id, completed.id, 'missing-task-id'],
        approved_count: 1,
        approved_task_ids: [approvable.id],
        skipped: expect.arrayContaining([
          expect.objectContaining({
            task_id: completed.id,
            reason: 'not_pending_approval',
            status: 'completed',
          }),
          expect.objectContaining({
            task_id: 'missing-task-id',
            reason: 'not_found',
            status: null,
          }),
        ]),
      }),
      200,
      expect.anything(),
    );
  });
});
