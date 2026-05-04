const workflowEngine = require('../db/workflow-engine');
const taskCore = require('../db/task-core');
const providerRoutingCore = require('../db/provider/routing-core');
const schedulingAutomation = require('../db/scheduling-automation');
const eventTracking = require('../db/event-tracking');
const taskManager = require('../task-manager');
const workflowRuntime = require('../execution/workflow-runtime');
const handlers = require('../handlers/workflow/advanced');

const workflowRuntimeDb = {
  getTask: (...args) => taskCore.getTask(...args),
  updateTaskStatus: (...args) => taskCore.updateTaskStatus(...args),
  getWorkflow: (...args) => workflowEngine.getWorkflow(...args),
  getTaskDependents: (...args) => workflowEngine.getTaskDependents(...args),
  getTaskDependencies: (...args) => workflowEngine.getTaskDependencies(...args),
  evaluateCondition: (...args) => workflowEngine.evaluateCondition(...args),
  getWorkflowTasks: (...args) => workflowEngine.getWorkflowTasks(...args),
  updateWorkflow: (...args) => workflowEngine.updateWorkflow(...args),
};

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

describe('workflow-advanced handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('handleForkWorkflow', () => {
    it('returns INVALID_PARAM when workflow_id is missing', () => {
      const result = handlers.handleForkWorkflow({
        branches: [{ name: 'a', tasks: ['one'] }, { name: 'b', tasks: ['two'] }]
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('workflow_id');
    });

    it('returns INVALID_PARAM when fewer than 2 branches are provided', () => {
      const result = handlers.handleForkWorkflow({
        workflow_id: 'wf-1',
        branches: [{ name: 'only', tasks: ['one'] }]
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('at least 2');
    });

    it('returns INVALID_PARAM for unknown merge_strategy', () => {
      const result = handlers.handleForkWorkflow({
        workflow_id: 'wf-1',
        branches: [{ name: 'a', tasks: ['one'] }, { name: 'b', tasks: ['two'] }],
        merge_strategy: 'none'
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('merge_strategy');
    });

    it('returns WORKFLOW_NOT_FOUND when workflow does not exist', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue(null);

      const result = handlers.handleForkWorkflow({
        workflow_id: 'wf-missing',
        branches: [{ name: 'a', tasks: ['one'] }, { name: 'b', tasks: ['two'] }]
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
      expect(textOf(result)).toContain('Workflow not found');
    });

    it('creates branch tasks, tracks branch_count, and defaults merge strategy to all', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'Workflow 1' });
      const createForkSpy = vi.spyOn(providerRoutingCore, 'createWorkflowFork').mockReturnValue({
        id: 'fork-1',
        workflow_id: 'wf-1',
        merge_strategy: 'all'
      });
      const createTaskSpy = vi.spyOn(taskCore, 'createTask').mockReturnValue(undefined);
      const runtimeSpy = vi.spyOn(workflowRuntime, 'evaluateWorkflowDependencies');

      const result = handlers.handleForkWorkflow({
        workflow_id: 'wf-1',
        branches: [
          { name: 'parallel-a', tasks: ['a1', 'a2'] },
          { name: 'parallel-b', tasks: ['b1'] }
        ]
      });

      expect(createForkSpy).toHaveBeenCalledWith(expect.objectContaining({
        workflow_id: 'wf-1',
        branch_count: 2,
        merge_strategy: 'all',
        id: expect.any(String)
      }));
      expect(createTaskSpy).toHaveBeenCalledTimes(3);
      expect(createTaskSpy).toHaveBeenCalledWith(expect.objectContaining({
        task_description: 'a1',
        workflow_id: 'wf-1',
        status: 'queued'
      }));
      expect(createTaskSpy).toHaveBeenCalledWith(expect.objectContaining({
        task_description: 'b1',
        workflow_id: 'wf-1',
        status: 'queued'
      }));
      expect(runtimeSpy).not.toHaveBeenCalled();
      expect(textOf(result)).toContain('Workflow Forked');
      expect(textOf(result)).toContain('parallel-a');
      expect(textOf(result)).toContain('parallel-b');
    });
  });

  describe('handleMergeWorkflows', () => {
    it('returns INVALID_PARAM for invalid fork_id', () => {
      const result = handlers.handleMergeWorkflows({ fork_id: '' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
    });

    it('returns RESOURCE_NOT_FOUND when fork does not exist', () => {
      vi.spyOn(providerRoutingCore, 'getWorkflowFork').mockReturnValue(null);

      const result = handlers.handleMergeWorkflows({ fork_id: 'fork-404' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(textOf(result)).toContain('Fork not found');
    });

    it('marks fork as merged and supports combine_outputs=false', () => {
      vi.spyOn(providerRoutingCore, 'getWorkflowFork').mockReturnValue({
        id: 'fork-1',
        workflow_id: 'wf-1',
        merge_strategy: 'any'
      });
      const updateStatusSpy = vi.spyOn(providerRoutingCore, 'updateWorkflowForkStatus').mockReturnValue(undefined);

      const result = handlers.handleMergeWorkflows({
        fork_id: 'fork-1',
        combine_outputs: false
      });

      expect(updateStatusSpy).toHaveBeenCalledWith('fork-1', 'merged');
      expect(textOf(result)).toContain('Workflow Branches Merged');
      expect(textOf(result)).toContain('false');
    });
  });

  describe('handleReplayTask', () => {
    it('returns INVALID_PARAM when task_id is invalid', () => {
      const result = handlers.handleReplayTask({ task_id: null });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
    });

    it('returns TASK_NOT_FOUND when original task is missing', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);

      const result = handlers.handleReplayTask({ task_id: 'missing-task' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(textOf(result)).toContain('Task not found');
    });

    it('creates replay task and replay record with modified inputs', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({
        id: 'orig-1',
        task_description: 'original task',
        working_directory: '/repo',
        timeout_minutes: 25,
        auto_approve: true,
        priority: 3,
        template_name: 'tmpl-A'
      });
      const createTaskSpy = vi.spyOn(taskCore, 'createTask').mockReturnValue(undefined);
      const replaySpy = vi.spyOn(providerRoutingCore, 'createTaskReplay').mockReturnValue(undefined);

      const result = handlers.handleReplayTask({
        task_id: 'orig-1',
        modified_inputs: { task: 'updated task', extra: 'x' },
        new_working_directory: '/repo/new'
      });

      expect(createTaskSpy).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.any(String),
        task_description: 'updated task',
        working_directory: '/repo/new',
        timeout_minutes: 25,
        auto_approve: true,
        priority: 3,
        template_name: 'tmpl-A',
        status: 'queued'
      }));
      expect(replaySpy).toHaveBeenCalledWith(expect.objectContaining({
        original_task_id: 'orig-1',
        replay_task_id: expect.any(String),
        modified_inputs: { task: 'updated task', extra: 'x' }
      }));
      expect(textOf(result)).toContain('Task Replayed');
      expect(textOf(result)).toContain('Modified Inputs');
    });
  });

  describe('handleDiffTaskRuns', () => {
    it('requires both task IDs', () => {
      const result = handlers.handleDiffTaskRuns({ task_id_a: 'a-only' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns TASK_NOT_FOUND when task A is missing', () => {
      vi.spyOn(taskCore, 'getTask').mockImplementation((id) => (id === 'b' ? { id: 'b' } : null));
      const result = handlers.handleDiffTaskRuns({ task_id_a: 'a', task_id_b: 'b' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Task not found');
    });

    it('returns TASK_NOT_FOUND when task B is missing', () => {
      vi.spyOn(taskCore, 'getTask').mockImplementation((id) => (id === 'a' ? { id: 'a' } : null));
      const result = handlers.handleDiffTaskRuns({ task_id_a: 'a', task_id_b: 'b' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Task not found');
    });

    it('computes duration deltas and same/different markers', () => {
      vi.spyOn(taskCore, 'getTask').mockImplementation((id) => {
        if (id === 'a') {
          return {
            id: 'a',
            output: 'same output',
            started_at: '2026-01-01T00:00:00.000Z',
            completed_at: '2026-01-01T00:00:10.000Z'
          };
        }
        return {
          id: 'b',
          output: 'different output',
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T00:00:05.000Z'
        };
      });

      const result = handlers.handleDiffTaskRuns({
        task_id_a: 'a',
        task_id_b: 'b',
        compare_fields: ['duration', 'output']
      });

      const text = textOf(result);
      expect(text).toContain('Task Comparison');
      expect(text).toContain('| duration | 10 | 5 | ✗ |');
      expect(text).toContain('| output | same output | different output | ✗ |');
    });
  });

  describe('handleDuplicatePipeline', () => {
    it('returns PIPELINE_NOT_FOUND when duplicatePipeline fails', () => {
      vi.spyOn(schedulingAutomation, 'duplicatePipeline').mockReturnValue(null);

      const result = handlers.handleDuplicatePipeline({
        pipeline_id: 'pipe-404',
        new_name: 'Clone'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('PIPELINE_NOT_FOUND');
    });

    it('renders cloned pipeline with truncated step tasks', () => {
      vi.spyOn(schedulingAutomation, 'duplicatePipeline').mockReturnValue({
        id: 'pipe-2',
        name: 'Clone',
        description: 'Cloned pipeline',
        definition: '[{"task":"placeholder"}]'
      });
      vi.spyOn(eventTracking, 'safeJsonParse').mockReturnValue([
        { task: 'short task' },
        { task: 'This is a very long task description that should be truncated at fifty characters for display' }
      ]);

      const result = handlers.handleDuplicatePipeline({
        pipeline_id: 'pipe-1',
        new_name: 'Clone'
      });

      expect(textOf(result)).toContain('Pipeline Cloned');
      expect(textOf(result)).toContain('**Steps:** 2');
      expect(textOf(result)).toContain('short task');
      expect(textOf(result)).toContain('...');
    });
  });

  describe('handleExportReport', () => {
    it('returns empty report message when no tasks match', () => {
      vi.spyOn(schedulingAutomation, 'exportTasksReport').mockReturnValue({
        tasks: [],
        summary: { total: 0, by_status: {}, by_project: {} }
      });

      const result = handlers.handleExportReport({ project: 'none' });
      expect(textOf(result)).toContain('No tasks found');
    });

    it('renders csv output and splits comma-separated status filter', () => {
      const exportSpy = vi.spyOn(schedulingAutomation, 'exportTasksReport').mockReturnValue({
        tasks: [
          {
            id: 'task-1',
            status: 'completed',
            task_description: 'he said "ok"',
            project: 'proj-a',
            priority: 2,
            progress_percent: 100,
            exit_code: 0,
            created_at: '2026-01-01T00:00:00.000Z'
          }
        ],
        summary: { total: 1, by_status: { completed: 1 }, by_project: { 'proj-a': 1 } }
      });

      const result = handlers.handleExportReport({
        format: 'csv',
        status: 'completed, failed'
      });

      expect(exportSpy).toHaveBeenCalledWith(expect.objectContaining({
        status: ['completed', 'failed']
      }));
      expect(textOf(result)).toContain('Task Report (CSV)');
      expect(textOf(result)).toContain('he said ""ok""');
    });

    it('renders json output and indicates additional tasks after first 20', () => {
      const manyTasks = Array.from({ length: 22 }, (_, i) => ({
        id: `task-${i + 1}`,
        status: 'completed'
      }));
      vi.spyOn(schedulingAutomation, 'exportTasksReport').mockReturnValue({
        tasks: manyTasks,
        summary: { total: 22, by_status: { completed: 22 }, by_project: {} }
      });

      const result = handlers.handleExportReport({ format: 'json' });
      expect(textOf(result)).toContain('Task Report (JSON)');
      expect(textOf(result)).toContain('// ... 2 more tasks');
    });

    it('renders markdown summary and caps visible tasks at 50', () => {
      const manyTasks = Array.from({ length: 51 }, (_, i) => ({
        id: `abcdef12-0000-0000-0000-${String(i).padStart(12, '0')}`,
        status: i % 2 === 0 ? 'completed' : 'failed',
        task_description: `Task ${i} description`,
        project: i % 2 === 0 ? 'proj-a' : 'proj-b',
        created_at: '2026-01-01T00:00:00.000Z'
      }));

      vi.spyOn(schedulingAutomation, 'exportTasksReport').mockReturnValue({
        tasks: manyTasks,
        summary: {
          total: 51,
          by_status: { completed: 26, failed: 25 },
          by_project: { 'proj-a': 26, 'proj-b': 25 }
        }
      });

      const result = handlers.handleExportReport({});
      const text = textOf(result);
      expect(text).toContain('Task Report');
      expect(text).toContain('By Status');
      expect(text).toContain('By Project');
      expect(text).toContain('Showing 50 of 51 tasks');
    });
  });

  describe('handleRetryWorkflowFrom', () => {
    it('returns WORKFLOW_NOT_FOUND when workflow is missing', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue(null);

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-missing',
        from_task_id: 'task-1'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('returns TASK_NOT_FOUND when from_task_id is not in workflow', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1' });
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1', workflow_id: 'wf-other' });

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-1',
        from_task_id: 'task-1'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(textOf(result)).toContain('Task not found in workflow');
    });

    it('resets downstream tasks using dependency traversal and restarts pending tasks', () => {
      const taskState = {
        'task-a': { id: 'task-a', workflow_id: 'wf-1', workflow_node_id: 'A', status: 'failed' },
        'task-b': { id: 'task-b', workflow_id: 'wf-1', workflow_node_id: 'B', status: 'failed' },
        'task-c': { id: 'task-c', workflow_id: 'wf-1', workflow_node_id: 'C', status: 'failed' }
      };

      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'Retry Workflow' });
      vi.spyOn(taskCore, 'getTask').mockImplementation((id) => taskState[id] || null);
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf-1',
        name: 'Retry Workflow',
        status: 'failed',
        tasks: taskState
      });
      vi.spyOn(workflowEngine, 'getWorkflowDependencies').mockReturnValue([
        { task_id: 'task-b', depends_on_task_id: 'task-a' },
        { task_id: 'task-c', depends_on_task_id: 'task-b' }
      ]);
      const updateStatusSpy = vi.spyOn(taskCore, 'updateTaskStatus').mockImplementation((id, status) => {
        if (taskState[id]) taskState[id].status = status;
      });
      const updateWorkflowSpy = vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockImplementation(() => Object.values(taskState));
      const startTaskSpy = vi.spyOn(taskManager, 'startTask').mockImplementation((taskId) => {
        if (taskId === 'task-a') {
          throw new Error('queued elsewhere');
        }
      });

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-1',
        from_task_id: 'task-a'
      });

      expect(updateStatusSpy).toHaveBeenCalledWith('task-a', 'pending');
      expect(updateStatusSpy).toHaveBeenCalledWith('task-b', 'blocked');
      expect(updateStatusSpy).toHaveBeenCalledWith('task-c', 'blocked');
      expect(updateWorkflowSpy).toHaveBeenCalledWith('wf-1', expect.objectContaining({
        status: 'running',
        completed_at: null
      }));
      expect(startTaskSpy).toHaveBeenCalledWith('task-a');
      expect(textOf(result)).toContain('Workflow Restarted');
      expect(textOf(result)).toContain('**Tasks Reset:** 3');
    });

    it('returns INVALID_STATUS_TRANSITION when workflow still has live runnable work', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'Retry Workflow' });
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-a', workflow_id: 'wf-1', workflow_node_id: 'A', status: 'failed' });
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf-1',
        name: 'Retry Workflow',
        status: 'running',
        tasks: {
          'task-a': { id: 'task-a', status: 'failed' },
          'task-b': { id: 'task-b', status: 'running' },
          'task-c': { id: 'task-c', status: 'queued' }
        }
      });
      const updateStatusSpy = vi.spyOn(taskCore, 'updateTaskStatus');
      const updateWorkflowSpy = vi.spyOn(workflowEngine, 'updateWorkflow');
      const startTaskSpy = vi.spyOn(taskManager, 'startTask');

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-1',
        from_task_id: 'task-a'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
      expect(textOf(result)).toContain('still has live runnable work');
      expect(textOf(result)).toContain('1 running, 0 pending, 1 queued');
      expect(updateStatusSpy).not.toHaveBeenCalled();
      expect(updateWorkflowSpy).not.toHaveBeenCalled();
      expect(startTaskSpy).not.toHaveBeenCalled();
    });

    it('allows retry when remaining open work is blocked only', () => {
      const taskState = {
        'task-a': { id: 'task-a', workflow_id: 'wf-1', workflow_node_id: 'A', status: 'failed' },
        'task-b': { id: 'task-b', workflow_id: 'wf-1', workflow_node_id: 'B', status: 'blocked' }
      };

      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'Retry Workflow' });
      vi.spyOn(taskCore, 'getTask').mockImplementation((id) => taskState[id] || null);
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf-1',
        name: 'Retry Workflow',
        status: 'paused',
        tasks: taskState
      });
      vi.spyOn(workflowEngine, 'getWorkflowDependencies').mockReturnValue([
        { task_id: 'task-b', depends_on_task_id: 'task-a' }
      ]);
      const updateStatusSpy = vi.spyOn(taskCore, 'updateTaskStatus').mockImplementation((id, status) => {
        if (taskState[id]) taskState[id].status = status;
      });
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockImplementation(() => Object.values(taskState));
      const startTaskSpy = vi.spyOn(taskManager, 'startTask').mockImplementation(() => undefined);

      const result = handlers.handleRetryWorkflowFrom({
        workflow_id: 'wf-1',
        from_task_id: 'task-a'
      });

      expect(result.isError).toBeFalsy();
      expect(updateStatusSpy).toHaveBeenCalledWith('task-a', 'pending');
      expect(updateStatusSpy).toHaveBeenCalledWith('task-b', 'blocked');
      expect(startTaskSpy).toHaveBeenCalledWith('task-a');
    });
  });

  describe('handleReopenWorkflow', () => {
    it('returns WORKFLOW_NOT_FOUND when workflow is missing', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue(null);

      const result = handlers.handleReopenWorkflow({ workflow_id: 'wf-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('returns INVALID_STATUS_TRANSITION when workflow is running', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1', name: 'Live WF', status: 'running'
      });

      const result = handlers.handleReopenWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
      expect(textOf(result)).toContain("status 'running'");
    });

    it('returns INVALID_STATUS_TRANSITION when workflow is completed', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1', name: 'Done WF', status: 'completed'
      });

      const result = handlers.handleReopenWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('returns INVALID_PARAM when workflow has no tasks', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1', name: 'Empty', status: 'failed'
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([]);

      const result = handlers.handleReopenWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('no tasks');
    });

    it('returns INVALID_STATUS_TRANSITION when nothing is resettable', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1', name: 'AllDone', status: 'failed'
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'task-a', status: 'completed', workflow_node_id: 'A' },
        { id: 'task-b', status: 'completed', workflow_node_id: 'B' },
      ]);
      vi.spyOn(workflowEngine, 'getWorkflowDependencies').mockReturnValue([]);

      const result = handlers.handleReopenWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
      expect(textOf(result)).toContain('No failed, cancelled, or skipped');
    });

    it('resets failed + cancelled + skipped tasks while preserving completed ones', () => {
      const tasks = [
        { id: 'task-a', status: 'completed', workflow_node_id: 'A' },
        { id: 'task-b', status: 'failed', workflow_node_id: 'B' },
        { id: 'task-c', status: 'cancelled', workflow_node_id: 'C' },
        { id: 'task-d', status: 'skipped', workflow_node_id: 'D' },
      ];
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1', name: 'Mixed', status: 'failed', context: {}
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue(tasks);
      vi.spyOn(workflowEngine, 'getWorkflowDependencies').mockReturnValue([]);

      const updateStatusSpy = vi.spyOn(taskCore, 'updateTaskStatus').mockImplementation(() => {});
      const updateWorkflowSpy = vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'startTask').mockImplementation(() => {});

      const result = handlers.handleReopenWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBeFalsy();
      // Completed task must NOT be reset.
      expect(updateStatusSpy).not.toHaveBeenCalledWith('task-a', expect.anything());
      // Failed/cancelled/skipped → pending (no deps).
      expect(updateStatusSpy).toHaveBeenCalledWith('task-b', 'pending');
      expect(updateStatusSpy).toHaveBeenCalledWith('task-c', 'pending');
      expect(updateStatusSpy).toHaveBeenCalledWith('task-d', 'pending');
      expect(updateWorkflowSpy).toHaveBeenCalledWith('wf-1', expect.objectContaining({
        status: 'running',
        completed_at: null,
      }));
      expect(textOf(result)).toContain('Workflow Reopened');
      expect(textOf(result)).toContain('**Tasks Reset:** 3');
    });

    it('restores blocked status when a prerequisite is still non-completed', () => {
      const tasks = [
        { id: 'task-a', status: 'failed', workflow_node_id: 'A' },
        { id: 'task-b', status: 'failed', workflow_node_id: 'B' },
      ];
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1', name: 'Chain', status: 'failed', context: {}
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue(tasks);
      vi.spyOn(workflowEngine, 'getWorkflowDependencies').mockReturnValue([
        { task_id: 'task-b', depends_on_task_id: 'task-a' },
      ]);

      const updateStatusSpy = vi.spyOn(taskCore, 'updateTaskStatus').mockImplementation(() => {});
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'startTask').mockImplementation(() => {});

      const result = handlers.handleReopenWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBeFalsy();
      // task-a has no deps → pending. task-b depends on task-a which is not completed → blocked.
      expect(updateStatusSpy).toHaveBeenCalledWith('task-a', 'pending');
      expect(updateStatusSpy).toHaveBeenCalledWith('task-b', 'blocked');
    });

    it('works for cancelled workflows too', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1', name: 'Cancelled', status: 'cancelled', context: {}
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'task-a', status: 'cancelled', workflow_node_id: 'A' },
      ]);
      vi.spyOn(workflowEngine, 'getWorkflowDependencies').mockReturnValue([]);
      vi.spyOn(taskCore, 'updateTaskStatus').mockImplementation(() => {});
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'startTask').mockImplementation(() => {});

      const result = handlers.handleReopenWorkflow({ workflow_id: 'wf-1' });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Workflow Reopened');
    });
  });

  describe('handleSkipTask', () => {
    it('returns TASK_NOT_FOUND for unknown task', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
      const result = handlers.handleSkipTask({ task_id: 'missing' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('returns INVALID_STATUS_TRANSITION when task is not blocked', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1', status: 'running' });
      const result = handlers.handleSkipTask({ task_id: 'task-1' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('skips blocked task with reason and unblocks dependent when condition passes', () => {
      const taskState = {
        root: {
          id: 'root',
          workflow_id: 'wf-1',
          workflow_node_id: 'root-node',
          status: 'blocked',
          exit_code: 0,
          output: 'ok',
          error_output: ''
        },
        dep: {
          id: 'dep',
          workflow_id: 'wf-1',
          workflow_node_id: 'dep-node',
          status: 'blocked'
        }
      };

      vi.spyOn(taskCore, 'getTask').mockImplementation((id) => taskState[id] ? { ...taskState[id] } : null);
      const updateStatusSpy = vi.spyOn(taskCore, 'updateTaskStatus').mockImplementation((id, status, extra = {}) => {
        if (taskState[id]) {
          taskState[id].status = status;
          Object.assign(taskState[id], extra);
        }
      });
      const workflowCountSpy = vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', status: 'running' });
      vi.spyOn(workflowEngine, 'getTaskDependents').mockReturnValue([{
        task_id: 'dep',
        condition_expr: 'exit_code == 0',
        on_fail: 'skip'
      }]);
      vi.spyOn(workflowEngine, 'getTaskDependencies').mockReturnValue([{
        task_id: 'dep',
        depends_on_task_id: 'root',
        condition_expr: 'exit_code == 0',
        on_fail: 'skip'
      }]);
      vi.spyOn(workflowEngine, 'evaluateCondition').mockReturnValue(true);
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue(Object.values(taskState));
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      // Initialize workflow-runtime with the spied task/workflow adapters so handleWorkflowTermination works
      workflowRuntime.init({ db: workflowRuntimeDb });

      const result = handlers.handleSkipTask({
        task_id: 'root',
        reason: 'manual override'
      });

      expect(updateStatusSpy).toHaveBeenCalledWith('root', 'skipped', {
        error_output: 'manual override'
      });
      expect(workflowCountSpy).toHaveBeenCalledWith('wf-1');
      // unblockTask sets status to 'queued' via clearTaskBlockerSnapshot which passes context
      expect(updateStatusSpy).toHaveBeenCalledWith('dep', 'queued', expect.objectContaining({}));
      expect(textOf(result)).toContain('Task Skipped');
      expect(textOf(result)).toContain('manual override');
    });

    it('skips dependent task when condition fails with on_fail=skip', () => {
      const taskState = {
        root: {
          id: 'root',
          workflow_id: 'wf-1',
          workflow_node_id: 'root-node',
          status: 'blocked',
          exit_code: 1,
          output: '',
          error_output: 'boom'
        },
        dep: {
          id: 'dep',
          workflow_id: 'wf-1',
          workflow_node_id: 'dep-node',
          status: 'blocked'
        }
      };

      vi.spyOn(taskCore, 'getTask').mockImplementation((id) => taskState[id] ? { ...taskState[id] } : null);
      const updateStatusSpy = vi.spyOn(taskCore, 'updateTaskStatus').mockImplementation((id, status, extra) => {
        if (taskState[id]) {
          taskState[id].status = status;
          if (extra) Object.assign(taskState[id], extra);
        }
      });
      vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', status: 'running' });
      vi.spyOn(workflowEngine, 'getTaskDependents').mockReturnValue([{
        task_id: 'dep',
        condition_expr: 'exit_code == 0',
        on_fail: 'skip'
      }]);
      vi.spyOn(workflowEngine, 'evaluateCondition').mockReturnValue(false);
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue(Object.values(taskState));
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);
      const startTaskSpy = vi.spyOn(taskManager, 'startTask').mockReturnValue(undefined);
      // Initialize workflow-runtime with the spied task/workflow adapters so handleWorkflowTermination works
      workflowRuntime.init({ db: workflowRuntimeDb });

      const result = handlers.handleSkipTask({ task_id: 'root' });

      expect(updateStatusSpy).toHaveBeenCalledWith('root', 'skipped', {
        error_output: 'Manually skipped'
      });
      // applyFailureAction with on_fail='skip' calls updateTaskStatus with error_output message
      expect(updateStatusSpy).toHaveBeenCalledWith('dep', 'skipped', expect.objectContaining({
        error_output: expect.any(String)
      }));
      expect(startTaskSpy).not.toHaveBeenCalled();
      expect(textOf(result)).toContain('Task Skipped');
    });
  });
});
