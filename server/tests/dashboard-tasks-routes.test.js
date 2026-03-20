'use strict';

import { describe, expect, it, vi, beforeEach } from 'vitest';

const ROUTE_MODULE = '../dashboard/routes/tasks';
const MODULE_PATHS = [
  ROUTE_MODULE,
  '../database',
  '../dashboard/utils',
  '../task-manager',
  '../tools',
  '../dashboard-server',
];

const mockDb = {
  listTasks: vi.fn(),
  countTasks: vi.fn(),
  getTask: vi.fn(),
  getStreamChunks: vi.fn(),
  updateTaskStatus: vi.fn(),
  approveProviderSwitch: vi.fn(),
  rejectProviderSwitch: vi.fn(),
  deleteTask: vi.fn(),
  getDiffPreview: vi.fn(),
  getTaskLogs: vi.fn(),
};

const mockUtils = {
  sendJson: vi.fn(),
  sendError: vi.fn(),
  parseBody: vi.fn(),
  enrichTaskWithHostName: vi.fn(),
};

const mockTaskManager = {
  cancelTask: vi.fn(),
};

const mockTools = {
  handleToolCall: vi.fn(),
};

const mockDashboardServer = {
  notifyTaskDeleted: vi.fn(),
};

let handlers;

function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function installMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearLoadedModules() {
  for (const modulePath of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that have not been loaded yet.
    }
  }
}

function loadHandlers() {
  clearLoadedModules();
  installMock('../database', mockDb);
  installMock('../dashboard/utils', mockUtils);
  installMock('../task-manager', mockTaskManager);
  installMock('../tools', mockTools);
  installMock('../dashboard-server', mockDashboardServer);
  return require(ROUTE_MODULE);
}

function createReq(overrides = {}) {
  return {
    body: undefined,
    headers: {},
    query: {},
    ...overrides,
  };
}

function createRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    payload: null,
    writeHead: vi.fn((statusCode, headers) => {
      res.statusCode = statusCode;
      res.headers = headers;
    }),
    end: vi.fn((body) => {
      res.body = body;
      try {
        res.payload = typeof body === 'string' ? JSON.parse(body) : body;
      } catch {
        res.payload = body;
      }
    }),
  };
  return res;
}

function createContext(overrides = {}) {
  return {
    broadcastTaskUpdate: vi.fn(),
    clients: new Set(),
    serverPort: 3456,
    ...overrides,
  };
}

function expectSuccess(res, payload, statusCode = 200) {
  expect(res.statusCode).toBe(statusCode);
  expect(res.payload).toEqual(payload);
}

function expectFailure(res, message, statusCode = 400) {
  expect(res.statusCode).toBe(statusCode);
  expect(res.payload).toEqual({ error: message });
}

function resetDbDefaults() {
  mockDb.listTasks.mockReset();
  mockDb.listTasks.mockReturnValue([]);

  mockDb.countTasks.mockReset();
  mockDb.countTasks.mockReturnValue(0);

  mockDb.getTask.mockReset();
  mockDb.getTask.mockReturnValue(null);

  mockDb.getStreamChunks.mockReset();
  mockDb.getStreamChunks.mockReturnValue([]);

  mockDb.updateTaskStatus.mockReset();
  mockDb.updateTaskStatus.mockReturnValue(undefined);

  mockDb.approveProviderSwitch.mockReset();
  mockDb.approveProviderSwitch.mockReturnValue(undefined);

  mockDb.rejectProviderSwitch.mockReset();
  mockDb.rejectProviderSwitch.mockReturnValue(undefined);

  mockDb.deleteTask.mockReset();
  mockDb.deleteTask.mockReturnValue(undefined);

  mockDb.getDiffPreview.mockReset();
  mockDb.getDiffPreview.mockReturnValue(null);

  mockDb.getTaskLogs.mockReset();
  mockDb.getTaskLogs.mockReturnValue([]);
}

function resetUtilsDefaults() {
  mockUtils.sendJson.mockReset();
  mockUtils.sendJson.mockImplementation((res, payload, statusCode = 200) => {
    const finalPayload = clone(payload);
    res.statusCode = statusCode;
    res.headers = { 'Content-Type': 'application/json' };
    res.payload = finalPayload;
    res.body = JSON.stringify(finalPayload);
    if (typeof res.writeHead === 'function') {
      res.writeHead(statusCode, res.headers);
    }
    if (typeof res.end === 'function') {
      res.end(res.body);
    }
    return finalPayload;
  });

  mockUtils.sendError.mockReset();
  mockUtils.sendError.mockImplementation((res, message, statusCode = 400) => (
    mockUtils.sendJson(res, { error: message }, statusCode)
  ));

  mockUtils.parseBody.mockReset();
  mockUtils.parseBody.mockResolvedValue({});

  mockUtils.enrichTaskWithHostName.mockReset();
  mockUtils.enrichTaskWithHostName.mockImplementation((task) => {
    if (task && typeof task === 'object') {
      task.enriched = true;
    }
    return task;
  });
}

function resetDependencyDefaults() {
  mockTaskManager.cancelTask.mockReset();
  mockTaskManager.cancelTask.mockReturnValue(undefined);

  mockTools.handleToolCall.mockReset();
  mockTools.handleToolCall.mockResolvedValue({
    isError: false,
    content: [{ text: '{}' }],
  });

  mockDashboardServer.notifyTaskDeleted.mockReset();
  mockDashboardServer.notifyTaskDeleted.mockReturnValue(undefined);
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetDbDefaults();
  resetUtilsDefaults();
  resetDependencyDefaults();
  handlers = loadHandlers();
});

describe('dashboard/routes/tasks', () => {
  describe('handleListTasks', () => {
    it('returns paginated tasks with default page and limit', () => {
      mockDb.listTasks.mockReturnValue([
        { id: 'task-1', status: 'running', ollama_host_id: 'host-a' },
      ]);
      mockDb.countTasks.mockReturnValue(26);
      const res = createRes();

      handlers.handleListTasks(createReq(), res, {});

      expect(mockDb.listTasks).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        orderBy: 'created_at',
        orderDir: 'desc',
      });
      expect(mockDb.countTasks).toHaveBeenCalledWith({
        orderBy: 'created_at',
        orderDir: 'desc',
      });
      expect(mockUtils.enrichTaskWithHostName).toHaveBeenCalledTimes(1);
      expectSuccess(res, {
        tasks: [
          { id: 'task-1', status: 'running', ollama_host_id: 'host-a', enriched: true },
        ],
        pagination: {
          page: 1,
          limit: 25,
          total: 26,
          totalPages: 2,
        },
      });
    });

    it('applies pagination, status, provider, search, date, and sort filters', () => {
      const res = createRes();

      handlers.handleListTasks(createReq(), res, {
        page: '3',
        limit: '10',
        status: 'running',
        provider: 'openai',
        search: 'build',
        from: '2026-03-01',
        to: '2026-03-10',
        orderBy: 'created_at',
        orderDir: 'asc',
      });

      expect(mockDb.listTasks).toHaveBeenCalledWith({
        status: 'running',
        provider: 'openai',
        search: 'build',
        from_date: '2026-03-01',
        to_date: '2026-03-10',
        orderBy: 'created_at',
        orderDir: 'asc',
        limit: 10,
        offset: 20,
      });
      expect(mockDb.countTasks).toHaveBeenCalledWith({
        status: 'running',
        provider: 'openai',
        search: 'build',
        from_date: '2026-03-01',
        to_date: '2026-03-10',
        orderBy: 'created_at',
        orderDir: 'asc',
      });
      expectSuccess(res, {
        tasks: [],
        pagination: {
          page: 3,
          limit: 10,
          total: 0,
          totalPages: 0,
        },
      });
    });

    it('maps archived status to archivedOnly without forwarding status', () => {
      const res = createRes();

      handlers.handleListTasks(createReq(), res, {
        status: 'archived',
        page: '2',
      });

      expect(mockDb.listTasks).toHaveBeenCalledWith({
        archivedOnly: true,
        limit: 25,
        offset: 25,
        orderBy: 'created_at',
        orderDir: 'desc',
      });
      expect(mockDb.countTasks).toHaveBeenCalledWith({
        archivedOnly: true,
        orderBy: 'created_at',
        orderDir: 'desc',
      });
    });

    it('clamps large limits to 100', () => {
      const res = createRes();

      handlers.handleListTasks(createReq(), res, {
        page: '2',
        limit: '999',
      });

      expect(mockDb.listTasks).toHaveBeenCalledWith({
        limit: 100,
        offset: 100,
        orderBy: 'created_at',
        orderDir: 'desc',
      });
      expect(res.payload.pagination).toEqual({
        page: 2,
        limit: 100,
        total: 0,
        totalPages: 0,
      });
    });

    it('falls back to page 1 and limit 25 when query values parse to zero', () => {
      const res = createRes();

      handlers.handleListTasks(createReq(), res, {
        page: '0',
        limit: '0',
      });

      expect(mockDb.listTasks).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        orderBy: 'created_at',
        orderDir: 'desc',
      });
      expect(res.payload.pagination.page).toBe(1);
      expect(res.payload.pagination.limit).toBe(25);
    });

    it('returns an empty state with zero total pages when no tasks match', () => {
      const res = createRes();

      handlers.handleListTasks(createReq(), res, {
        status: 'completed',
      });

      expectSuccess(res, {
        tasks: [],
        pagination: {
          page: 1,
          limit: 25,
          total: 0,
          totalPages: 0,
        },
      });
    });
  });

  describe('handleGetTask', () => {
    it('returns 404 when the task does not exist', () => {
      const res = createRes();

      handlers.handleGetTask(createReq(), res, {}, 'missing-task');

      expectFailure(res, 'Task not found', 404);
      expect(mockDb.getStreamChunks).not.toHaveBeenCalled();
    });

    it('returns task details with streamed output chunks', () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-1',
        status: 'completed',
        ollama_host_id: 'host-a',
      });
      mockDb.getStreamChunks.mockReturnValue([
        { sequence: 1, content: 'hello' },
      ]);
      const res = createRes();

      handlers.handleGetTask(createReq(), res, {}, 'task-1');

      expect(mockDb.getTask).toHaveBeenCalledWith('task-1');
      expect(mockDb.getStreamChunks).toHaveBeenCalledWith('task-1');
      expect(mockUtils.enrichTaskWithHostName).toHaveBeenCalledTimes(1);
      expectSuccess(res, {
        id: 'task-1',
        status: 'completed',
        ollama_host_id: 'host-a',
        output_chunks: [{ sequence: 1, content: 'hello' }],
        enriched: true,
      });
    });

    it('falls back to an empty chunk list when chunk lookup throws', () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-2',
        status: 'failed',
      });
      mockDb.getStreamChunks.mockImplementation(() => {
        throw new Error('stream unavailable');
      });
      const res = createRes();

      handlers.handleGetTask(createReq(), res, {}, 'task-2');

      expectSuccess(res, {
        id: 'task-2',
        status: 'failed',
        output_chunks: [],
        enriched: true,
      });
    });
  });

  describe('handleTaskAction', () => {
    it('returns 404 when the task action target does not exist', async () => {
      const res = createRes();
      const context = createContext();

      await handlers.handleTaskAction(createReq(), res, {}, 'missing-task', 'retry', context);

      expectFailure(res, 'Task not found', 404);
      expect(context.broadcastTaskUpdate).not.toHaveBeenCalled();
    });

    it('requeues failed tasks on retry', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-1',
        status: 'failed',
      });
      const res = createRes();
      const context = createContext();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-1', 'retry', context);

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-1', 'queued', {
        retry_count: 1,
        provider: null,
        error_output: null,
        started_at: null,
        completed_at: null,
      });
      expect(context.broadcastTaskUpdate).toHaveBeenCalledWith('task-1');
      expectSuccess(res, { success: true, message: 'Task requeued' });
    });

    it('rejects retry when the task is not failed', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-1',
        status: 'completed',
      });
      const res = createRes();
      const context = createContext();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-1', 'retry', context);

      expectFailure(res, 'Can only retry failed tasks');
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(context.broadcastTaskUpdate).not.toHaveBeenCalled();
    });

    it('cancels queued or running tasks through the task manager', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-2',
        status: 'running',
      });
      const res = createRes();
      const context = createContext();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-2', 'cancel', context);

      expect(mockTaskManager.cancelTask).toHaveBeenCalledWith(
        'task-2',
        'Cancelled by user via dashboard',
      );
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(context.broadcastTaskUpdate).toHaveBeenCalledWith('task-2');
      expectSuccess(res, { success: true, message: 'Task cancelled' });
    });

    it('falls back to marking the task failed when cancellation throws', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-2',
        status: 'queued',
      });
      mockTaskManager.cancelTask.mockImplementation(() => {
        throw new Error('cancel failed');
      });
      const res = createRes();
      const context = createContext();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-2', 'cancel', context);

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-2', 'failed', {
        error_output: 'Cancelled by user via dashboard',
      });
      expect(context.broadcastTaskUpdate).toHaveBeenCalledWith('task-2');
      expectSuccess(res, { success: true, message: 'Task cancelled' });
    });

    it('rejects cancel for tasks that are not queued or running', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-2',
        status: 'completed',
      });
      const res = createRes();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-2', 'cancel', createContext());

      expectFailure(res, 'Can only cancel queued or running tasks');
      expect(mockTaskManager.cancelTask).not.toHaveBeenCalled();
    });

    it('approves provider switches using provider_switch_target from string metadata', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-3',
        status: 'pending_provider_switch',
        metadata: JSON.stringify({
          provider_switch_target: 'codex',
          target_provider: 'claude-cli',
          fallback_provider: 'openai',
        }),
      });
      const res = createRes();
      const context = createContext();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-3', 'approve-switch', context);

      expect(mockDb.approveProviderSwitch).toHaveBeenCalledWith('task-3', 'codex');
      expect(context.broadcastTaskUpdate).toHaveBeenCalledWith('task-3');
      expectSuccess(res, { success: true, message: 'Provider switch approved' });
    });

    it('approves provider switches using target_provider from object metadata', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-4',
        status: 'pending_provider_switch',
        metadata: {
          target_provider: 'claude-cli',
        },
      });
      const res = createRes();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-4', 'approve-switch', createContext());

      expect(mockDb.approveProviderSwitch).toHaveBeenCalledWith('task-4', 'claude-cli');
      expectSuccess(res, { success: true, message: 'Provider switch approved' });
    });

    it('approves provider switches with an undefined target when metadata is invalid', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-5',
        status: 'pending_provider_switch',
        metadata: '{bad-json',
      });
      const res = createRes();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-5', 'approve-switch', createContext());

      expect(mockDb.approveProviderSwitch).toHaveBeenCalledWith('task-5', undefined);
      expectSuccess(res, { success: true, message: 'Provider switch approved' });
    });

    it('rejects provider switch approval when the task is not pending a switch', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-5',
        status: 'running',
      });
      const res = createRes();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-5', 'approve-switch', createContext());

      expectFailure(res, 'Task is not pending provider switch');
      expect(mockDb.approveProviderSwitch).not.toHaveBeenCalled();
    });

    it('rejects provider switches and broadcasts the update', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-6',
        status: 'pending_provider_switch',
      });
      const res = createRes();
      const context = createContext();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-6', 'reject-switch', context);

      expect(mockDb.rejectProviderSwitch).toHaveBeenCalledWith(
        'task-6',
        'Rejected via dashboard',
      );
      expect(context.broadcastTaskUpdate).toHaveBeenCalledWith('task-6');
      expectSuccess(res, { success: true, message: 'Provider switch rejected' });
    });

    it('rejects provider switch rejection when the task is not pending a switch', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-6',
        status: 'failed',
      });
      const res = createRes();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-6', 'reject-switch', createContext());

      expectFailure(res, 'Task is not pending provider switch');
      expect(mockDb.rejectProviderSwitch).not.toHaveBeenCalled();
    });

    it('removes terminal tasks and notifies the dashboard', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-7',
        status: 'completed',
      });
      const res = createRes();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-7', 'remove', createContext());

      expect(mockDb.deleteTask).toHaveBeenCalledWith('task-7');
      expect(mockDashboardServer.notifyTaskDeleted).toHaveBeenCalledWith('task-7');
      expectSuccess(res, { success: true, message: 'Task removed' });
    });

    it('still succeeds when dashboard deletion notification throws', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-7',
        status: 'cancelled',
      });
      mockDashboardServer.notifyTaskDeleted.mockImplementation(() => {
        throw new Error('dashboard offline');
      });
      const res = createRes();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-7', 'remove', createContext());

      expect(mockDb.deleteTask).toHaveBeenCalledWith('task-7');
      expectSuccess(res, { success: true, message: 'Task removed' });
    });

    it('rejects remove for non-terminal tasks', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-8',
        status: 'queued',
      });
      const res = createRes();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-8', 'remove', createContext());

      expectFailure(res, 'Can only remove completed, failed, or cancelled tasks');
      expect(mockDb.deleteTask).not.toHaveBeenCalled();
    });

    it('returns 500 when deleting a task fails', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-9',
        status: 'failed',
      });
      mockDb.deleteTask.mockImplementation(() => {
        throw new Error('disk locked');
      });
      const res = createRes();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-9', 'remove', createContext());

      expectFailure(res, 'Failed to remove task: disk locked', 500);
    });

    it('returns 400 for unknown task actions', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'task-10',
        status: 'failed',
      });
      const res = createRes();

      await handlers.handleTaskAction(createReq(), res, {}, 'task-10', 'archive', createContext());

      expectFailure(res, 'Unknown action', 400);
    });
  });

  describe('handleSubmitTask', () => {
    it('rejects requests without a task string', async () => {
      mockUtils.parseBody.mockResolvedValue({});
      const res = createRes();

      await handlers.handleSubmitTask(createReq(), res, {}, createContext());

      expectFailure(res, 'task is required and must be a non-empty string', 400);
      expect(mockTools.handleToolCall).not.toHaveBeenCalled();
    });

    it('rejects whitespace-only task input', async () => {
      mockUtils.parseBody.mockResolvedValue({
        task: '   ',
      });
      const res = createRes();

      await handlers.handleSubmitTask(createReq(), res, {}, createContext());

      expectFailure(res, 'task is required and must be a non-empty string', 400);
      expect(mockTools.handleToolCall).not.toHaveBeenCalled();
    });

    it('submits through smart_submit_task by default and broadcasts the new task id', async () => {
      mockUtils.parseBody.mockResolvedValue({
        task: '  Build release  ',
      });
      mockTools.handleToolCall.mockResolvedValue({
        isError: false,
        content: [{ text: '{"task_id":"task-11","status":"queued"}' }],
      });
      const res = createRes();
      const context = createContext();

      await handlers.handleSubmitTask(createReq(), res, {}, context);

      expect(mockTools.handleToolCall).toHaveBeenCalledWith('smart_submit_task', {
        task: 'Build release',
      });
      expect(context.broadcastTaskUpdate).toHaveBeenCalledWith('task-11');
      expectSuccess(res, {
        success: true,
        task_id: 'task-11',
        status: 'queued',
      });
    });

    it('keeps using smart_submit_task when provider is auto', async () => {
      mockUtils.parseBody.mockResolvedValue({
        task: 'Sync docs',
        provider: 'auto',
        model: 'gpt-5',
      });
      const res = createRes();

      await handlers.handleSubmitTask(createReq(), res, {}, createContext());

      expect(mockTools.handleToolCall).toHaveBeenCalledWith('smart_submit_task', {
        task: 'Sync docs',
        model: 'gpt-5',
      });
      expectSuccess(res, { success: true });
    });

    it('submits through submit_task when an explicit provider is supplied', async () => {
      mockUtils.parseBody.mockResolvedValue({
        task: 'Run lint',
        provider: 'openrouter',
        model: 'claude-3.7',
        working_directory: 'C:\\repo',
      });
      mockTools.handleToolCall.mockResolvedValue({
        isError: false,
        content: [{ text: '{"task_id":"task-12","status":"queued","provider":"openrouter"}' }],
      });
      const res = createRes();

      await handlers.handleSubmitTask(createReq(), res, {}, createContext());

      expect(mockTools.handleToolCall).toHaveBeenCalledWith('submit_task', {
        task: 'Run lint',
        provider: 'openrouter',
        model: 'claude-3.7',
        working_directory: 'C:\\repo',
      });
      expectSuccess(res, {
        success: true,
        task_id: 'task-12',
        status: 'queued',
        provider: 'openrouter',
      });
    });

    it('returns the tool error text when submission fails', async () => {
      mockUtils.parseBody.mockResolvedValue({
        task: 'Run tests',
      });
      mockTools.handleToolCall.mockResolvedValue({
        isError: true,
        content: [{ text: 'provider unavailable' }],
      });
      const res = createRes();

      await handlers.handleSubmitTask(createReq(), res, {}, createContext());

      expectFailure(res, 'provider unavailable', 400);
    });

    it('falls back to raw result text when the tool response is not JSON', async () => {
      mockUtils.parseBody.mockResolvedValue({
        task: 'Refresh cache',
      });
      mockTools.handleToolCall.mockResolvedValue({
        isError: false,
        content: [{ text: 'submitted successfully' }],
      });
      const res = createRes();
      const context = createContext();

      await handlers.handleSubmitTask(createReq(), res, {}, context);

      expectSuccess(res, {
        success: true,
        raw: 'submitted successfully',
      });
      expect(context.broadcastTaskUpdate).not.toHaveBeenCalled();
    });

    it('does not broadcast when no task_id is returned or no broadcaster exists', async () => {
      mockUtils.parseBody.mockResolvedValue({
        task: 'Cleanup artifacts',
      });
      mockTools.handleToolCall.mockResolvedValue({
        isError: false,
        content: [{ text: '{"status":"queued"}' }],
      });
      const res = createRes();

      await handlers.handleSubmitTask(createReq(), res, {}, {});

      expectSuccess(res, {
        success: true,
        status: 'queued',
      });
    });

    it('returns 500 when the tool call throws', async () => {
      mockUtils.parseBody.mockResolvedValue({
        task: 'Run benchmark',
      });
      mockTools.handleToolCall.mockRejectedValue(new Error('tool crashed'));
      const res = createRes();

      await handlers.handleSubmitTask(createReq(), res, {}, createContext());

      expectFailure(res, 'Task submission failed: tool crashed', 500);
    });

    it('rejects when body parsing fails before submission starts', async () => {
      mockUtils.parseBody.mockRejectedValue(new Error('Invalid JSON body'));

      await expect(
        handlers.handleSubmitTask(createReq(), createRes(), {}, createContext()),
      ).rejects.toThrow('Invalid JSON body');
      expect(mockTools.handleToolCall).not.toHaveBeenCalled();
    });
  });

  describe('handleTaskDiff', () => {
    it('returns the stored diff preview when one exists', () => {
      mockDb.getDiffPreview.mockReturnValue({
        diff_content: '@@ -1 +1 @@',
        files_changed: 1,
        lines_added: 2,
        lines_removed: 1,
      });
      const res = createRes();

      handlers.handleTaskDiff(createReq(), res, {}, 'task-13');

      expect(mockDb.getDiffPreview).toHaveBeenCalledWith('task-13');
      expectSuccess(res, {
        diff_content: '@@ -1 +1 @@',
        files_changed: 1,
        lines_added: 2,
        lines_removed: 1,
      });
    });

    it('returns a null diff fallback when no preview exists', () => {
      const res = createRes();

      handlers.handleTaskDiff(createReq(), res, {}, 'task-13');

      expectSuccess(res, {
        diff_content: null,
        files_changed: 0,
        lines_added: 0,
        lines_removed: 0,
      });
    });
  });

  describe('handleTaskLogs', () => {
    it('returns task logs from the database', () => {
      mockDb.getTaskLogs.mockReturnValue([
        { level: 'info', message: 'started' },
        { level: 'error', message: 'failed' },
      ]);
      const res = createRes();

      handlers.handleTaskLogs(createReq(), res, {}, 'task-14');

      expect(mockDb.getTaskLogs).toHaveBeenCalledWith('task-14');
      expectSuccess(res, [
        { level: 'info', message: 'started' },
        { level: 'error', message: 'failed' },
      ]);
    });
  });
});
