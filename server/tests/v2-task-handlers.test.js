'use strict';

const eventBus = require('../event-bus');

const mockDb = {
  countTasks: vi.fn(),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getDefaultProvider: vi.fn(),
  getProvider: vi.fn(),
  getTask: vi.fn(),
  getTaskFileChanges: vi.fn(),
  listTasks: vi.fn(),
  updateTask: vi.fn(),
  updateTaskStatus: vi.fn(),
};

const mockConfig = {
  getInt: vi.fn(),
};

const mockUuidV4 = vi.fn();

const mockControlPlane = {
  sendSuccess: vi.fn(),
  sendError: vi.fn(),
  sendList: vi.fn(),
  resolveRequestId: vi.fn(),
  buildTaskResponse: vi.fn(),
  buildTaskDetailResponse: vi.fn(),
};

const mockMiddleware = {
  parseBody: vi.fn(),
};

const mockPipeline = {
  handleCommitTask: vi.fn(),
};

const mockTaskLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockLoggerModule = {
  child: vi.fn(() => mockTaskLogger),
};

const mockConstants = {
  PROVIDER_DEFAULT_TIMEOUTS: {
    codex: 45,
    ollama: 60,
  },
};

vi.mock('uuid', () => ({
  v4: mockUuidV4,
}));
vi.mock('../database', () => mockDb);
vi.mock('../db/task-core', () => mockDb);
vi.mock('../config', () => mockConfig);
vi.mock('../constants', () => mockConstants);
vi.mock('../api/v2-control-plane', () => mockControlPlane);
vi.mock('../api/middleware', () => mockMiddleware);
vi.mock('../handlers/task/pipeline', () => mockPipeline);
vi.mock('../logger', () => mockLoggerModule);

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadHandlers() {
  delete require.cache[require.resolve('../api/v2-task-handlers')];
  installCjsModuleMock('uuid', { v4: mockUuidV4 });
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../db/task-core', mockDb);
  installCjsModuleMock('../db/provider-routing-core', mockDb);
  installCjsModuleMock('../db/file-tracking', mockDb);
  installCjsModuleMock('../config', mockConfig);
  installCjsModuleMock('../constants', mockConstants);
  installCjsModuleMock('../api/v2-control-plane', mockControlPlane);
  installCjsModuleMock('../api/middleware', mockMiddleware);
  installCjsModuleMock('../handlers/task/pipeline', mockPipeline);
  installCjsModuleMock('../logger', mockLoggerModule);
  return require('../api/v2-task-handlers');
}

const mockTaskManager = {
  startTask: vi.fn(),
  cancelTask: vi.fn(),
  getTaskProgress: vi.fn(),
};

let handlers;

function parseJson(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function buildTaskSummary(task) {
  if (!task) return null;
  return {
    id: task.id,
    status: task.status,
    description: task.task_description || task.description || null,
    provider: task.provider || null,
    model: task.model || null,
    working_directory: task.working_directory || null,
    timeout_minutes: task.timeout_minutes ?? null,
    priority: task.priority || 0,
    auto_approve: Boolean(task.auto_approve),
    metadata: typeof task.metadata === 'string' ? parseJson(task.metadata) : (task.metadata || {}),
  };
}

function buildTaskDetail(task) {
  const base = buildTaskSummary(task);
  if (!base) return null;
  return {
    ...base,
    output: task.output || null,
    error_output: task.error_output || null,
  };
}

function createReq(overrides = {}) {
  return {
    params: {},
    query: {},
    requestId: 'req-123',
    headers: {},
    ...overrides,
  };
}

function createRes() {
  return {};
}

function getLastSuccess() {
  const [res, requestId, data, status, req] = mockControlPlane.sendSuccess.mock.calls.at(-1);
  return { res, requestId, data, status, req };
}

function getLastError() {
  const [res, requestId, code, message, status, details, req] = mockControlPlane.sendError.mock.calls.at(-1);
  return { res, requestId, code, message, status, details, req };
}

function getLastList() {
  const [res, requestId, items, total, req] = mockControlPlane.sendList.mock.calls.at(-1);
  return { res, requestId, items, total, req };
}

function resetMockDefaults() {
  mockDb.countTasks.mockReturnValue(0);
  mockDb.createTask.mockReturnValue(undefined);
  mockDb.getDefaultProvider.mockReturnValue('codex');
  mockDb.getProvider.mockReturnValue({ enabled: true });
  mockDb.getTask.mockReturnValue(null);
  mockDb.getTaskFileChanges.mockReturnValue([]);
  mockDb.listTasks.mockReturnValue([]);
  mockDb.updateTask.mockImplementation((id, fields) => ({
    id,
    ...fields,
  }));
  mockDb.updateTaskStatus.mockImplementation((id, status, fields = {}) => ({
    id,
    status,
    ...fields,
  }));

  mockConfig.getInt.mockImplementation((key, fallback) => fallback);

  mockUuidV4.mockReturnValue('generated-task-id');

  mockControlPlane.resolveRequestId.mockImplementation((req) => (
    req?.requestId || req?.headers?.['x-request-id'] || 'req-default'
  ));
  mockControlPlane.buildTaskResponse.mockImplementation(buildTaskSummary);
  mockControlPlane.buildTaskDetailResponse.mockImplementation(buildTaskDetail);

  mockMiddleware.parseBody.mockResolvedValue({});

  mockPipeline.handleCommitTask.mockReturnValue({
    isError: false,
    content: [{ text: 'Committed abcdef1' }],
  });

  mockTaskManager.startTask.mockReturnValue({ queued: false });
  mockTaskManager.cancelTask.mockReturnValue(undefined);
  mockTaskManager.getTaskProgress.mockReturnValue(null);

  mockDb.deleteTask.mockReturnValue(undefined);
  mockLoggerModule.child.mockReturnValue(mockTaskLogger);
}

beforeEach(() => {
  vi.resetAllMocks();
  resetMockDefaults();
  handlers = loadHandlers();
  handlers.init(mockTaskManager);
});

describe('api/v2-task-handlers.handleSubmitTask', () => {
  it('returns 201 and task data for a valid submission', async () => {
    const emitTaskUpdatedSpy = vi.spyOn(eventBus, 'emitTaskUpdated');
    const res = createRes();
    const req = createReq({
      body: {
        task: '  Run lint  ',
        working_directory: '/repo',
        model: 'gpt-5',
        auto_approve: true,
        priority: 3,
      },
    });

    mockUuidV4.mockReturnValueOnce('submit-task-1');
    mockDb.getTask.mockReturnValue({
      id: 'submit-task-1',
      status: 'running',
      task_description: 'Run lint',
      working_directory: '/repo',
      timeout_minutes: 45,
      auto_approve: true,
      priority: 3,
      provider: 'codex',
      model: 'gpt-5',
      metadata: '{}',
    });

    try {
      await handlers.handleSubmitTask(req, res);

      expect(mockDb.createTask).toHaveBeenCalledWith(expect.objectContaining({
        id: 'submit-task-1',
        status: 'pending',
        task_description: 'Run lint',
        working_directory: '/repo',
        timeout_minutes: 45,
        auto_approve: true,
        priority: 3,
        provider: null,
        model: 'gpt-5',
        metadata: '{"intended_provider":"codex"}',
      }));
      expect(mockTaskManager.startTask).toHaveBeenCalledWith('submit-task-1');
      expect(emitTaskUpdatedSpy).toHaveBeenCalledWith({
        taskId: 'submit-task-1',
        status: 'running',
      });

      expect(getLastSuccess()).toEqual({
        res,
        requestId: 'req-123',
        data: expect.objectContaining({
          task_id: 'submit-task-1',
          id: 'submit-task-1',
          status: 'running',
          provider: 'codex',
          model: 'gpt-5',
        }),
        status: 201,
        req,
      });
      expect(mockMiddleware.parseBody).not.toHaveBeenCalled();
    } finally {
      emitTaskUpdatedSpy.mockRestore();
    }
  });

  it('parses the request body when req.body is missing', async () => {
    const res = createRes();
    const req = createReq();

    mockUuidV4.mockReturnValueOnce('submit-task-2');
    mockMiddleware.parseBody.mockResolvedValue({
      description: 'Parsed body task',
      provider: 'ollama',
    });
    mockTaskManager.startTask.mockReturnValue({ queued: true });
    mockDb.getTask.mockReturnValue({
      id: 'submit-task-2',
      status: 'queued',
      task_description: 'Parsed body task',
      provider: 'ollama',
      model: null,
      timeout_minutes: 60,
      metadata: '{"user_provider_override":true}',
    });

    await handlers.handleSubmitTask(req, res);

    expect(mockMiddleware.parseBody).toHaveBeenCalledWith(req);
    expect(mockDb.createTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'submit-task-2',
      task_description: 'Parsed body task',
      provider: null,
      timeout_minutes: 60,
      metadata: '{"user_provider_override":true,"requested_provider":"ollama","intended_provider":"ollama"}',
    }));
    expect(getLastSuccess()).toEqual({
      res,
      requestId: 'req-123',
      data: expect.objectContaining({
        task_id: 'submit-task-2',
        id: 'submit-task-2',
        status: 'queued',
        provider: 'ollama',
        metadata: { user_provider_override: true },
      }),
      status: 201,
      req,
    });
  });

  it('returns 400 when the task description is missing', async () => {
    await handlers.handleSubmitTask(createReq({ body: { task: '   ' } }), createRes());

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'validation_error',
      message: 'task or description is required',
      status: 400,
      details: undefined,
      req: undefined,
    });
    expect(mockDb.createTask).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown provider override', async () => {
    mockDb.getProvider.mockReturnValue(null);

    await handlers.handleSubmitTask(
      createReq({ body: { task: 'Run tests', provider: 'missing-provider' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'provider_not_found',
      message: 'Unknown provider: missing-provider',
      status: 404,
      details: undefined,
      req: undefined,
    });
  });

  it('returns 400 for a disabled provider override', async () => {
    mockDb.getProvider.mockReturnValue({ enabled: false });

    await handlers.handleSubmitTask(
      createReq({ body: { task: 'Run tests', provider: 'ollama' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'provider_unavailable',
      message: 'Provider ollama is disabled',
      status: 400,
      details: undefined,
      req: undefined,
    });
  });

  it('returns 500 when task creation throws', async () => {
    mockDb.createTask.mockImplementation(() => {
      throw new Error('insert failed');
    });

    await handlers.handleSubmitTask(
      createReq({ body: { task: 'Run tests' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'operation_failed',
      message: 'insert failed',
      status: 500,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });
});

describe('api/v2-task-handlers.handleListTasks', () => {
  it('returns a list response with an items array', async () => {
    const req = createReq();
    const res = createRes();

    mockDb.countTasks.mockReturnValue(2);
    mockDb.listTasks.mockReturnValue([
      { id: 'task-1', status: 'running', task_description: 'First', provider: 'codex' },
      { id: 'task-2', status: 'queued', task_description: 'Second', provider: 'ollama' },
    ]);

    await handlers.handleListTasks(req, res);

    expect(mockDb.listTasks).toHaveBeenCalledWith({
      limit: 20,
      offset: 0,
    });
    expect(mockDb.countTasks).toHaveBeenCalledWith({});
    expect(getLastList()).toEqual({
      res,
      requestId: 'req-123',
      items: [
        expect.objectContaining({ id: 'task-1', description: 'First' }),
        expect.objectContaining({ id: 'task-2', description: 'Second' }),
      ],
      total: 2,
      req,
    });
  });

  it('passes the limit query parameter through to the db listing call', async () => {
    const req = createReq({ query: { limit: '2' } });

    mockDb.listTasks.mockReturnValue([
      { id: 'task-1', status: 'running', task_description: 'One' },
      { id: 'task-2', status: 'queued', task_description: 'Two' },
      { id: 'task-3', status: 'failed', task_description: 'Three' },
    ]);

    await handlers.handleListTasks(req, createRes());

    expect(mockDb.listTasks).toHaveBeenCalledWith({
      limit: 2,
      offset: 0,
    });
    expect(getLastList().items).toHaveLength(3);
    expect(getLastList().items.map((item) => item.id)).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('maps dashboard query params to db filters and uses countTasks for total', async () => {
    const req = createReq({
      query: {
        page: '2',
        limit: '25',
        provider: 'codex',
        search: 'lint',
        tags: 'ui, perf',
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-03-05T00:00:00.000Z',
        orderBy: 'created_at',
        orderDir: 'desc',
      },
    });

    mockDb.countTasks.mockReturnValue(47);
    mockDb.listTasks.mockReturnValue([
      { id: 'task-26', status: 'running', task_description: 'Run lint' },
    ]);

    await handlers.handleListTasks(req, createRes());

    expect(mockDb.listTasks).toHaveBeenCalledWith({
      provider: 'codex',
      search: 'lint',
      tags: ['ui', 'perf'],
      from_date: '2026-03-01T00:00:00.000Z',
      to_date: '2026-03-05T00:00:00.000Z',
      orderBy: 'created_at',
      orderDir: 'desc',
      limit: 25,
      offset: 25,
    });
    expect(mockDb.countTasks).toHaveBeenCalledWith({
      provider: 'codex',
      search: 'lint',
      tags: ['ui', 'perf'],
      from_date: '2026-03-01T00:00:00.000Z',
      to_date: '2026-03-05T00:00:00.000Z',
      orderBy: 'created_at',
      orderDir: 'desc',
    });
    expect(getLastList().total).toBe(47);
  });

  it('rejects invalid orderBy values before querying the database', async () => {
    const res = createRes();
    const req = createReq({
      query: {
        orderBy: 'created_at; DROP TABLE tasks; --',
      },
    });

    await handlers.handleListTasks(req, res);

    expect(mockDb.listTasks).not.toHaveBeenCalled();
    expect(getLastError()).toEqual({
      res,
      requestId: 'req-123',
      code: 'validation_error',
      message: 'Invalid orderBy column',
      status: 400,
      details: undefined,
      req,
    });
  });

  it('rejects invalid orderDir values before querying the database', async () => {
    const res = createRes();
    const req = createReq({
      query: {
        orderDir: 'descending',
      },
    });

    await handlers.handleListTasks(req, res);

    expect(mockDb.listTasks).not.toHaveBeenCalled();
    expect(getLastError()).toEqual({
      res,
      requestId: 'req-123',
      code: 'validation_error',
      message: 'Invalid orderDir',
      status: 400,
      details: undefined,
      req,
    });
  });

  it('treats archived status like the legacy dashboard route', async () => {
    const req = createReq({ query: { status: 'archived', offset: '40', limit: '10' } });

    await handlers.handleListTasks(req, createRes());

    expect(mockDb.listTasks).toHaveBeenCalledWith({
      archivedOnly: true,
      limit: 10,
      offset: 40,
    });
    expect(mockDb.countTasks).toHaveBeenCalledWith({
      archivedOnly: true,
    });
  });
});

describe('api/v2-task-handlers.handleGetTask', () => {
  it('returns task detail including output and error_output', async () => {
    const task = {
      id: 'task-1',
      status: 'failed',
      task_description: 'Inspect task',
      provider: 'codex',
      output: 'stdout',
      error_output: 'stderr',
      metadata: '{}',
    };

    mockDb.getTask.mockReturnValue(task);

    await handlers.handleGetTask(
      createReq({ params: { task_id: 'task-1' } }),
      createRes(),
    );

    expect(mockControlPlane.buildTaskDetailResponse).toHaveBeenCalledWith(task);
    expect(getLastSuccess().data).toEqual(expect.objectContaining({
      id: 'task-1',
      output: 'stdout',
      error_output: 'stderr',
    }));
  });

  it('returns 404 when the task is missing', async () => {
    await handlers.handleGetTask(
      createReq({ params: { task_id: 'missing-task' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'task_not_found',
      message: 'Task not found: missing-task',
      status: 404,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('returns 400 for ambiguous task ids', async () => {
    mockDb.getTask.mockImplementation(() => {
      throw new Error('Ambiguous task ID: task');
    });

    await handlers.handleGetTask(
      createReq({ params: { task_id: 'task' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'validation_error',
      message: 'Ambiguous task ID: task',
      status: 400,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });
});

describe('api/v2-task-handlers.handleCancelTask', () => {
  it('cancels a running task', async () => {
    const req = createReq({
      params: { task_id: 'task-running' },
      body: { reason: 'Stop now' },
    });
    const res = createRes();

    mockDb.getTask
      .mockReturnValueOnce({ id: 'task-running', status: 'running' })
      .mockReturnValueOnce({ id: 'task-running', status: 'cancelled' });

    await handlers.handleCancelTask(req, res);

    expect(mockTaskManager.cancelTask).toHaveBeenCalledWith('task-running', 'Stop now');
    expect(getLastSuccess()).toEqual({
      res,
      requestId: 'req-123',
      data: {
        task_id: 'task-running',
        cancelled: true,
        status: 'cancelled',
      },
      status: 200,
      req,
    });
  });

  it('returns cancelled=false for a terminal task', async () => {
    mockDb.getTask.mockReturnValue({ id: 'task-complete', status: 'completed' });

    await handlers.handleCancelTask(
      createReq({ params: { task_id: 'task-complete' } }),
      createRes(),
    );

    expect(mockTaskManager.cancelTask).not.toHaveBeenCalled();
    expect(getLastSuccess().data).toEqual({
      task_id: 'task-complete',
      cancelled: false,
      status: 'completed',
      reason: 'Task already in terminal state',
    });
  });

  it('returns 404 when cancelling a missing task', async () => {
    await handlers.handleCancelTask(
      createReq({ params: { task_id: 'missing-task' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'task_not_found',
      message: 'Task not found: missing-task',
      status: 404,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });
});

describe('api/v2-task-handlers.handleRetryTask', () => {
  it('creates a new task from a failed task', async () => {
    const emitTaskUpdatedSpy = vi.spyOn(eventBus, 'emitTaskUpdated');
    const req = createReq({ params: { task_id: 'failed-task' } });
    const res = createRes();

    mockUuidV4.mockReturnValueOnce('retry-task-1');
    mockTaskManager.startTask.mockReturnValue({ queued: true });
    mockDb.getTask
      .mockReturnValueOnce({
        id: 'failed-task',
        status: 'failed',
        task_description: 'Retry me',
        working_directory: '/repo',
        timeout_minutes: 20,
        auto_approve: true,
        priority: 2,
        provider: 'codex',
        model: 'gpt-5',
      })
      .mockReturnValueOnce({
        id: 'retry-task-1',
        status: 'queued',
        task_description: 'Retry me',
        working_directory: '/repo',
        timeout_minutes: 20,
        auto_approve: true,
        priority: 2,
        provider: 'codex',
        model: 'gpt-5',
        metadata: '{"retry_of":"failed-task"}',
      });

    try {
      await handlers.handleRetryTask(req, res);

      expect(mockDb.createTask).toHaveBeenCalledWith({
        id: 'retry-task-1',
        status: 'pending',
        task_description: 'Retry me',
        working_directory: '/repo',
        timeout_minutes: 20,
        auto_approve: true,
        priority: 2,
        provider: null,
        model: 'gpt-5',
        // Smart-routed tasks (no user_provider_override) get intended_provider: null
        // so routing re-evaluates on retry
        metadata: '{"retry_of":"failed-task","intended_provider":null}',
      });
      expect(mockTaskManager.startTask).toHaveBeenCalledWith('retry-task-1');
      expect(emitTaskUpdatedSpy).toHaveBeenCalledWith({
        taskId: 'retry-task-1',
        status: 'queued',
      });
      expect(getLastSuccess()).toEqual({
        res,
        requestId: 'req-123',
        data: expect.objectContaining({
          task_id: 'retry-task-1',
          original_task_id: 'failed-task',
          id: 'retry-task-1',
          status: 'queued',
        }),
        status: 201,
        req,
      });
    } finally {
      emitTaskUpdatedSpy.mockRestore();
    }
  });

  it('returns 400 for a non-retryable task status', async () => {
    mockDb.getTask.mockReturnValue({
      id: 'task-complete',
      status: 'completed',
    });

    await handlers.handleRetryTask(
      createReq({ params: { task_id: 'task-complete' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'invalid_status',
      message: 'Cannot retry task with status: completed',
      status: 400,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('returns 404 when retrying a missing task', async () => {
    await handlers.handleRetryTask(
      createReq({ params: { task_id: 'missing-task' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'task_not_found',
      message: 'Task not found: missing-task',
      status: 404,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('returns 400 when retrying a task with an unknown stored provider', async () => {
    // user_provider_override: true means this was explicitly user-chosen, so we
    // validate the stored provider and reject if it's unknown
    mockDb.getTask.mockReturnValue({
      id: 'failed-task',
      status: 'failed',
      task_description: 'Retry me',
      provider: 'missing-provider',
      metadata: { user_provider_override: true },
    });
    mockDb.getProvider.mockReturnValue(null);

    await handlers.handleRetryTask(
      createReq({ params: { task_id: 'failed-task' } }),
      createRes(),
    );

    expect(mockDb.createTask).not.toHaveBeenCalled();
    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'provider_not_found',
      message: 'Unknown provider: missing-provider',
      status: 400,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });
});

describe('api/v2-task-handlers.handleReassignTaskProvider', () => {
  it('successfully reassigns a queued task provider and marks it as user-overridden', async () => {
    const req = createReq({
      params: { task_id: 'task-queued' },
      body: { provider: 'ollama' },
    });
    const res = createRes();

    mockDb.getTask.mockReturnValue({
      id: 'task-queued',
      status: 'queued',
      task_description: 'Queued task',
      provider: 'codex',
      metadata: '{"existing":"value"}',
    });
    mockDb.updateTask.mockReturnValue({
      id: 'task-queued',
      status: 'queued',
      task_description: 'Queued task',
      provider: 'ollama',
      metadata: '{"existing":"value","user_provider_override":true}',
    });

    await handlers.handleReassignTaskProvider(req, res);

    expect(mockDb.getProvider).toHaveBeenCalledWith('ollama');
    expect(mockDb.updateTask).toHaveBeenCalledWith('task-queued', {
      provider: 'ollama',
      metadata: {
        existing: 'value',
        user_provider_override: true,
      },
      model: null,
      ollama_host_id: null,
    });
    expect(mockTaskLogger.info).toHaveBeenCalledWith(
      'Reassigned queued task task-queued provider from codex to ollama',
    );
    expect(getLastSuccess()).toEqual({
      res,
      requestId: 'req-123',
      data: {
        id: 'task-queued',
        status: 'queued',
        description: 'Queued task',
        provider: 'ollama',
        model: null,
        working_directory: null,
        timeout_minutes: null,
        priority: 0,
        auto_approve: false,
        metadata: {
          existing: 'value',
          user_provider_override: true,
        },
        output: null,
        error_output: null,
      },
      status: 200,
      req,
    });
  });

  it('returns 400 when reassigning to a disabled provider', async () => {
    mockDb.getTask.mockReturnValue({
      id: 'task-queued',
      status: 'queued',
      provider: 'codex',
      metadata: '{}',
    });
    mockDb.getProvider.mockReturnValue({ enabled: false });

    await handlers.handleReassignTaskProvider(
      createReq({
        params: { task_id: 'task-queued' },
        body: { provider: 'ollama' },
      }),
      createRes(),
    );

    expect(mockDb.updateTask).not.toHaveBeenCalled();
    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'provider_unavailable',
      message: 'Provider is currently disabled',
      status: 400,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('emits queue processing and task updates after a successful reassignment', async () => {
    const emitQueueChangedSpy = vi.spyOn(eventBus, 'emitQueueChanged');
    const emitTaskUpdatedSpy = vi.spyOn(eventBus, 'emitTaskUpdated');
    try {
      mockDb.getTask.mockReturnValue({
        id: 'task-queued',
        status: 'queued',
        provider: 'codex',
        metadata: '{}',
      });
      mockDb.updateTask.mockReturnValue({
        id: 'task-queued',
        status: 'queued',
        provider: 'ollama',
        metadata: '{"user_provider_override":true}',
      });

      await handlers.handleReassignTaskProvider(
        createReq({
          params: { task_id: 'task-queued' },
          body: { provider: 'ollama' },
        }),
        createRes(),
      );

      expect(mockDb.updateTask).toHaveBeenCalled();
      expect(emitQueueChangedSpy).toHaveBeenCalled();
      expect(emitTaskUpdatedSpy).toHaveBeenCalledWith({
        taskId: 'task-queued',
        status: 'queued',
      });
      expect(mockDb.updateTask.mock.invocationCallOrder[0]).toBeLessThan(emitQueueChangedSpy.mock.invocationCallOrder[0]);
    } finally {
      emitQueueChangedSpy.mockRestore();
      emitTaskUpdatedSpy.mockRestore();
    }
  });

  it.each(['running', 'completed', 'failed'])('returns 409 for a %s task', async (status) => {
    mockDb.getTask.mockReturnValue({
      id: `task-${status}`,
      status,
      provider: 'codex',
      metadata: '{}',
    });

    await handlers.handleReassignTaskProvider(
      createReq({
        params: { task_id: `task-${status}` },
        body: { provider: 'ollama' },
      }),
      createRes(),
    );

    expect(mockDb.updateTask).not.toHaveBeenCalled();
    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'invalid_status',
      message: `Cannot reassign provider for task with status: ${status}`,
      status: 409,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('returns 400 for an unknown provider', async () => {
    mockDb.getTask.mockReturnValue({
      id: 'task-queued',
      status: 'queued',
      provider: 'codex',
      metadata: '{}',
    });
    mockDb.getProvider.mockReturnValue(null);

    await handlers.handleReassignTaskProvider(
      createReq({
        params: { task_id: 'task-queued' },
        body: { provider: 'missing-provider' },
      }),
      createRes(),
    );

    expect(mockDb.updateTask).not.toHaveBeenCalled();
    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'provider_not_found',
      message: 'Unknown provider: missing-provider',
      status: 400,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('preserves existing metadata while setting user_provider_override', async () => {
    mockDb.getTask.mockReturnValue({
      id: 'task-queued',
      status: 'queued',
      provider: 'codex',
      metadata: {
        retry_of: 'task-original',
        custom_flag: true,
      },
    });
    mockDb.updateTask.mockReturnValue({
      id: 'task-queued',
      status: 'queued',
      provider: 'codex',
      metadata: {
        retry_of: 'task-original',
        custom_flag: true,
        user_provider_override: true,
      },
    });

    await handlers.handleReassignTaskProvider(
      createReq({
        params: { task_id: 'task-queued' },
        body: { provider: 'codex' },
      }),
      createRes(),
    );

    expect(mockDb.updateTask).toHaveBeenCalledWith('task-queued', {
      provider: 'codex',
      metadata: {
        retry_of: 'task-original',
        custom_flag: true,
        user_provider_override: true,
      },
      ollama_host_id: null,
    });
    expect(getLastSuccess().data.metadata).toEqual({
      retry_of: 'task-original',
      custom_flag: true,
      user_provider_override: true,
    });
  });
});

describe('api/v2-task-handlers.handleCommitTask', () => {
  it('commits a completed task and extracts the commit sha', async () => {
    const req = createReq({
      params: { task_id: 'task-commit' },
      body: { message: 'ship it', auto_push: true },
    });
    const res = createRes();

    mockDb.getTask.mockReturnValue({ id: 'task-commit', status: 'completed' });
    mockPipeline.handleCommitTask.mockReturnValue({
      isError: false,
      content: [{ text: 'Committed as abcdef1234567890' }],
    });

    await handlers.handleCommitTask(req, res);

    expect(mockPipeline.handleCommitTask).toHaveBeenCalledWith({
      task_id: 'task-commit',
      message: 'ship it',
      auto_push: true,
    });
    expect(getLastSuccess()).toEqual({
      res,
      requestId: 'req-123',
      data: {
        task_id: 'task-commit',
        committed: true,
        sha: 'abcdef1234567890',
        message: 'Committed as abcdef1234567890',
      },
      status: 200,
      req,
    });
  });

  it('returns committed=false when the pipeline handler reports an error', async () => {
    mockDb.getTask.mockReturnValue({ id: 'task-commit', status: 'completed' });
    mockPipeline.handleCommitTask.mockReturnValue({
      isError: true,
      content: [{ text: 'Commit failed due to conflict' }],
    });

    await handlers.handleCommitTask(
      createReq({ params: { task_id: 'task-commit' } }),
      createRes(),
    );

    expect(getLastSuccess().data).toEqual({
      task_id: 'task-commit',
      committed: false,
      sha: null,
      message: 'Commit failed due to conflict',
    });
  });

  it('returns 400 for a non-completed task', async () => {
    mockDb.getTask.mockReturnValue({ id: 'task-running', status: 'running' });

    await handlers.handleCommitTask(
      createReq({ params: { task_id: 'task-running' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'invalid_status',
      message: 'Cannot commit task with status: running',
      status: 400,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('returns 404 when committing a missing task', async () => {
    await handlers.handleCommitTask(
      createReq({ params: { task_id: 'missing-task' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'task_not_found',
      message: 'Task not found: missing-task',
      status: 404,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });
});

describe('api/v2-task-handlers.handleTaskDiff', () => {
  it('returns a normalized file changes array', async () => {
    const req = createReq({ params: { task_id: 'task-diff' } });
    const res = createRes();

    mockDb.getTask.mockReturnValue({ id: 'task-diff', status: 'completed' });
    mockDb.getTaskFileChanges.mockReturnValue([
      {
        file_path: 'src/new.js',
        change_type: 'added',
        lines_added: 10,
        lines_removed: 0,
      },
      {
        file: 'src/old.js',
        action: 'deleted',
        lines_removed: 4,
      },
    ]);

    await handlers.handleTaskDiff(req, res);

    expect(getLastSuccess()).toEqual({
      res,
      requestId: 'req-123',
      data: {
        task_id: 'task-diff',
        files_changed: 2,
        changes: [
          { file: 'src/new.js', action: 'added', lines_added: 10, lines_removed: 0 },
          { file: 'src/old.js', action: 'deleted', lines_added: 0, lines_removed: 4 },
        ],
      },
      status: 200,
      req,
    });
  });

  it('returns 404 when diff is requested for a missing task', async () => {
    await handlers.handleTaskDiff(
      createReq({ params: { task_id: 'missing-task' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'task_not_found',
      message: 'Task not found: missing-task',
      status: 404,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });
});

describe('api/v2-task-handlers.handleTaskLogs', () => {
  it('returns task output and error_output', async () => {
    const req = createReq({ params: { task_id: 'task-logs' } });
    const res = createRes();

    mockDb.getTask.mockReturnValue({
      id: 'task-logs',
      status: 'failed',
      output: 'stdout',
      error_output: 'stderr',
    });

    await handlers.handleTaskLogs(req, res);

    expect(getLastSuccess()).toEqual({
      res,
      requestId: 'req-123',
      data: {
        task_id: 'task-logs',
        status: 'failed',
        output: 'stdout',
        error_output: 'stderr',
      },
      status: 200,
      req,
    });
  });

  it('returns 404 when logs are requested for a missing task', async () => {
    await handlers.handleTaskLogs(
      createReq({ params: { task_id: 'missing-task' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'task_not_found',
      message: 'Task not found: missing-task',
      status: 404,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });
});

describe('api/v2-task-handlers.handleTaskProgress', () => {
  it('returns progress data for a running task', async () => {
    const req = createReq({ params: { task_id: 'task-progress' } });
    const res = createRes();

    mockTaskManager.getTaskProgress.mockReturnValue({
      status: 'running',
      progress: 67,
      phase: 'execute',
      elapsed_seconds: 12,
      output_length: 1024,
      last_output_at: '2026-03-10T18:00:00.000Z',
    });

    await handlers.handleTaskProgress(req, res);

    expect(getLastSuccess()).toEqual({
      res,
      requestId: 'req-123',
      data: {
        task_id: 'task-progress',
        status: 'running',
        progress_percent: 67,
        phase: 'execute',
        elapsed_seconds: 12,
        output_bytes: 1024,
        last_output_at: '2026-03-10T18:00:00.000Z',
      },
      status: 200,
      req,
    });
  });

  it('returns 404 when no progress is available', async () => {
    await handlers.handleTaskProgress(
      createReq({ params: { task_id: 'missing-task' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'task_not_found',
      message: 'Task not found or not running: missing-task',
      status: 404,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('returns 500 when the task manager has not been initialized', async () => {
    handlers.init(null);

    await handlers.handleTaskProgress(
      createReq({ params: { task_id: 'task-progress' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'not_initialized',
      message: 'Task manager not initialized',
      status: 500,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });
});

describe('api/v2-task-handlers.handleDeleteTask', () => {
  it('returns 404 for a non-existent task', async () => {
    await handlers.handleDeleteTask(
      createReq({ params: { task_id: 'missing-task' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'task_not_found',
      message: 'Task not found: missing-task',
      status: 404,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('returns 400 when trying to delete a running task', async () => {
    mockDb.getTask.mockReturnValue({ id: 'task-running', status: 'running' });

    await handlers.handleDeleteTask(
      createReq({ params: { task_id: 'task-running' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'invalid_status',
      message: 'Cannot delete task with status: running. Cancel it first.',
      status: 400,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
    expect(mockDb.deleteTask).not.toHaveBeenCalled();
  });

  it('returns 400 when trying to delete a queued task', async () => {
    mockDb.getTask.mockReturnValue({ id: 'task-queued', status: 'queued' });

    await handlers.handleDeleteTask(
      createReq({ params: { task_id: 'task-queued' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'invalid_status',
      message: 'Cannot delete task with status: queued. Cancel it first.',
      status: 400,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
    expect(mockDb.deleteTask).not.toHaveBeenCalled();
  });

  it('successfully deletes a completed task', async () => {
    const req = createReq({ params: { task_id: 'task-done' } });
    const res = createRes();

    mockDb.getTask.mockReturnValue({ id: 'task-done', status: 'completed' });

    await handlers.handleDeleteTask(req, res);

    expect(mockDb.deleteTask).toHaveBeenCalledWith('task-done');
    expect(getLastSuccess()).toEqual({
      res,
      requestId: 'req-123',
      data: { task_id: 'task-done', deleted: true },
      status: 200,
      req,
    });
  });

  it('successfully deletes a failed task', async () => {
    mockDb.getTask.mockReturnValue({ id: 'task-failed', status: 'failed' });

    await handlers.handleDeleteTask(
      createReq({ params: { task_id: 'task-failed' } }),
      createRes(),
    );

    expect(mockDb.deleteTask).toHaveBeenCalledWith('task-failed');
    expect(getLastSuccess().data).toEqual({ task_id: 'task-failed', deleted: true });
  });

  it('successfully deletes a cancelled task', async () => {
    mockDb.getTask.mockReturnValue({ id: 'task-cancelled', status: 'cancelled' });

    await handlers.handleDeleteTask(
      createReq({ params: { task_id: 'task-cancelled' } }),
      createRes(),
    );

    expect(mockDb.deleteTask).toHaveBeenCalledWith('task-cancelled');
    expect(getLastSuccess().data).toEqual({ task_id: 'task-cancelled', deleted: true });
  });
});

describe('api/v2-task-handlers.handleApproveSwitch', () => {
  it('returns 404 for a non-existent task', async () => {
    await handlers.handleApproveSwitch(
      createReq({ params: { task_id: 'missing-task' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'task_not_found',
      message: 'Task not found: missing-task',
      status: 404,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('returns 409 when the task is not pending a provider switch', async () => {
    mockDb.getTask.mockReturnValue({ id: 'task-switch', status: 'running', provider: 'codex' });

    await handlers.handleApproveSwitch(
      createReq({ params: { task_id: 'task-switch' } }),
      createRes(),
    );

    expect(mockDb.updateTask).not.toHaveBeenCalled();
    expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'invalid_status',
      message: 'Cannot approve provider switch for task with status: running',
      status: 409,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('returns 400 when the pending switch has no target provider metadata', async () => {
    mockDb.getTask.mockReturnValue({
      id: 'task-switch',
      status: 'pending_provider_switch',
      provider: 'codex',
      metadata: {},
    });

    await handlers.handleApproveSwitch(
      createReq({ params: { task_id: 'task-switch' } }),
      createRes(),
    );

    expect(mockDb.updateTask).not.toHaveBeenCalled();
    expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'validation_error',
      message: 'Pending provider switch is missing a target provider',
      status: 400,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('queues the task with the metadata target provider and emits dashboard updates', async () => {
    const req = createReq({ params: { task_id: 'task-switch' } });
    const res = createRes();
    const emitQueueChangedSpy = vi.spyOn(eventBus, 'emitQueueChanged');
    const emitTaskUpdatedSpy = vi.spyOn(eventBus, 'emitTaskUpdated');

    const task = {
      id: 'task-switch',
      status: 'pending_provider_switch',
      provider: 'codex',
      task_description: 'Switch providers',
      retry_count: 1,
      metadata: {
        target_provider: 'ollama',
        original_provider: 'codex',
      },
    };
    const updatedMetadata = {
      target_provider: 'ollama',
      user_provider_override: true,
    };
    mockDb.getTask.mockReturnValue(task);
    mockDb.updateTask.mockReturnValue({
      ...task,
      status: 'queued',
      provider: 'ollama',
      metadata: updatedMetadata,
    });

    try {
      await handlers.handleApproveSwitch(req, res);

      expect(mockDb.updateTask).toHaveBeenCalledWith('task-switch', {
        status: 'queued',
        provider: 'ollama',
        metadata: updatedMetadata,
        started_at: null,
        completed_at: null,
        exit_code: null,
        pid: null,
        progress_percent: 0,
        model: null,
        ollama_host_id: null,
      });
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(emitQueueChangedSpy).toHaveBeenCalled();
      expect(emitTaskUpdatedSpy).toHaveBeenCalledWith({
        taskId: 'task-switch',
        status: 'queued',
      });
      expect(getLastSuccess()).toEqual({
        res,
        requestId: 'req-123',
        data: buildTaskDetail({ ...task, status: 'queued', provider: 'ollama', metadata: updatedMetadata }),
        status: 200,
        req,
      });
    } finally {
      emitQueueChangedSpy.mockRestore();
      emitTaskUpdatedSpy.mockRestore();
    }
  });

  it('falls back to updateTaskStatus when updateTask rejects status changes (production path)', async () => {
    const req = createReq({ params: { task_id: 'task-switch-prod' } });
    const res = createRes();
    const emitQueueChangedSpy = vi.spyOn(eventBus, 'emitQueueChanged');

    const task = {
      id: 'task-switch-prod',
      status: 'pending_provider_switch',
      provider: 'codex',
      task_description: 'Switch providers via production path',
      retry_count: 0,
      metadata: {
        provider_switch_target: 'ollama',
      },
    };
    const expectedMetadata = {
      provider_switch_target: 'ollama',
      user_provider_override: true,
    };
    mockDb.getTask.mockReturnValue(task);
    // Production: updateTask throws because it rejects status changes
    mockDb.updateTask.mockImplementation(() => {
      throw new Error('Use updateTaskStatus() to modify task status');
    });
    mockDb.updateTaskStatus.mockReturnValue({
      ...task,
      status: 'queued',
      provider: 'ollama',
      metadata: expectedMetadata,
    });

    try {
      await handlers.handleApproveSwitch(req, res);

      expect(mockDb.updateTask).toHaveBeenCalled();
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-switch-prod', 'queued', {
        provider: 'ollama',
        metadata: expectedMetadata,
        started_at: null,
        completed_at: null,
        exit_code: null,
        pid: null,
        progress_percent: 0,
        model: null,
        ollama_host_id: null,
      });
      expect(emitQueueChangedSpy).toHaveBeenCalled();
      expect(getLastSuccess()).toMatchObject({
        status: 200,
      });
    } finally {
      emitQueueChangedSpy.mockRestore();
    }
  });
});

describe('api/v2-task-handlers.handleRejectSwitch', () => {
  it('returns 404 for a non-existent task', async () => {
    await handlers.handleRejectSwitch(
      createReq({ params: { task_id: 'missing-task' } }),
      createRes(),
    );

    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'task_not_found',
      message: 'Task not found: missing-task',
      status: 404,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('returns 409 when the task is not pending a provider switch', async () => {
    mockDb.getTask.mockReturnValue({ id: 'task-reject', status: 'completed', provider: 'ollama' });

    await handlers.handleRejectSwitch(
      createReq({ params: { task_id: 'task-reject' } }),
      createRes(),
    );

    expect(mockDb.updateTask).not.toHaveBeenCalled();
    expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'invalid_status',
      message: 'Cannot reject provider switch for task with status: completed',
      status: 409,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('returns 400 when the pending switch has no original provider metadata', async () => {
    mockDb.getTask.mockReturnValue({
      id: 'task-reject',
      status: 'pending_provider_switch',
      provider: null,
      original_provider: null,
      metadata: {},
    });

    await handlers.handleRejectSwitch(
      createReq({ params: { task_id: 'task-reject' } }),
      createRes(),
    );

    expect(mockDb.updateTask).not.toHaveBeenCalled();
    expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'validation_error',
      message: 'Pending provider switch is missing an original provider',
      status: 400,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('returns 400 when the fallback original provider is unknown', async () => {
    mockDb.getTask.mockReturnValue({
      id: 'task-reject',
      status: 'pending_provider_switch',
      provider: '   ',
      metadata: {
        original_provider: 'missing-provider',
      },
    });
    mockDb.getProvider.mockReturnValue(null);

    await handlers.handleRejectSwitch(
      createReq({ params: { task_id: 'task-reject' } }),
      createRes(),
    );

    expect(mockDb.updateTask).not.toHaveBeenCalled();
    expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    expect(getLastError()).toEqual({
      res: expect.any(Object),
      requestId: 'req-123',
      code: 'provider_not_found',
      message: 'Unknown provider: missing-provider',
      status: 400,
      details: {},
      req: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('queues the task with task.provider when metadata.original_provider is stale and emits dashboard updates', async () => {
    const req = createReq({ params: { task_id: 'task-reject' } });
    const res = createRes();
    const emitQueueChangedSpy = vi.spyOn(eventBus, 'emitQueueChanged');
    const emitTaskUpdatedSpy = vi.spyOn(eventBus, 'emitTaskUpdated');

    const task = {
      id: 'task-reject',
      status: 'pending_provider_switch',
      provider: 'ollama',
      task_description: 'Reject provider switch',
      retry_count: 2,
      metadata: {
        original_provider: 'codex',
        quota_overflow: true,
        retained_flag: 'keep-me',
      },
    };
    const updatedMetadata = {
      retained_flag: 'keep-me',
    };
    mockDb.getTask.mockReturnValue(task);
    mockDb.updateTask.mockReturnValue({
      ...task,
      status: 'queued',
      provider: 'ollama',
      metadata: updatedMetadata,
    });

    try {
      await handlers.handleRejectSwitch(req, res);

      expect(mockDb.updateTask).toHaveBeenCalledWith('task-reject', {
        status: 'queued',
        provider: 'ollama',
        metadata: updatedMetadata,
        started_at: null,
        completed_at: null,
        exit_code: null,
        pid: null,
        progress_percent: 0,
      });
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(emitQueueChangedSpy).toHaveBeenCalled();
      expect(emitTaskUpdatedSpy).toHaveBeenCalledWith({
        taskId: 'task-reject',
        status: 'queued',
      });
      expect(getLastSuccess()).toEqual({
        res,
        requestId: 'req-123',
        data: buildTaskDetail({ ...task, status: 'queued', provider: 'ollama', metadata: updatedMetadata }),
        status: 200,
        req,
      });
    } finally {
      emitQueueChangedSpy.mockRestore();
      emitTaskUpdatedSpy.mockRestore();
    }
  });

  it('falls back to metadata.original_provider when task.provider is empty (production path)', async () => {
    const req = createReq({ params: { task_id: 'task-reject-prod' } });
    const res = createRes();
    const emitQueueChangedSpy = vi.spyOn(eventBus, 'emitQueueChanged');
    const emitTaskUpdatedSpy = vi.spyOn(eventBus, 'emitTaskUpdated');

    const task = {
      id: 'task-reject-prod',
      status: 'pending_provider_switch',
      provider: '   ',
      task_description: 'Reject switch via production path',
      retry_count: 1,
      metadata: {
        original_provider: 'codex',
        quota_overflow: true,
        retained_flag: 'keep-me',
      },
    };
    const updatedMetadata = {
      retained_flag: 'keep-me',
    };
    mockDb.getTask.mockReturnValue(task);
    mockDb.updateTask.mockImplementation(() => {
      throw new Error('Use updateTaskStatus() to modify task status');
    });
    mockDb.updateTaskStatus.mockReturnValue({
      ...task,
      status: 'queued',
      provider: 'codex',
      metadata: updatedMetadata,
    });

    try {
      await handlers.handleRejectSwitch(req, res);

      expect(mockDb.updateTask).toHaveBeenCalled();
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-reject-prod', 'queued', {
        provider: 'codex',
        metadata: updatedMetadata,
        started_at: null,
        completed_at: null,
        exit_code: null,
        pid: null,
        progress_percent: 0,
        model: null,
        ollama_host_id: null,
      });
      expect(emitQueueChangedSpy).toHaveBeenCalled();
      expect(emitTaskUpdatedSpy).toHaveBeenCalledWith({
        taskId: 'task-reject-prod',
        status: 'queued',
      });
      expect(getLastSuccess()).toEqual({
        res,
        requestId: 'req-123',
        data: buildTaskDetail({ ...task, status: 'queued', provider: 'codex', metadata: updatedMetadata }),
        status: 200,
        req,
      });
    } finally {
      emitQueueChangedSpy.mockRestore();
      emitTaskUpdatedSpy.mockRestore();
    }
  });
});
