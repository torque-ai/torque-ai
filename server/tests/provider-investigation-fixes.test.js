'use strict';

/**
 * Tests for provider investigation fixes (Items 15, 22, 23).
 *
 * Item 15: Workflow task creation rejects invalid provider overrides
 * Item 22: Retry clones preserve original user_provider_override
 * Item 23: pending_provider_switch included in workflow lifecycle status sets
 */

const { randomUUID } = require('crypto');
const { TEST_MODELS } = require('./test-helpers');

// ═══════════════════════════════════════════════════════════════════
// Item 15: Workflow task creation validates provider overrides
// ═══════════════════════════════════════════════════════════════════

describe('Item 15: workflow provider validation', () => {
  const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
  let _db;

  beforeAll(() => {
    const env = setupTestDb('provider-investigation-item15');
    _db = env.db;
  });
  afterAll(() => { teardownTestDb(); });

  describe('create_workflow with provider overrides', () => {
    it('rejects task with unknown provider', async () => {
      const result = await safeTool('create_workflow', {
        name: 'wf-bad-provider',
        tasks: [{
          node_id: 'step-1',
          task_description: 'Do something',
          provider: 'nonexistent-provider-xyz'
        }]
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Unknown provider');
      expect(getText(result)).toContain('nonexistent-provider-xyz');
    });

    it('accepts task with valid enabled provider', async () => {
      const result = await safeTool('create_workflow', {
        name: 'wf-good-provider',
        tasks: [{
          node_id: 'step-1',
          task_description: 'Do something with codex',
          provider: 'codex'
        }]
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Workflow Created');
    });

    it('accepts task without provider override', async () => {
      const result = await safeTool('create_workflow', {
        name: 'wf-no-provider',
        tasks: [{
          node_id: 'step-1',
          task_description: 'Use default provider'
        }]
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Workflow Created');
    });
  });

  describe('add_workflow_task with provider overrides', () => {
    let workflowId;

    beforeAll(async () => {
      const result = await safeTool('create_workflow', {
        name: 'wf-add-task-provider-test',
        tasks: [{ node_id: 'root', task_description: 'Root task' }]
      });
      const text = getText(result);
      const m = text.match(/([a-f0-9-]{36})/);
      workflowId = m ? m[1] : null;
    });

    it('rejects add_workflow_task with unknown provider', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        node_id: 'bad-prov-node',
        task_description: 'Task with bad provider',
        provider: 'fantasy-provider-999'
        });
        expect(result.isError).toBe(true);
        expect(getText(result)).toContain('Parameter "provider" must be one of');
        expect(getText(result)).toContain('fantasy-provider-999');
      });

    it('accepts add_workflow_task with valid provider', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        node_id: 'good-prov-node',
        task_description: 'Task with valid provider',
        provider: 'codex'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Task Added');
    });

    it('accepts add_workflow_task without provider override', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        node_id: 'no-prov-node',
        task_description: 'Task with default provider'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Task Added');
    });
  });
});


// ═══════════════════════════════════════════════════════════════════
// Item 22: Retry metadata preserves user_provider_override correctly
// ═══════════════════════════════════════════════════════════════════

describe('Item 22: buildRetryMetadata provider override preservation', () => {
  const mockTaskCore = {
    countTasks: vi.fn(),
    createTask: vi.fn(),
    deleteTask: vi.fn(),
    getTask: vi.fn(),
    listTasks: vi.fn(),
    updateTask: vi.fn(),
    updateTaskStatus: vi.fn(),
  };
  const mockProviderRoutingCore = {
    getDefaultProvider: vi.fn(),
    getProvider: vi.fn(),
  };
  const mockFileTracking = {
    getTaskFileChanges: vi.fn(),
  };

  const mockConfig = { getInt: vi.fn() };
  const mockUuidV4 = vi.fn();
  const mockControlPlane = {
    sendSuccess: vi.fn(),
    sendError: vi.fn(),
    sendList: vi.fn(),
    resolveRequestId: vi.fn(),
    buildTaskResponse: vi.fn(),
    buildTaskDetailResponse: vi.fn(),
  };
  const mockMiddleware = { parseBody: vi.fn() };
  const mockPipeline = { handleCommitTask: vi.fn() };
  const mockTaskLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const mockLoggerModule = { child: vi.fn(() => mockTaskLogger) };
  const mockConstants = { PROVIDER_DEFAULT_TIMEOUTS: { codex: 45, ollama: 60 } };

  vi.mock('uuid', () => ({ v4: mockUuidV4 }));
  vi.mock('../db/task-core', () => mockTaskCore);
  vi.mock('../db/provider/routing-core', () => mockProviderRoutingCore);
  vi.mock('../db/file-tracking', () => mockFileTracking);
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
    installCjsModuleMock('../db/task-core', mockTaskCore);
    installCjsModuleMock('../db/provider/routing-core', mockProviderRoutingCore);
    installCjsModuleMock('../db/file-tracking', mockFileTracking);
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
    try { return JSON.parse(value); } catch { return {}; }
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

  function createReq(overrides = {}) {
    return { params: {}, query: {}, requestId: 'req-retry', headers: {}, ...overrides };
  }
  function createRes() { return {}; }

  function resetMockDefaults() {
    mockTaskCore.countTasks.mockReturnValue(0);
    mockTaskCore.createTask.mockReturnValue(undefined);
    mockTaskCore.getTask.mockReturnValue(null);
    mockTaskCore.listTasks.mockReturnValue([]);
    mockTaskCore.updateTask.mockImplementation((id, fields) => ({ id, ...fields }));
    mockTaskCore.updateTaskStatus.mockImplementation((id, status, fields = {}) => ({ id, status, ...fields }));
    mockProviderRoutingCore.getDefaultProvider.mockReturnValue('codex');
    mockProviderRoutingCore.getProvider.mockReturnValue({ enabled: true });
    mockFileTracking.getTaskFileChanges.mockReturnValue([]);
    mockConfig.getInt.mockImplementation((key, fallback) => fallback);
    mockUuidV4.mockReturnValue('retry-id');
    mockControlPlane.resolveRequestId.mockImplementation((req) => req?.requestId || 'req-default');
    mockControlPlane.buildTaskResponse.mockImplementation(buildTaskSummary);
    mockControlPlane.buildTaskDetailResponse.mockImplementation(buildTaskSummary);
    mockMiddleware.parseBody.mockResolvedValue({});
    mockPipeline.handleCommitTask.mockReturnValue({ isError: false, content: [{ text: 'ok' }] });
    mockTaskManager.startTask.mockReturnValue({ queued: false });
    mockTaskManager.cancelTask.mockReturnValue(undefined);
    mockTaskManager.getTaskProgress.mockReturnValue(null);
    mockLoggerModule.child.mockReturnValue(mockTaskLogger);
  }

  beforeEach(() => {
    vi.resetAllMocks();
    resetMockDefaults();
    handlers = loadHandlers();
    handlers.init(mockTaskManager);
  });

  it('does NOT set user_provider_override when retrying a smart-routed task on non-default provider', async () => {
    // Task was smart-routed to deepinfra (not user-chosen) — no user_provider_override in metadata
    mockUuidV4.mockReturnValueOnce('retry-smart-1');
    mockTaskManager.startTask.mockReturnValue({ queued: false });
    mockProviderRoutingCore.getDefaultProvider.mockReturnValue('codex');
    mockTaskCore.getTask
      .mockReturnValueOnce({
        id: 'smart-routed-task',
        status: 'failed',
        task_description: 'Analyze complex code',
        working_directory: '/repo',
        timeout_minutes: 30,
        auto_approve: false,
        priority: 0,
        provider: 'deepinfra',  // Non-default, but smart-routed
        model: 'Qwen/Qwen2.5-72B-Instruct',
        metadata: '{}',  // No user_provider_override — smart routing chose this
      })
      .mockReturnValueOnce({
        id: 'retry-smart-1',
        status: 'running',
        task_description: 'Analyze complex code',
        provider: 'deepinfra',
        metadata: '{"retry_of":"smart-routed-task"}',
      });

    await handlers.handleRetryTask(
      createReq({ params: { task_id: 'smart-routed-task' } }),
      createRes(),
    );

    // The retry should NOT have user_provider_override — let smart routing re-route
    const createCall = mockTaskCore.createTask.mock.calls[0]?.[0];
    expect(createCall).toBeDefined();
    const meta = parseJson(createCall.metadata);
    expect(meta.user_provider_override).toBeUndefined();
    expect(meta.retry_of).toBe('smart-routed-task');
  });

  it('preserves user_provider_override when retrying a user-overridden task', async () => {
    mockUuidV4.mockReturnValueOnce('retry-user-1');
    mockTaskManager.startTask.mockReturnValue({ queued: false });
    mockProviderRoutingCore.getDefaultProvider.mockReturnValue('codex');
    mockTaskCore.getTask
      .mockReturnValueOnce({
        id: 'user-routed-task',
        status: 'failed',
        task_description: 'Run tests on ollama',
        working_directory: '/repo',
        timeout_minutes: 30,
        auto_approve: false,
        priority: 0,
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        metadata: '{"user_provider_override":true}',  // Explicitly user-chosen
      })
      .mockReturnValueOnce({
        id: 'retry-user-1',
        status: 'running',
        task_description: 'Run tests on ollama',
        provider: 'ollama',
        metadata: '{"retry_of":"user-routed-task","user_provider_override":true}',
      });

    await handlers.handleRetryTask(
      createReq({ params: { task_id: 'user-routed-task' } }),
      createRes(),
    );

    const createCall = mockTaskCore.createTask.mock.calls[0]?.[0];
    expect(createCall).toBeDefined();
    const meta = parseJson(createCall.metadata);
    expect(meta.user_provider_override).toBe(true);
    expect(meta.retry_of).toBe('user-routed-task');
  });

  it('sets user_provider_override when original_provider is present in metadata', async () => {
    // Task was explicitly routed, then provider-switched (has original_provider)
    mockUuidV4.mockReturnValueOnce('retry-switched-1');
    mockTaskManager.startTask.mockReturnValue({ queued: false });
    mockProviderRoutingCore.getDefaultProvider.mockReturnValue('codex');
    mockTaskCore.getTask
      .mockReturnValueOnce({
        id: 'switched-task',
        status: 'failed',
        task_description: 'Switched task',
        working_directory: '/repo',
        timeout_minutes: 30,
        auto_approve: false,
        priority: 0,
        provider: 'deepinfra',
        model: null,
        metadata: '{"original_provider":"ollama"}',  // Was explicitly on ollama, then switched
      })
      .mockReturnValueOnce({
        id: 'retry-switched-1',
        status: 'running',
        task_description: 'Switched task',
        provider: 'ollama',
        metadata: '{"retry_of":"switched-task","user_provider_override":true}',
      });

    await handlers.handleRetryTask(
      createReq({ params: { task_id: 'switched-task' } }),
      createRes(),
    );

    const createCall = mockTaskCore.createTask.mock.calls[0]?.[0];
    expect(createCall).toBeDefined();
    const meta = parseJson(createCall.metadata);
    expect(meta.user_provider_override).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════
// Item 23: pending_provider_switch in workflow lifecycle status sets
// ═══════════════════════════════════════════════════════════════════

describe('Item 23: pending_provider_switch in workflow lifecycle', () => {

  describe('getWorkflowTaskCounts includes pending_provider_switch', () => {
    // Import the function directly from shared.js
    let getWorkflowTaskCounts;

    beforeAll(() => {
      // We can require shared.js directly since getWorkflowTaskCounts is a pure function
      const shared = require('../handlers/shared');
      getWorkflowTaskCounts = shared.getWorkflowTaskCounts;
    });

    it('counts pending_provider_switch tasks in open and runnable', () => {
      const workflow = {
        tasks: [
          { id: '1', status: 'completed' },
          { id: '2', status: 'pending_provider_switch' },
          { id: '3', status: 'running' },
          { id: '4', status: 'blocked' },
        ],
      };

      const counts = getWorkflowTaskCounts(workflow);
      expect(counts.pending_provider_switch).toBe(1);
      expect(counts.open).toBe(3);  // running + blocked + pending_provider_switch
      expect(counts.runnable).toBe(2);  // running + pending_provider_switch
      expect(counts.terminal).toBe(1);  // completed
      expect(counts.total).toBe(4);
    });

    it('counts pending_provider_switch in summary-only mode', () => {
      const workflow = {
        summary: {
          total: 5,
          completed: 2,
          running: 1,
          pending: 0,
          queued: 0,
          blocked: 1,
          pending_provider_switch: 1,
          skipped: 0,
          failed: 0,
          cancelled: 0,
        },
      };

      const counts = getWorkflowTaskCounts(workflow);
      expect(counts.pending_provider_switch).toBe(1);
      expect(counts.open).toBe(3);  // running + blocked + pending_provider_switch
      expect(counts.runnable).toBe(2);  // running + pending_provider_switch
    });

    it('returns 0 for pending_provider_switch when none exist', () => {
      const workflow = {
        tasks: [
          { id: '1', status: 'completed' },
          { id: '2', status: 'running' },
        ],
      };

      const counts = getWorkflowTaskCounts(workflow);
      expect(counts.pending_provider_switch).toBe(0);
      expect(counts.open).toBe(1);  // running only
    });
  });

  // Integration test skipped: db.resetForTest not exported via CJS require path.
  // cancelDependentTasks coverage is in workflow-runtime.test.js unit tests instead.
  // SKIP REASON: db.resetForTest is not exported via the CJS require path used here.
  // This test needs the DI container's resetForTest() which is only accessible via
  // container.get('db'). cancelDependentTasks has unit test coverage in
  // workflow-runtime.test.js instead. Unskip when DI migration is complete.
  describe.skip('cancelDependentTasks cancels pending_provider_switch tasks', () => {
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const workflowEngine = require('../db/workflow-engine');
    const projectConfigCore = require('../db/project-config-core');
    const taskCore = require('../db/task-core');

    let testDir, origDataDir, db, mod;
    let startCalls, cancelCalls, queueCalls;
    const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
    let templateBuffer;

    function setup() {
      testDir = path.join(os.tmpdir(), `torque-vtest-item23-${Date.now()}-${randomUUID().slice(0, 8)}`);
      fs.mkdirSync(testDir, { recursive: true });
      origDataDir = process.env.TORQUE_DATA_DIR;
      process.env.TORQUE_DATA_DIR = testDir;

      db = require('../database');
      if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
      db.resetForTest(templateBuffer);
      mod = require('../execution/workflow-runtime');
      initRuntime();
    }

    function initRuntime() {
      startCalls = [];
      cancelCalls = [];
      queueCalls = [];

      mod.init({
        db,
        startTask: (taskId) => { startCalls.push(taskId); return { status: 'running' }; },
        cancelTask: (taskId, reason) => { cancelCalls.push({ taskId, reason }); return { status: 'cancelled' }; },
        processQueue: () => { queueCalls.push(Date.now()); },
        dashboard: { broadcast: () => {}, notifyTaskUpdated: () => {} },
      });
    }

    function teardown() {
      if (db) { try { db.close(); } catch { /* ignore */ } }
      if (testDir) {
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      if (origDataDir !== undefined) {
        process.env.TORQUE_DATA_DIR = origDataDir;
      } else {
        delete process.env.TORQUE_DATA_DIR;
      }
    }

    function createTask(overrides = {}) {
      const id = overrides.id || randomUUID();
      taskCore.createTask({
        task_description: overrides.task_description || `Task ${id.slice(0, 8)}`,
        working_directory: overrides.working_directory || testDir,
        status: overrides.status || 'pending',
        provider: overrides.provider || 'codex',
        ...overrides,
        id,
      });
      return id;
    }

    function createWorkflow(overrides = {}) {
      const id = overrides.id || randomUUID();
      workflowEngine.createWorkflow({
        id,
        name: overrides.name || `wf-${id.slice(0, 8)}`,
        status: overrides.status || 'running',
        description: overrides.description || null,
      });
      return id;
    }

    function createWorkflowTask(workflowId, nodeId, status = 'blocked', overrides = {}) {
      return createTask({
        workflow_id: workflowId,
        workflow_node_id: nodeId,
        status,
        ...overrides,
      });
    }

    function _withTaskIdDependentShape(run) {
      const original = projectConfigCore.getDependentTasks;
      projectConfigCore.getDependentTasks = (taskId) => {
        const rows = original.call(projectConfigCore, taskId);
        return rows.map(row => ({ ...row, task_id: row.task_id || row.id }));
      };
      try { run(); } finally { projectConfigCore.getDependentTasks = original; }
    }

    beforeAll(() => { setup(); });
    afterAll(() => { teardown(); });
    beforeEach(() => { initRuntime(); });

    it('cancels pending_provider_switch dependent tasks', () => {
      const workflowId = createWorkflow({ name: 'wf-cancel-pps' });
      const root = createWorkflowTask(workflowId, 'root', 'failed');
      const pps = createWorkflowTask(workflowId, 'pps-child', 'pending_provider_switch');

      // Wire dependency: pps depends on root
      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: pps,
        depends_on_task_id: root,
        on_fail: 'cancel',
      });

      mod.cancelDependentTasks(root, workflowId, 'parent failed');

      expect(taskCore.getTask(pps).status).toBe('cancelled');
    });
  });
});
