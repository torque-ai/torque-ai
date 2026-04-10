'use strict';

const MODULE_PATH = '../handlers/workflow';
const MOCKED_MODULES = [
  MODULE_PATH,
  '../database',
  '../config',
  '../task-manager',
  '../logger',
  '../db/coordination',
  '../db/provider-routing-core',
  '../db/workflow-engine',
  '../policy-engine/task-hooks',
  '../policy-engine/engine',
  '../policy-engine/shadow-enforcer',
  '../execution/workflow-runtime',
  '../handlers/shared',
  '../handlers/workflow/templates',
  '../handlers/workflow/dag',
  '../handlers/workflow/await',
  '../handlers/workflow/advanced',
  '../handlers/workflow/feature-workflow',
  'uuid',
];

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function createConfigMock(dbRef) {
  return {
    init: vi.fn(),
    get: vi.fn((key, fallback) => {
      const val = dbRef.getConfig(key);
      return val !== null && val !== undefined ? val : (fallback !== undefined ? fallback : null);
    }),
    getInt: vi.fn((key, fallback) => {
      const val = dbRef.getConfig(key);
      if (val === null || val === undefined) return fallback !== undefined ? fallback : 0;
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? (fallback !== undefined ? fallback : 0) : parsed;
    }),
    getBool: vi.fn((key) => {
      const val = dbRef.getConfig(key);
      if (val === null || val === undefined) return true;
      return val !== '0' && val !== 'false';
    }),
    isOptIn: vi.fn((key) => {
      const val = dbRef.getConfig(key);
      return val === '1' || val === 'true';
    }),
    getFloat: vi.fn(),
    getJson: vi.fn(),
    getApiKey: vi.fn(),
    hasApiKey: vi.fn(),
    getPort: vi.fn(),
  };
}

function unloadCjsModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Ignore unload misses during test setup/teardown.
  }
}

function unloadAllMocks() {
  for (const modulePath of MOCKED_MODULES) {
    unloadCjsModule(modulePath);
  }
}

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

function buildTaskCounts(status) {
  const counts = {
    completed: 0,
    running: 0,
    pending: 0,
    queued: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    total: 0,
    open: 0,
  };

  for (const task of Object.values(status?.tasks || {})) {
    if (Object.prototype.hasOwnProperty.call(counts, task.status)) {
      counts[task.status] += 1;
    }
    counts.total += 1;
    if (!['completed', 'failed', 'skipped', 'cancelled'].includes(task.status)) {
      counts.open += 1;
    }
  }

  return counts;
}

function createSharedMock(db) {
  const shared = {
    __restartGuard: null,
    __visibility: null,
    safeLimit(value, defaultValue, maxValue = 1000) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return Math.min(defaultValue, maxValue);
      }
      return Math.min(parsed, maxValue);
    },
    MAX_NAME_LENGTH: 100,
    MAX_DESCRIPTION_LENGTH: 1000,
    MAX_TASK_LENGTH: 50000,
    safeDate(value) {
      return value || null;
    },
    evaluateWorkflowVisibility: vi.fn((status) => {
      if (shared.__visibility) {
        return shared.__visibility;
      }
      const counts = buildTaskCounts(status);
      return {
        state: counts.open > 0 ? 'actionable' : 'quiet',
        label: counts.open > 0 ? 'Actionable' : 'Quiet',
        actionable: counts.open > 0,
        reason: counts.open > 0 ? 'Tasks remain active' : 'Workflow is complete',
        next_step: counts.open > 0 ? 'Use run_workflow to continue' : 'No action required',
      };
    }),
    getWorkflowRestartGuardError: vi.fn(() => shared.__restartGuard),
    getWorkflowTaskCounts: vi.fn((status) => buildTaskCounts(status)),
    ErrorCodes: {
      INVALID_PARAM: 'INVALID_PARAM',
      MISSING_REQUIRED_PARAM: 'MISSING_REQUIRED_PARAM',
      CONFLICT: 'CONFLICT',
      PARAM_TOO_LONG: 'PARAM_TOO_LONG',
      RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
      WORKFLOW_NOT_FOUND: 'WORKFLOW_NOT_FOUND',
      OPERATION_FAILED: 'OPERATION_FAILED',
      TASK_ALREADY_RUNNING: 'TASK_ALREADY_RUNNING',
      INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
    },
    makeError(code, message, details) {
      return {
        isError: true,
        error_code: code,
        content: [{ type: 'text', text: message }],
        ...(details !== undefined ? { details } : {}),
      };
    },
    formatTime(isoString) {
      if (!isoString) return 'N/A';
      return new Date(isoString).toLocaleString('en-US', { timeZone: 'America/Denver' });
    },
    requireWorkflow(workflowId) {
      if (!workflowId) return { error: shared.makeError(shared.ErrorCodes.MISSING_REQUIRED_PARAM, 'workflow_id is required') };
      const workflow = db.getWorkflow(workflowId);
      if (!workflow) return { error: shared.makeError(shared.ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow not found: ${workflowId}`) };
      return { workflow };
    },
  };

  return shared;
}

function createMockDb() {
  const workflows = new Map();
  const tasks = new Map();
  const dependencies = [];
  const workflowStatusOverrides = new Map();
  const configs = new Map([
    ['default_timeout', '30'],
    ['max_codex_concurrent', '5'],
    ['max_concurrent', '20'],
  ]);

  let placeholder = null;
  let createTaskError = null;

  const db = {
    __workflows: workflows,
    __tasks: tasks,
    __dependencies: dependencies,
    __setConfig(key, value) {
      configs.set(key, value);
    },
    __setPlaceholder(value) {
      placeholder = value;
    },
    __setCreateTaskError(error) {
      createTaskError = error;
    },
    __setWorkflowStatus(id, status) {
      workflowStatusOverrides.set(id, status);
    },
    __buildWorkflowStatus(workflowId) {
      const workflow = workflows.get(workflowId);
      if (!workflow) {
        return null;
      }

      const workflowTasks = Array.from(tasks.values())
        .filter((task) => task.workflow_id === workflowId);
      const taskMap = {};
      for (const task of workflowTasks) {
        taskMap[task.id] = {
          id: task.id,
          node_id: task.workflow_node_id,
          status: task.status,
          progress: task.progress || 0,
        };
      }

      return {
        ...workflow,
        tasks: taskMap,
      };
    },
    getConfig: vi.fn((key) => configs.get(key) ?? null),
    findEmptyWorkflowPlaceholder: vi.fn(() => placeholder),
    createWorkflow: vi.fn((workflow) => {
      workflows.set(workflow.id, {
        status: 'pending',
        created_at: '2026-03-09T00:00:00.000Z',
        description: null,
        working_directory: null,
        ...workflow,
      });
      return workflow.id;
    }),
    getWorkflow: vi.fn((workflowId) => workflows.get(workflowId) || null),
    updateWorkflow: vi.fn((workflowId, changes) => {
      const existing = workflows.get(workflowId);
      if (!existing) {
        return;
      }
      workflows.set(workflowId, { ...existing, ...changes });
    }),
    createTask: vi.fn((task) => {
      if (createTaskError) {
        throw createTaskError;
      }
      tasks.set(task.id, {
        status: 'pending',
        working_directory: null,
        priority: 0,
        tags: [],
        ...task,
      });
      return task.id;
    }),
    getTask: vi.fn((taskId) => tasks.get(taskId) || null),
    updateTaskStatus: vi.fn((taskId, status, extra = {}) => {
      const existing = tasks.get(taskId);
      if (!existing) {
        return;
      }
      tasks.set(taskId, { ...existing, status, ...extra });
    }),
    getWorkflowTasks: vi.fn((workflowId) => Array.from(tasks.values())
      .filter((task) => task.workflow_id === workflowId)),
    addTaskDependency: vi.fn((dependency) => {
      dependencies.push({ ...dependency });
    }),
    getTaskDependencies: vi.fn((taskId) => dependencies
      .filter((dependency) => dependency.task_id === taskId)),
    getWorkflowDependencies: vi.fn((workflowId) => dependencies
      .filter((dependency) => dependency.workflow_id === workflowId)),
    updateWorkflowCounts: vi.fn(),
    getWorkflowStatus: vi.fn((workflowId) => {
      if (workflowStatusOverrides.has(workflowId)) {
        return workflowStatusOverrides.get(workflowId);
      }
      return db.__buildWorkflowStatus(workflowId);
    }),
    reconcileStaleWorkflows: vi.fn(() => 0),
    listWorkflows: vi.fn(() => Array.from(workflows.values())),
    getWorkflowHistory: vi.fn(() => []),
  };

  return db;
}

function createTaskManagerMock(db) {
  return {
    startTask: vi.fn((taskId) => {
      db.updateTaskStatus(taskId, 'running', {
        started_at: '2026-03-09T00:00:00.000Z',
      });
    }),
    cancelTask: vi.fn((taskId, reason) => {
      db.updateTaskStatus(taskId, 'cancelled', {
        error_output: reason || null,
        completed_at: '2026-03-09T00:05:00.000Z',
      });
    }),
    unblockTask: vi.fn((taskId) => {
      db.updateTaskStatus(taskId, 'queued');
    }),
  };
}

function createUuidMock() {
  const state = {
    queue: [],
    counter: 0,
  };

  return {
    __setIds(...ids) {
      state.queue = ids.slice();
      state.counter = 0;
    },
    v4: vi.fn(() => {
      if (state.queue.length > 0) {
        return state.queue.shift();
      }
      state.counter += 1;
      return `generated-id-${state.counter}`;
    }),
  };
}

function createTestContext() {
  const db = createMockDb();
  const shared = createSharedMock(db);
  const workflowRuntime = {
    evaluateWorkflowDependencies: vi.fn(),
  };
  const coordination = {
    recordCoordinationEvent: vi.fn(),
  };
  const providerRoutingCore = {
    getProvider: vi.fn(() => ({ enabled: 1 })),
  };
  const taskPolicyHooks = {
    evaluateTaskSubmissionPolicy: vi.fn(() => null),
  };
  const policyEngine = {
    evaluatePolicies: vi.fn(() => ({
      summary: { blocked: 0, failed: 0, warned: 0 },
      total_results: 0,
    })),
  };
  const shadowEnforcer = {
    isEngineEnabled: vi.fn(() => false),
    isShadowOnly: vi.fn(() => false),
  };
  const featureWorkflow = {
    init: vi.fn(),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger.child = vi.fn(() => logger);
  const taskManager = createTaskManagerMock(db);
  const uuid = createUuidMock();

  installCjsModuleMock('../database', db);
  installCjsModuleMock('../config', createConfigMock(db));
  installCjsModuleMock('../task-manager', taskManager);
  installCjsModuleMock('../logger', logger);
  installCjsModuleMock('../db/coordination', coordination);
  installCjsModuleMock('../db/provider-routing-core', providerRoutingCore);
  installCjsModuleMock('../db/workflow-engine', db);
  installCjsModuleMock('../policy-engine/task-hooks', taskPolicyHooks);
  installCjsModuleMock('../policy-engine/engine', policyEngine);
  installCjsModuleMock('../policy-engine/shadow-enforcer', shadowEnforcer);
  installCjsModuleMock('../execution/workflow-runtime', workflowRuntime);
  installCjsModuleMock('../handlers/shared', shared);
  installCjsModuleMock('../handlers/workflow/templates', {});
  installCjsModuleMock('../handlers/workflow/dag', {});
  installCjsModuleMock('../handlers/workflow/await', {});
  installCjsModuleMock('../handlers/workflow/advanced', {});
  installCjsModuleMock('../handlers/workflow/feature-workflow', featureWorkflow);
  installCjsModuleMock('uuid', { v4: uuid.v4 });

  delete require.cache[require.resolve(MODULE_PATH)];
  const handlers = require(MODULE_PATH);

  return {
    db,
    handlers,
    logger,
    shared,
    taskManager,
    workflowRuntime,
    uuid,
  };
}

function seedWorkflow(db, overrides = {}) {
  const workflow = {
    id: overrides.id || `wf-${db.__workflows.size + 1}`,
    name: 'Workflow Under Test',
    status: 'pending',
    description: null,
    working_directory: '/repo',
    ...overrides,
  };
  db.createWorkflow(workflow);
  return db.getWorkflow(workflow.id);
}

function seedTask(db, overrides = {}) {
  const task = {
    id: overrides.id || `task-${db.__tasks.size + 1}`,
    task_description: 'Task under test',
    status: 'pending',
    working_directory: '/repo',
    workflow_id: null,
    workflow_node_id: null,
    provider: null,
    progress: 0,
    ...overrides,
  };
  db.createTask(task);
  return db.getTask(task.id);
}

function seedDependency(db, overrides = {}) {
  const dependency = {
    workflow_id: overrides.workflow_id || null,
    task_id: overrides.task_id,
    depends_on_task_id: overrides.depends_on_task_id,
    condition_expr: overrides.condition_expr,
    on_fail: overrides.on_fail,
    alternate_task_id: overrides.alternate_task_id ?? null,
  };
  db.addTaskDependency(dependency);
  return dependency;
}

describe('server/handlers/workflow-handlers', () => {
  let ctx;

  beforeEach(() => {
    unloadAllMocks();
    ctx = createTestContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    unloadAllMocks();
  });

  describe('handleCreateWorkflow', () => {
    it('rejects workflows without a name', () => {
      const result = ctx.handlers.handleCreateWorkflow({ name: '   ' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('name must be a non-empty string');
    });

    it('rejects empty workflows when no tasks are provided', () => {
      const result = ctx.handlers.handleCreateWorkflow({ name: 'Release Flow' });

      expect(ctx.db.findEmptyWorkflowPlaceholder).toHaveBeenCalledWith('Release Flow', 'pending');
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('must include at least one task');
    });

    it('returns a conflict when a matching empty placeholder already exists', () => {
      ctx.db.__setPlaceholder({
        id: 'wf-placeholder',
        status: 'pending',
      });

      const result = ctx.handlers.handleCreateWorkflow({ name: 'Release Flow' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('CONFLICT');
      expect(textOf(result)).toContain('wf-placeholder');
      expect(textOf(result)).toContain('empty pending placeholder');
    });

    it('rejects non-object task definitions', () => {
      const result = ctx.handlers.handleCreateWorkflow({
        name: 'Release Flow',
        tasks: [null],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('tasks[0] must be an object');
    });

    it('rejects duplicate node ids in the initial DAG', () => {
      const result = ctx.handlers.handleCreateWorkflow({
        name: 'Release Flow',
        tasks: [
          { node_id: 'build', task_description: 'Build artifact' },
          { node_id: 'build', task_description: 'Run tests' },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('CONFLICT');
      expect(textOf(result)).toContain("Duplicate workflow node_id 'build'");
    });

    it('rejects missing dependency nodes in the initial DAG', () => {
      const result = ctx.handlers.handleCreateWorkflow({
        name: 'Release Flow',
        tasks: [
          {
            node_id: 'deploy',
            task_description: 'Deploy artifact',
            depends_on: ['build'],
          },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(textOf(result)).toContain('Dependency not found: build');
    });

    it('rejects circular dependencies in the initial DAG', () => {
      const result = ctx.handlers.handleCreateWorkflow({
        name: 'Release Flow',
        tasks: [
          {
            node_id: 'build',
            task_description: 'Build artifact',
            depends_on: ['deploy'],
          },
          {
            node_id: 'deploy',
            task_description: 'Deploy artifact',
            depends_on: ['build'],
          },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('Circular dependency detected');
    });

    it('creates a seeded workflow with dependency metadata, timeouts, and alternate mappings', () => {
      ctx.uuid.__setIds('wf-1', 'task-build', 'task-review', 'task-deploy');
      ctx.db.__setConfig('default_timeout', '15');

      const result = ctx.handlers.handleCreateWorkflow({
        name: '  Release Flow  ',
        description: 'Ship the release',
        priority: 9,
        working_directory: '/repo',
        tasks: [
          {
            node_id: 'build',
            task_description: 'Build artifact',
            timeout_minutes: '10',
          },
          {
            node_id: 'review',
            task_description: 'Review release notes',
          },
          {
            node_id: 'deploy',
            task_description: 'Deploy artifact',
            depends_on: ['build'],
            condition: 'exit_code == 0',
            on_fail: 'cancel',
            alternate_node_id: 'review',
            context_from: ['build'],
          },
        ],
      });

      expect(result.isError).toBeFalsy();
      expect(ctx.db.createWorkflow).toHaveBeenCalledWith(expect.objectContaining({
        id: 'wf-1',
        name: 'Release Flow',
        description: 'Ship the release',
        priority: 9,
        working_directory: '/repo',
      }));
      expect(ctx.db.createTask).toHaveBeenCalledTimes(3);
      expect(ctx.db.__tasks.get('task-build')).toEqual(expect.objectContaining({
        task_description: 'Build artifact',
        timeout_minutes: 10,
        status: 'pending',
      }));
      expect(ctx.db.__tasks.get('task-deploy')).toEqual(expect.objectContaining({
        status: 'blocked',
        timeout_minutes: 15,
        metadata: JSON.stringify({ context_from: ['build'] }),
      }));
      expect(ctx.db.__dependencies).toEqual([
        expect.objectContaining({
          workflow_id: 'wf-1',
          task_id: 'task-deploy',
          depends_on_task_id: 'task-build',
          condition_expr: 'exit_code == 0',
          on_fail: 'cancel',
          alternate_task_id: 'task-review',
        }),
      ]);
      expect(ctx.db.updateWorkflowCounts).toHaveBeenCalledWith('wf-1');
      expect(textOf(result)).toContain('Workflow Created');
      expect(textOf(result)).toContain('**Tasks:** 3');
    });
  });

  describe('handleAddWorkflowTask', () => {
    it('returns WORKFLOW_NOT_FOUND when the parent workflow is missing', () => {
      const result = ctx.handlers.handleAddWorkflowTask({
        workflow_id: 'wf-missing',
        node_id: 'build',
        task_description: 'Build artifact',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
      expect(textOf(result)).toContain('Workflow not found');
    });

    it('rejects dependency lists that contain non-string node ids', () => {
      const result = ctx.handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'build',
        task_description: 'Build artifact',
        depends_on: ['setup', 42],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('depends_on elements must be strings');
    });

    it('wraps task creation failures as OPERATION_FAILED', () => {
      seedWorkflow(ctx.db, { id: 'wf-1' });
      ctx.db.__setCreateTaskError(new Error('disk full'));

      const result = ctx.handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'build',
        task_description: 'Build artifact',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(textOf(result)).toContain('Failed to create task: disk full');
    });

    it('returns RESOURCE_NOT_FOUND when a dependency node is missing', () => {
      seedWorkflow(ctx.db, { id: 'wf-1' });
      ctx.uuid.__setIds('task-new');

      const result = ctx.handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'deploy',
        task_description: 'Deploy artifact',
        depends_on: ['build'],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(textOf(result)).toContain('Dependency not found: build');
      expect(ctx.db.addTaskDependency).not.toHaveBeenCalled();
    });

    it('rejects tasks that would create a circular dependency', () => {
      seedWorkflow(ctx.db, { id: 'wf-1' });
      seedTask(ctx.db, {
        id: 'task-a',
        workflow_id: 'wf-1',
        workflow_node_id: 'A',
      });
      seedTask(ctx.db, {
        id: 'task-b',
        workflow_id: 'wf-1',
        workflow_node_id: 'B',
      });
      seedDependency(ctx.db, {
        workflow_id: 'wf-1',
        task_id: 'task-a',
        depends_on_task_id: 'task-b',
      });
      ctx.uuid.__setIds('task-new');

      const result = ctx.handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'B',
        task_description: 'Cycle candidate',
        depends_on: ['A'],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('Circular dependency detected');
      expect(ctx.db.addTaskDependency).toHaveBeenCalledTimes(1);
    });

    it('creates dependency metadata and alternate mappings using the full task prompt', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        status: 'pending',
        working_directory: '/repo',
      });
      seedTask(ctx.db, {
        id: 'task-a',
        workflow_id: 'wf-1',
        workflow_node_id: 'node-a',
      });
      seedTask(ctx.db, {
        id: 'task-alt',
        workflow_id: 'wf-1',
        workflow_node_id: 'node-alt',
      });
      ctx.uuid.__setIds('task-b');
      ctx.db.__setConfig('default_timeout', '45');

      const result = ctx.handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'node-b',
        task: 'Use the full prompt',
        task_description: 'Short label',
        depends_on: ['node-a'],
        condition: 'exit_code == 0',
        on_fail: 'cancel',
        alternate_node_id: 'node-alt',
        context_from: ['node-a'],
        tags: ['release'],
      });

      expect(result.isError).toBeFalsy();
      expect(ctx.db.__tasks.get('task-b')).toEqual(expect.objectContaining({
        task_description: 'Use the full prompt',
        status: 'blocked',
        timeout_minutes: 45,
        metadata: JSON.stringify({ context_from: ['node-a'] }),
        tags: ['release'],
      }));
      expect(ctx.db.__dependencies).toContainEqual(expect.objectContaining({
        workflow_id: 'wf-1',
        task_id: 'task-b',
        depends_on_task_id: 'task-a',
        condition_expr: 'exit_code == 0',
        on_fail: 'cancel',
        alternate_task_id: 'task-alt',
      }));
      expect(ctx.db.updateWorkflowCounts).toHaveBeenCalledWith('wf-1');
      expect(textOf(result)).toContain('Depends On');
      expect(textOf(result)).toContain('Context From');
    });

    it('starts dependency-free tasks immediately in a running workflow', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        status: 'running',
      });
      ctx.uuid.__setIds('task-run-now');

      const result = ctx.handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'run-now',
        task_description: 'Run immediately',
      });

      expect(result.isError).toBeFalsy();
      expect(ctx.taskManager.startTask).toHaveBeenCalledWith('task-run-now');
      expect(ctx.workflowRuntime.evaluateWorkflowDependencies).not.toHaveBeenCalled();
      expect(ctx.db.__tasks.get('task-run-now').status).toBe('running');
      expect(textOf(result)).toContain('**Status:** running');
    });

    it('records start failures when immediate task start throws', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        status: 'running',
      });
      ctx.uuid.__setIds('task-run-now');
      ctx.taskManager.startTask.mockImplementationOnce(() => {
        throw new Error('capacity');
      });

      const result = ctx.handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'run-now',
        task_description: 'Run immediately',
      });

      expect(result.isError).toBeFalsy();
      expect(result.start_failures).toEqual([
        expect.objectContaining({
          task_id: 'task-run-now',
          node_id: 'run-now',
          error: 'capacity',
        }),
      ]);
      expect(ctx.logger.debug).toHaveBeenCalled();
      expect(ctx.db.__tasks.get('task-run-now').status).toBe('pending');
      expect(textOf(result)).toContain('Start Failures');
    });

    it('reopens failed workflows and unblocks tasks when dependencies are terminal', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        status: 'failed',
        completed_at: '2026-03-08T10:00:00.000Z',
      });
      seedTask(ctx.db, {
        id: 'task-a',
        workflow_id: 'wf-1',
        workflow_node_id: 'node-a',
        status: 'completed',
      });
      ctx.uuid.__setIds('task-b');

      const result = ctx.handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'node-b',
        task_description: 'Recover workflow',
        depends_on: ['node-a'],
      });

      expect(result.isError).toBeFalsy();
      expect(ctx.db.updateWorkflow).toHaveBeenCalledWith('wf-1', {
        status: 'running',
        completed_at: null,
      });
      expect(ctx.taskManager.unblockTask).toHaveBeenCalledWith('task-b');
      expect(ctx.db.getWorkflow('wf-1').status).toBe('running');
      expect(ctx.db.__tasks.get('task-b').status).toBe('queued');
      expect(textOf(result)).toContain('**Status:** queued');
    });
  });

  describe('handleCloneWorkflow', () => {
    it('clones workflow tasks and dependency edges into a fresh workflow instance', () => {
      const sourceWorkflow = seedWorkflow(ctx.db, {
        id: 'wf-source',
        name: 'example-project Ollama Autodev Loop',
        description: 'Original source workflow',
        working_directory: 'C:\\Users\\<os-user>\\Projects\\example-project-autodev',
        priority: 7,
        context: { project: 'example-project-autodev' },
      });
      const planTask = seedTask(ctx.db, {
        id: 'task-plan',
        workflow_id: sourceWorkflow.id,
        workflow_node_id: 'plan',
        status: 'completed',
        task_description: 'Plan the next iteration',
        working_directory: 'C:\\Users\\<os-user>\\Projects\\example-project-autodev',
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        tags: ['autodev', 'planning'],
        priority: 5,
        max_retries: 4,
        metadata: { context_from: ['seed'] },
      });
      const executeTask = seedTask(ctx.db, {
        id: 'task-execute',
        workflow_id: sourceWorkflow.id,
        workflow_node_id: 'execute',
        status: 'failed',
        task_description: 'Implement the planned change',
        working_directory: 'C:\\Users\\<os-user>\\Projects\\example-project-autodev',
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        tags: ['autodev', 'execution'],
        priority: 4,
        metadata: { user_provider_override: true },
      });
      const reportTask = seedTask(ctx.db, {
        id: 'task-report',
        workflow_id: sourceWorkflow.id,
        workflow_node_id: 'report',
        status: 'blocked',
        task_description: 'Summarize the results',
        working_directory: 'C:\\Users\\<os-user>\\Projects\\example-project-autodev',
        provider: null,
        model: null,
        tags: ['autodev', 'reporting'],
        metadata: {},
      });

      seedDependency(ctx.db, {
        workflow_id: sourceWorkflow.id,
        task_id: executeTask.id,
        depends_on_task_id: planTask.id,
        condition_expr: 'exit_code == 0',
        on_fail: 'skip',
      });
      seedDependency(ctx.db, {
        workflow_id: sourceWorkflow.id,
        task_id: reportTask.id,
        depends_on_task_id: executeTask.id,
        condition_expr: 'status == "completed"',
        on_fail: 'run_alternate',
        alternate_task_id: planTask.id,
      });

      ctx.uuid.__setIds('wf-cloned', 'task-plan-cloned', 'task-execute-cloned', 'task-report-cloned');

      const result = ctx.handlers.handleCloneWorkflow({
        source_workflow_id: 'wf-source',
        name: 'example-project Ollama Autodev Loop Clone',
        context: {
          _scheduled_origin: {
            schedule_id: 'schedule-dlphone',
          },
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.workflow_id).toBe('wf-cloned');
      expect(textOf(result)).toContain('Workflow Cloned');

      const clonedWorkflow = ctx.db.getWorkflow('wf-cloned');
      expect(clonedWorkflow).toEqual(expect.objectContaining({
        id: 'wf-cloned',
        name: 'example-project Ollama Autodev Loop Clone',
        description: 'Original source workflow',
        working_directory: 'C:\\Users\\<os-user>\\Projects\\example-project-autodev',
        priority: 7,
        template_id: null,
        context: expect.objectContaining({
          project: 'example-project-autodev',
          _scheduled_origin: { schedule_id: 'schedule-dlphone' },
          _cloned_from_workflow_id: 'wf-source',
        }),
      }));

      expect(ctx.db.getTask('task-plan-cloned')).toEqual(expect.objectContaining({
        workflow_id: 'wf-cloned',
        workflow_node_id: 'plan',
        status: 'pending',
        task_description: 'Plan the next iteration',
        project: 'example-project-autodev',
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        tags: ['autodev', 'planning'],
        priority: 5,
        max_retries: 4,
        metadata: { context_from: ['seed'] },
      }));
      expect(ctx.db.getTask('task-execute-cloned')).toEqual(expect.objectContaining({
        workflow_id: 'wf-cloned',
        workflow_node_id: 'execute',
        status: 'blocked',
        task_description: 'Implement the planned change',
        project: 'example-project-autodev',
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        tags: ['autodev', 'execution'],
        priority: 4,
        metadata: { user_provider_override: true },
      }));
      expect(ctx.db.getTask('task-report-cloned')).toEqual(expect.objectContaining({
        workflow_id: 'wf-cloned',
        workflow_node_id: 'report',
        status: 'blocked',
        task_description: 'Summarize the results',
        project: 'example-project-autodev',
        tags: ['autodev', 'reporting'],
      }));

      expect(ctx.db.__dependencies).toContainEqual(expect.objectContaining({
        workflow_id: 'wf-cloned',
        task_id: 'task-execute-cloned',
        depends_on_task_id: 'task-plan-cloned',
        condition_expr: 'exit_code == 0',
        on_fail: 'skip',
      }));
      expect(ctx.db.__dependencies).toContainEqual(expect.objectContaining({
        workflow_id: 'wf-cloned',
        task_id: 'task-report-cloned',
        depends_on_task_id: 'task-execute-cloned',
        condition_expr: 'status == "completed"',
        on_fail: 'run_alternate',
        alternate_task_id: 'task-plan-cloned',
      }));
      expect(ctx.db.updateWorkflowCounts).toHaveBeenCalledWith('wf-cloned');
    });
  });

  describe('handleRunWorkflow', () => {
    it('returns WORKFLOW_NOT_FOUND when the workflow does not exist', () => {
      const result = ctx.handlers.handleRunWorkflow({ workflow_id: 'wf-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
      expect(textOf(result)).toContain('Workflow not found');
    });

    it('prevents starting an already-running workflow', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        status: 'running',
      });

      const result = ctx.handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_ALREADY_RUNNING');
      expect(textOf(result)).toContain('Workflow already running');
    });

    it('returns restart guard errors before starting tasks', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        status: 'paused',
      });
      ctx.shared.__restartGuard = ctx.shared.makeError(
        ctx.shared.ErrorCodes.INVALID_STATUS_TRANSITION,
        'restart blocked'
      );

      const result = ctx.handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
      expect(textOf(result)).toContain('restart blocked');
      expect(ctx.taskManager.startTask).not.toHaveBeenCalled();
    });

    it('rejects workflows that have no tasks', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        status: 'pending',
      });

      const result = ctx.handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('has no tasks');
    });

    it('attempts every runnable pending task and lets startTask queue exact-provider overflow', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        name: 'Concurrency Flow',
        status: 'paused',
      });
      seedTask(ctx.db, {
        id: 't1',
        workflow_id: 'wf-1',
        workflow_node_id: 'build',
        status: 'pending',
        provider: 'codex',
      });
      seedTask(ctx.db, {
        id: 't2',
        workflow_id: 'wf-1',
        workflow_node_id: 'test',
        status: 'pending',
        provider: 'codex',
      });
      seedTask(ctx.db, {
        id: 't3',
        workflow_id: 'wf-1',
        workflow_node_id: 'deploy',
        status: 'pending',
        provider: 'openai',
      });
      seedTask(ctx.db, {
        id: 't4',
        workflow_id: 'wf-1',
        workflow_node_id: 'review',
        status: 'blocked',
        provider: 'openai',
      });
      ctx.db.__setConfig('max_codex_concurrent', '1');
      ctx.db.__setConfig('max_concurrent', '2');
      ctx.taskManager.startTask
        .mockImplementationOnce((taskId) => {
          ctx.db.updateTaskStatus(taskId, 'running', {
            started_at: '2026-03-09T00:00:00.000Z',
          });
        })
        .mockImplementationOnce((taskId) => {
          ctx.db.updateTaskStatus(taskId, 'queued');
          return { queued: true };
        })
        .mockImplementationOnce((taskId) => {
          ctx.db.updateTaskStatus(taskId, 'running', {
            started_at: '2026-03-09T00:00:00.000Z',
          });
        });

      const result = ctx.handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBeFalsy();
      expect(ctx.db.updateWorkflow).toHaveBeenCalledWith('wf-1', expect.objectContaining({
        status: 'running',
        started_at: expect.any(String),
      }));
      expect(ctx.taskManager.startTask).toHaveBeenNthCalledWith(1, 't1');
      expect(ctx.taskManager.startTask).toHaveBeenNthCalledWith(2, 't2');
      expect(ctx.taskManager.startTask).toHaveBeenNthCalledWith(3, 't3');
      expect(ctx.db.__tasks.get('t2').status).toBe('queued');
      expect(textOf(result)).toContain('**Tasks Started:** 2');
      expect(textOf(result)).toContain('**Tasks Queued:** 1');
      expect(textOf(result)).toContain('**Blocked Tasks:** 1');
    });

    it('returns OPERATION_FAILED when every task start attempt fails', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        name: 'Broken Flow',
        status: 'pending',
      });
      seedTask(ctx.db, {
        id: 't1',
        workflow_id: 'wf-1',
        workflow_node_id: 'build',
        status: 'pending',
      });
      seedTask(ctx.db, {
        id: 't2',
        workflow_id: 'wf-1',
        workflow_node_id: 'test',
        status: 'pending',
      });
      ctx.taskManager.startTask.mockImplementation(() => {
        throw new Error('capacity');
      });

      const result = ctx.handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(textOf(result)).toContain("Failed to start workflow 'Broken Flow'");
      expect(result.details).toHaveLength(2);
      expect(ctx.logger.debug).toHaveBeenCalledTimes(2);
    });

    it('returns OPERATION_FAILED when a start attempt leaves the task pending', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        name: 'Stuck Flow',
        status: 'pending',
      });
      seedTask(ctx.db, {
        id: 't1',
        workflow_id: 'wf-1',
        workflow_node_id: 'plan',
        status: 'pending',
      });
      ctx.taskManager.startTask.mockImplementation(() => Promise.resolve());

      const result = ctx.handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(textOf(result)).toContain("Failed to start workflow 'Stuck Flow'");
      expect(result.details).toEqual([
        expect.objectContaining({
          task_id: 't1',
          node_id: 'plan',
          error: 'Task remained pending after start attempt',
        }),
      ]);
    });

    it('treats instantly completed tasks as started for workflow launch accounting', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        name: 'Noop Plan Flow',
        status: 'pending',
      });
      seedTask(ctx.db, {
        id: 't1',
        workflow_id: 'wf-1',
        workflow_node_id: 'plan',
        status: 'pending',
      });
      seedTask(ctx.db, {
        id: 't2',
        workflow_id: 'wf-1',
        workflow_node_id: 'execute',
        status: 'blocked',
      });
      ctx.taskManager.startTask.mockImplementation((taskId) => {
        ctx.db.updateTaskStatus(taskId, 'completed');
      });

      const result = ctx.handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('**Tasks Started:** 1');
      expect(textOf(result)).toContain('**Blocked Tasks:** 1');
      expect(ctx.db.__tasks.get('t1').status).toBe('completed');
    });

    it('reports partial start failures and continues starting later tasks', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        name: 'Partial Flow',
        status: 'pending',
      });
      seedTask(ctx.db, {
        id: 't1',
        workflow_id: 'wf-1',
        workflow_node_id: 'build',
        status: 'pending',
        provider: 'codex',
      });
      seedTask(ctx.db, {
        id: 't2',
        workflow_id: 'wf-1',
        workflow_node_id: 'deploy',
        status: 'pending',
        provider: 'openai',
      });
      ctx.taskManager.startTask
        .mockImplementationOnce(() => {
          throw new Error('capacity');
        })
        .mockImplementation((taskId) => {
          ctx.db.updateTaskStatus(taskId, 'running');
        });

      const result = ctx.handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBeFalsy();
      expect(result.start_failures).toEqual([
        expect.objectContaining({
          task_id: 't1',
          node_id: 'build',
          error: 'capacity',
        }),
      ]);
      expect(ctx.db.__tasks.get('t2').status).toBe('running');
      expect(textOf(result)).toContain('**Tasks Failed to Start:** 1');
      expect(textOf(result)).toContain('- build: capacity');
    });
  });

  describe('handleWorkflowStatus', () => {
    it('returns WORKFLOW_NOT_FOUND when the workflow status payload is missing', () => {
      const result = ctx.handlers.handleWorkflowStatus({ workflow_id: 'wf-missing' });

      expect(ctx.db.reconcileStaleWorkflows).toHaveBeenCalledWith('wf-missing');
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('renders workflow visibility, counts, and task rows', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        name: 'Release Flow',
        status: 'running',
        started_at: '2026-03-09T12:00:00.000Z',
      });
      seedTask(ctx.db, {
        id: 't1',
        workflow_id: 'wf-1',
        workflow_node_id: 'build',
        status: 'completed',
        progress: 100,
      });
      seedTask(ctx.db, {
        id: 't2',
        workflow_id: 'wf-1',
        workflow_node_id: 'test',
        status: 'running',
        progress: 50,
      });
      seedTask(ctx.db, {
        id: 't3',
        workflow_id: 'wf-1',
        workflow_node_id: 'deploy',
        status: 'blocked',
        progress: 0,
      });
      ctx.shared.__visibility = {
        state: 'actionable',
        label: 'Needs Attention',
        actionable: true,
        reason: 'Blocked by downstream dependency',
        next_step: 'Complete the running task',
      };

      const result = ctx.handlers.handleWorkflowStatus({ workflow_id: 'wf-1' });

      expect(result.isError).toBeFalsy();
      expect(ctx.db.reconcileStaleWorkflows).toHaveBeenCalledWith('wf-1');
      expect(textOf(result)).toContain('Workflow Status: Release Flow');
      expect(textOf(result)).toContain('**Visibility:** Needs Attention');
      expect(textOf(result)).toContain('**Actionable:** Yes');
      expect(textOf(result)).toContain('Blocked by downstream dependency');
      expect(textOf(result)).toContain('Complete the running task');
      expect(textOf(result)).toContain('| Completed | 1 |');
      expect(textOf(result)).toContain('| Running | 1 |');
      expect(textOf(result)).toContain('| Blocked | 1 |');
      expect(textOf(result)).toContain('| build | completed | 100% |');
      expect(textOf(result)).toContain('| test | running | 50% |');
      expect(textOf(result)).toContain('| deploy | blocked | 0% |');
    });
  });

  describe('handlePauseWorkflow', () => {
    it('returns WORKFLOW_NOT_FOUND when the workflow does not exist', () => {
      const result = ctx.handlers.handlePauseWorkflow({ workflow_id: 'wf-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('rejects pausing workflows that are not running', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        status: 'pending',
      });

      const result = ctx.handlers.handlePauseWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
      expect(textOf(result)).toContain('Workflow is not running');
    });

    it('pauses running workflows', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        name: 'Pause Flow',
        status: 'running',
      });

      const result = ctx.handlers.handlePauseWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBeFalsy();
      expect(ctx.db.updateWorkflow).toHaveBeenCalledWith('wf-1', { status: 'paused' });
      expect(ctx.db.getWorkflow('wf-1').status).toBe('paused');
      expect(textOf(result)).toContain('Workflow Paused');
      expect(textOf(result)).toContain('Pause Flow');
    });
  });

  describe('handleCancelWorkflow', () => {
    it('returns WORKFLOW_NOT_FOUND when the workflow does not exist', () => {
      const result = ctx.handlers.handleCancelWorkflow({ workflow_id: 'wf-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('cancels running and queued work while leaving completed tasks untouched', () => {
      seedWorkflow(ctx.db, {
        id: 'wf-1',
        name: 'Cancel Flow',
        status: 'running',
      });
      seedTask(ctx.db, {
        id: 't-running',
        workflow_id: 'wf-1',
        workflow_node_id: 'build',
        status: 'running',
      });
      seedTask(ctx.db, {
        id: 't-pending',
        workflow_id: 'wf-1',
        workflow_node_id: 'test',
        status: 'pending',
      });
      seedTask(ctx.db, {
        id: 't-blocked',
        workflow_id: 'wf-1',
        workflow_node_id: 'review',
        status: 'blocked',
      });
      seedTask(ctx.db, {
        id: 't-queued',
        workflow_id: 'wf-1',
        workflow_node_id: 'deploy',
        status: 'queued',
      });
      seedTask(ctx.db, {
        id: 't-done',
        workflow_id: 'wf-1',
        workflow_node_id: 'cleanup',
        status: 'completed',
      });

      const result = ctx.handlers.handleCancelWorkflow({
        workflow_id: 'wf-1',
        reason: 'operator request',
      });

      expect(result.isError).toBeFalsy();
      expect(ctx.taskManager.cancelTask).toHaveBeenCalledWith('t-running', 'operator request');
      expect(ctx.db.__tasks.get('t-pending').status).toBe('cancelled');
      expect(ctx.db.__tasks.get('t-blocked').status).toBe('cancelled');
      expect(ctx.db.__tasks.get('t-queued').status).toBe('cancelled');
      expect(ctx.db.__tasks.get('t-done').status).toBe('completed');
      expect(ctx.db.updateWorkflow).toHaveBeenCalledWith('wf-1', expect.objectContaining({
        status: 'cancelled',
        completed_at: expect.any(String),
      }));
      expect(textOf(result)).toContain('Workflow Cancelled');
      expect(textOf(result)).toContain('**Tasks Cancelled:** 4');
      expect(textOf(result)).toContain('operator request');
    });
  });
});
