const workflowEngine = require('../db/workflow-engine');
const configCore = require('../db/config-core');
const database = require('../database');
const taskCore = require('../db/task-core');
const taskManager = require('../task-manager');
const workflowRuntime = require('../execution/workflow-runtime');
const taskPolicyHooks = require('../policy-engine/task-hooks');
const policyEngine = require('../policy-engine/engine');
const shadowEnforcer = require('../policy-engine/shadow-enforcer');
const projectConfigCore = require('../db/project-config-core');
const logger = require('../logger');
const handlers = require('../handlers/workflow');
const Module = require('module');

function loadHandlers(deps = { db: database }) {
  delete require.cache[require.resolve('../handlers/workflow')];
  delete require.cache[require.resolve('../handlers/workflow/feature-workflow')];
  const loadedHandlers = require('../handlers/workflow');
  if (loadedHandlers && typeof loadedHandlers.init === 'function') {
    loadedHandlers.init(deps);
  }
  return loadedHandlers;
}

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

describe('handler:workflow-handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    handlers.init({ db: database });
    // Prevent reconcileStaleWorkflows from hitting an uninitialised raw db handle
    vi.spyOn(workflowEngine, 'reconcileStaleWorkflows').mockReturnValue(0);
    // Prevent getProjectConfig from hitting an uninitialised db handle
    vi.spyOn(projectConfigCore, 'getProjectConfig').mockReturnValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('handleCreateWorkflow', () => {
    it('returns INVALID_PARAM for empty workflow name', async () => {
      const result = handlers.handleCreateWorkflow({ name: '   ' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('name must be a non-empty string');
    });

    it('returns INVALID_PARAM for non-string description', async () => {
      const result = handlers.handleCreateWorkflow({
        name: 'build',
        description: 123
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('description must be a string');
    });

    it('rejects empty workflow creation without initial tasks', async () => {
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue(null);

      const result = handlers.handleCreateWorkflow({
        name: 'Release Workflow'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('must include at least one task');
      expect(textOf(result)).toContain('Provide a non-empty tasks array');
    });

    it('returns CONFLICT when an empty placeholder with the same name already exists', async () => {
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue({
        id: 'wf-empty-existing',
        status: 'pending'
      });

      const result = handlers.handleCreateWorkflow({
        name: 'Release Workflow'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('CONFLICT');
      expect(textOf(result)).toContain('empty pending placeholder');
      expect(textOf(result)).toContain('wf-empty-existing');
    });

    it('creates workflow, seeds tasks, and trims name before persistence', async () => {
      const createWorkflowSpy = vi.spyOn(workflowEngine, 'createWorkflow').mockReturnValue(undefined);
      const createTaskSpy = vi.spyOn(database, 'createTask').mockReturnValue(undefined);
      const addTaskDependencySpy = vi.spyOn(workflowEngine, 'addTaskDependency').mockReturnValue(undefined);
      const updateWorkflowCountsSpy = vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue(null);
      vi.spyOn(configCore, 'getConfig').mockReturnValue('30');

      const result = handlers.handleCreateWorkflow({
        name: '  Release Workflow  ',
        description: 'ship it',
        working_directory: '/repo',
        tasks: [
          { node_id: 'build', task_description: 'Build release' },
          { node_id: 'test', task_description: 'Run release tests', depends_on: ['build'] }
        ]
      });

      expect(createWorkflowSpy).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.any(String),
        name: 'Release Workflow',
        description: 'ship it',
        working_directory: '/repo'
      }));
      expect(createTaskSpy).toHaveBeenCalledTimes(2);
      expect(addTaskDependencySpy).toHaveBeenCalledWith(expect.objectContaining({
        workflow_id: expect.any(String),
        condition_expr: undefined,
        on_fail: 'skip'
      }));
      expect(updateWorkflowCountsSpy).toHaveBeenCalledWith(expect.any(String));
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Workflow Created');
      expect(textOf(result)).toContain('**Tasks:** 2');
      expect(textOf(result)).toContain('ship it');
    });

    it('uses an injected database dependency when seeding workflow tasks', async () => {
      const rawDb = {
        transaction: vi.fn((fn) => () => fn())
      };
      const fakeDb = {
        getDbInstance: vi.fn(() => rawDb),
        createTask: vi.fn()
      };
      const injectedHandlers = handlers.createWorkflowHandlers({ db: fakeDb });
      const databaseCreateTaskSpy = vi.spyOn(database, 'createTask').mockReturnValue(undefined);
      const createWorkflowSpy = vi.spyOn(workflowEngine, 'createWorkflow').mockReturnValue(undefined);
      const updateWorkflowCountsSpy = vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue(null);
      vi.spyOn(configCore, 'getConfig').mockReturnValue('30');

      const result = injectedHandlers.handleCreateWorkflow({
        name: 'Injected Workflow',
        tasks: [
          { node_id: 'build', task_description: 'Build with injected db' }
        ]
      });

      expect(result.isError).toBeFalsy();
      expect(createWorkflowSpy).toHaveBeenCalledTimes(1);
      expect(fakeDb.getDbInstance).toHaveBeenCalled();
      expect(rawDb.transaction).toHaveBeenCalled();
      expect(fakeDb.createTask).toHaveBeenCalledWith(expect.objectContaining({
        task_description: 'Build with injected db',
        workflow_node_id: 'build'
      }));
      expect(updateWorkflowCountsSpy).toHaveBeenCalledWith(expect.any(String));
      expect(databaseCreateTaskSpy).not.toHaveBeenCalled();
    });

    it('uses handler DI database resolution and never falls back to the database facade', async () => {
      const originalLoad = Module._load;
      const blockedRequests = [];
      const rawDb = {
        transaction: vi.fn((fn) => () => fn())
      };
      const fakeTaskCore = {
        createTask: vi.fn()
      };
      const container = {
        has: vi.fn((name) => name === 'dbInstance' || name === 'taskCore'),
        get: vi.fn((name) => {
          if (name === 'dbInstance') return rawDb;
          if (name === 'taskCore') return fakeTaskCore;
          throw new Error(`Unexpected service: ${name}`);
        })
      };
      const injectedHandlers = handlers.createWorkflowHandlers({
        container,
        db: undefined,
        rawDb: undefined,
        taskCore: fakeTaskCore
      });
      const createWorkflowSpy = vi.spyOn(workflowEngine, 'createWorkflow').mockReturnValue(undefined);
      const updateWorkflowCountsSpy = vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue(null);
      vi.spyOn(configCore, 'getConfig').mockReturnValue('30');

      const databaseLoadSpy = vi.spyOn(Module, '_load').mockImplementation(function patchedLoad(request, parent, isMain) {
        const parentFile = parent?.filename ? parent.filename.replace(/\\/g, '/') : '';
        if (request === '../../database' && parentFile.endsWith('server/handlers/workflow/index.js')) {
          blockedRequests.push(request);
          throw new Error('workflow handler should not require database facade');
        }
        return originalLoad.call(this, request, parent, isMain);
      });

      try {
        const result = injectedHandlers.handleCreateWorkflow({
          name: 'Container Workflow',
          tasks: [
            { node_id: 'build', task_description: 'Build through container db' }
          ]
        });

        expect(result.isError).toBeFalsy();
        expect(createWorkflowSpy).toHaveBeenCalledTimes(1);
        expect(container.get).toHaveBeenCalledWith('dbInstance');
        expect(rawDb.transaction).toHaveBeenCalled();
        expect(fakeTaskCore.createTask).toHaveBeenCalledWith(expect.objectContaining({
          task_description: 'Build through container db',
          workflow_node_id: 'build'
        }));
        expect(updateWorkflowCountsSpy).toHaveBeenCalledWith(expect.any(String));
        expect(blockedRequests).toEqual([]);
      } finally {
        databaseLoadSpy.mockRestore();
      }
    });

    it('loads workflow handlers without requiring the database facade directly', () => {
      const originalLoad = Module._load;
      const blockedRequests = [];
      delete require.cache[require.resolve('../handlers/workflow')];

      Module._load = function patchedLoad(request, parent, isMain) {
        const parentFile = parent?.filename ? parent.filename.replace(/\\/g, '/') : '';
        if (request === '../../database' && parentFile.endsWith('server/handlers/workflow/index.js')) {
          blockedRequests.push(request);
          throw new Error('workflow handler should not require database facade');
        }
        return originalLoad.call(this, request, parent, isMain);
      };

      try {
        const loadedHandlers = require('../handlers/workflow');
        expect(typeof loadedHandlers.handleCreateWorkflow).toBe('function');
        expect(blockedRequests).toEqual([]);
      } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../handlers/workflow')];
        loadHandlers();
      }
    });

    it('skips policy-rejected initial tasks and reports them in the response', async () => {
      const createWorkflowSpy = vi.spyOn(workflowEngine, 'createWorkflow').mockReturnValue(undefined);
      const createTaskSpy = vi.spyOn(database, 'createTask').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'addTaskDependency').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue(null);
      vi.spyOn(configCore, 'getConfig').mockReturnValue('30');
      vi.spyOn(taskPolicyHooks, 'evaluateTaskSubmissionPolicy')
        .mockImplementation((taskData) => (taskData.task_description === 'Run release tests'
          ? { blocked: true, reason: 'Approval required' }
          : { blocked: false }));

      const result = handlers.handleCreateWorkflow({
        name: 'Release Workflow',
        working_directory: '/repo',
        tasks: [
          { node_id: 'build', task_description: 'Build release' },
          { node_id: 'test', task_description: 'Run release tests' }
        ]
      });

      expect(createWorkflowSpy).toHaveBeenCalledTimes(1);
      expect(createTaskSpy).toHaveBeenCalledTimes(1);
      expect(result.isError).toBeFalsy();
      expect(result.rejected_tasks).toEqual([
        expect.objectContaining({
          node_id: 'test',
          reason: 'Approval required'
        })
      ]);
      expect(textOf(result)).toContain('**Tasks:** 1');
      expect(textOf(result)).toContain('**Rejected Tasks:** 1');
      expect(textOf(result)).toContain('test: Approval required');
    });

    it('blocks workflow creation when workflow_submit policy blocks', async () => {
      const createWorkflowSpy = vi.spyOn(workflowEngine, 'createWorkflow').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue(null);
      vi.spyOn(configCore, 'getConfig').mockReturnValue('30');
      vi.spyOn(taskPolicyHooks, 'evaluateTaskSubmissionPolicy').mockReturnValue({ blocked: false });
      vi.spyOn(shadowEnforcer, 'isEngineEnabled').mockReturnValue(true);
      vi.spyOn(shadowEnforcer, 'isShadowOnly').mockReturnValue(false);
      const evaluateSpy = vi.spyOn(policyEngine, 'evaluatePolicies').mockReturnValue({
        summary: {
          passed: 0,
          failed: 1,
          warned: 0,
          blocked: 1,
          degraded: 0,
          skipped: 0,
          overridden: 0,
          suppressed: 0,
        },
        results: [{ outcome: 'fail', mode: 'block', message: 'Workflow approval required' }],
        total_results: 1,
      });

      const result = handlers.handleCreateWorkflow({
        name: 'Release Workflow',
        tasks: [{ node_id: 'build', task_description: 'Build release' }]
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(textOf(result)).toContain('Workflow approval required');
      expect(createWorkflowSpy).not.toHaveBeenCalled();
      expect(evaluateSpy).toHaveBeenCalledWith(expect.objectContaining({
        stage: 'workflow_submit',
        target_type: 'workflow'
      }));
    });
  });

  describe('handleAddWorkflowTask', () => {
    it('returns INVALID_PARAM when task description is missing', async () => {
      const result = handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'node-a'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('expected a non-empty string');
    });

    it('returns WORKFLOW_NOT_FOUND when parent workflow is missing', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue(null);

      const result = handlers.handleAddWorkflowTask({
        workflow_id: 'wf-missing',
        node_id: 'node-a',
        task_description: 'Do work'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
      expect(textOf(result)).toContain('Workflow not found');
    });

    it('returns RESOURCE_NOT_FOUND when a dependency node is missing', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'pending',
        working_directory: '/repo'
      });
      vi.spyOn(configCore, 'getConfig').mockReturnValue('30');
      vi.spyOn(database, 'createTask').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([]);
      vi.spyOn(workflowEngine, 'getTaskDependencies').mockReturnValue([]);

      const result = handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'node-b',
        task_description: 'Depends on missing node',
        depends_on: ['node-a']
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(textOf(result)).toContain('Dependency not found');
    });

    it('returns INVALID_PARAM when adding the dependency would create a cycle', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'pending',
        working_directory: '/repo'
      });
      vi.spyOn(configCore, 'getConfig').mockReturnValue('30');
      vi.spyOn(database, 'createTask').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'task-a', workflow_node_id: 'A' },
        { id: 'task-b', workflow_node_id: 'B' }
      ]);
      vi.spyOn(workflowEngine, 'getTaskDependencies').mockImplementation((taskId) => {
        if (taskId === 'task-a') {
          return [{ depends_on_task_id: 'task-b' }];
        }
        return [];
      });

      const result = handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'B',
        task_description: 'Cycle candidate',
        depends_on: ['A']
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('Circular dependency detected');
    });

    it('creates dependency metadata and maps alternate dependency node IDs', async () => {
      const createTaskSpy = vi.spyOn(database, 'createTask').mockReturnValue(undefined);
      const addTaskDependencySpy = vi.spyOn(workflowEngine, 'addTaskDependency').mockReturnValue(undefined);

      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'pending',
        working_directory: '/repo'
      });
      vi.spyOn(configCore, 'getConfig').mockReturnValue('45');
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'task-a', workflow_node_id: 'node-a' },
        { id: 'task-alt', workflow_node_id: 'node-alt' }
      ]);
      vi.spyOn(workflowEngine, 'getTaskDependencies').mockReturnValue([]);
      vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);

      const result = handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'node-b',
        task: 'Use the full task prompt',
        task_description: 'ignored label',
        depends_on: ['node-a'],
        condition: 'exit_code == 0',
        on_fail: 'cancel',
        alternate_node_id: 'node-alt',
        context_from: ['node-a'],
        tags: ['release']
      });

      expect(createTaskSpy).toHaveBeenCalledWith(expect.objectContaining({
        task_description: 'Use the full task prompt',
        workflow_id: 'wf-1',
        workflow_node_id: 'node-b',
        status: 'blocked',
        timeout_minutes: 45,
        metadata: JSON.stringify({ context_from: ['node-a'] }),
        tags: ['release']
      }));
      expect(addTaskDependencySpy).toHaveBeenCalledWith(expect.objectContaining({
        workflow_id: 'wf-1',
        depends_on_task_id: 'task-a',
        on_fail: 'cancel',
        condition_expr: 'exit_code == 0',
        alternate_task_id: 'task-alt'
      }));
      expect(textOf(result)).toContain('Depends On');
      expect(textOf(result)).toContain('Context From');
    });

    it('starts dependency-free task immediately in active workflow and does not call workflow-runtime directly', async () => {
      const runtimeSpy = vi.spyOn(workflowRuntime, 'evaluateWorkflowDependencies');

      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'running',
        working_directory: '/repo'
      });
      vi.spyOn(configCore, 'getConfig').mockReturnValue('30');
      vi.spyOn(database, 'createTask').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'startTask').mockReturnValue(undefined);
      vi.spyOn(database, 'getTask').mockReturnValue({ status: 'running' });

      const result = handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'run-now',
        task_description: 'Run this now'
      });

      expect(taskManager.startTask).toHaveBeenCalledWith(expect.any(String));
      expect(runtimeSpy).not.toHaveBeenCalled();
      expect(textOf(result)).toContain('**Status:** running');
    });

    it('reports queued status when an active-workflow task is deferred for capacity', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'running',
        working_directory: '/repo'
      });
      vi.spyOn(configCore, 'getConfig').mockReturnValue('30');
      vi.spyOn(database, 'createTask').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'startTask').mockReturnValue({ queued: true });
      vi.spyOn(database, 'getTask').mockReturnValue({ status: 'pending' });

      const result = handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'queue-now',
        task_description: 'Queue this when capacity is full'
      });

      expect(taskManager.startTask).toHaveBeenCalledWith(expect.any(String));
      expect(textOf(result)).toContain('**Status:** queued');
    });

    it('reopens failed workflow and unblocks task when all dependencies are terminal', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'failed',
        working_directory: '/repo'
      });
      vi.spyOn(configCore, 'getConfig').mockReturnValue('30');
      vi.spyOn(database, 'createTask').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'getWorkflowTasks')
        .mockReturnValueOnce([{ id: 'task-a', workflow_node_id: 'node-a' }])
        .mockReturnValueOnce([{ id: 'task-a', workflow_node_id: 'node-a', status: 'completed' }]);
      vi.spyOn(workflowEngine, 'getTaskDependencies').mockReturnValue([]);
      vi.spyOn(workflowEngine, 'addTaskDependency').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
      const updateWorkflowSpy = vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'unblockTask').mockReturnValue(undefined);
      vi.spyOn(database, 'getTask').mockReturnValue({ status: 'queued' });

      const result = handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'node-b',
        task_description: 'Recover workflow',
        depends_on: ['node-a']
      });

      expect(updateWorkflowSpy).toHaveBeenCalledWith('wf-1', {
        status: 'running',
        completed_at: null
      });
      expect(taskManager.unblockTask).toHaveBeenCalledWith(expect.any(String));
      expect(textOf(result)).toContain('**Status:** queued');
    });

    it('does not create a task when task submission policy rejects it', async () => {
      const createTaskSpy = vi.spyOn(database, 'createTask').mockReturnValue(undefined);

      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'pending',
        working_directory: '/repo'
      });
      vi.spyOn(configCore, 'getConfig').mockReturnValue('30');
      vi.spyOn(taskPolicyHooks, 'evaluateTaskSubmissionPolicy').mockReturnValue({
        blocked: true,
        reason: 'Needs manual approval'
      });

      const result = handlers.handleAddWorkflowTask({
        workflow_id: 'wf-1',
        node_id: 'hold',
        task_description: 'Wait for approval'
      });

      expect(result.isError).toBeFalsy();
      expect(createTaskSpy).not.toHaveBeenCalled();
      expect(result.rejected_tasks).toEqual([
        expect.objectContaining({
          node_id: 'hold',
          reason: 'Needs manual approval'
        })
      ]);
      expect(textOf(result)).toContain('Task Rejected by Policy');
      expect(textOf(result)).toContain('Needs manual approval');
    });
  });

  describe('handleRunWorkflow', () => {
    it('returns WORKFLOW_NOT_FOUND when workflow does not exist', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue(null);

      const result = await handlers.handleRunWorkflow({ workflow_id: 'wf-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('returns INVALID_PARAM when workflow has no tasks', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'pending'
      });
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'pending',
        tasks: {}
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([]);

      const result = await handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('has no tasks');
    });

    it('attempts every runnable pending task and trusts startTask to queue overflow', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'paused'
      });
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'paused',
        tasks: {
          t1: { id: 't1', status: 'pending' },
          t2: { id: 't2', status: 'pending' },
          t3: { id: 't3', status: 'pending' },
          t4: { id: 't4', status: 'blocked' }
        }
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 't1', status: 'pending', provider: 'codex' },
        { id: 't2', status: 'pending', provider: 'codex' },
        { id: 't3', status: 'pending', provider: 'openai' },
        { id: 't4', status: 'blocked', provider: 'openai' }
      ]);
      vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
        if (key === 'max_codex_concurrent') return '1';
        if (key === 'max_concurrent') return '2';
        return null;
      });
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      const updateTaskStatusSpy = vi.spyOn(database, 'updateTaskStatus').mockReturnValue(undefined);
      // Track call counts to distinguish pre-start check from post-start classification
      const getTaskCallCount = {};
      vi.spyOn(database, 'getTask').mockImplementation((taskId) => {
        getTaskCallCount[taskId] = (getTaskCallCount[taskId] || 0) + 1;
        const isPreCheck = getTaskCallCount[taskId] === 1;
        if (taskId === 't1') return { id: 't1', status: isPreCheck ? 'pending' : 'running' };
        if (taskId === 't2') return { id: 't2', status: 'pending' };
        if (taskId === 't3') return { id: 't3', status: isPreCheck ? 'pending' : 'running' };
        if (taskId === 't4') return { id: 't4', status: 'blocked' };
        return null;
      });
      vi.spyOn(taskManager, 'startTask')
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({ queued: true })
        .mockReturnValueOnce(undefined);

      const result = await handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(taskManager.startTask).toHaveBeenNthCalledWith(1, 't1');
      expect(taskManager.startTask).toHaveBeenNthCalledWith(2, 't2');
      expect(taskManager.startTask).toHaveBeenNthCalledWith(3, 't3');
      expect(updateTaskStatusSpy).not.toHaveBeenCalledWith('t2', 'queued');
      expect(textOf(result)).toContain('**Tasks Started:** 2');
      expect(textOf(result)).toContain('**Tasks Queued:** 1');
      expect(textOf(result)).toContain('**Blocked Tasks:** 1');
    });

    it('counts deferred startTask results as queued instead of started', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'pending'
      });
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'pending',
        tasks: {
          t1: { id: 't1', status: 'pending' },
          t2: { id: 't2', status: 'pending' }
        }
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 't1', status: 'pending', provider: 'codex' },
        { id: 't2', status: 'pending', provider: 'openai' }
      ]);
      vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
        if (key === 'max_codex_concurrent') return '5';
        if (key === 'max_concurrent') return '10';
        return null;
      });
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      const getTaskCounts = {};
      vi.spyOn(database, 'getTask').mockImplementation((id) => {
        getTaskCounts[id] = (getTaskCounts[id] || 0) + 1;
        const isPreCheck = getTaskCounts[id] === 1;
        // Pre-start check returns 'pending' so startTask is called;
        // post-start classification returns the outcome status
        if (id === 't1') return { id: 't1', status: 'pending' };
        if (id === 't2') return { id: 't2', status: isPreCheck ? 'pending' : 'running' };
        return null;
      });
      vi.spyOn(taskManager, 'startTask')
        .mockReturnValueOnce({ queued: true })
        .mockReturnValueOnce(undefined);

      const result = await handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBeFalsy();
      expect(taskManager.startTask).toHaveBeenNthCalledWith(1, 't1');
      expect(taskManager.startTask).toHaveBeenNthCalledWith(2, 't2');
      expect(textOf(result)).toContain('**Tasks Started:** 1');
      expect(textOf(result)).toContain('**Tasks Queued:** 1');
    });

    it('logs non-critical start errors and continues', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'pending'
      });
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'pending',
        tasks: {
          t1: { id: 't1', status: 'pending' },
          t2: { id: 't2', status: 'pending' }
        }
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 't1', status: 'pending', provider: 'codex' },
        { id: 't2', status: 'pending', provider: 'openai' }
      ]);
      vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
        if (key === 'max_codex_concurrent') return '5';
        if (key === 'max_concurrent') return '10';
        return null;
      });
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      const getTaskCounts = {};
      vi.spyOn(database, 'getTask').mockImplementation((id) => {
        getTaskCounts[id] = (getTaskCounts[id] || 0) + 1;
        const isPreCheck = getTaskCounts[id] === 1;
        if (id === 't1') return { id: 't1', status: 'pending' };
        if (id === 't2') return { id: 't2', status: isPreCheck ? 'pending' : 'running' };
        return null;
      });
      vi.spyOn(taskManager, 'startTask')
        .mockImplementationOnce(() => { throw new Error('capacity'); })
        .mockImplementationOnce(() => undefined);
      const debugSpy = vi.spyOn(logger.constructor.prototype, 'debug').mockReturnValue(undefined);

      const result = await handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBeFalsy();
      expect(debugSpy).toHaveBeenCalled();
      expect(textOf(result)).toContain('Workflow Started');
    });

    it('runs workflow_run policy in fail-open mode when no policies are configured', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'pending',
        working_directory: '/repo'
      });
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'pending',
        tasks: {
          t1: { id: 't1', status: 'pending' }
        }
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 't1', status: 'pending', provider: 'codex' }
      ]);
      vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
        if (key === 'max_codex_concurrent') return '5';
        if (key === 'max_concurrent') return '10';
        return null;
      });
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      let t1CallCount = 0;
      vi.spyOn(database, 'getTask').mockImplementation(() => {
        t1CallCount++;
        return { id: 't1', status: t1CallCount === 1 ? 'pending' : 'running' };
      });
      vi.spyOn(taskManager, 'startTask').mockReturnValue(undefined);
      vi.spyOn(shadowEnforcer, 'isEngineEnabled').mockReturnValue(true);
      vi.spyOn(shadowEnforcer, 'isShadowOnly').mockReturnValue(false);
      vi.spyOn(taskPolicyHooks, 'evaluateTaskSubmissionPolicy').mockReturnValue({ blocked: false });
      const evaluateSpy = vi.spyOn(policyEngine, 'evaluatePolicies').mockReturnValue({
        summary: {
          passed: 0,
          failed: 0,
          warned: 0,
          blocked: 0,
          degraded: 0,
          skipped: 0,
          overridden: 0,
          suppressed: 0,
        },
        results: [],
        total_results: 0,
      });
      const warnSpy = vi.spyOn(logger.constructor.prototype, 'warn').mockReturnValue(undefined);

      const result = await handlers.handleRunWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBeFalsy();
      expect(taskManager.startTask).toHaveBeenCalledWith('t1');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No policies configured for workflow_run'));
      expect(evaluateSpy).toHaveBeenCalledWith(expect.objectContaining({
        stage: 'workflow_run',
        target_type: 'workflow',
        target_id: 'wf-1'
      }));
    });
  });

  describe('handleWorkflowStatus', () => {
    it('returns WORKFLOW_NOT_FOUND when status payload is missing', async () => {
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue(null);

      const result = handlers.handleWorkflowStatus({ workflow_id: 'wf-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('renders status summary and per-task progress table', async () => {
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf-1',
        name: 'WF Status',
        status: 'running',
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: null,
        summary: {
          completed: 1,
          running: 1,
          pending: 2,
          blocked: 1,
          failed: 0,
          skipped: 0,
          total: 5
        },
        tasks: {
          a: { id: 'a', node_id: 'build', status: 'completed', progress: 100 },
          b: { id: 'b1234567890', status: 'running', progress: 20 }
        }
      });

      const result = handlers.handleWorkflowStatus({ workflow_id: 'wf-1' });
      const text = textOf(result);

      expect(text).toContain('Workflow Status: WF Status');
      expect(text).toContain('**Visibility:** ACTIONABLE');
      expect(text).toContain('| Completed | 1 |');
      expect(text).toContain('| build | completed | 100% |');
      expect(text).toContain('| b1234567 | running | 20% |');
    });

    it('surfaces empty workflows as hygiene issues', async () => {
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf-empty',
        name: 'WF Empty',
        status: 'pending',
        started_at: null,
        completed_at: null,
        summary: {
          completed: 0,
          running: 0,
          pending: 0,
          blocked: 0,
          failed: 0,
          skipped: 0,
          total: 0
        },
        tasks: {}
      });

      const result = handlers.handleWorkflowStatus({ workflow_id: 'wf-empty' });
      const text = textOf(result);

      expect(text).toContain('**Visibility:** HYGIENE: empty workflow');
      expect(text).toContain('**Actionable:** No');
      expect(text).toContain('has no tasks attached');
      expect(text).toContain('Add tasks or remove the workflow entry');
    });

    it('surfaces stale active workflows as hygiene issues', async () => {
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf-stale',
        name: 'WF Stale',
        status: 'running',
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: null,
        summary: {
          completed: 2,
          running: 0,
          pending: 0,
          blocked: 0,
          failed: 0,
          skipped: 0,
          total: 2
        },
        tasks: {
          a: { id: 'a', node_id: 'build', status: 'completed', progress: 100 },
          b: { id: 'b', node_id: 'test', status: 'completed', progress: 100 }
        }
      });

      const result = handlers.handleWorkflowStatus({ workflow_id: 'wf-stale' });
      const text = textOf(result);

      expect(text).toContain('**Visibility:** HYGIENE: stale active status');
      expect(text).toContain('every task is already terminal');
      expect(text).toContain('Refresh or close the workflow');
    });
  });

  describe('handleCancelWorkflow', () => {
    it('cancels running/pending/blocked/queued tasks and records cancellation reason', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'WF' });
      const taskMap = {
        'run-1': { id: 'run-1', status: 'running' },
        'pen-1': { id: 'pen-1', status: 'pending' },
        'blk-1': { id: 'blk-1', status: 'blocked' },
        'que-1': { id: 'que-1', status: 'queued' },
        'done-1': { id: 'done-1', status: 'completed' },
      };
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue(Object.values(taskMap));
      vi.spyOn(database, 'getTask').mockImplementation((id) => taskMap[id] || null);
      vi.spyOn(taskManager, 'cancelTask').mockReturnValue(undefined);
      const updateTaskStatusSpy = vi.spyOn(database, 'updateTaskStatus').mockReturnValue(undefined);
      const updateWorkflowSpy = vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);

      const result = handlers.handleCancelWorkflow({
        workflow_id: 'wf-1',
        reason: 'Superseded'
      });

      expect(taskManager.cancelTask).toHaveBeenCalledWith('run-1', 'Superseded');
      expect(updateTaskStatusSpy).toHaveBeenCalledWith('pen-1', 'cancelled');
      expect(updateTaskStatusSpy).toHaveBeenCalledWith('blk-1', 'cancelled');
      expect(updateTaskStatusSpy).toHaveBeenCalledWith('que-1', 'cancelled');
      expect(updateWorkflowSpy).toHaveBeenCalledWith('wf-1', expect.objectContaining({
        status: 'cancelled',
        completed_at: expect.any(String)
      }));
      expect(textOf(result)).toContain('**Tasks Cancelled:** 4');
      expect(textOf(result)).toContain('**Reason:** Superseded');
    });
  });

  describe('handlePauseWorkflow', () => {
    it('returns INVALID_STATUS_TRANSITION when workflow is not running', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'completed'
      });

      const result = handlers.handlePauseWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
      expect(textOf(result)).toContain('Current status: completed');
    });

    it('pauses a running workflow', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'WF',
        status: 'running'
      });
      const updateSpy = vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);

      const result = handlers.handlePauseWorkflow({ workflow_id: 'wf-1' });

      expect(updateSpy).toHaveBeenCalledWith('wf-1', { status: 'paused' });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Workflow Paused');
    });
  });

  describe('handleListWorkflows', () => {
    it('passes normalized filters and renders workflow rows', async () => {
      const listSpy = vi.spyOn(workflowEngine, 'listWorkflows').mockReturnValue([
        {
          id: 'wf-1',
          name: 'Shipping',
          status: 'running',
          total_tasks: 6,
          created_at: '2026-01-01T00:00:00.000Z'
        }
      ]);
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf-1',
        name: 'Shipping',
        status: 'running',
        summary: {
          total: 6,
          completed: 1,
          failed: 0,
          running: 2,
          blocked: 1,
          pending: 2,
          skipped: 0
        },
        tasks: {
          a: { id: 'a', status: 'running' },
          b: { id: 'b', status: 'running' },
          c: { id: 'c', status: 'pending' },
          d: { id: 'd', status: 'pending' },
          e: { id: 'e', status: 'blocked' },
          f: { id: 'f', status: 'completed' }
        }
      });

      const result = handlers.handleListWorkflows({
        status: 'running',
        template_id: 'tmpl-1',
        since: '2026-02-10',
        limit: '3'
      });

      expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({
        status: 'running',
        template_id: 'tmpl-1',
        since: expect.stringContaining('2026-02-10'),
        limit: 3
      }));
      expect(textOf(result)).toContain('## Workflows');
      expect(textOf(result)).toContain('### Actionable Workflows');
      expect(textOf(result)).toContain('| Shipping | running | 5/6 | ACTIONABLE |');
    });

    it('separates hygiene workflows from actionable ones', async () => {
      vi.spyOn(workflowEngine, 'listWorkflows').mockReturnValue([
        {
          id: 'wf-empty',
          name: 'Empty Noise',
          status: 'pending',
          total_tasks: 0,
          created_at: '2026-01-02T00:00:00.000Z'
        },
        {
          id: 'wf-live',
          name: 'Live Work',
          status: 'running',
          total_tasks: 2,
          created_at: '2026-01-03T00:00:00.000Z'
        }
      ]);
      vi.spyOn(workflowEngine, 'getWorkflowStatus')
        .mockImplementation((workflowId) => {
          if (workflowId === 'wf-empty') {
            return {
              id: 'wf-empty',
              name: 'Empty Noise',
              status: 'pending',
              summary: {
                total: 0,
                completed: 0,
                failed: 0,
                running: 0,
                blocked: 0,
                pending: 0,
                skipped: 0
              },
              tasks: {}
            };
          }
          return {
            id: 'wf-live',
            name: 'Live Work',
            status: 'running',
            summary: {
              total: 2,
              completed: 0,
              failed: 0,
              running: 1,
              blocked: 0,
              pending: 1,
              skipped: 0
            },
            tasks: {
              a: { id: 'a', status: 'running' },
              b: { id: 'b', status: 'pending' }
            }
          };
        });

      const text = textOf(handlers.handleListWorkflows({}));

      expect(text).toContain('**Actionable:** 1 | **Hygiene Issues:** 1 | **Quiet:** 0');
      expect(text).toContain('### Workflow Hygiene Issues');
      expect(text).toContain('| Empty Noise | pending | 0/0 | HYGIENE: empty workflow |');
      expect(text).toContain('| Live Work | running | 2/2 | ACTIONABLE |');
    });
  });

  describe('handleWorkflowHistory', () => {
    it('shows explicit empty-state when there are no events', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'WF History' });
      vi.spyOn(workflowEngine, 'getWorkflowHistory').mockReturnValue([]);

      const result = handlers.handleWorkflowHistory({ workflow_id: 'wf-1' });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('No events recorded.');
    });

    it('renders event rows with detail and exit code fallback', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'WF History' });
      vi.spyOn(workflowEngine, 'getWorkflowHistory').mockReturnValue([
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'task_started',
          node_id: 'build',
          details: 'Starting build and preparing environment'
        },
        {
          timestamp: '2026-01-01T00:00:05.000Z',
          type: 'task_failed',
          task_id: 'abcdef1234567890',
          exit_code: 2
        }
      ]);

      const result = handlers.handleWorkflowHistory({ workflow_id: 'wf-1' });
      const text = textOf(result);

      expect(text).toContain('Workflow History: WF History');
      expect(text).toContain('| task_started | build |');
      expect(text).toContain('Starting build and preparing e');
      expect(text).toContain('| task_failed | abcdef12 | exit: 2 |');
    });
  });

  describe('handleCreateFeatureWorkflow', () => {
    it('returns INVALID_PARAM when feature_name is missing', async () => {
      const result = loadHandlers().handleCreateFeatureWorkflow({
        working_directory: '/repo'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('feature_name must be a non-empty string');
    });

    it('rejects feature workflows that would create an empty DAG', async () => {
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue(null);

      const result = loadHandlers().handleCreateFeatureWorkflow({
        feature_name: 'PlayerStats',
        working_directory: '/repo'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('must include at least one task');
      expect(textOf(result)).toContain('types_task');
    });

    it('returns CONFLICT when a duplicate empty feature placeholder already exists', async () => {
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue({
        id: 'wf-feature-empty',
        status: 'pending'
      });

      const result = handlers.handleCreateFeatureWorkflow({
        feature_name: 'PlayerStats',
        workflow_name: 'Feature: PlayerStats',
        working_directory: '/repo'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('CONFLICT');
      expect(textOf(result)).toContain('wf-feature-empty');
    });

    it('creates full feature DAG with dependencies and parallel tasks', async () => {
      const createWorkflowSpy = vi.spyOn(workflowEngine, 'createWorkflow').mockReturnValue(undefined);
      const createTaskSpy = vi.spyOn(taskCore, 'createTask').mockReturnValue(undefined);
      const addTaskDependencySpy = vi.spyOn(workflowEngine, 'addTaskDependency').mockReturnValue(undefined);
      const updateCountsSpy = vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue(null);

      const result = loadHandlers().handleCreateFeatureWorkflow({
        feature_name: 'PlayerStats',
        working_directory: '/repo',
        types_task: 'Define types',
        events_task: 'Add events',
        data_task: 'Create data layer',
        system_task: 'Build system',
        tests_task: 'Write tests',
        wire_task: 'Wire dependencies',
        parallel_tasks: [{ node_id: 'lint', task: 'Run lint', provider: 'codex' }],
        step_providers: {
          types: 'codex',
          events: 'claude-cli',
          data: 'codex',
          system: 'claude-cli',
          tests: 'codex',
          wire: 'codex',
          parallel: 'codex'
        }
      });

      expect(createWorkflowSpy).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.any(String),
        name: 'Feature: PlayerStats'
      }));
      expect(createTaskSpy).toHaveBeenCalledTimes(7);
      expect(addTaskDependencySpy).toHaveBeenCalledTimes(5);
      expect(updateCountsSpy).toHaveBeenCalledTimes(1);
      expect(textOf(result)).toContain('Feature Workflow Created');
      expect(textOf(result)).toContain('player-stats-types');
      expect(textOf(result)).toContain('run_workflow');
    });

    it('auto-runs pending feature tasks and logs non-critical start failures', async () => {
      vi.spyOn(workflowEngine, 'createWorkflow').mockReturnValue(undefined);
      vi.spyOn(taskCore, 'createTask').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'addTaskDependency').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue(null);
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 't1', status: 'pending' },
        { id: 't2', status: 'blocked' },
        { id: 't3', status: 'pending' }
      ]);
      const getTaskCounts = {};
      vi.spyOn(database, 'getTask').mockImplementation((id) => {
        getTaskCounts[id] = (getTaskCounts[id] || 0) + 1;
        const isPreCheck = getTaskCounts[id] === 1;
        if (id === 't1') return { id: 't1', status: 'pending' };
        if (id === 't3') return { id: 't3', status: isPreCheck ? 'pending' : 'running' };
        return null;
      });
      vi.spyOn(taskManager, 'startTask')
        .mockImplementationOnce(() => { throw new Error('busy'); })
        .mockImplementationOnce(() => undefined);
      const debugSpy = vi.spyOn(logger.constructor.prototype, 'debug').mockReturnValue(undefined);

      const result = loadHandlers().handleCreateFeatureWorkflow({
        feature_name: 'Inventory',
        working_directory: '/repo',
        types_task: 'Types',
        system_task: 'System',
        auto_run: true
      });

      expect(workflowEngine.updateWorkflow).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        status: 'running',
        started_at: expect.any(String)
      }));
      expect(taskManager.startTask).toHaveBeenCalledTimes(2);
      expect(debugSpy).toHaveBeenCalled();
      expect(textOf(result)).toContain('Feature Workflow Created & Started');
      expect(textOf(result)).toContain('**Queued:** 0 tasks');
      expect(textOf(result)).toContain('Use `await_workflow`');
    });
  });

});
