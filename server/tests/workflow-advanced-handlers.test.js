'use strict';

const MAX_SANITIZE_SLICE = 10240; // matches workflow-runtime.js slice(-10240)
const MAX_ERROR_SLICE = 5120;     // matches workflow-runtime.js slice(-5120)

function sanitizeForCondition(text) {
  if (typeof text !== 'string') return '';
  return text; // no secrets in test data, just return as-is
}

const { dbMock, taskManagerMock, loggerMock, loggerModuleMock, workflowRuntimeMock } = vi.hoisted(() => {
  const _dbMock = {
    getWorkflow: vi.fn(),
    createWorkflowFork: vi.fn(),
    createTask: vi.fn(),
    getWorkflowFork: vi.fn(),
    updateWorkflowForkStatus: vi.fn(),
    getTask: vi.fn(),
    createTaskReplay: vi.fn(),
    duplicatePipeline: vi.fn(),
    safeJsonParse: vi.fn(),
    exportTasksReport: vi.fn(),
    getWorkflowStatus: vi.fn(),
    getWorkflowDependencies: vi.fn(),
    updateTaskStatus: vi.fn(),
    updateWorkflow: vi.fn(),
    getWorkflowTasks: vi.fn(),
    updateWorkflowCounts: vi.fn(),
    getTaskDependents: vi.fn(),
    getTaskDependencies: vi.fn(),
    areTaskDependenciesSatisfied: vi.fn(),
    evaluateCondition: vi.fn(),
  };
  const _taskManagerMock = {
    startTask: vi.fn(),
  };
  const _loggerMock = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const _loggerModuleMock = {
    child: vi.fn(),
  };

  // Mock handleWorkflowTermination using the same logic as production but backed by _dbMock/_taskManagerMock.
  // Mirrors the evaluateWorkflowDependencies behavior from workflow-runtime.js so tests can verify
  // condition evaluation and downstream task unblocking.
  function _handleWorkflowTerminationImpl(taskId) {
    const task = _dbMock.getTask(taskId);
    if (!task || !task.workflow_id) return;

    const workflow = _dbMock.getWorkflow(task.workflow_id);
    if (!workflow || ['completed', 'failed', 'cancelled', 'paused'].includes(workflow.status)) return;

    const dependents = _dbMock.getTaskDependents(taskId);

    for (const dep of dependents) {
      const context = {
        exit_code: task.exit_code || 0,
        output: (task.output || '').slice(-MAX_SANITIZE_SLICE),
        error_output: (task.error_output || '').slice(-MAX_ERROR_SLICE),
        duration_seconds: 0,
        status: task.status,
      };

      let conditionPassed;
      if (dep.condition_expr) {
        conditionPassed = _dbMock.evaluateCondition(dep.condition_expr, context);
      } else {
        conditionPassed = ['completed', 'skipped'].includes(task.status);
      }

      if (conditionPassed) {
        const { satisfied } = _dbMock.areTaskDependenciesSatisfied(dep.task_id);
        if (satisfied) {
          _dbMock.updateTaskStatus(dep.task_id, 'pending');
          try {
            _taskManagerMock.startTask(dep.task_id);
          } catch (err) {
            _loggerMock.debug('[workflow-handlers] non-critical error restarting dependency task:', err.message);
          }
        }
      } else if (dep.on_fail === 'skip') {
        _dbMock.updateTaskStatus(dep.task_id, 'skipped');
      }
    }
  }

  const _workflowRuntimeMock = {
    handleWorkflowTermination: vi.fn().mockImplementation(_handleWorkflowTerminationImpl),
  };

  return {
    dbMock: _dbMock,
    taskManagerMock: _taskManagerMock,
    loggerMock: _loggerMock,
    loggerModuleMock: _loggerModuleMock,
    workflowRuntimeMock: _workflowRuntimeMock,
  };
});

let handlers;
let shared;

const databaseModulePath = require.resolve('../database');
const taskManagerModulePath = require.resolve('../task-manager');
const loggerModulePath = require.resolve('../logger');
const sharedHandlerPath = require.resolve('../handlers/shared');
const advancedHandlerPath = require.resolve('../handlers/workflow/advanced');
const workflowRuntimePath = require.resolve('../execution/workflow-runtime');
const originalModules = new Map();

function installModule(modulePath, exportsValue) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsValue,
    children: [],
    paths: [],
  };
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function expectError(result, code, snippet) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(code);
  if (snippet) {
    expect(getText(result)).toContain(snippet);
  }
}

function makeWorkflow(overrides = {}) {
  return {
    id: 'wf-1',
    name: 'Workflow 1',
    status: 'failed',
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    task_description: 'run unit tests',
    working_directory: '/repo',
    timeout_minutes: 30,
    auto_approve: false,
    priority: 2,
    template_name: 'default-template',
    status: 'failed',
    ...overrides,
  };
}

function makeReportTask(index, overrides = {}) {
  return {
    id: `abcdef12-0000-0000-0000-${String(index).padStart(12, '0')}`,
    status: index % 2 === 0 ? 'completed' : 'failed',
    task_description: `Task ${index} description`,
    project: index % 2 === 0 ? 'proj-a' : 'proj-b',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function resetMocks() {
  for (const group of [dbMock, taskManagerMock, loggerMock]) {
    for (const fn of Object.values(group)) {
      if (typeof fn?.mockReset === 'function') {
        fn.mockReset();
      }
    }
  }

  loggerModuleMock.child.mockReset();
  loggerModuleMock.child.mockReturnValue(loggerMock);

  dbMock.getWorkflow.mockReturnValue(null);
  dbMock.createWorkflowFork.mockImplementation((fork) => ({ ...fork }));
  dbMock.createTask.mockReturnValue(undefined);
  dbMock.getWorkflowFork.mockReturnValue(null);
  dbMock.updateWorkflowForkStatus.mockReturnValue(undefined);
  dbMock.getTask.mockReturnValue(null);
  dbMock.createTaskReplay.mockReturnValue(undefined);
  dbMock.duplicatePipeline.mockReturnValue(null);
  dbMock.safeJsonParse.mockReturnValue([]);
  dbMock.exportTasksReport.mockReturnValue({
    tasks: [],
    summary: { total: 0, by_status: {}, by_project: {} },
  });
  dbMock.getWorkflowStatus.mockReturnValue(null);
  dbMock.getWorkflowDependencies.mockReturnValue([]);
  dbMock.updateTaskStatus.mockReturnValue(undefined);
  dbMock.updateWorkflow.mockReturnValue(undefined);
  dbMock.getWorkflowTasks.mockReturnValue([]);
  dbMock.updateWorkflowCounts.mockReturnValue(undefined);
  dbMock.getTaskDependents.mockReturnValue([]);
  dbMock.getTaskDependencies.mockReturnValue([]);
  dbMock.areTaskDependenciesSatisfied.mockReturnValue({ satisfied: false, deps: [] });
  dbMock.evaluateCondition.mockReturnValue(true);

  taskManagerMock.startTask.mockReturnValue(undefined);

  // Restore the default workflow-runtime mock implementation after each reset
  workflowRuntimeMock.handleWorkflowTermination.mockImplementation(function _impl(taskId) {
    const task = dbMock.getTask(taskId);
    if (!task || !task.workflow_id) return;

    const workflow = dbMock.getWorkflow(task.workflow_id);
    if (!workflow || ['completed', 'failed', 'cancelled', 'paused'].includes(workflow.status)) return;

    const dependents = dbMock.getTaskDependents(taskId);

    for (const dep of dependents) {
      const context = {
        exit_code: task.exit_code || 0,
        output: (task.output || '').slice(-MAX_SANITIZE_SLICE),
        error_output: (task.error_output || '').slice(-MAX_ERROR_SLICE),
        duration_seconds: 0,
        status: task.status,
      };

      let conditionPassed;
      if (dep.condition_expr) {
        conditionPassed = dbMock.evaluateCondition(dep.condition_expr, context);
      } else {
        conditionPassed = ['completed', 'skipped'].includes(task.status);
      }

      if (conditionPassed) {
        const { satisfied } = dbMock.areTaskDependenciesSatisfied(dep.task_id);
        if (satisfied) {
          dbMock.updateTaskStatus(dep.task_id, 'pending');
          try {
            taskManagerMock.startTask(dep.task_id);
          } catch (err) {
            loggerMock.debug('[workflow-handlers] non-critical error restarting dependency task:', err.message);
          }
        }
      } else if (dep.on_fail === 'skip') {
        dbMock.updateTaskStatus(dep.task_id, 'skipped');
      }
    }
  });
}

describe('workflow advanced handlers', () => {
  beforeAll(() => {
    resetMocks();

    for (const modulePath of [
      databaseModulePath,
      taskManagerModulePath,
      loggerModulePath,
      workflowRuntimePath,
      sharedHandlerPath,
      advancedHandlerPath,
    ]) {
      originalModules.set(modulePath, require.cache[modulePath]);
    }

    installModule(databaseModulePath, dbMock);
    installModule(taskManagerModulePath, taskManagerMock);
    installModule(loggerModulePath, loggerModuleMock);
    installModule(workflowRuntimePath, workflowRuntimeMock);

    delete require.cache[sharedHandlerPath];
    delete require.cache[advancedHandlerPath];

    shared = require('../handlers/shared');
    handlers = require('../handlers/workflow/advanced');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete require.cache[sharedHandlerPath];
    delete require.cache[advancedHandlerPath];

    for (const modulePath of [
      databaseModulePath,
      taskManagerModulePath,
      loggerModulePath,
      workflowRuntimePath,
      sharedHandlerPath,
      advancedHandlerPath,
    ]) {
      const original = originalModules.get(modulePath);
      if (original) {
        require.cache[modulePath] = original;
      } else {
        delete require.cache[modulePath];
      }
    }
  });

  describe('handleForkWorkflow', () => {
    it('returns INVALID_PARAM when workflow_id is missing', () => {
      const result = handlers.handleForkWorkflow({
        branches: [{ name: 'a', tasks: ['one'] }, { name: 'b', tasks: ['two'] }],
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'workflow_id must be a non-empty string');
      expect(dbMock.getWorkflow).not.toHaveBeenCalled();
    });

    it('returns INVALID_PARAM when fewer than two branches are provided', () => {
      const result = handlers.handleForkWorkflow({
        workflow_id: 'wf-1',
        branches: [{ name: 'solo', tasks: ['one'] }],
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'branches must have at least 2 items');
      expect(dbMock.getWorkflow).not.toHaveBeenCalled();
    });

    it('returns INVALID_PARAM for unsupported merge strategies', () => {
      const result = handlers.handleForkWorkflow({
        workflow_id: 'wf-1',
        branches: [{ name: 'a', tasks: ['one'] }, { name: 'b', tasks: ['two'] }],
        merge_strategy: 'none',
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'merge_strategy must be "all", "any", or "first"');
    });

    it('returns WORKFLOW_NOT_FOUND when the workflow does not exist', () => {
      const result = handlers.handleForkWorkflow({
        workflow_id: 'wf-missing',
        branches: [{ name: 'a', tasks: ['one'] }, { name: 'b', tasks: ['two'] }],
      });

      expect(dbMock.getWorkflow).toHaveBeenCalledWith('wf-missing');
      expectError(result, shared.ErrorCodes.WORKFLOW_NOT_FOUND.code, 'Workflow not found: wf-missing');
    });

    it('creates a workflow fork and queues tasks for every branch', () => {
      dbMock.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-branch' }));

      const result = handlers.handleForkWorkflow({
        workflow_id: 'wf-branch',
        merge_strategy: 'first',
        branches: [
          { name: 'alpha', tasks: ['task A1', 'task A2'] },
          { name: 'beta', tasks: ['task B1'] },
        ],
      });

      const forkCall = dbMock.createWorkflowFork.mock.calls[0][0];
      const createdTasks = dbMock.createTask.mock.calls.map(([task]) => task);
      const text = getText(result);

      expect(forkCall).toEqual({
        id: expect.any(String),
        workflow_id: 'wf-branch',
        branches: [
          { name: 'alpha', tasks: ['task A1', 'task A2'] },
          { name: 'beta', tasks: ['task B1'] },
        ],
        branch_count: 2,
        merge_strategy: 'first',
      });
      expect(createdTasks).toHaveLength(3);
      expect(createdTasks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          task_description: 'task A1',
          workflow_id: 'wf-branch',
          status: 'queued',
        }),
        expect.objectContaining({
          id: expect.any(String),
          task_description: 'task A2',
          workflow_id: 'wf-branch',
          status: 'queued',
        }),
        expect.objectContaining({
          id: expect.any(String),
          task_description: 'task B1',
          workflow_id: 'wf-branch',
          status: 'queued',
        }),
      ]));
      expect(text).toContain('## Workflow Forked');
      expect(text).toContain('**Merge Strategy:** first');
      expect(text).toContain('**alpha:** 2 tasks');
      expect(text).toContain('**beta:** 1 tasks');
    });
  });

  describe('handleMergeWorkflows', () => {
    it('returns INVALID_PARAM when fork_id is missing', () => {
      const result = handlers.handleMergeWorkflows({});

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'fork_id must be a non-empty string');
      expect(dbMock.getWorkflowFork).not.toHaveBeenCalled();
    });

    it('returns RESOURCE_NOT_FOUND when the fork cannot be found', () => {
      const result = handlers.handleMergeWorkflows({ fork_id: 'fork-404' });

      expect(dbMock.getWorkflowFork).toHaveBeenCalledWith('fork-404');
      expectError(result, shared.ErrorCodes.RESOURCE_NOT_FOUND.code, 'Fork not found: fork-404');
    });

    it('marks the fork as merged and renders the merge details', () => {
      dbMock.getWorkflowFork.mockReturnValue({
        id: 'fork-1',
        workflow_id: 'wf-1',
        merge_strategy: 'any',
      });

      const result = handlers.handleMergeWorkflows({
        fork_id: 'fork-1',
        combine_outputs: false,
      });

      expect(dbMock.updateWorkflowForkStatus).toHaveBeenCalledWith('fork-1', 'merged');
      expect(getText(result)).toContain('## Workflow Branches Merged');
      expect(getText(result)).toContain('**Workflow:** wf-1');
      expect(getText(result)).toContain('**Strategy:** any');
      expect(getText(result)).toContain('**Outputs Combined:** false');
    });
  });

  describe('handleReplayTask', () => {
    it('returns INVALID_PARAM when task_id is missing', () => {
      const result = handlers.handleReplayTask({});

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'task_id must be a non-empty string');
      expect(dbMock.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the original task is missing', () => {
      const result = handlers.handleReplayTask({ task_id: 'task-missing' });

      expect(dbMock.getTask).toHaveBeenCalledWith('task-missing');
      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: task-missing');
    });

    it('creates a replay task and replay record with overrides', () => {
      dbMock.getTask.mockReturnValue(makeTask({
        id: 'task-orig',
        task_description: 'original task',
        working_directory: '/repo/original',
        timeout_minutes: 45,
        auto_approve: true,
        priority: 5,
        template_name: 'tmpl-1',
      }));

      const result = handlers.handleReplayTask({
        task_id: 'task-orig',
        modified_inputs: { task: 'updated task', provider: 'codex' },
        new_working_directory: '/repo/new',
      });

      const replayTask = dbMock.createTask.mock.calls[0][0];
      const replayRecord = dbMock.createTaskReplay.mock.calls[0][0];

      expect(replayTask).toEqual({
        id: expect.any(String),
        task_description: 'updated task',
        working_directory: '/repo/new',
        timeout_minutes: 45,
        auto_approve: true,
        priority: 5,
        template_name: 'tmpl-1',
        status: 'queued',
      });
      expect(replayRecord).toEqual({
        id: expect.any(String),
        original_task_id: 'task-orig',
        replay_task_id: replayTask.id,
        modified_inputs: { task: 'updated task', provider: 'codex' },
      });
      expect(getText(result)).toContain('## Task Replayed');
      expect(getText(result)).toContain(`**Replay Task:** \`${replayTask.id}\``);
      expect(getText(result)).toContain('**Modified Inputs:** task, provider');
    });

    it('falls back to the original task description and working directory when no overrides are provided', () => {
      dbMock.getTask.mockReturnValue(makeTask({
        id: 'task-orig',
        task_description: 'keep original task',
        working_directory: '/repo/original',
        timeout_minutes: 20,
      }));

      const result = handlers.handleReplayTask({ task_id: 'task-orig' });
      const replayTask = dbMock.createTask.mock.calls[0][0];

      expect(replayTask.task_description).toBe('keep original task');
      expect(replayTask.working_directory).toBe('/repo/original');
      expect(getText(result)).not.toContain('Modified Inputs');
    });
  });

  describe('handleDiffTaskRuns', () => {
    it('returns MISSING_REQUIRED_PARAM when both task ids are not provided', () => {
      const result = handlers.handleDiffTaskRuns({ task_id_a: 'task-a' });

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'Both task_id_a and task_id_b are required');
    });

    it('returns TASK_NOT_FOUND when task A does not exist', () => {
      dbMock.getTask.mockImplementation((taskId) => (taskId === 'task-b' ? makeTask({ id: 'task-b' }) : null));

      const result = handlers.handleDiffTaskRuns({
        task_id_a: 'task-a',
        task_id_b: 'task-b',
      });

      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: task-a');
    });

    it('returns TASK_NOT_FOUND when task B does not exist', () => {
      dbMock.getTask.mockImplementation((taskId) => (taskId === 'task-a' ? makeTask({ id: 'task-a' }) : null));

      const result = handlers.handleDiffTaskRuns({
        task_id_a: 'task-a',
        task_id_b: 'task-b',
      });

      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: task-b');
    });

    it('compares durations, arrays, and falsy values in the diff table', () => {
      dbMock.getTask.mockImplementation((taskId) => {
        if (taskId === 'task-a') {
          return makeTask({
            id: 'task-a',
            output: 'same output',
            files_modified: ['a.txt'],
            exit_code: 0,
            started_at: '2026-01-01T00:00:00.000Z',
            completed_at: '2026-01-01T00:00:10.000Z',
          });
        }

        return makeTask({
          id: 'task-b',
          output: 'different output',
          files_modified: ['a.txt'],
          exit_code: 1,
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T00:00:05.000Z',
        });
      });

      const result = handlers.handleDiffTaskRuns({
        task_id_a: 'task-a',
        task_id_b: 'task-b',
        compare_fields: ['duration', 'output', 'files_modified', 'exit_code'],
      });

      const text = getText(result);
      expect(text).toContain('## Task Comparison');
      expect(text).toContain('| duration | 10 | 5 | ✗ |');
      expect(text).toContain('| output | same output | different output | ✗ |');
      expect(text).toContain('| files_modified | a.txt | a.txt | ✓ |');
      expect(text).toContain('| exit_code | N/A | 1 | ✗ |');
    });

    it('renders N/A for missing durations and truncates long string fields to 30 characters', () => {
      dbMock.getTask.mockImplementation((taskId) => makeTask({
        id: taskId,
        output: taskId === 'task-a' ? 'A'.repeat(40) : 'B'.repeat(40),
      }));

      const result = handlers.handleDiffTaskRuns({
        task_id_a: 'task-a',
        task_id_b: 'task-b',
        compare_fields: ['duration', 'output'],
      });

      expect(getText(result)).toContain('| duration | N/A | N/A | ✓ |');
      expect(getText(result)).toContain(`| output | ${'A'.repeat(30)} | ${'B'.repeat(30)} | ✗ |`);
    });
  });

  describe('handleDuplicatePipeline', () => {
    it('returns PIPELINE_NOT_FOUND when the pipeline cannot be duplicated', () => {
      const result = handlers.handleDuplicatePipeline({
        pipeline_id: 'pipe-404',
        new_name: 'Clone',
      });

      expect(dbMock.duplicatePipeline).toHaveBeenCalledWith('pipe-404', 'Clone', {
        working_directory: undefined,
        auto_approve: undefined,
        timeout_minutes: undefined,
        description: undefined,
      });
      expectError(result, shared.ErrorCodes.PIPELINE_NOT_FOUND.code, 'Pipeline not found: pipe-404');
    });

    it('passes override options through and renders truncated pipeline steps', () => {
      dbMock.duplicatePipeline.mockReturnValue({
        id: 'pipe-2',
        name: 'Clone',
        description: 'Cloned pipeline',
        definition: '[{"task":"placeholder"}]',
      });
      dbMock.safeJsonParse.mockReturnValue([
        { task: 'short task' },
        { task: 'This is a very long task description that should be truncated at fifty characters for display' },
      ]);

      const result = handlers.handleDuplicatePipeline({
        pipeline_id: 'pipe-1',
        new_name: 'Clone',
        working_directory: '/repo',
        auto_approve: true,
        timeout_minutes: 90,
        description: 'Override description',
      });

      expect(dbMock.duplicatePipeline).toHaveBeenCalledWith('pipe-1', 'Clone', {
        working_directory: '/repo',
        auto_approve: true,
        timeout_minutes: 90,
        description: 'Override description',
      });
      expect(getText(result)).toContain('## Pipeline Cloned');
      expect(getText(result)).toContain('**New Pipeline:** Clone');
      expect(getText(result)).toContain('**Description:** Cloned pipeline');
      expect(getText(result)).toContain('**Steps:** 2');
      expect(getText(result)).toContain('| 1 | short task |');
      expect(getText(result)).toContain('This is a very long task description that should b...');
    });

    it('renders zero steps when the duplicated definition parses to an empty list', () => {
      dbMock.duplicatePipeline.mockReturnValue({
        id: 'pipe-empty',
        name: 'Empty Clone',
        description: 'No steps',
        definition: '[]',
      });
      dbMock.safeJsonParse.mockReturnValue([]);

      const result = handlers.handleDuplicatePipeline({
        pipeline_id: 'pipe-empty-source',
        new_name: 'Empty Clone',
      });

      expect(getText(result)).toContain('**Steps:** 0');
      expect(getText(result)).not.toContain('| 1 |');
    });
  });

  describe('handleExportReport', () => {
    it('returns an empty report message when no tasks match the criteria', () => {
      const result = handlers.handleExportReport({
        project: 'none',
        include_output: true,
      });

      expect(dbMock.exportTasksReport).toHaveBeenCalledWith({
        project: 'none',
        status: null,
        start_date: undefined,
        end_date: undefined,
        tags: undefined,
        include_output: true,
      });
      expect(getText(result)).toContain('No tasks found matching the criteria.');
    });

    it('renders csv output and splits comma-separated status filters', () => {
      dbMock.exportTasksReport.mockReturnValue({
        tasks: [{
          id: 'task-1',
          status: 'completed',
          task_description: 'he said "ok"',
          project: 'proj-a',
          priority: 2,
          progress_percent: 100,
          exit_code: 0,
          created_at: '2026-01-01T00:00:00.000Z',
        }],
        summary: {
          total: 1,
          by_status: { completed: 1 },
          by_project: { 'proj-a': 1 },
        },
      });

      const result = handlers.handleExportReport({
        format: 'csv',
        status: 'completed, failed',
        tags: 'smoke,regression',
      });

      expect(dbMock.exportTasksReport).toHaveBeenCalledWith({
        project: undefined,
        status: ['completed', 'failed'],
        start_date: undefined,
        end_date: undefined,
        tags: 'smoke,regression',
        include_output: false,
      });
      expect(getText(result)).toContain('## Task Report (CSV)');
      expect(getText(result)).toContain('id,status,task_description,project,priority,progress_percent,exit_code,created_at');
      expect(getText(result)).toContain('"he said ""ok"""');
    });

    it('renders json output and only includes the first twenty tasks in the preview', () => {
      const tasks = Array.from({ length: 22 }, (_, index) => ({
        id: `task-${index + 1}`,
        status: 'completed',
      }));
      dbMock.exportTasksReport.mockReturnValue({
        tasks,
        summary: {
          total: 22,
          by_status: { completed: 22 },
          by_project: {},
        },
      });

      const result = handlers.handleExportReport({ format: 'json' });
      const text = getText(result);

      expect(text).toContain('## Task Report (JSON)');
      expect(text).toContain('"total": 22');
      expect(text).toContain('"id": "task-20"');
      expect(text).not.toContain('"id": "task-21"');
      expect(text).toContain('// ... 2 more tasks');
    });

    it('renders markdown output with summary sections and caps visible rows at fifty tasks', () => {
      vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('1/1/2026');
      const tasks = Array.from({ length: 51 }, (_, index) => makeReportTask(index));
      dbMock.exportTasksReport.mockReturnValue({
        tasks,
        summary: {
          total: 51,
          by_status: { completed: 26, failed: 25 },
          by_project: { 'proj-a': 26, 'proj-b': 25 },
        },
      });

      const result = handlers.handleExportReport({});
      const text = getText(result);

      expect(text).toContain('## Task Report');
      expect(text).toContain('### Summary');
      expect(text).toContain('completed: 26');
      expect(text).toContain('proj-a: 26');
      expect(text).toContain('| abcdef12 | completed | Task 0 description... | proj-a | 1/1/2026 |');
      expect(text).toContain('Showing 50 of 51 tasks');
    });
  });

  describe('handleRetryWorkflowFrom', () => {
    it('returns WORKFLOW_NOT_FOUND when the workflow does not exist', () => {
      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-missing',
        from_task_id: 'task-1',
      });

      expect(dbMock.getWorkflow).toHaveBeenCalledWith('wf-missing');
      expectError(result, shared.ErrorCodes.WORKFLOW_NOT_FOUND.code, 'Workflow not found: wf-missing');
    });

    it('returns TASK_NOT_FOUND when the from_task is not part of the workflow', () => {
      dbMock.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-1' }));
      dbMock.getTask.mockReturnValue(makeTask({
        id: 'task-1',
        workflow_id: 'wf-other',
      }));

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-1',
        from_task_id: 'task-1',
      });

      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found in workflow wf-1: task-1');
      expect(dbMock.getWorkflowStatus).not.toHaveBeenCalled();
    });

    it('returns INVALID_STATUS_TRANSITION when the workflow still has live runnable work', () => {
      dbMock.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-1', status: 'running' }));
      dbMock.getTask.mockReturnValue(makeTask({
        id: 'task-a',
        workflow_id: 'wf-1',
        workflow_node_id: 'A',
      }));
      dbMock.getWorkflowStatus.mockReturnValue({
        id: 'wf-1',
        name: 'Workflow 1',
        status: 'running',
        tasks: {
          'task-a': { id: 'task-a', status: 'failed' },
          'task-b': { id: 'task-b', status: 'running' },
          'task-c': { id: 'task-c', status: 'queued' },
        },
      });

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-1',
        from_task_id: 'task-a',
      });

      expectError(result, shared.ErrorCodes.INVALID_STATUS_TRANSITION.code, 'still has live runnable work');
      expect(dbMock.getWorkflowDependencies).not.toHaveBeenCalled();
      expect(dbMock.updateTaskStatus).not.toHaveBeenCalled();
      expect(taskManagerMock.startTask).not.toHaveBeenCalled();
    });

    it('resets downstream tasks, restarts pending work, and logs non-critical start errors', () => {
      const taskState = {
        'task-a': makeTask({
          id: 'task-a',
          workflow_id: 'wf-1',
          workflow_node_id: 'A',
          status: 'failed',
        }),
        'task-b': makeTask({
          id: 'task-b',
          workflow_id: 'wf-1',
          workflow_node_id: 'B',
          status: 'failed',
        }),
        'task-c': makeTask({
          id: 'task-c',
          workflow_id: 'wf-1',
          workflow_node_id: 'C',
          status: 'failed',
        }),
      };

      dbMock.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-1', name: 'Retry Workflow' }));
      dbMock.getTask.mockImplementation((taskId) => taskState[taskId] || null);
      dbMock.getWorkflowStatus.mockReturnValue({
        id: 'wf-1',
        name: 'Retry Workflow',
        status: 'failed',
        tasks: taskState,
      });
      dbMock.getWorkflowDependencies.mockReturnValue([
        { task_id: 'task-b', depends_on_task_id: 'task-a' },
        { task_id: 'task-c', depends_on_task_id: 'task-b' },
      ]);
      dbMock.updateTaskStatus.mockImplementation((taskId, status, extra = {}) => {
        if (taskState[taskId]) {
          taskState[taskId] = { ...taskState[taskId], status, ...extra };
        }
      });
      dbMock.getWorkflowTasks.mockImplementation(() => Object.values(taskState));
      taskManagerMock.startTask.mockImplementation((taskId) => {
        if (taskId === 'task-a') {
          throw new Error('queued elsewhere');
        }
      });

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-1',
        from_task_id: 'task-a',
      });

      expect(dbMock.updateTaskStatus).toHaveBeenCalledWith('task-a', 'pending');
      expect(dbMock.updateTaskStatus).toHaveBeenCalledWith('task-b', 'blocked');
      expect(dbMock.updateTaskStatus).toHaveBeenCalledWith('task-c', 'blocked');
      expect(dbMock.updateWorkflow).toHaveBeenCalledWith('wf-1', expect.objectContaining({
        status: 'running',
        completed_at: null,
      }));
      expect(taskManagerMock.startTask).toHaveBeenCalledWith('task-a');
      expect(loggerMock.debug).toHaveBeenCalledWith(
        '[workflow-handlers] non-critical error restarting pending workflow task:',
        'queued elsewhere'
      );
      expect(getText(result)).toContain('## Workflow Restarted');
      expect(getText(result)).toContain('**From Task:** A');
      expect(getText(result)).toContain('**Tasks Reset:** 3');
    });

    it('ignores missing downstream tasks while counting only tasks that were actually reset', () => {
      const taskState = {
        'task-a': makeTask({
          id: 'task-a',
          workflow_id: 'wf-1',
          workflow_node_id: 'A',
          status: 'failed',
        }),
        'task-b': makeTask({
          id: 'task-b',
          workflow_id: 'wf-1',
          workflow_node_id: 'B',
          status: 'failed',
        }),
      };

      dbMock.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-1' }));
      dbMock.getTask.mockImplementation((taskId) => taskState[taskId] || null);
      dbMock.getWorkflowDependencies.mockReturnValue([
        { task_id: 'task-b', depends_on_task_id: 'task-a' },
        { task_id: 'task-missing', depends_on_task_id: 'task-b' },
      ]);
      dbMock.updateTaskStatus.mockImplementation((taskId, status) => {
        if (taskState[taskId]) {
          taskState[taskId].status = status;
        }
      });
      dbMock.getWorkflowTasks.mockImplementation(() => Object.values(taskState));

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-1',
        from_task_id: 'task-a',
      });

      expect(dbMock.updateTaskStatus).toHaveBeenCalledTimes(2);
      expect(getText(result)).toContain('**Tasks Reset:** 2');
    });

    it('skips downstream tasks that are already running', () => {
      const taskState = {
        'task-a': makeTask({
          id: 'task-a',
          workflow_id: 'wf-1',
          workflow_node_id: 'A',
          status: 'failed',
        }),
        'task-b': makeTask({
          id: 'task-b',
          workflow_id: 'wf-1',
          workflow_node_id: 'B',
          status: 'running',
        }),
        'task-c': makeTask({
          id: 'task-c',
          workflow_id: 'wf-1',
          workflow_node_id: 'C',
          status: 'failed',
        }),
      };

      dbMock.getWorkflow.mockReturnValue(makeWorkflow({ id: 'wf-1' }));
      dbMock.getTask.mockImplementation((taskId) => taskState[taskId] || null);
      dbMock.getWorkflowDependencies.mockReturnValue([
        { task_id: 'task-b', depends_on_task_id: 'task-a' },
        { task_id: 'task-c', depends_on_task_id: 'task-b' },
      ]);
      dbMock.updateTaskStatus.mockImplementation((taskId, status) => {
        if (taskState[taskId]) {
          taskState[taskId].status = status;
        }
      });
      dbMock.getWorkflowTasks.mockImplementation(() => Object.values(taskState));

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-1',
        from_task_id: 'task-a',
      });

      expect(dbMock.updateTaskStatus).toHaveBeenCalledWith('task-a', 'pending');
      expect(dbMock.updateTaskStatus).not.toHaveBeenCalledWith('task-b', 'blocked');
      expect(dbMock.updateTaskStatus).toHaveBeenCalledWith('task-c', 'blocked');
      expect(getText(result)).toContain('**Tasks Reset:** 2');
    });
  });

  describe('handleSkipTask', () => {
    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      const result = handlers.handleSkipTask({ task_id: 'task-missing' });

      expect(dbMock.getTask).toHaveBeenCalledWith('task-missing');
      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: task-missing');
    });

    it('returns INVALID_STATUS_TRANSITION when the task is not blocked', () => {
      dbMock.getTask.mockReturnValue(makeTask({
        id: 'task-1',
        status: 'running',
      }));

      const result = handlers.handleSkipTask({ task_id: 'task-1' });

      expectError(result, shared.ErrorCodes.INVALID_STATUS_TRANSITION.code, 'Task is not blocked. Current status: running');
      expect(dbMock.updateTaskStatus).not.toHaveBeenCalled();
    });

    it('skips a blocked standalone task with the default reason', () => {
      dbMock.getTask.mockReturnValue(makeTask({
        id: 'task-123456789',
        status: 'blocked',
        workflow_id: null,
      }));

      const result = handlers.handleSkipTask({ task_id: 'task-123456789' });

      expect(dbMock.updateTaskStatus).toHaveBeenCalledWith('task-123456789', 'skipped', {
        error_output: 'Manually skipped',
      });
      expect(dbMock.updateWorkflowCounts).not.toHaveBeenCalled();
      expect(getText(result)).toContain('## Task Skipped');
      expect(getText(result)).toContain('**Task:** task-123');
    });

    it('updates workflow counts, evaluates dependency conditions, and logs start errors when unblocking dependents', () => {
      const taskState = {
        root: makeTask({
          id: 'root',
          workflow_id: 'wf-1',
          workflow_node_id: 'root-node',
          status: 'blocked',
          exit_code: 0,
          output: 'A'.repeat(11000),
          error_output: 'B'.repeat(6000),
        }),
        dep: makeTask({
          id: 'dep',
          workflow_id: 'wf-1',
          workflow_node_id: 'dep-node',
          status: 'blocked',
        }),
      };

      dbMock.getWorkflow.mockReturnValue({ id: 'wf-1', name: 'Workflow 1', status: 'running' });
      dbMock.getTask.mockImplementation((taskId) => taskState[taskId] || null);
      dbMock.updateTaskStatus.mockImplementation((taskId, status, extra = {}) => {
        if (taskState[taskId]) {
          taskState[taskId] = { ...taskState[taskId], status, ...extra };
        }
      });
      dbMock.getTaskDependents.mockReturnValue([{
        task_id: 'dep',
        depends_on_task_id: 'root',
        condition_expr: 'exit_code == 0',
        on_fail: 'skip',
      }]);
      dbMock.areTaskDependenciesSatisfied.mockReturnValue({
        satisfied: true,
        deps: [{
          depends_on_task_id: 'root',
          condition_expr: 'exit_code == 0',
        }],
      });
      taskManagerMock.startTask.mockImplementation(() => {
        throw new Error('already queued');
      });

      const result = handlers.handleSkipTask({
        task_id: 'root',
        reason: 'manual override',
      });

      const conditionContext = dbMock.evaluateCondition.mock.calls[0][1];

      expect(dbMock.updateTaskStatus).toHaveBeenCalledWith('root', 'skipped', {
        error_output: 'manual override',
      });
      expect(dbMock.updateWorkflowCounts).toHaveBeenCalledWith('wf-1');
      expect(dbMock.evaluateCondition).toHaveBeenCalledWith('exit_code == 0', expect.any(Object));
      expect(conditionContext.exit_code).toBe(0);
      expect(conditionContext.status).toBe('skipped');
      expect(conditionContext.output).toHaveLength(10240);
      expect(conditionContext.error_output).toBe('manual override');
      expect(dbMock.updateTaskStatus).toHaveBeenCalledWith('dep', 'pending');
      expect(taskManagerMock.startTask).toHaveBeenCalledWith('dep');
      expect(loggerMock.debug).toHaveBeenCalledWith(
        '[workflow-handlers] non-critical error restarting dependency task:',
        'already queued'
      );
      expect(getText(result)).toContain('**Task:** root-node');
      expect(getText(result)).toContain('**Reason:** manual override');
    });

    it('skips dependents when a dependency condition fails with on_fail=skip', () => {
      const taskState = {
        root: makeTask({
          id: 'root',
          workflow_id: 'wf-1',
          workflow_node_id: 'root-node',
          status: 'blocked',
          exit_code: 1,
          output: '',
          error_output: 'boom',
        }),
        dep: makeTask({
          id: 'dep',
          workflow_id: 'wf-1',
          workflow_node_id: 'dep-node',
          status: 'blocked',
        }),
      };

      dbMock.getWorkflow.mockReturnValue({ id: 'wf-1', name: 'Workflow 1', status: 'running' });
      dbMock.getTask.mockImplementation((taskId) => taskState[taskId] || null);
      dbMock.updateTaskStatus.mockImplementation((taskId, status, extra = {}) => {
        if (taskState[taskId]) {
          taskState[taskId] = { ...taskState[taskId], status, ...extra };
        }
      });
      dbMock.getTaskDependents.mockReturnValue([{
        task_id: 'dep',
        depends_on_task_id: 'root',
        condition_expr: 'exit_code == 0',
        on_fail: 'skip',
      }]);
      dbMock.evaluateCondition.mockReturnValue(false);

      const result = handlers.handleSkipTask({ task_id: 'root' });

      expect(dbMock.updateTaskStatus).toHaveBeenCalledWith('dep', 'skipped');
      expect(taskManagerMock.startTask).not.toHaveBeenCalled();
      expect(getText(result)).toContain('## Task Skipped');
    });

    it('leaves blocked dependents unchanged when prerequisites are still unsatisfied', () => {
      const taskState = {
        root: makeTask({
          id: 'root',
          workflow_id: 'wf-1',
          status: 'blocked',
        }),
        dep: makeTask({
          id: 'dep',
          workflow_id: 'wf-1',
          status: 'blocked',
        }),
      };

      dbMock.getTask.mockImplementation((taskId) => taskState[taskId] || null);
      dbMock.updateTaskStatus.mockImplementation((taskId, status, extra = {}) => {
        if (taskState[taskId]) {
          taskState[taskId] = { ...taskState[taskId], status, ...extra };
        }
      });
      dbMock.getTaskDependents.mockReturnValue([{ task_id: 'dep' }]);
      dbMock.areTaskDependenciesSatisfied.mockReturnValue({
        satisfied: false,
        deps: [],
      });

      handlers.handleSkipTask({ task_id: 'root' });

      expect(dbMock.evaluateCondition).not.toHaveBeenCalled();
      expect(taskManagerMock.startTask).not.toHaveBeenCalled();
      expect(taskState.dep.status).toBe('blocked');
    });
  });
});
