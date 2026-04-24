'use strict';

const HANDLER_MODULE = '../api/v2-workflow-handlers';
const MODULE_PATHS = [
  HANDLER_MODULE,
  '../database',
  '../db/workflow-engine',
  '../api/v2-control-plane',
  '../api/middleware',
  '../container',
  '../handlers/workflow/index',
];

const mockTaskManager = {
  startTask: vi.fn(),
  cancelTask: vi.fn(),
  processQueue: vi.fn(),
};

const mockDb = {
  getWorkflow: vi.fn(),
  getWorkflowStatus: vi.fn(),
  listWorkflows: vi.fn(),
  reconcileStaleWorkflows: vi.fn(),
  getWorkflowHistory: vi.fn(),
  updateWorkflow: vi.fn(),
};

const mockCheckpointStore = {
  listCheckpoints: vi.fn(),
  getCheckpoint: vi.fn(),
};

const mockForker = {
  fork: vi.fn(),
};

const mockDefaultContainer = {
  has: vi.fn(),
  get: vi.fn(),
};

const mockContainer = {
  defaultContainer: mockDefaultContainer,
};

function serializeWorkflow(workflow) {
  if (!workflow) return null;
  return {
    id: workflow.id,
    name: workflow.name || null,
    status: workflow.status,
    priority: workflow.priority ?? 0,
    description: workflow.description || null,
    working_directory: workflow.working_directory || null,
    created_at: workflow.created_at || null,
    started_at: workflow.started_at || null,
    completed_at: workflow.completed_at || null,
  };
}

function serializeWorkflowDetail(workflow, tasks) {
  const base = serializeWorkflow(workflow);
  if (!base) return null;

  const taskList = Array.isArray(tasks) ? tasks : Object.values(tasks || {});
  const counts = {
    total: 0,
    completed: 0,
    running: 0,
    pending: 0,
    queued: 0,
    failed: 0,
    cancelled: 0,
    blocked: 0,
    skipped: 0,
  };

  for (const task of taskList) {
    counts.total += 1;
    if (counts[task.status] !== undefined) {
      counts[task.status] += 1;
    }
  }

  return {
    ...base,
    task_counts: counts,
    tasks: taskList.map((task) => ({
      id: task.id,
      node_id: task.node_id || task.workflow_node_id || null,
      status: task.status,
      description: task.task_description || task.description || null,
      provider: task.provider || null,
      model: task.model || null,
      progress: task.progress || task.progress_percent || 0,
      depends_on: task.depends_on || null,
    })),
  };
}

const mockSendSuccess = vi.fn();
const mockSendError = vi.fn();
const mockSendList = vi.fn();
const mockResolveRequestId = vi.fn();
const mockBuildWorkflowResponse = vi.fn();
const mockBuildWorkflowDetailResponse = vi.fn();
const mockBuildTaskResponse = vi.fn();

const mockControlPlane = {
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  sendList: mockSendList,
  resolveRequestId: mockResolveRequestId,
  buildWorkflowResponse: mockBuildWorkflowResponse,
  buildWorkflowDetailResponse: mockBuildWorkflowDetailResponse,
  buildTaskResponse: mockBuildTaskResponse,
};

const mockParseBody = vi.fn();
const mockMiddleware = {
  parseBody: mockParseBody,
};

const mockHandleCreateWorkflow = vi.fn();
const mockHandleRunWorkflow = vi.fn();
const mockHandleCancelWorkflow = vi.fn();
const mockHandleAddWorkflowTask = vi.fn();
const mockHandleCreateFeatureWorkflow = vi.fn();
const mockHandleFeatureWorkflow = vi.fn();
const mockHandlePauseWorkflow = vi.fn();
const mockHandleResumeWorkflow = vi.fn();

const mockWorkflowHandlers = {
  handleCreateWorkflow: mockHandleCreateWorkflow,
  handleRunWorkflow: mockHandleRunWorkflow,
  handleCancelWorkflow: mockHandleCancelWorkflow,
  handleAddWorkflowTask: mockHandleAddWorkflowTask,
  handleCreateFeatureWorkflow: mockHandleCreateFeatureWorkflow,
  handleFeatureWorkflow: mockHandleFeatureWorkflow,
  handlePauseWorkflow: mockHandlePauseWorkflow,
  handleResumeWorkflow: mockHandleResumeWorkflow,
};

function installCjsModuleMock(modulePath, exportsValue) {
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
      // Ignore modules that were not loaded.
    }
  }
}

function loadHandlers() {
  clearLoadedModules();
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../db/workflow-engine', mockDb);
  installCjsModuleMock('../api/v2-control-plane', mockControlPlane);
  installCjsModuleMock('../api/middleware', mockMiddleware);
  installCjsModuleMock('../container', mockContainer);
  installCjsModuleMock('../handlers/workflow/index', mockWorkflowHandlers);
  return require(HANDLER_MODULE);
}

vi.mock('../database', () => mockDb);
vi.mock('../api/v2-control-plane', () => mockControlPlane);
vi.mock('../api/middleware', () => mockMiddleware);
vi.mock('../container', () => mockContainer);
vi.mock('../handlers/workflow/index', () => mockWorkflowHandlers);

function makeWorkflow(overrides = {}) {
  return {
    id: 'abc12345-0000-4000-8000-aaaaaaaaaaaa',
    name: 'Release Workflow',
    status: 'pending',
    priority: 0,
    description: 'Ship the release',
    working_directory: 'C:\\repo',
    created_at: '2026-03-10T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    workflow_node_id: 'node-a',
    status: 'pending',
    task_description: 'Do work',
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    progress_percent: 0,
    depends_on: null,
    ...overrides,
  };
}

function makeReq(overrides = {}) {
  return {
    params: {},
    query: {},
    body: {},
    requestId: 'req-123',
    headers: {},
    ...overrides,
  };
}

function makeRes() {
  return {};
}

function lastCall(mockFn) {
  return mockFn.mock.calls[mockFn.mock.calls.length - 1];
}

function resetMockDefaults() {
  mockTaskManager.startTask.mockReset();
  mockTaskManager.cancelTask.mockReset();
  mockTaskManager.processQueue.mockReset();

  mockDb.getWorkflow.mockReset().mockReturnValue(null);
  mockDb.getWorkflowStatus.mockReset().mockReturnValue(null);
  mockDb.listWorkflows.mockReset().mockReturnValue([]);
  mockDb.reconcileStaleWorkflows.mockReset().mockReturnValue(undefined);
  mockDb.getWorkflowHistory.mockReset().mockReturnValue([]);
  mockDb.updateWorkflow.mockReset().mockReturnValue(undefined);

  mockCheckpointStore.listCheckpoints.mockReset().mockReturnValue([]);
  mockCheckpointStore.getCheckpoint.mockReset().mockReturnValue(null);
  mockForker.fork.mockReset().mockReturnValue({
    new_workflow_id: 'wf-forked',
    resumes_from_step: null,
    cloned_step_count: 0,
  });
  mockDefaultContainer.has.mockReset().mockImplementation((name) => (
    name === 'checkpointStore' || name === 'forker'
  ));
  mockDefaultContainer.get.mockReset().mockImplementation((name) => {
    if (name === 'checkpointStore') return mockCheckpointStore;
    if (name === 'forker') return mockForker;
    throw new Error(`Unknown container service: ${name}`);
  });

  mockSendSuccess.mockReset();
  mockSendError.mockReset();
  mockSendList.mockReset();
  mockResolveRequestId.mockReset().mockImplementation(
    (req) => req?.requestId || req?.headers?.['x-request-id'] || 'generated-request-id',
  );
  mockBuildWorkflowResponse.mockReset().mockImplementation(serializeWorkflow);
  mockBuildWorkflowDetailResponse.mockReset().mockImplementation(serializeWorkflowDetail);
  mockBuildTaskResponse.mockReset().mockImplementation((task) => {
    if (!task) return null;
    return {
      id: task.id,
      status: task.status,
      description: task.task_description || task.description || null,
      provider: task.provider || null,
      model: task.model || null,
    };
  });

  mockParseBody.mockReset().mockResolvedValue({});

  mockHandleCreateWorkflow.mockReset().mockReturnValue({
    content: [{ type: 'text', text: '## Workflow Created' }],
  });
  mockHandleRunWorkflow.mockReset().mockReturnValue({
    content: [{ type: 'text', text: '## Workflow Started' }],
  });
  mockHandleCancelWorkflow.mockReset().mockReturnValue({
    content: [{ type: 'text', text: '## Workflow Cancelled' }],
  });
  mockHandleAddWorkflowTask.mockReset().mockReturnValue({
    content: [{ type: 'text', text: '## Task Added to Workflow' }],
  });
  mockHandleCreateFeatureWorkflow.mockReset().mockReturnValue({
    content: [{ type: 'text', text: '## Feature Workflow Created' }],
  });
  mockHandleFeatureWorkflow.mockReset().mockReturnValue({
    content: [{ type: 'text', text: '## Feature Workflow Created' }],
  });
  mockHandlePauseWorkflow.mockReset().mockReturnValue({
    content: [{ type: 'text', text: '## Workflow Paused' }],
  });
  mockHandleResumeWorkflow.mockReset().mockReturnValue({
    content: [{ type: 'text', text: '## Workflow Resumed' }],
  });

  mockWorkflowHandlers.handleCreateFeatureWorkflow = mockHandleCreateFeatureWorkflow;
  mockWorkflowHandlers.handleFeatureWorkflow = mockHandleFeatureWorkflow;
  mockWorkflowHandlers.handlePauseWorkflow = mockHandlePauseWorkflow;
  mockWorkflowHandlers.handleResumeWorkflow = mockHandleResumeWorkflow;
}

describe('api/v2-workflow-handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
    handlers.init(mockTaskManager);
  });

  describe('handleCreateWorkflow', () => {
    it('returns 201 with workflow detail for a valid creation', async () => {
      const workflowId = 'abc12345-0000-4000-8000-aaaaaaaaaaaa';
      const workflow = makeWorkflow({ id: workflowId, name: 'Ship It' });
      const req = makeReq({
        requestId: 'req-create',
        body: {
          name: 'Ship It',
          description: 'Release train',
          priority: 5,
          working_directory: 'C:\\repo',
          control_handlers: {
            queries: { current_round: 'state.round' },
          },
          tasks: [{ node_id: 'build', task_description: 'Build binaries' }],
        },
      });
      const res = makeRes();

      mockHandleCreateWorkflow.mockReturnValue({
        content: [{ type: 'text', text: `## Workflow Created\n\n**ID:** ${workflowId}` }],
      });
      mockDb.getWorkflow.mockReturnValue(workflow);
      mockDb.getWorkflowStatus.mockReturnValue({
        tasks: {
          first: makeTask({ id: 'task-1', workflow_node_id: 'build', status: 'pending' }),
          second: makeTask({ id: 'task-2', workflow_node_id: 'test', status: 'running' }),
        },
      });

      await handlers.handleCreateWorkflow(req, res);

      expect(mockHandleCreateWorkflow).toHaveBeenCalledWith({
        name: 'Ship It',
        description: 'Release train',
        priority: 5,
        working_directory: 'C:\\repo',
        control_handlers: {
          queries: { current_round: 'state.round' },
        },
        tasks: [{ node_id: 'build', task_description: 'Build binaries' }],
      });

      const [resArg, requestId, data, status, reqArg] = lastCall(mockSendSuccess);
      expect(resArg).toBe(res);
      expect(requestId).toBe('req-create');
      expect(status).toBe(201);
      expect(reqArg).toBe(req);
      expect(data).toMatchObject({
        id: workflowId,
        name: 'Ship It',
        task_counts: { total: 2, pending: 1, running: 1 },
      });
      expect(data.tasks).toHaveLength(2);
      expect(mockSendError).not.toHaveBeenCalled();
    });

    it('returns fallback message payload when no workflow id is present in the MCP response', async () => {
      const req = makeReq({
        body: {
          name: 'Ship It',
          tasks: [{ node_id: 'build', task_description: 'Build binaries' }],
        },
      });
      const res = makeRes();

      mockHandleCreateWorkflow.mockReturnValue({
        content: [{ type: 'text', text: 'Workflow created without structured ID output' }],
      });

      await handlers.handleCreateWorkflow(req, res);

      const [, , data, status] = lastCall(mockSendSuccess);
      expect(status).toBe(201);
      expect(data).toEqual({
        name: 'Ship It',
        message: 'Workflow created without structured ID output',
      });
    });

    it('reads the request body from parseBody when req.body is missing', async () => {
      const req = makeReq({
        body: undefined,
        requestId: 'req-create-parse',
      });
      const res = makeRes();

      mockParseBody.mockResolvedValue({
        name: 'Parsed Workflow',
        tasks: [{ node_id: 'seed', task_description: 'Seed task' }],
      });
      mockHandleCreateWorkflow.mockReturnValue({
        content: [{ type: 'text', text: 'Created from parsed body' }],
      });

      await handlers.handleCreateWorkflow(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
      const [, requestId, data] = lastCall(mockSendSuccess);
      expect(requestId).toBe('req-create-parse');
      expect(data).toEqual({
        name: 'Parsed Workflow',
        message: 'Created from parsed body',
      });
    });

    it('returns 400 when name is missing', async () => {
      const req = makeReq({
        requestId: 'req-create-missing-name',
        body: {
          tasks: [{ node_id: 'build', task_description: 'Build binaries' }],
        },
      });

      await handlers.handleCreateWorkflow(req, makeRes());

      expect(mockSendError).toHaveBeenCalledWith(
        expect.any(Object),
        'req-create-missing-name',
        'validation_error',
        'name is required',
        400,
        undefined,
        req,
      );
      expect(mockHandleCreateWorkflow).not.toHaveBeenCalled();
    });

    it('returns 400 when tasks is an empty array', async () => {
      const req = makeReq({
        requestId: 'req-create-empty-tasks',
        body: { name: 'Ship It', tasks: [] },
      });

      await handlers.handleCreateWorkflow(req, makeRes());

      expect(mockSendError).toHaveBeenCalledWith(
        expect.any(Object),
        'req-create-empty-tasks',
        'validation_error',
        'tasks must be a non-empty array',
        400,
        undefined,
        req,
      );
      expect(mockHandleCreateWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('handleListWorkflows', () => {
    it('returns a list of serialized workflows', async () => {
      const req = makeReq({ requestId: 'req-list', query: {} });
      const res = makeRes();
      const workflows = [
        makeWorkflow({ id: 'wf-1', name: 'Alpha', status: 'pending' }),
        makeWorkflow({ id: 'wf-2', name: 'Beta', status: 'running' }),
      ];
      mockDb.listWorkflows.mockReturnValue(workflows);

      await handlers.handleListWorkflows(req, res);

      expect(mockDb.listWorkflows).toHaveBeenCalledWith({
        status: undefined,
        limit: 20,
      });
      const [resArg, requestId, items, total, reqArg] = lastCall(mockSendList);
      expect(resArg).toBe(res);
      expect(requestId).toBe('req-list');
      expect(total).toBe(2);
      expect(reqArg).toBe(req);
      expect(items).toEqual(workflows.map(serializeWorkflow));
    });

    it('passes through the requested status and limit', async () => {
      const req = makeReq({
        requestId: 'req-list-limit',
        query: { status: 'running', limit: '5' },
      });

      await handlers.handleListWorkflows(req, makeRes());

      expect(mockDb.listWorkflows).toHaveBeenCalledWith({
        status: 'running',
        limit: 5,
      });
    });

    it('clamps limit to 100', async () => {
      const req = makeReq({
        requestId: 'req-list-clamp',
        query: { limit: '999' },
      });

      await handlers.handleListWorkflows(req, makeRes());

      expect(mockDb.listWorkflows).toHaveBeenCalledWith({
        status: undefined,
        limit: 100,
      });
    });

    it('handles empty results even when reconcileStaleWorkflows throws', async () => {
      const req = makeReq({
        requestId: 'req-list-empty',
        query: { limit: '3' },
      });
      mockDb.reconcileStaleWorkflows.mockImplementation(() => {
        throw new Error('stale reconciliation failed');
      });
      mockDb.listWorkflows.mockReturnValue([]);

      await handlers.handleListWorkflows(req, makeRes());

      const [, requestId, items, total] = lastCall(mockSendList);
      expect(requestId).toBe('req-list-empty');
      expect(items).toEqual([]);
      expect(total).toBe(0);
    });
  });

  describe('handleGetWorkflow', () => {
    it('returns workflow detail with task_counts and tasks array', async () => {
      const workflowId = 'wf-detail';
      const req = makeReq({
        requestId: 'req-get',
        params: { workflow_id: workflowId },
      });
      const workflow = makeWorkflow({ id: workflowId, name: 'Inspect Workflow', status: 'running' });

      mockDb.getWorkflow.mockReturnValue(workflow);
      mockDb.getWorkflowStatus.mockReturnValue({
        tasks: {
          a: makeTask({ id: 'task-a', workflow_node_id: 'build', status: 'running', progress_percent: 25 }),
          b: makeTask({ id: 'task-b', workflow_node_id: 'test', status: 'pending' }),
        },
      });

      await handlers.handleGetWorkflow(req, makeRes());

      expect(mockDb.reconcileStaleWorkflows).toHaveBeenCalledWith(workflowId);
      const [, requestId, data, status] = lastCall(mockSendSuccess);
      expect(requestId).toBe('req-get');
      expect(status).toBe(200);
      expect(data.task_counts).toMatchObject({ total: 2, running: 1, pending: 1 });
      expect(data.tasks).toEqual([
        expect.objectContaining({ id: 'task-a', node_id: 'build', status: 'running', progress: 25 }),
        expect.objectContaining({ id: 'task-b', node_id: 'test', status: 'pending', progress: 0 }),
      ]);
    });

    it('returns 404 when the workflow is missing', async () => {
      const req = makeReq({
        requestId: 'req-get-missing',
        params: { workflow_id: 'wf-missing' },
      });

      await handlers.handleGetWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-get-missing');
      expect(code).toBe('workflow_not_found');
      expect(message).toBe('Workflow not found: wf-missing');
      expect(status).toBe(404);
    });
  });

  describe('handleRunWorkflow', () => {
    it('starts a workflow and returns updated detail', async () => {
      const workflowId = 'abc12345-0000-4000-8000-bbbbbbbbbbbb';
      const req = makeReq({
        requestId: 'req-run',
        params: { workflow_id: workflowId },
      });
      const initialWorkflow = makeWorkflow({ id: workflowId, status: 'pending' });
      const updatedWorkflow = makeWorkflow({ id: workflowId, status: 'running', started_at: '2026-03-10T01:00:00.000Z' });

      mockDb.getWorkflow
        .mockReturnValueOnce(initialWorkflow)
        .mockReturnValueOnce(updatedWorkflow);
      mockDb.getWorkflowStatus.mockReturnValue({
        tasks: {
          a: makeTask({ id: 'task-a', status: 'running' }),
        },
      });
      mockHandleRunWorkflow.mockReturnValue({
        content: [{ type: 'text', text: `## Workflow Started\n\n**ID:** ${workflowId}` }],
      });

      await handlers.handleRunWorkflow(req, makeRes());

      expect(mockHandleRunWorkflow).toHaveBeenCalledWith({ workflow_id: workflowId });
      const [, requestId, data, status] = lastCall(mockSendSuccess);
      expect(requestId).toBe('req-run');
      expect(status).toBe(200);
      expect(data).toMatchObject({
        id: workflowId,
        status: 'running',
        task_counts: { total: 1, running: 1 },
      });
    });

    it('returns 404 when the workflow is missing', async () => {
      const req = makeReq({
        requestId: 'req-run-missing',
        params: { workflow_id: 'wf-missing' },
      });

      await handlers.handleRunWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-run-missing');
      expect(code).toBe('workflow_not_found');
      expect(message).toBe('Workflow not found: wf-missing');
      expect(status).toBe(404);
    });

    it('returns 400 when the workflow is already running', async () => {
      const req = makeReq({
        requestId: 'req-run-already',
        params: { workflow_id: 'wf-running' },
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-running', status: 'running' }));

      await handlers.handleRunWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-run-already');
      expect(code).toBe('invalid_status');
      expect(message).toBe('Workflow is already running');
      expect(status).toBe(400);
      expect(mockHandleRunWorkflow).not.toHaveBeenCalled();
    });

    it('returns 400 when the delegated workflow handler returns an MCP error payload', async () => {
      const req = makeReq({
        requestId: 'req-run-error',
        params: { workflow_id: 'wf-error' },
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-error', status: 'pending' }));
      mockHandleRunWorkflow.mockReturnValue({
        error_code: 'OPERATION_FAILED',
        content: [{ type: 'text', text: 'Workflow start failed upstream' }],
      });

      await handlers.handleRunWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-run-error');
      expect(code).toBe('operation_failed');
      expect(message).toBe('Workflow start failed upstream');
      expect(status).toBe(400);
    });

    it('returns 500 when the delegated workflow handler throws', async () => {
      const req = makeReq({
        requestId: 'req-run-throw',
        params: { workflow_id: 'wf-throw' },
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-throw', status: 'pending' }));
      mockHandleRunWorkflow.mockImplementation(() => {
        throw new Error('workflow boom');
      });

      await handlers.handleRunWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-run-throw');
      expect(code).toBe('operation_failed');
      expect(message).toBe('workflow boom');
      expect(status).toBe(500);
    });
  });

  describe('handleCancelWorkflow', () => {
    it('cancels an active workflow', async () => {
      const workflowId = 'wf-cancel';
      const req = makeReq({
        requestId: 'req-cancel',
        params: { workflow_id: workflowId },
      });

      mockDb.getWorkflow
        .mockReturnValueOnce(makeWorkflow({ id: workflowId, status: 'running' }))
        .mockReturnValueOnce(makeWorkflow({ id: workflowId, status: 'cancelled' }));

      await handlers.handleCancelWorkflow(req, makeRes());

      expect(mockHandleCancelWorkflow).toHaveBeenCalledWith({ workflow_id: workflowId });
      const [, requestId, data, status] = lastCall(mockSendSuccess);
      expect(requestId).toBe('req-cancel');
      expect(status).toBe(200);
      expect(data).toEqual({
        workflow_id: workflowId,
        cancelled: true,
        status: 'cancelled',
      });
    });

    it('returns cancelled=false for a terminal workflow', async () => {
      const workflowId = 'wf-terminal';
      const req = makeReq({
        requestId: 'req-cancel-terminal',
        params: { workflow_id: workflowId },
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: workflowId, status: 'completed' }));

      await handlers.handleCancelWorkflow(req, makeRes());

      const [, requestId, data, status] = lastCall(mockSendSuccess);
      expect(requestId).toBe('req-cancel-terminal');
      expect(status).toBe(200);
      expect(data).toEqual({
        workflow_id: workflowId,
        cancelled: false,
        status: 'completed',
        reason: 'Workflow already in terminal state',
      });
      expect(mockHandleCancelWorkflow).not.toHaveBeenCalled();
    });

    it('returns 404 when the workflow is missing', async () => {
      const req = makeReq({
        requestId: 'req-cancel-missing',
        params: { workflow_id: 'wf-missing' },
      });

      await handlers.handleCancelWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-cancel-missing');
      expect(code).toBe('workflow_not_found');
      expect(message).toBe('Workflow not found: wf-missing');
      expect(status).toBe(404);
    });
  });

  describe('handleAddWorkflowTask', () => {
    it('adds a task to the workflow and returns 201 with the parsed task id', async () => {
      const workflowId = 'wf-add-task';
      const taskId = 'deadbeef-1111-4222-8333-aaaaaaaaaaaa';
      const description = 'x'.repeat(250);
      const req = makeReq({
        requestId: 'req-add-task',
        params: { workflow_id: workflowId },
        body: {
          node_id: 'build',
          task_description: description,
        },
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({
        id: workflowId,
        working_directory: 'C:\\repo',
      }));
      mockHandleAddWorkflowTask.mockReturnValue({
        content: [{ type: 'text', text: `## Task Added to Workflow\n\n**Task ID:** ${taskId}` }],
      });

      await handlers.handleAddWorkflowTask(req, makeRes());

      expect(mockHandleAddWorkflowTask).toHaveBeenCalledWith({
        workflow_id: workflowId,
        task: description,
        task_description: description,
        node_id: 'build',
        depends_on: undefined,
        provider: undefined,
        model: undefined,
        working_directory: 'C:\\repo',
      });

      const [, requestId, data, status] = lastCall(mockSendSuccess);
      expect(requestId).toBe('req-add-task');
      expect(status).toBe(201);
      expect(data).toEqual({
        workflow_id: workflowId,
        task_id: taskId,
        description: description.slice(0, 200),
        added: true,
      });
    });

    it('reads body via parseBody and accepts the task field', async () => {
      const workflowId = 'wf-add-task-parse';
      const taskId = 'feedface-1111-4222-8333-bbbbbbbbbbbb';
      const req = makeReq({
        requestId: 'req-add-task-parse',
        body: undefined,
        params: { workflow_id: workflowId },
      });

      mockParseBody.mockResolvedValue({
        node_id: 'review',
        task: 'Review the release diff',
      });
      mockDb.getWorkflow.mockReturnValue(makeWorkflow({
        id: workflowId,
        working_directory: 'D:\\workspace',
      }));
      mockHandleAddWorkflowTask.mockReturnValue({
        content: [{ type: 'text', text: `## Task Added to Workflow\n\n**Task ID:** ${taskId}` }],
      });

      await handlers.handleAddWorkflowTask(req, makeRes());

      expect(mockParseBody).toHaveBeenCalledWith(req);
      expect(mockHandleAddWorkflowTask).toHaveBeenCalledWith({
        workflow_id: workflowId,
        task: 'Review the release diff',
        task_description: undefined,
        node_id: 'review',
        depends_on: undefined,
        provider: undefined,
        model: undefined,
        working_directory: 'D:\\workspace',
      });
    });

    it('returns 404 when the workflow is missing', async () => {
      const req = makeReq({
        requestId: 'req-add-task-missing',
        params: { workflow_id: 'wf-missing' },
        body: { task_description: 'Do work' },
      });

      await handlers.handleAddWorkflowTask(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-add-task-missing');
      expect(code).toBe('workflow_not_found');
      expect(message).toBe('Workflow not found: wf-missing');
      expect(status).toBe(404);
    });

    it('returns 400 when task description is missing', async () => {
      const req = makeReq({
        requestId: 'req-add-task-validation',
        params: { workflow_id: 'wf-1' },
        body: {},
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-1' }));

      await handlers.handleAddWorkflowTask(req, makeRes());

      expect(mockSendError).toHaveBeenCalledWith(
        expect.any(Object),
        'req-add-task-validation',
        'validation_error',
        'task or task_description is required',
        400,
        undefined,
        req,
      );
      expect(mockHandleAddWorkflowTask).not.toHaveBeenCalled();
    });
  });

  describe('handleWorkflowHistory', () => {
    it('returns a normalized events array', async () => {
      const workflowId = 'wf-history';
      const req = makeReq({
        requestId: 'req-history',
        params: { workflow_id: workflowId },
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: workflowId, name: 'History Workflow' }));
      mockDb.getWorkflowHistory.mockReturnValue([
        {
          created_at: '2026-03-10T10:00:00.000Z',
          event_type: 'task_status_changed',
          task_id: 'task-1',
          old_value: 'pending',
          new_value: 'running',
          event_data: { attempt: 1 },
        },
        {
          timestamp: '2026-03-10T11:00:00.000Z',
          type: 'workflow_completed',
          details: { summary: 'done' },
        },
      ]);

      await handlers.handleWorkflowHistory(req, makeRes());

      const [, requestId, data, status] = lastCall(mockSendSuccess);
      expect(requestId).toBe('req-history');
      expect(status).toBe(200);
      expect(data).toEqual({
        workflow_id: workflowId,
        events: [
          {
            timestamp: '2026-03-10T10:00:00.000Z',
            event_type: 'task_status_changed',
            task_id: 'task-1',
            old_status: 'pending',
            new_status: 'running',
            details: { attempt: 1 },
          },
          {
            timestamp: '2026-03-10T11:00:00.000Z',
            event_type: 'workflow_completed',
            task_id: null,
            old_status: null,
            new_status: null,
            details: { summary: 'done' },
          },
        ],
      });
    });

    it('returns an empty events array when history is not an array', async () => {
      const workflowId = 'wf-history-empty';
      const req = makeReq({
        requestId: 'req-history-empty',
        params: { workflow_id: workflowId },
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: workflowId }));
      mockDb.getWorkflowHistory.mockReturnValue('not-an-array');

      await handlers.handleWorkflowHistory(req, makeRes());

      const [, , data] = lastCall(mockSendSuccess);
      expect(data).toEqual({
        workflow_id: workflowId,
        events: [],
      });
    });

    it('returns 404 when the workflow is missing', async () => {
      const req = makeReq({
        requestId: 'req-history-missing',
        params: { workflow_id: 'wf-missing' },
      });

      await handlers.handleWorkflowHistory(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-history-missing');
      expect(code).toBe('workflow_not_found');
      expect(message).toBe('Workflow not found: wf-missing');
      expect(status).toBe(404);
    });
  });

  describe('handleGetWorkflowCheckpoints', () => {
    it('returns 404 when the workflow is missing', async () => {
      const req = makeReq({
        requestId: 'req-checkpoints-missing',
        params: { workflow_id: 'wf-missing' },
      });

      await handlers.handleGetWorkflowCheckpoints(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-checkpoints-missing');
      expect(code).toBe('workflow_not_found');
      expect(message).toBe('Workflow not found: wf-missing');
      expect(status).toBe(404);
    });

    it('returns checkpoint data for a valid workflow', async () => {
      const workflowId = 'wf-checkpoints';
      const req = makeReq({
        requestId: 'req-checkpoints',
        params: { workflow_id: workflowId },
      });
      const res = makeRes();
      const checkpoints = [
        {
          checkpoint_id: 'cp-1',
          workflow_id: workflowId,
          step_id: 'build',
          task_id: 'task-1',
          state_version: 2,
          taken_at: '2026-04-23T00:00:00.000Z',
        },
      ];

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: workflowId }));
      mockCheckpointStore.listCheckpoints.mockReturnValue(checkpoints);

      await handlers.handleGetWorkflowCheckpoints(req, res);

      expect(mockCheckpointStore.listCheckpoints).toHaveBeenCalledWith(workflowId);
      const [resArg, requestId, data, status, reqArg] = lastCall(mockSendSuccess);
      expect(resArg).toBe(res);
      expect(requestId).toBe('req-checkpoints');
      expect(status).toBe(200);
      expect(reqArg).toBe(req);
      expect(data).toEqual({
        workflow_id: workflowId,
        checkpoints,
      });
    });
  });

  describe('handleForkWorkflow', () => {
    it('returns 404 when the workflow is missing', async () => {
      const req = makeReq({
        requestId: 'req-fork-missing',
        params: { workflow_id: 'wf-missing' },
        body: { checkpoint_id: 'cp-1' },
      });

      await handlers.handleForkWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-fork-missing');
      expect(code).toBe('workflow_not_found');
      expect(message).toBe('Workflow not found: wf-missing');
      expect(status).toBe(404);
    });

    it('returns 400 when checkpoint_id is missing', async () => {
      const workflowId = 'wf-fork';
      const req = makeReq({
        requestId: 'req-fork-validation',
        params: { workflow_id: workflowId },
        body: {},
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: workflowId }));

      await handlers.handleForkWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-fork-validation');
      expect(code).toBe('validation_error');
      expect(message).toBe('checkpoint_id is required');
      expect(status).toBe(400);
    });

    it('reads body via parseBody and returns a fork result', async () => {
      const workflowId = 'wf-fork';
      const req = makeReq({
        body: undefined,
        requestId: 'req-fork-parse',
        params: { workflow_id: workflowId },
      });
      const res = makeRes();

      mockParseBody.mockResolvedValue({
        checkpoint_id: 'cp-9',
        name: 'Forked workflow',
        state_overrides: { logs: ['patched'] },
      });
      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: workflowId }));
      mockCheckpointStore.getCheckpoint.mockReturnValue({
        checkpoint_id: 'cp-9',
        workflow_id: workflowId,
      });
      mockForker.fork.mockReturnValue({
        new_workflow_id: 'wf-child',
        resumes_from_step: 'build',
        cloned_step_count: 3,
      });

      await handlers.handleForkWorkflow(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
      expect(mockCheckpointStore.getCheckpoint).toHaveBeenCalledWith('cp-9');
      expect(mockForker.fork).toHaveBeenCalledWith({
        checkpointId: 'cp-9',
        name: 'Forked workflow',
        state_overrides: { logs: ['patched'] },
      });

      const [resArg, requestId, data, status, reqArg] = lastCall(mockSendSuccess);
      expect(resArg).toBe(res);
      expect(requestId).toBe('req-fork-parse');
      expect(status).toBe(201);
      expect(reqArg).toBe(req);
      expect(data).toEqual({
        new_workflow_id: 'wf-child',
        resumes_from_step: 'build',
        cloned_step_count: 3,
      });
    });

    it('returns 400 when the checkpoint belongs to a different workflow', async () => {
      const req = makeReq({
        requestId: 'req-fork-mismatch',
        params: { workflow_id: 'wf-parent' },
        body: { checkpoint_id: 'cp-5' },
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-parent' }));
      mockCheckpointStore.getCheckpoint.mockReturnValue({
        checkpoint_id: 'cp-5',
        workflow_id: 'wf-other',
      });

      await handlers.handleForkWorkflow(req, makeRes());

      expect(mockForker.fork).not.toHaveBeenCalled();
      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-fork-mismatch');
      expect(code).toBe('validation_error');
      expect(message).toBe('Checkpoint cp-5 does not belong to workflow wf-parent');
      expect(status).toBe(400);
    });
  });

  describe('handleCreateFeatureWorkflow', () => {
    it('returns 400 when feature_name is missing', async () => {
      const req = makeReq({
        requestId: 'req-feature-missing',
        body: { working_directory: 'C:\\repo' },
      });

      await handlers.handleCreateFeatureWorkflow(req, makeRes());

      expect(mockSendError).toHaveBeenCalledWith(
        expect.any(Object),
        'req-feature-missing',
        'validation_error',
        'feature_name is required',
        400,
        undefined,
        req,
      );
    });

    it('returns 201 with workflow detail when feature workflow creation succeeds', async () => {
      const workflowId = 'facefeed-0000-4000-8000-cccccccccccc';
      const req = makeReq({
        requestId: 'req-feature-create',
        body: {
          feature_name: 'Auth',
          working_directory: 'C:\\repo',
        },
      });

      mockHandleCreateFeatureWorkflow.mockReturnValue({
        content: [{ type: 'text', text: `## Feature Workflow Created\n\n**ID:** ${workflowId}` }],
      });
      mockDb.getWorkflow.mockReturnValue(makeWorkflow({
        id: workflowId,
        name: 'Feature: Auth',
      }));
      mockDb.getWorkflowStatus.mockReturnValue({
        tasks: {
          a: makeTask({ id: 'task-a', status: 'pending' }),
        },
      });

      await handlers.handleCreateFeatureWorkflow(req, makeRes());

      expect(mockHandleCreateFeatureWorkflow).toHaveBeenCalledWith({
        feature_name: 'Auth',
        working_directory: 'C:\\repo',
      });
      const [, requestId, data, status] = lastCall(mockSendSuccess);
      expect(requestId).toBe('req-feature-create');
      expect(status).toBe(201);
      expect(data).toMatchObject({
        id: workflowId,
        name: 'Feature: Auth',
        task_counts: { total: 1, pending: 1 },
      });
    });

    it('falls back to handleFeatureWorkflow when handleCreateFeatureWorkflow is unavailable', async () => {
      const workflowId = 'beadfeed-0000-4000-8000-dddddddddddd';
      const req = makeReq({
        requestId: 'req-feature-fallback',
        body: {
          feature_name: 'Payments',
          working_directory: 'D:\\repo',
        },
      });

      mockWorkflowHandlers.handleCreateFeatureWorkflow = undefined;
      mockHandleFeatureWorkflow.mockReturnValue({
        content: [{ type: 'text', text: `## Feature Workflow Created\n\n**ID:** ${workflowId}` }],
      });
      mockDb.getWorkflow.mockReturnValue(makeWorkflow({
        id: workflowId,
        name: 'Feature: Payments',
      }));
      mockDb.getWorkflowStatus.mockReturnValue({ tasks: {} });

      await handlers.handleCreateFeatureWorkflow(req, makeRes());

      expect(mockHandleFeatureWorkflow).toHaveBeenCalledWith({
        feature_name: 'Payments',
        working_directory: 'D:\\repo',
      });
      const [, requestId, data, status] = lastCall(mockSendSuccess);
      expect(requestId).toBe('req-feature-fallback');
      expect(status).toBe(201);
      expect(data.id).toBe(workflowId);
    });

    it('returns 501 when no feature workflow handler is available', async () => {
      const req = makeReq({
        requestId: 'req-feature-unavailable',
        body: {
          feature_name: 'Reports',
          working_directory: 'C:\\repo',
        },
      });

      mockWorkflowHandlers.handleCreateFeatureWorkflow = undefined;
      mockWorkflowHandlers.handleFeatureWorkflow = undefined;

      await handlers.handleCreateFeatureWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-feature-unavailable');
      expect(code).toBe('not_implemented');
      expect(message).toBe('Feature workflow creation not available');
      expect(status).toBe(501);
    });
  });

  describe('handlePauseWorkflow', () => {
    it('returns 404 for a non-existent workflow', async () => {
      const req = makeReq({
        requestId: 'req-pause-missing',
        params: { workflow_id: 'wf-missing' },
      });

      await handlers.handlePauseWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-pause-missing');
      expect(code).toBe('workflow_not_found');
      expect(message).toBe('Workflow not found: wf-missing');
      expect(status).toBe(404);
    });

    it('returns 400 when workflow is not running', async () => {
      const req = makeReq({
        requestId: 'req-pause-pending',
        params: { workflow_id: 'wf-pending' },
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-pending', status: 'pending' }));

      await handlers.handlePauseWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-pause-pending');
      expect(code).toBe('invalid_status');
      expect(message).toBe('Cannot pause workflow with status: pending');
      expect(status).toBe(400);
    });

    it('successfully pauses a running workflow', async () => {
      const workflowId = 'wf-pause';
      const req = makeReq({
        requestId: 'req-pause',
        params: { workflow_id: workflowId },
      });

      mockDb.getWorkflow
        .mockReturnValueOnce(makeWorkflow({ id: workflowId, status: 'running' }))
        .mockReturnValueOnce(makeWorkflow({ id: workflowId, status: 'paused' }));

      await handlers.handlePauseWorkflow(req, makeRes());

      expect(mockHandlePauseWorkflow).toHaveBeenCalledWith({ workflow_id: workflowId });
      const [, requestId, data, status] = lastCall(mockSendSuccess);
      expect(requestId).toBe('req-pause');
      expect(status).toBe(200);
      expect(data).toEqual({
        workflow_id: workflowId,
        paused: true,
        status: 'paused',
      });
    });

    it('falls back to db.updateWorkflow if MCP handler unavailable', async () => {
      const workflowId = 'wf-pause-fallback';
      const req = makeReq({
        requestId: 'req-pause-fallback',
        params: { workflow_id: workflowId },
      });

      mockWorkflowHandlers.handlePauseWorkflow = undefined;
      mockDb.getWorkflow
        .mockReturnValueOnce(makeWorkflow({ id: workflowId, status: 'running' }))
        .mockReturnValueOnce(makeWorkflow({ id: workflowId, status: 'paused' }));

      await handlers.handlePauseWorkflow(req, makeRes());

      expect(mockDb.updateWorkflow).toHaveBeenCalledWith(workflowId, { status: 'paused' });
      const [, requestId, data, status] = lastCall(mockSendSuccess);
      expect(requestId).toBe('req-pause-fallback');
      expect(status).toBe(200);
      expect(data).toEqual({
        workflow_id: workflowId,
        paused: true,
        status: 'paused',
      });
    });
  });

  describe('handleResumeWorkflow', () => {
    it('returns 404 for a non-existent workflow', async () => {
      const req = makeReq({
        requestId: 'req-resume-missing',
        params: { workflow_id: 'wf-missing' },
      });

      await handlers.handleResumeWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-resume-missing');
      expect(code).toBe('workflow_not_found');
      expect(message).toBe('Workflow not found: wf-missing');
      expect(status).toBe(404);
    });

    it('returns 400 when workflow is not paused', async () => {
      const req = makeReq({
        requestId: 'req-resume-running',
        params: { workflow_id: 'wf-running' },
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-running', status: 'running' }));

      await handlers.handleResumeWorkflow(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-resume-running');
      expect(code).toBe('invalid_status');
      expect(message).toBe('Cannot resume workflow with status: running');
      expect(status).toBe(400);
    });

    it('successfully resumes a paused workflow', async () => {
      const workflowId = 'wf-resume';
      const req = makeReq({
        requestId: 'req-resume',
        params: { workflow_id: workflowId },
      });

      mockDb.getWorkflow
        .mockReturnValueOnce(makeWorkflow({ id: workflowId, status: 'paused' }))
        .mockReturnValueOnce(makeWorkflow({ id: workflowId, status: 'running', started_at: '2026-03-10T01:00:00.000Z' }));
      mockDb.getWorkflowStatus.mockReturnValue({
        tasks: {
          a: makeTask({ id: 'task-a', status: 'running' }),
        },
      });

      await handlers.handleResumeWorkflow(req, makeRes());

      expect(mockHandleResumeWorkflow).toHaveBeenCalledWith({ workflow_id: workflowId });
      const [, requestId, data, status] = lastCall(mockSendSuccess);
      expect(requestId).toBe('req-resume');
      expect(status).toBe(200);
      expect(data).toMatchObject({
        id: workflowId,
        status: 'running',
        task_counts: { total: 1, running: 1 },
      });
    });
  });

  describe('handleGetWorkflowTasks', () => {
    it('returns 404 for a non-existent workflow', async () => {
      const req = makeReq({
        requestId: 'req-tasks-missing',
        params: { workflow_id: 'wf-missing' },
      });

      await handlers.handleGetWorkflowTasks(req, makeRes());

      const [, requestId, code, message, status] = lastCall(mockSendError);
      expect(requestId).toBe('req-tasks-missing');
      expect(code).toBe('workflow_not_found');
      expect(message).toBe('Workflow not found: wf-missing');
      expect(status).toBe(404);
    });

    it('returns task list for a valid workflow', async () => {
      const workflowId = 'wf-tasks';
      const req = makeReq({
        requestId: 'req-tasks',
        params: { workflow_id: workflowId },
      });
      const res = makeRes();

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: workflowId, status: 'running' }));
      mockDb.getWorkflowStatus.mockReturnValue({
        tasks: {
          a: makeTask({
            id: 'task-a',
            workflow_node_id: 'build',
            status: 'completed',
            task_description: 'Build step',
            provider: 'codex',
            node_id: 'build',
            depends_on: null,
          }),
          b: makeTask({
            id: 'task-b',
            workflow_node_id: 'test',
            status: 'running',
            task_description: 'Test step',
            provider: 'ollama',
            node_id: 'test',
            depends_on: 'build',
          }),
        },
      });

      await handlers.handleGetWorkflowTasks(req, res);

      const [resArg, requestId, items, total, reqArg] = lastCall(mockSendList);
      expect(resArg).toBe(res);
      expect(requestId).toBe('req-tasks');
      expect(total).toBe(2);
      expect(reqArg).toBe(req);
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ id: 'task-a', node_id: 'build', depends_on: null });
      expect(items[1]).toMatchObject({ id: 'task-b', node_id: 'test', depends_on: 'build' });
    });

    it('returns empty list for a workflow with no tasks', async () => {
      const workflowId = 'wf-empty-tasks';
      const req = makeReq({
        requestId: 'req-empty-tasks',
        params: { workflow_id: workflowId },
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: workflowId, status: 'pending' }));
      mockDb.getWorkflowStatus.mockReturnValue({ tasks: {} });

      await handlers.handleGetWorkflowTasks(req, makeRes());

      const [, requestId, items, total] = lastCall(mockSendList);
      expect(requestId).toBe('req-empty-tasks');
      expect(items).toEqual([]);
      expect(total).toBe(0);
    });

    it('tasks include node_id and depends_on fields', async () => {
      const workflowId = 'wf-task-fields';
      const req = makeReq({
        requestId: 'req-task-fields',
        params: { workflow_id: workflowId },
      });

      mockDb.getWorkflow.mockReturnValue(makeWorkflow({ id: workflowId }));
      mockDb.getWorkflowStatus.mockReturnValue({
        tasks: {
          a: makeTask({
            id: 'task-dep',
            status: 'pending',
            task_description: 'Dependent task',
            node_id: 'deploy',
            depends_on: 'build,test',
          }),
        },
      });

      await handlers.handleGetWorkflowTasks(req, makeRes());

      const [, , items] = lastCall(mockSendList);
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveProperty('node_id', 'deploy');
      expect(items[0]).toHaveProperty('depends_on', 'build,test');
    });
  });
});
