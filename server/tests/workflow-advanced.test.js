'use strict';

const MODULE_PATH = '../handlers/workflow/advanced';
const MOCKED_MODULES = [
  MODULE_PATH,
  '../database',
  '../task-manager',
  '../logger',
  '../handlers/shared',
  'uuid',
];

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Ignore cache misses while preparing isolated module state.
  }
}

const uuidState = {
  queue: [],
  counter: 0,
};

const mockDb = {
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
  areTaskDependenciesSatisfied: vi.fn(),
  evaluateCondition: vi.fn(),
};

const mockTaskManager = {
  startTask: vi.fn(),
};

const mockLogger = {
  child: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockShared = {
  ErrorCodes: {
    INVALID_PARAM: 'INVALID_PARAM',
    MISSING_REQUIRED_PARAM: 'MISSING_REQUIRED_PARAM',
    RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
    WORKFLOW_NOT_FOUND: 'WORKFLOW_NOT_FOUND',
    TASK_NOT_FOUND: 'TASK_NOT_FOUND',
    PIPELINE_NOT_FOUND: 'PIPELINE_NOT_FOUND',
    INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  },
  getWorkflowRestartGuardError: vi.fn(),
  makeError(code, message, details) {
    return {
      isError: true,
      error_code: code,
      content: [{ type: 'text', text: message }],
      ...(details !== undefined ? { details } : {}),
    };
  },
  requireTask(db, taskId) {
    if (!taskId) return { error: mockShared.makeError(mockShared.ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required') };
    const task = db.getTask(taskId);
    if (!task) return { error: mockShared.makeError(mockShared.ErrorCodes.TASK_NOT_FOUND, `Task not found: ${taskId}`) };
    return { task };
  },
  requireWorkflow(db, workflowId) {
    if (!workflowId) return { error: mockShared.makeError(mockShared.ErrorCodes.MISSING_REQUIRED_PARAM, 'workflow_id is required') };
    const workflow = db.getWorkflow(workflowId);
    if (!workflow) return { error: mockShared.makeError(mockShared.ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow not found: ${workflowId}`) };
    return { workflow };
  },
};

const mockUuid = {
  v4: vi.fn(),
};

function queueUuids(...ids) {
  uuidState.queue = ids.slice();
  uuidState.counter = 0;
}

function resetMockDefaults() {
  for (const group of [mockDb, mockTaskManager, mockLogger, mockShared, mockUuid]) {
    for (const fn of Object.values(group)) {
      if (typeof fn?.mockReset === 'function') {
        fn.mockReset();
      }
    }
  }

  queueUuids();
  mockUuid.v4.mockImplementation(() => {
    if (uuidState.queue.length > 0) {
      return uuidState.queue.shift();
    }
    uuidState.counter += 1;
    return `generated-id-${uuidState.counter}`;
  });

  mockLogger.child.mockReturnValue(mockLogger);

  mockShared.getWorkflowRestartGuardError.mockReturnValue(null);

  mockDb.getWorkflow.mockReturnValue(null);
  mockDb.createWorkflowFork.mockImplementation((fork) => fork);
  mockDb.createTask.mockReturnValue(undefined);
  mockDb.getWorkflowFork.mockReturnValue(null);
  mockDb.updateWorkflowForkStatus.mockReturnValue(undefined);
  mockDb.getTask.mockReturnValue(null);
  mockDb.createTaskReplay.mockReturnValue(undefined);
  mockDb.duplicatePipeline.mockReturnValue(null);
  mockDb.safeJsonParse.mockReturnValue([]);
  mockDb.exportTasksReport.mockReturnValue({
    tasks: [],
    summary: { total: 0, by_status: {}, by_project: {} },
  });
  mockDb.getWorkflowStatus.mockReturnValue(null);
  mockDb.getWorkflowDependencies.mockReturnValue([]);
  mockDb.updateTaskStatus.mockReturnValue(undefined);
  mockDb.updateWorkflow.mockReturnValue(undefined);
  mockDb.getWorkflowTasks.mockReturnValue([]);
  mockDb.updateWorkflowCounts.mockReturnValue(undefined);
  mockDb.getTaskDependents.mockReturnValue([]);
  mockDb.areTaskDependenciesSatisfied.mockReturnValue({ satisfied: false, deps: [] });
  mockDb.evaluateCondition.mockReturnValue(true);
}

function loadHandlers() {
  for (const modulePath of MOCKED_MODULES) {
    clearModule(modulePath);
  }

  installMock('../database', mockDb);
  installMock('../task-manager', mockTaskManager);
  installMock('../logger', mockLogger);
  installMock('../handlers/shared', mockShared);
  installMock('uuid', mockUuid);

  return require(MODULE_PATH);
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('server/handlers/workflow/advanced', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const modulePath of MOCKED_MODULES) {
      clearModule(modulePath);
    }
  });

  describe('handleForkWorkflow', () => {
    it('returns INVALID_PARAM when workflow_id is missing', () => {
      const result = handlers.handleForkWorkflow({
        branches: [{ name: 'a', tasks: ['one'] }, { name: 'b', tasks: ['two'] }],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('workflow_id must be a non-empty string');
      expect(mockDb.getWorkflow).not.toHaveBeenCalled();
    });

    it('returns WORKFLOW_NOT_FOUND when the workflow does not exist', () => {
      const result = handlers.handleForkWorkflow({
        workflow_id: 'wf-missing',
        branches: [{ name: 'a', tasks: ['one'] }, { name: 'b', tasks: ['two'] }],
      });

      expect(mockDb.getWorkflow).toHaveBeenCalledWith('wf-missing');
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
      expect(getText(result)).toContain('Workflow not found: wf-missing');
    });

    it('creates a fork and queued branch tasks', () => {
      queueUuids('fork-1', 'task-a1', 'task-a2', 'task-b1');
      mockDb.getWorkflow.mockReturnValue({ id: 'wf-1', name: 'Workflow 1' });
      mockDb.createWorkflowFork.mockImplementation((fork) => ({ ...fork }));

      const result = handlers.handleForkWorkflow({
        workflow_id: 'wf-1',
        branches: [
          { name: 'parallel-a', tasks: ['a1', 'a2'] },
          { name: 'parallel-b', tasks: ['b1'] },
        ],
      });

      expect(mockDb.createWorkflowFork).toHaveBeenCalledWith({
        id: 'fork-1',
        workflow_id: 'wf-1',
        branches: [
          { name: 'parallel-a', tasks: ['a1', 'a2'] },
          { name: 'parallel-b', tasks: ['b1'] },
        ],
        branch_count: 2,
        merge_strategy: 'all',
      });
      expect(mockDb.createTask).toHaveBeenCalledTimes(3);
      expect(mockDb.createTask).toHaveBeenCalledWith({
        id: 'task-a1',
        task_description: 'a1',
        workflow_id: 'wf-1',
        status: 'queued',
      });
      expect(mockDb.createTask).toHaveBeenCalledWith({
        id: 'task-a2',
        task_description: 'a2',
        workflow_id: 'wf-1',
        status: 'queued',
      });
      expect(mockDb.createTask).toHaveBeenCalledWith({
        id: 'task-b1',
        task_description: 'b1',
        workflow_id: 'wf-1',
        status: 'queued',
      });
      expect(getText(result)).toContain('Workflow Forked');
      expect(getText(result)).toContain('parallel-a');
      expect(getText(result)).toContain('parallel-b');
      expect(getText(result)).toContain('fork-1');
    });
  });

  describe('handleMergeWorkflows', () => {
    it('returns INVALID_PARAM when fork_id is missing', () => {
      const result = handlers.handleMergeWorkflows({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('fork_id must be a non-empty string');
      expect(mockDb.getWorkflowFork).not.toHaveBeenCalled();
    });

    it('returns RESOURCE_NOT_FOUND when the fork does not exist', () => {
      const result = handlers.handleMergeWorkflows({ fork_id: 'fork-404' });

      expect(mockDb.getWorkflowFork).toHaveBeenCalledWith('fork-404');
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(getText(result)).toContain('Fork not found: fork-404');
    });

    it('marks the fork as merged and renders merge details', () => {
      mockDb.getWorkflowFork.mockReturnValue({
        id: 'fork-1',
        workflow_id: 'wf-1',
        merge_strategy: 'any',
      });

      const result = handlers.handleMergeWorkflows({
        fork_id: 'fork-1',
        combine_outputs: false,
      });

      expect(mockDb.updateWorkflowForkStatus).toHaveBeenCalledWith('fork-1', 'merged');
      expect(getText(result)).toContain('Workflow Branches Merged');
      expect(getText(result)).toContain('**Workflow:** wf-1');
      expect(getText(result)).toContain('**Strategy:** any');
      expect(getText(result)).toContain('**Outputs Combined:** false');
    });
  });

  describe('handleReplayTask', () => {
    it('returns INVALID_PARAM when task_id is missing', () => {
      const result = handlers.handleReplayTask({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('task_id must be a non-empty string');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the original task does not exist', () => {
      const result = handlers.handleReplayTask({ task_id: 'task-missing' });

      expect(mockDb.getTask).toHaveBeenCalledWith('task-missing');
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getText(result)).toContain('Task not found: task-missing');
    });

    it('creates a replay task and replay record with overrides', () => {
      queueUuids('replay-task-1', 'replay-record-1');
      mockDb.getTask.mockReturnValue({
        id: 'task-1',
        task_description: 'original task',
        working_directory: '/repo',
        timeout_minutes: 25,
        auto_approve: true,
        priority: 3,
        template_name: 'tmpl-A',
      });

      const result = handlers.handleReplayTask({
        task_id: 'task-1',
        modified_inputs: { task: 'updated task', extra: 'x' },
        new_working_directory: '/repo/new',
      });

      expect(mockDb.createTask).toHaveBeenCalledWith({
        id: 'replay-task-1',
        task_description: 'updated task',
        working_directory: '/repo/new',
        timeout_minutes: 25,
        auto_approve: true,
        priority: 3,
        template_name: 'tmpl-A',
        status: 'queued',
      });
      expect(mockDb.createTaskReplay).toHaveBeenCalledWith({
        id: 'replay-record-1',
        original_task_id: 'task-1',
        replay_task_id: 'replay-task-1',
        modified_inputs: { task: 'updated task', extra: 'x' },
      });
      expect(getText(result)).toContain('Task Replayed');
      expect(getText(result)).toContain('Replay Task:** `replay-task-1`');
      expect(getText(result)).toContain('Modified Inputs:');
    });
  });

  describe('handleDiffTaskRuns', () => {
    it('returns MISSING_REQUIRED_PARAM when either task id is missing', () => {
      const result = handlers.handleDiffTaskRuns({ task_id_a: 'task-a' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('Both task_id_a and task_id_b are required');
    });

    it('returns TASK_NOT_FOUND when task A does not exist', () => {
      mockDb.getTask.mockImplementation((taskId) => (
        taskId === 'task-b' ? { id: 'task-b' } : null
      ));

      const result = handlers.handleDiffTaskRuns({
        task_id_a: 'task-a',
        task_id_b: 'task-b',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getText(result)).toContain('Task not found: task-a');
    });

    it('returns TASK_NOT_FOUND when task B does not exist', () => {
      mockDb.getTask.mockImplementation((taskId) => (
        taskId === 'task-a' ? { id: 'task-a' } : null
      ));

      const result = handlers.handleDiffTaskRuns({
        task_id_a: 'task-a',
        task_id_b: 'task-b',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getText(result)).toContain('Task not found: task-b');
    });

    it('compares the requested task fields and durations', () => {
      mockDb.getTask.mockImplementation((taskId) => {
        if (taskId === 'task-a') {
          return {
            id: 'task-a',
            output: 'same output',
            exit_code: 0,
            started_at: '2026-01-01T00:00:00.000Z',
            completed_at: '2026-01-01T00:00:10.000Z',
          };
        }

        return {
          id: 'task-b',
          output: 'different output',
          exit_code: 1,
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T00:00:05.000Z',
        };
      });

      const result = handlers.handleDiffTaskRuns({
        task_id_a: 'task-a',
        task_id_b: 'task-b',
        compare_fields: ['duration', 'output', 'exit_code'],
      });

      const text = getText(result);
      expect(text).toContain('Task Comparison');
      expect(text).toContain('| duration | 10 | 5 | ✗ |');
      expect(text).toContain('| output | same output | different output | ✗ |');
      expect(text).toContain('| exit_code | N/A | 1 | ✗ |');
    });
  });

  describe('handleDuplicatePipeline', () => {
    it('returns PIPELINE_NOT_FOUND when the pipeline cannot be duplicated', () => {
      const result = handlers.handleDuplicatePipeline({
        pipeline_id: 'pipe-missing',
        new_name: 'Clone',
      });

      expect(mockDb.duplicatePipeline).toHaveBeenCalledWith('pipe-missing', 'Clone', {
        working_directory: undefined,
        auto_approve: undefined,
        timeout_minutes: undefined,
        description: undefined,
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('PIPELINE_NOT_FOUND');
      expect(getText(result)).toContain('Pipeline not found: pipe-missing');
    });

    it('renders the duplicated pipeline with truncated steps', () => {
      mockDb.duplicatePipeline.mockReturnValue({
        id: 'pipe-2',
        name: 'Clone',
        description: 'Cloned pipeline',
        definition: '[{"task":"placeholder"}]',
      });
      mockDb.safeJsonParse.mockReturnValue([
        { task: 'short task' },
        { task: 'This is a very long task description that should be truncated at fifty characters for display' },
      ]);

      const result = handlers.handleDuplicatePipeline({
        pipeline_id: 'pipe-1',
        new_name: 'Clone',
      });

      expect(getText(result)).toContain('Pipeline Cloned');
      expect(getText(result)).toContain('**New Pipeline:** Clone');
      expect(getText(result)).toContain('**ID:** pipe-2');
      expect(getText(result)).toContain('**Steps:** 2');
      expect(getText(result)).toContain('| 1 | short task |');
      expect(getText(result)).toContain('...');
    });
  });

  describe('handleExportReport', () => {
    it('returns an empty report when no tasks match the criteria', () => {
      const result = handlers.handleExportReport({ project: 'none' });

      expect(mockDb.exportTasksReport).toHaveBeenCalledWith({
        project: 'none',
        status: null,
        start_date: undefined,
        end_date: undefined,
        tags: undefined,
        include_output: false,
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No tasks found matching the criteria.');
    });

    it('renders csv output and splits comma-separated status filters', () => {
      mockDb.exportTasksReport.mockReturnValue({
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
      });

      expect(mockDb.exportTasksReport).toHaveBeenCalledWith({
        project: undefined,
        status: ['completed', 'failed'],
        start_date: undefined,
        end_date: undefined,
        tags: undefined,
        include_output: false,
      });
      expect(getText(result)).toContain('Task Report (CSV)');
      expect(getText(result)).toContain('id,status,task_description,project,priority,progress_percent,exit_code,created_at');
      expect(getText(result)).toContain('"he said ""ok"""');
    });

    it('renders json output and notes additional rows beyond the first 20', () => {
      const tasks = Array.from({ length: 22 }, (_, index) => ({
        id: `task-${index + 1}`,
        status: 'completed',
      }));
      mockDb.exportTasksReport.mockReturnValue({
        tasks,
        summary: {
          total: 22,
          by_status: { completed: 22 },
          by_project: {},
        },
      });

      const result = handlers.handleExportReport({ format: 'json' });

      expect(getText(result)).toContain('Task Report (JSON)');
      expect(getText(result)).toContain('"total": 22');
      expect(getText(result)).toContain('// ... 2 more tasks');
    });

    it('renders markdown output with summary sections and task cap note', () => {
      vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('1/1/2026');
      const tasks = Array.from({ length: 51 }, (_, index) => ({
        id: `abcdef12-0000-0000-0000-${String(index).padStart(12, '0')}`,
        status: index % 2 === 0 ? 'completed' : 'failed',
        task_description: `Task ${index} description`,
        project: index % 2 === 0 ? 'proj-a' : 'proj-b',
        created_at: '2026-01-01T00:00:00.000Z',
      }));
      mockDb.exportTasksReport.mockReturnValue({
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

      expect(mockDb.getWorkflow).toHaveBeenCalledWith('wf-missing');
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
      expect(getText(result)).toContain('Workflow not found: wf-missing');
    });

    it('returns TASK_NOT_FOUND when the task is not in the workflow', () => {
      mockDb.getWorkflow.mockReturnValue({ id: 'wf-1' });
      mockDb.getTask.mockReturnValue({ id: 'task-1', workflow_id: 'wf-other' });

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-1',
        from_task_id: 'task-1',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getText(result)).toContain('Task not found in workflow wf-1: task-1');
      expect(mockShared.getWorkflowRestartGuardError).not.toHaveBeenCalled();
    });

    it('returns the restart guard error when the workflow still has runnable work', () => {
      const guardError = mockShared.makeError(
        mockShared.ErrorCodes.INVALID_STATUS_TRANSITION,
        'Cannot retry because work is still running',
      );
      mockDb.getWorkflow.mockReturnValue({ id: 'wf-1', name: 'Workflow 1' });
      mockDb.getTask.mockReturnValue({ id: 'task-1', workflow_id: 'wf-1' });
      mockDb.getWorkflowStatus.mockReturnValue({
        id: 'wf-1',
        status: 'running',
      });
      mockShared.getWorkflowRestartGuardError.mockReturnValue(guardError);

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-1',
        from_task_id: 'task-1',
      });

      expect(result).toEqual(guardError);
      expect(mockDb.getWorkflowDependencies).not.toHaveBeenCalled();
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    });

    it('resets downstream tasks and restarts pending work', () => {
      const taskState = {
        'task-a': { id: 'task-a', workflow_id: 'wf-1', workflow_node_id: 'A', status: 'failed' },
        'task-b': { id: 'task-b', workflow_id: 'wf-1', workflow_node_id: 'B', status: 'failed' },
        'task-c': { id: 'task-c', workflow_id: 'wf-1', workflow_node_id: 'C', status: 'failed' },
      };

      mockDb.getWorkflow.mockReturnValue({ id: 'wf-1', name: 'Retry Workflow' });
      mockDb.getTask.mockImplementation((taskId) => taskState[taskId] || null);
      mockDb.getWorkflowStatus.mockReturnValue({
        id: 'wf-1',
        name: 'Retry Workflow',
        status: 'failed',
        tasks: taskState,
      });
      mockDb.getWorkflowDependencies.mockReturnValue([
        { task_id: 'task-b', depends_on_task_id: 'task-a' },
        { task_id: 'task-c', depends_on_task_id: 'task-b' },
      ]);
      mockDb.updateTaskStatus.mockImplementation((taskId, status, extra = {}) => {
        if (taskState[taskId]) {
          taskState[taskId] = { ...taskState[taskId], status, ...extra };
        }
      });
      mockDb.getWorkflowTasks.mockImplementation(() => Object.values(taskState));

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-1',
        from_task_id: 'task-a',
      });

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-a', 'pending');
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-b', 'blocked');
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-c', 'blocked');
      expect(mockDb.updateWorkflow).toHaveBeenCalledWith('wf-1', {
        status: 'running',
        completed_at: null,
      });
      expect(mockTaskManager.startTask).toHaveBeenCalledWith('task-a');
      expect(getText(result)).toContain('Workflow Restarted');
      expect(getText(result)).toContain('**From Task:** A');
      expect(getText(result)).toContain('**Tasks Reset:** 3');
    });
  });

  describe('handleSkipTask', () => {
    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      const result = handlers.handleSkipTask({ task_id: 'task-missing' });

      expect(mockDb.getTask).toHaveBeenCalledWith('task-missing');
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getText(result)).toContain('Task not found: task-missing');
    });

    it('returns INVALID_STATUS_TRANSITION when the task is not blocked', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-1', status: 'running' });

      const result = handlers.handleSkipTask({ task_id: 'task-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
      expect(getText(result)).toContain('Task is not blocked. Current status: running');
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    });

    it('skips a blocked task and unblocks a dependent when conditions pass', () => {
      const taskState = {
        root: {
          id: 'root',
          workflow_id: 'wf-1',
          workflow_node_id: 'root-node',
          status: 'blocked',
          exit_code: 0,
          output: 'ok',
          error_output: '',
        },
        dep: {
          id: 'dep',
          workflow_id: 'wf-1',
          workflow_node_id: 'dep-node',
          status: 'blocked',
        },
      };

      mockDb.getTask.mockImplementation((taskId) => taskState[taskId] || null);
      mockDb.updateTaskStatus.mockImplementation((taskId, status, extra = {}) => {
        if (taskState[taskId]) {
          taskState[taskId] = { ...taskState[taskId], status, ...extra };
        }
      });
      mockDb.getTaskDependents.mockReturnValue([{ task_id: 'dep' }]);
      mockDb.areTaskDependenciesSatisfied.mockReturnValue({
        satisfied: true,
        deps: [{ depends_on_task_id: 'root', condition_expr: 'exit_code == 0' }],
      });
      mockDb.evaluateCondition.mockReturnValue(true);

      const result = handlers.handleSkipTask({
        task_id: 'root',
        reason: 'manual override',
      });

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('root', 'skipped', {
        error_output: 'manual override',
      });
      expect(mockDb.updateWorkflowCounts).toHaveBeenCalledWith('wf-1');
      expect(mockDb.evaluateCondition).toHaveBeenCalledWith('exit_code == 0', {
        exit_code: 0,
        status: 'skipped',
        output: 'ok',
        error_output: 'manual override',
        duration_seconds: 0,
      });
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('dep', 'pending');
      expect(mockTaskManager.startTask).toHaveBeenCalledWith('dep');
      expect(getText(result)).toContain('Task Skipped');
      expect(getText(result)).toContain('**Task:** root-node');
      expect(getText(result)).toContain('**Reason:** manual override');
    });
  });
});
