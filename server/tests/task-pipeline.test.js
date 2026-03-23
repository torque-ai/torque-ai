'use strict';

const pipelineHandlersPath = require.resolve('../handlers/task/pipeline');

let currentModules = {};

const originalCacheEntries = new Map();

vi.mock('../database', () => currentModules.db);
vi.mock('../task-manager', () => currentModules.taskManager);
vi.mock('../logger', () => currentModules.loggerModule);
vi.mock('../handlers/task/utils', () => currentModules.taskUtilsModule);
vi.mock('uuid', () => currentModules.uuidModule);
vi.mock('child_process', () => currentModules.childProcessModule);

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  if (!originalCacheEntries.has(resolved)) {
    originalCacheEntries.set(resolved, require.cache[resolved]);
  }
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
  } catch {}
}

function restoreMockedModules() {
  for (const [resolved, originalEntry] of originalCacheEntries.entries()) {
    if (originalEntry) {
      require.cache[resolved] = originalEntry;
    } else {
      delete require.cache[resolved];
    }
  }
  originalCacheEntries.clear();
}

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

function makeTask(overrides = {}) {
  return {
    id: overrides.id || '11111111-1111-1111-1111-111111111111',
    status: overrides.status || 'failed',
    task_description: overrides.task_description || 'Run verification',
    working_directory: overrides.working_directory || '/repo',
    timeout_minutes: overrides.timeout_minutes || 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 2,
    template_name: overrides.template_name || null,
    context: overrides.context || null,
    ...overrides,
  };
}

function makeStep(overrides = {}) {
  return {
    id: overrides.id || 'step-1',
    step_order: overrides.step_order || 1,
    name: overrides.name || 'Verify',
    task_template: overrides.task_template || 'npm run verify',
    timeout_minutes: overrides.timeout_minutes || 30,
    condition: overrides.condition || 'on_success',
    status: overrides.status || 'pending',
    task_id: overrides.task_id || null,
    ...overrides,
  };
}

function makePipeline(overrides = {}) {
  return {
    id: overrides.id || 'pipeline-1',
    name: overrides.name || 'Verify Fix Retry',
    description: overrides.description ?? null,
    working_directory: overrides.working_directory || '/repo',
    status: overrides.status || 'pending',
    current_step: overrides.current_step || 0,
    started_at: overrides.started_at || null,
    completed_at: overrides.completed_at || null,
    error: overrides.error || null,
    created_at: overrides.created_at || '2026-03-12T12:00:00.000Z',
    steps: overrides.steps || [],
    ...overrides,
  };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockDb(options = {}) {
  const tasks = new Map(Object.entries(options.tasks || {}));
  const pipelines = new Map(
    Object.entries(options.pipelines || {}).map(([id, pipeline]) => [
      id,
      {
        ...pipeline,
        steps: (pipeline.steps || []).map((step) => ({ ...step })),
      },
    ]),
  );

  const db = {
    __stores: { tasks, pipelines },
    createTask: vi.fn((payload) => {
      const task = { ...payload };
      tasks.set(task.id, task);
      return task;
    }),
    getTask: vi.fn((taskId) => tasks.get(taskId) ?? null),
    createPipeline: vi.fn((payload) => {
      const pipeline = {
        status: 'pending',
        current_step: 0,
        started_at: null,
        completed_at: null,
        error: null,
        created_at: '2026-03-12T12:00:00.000Z',
        steps: [],
        ...payload,
      };
      pipelines.set(pipeline.id, pipeline);
      return pipeline;
    }),
    addPipelineStep: vi.fn((payload) => {
      const pipeline = pipelines.get(payload.pipeline_id);
      if (!pipeline) return payload;
      const step = {
        id: payload.id || `step-${payload.step_order}`,
        status: 'pending',
        task_id: null,
        ...payload,
      };
      pipeline.steps.push(step);
      pipeline.steps.sort((left, right) => left.step_order - right.step_order);
      return step;
    }),
    getPipeline: vi.fn((pipelineId) => pipelines.get(pipelineId) ?? null),
    updatePipelineStatus: vi.fn((pipelineId, status, updates = {}) => {
      const pipeline = pipelines.get(pipelineId);
      if (pipeline) {
        pipeline.status = status;
        Object.assign(pipeline, updates);
      }
      return pipeline ?? null;
    }),
    updatePipelineStep: vi.fn((stepId, updates) => {
      for (const pipeline of pipelines.values()) {
        const step = pipeline.steps.find((candidate) => candidate.id === stepId);
        if (step) {
          Object.assign(step, updates);
          return step;
        }
      }
      return null;
    }),
    recordEvent: vi.fn(),
    listPipelines: vi.fn(({ status, limit } = {}) => {
      let list = Array.from(pipelines.values());
      if (status) {
        list = list.filter((pipeline) => pipeline.status === status);
      }
      return list.slice(0, limit ?? 20);
    }),
  };

  if (options.methods) {
    Object.assign(db, options.methods);
  }

  return db;
}

function createDefaultModules(overrides = {}) {
  let uuidCounter = 0;
  const logger = overrides.logger || createMockLogger();
  const db = overrides.db || createMockDb(overrides.dbOptions);
  const startTask = overrides.startTask || vi.fn(() => ({}));
  const formatTime = overrides.formatTime || vi.fn((value) => `fmt:${value}`);
  const uuidValues = [...(overrides.uuidValues || [])];
  const eventTrackingModule = {
    recordEvent: db.recordEvent,
    getAnalytics: overrides.getAnalytics || vi.fn(() => ({
      tasksByStatus: {},
      successRate: 0,
      avgDurationMinutes: 0,
      tasksLast24h: 0,
      topTemplates: [],
      recentEvents: [],
    })),
  };
  const taskCoreModule = {
    createTask: db.createTask,
    getTask: db.getTask,
  };
  const projectConfigCoreModule = {
    createPipeline: db.createPipeline,
    addPipelineStep: db.addPipelineStep,
    getPipeline: db.getPipeline,
    updatePipelineStatus: db.updatePipelineStatus,
    updatePipelineStep: db.updatePipelineStep,
    listPipelines: db.listPipelines,
  };

  return {
    db,
    taskCoreModule,
    eventTrackingModule,
    fileTrackingModule: {
      createRollback: overrides.createRollback || vi.fn(() => 'rollback-1'),
    },
    projectConfigCoreModule,
    schedulingAutomationModule: {
      saveTemplate: overrides.saveTemplate || vi.fn(),
      listTemplates: overrides.listTemplates || vi.fn(() => []),
      getTemplate: overrides.getTemplate || vi.fn(() => null),
      incrementTemplateUsage: overrides.incrementTemplateUsage || vi.fn(),
    },
    taskMetadataModule: {
      updateTaskGitState: overrides.updateTaskGitState || vi.fn(),
      getTasksWithCommits: overrides.getTasksWithCommits || vi.fn(() => []),
    },
    taskManager: {
      startTask,
    },
    logger,
    loggerModule: {
      child: vi.fn(() => logger),
    },
    taskUtilsModule: {
      formatTime,
    },
    uuidModule: {
      v4: overrides.uuidV4 || vi.fn(() => uuidValues.shift() || `11111111-1111-1111-1111-${String(++uuidCounter).padStart(12, '0')}`),
    },
    childProcessModule: overrides.childProcessModule || {
      spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '', error: null })),
    },
  };
}

function loadHandlers(overrides = {}) {
  currentModules = createDefaultModules(overrides);

  vi.resetModules();
  vi.doMock('../database', () => currentModules.db);
  vi.doMock('../task-manager', () => currentModules.taskManager);
  vi.doMock('../logger', () => currentModules.loggerModule);
  vi.doMock('../handlers/task/utils', () => currentModules.taskUtilsModule);
  vi.doMock('uuid', () => currentModules.uuidModule);
  vi.doMock('child_process', () => currentModules.childProcessModule);

  installCjsModuleMock('../database', currentModules.db);
  installCjsModuleMock('../db/task-core', currentModules.taskCoreModule);
  installCjsModuleMock('../db/event-tracking', currentModules.eventTrackingModule);
  installCjsModuleMock('../db/file-tracking', currentModules.fileTrackingModule);
  installCjsModuleMock('../db/project-config-core', currentModules.projectConfigCoreModule);
  installCjsModuleMock('../db/scheduling-automation', currentModules.schedulingAutomationModule);
  installCjsModuleMock('../db/task-metadata', currentModules.taskMetadataModule);
  installCjsModuleMock('../task-manager', currentModules.taskManager);
  installCjsModuleMock('../logger', currentModules.loggerModule);
  installCjsModuleMock('../handlers/task/utils', currentModules.taskUtilsModule);
  installCjsModuleMock('uuid', currentModules.uuidModule);

  clearModule(pipelineHandlersPath);

  return {
    handlers: require('../handlers/task/pipeline'),
    mocks: currentModules,
  };
}

afterEach(() => {
  currentModules = {};
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
  clearModule(pipelineHandlersPath);
  restoreMockedModules();
});

describe('handlers/task/pipeline', () => {
  describe('handleRetryTask', () => {
    it('returns a missing-parameter error when task_id is omitted', () => {
      const { handlers } = loadHandlers();

      const result = handlers.handleRetryTask({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('task_id is required');
    });

    it('rejects modified_task values that are not strings', () => {
      const { handlers } = loadHandlers();

      const result = handlers.handleRetryTask({
        task_id: '11111111-1111-1111-1111-111111111111',
        modified_task: { invalid: true },
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('modified_task must be a string');
    });

    it('rejects retries for tasks that have not failed or been cancelled', () => {
      const pendingTaskId = '11111111-1111-1111-1111-111111111111';
      const { handlers } = loadHandlers({
        dbOptions: {
          tasks: {
            [pendingTaskId]: makeTask({ id: pendingTaskId, status: 'pending' }),
          },
        },
      });

      const result = handlers.handleRetryTask({ task_id: pendingTaskId });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
      expect(textOf(result)).toContain('Can only retry failed or cancelled tasks');
    });

    it('clones failed tasks with incremented priority and retry context', () => {
      const failedTaskId = '11111111-1111-1111-1111-111111111111';
      const retryTaskId = '22222222-2222-2222-2222-222222222222';
      const originalTask = makeTask({
        id: failedTaskId,
        status: 'failed',
        task_description: 'npm run verify',
        working_directory: '/repo/project',
        timeout_minutes: 45,
        auto_approve: true,
        priority: 6,
        template_name: 'verify-template',
      });
      const { handlers, mocks } = loadHandlers({
        uuidValues: [retryTaskId],
        dbOptions: {
          tasks: {
            [failedTaskId]: originalTask,
          },
        },
      });

      const result = handlers.handleRetryTask({ task_id: failedTaskId });

      expect(mocks.db.createTask).toHaveBeenCalledWith({
        id: retryTaskId,
        status: 'pending',
        task_description: 'npm run verify',
        working_directory: '/repo/project',
        timeout_minutes: 45,
        auto_approve: true,
        priority: 7,
        template_name: 'verify-template',
        context: { retry_of: failedTaskId },
      });
      expect(mocks.db.recordEvent).toHaveBeenCalledWith('task_retried', retryTaskId, {
        original_task: failedTaskId,
      });
      expect(mocks.taskManager.startTask).toHaveBeenCalledWith(retryTaskId);
      expect(textOf(result)).toContain(`Retry task started (ID: ${retryTaskId})`);
      expect(textOf(result)).toContain('Original: 11111111...');
    });

    it('uses modified_task text and queued messaging when retrying cancelled tasks', () => {
      const cancelledTaskId = '33333333-3333-3333-3333-333333333333';
      const retryTaskId = '44444444-4444-4444-4444-444444444444';
      const { handlers, mocks } = loadHandlers({
        uuidValues: [retryTaskId],
        startTask: vi.fn(() => ({ queued: true })),
        dbOptions: {
          tasks: {
            [cancelledTaskId]: makeTask({
              id: cancelledTaskId,
              status: 'cancelled',
              task_description: 'npm run fix',
              priority: 1,
            }),
          },
        },
      });

      const result = handlers.handleRetryTask({
        task_id: cancelledTaskId,
        modified_task: 'npm run fix -- --retry',
      });

      expect(mocks.db.createTask).toHaveBeenCalledWith(expect.objectContaining({
        id: retryTaskId,
        task_description: 'npm run fix -- --retry',
        priority: 2,
        context: { retry_of: cancelledTaskId },
      }));
      expect(textOf(result)).toContain(`Retry task queued (ID: ${retryTaskId})`);
    });
  });

  describe('handleCreatePipeline', () => {
    it('rejects a missing pipeline name', () => {
      const { handlers } = loadHandlers();

      const result = handlers.handleCreatePipeline({
        steps: [{ name: 'Verify', task_template: 'npm run verify' }],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('name must be a non-empty string');
    });

    it('rejects a missing or empty steps array', () => {
      const { handlers } = loadHandlers();

      const result = handlers.handleCreatePipeline({ name: 'Verify Fix Retry' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('steps must be a non-empty array');
    });

    it('rejects steps that omit task_template', () => {
      const { handlers } = loadHandlers();

      const result = handlers.handleCreatePipeline({
        name: 'Verify Fix Retry',
        steps: [{ name: 'Verify' }],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('Step 1: task_template is required');
    });

    it('stores verify, fix, and retry steps in order with default metadata', () => {
      const pipelineId = '55555555-5555-5555-5555-555555555555';
      const { handlers, mocks } = loadHandlers({
        uuidValues: [pipelineId],
      });

      const result = handlers.handleCreatePipeline({
        name: '  Verify Fix Retry  ',
        description: 'Verification and repair flow',
        working_directory: '/repo/project',
        steps: [
          { name: 'Verify', task_template: 'npm run verify' },
          { name: 'Fix', task_template: 'npm run fix' },
          { name: 'Retry', task_template: 'npm run retry' },
        ],
      });

      expect(mocks.db.createPipeline).toHaveBeenCalledWith({
        id: pipelineId,
        name: 'Verify Fix Retry',
        description: 'Verification and repair flow',
        working_directory: '/repo/project',
      });
      expect(mocks.db.addPipelineStep).toHaveBeenNthCalledWith(1, {
        pipeline_id: pipelineId,
        step_order: 1,
        name: 'Verify',
        task_template: 'npm run verify',
        condition: 'on_success',
        timeout_minutes: 30,
      });
      expect(mocks.db.addPipelineStep).toHaveBeenNthCalledWith(2, {
        pipeline_id: pipelineId,
        step_order: 2,
        name: 'Fix',
        task_template: 'npm run fix',
        condition: 'on_success',
        timeout_minutes: 30,
      });
      expect(mocks.db.addPipelineStep).toHaveBeenNthCalledWith(3, {
        pipeline_id: pipelineId,
        step_order: 3,
        name: 'Retry',
        task_template: 'npm run retry',
        condition: 'on_success',
        timeout_minutes: 30,
      });
      expect(textOf(result)).toContain('## Pipeline Created: Verify Fix Retry');
      expect(textOf(result)).toContain('1. **Verify** (on_success)');
      expect(textOf(result)).toContain('2. **Fix** (on_success)');
      expect(textOf(result)).toContain('3. **Retry** (on_success)');
    });

    it('preserves explicit step conditions and timeouts for ordered stages', () => {
      const pipelineId = '66666666-6666-6666-6666-666666666666';
      const { handlers, mocks } = loadHandlers({
        uuidValues: [pipelineId],
      });

      handlers.handleCreatePipeline({
        name: 'Conditional Verify Fix Retry',
        steps: [
          { name: 'Verify', task_template: 'npm run verify', timeout_minutes: 15 },
          { name: 'Fix', task_template: 'npm run fix', condition: 'on_failure', timeout_minutes: 20 },
          { name: 'Retry', task_template: 'npm run retry', condition: 'always', timeout_minutes: 10 },
        ],
      });

      expect(mocks.db.addPipelineStep).toHaveBeenNthCalledWith(1, expect.objectContaining({
        step_order: 1,
        condition: 'on_success',
        timeout_minutes: 15,
      }));
      expect(mocks.db.addPipelineStep).toHaveBeenNthCalledWith(2, expect.objectContaining({
        step_order: 2,
        condition: 'on_failure',
        timeout_minutes: 20,
      }));
      expect(mocks.db.addPipelineStep).toHaveBeenNthCalledWith(3, expect.objectContaining({
        step_order: 3,
        condition: 'always',
        timeout_minutes: 10,
      }));
    });
  });

  describe('handleRunPipeline', () => {
    it('returns PIPELINE_NOT_FOUND when the pipeline does not exist', () => {
      const { handlers } = loadHandlers();

      const result = handlers.handleRunPipeline({ pipeline_id: 'missing-pipeline' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('PIPELINE_NOT_FOUND');
      expect(textOf(result)).toContain('Pipeline not found');
    });

    it('rejects pipelines that are already running', () => {
      const pipelineId = '77777777-7777-7777-7777-777777777777';
      const { handlers } = loadHandlers({
        dbOptions: {
          pipelines: {
            [pipelineId]: makePipeline({ id: pipelineId, status: 'running' }),
          },
        },
      });

      const result = handlers.handleRunPipeline({ pipeline_id: pipelineId });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_ALREADY_RUNNING');
      expect(textOf(result)).toContain('already running');
    });

    it('rejects cancelled pipelines because only pending pipelines may start', () => {
      const pipelineId = '88888888-8888-8888-8888-888888888888';
      const { handlers } = loadHandlers({
        dbOptions: {
          pipelines: {
            [pipelineId]: makePipeline({ id: pipelineId, status: 'cancelled' }),
          },
        },
      });

      const result = handlers.handleRunPipeline({ pipeline_id: pipelineId });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
      expect(textOf(result)).toContain("cannot be started from 'cancelled'");
    });

    it('starts only the first verify stage, persists context, and leaves later stages pending', () => {
      const pipelineId = '99999999-9999-9999-9999-999999999999';
      const taskId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const pipeline = makePipeline({
        id: pipelineId,
        name: 'Verify Fix Retry',
        working_directory: '/repo/project',
        steps: [
          makeStep({
            id: 'verify-step',
            step_order: 1,
            name: 'Verify',
            task_template: 'npm run {target.path} && echo {attempt(1)}',
            timeout_minutes: 11,
          }),
          makeStep({
            id: 'fix-step',
            step_order: 2,
            name: 'Fix',
            task_template: 'npm run fix',
          }),
          makeStep({
            id: 'retry-step',
            step_order: 3,
            name: 'Retry',
            task_template: 'npm run retry',
          }),
        ],
      });
      const { handlers, mocks } = loadHandlers({
        uuidValues: [taskId],
        dbOptions: {
          pipelines: {
            [pipelineId]: pipeline,
          },
        },
      });

      const result = handlers.handleRunPipeline({
        pipeline_id: pipelineId,
        variables: {
          'target.path': 'verify',
          'attempt(1)': 'pass-1',
        },
      });

      expect(mocks.db.updatePipelineStatus).toHaveBeenNthCalledWith(1, pipelineId, 'running');
      expect(mocks.db.recordEvent).toHaveBeenCalledWith('pipeline_started', pipelineId, {
        name: 'Verify Fix Retry',
      });
      expect(mocks.db.createTask).toHaveBeenCalledWith({
        id: taskId,
        status: 'pending',
        task_description: 'npm run verify && echo pass-1',
        working_directory: '/repo/project',
        timeout_minutes: 11,
        context: { pipeline_id: pipelineId, step_id: 'verify-step' },
      });
      expect(mocks.db.updatePipelineStatus).toHaveBeenNthCalledWith(2, pipelineId, 'running', {
        current_step: 1,
      });
      expect(mocks.taskManager.startTask).toHaveBeenCalledWith(taskId);
      expect(mocks.db.updatePipelineStep).toHaveBeenCalledTimes(1);
      expect(mocks.db.updatePipelineStep).toHaveBeenCalledWith('verify-step', {
        task_id: taskId,
        status: 'running',
      });
      const storedPipeline = mocks.db.__stores.pipelines.get(pipelineId);
      expect(storedPipeline.current_step).toBe(1);
      expect(storedPipeline.steps.map((step) => step.status)).toEqual(['running', 'pending', 'pending']);
      expect(storedPipeline.steps.map((step) => step.task_id)).toEqual([taskId, null, null]);
      expect(textOf(result)).toContain('Pipeline "Verify Fix Retry" started.');
    });

    it('marks the first stage queued when task startup defers execution', () => {
      const pipelineId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const taskId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      const { handlers, mocks } = loadHandlers({
        uuidValues: [taskId],
        startTask: vi.fn(() => ({ queued: true })),
        dbOptions: {
          pipelines: {
            [pipelineId]: makePipeline({
              id: pipelineId,
              name: 'Queued Verify',
              steps: [makeStep({ id: 'verify-step', name: 'Verify' })],
            }),
          },
        },
      });

      handlers.handleRunPipeline({ pipeline_id: pipelineId });

      expect(mocks.db.updatePipelineStep).toHaveBeenCalledWith('verify-step', {
        task_id: taskId,
        status: 'queued',
      });
      expect(mocks.db.__stores.pipelines.get(pipelineId).steps[0].status).toBe('queued');
    });

    it('allows empty pipelines to enter running state without creating a task', () => {
      const pipelineId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      const { handlers, mocks } = loadHandlers({
        dbOptions: {
          pipelines: {
            [pipelineId]: makePipeline({
              id: pipelineId,
              name: 'Empty Pipeline',
              steps: [],
            }),
          },
        },
      });

      const result = handlers.handleRunPipeline({ pipeline_id: pipelineId });

      expect(mocks.db.updatePipelineStatus).toHaveBeenCalledOnce();
      expect(mocks.db.createTask).not.toHaveBeenCalled();
      expect(mocks.taskManager.startTask).not.toHaveBeenCalled();
      expect(textOf(result)).toContain('Pipeline "Empty Pipeline" started.');
    });

    it('propagates task startup failures to the pipeline and current stage', () => {
      const pipelineId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
      const taskId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      const startError = new Error('scheduler offline');
      const { handlers, mocks } = loadHandlers({
        uuidValues: [taskId],
        startTask: vi.fn(() => {
          throw startError;
        }),
        dbOptions: {
          pipelines: {
            [pipelineId]: makePipeline({
              id: pipelineId,
              name: 'Broken Verify',
              steps: [makeStep({ id: 'verify-step', name: 'Verify', task_template: 'npm run verify' })],
            }),
          },
        },
      });

      const result = handlers.handleRunPipeline({ pipeline_id: pipelineId });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(textOf(result)).toContain('Pipeline start failed: scheduler offline');
      expect(mocks.db.updatePipelineStep).toHaveBeenLastCalledWith('verify-step', {
        status: 'failed',
      });
      expect(mocks.db.updatePipelineStatus).toHaveBeenLastCalledWith(pipelineId, 'failed', {
        error: 'Failed to start first step: scheduler offline',
      });
      const storedPipeline = mocks.db.__stores.pipelines.get(pipelineId);
      expect(storedPipeline.status).toBe('failed');
      expect(storedPipeline.error).toBe('Failed to start first step: scheduler offline');
      expect(storedPipeline.steps[0].status).toBe('failed');
    });
  });

  describe('handleGetPipelineStatus', () => {
    it('renders ordered stage rows, current step, timestamps, and pipeline errors', () => {
      const pipelineId = 'abababab-abab-abab-abab-abababababab';
      const { handlers } = loadHandlers({
        dbOptions: {
          pipelines: {
            [pipelineId]: makePipeline({
              id: pipelineId,
              name: 'Verify Fix Retry',
              status: 'running',
              current_step: 2,
              started_at: '2026-03-12T10:00:00.000Z',
              completed_at: '2026-03-12T10:15:00.000Z',
              error: 'Retry step waiting on fix output',
              steps: [
                makeStep({
                  id: 'verify-step',
                  step_order: 1,
                  name: 'Verify',
                  status: 'completed',
                  task_id: '12345678-aaaa-bbbb-cccc-123456789012',
                }),
                makeStep({
                  id: 'fix-step',
                  step_order: 2,
                  name: 'Fix',
                  status: 'running',
                  task_id: '87654321-aaaa-bbbb-cccc-123456789012',
                }),
                makeStep({
                  id: 'retry-step',
                  step_order: 3,
                  name: 'Retry',
                  status: 'pending',
                  task_id: null,
                }),
              ],
            }),
          },
        },
      });

      const result = handlers.handleGetPipelineStatus({ pipeline_id: pipelineId });
      const text = textOf(result);

      expect(text).toContain('## Pipeline: Verify Fix Retry');
      expect(text).toContain('**Status:** running');
      expect(text).toContain('**Current Step:** 2 / 3');
      expect(text).toContain('**Started:** fmt:2026-03-12T10:00:00.000Z');
      expect(text).toContain('**Completed:** fmt:2026-03-12T10:15:00.000Z');
      expect(text).toContain('**Error:** Retry step waiting on fix output');
      expect(text).toContain('| 1 | Verify | completed | 12345678... |');
      expect(text).toContain('| 2 | Fix | running | 87654321... |');
      expect(text).toContain('| 3 | Retry | pending | - |');
    });
  });
});
