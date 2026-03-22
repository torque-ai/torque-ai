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

const db = require('../database');
const webhooksStreaming = require('../db/webhooks-streaming');
const apiServer = require('../api-server.core');

const { handleV2TaskCancel, setV2TaskManager } = apiServer._testing;

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
  vi.resetAllMocks();
  // Reset taskManager to null before each test
  setV2TaskManager(null);
  // Silence recordTaskEvent so recordV2TaskEvent never throws
  vi.spyOn(webhooksStreaming, 'recordTaskEvent').mockReturnValue(undefined);
});

// ─── Task not found ────────────────────────────────────────────────────────────

describe('handleV2TaskCancel — task not found', () => {
  it('returns 404 when the task does not exist', async () => {
    vi.spyOn(db, 'getTask').mockReturnValue(null);

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
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'task-term', status, provider: 'codex', model: null });

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
    vi.spyOn(db, 'getTask')
      .mockReturnValueOnce(taskRow)   // getV2TaskStatusRow (pre-cancel lookup)
      .mockReturnValueOnce({ ...taskRow, status: 'cancelled' }); // getV2TaskStatusRow (post-cancel lookup)

    const mockTaskManager = { cancelTask: vi.fn() };
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

  it('does NOT call db.updateTaskStatus when taskManager is available', async () => {
    const taskRow = { id: 'task-run2', status: 'queued', provider: 'ollama', model: null };
    vi.spyOn(db, 'getTask')
      .mockReturnValueOnce(taskRow)
      .mockReturnValueOnce({ ...taskRow, status: 'cancelled' });

    const updateSpy = vi.spyOn(db, 'updateTaskStatus');
    const mockTaskManager = { cancelTask: vi.fn() };
    setV2TaskManager(mockTaskManager);

    const res = createMockRes();
    await handleV2TaskCancel(null, res, { requestId: 'req-004' }, 'task-run2', null);

    expect(mockTaskManager.cancelTask).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

// ─── Fallback: no taskManager — uses db.updateTaskStatus ─────────────────────

describe('handleV2TaskCancel — running task without taskManager', () => {
  it('falls back to db.updateTaskStatus when taskManager is not set', async () => {
    const taskRow = { id: 'task-run3', status: 'running', provider: 'hashline-ollama', model: null };
    vi.spyOn(db, 'getTask')
      .mockReturnValueOnce(taskRow)
      .mockReturnValueOnce({ ...taskRow, status: 'cancelled' });

    const updateSpy = vi.spyOn(db, 'updateTaskStatus').mockReturnValue(undefined);
    // setV2TaskManager was reset to null in beforeEach

    const res = createMockRes();
    await handleV2TaskCancel(null, res, { requestId: 'req-005' }, 'task-run3', null);

    expect(updateSpy).toHaveBeenCalledWith('task-run3', 'cancelled', { error_output: 'Task cancelled by request' });
    const { statusCode, data } = parseLastResponse(res);
    expect(statusCode).toBe(200);
    expect(data.cancelled).toBe(true);
  });
});

// ─── Error propagation — errors must not be swallowed ─────────────────────────

describe('handleV2TaskCancel — cancellation errors propagate', () => {
  it('returns 500 when taskManager.cancelTask() throws', async () => {
    const taskRow = { id: 'task-err', status: 'running', provider: 'codex', model: null };
    vi.spyOn(db, 'getTask').mockReturnValue(taskRow);

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
    vi.spyOn(db, 'getTask').mockReturnValue(taskRow);
    vi.spyOn(db, 'updateTaskStatus').mockImplementation(() => { throw new Error('DB locked'); });

    const res = createMockRes();
    await handleV2TaskCancel(null, res, { requestId: 'req-007' }, 'task-dberr', null);

    const { statusCode, data } = parseLastResponse(res);
    expect(statusCode).toBe(500);
    expect(data.error.code).toBe('cancellation_failed');
    expect(data.cancelled).toBeUndefined();
  });
});
