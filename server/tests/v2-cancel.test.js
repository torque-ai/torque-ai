'use strict';

/**
 * Tests for handleV2TaskCancel in api-server.core.js.
 *
 * Verifies:
 * 1. Cancelling a running task calls taskManager.cancelTask(), not just db.updateTaskStatus()
 * 2. Cancelling a terminal task returns 409 Conflict (not false success)
 * 3. Cancellation errors propagate as 500 responses (not silently swallowed)
 * 4. cancelled: true is only returned on actual success
 */

const MODULE_PATH = '../api/v2-core-handlers';
const TASK_CORE_MODULE = '../db/task-core';
const WEBHOOKS_STREAMING_MODULE = '../db/webhooks-streaming';

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

function clearModuleCaches() {
  for (const modulePath of [MODULE_PATH, TASK_CORE_MODULE, WEBHOOKS_STREAMING_MODULE]) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore missing cache entries.
    }
  }
}

const mockTaskCore = {
  getTask: vi.fn(),
  updateTaskStatus: vi.fn(),
};

const mockWebhooksStreaming = {
  recordTaskEvent: vi.fn(),
  getTaskEvents: vi.fn(),
};

let handlers;

function loadHandlers() {
  clearModuleCaches();
  installMock(TASK_CORE_MODULE, mockTaskCore);
  installMock(WEBHOOKS_STREAMING_MODULE, mockWebhooksStreaming);
  return require(MODULE_PATH);
}

function setV2TaskManager(taskManager) {
  handlers.initTaskManager(taskManager);
}

async function handleV2TaskCancel(...args) {
  return handlers.handleV2TaskCancel(...args);
}

// Minimal mock response that captures writeHead + end calls
function createMockRes() {
  const calls = { writeHead: [], end: [] };
  const res = {
    writeHead: vi.fn((status, headers) => { calls.writeHead.push({ status, headers }); }),
    end: vi.fn((body) => { calls.end.push(body); }),
    _calls: calls,
  };
  return res;
}

function parseLastResponse(res) {
  const endCalls = res._calls.end;
  const writeHeadCalls = res._calls.writeHead;
  if (!endCalls.length) return null;
  const body = endCalls[endCalls.length - 1];
  const statusCode = writeHeadCalls.length ? writeHeadCalls[writeHeadCalls.length - 1].status : 200;
  let data = {};
  try { data = JSON.parse(body); } catch { /* ignore */ }
  return { statusCode, data };
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockTaskCore.getTask.mockReset();
  mockTaskCore.updateTaskStatus.mockReset();
  mockWebhooksStreaming.recordTaskEvent.mockReset();
  mockWebhooksStreaming.getTaskEvents.mockReset();
  mockTaskCore.getTask.mockReturnValue(null);
  mockTaskCore.updateTaskStatus.mockReturnValue(undefined);
  mockWebhooksStreaming.recordTaskEvent.mockReturnValue(undefined);
  mockWebhooksStreaming.getTaskEvents.mockReturnValue([]);
  handlers = loadHandlers();
  setV2TaskManager(null);
});

afterEach(() => {
  clearModuleCaches();
  vi.restoreAllMocks();
});

// ─── Task not found ────────────────────────────────────────────────────────────

describe('handleV2TaskCancel — task not found', () => {
  it('returns 404 when the task does not exist', async () => {
    mockTaskCore.getTask.mockReturnValue(null);

    const res = createMockRes();
    await handleV2TaskCancel(null, res, { requestId: 'req-001' }, 'nonexistent-id', null);

    const { statusCode, data } = parseLastResponse(res);
    expect(statusCode).toBe(404);
    expect(data.error.code).toBe('task_not_found');
  });
});

// ─── Terminal task — must return 409 ──────────────────────────────────────────

describe('handleV2TaskCancel — terminal task', () => {
  it.each(['completed', 'failed', 'cancelled'])(
    'returns 409 Conflict when task status is %s',
    async (status) => {
      mockTaskCore.getTask.mockReturnValue({ id: 'task-term', status, provider: 'codex', model: null });

      const res = createMockRes();
      await handleV2TaskCancel(null, res, { requestId: 'req-002' }, 'task-term', null);

      const { statusCode, data } = parseLastResponse(res);
      expect(statusCode).toBe(409);
      expect(data.error.code).toBe('task_already_terminal');
      // Must NOT report cancelled: true
      expect(data.cancelled).toBeUndefined();
    },
  );
});

// ─── Running task — must call taskManager.cancelTask ─────────────────────────

describe('handleV2TaskCancel — running task with taskManager', () => {
  it('calls taskManager.cancelTask() and reports cancelled: true', async () => {
    const taskRow = { id: 'task-run', status: 'running', provider: 'codex', model: null };
    mockTaskCore.getTask
      .mockReturnValueOnce(taskRow)   // getV2TaskStatusRow (pre-cancel lookup)
      .mockReturnValueOnce({ ...taskRow, status: 'cancelled' }); // getV2TaskStatusRow (post-cancel lookup)

    const mockTaskManager = { cancelTask: vi.fn().mockReturnValue(true) };
    setV2TaskManager(mockTaskManager);

    const res = createMockRes();
    await handleV2TaskCancel(null, res, { requestId: 'req-003' }, 'task-run', null);

    // Process kill must have been attempted
    expect(mockTaskManager.cancelTask).toHaveBeenCalledWith('task-run', 'Task cancelled by request');

    const { statusCode, data } = parseLastResponse(res);
    expect(statusCode).toBe(200);
    expect(data.cancelled).toBe(true);
    expect(data.task_id).toBe('task-run');
  });

  it('cancels pending approval tasks when the row lands in cancelled', async () => {
    const taskRow = { id: 'task-held', status: 'pending_approval', provider: 'codex', model: null };
    mockTaskCore.getTask
      .mockReturnValueOnce(taskRow)
      .mockReturnValueOnce({ ...taskRow, status: 'cancelled' });

    const mockTaskManager = { cancelTask: vi.fn().mockReturnValue(true) };
    setV2TaskManager(mockTaskManager);

    const res = createMockRes();
    await handleV2TaskCancel(null, res, { requestId: 'req-003b' }, 'task-held', null);

    expect(mockTaskManager.cancelTask).toHaveBeenCalledWith('task-held', 'Task cancelled by request');

    const { statusCode, data } = parseLastResponse(res);
    expect(statusCode).toBe(200);
    expect(data.cancelled).toBe(true);
    expect(data.status).toBe('cancelled');
  });

  it('does NOT call db.updateTaskStatus when taskManager is available', async () => {
    const taskRow = { id: 'task-run2', status: 'queued', provider: 'ollama', model: null };
    mockTaskCore.getTask
      .mockReturnValueOnce(taskRow)
      .mockReturnValueOnce({ ...taskRow, status: 'cancelled' });

    const updateSpy = mockTaskCore.updateTaskStatus;
    const mockTaskManager = { cancelTask: vi.fn() };
    setV2TaskManager(mockTaskManager);

    const res = createMockRes();
    await handleV2TaskCancel(null, res, { requestId: 'req-004' }, 'task-run2', null);

    expect(mockTaskManager.cancelTask).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('returns 409 when taskManager reports no cancellation and the task stays non-terminal', async () => {
    const taskRow = { id: 'task-stale', status: 'pending_approval', provider: 'codex', model: null };
    mockTaskCore.getTask
      .mockReturnValueOnce(taskRow)
      .mockReturnValueOnce(taskRow);

    const mockTaskManager = { cancelTask: vi.fn().mockReturnValue(false) };
    setV2TaskManager(mockTaskManager);

    const res = createMockRes();
    await handleV2TaskCancel(null, res, { requestId: 'req-004b' }, 'task-stale', null);

    const { statusCode, data } = parseLastResponse(res);
    expect(statusCode).toBe(409);
    expect(data.error.code).toBe('invalid_status');
    expect(data.error.message).toBe('Task status changed before cancellation could be applied');
    expect(data.cancelled).toBeUndefined();
  });
});

// ─── Fallback: no taskManager — uses db.updateTaskStatus ─────────────────────

describe('handleV2TaskCancel — running task without taskManager', () => {
  it('falls back to db.updateTaskStatus when taskManager is not set', async () => {
    const taskRow = { id: 'task-run3', status: 'running', provider: 'ollama', model: null };
    mockTaskCore.getTask
      .mockReturnValueOnce(taskRow)
      .mockReturnValueOnce({ ...taskRow, status: 'cancelled' });

    const updateSpy = mockTaskCore.updateTaskStatus.mockReturnValue(undefined);
    // setV2TaskManager was reset to null in beforeEach

    const res = createMockRes();
    await handleV2TaskCancel(null, res, { requestId: 'req-005' }, 'task-run3', null);

    expect(updateSpy).toHaveBeenCalledWith('task-run3', 'cancelled', {
      error_output: 'Task cancelled by request',
      cancel_reason: 'user',
    });
    const { statusCode, data } = parseLastResponse(res);
    expect(statusCode).toBe(200);
    expect(data.cancelled).toBe(true);
  });
});

// ─── Error propagation — errors must not be swallowed ─────────────────────────

describe('handleV2TaskCancel — cancellation errors propagate', () => {
  it('returns 500 when taskManager.cancelTask() throws', async () => {
    const taskRow = { id: 'task-err', status: 'running', provider: 'codex', model: null };
    mockTaskCore.getTask.mockReturnValue(taskRow);

    const mockTaskManager = {
      cancelTask: vi.fn().mockImplementation(() => {
        throw new Error('No task found matching ID prefix: task-err');
      }),
    };
    setV2TaskManager(mockTaskManager);

    const res = createMockRes();
    await handleV2TaskCancel(null, res, { requestId: 'req-006' }, 'task-err', null);

    const { statusCode, data } = parseLastResponse(res);
    expect(statusCode).toBe(500);
    expect(data.error.code).toBe('cancellation_failed');
    expect(data.error.message).toContain('No task found matching ID prefix');
    // Must NOT report cancelled: true
    expect(data.cancelled).toBeUndefined();
  });

  it('returns 500 when db.updateTaskStatus() throws (no taskManager)', async () => {
    const taskRow = { id: 'task-dberr', status: 'queued', provider: 'ollama', model: null };
    mockTaskCore.getTask.mockReturnValue(taskRow);
    mockTaskCore.updateTaskStatus.mockImplementation(() => { throw new Error('DB locked'); });

    const res = createMockRes();
    await handleV2TaskCancel(null, res, { requestId: 'req-007' }, 'task-dberr', null);

    const { statusCode, data } = parseLastResponse(res);
    expect(statusCode).toBe(500);
    expect(data.error.code).toBe('cancellation_failed');
    expect(data.cancelled).toBeUndefined();
  });
});
