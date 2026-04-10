'use strict';

const realShared = require('../handlers/shared');

const mockDb = {
  getWorkflow: vi.fn(),
  getWorkflowTasks: vi.fn(),
  getWorkflowDependencies: vi.fn(),
  getTask: vi.fn(),
  getTaskDependents: vi.fn(),
  evaluateCondition: vi.fn(),
  getBlockedTasks: vi.fn(),
  getTaskDependencies: vi.fn(),
};

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/workflow/dag')];
  installMock('../database', mockDb);
  installMock('../db/task-core', mockDb);
  installMock('../db/workflow-engine', mockDb);
  installMock('../handlers/shared', realShared);
  return require('../handlers/workflow/dag');
}

function resetDbMocks() {
  Object.values(mockDb).forEach((fn) => fn.mockReset());
}

function textOf(result) {
  return result && result.content && result.content[0] ? result.content[0].text : '';
}

describe('workflow dag handlers', () => {
  let handlers;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetDbMocks();
    handlers = loadHandlers();
  });

  describe('handleDependencyGraph', () => {
    it('returns WORKFLOW_NOT_FOUND when the workflow does not exist', () => {
      mockDb.getWorkflow.mockReturnValue(null);

      const result = handlers.handleDependencyGraph({ workflow_id: 'wf-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
      expect(textOf(result)).toContain('Workflow not found: wf-missing');
    });

    it('returns nodes and edges as JSON when format=json', () => {
      mockDb.getWorkflow.mockReturnValue({ id: 'wf-1', name: 'Release Pipeline' });
      mockDb.getWorkflowTasks.mockReturnValue([
        { id: 'task-build', workflow_node_id: 'build', status: 'completed' },
        { id: 'task-test', workflow_node_id: 'test', status: 'blocked' },
      ]);
      mockDb.getWorkflowDependencies.mockReturnValue([
        {
          depends_on_task_id: 'task-build',
          task_id: 'task-test',
          condition_expr: 'exit_code == 0',
          on_fail: 'skip',
        },
      ]);

      const result = handlers.handleDependencyGraph({ workflow_id: 'wf-1', format: 'json' });
      const graph = JSON.parse(textOf(result));

      expect(graph).toEqual({
        nodes: [
          { id: 'task-build', node_id: 'build', status: 'completed' },
          { id: 'task-test', node_id: 'test', status: 'blocked' },
        ],
        edges: [
          {
            from: 'task-build',
            to: 'task-test',
            condition: 'exit_code == 0',
            on_fail: 'skip',
          },
        ],
      });
    });

    it('renders a mermaid dependency diagram when format=mermaid', () => {
      mockDb.getWorkflow.mockReturnValue({ id: 'wf-1', name: 'Build Workflow' });
      mockDb.getWorkflowTasks.mockReturnValue([
        { id: 'task-build', workflow_node_id: 'build', status: 'completed' },
        { id: 'task-deploy', workflow_node_id: 'deploy', status: 'running' },
      ]);
      mockDb.getWorkflowDependencies.mockReturnValue([
        {
          depends_on_task_id: 'task-build',
          task_id: 'task-deploy',
          condition_expr: 'exit_code == 0 && checks_passed',
          on_fail: 'skip',
        },
      ]);

      const result = handlers.handleDependencyGraph({ workflow_id: 'wf-1', format: 'mermaid' });
      const text = textOf(result);

      expect(text).toContain('## Dependency Graph: Build Workflow');
      expect(text).toContain('```mermaid');
      expect(text).toContain('graph TD');
      expect(text).toContain('build["build"]:::completed');
      expect(text).toContain('deploy["deploy"]:::running');
      expect(text).toContain('build -->|exit_code == 0 && ch| deploy');
    });

    it('defaults to mermaid output when format is omitted', () => {
      mockDb.getWorkflow.mockReturnValue({ id: 'wf-1', name: 'Default Graph' });
      mockDb.getWorkflowTasks.mockReturnValue([
        { id: 'task-a', workflow_node_id: 'A', status: 'pending' },
      ]);
      mockDb.getWorkflowDependencies.mockReturnValue([]);

      const result = handlers.handleDependencyGraph({ workflow_id: 'wf-1' });
      const text = textOf(result);

      expect(text).toContain('## Dependency Graph: Default Graph');
      expect(text).toContain('```mermaid');
      expect(text).toContain('A["A"]:::pending');
    });
  });

  describe('handleCriticalPath', () => {
    it('returns WORKFLOW_NOT_FOUND when the workflow does not exist', () => {
      mockDb.getWorkflow.mockReturnValue(null);

      const result = handlers.handleCriticalPath({ workflow_id: 'wf-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('returns the critical path with total duration and bottleneck information', () => {
      mockDb.getWorkflow.mockReturnValue({ id: 'wf-1', name: 'Release Flow' });
      mockDb.getWorkflowTasks.mockReturnValue([
        { id: 'task-a', workflow_node_id: 'build', duration_seconds: 5 },
        { id: 'task-b', workflow_node_id: 'test', duration_seconds: 12 },
        { id: 'task-c', workflow_node_id: 'deploy', duration_seconds: 7 },
        { id: 'task-d', workflow_node_id: 'docs', duration_seconds: 3 },
      ]);
      mockDb.getWorkflowDependencies.mockReturnValue([
        { depends_on_task_id: 'task-a', task_id: 'task-b' },
        { depends_on_task_id: 'task-b', task_id: 'task-c' },
        { depends_on_task_id: 'task-a', task_id: 'task-d' },
      ]);

      const result = handlers.handleCriticalPath({ workflow_id: 'wf-1' });
      const text = textOf(result);

      expect(text).toContain('## Critical Path: Release Flow');
      expect(text).toContain('**Length:** 3 tasks');
      expect(text).toContain('**Duration:** 24s total');
      expect(text).toContain('**Bottleneck:** test (12s)');
      expect(text).toContain('1. build (5s)');
      expect(text).toContain('2. test (12s)');
      expect(text).toContain('3. deploy (7s)');
    });
  });

  describe('handleWhatIf', () => {
    it('returns WORKFLOW_NOT_FOUND when the workflow does not exist', () => {
      mockDb.getWorkflow.mockReturnValue(null);

      const result = handlers.handleWhatIf({
        workflow_id: 'wf-missing',
        task_id: 'task-1',
        simulated_status: 'failed',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      mockDb.getWorkflow.mockReturnValue({ id: 'wf-1', name: 'WF' });

      const result = handlers.handleWhatIf({
        workflow_id: 'wf-1',
        simulated_status: 'failed',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('task_id is required');
    });

    it('simulates task failure impact on downstream tasks', () => {
      mockDb.getWorkflow.mockReturnValue({ id: 'wf-1', name: 'WF' });
      mockDb.getTask.mockImplementation((taskId) => {
        const tasks = {
          source: { id: 'source', workflow_id: 'wf-1', workflow_node_id: 'source' },
          'task-cancel': { id: 'task-cancel', workflow_id: 'wf-1', workflow_node_id: 'cancel-path' },
          'task-ready': { id: 'task-ready', workflow_id: 'wf-1', workflow_node_id: 'ready-path' },
        };
        return tasks[taskId] || null;
      });
      mockDb.getTaskDependents.mockReturnValue([
        { task_id: 'task-cancel', condition_expr: 'exit_code == 0', on_fail: 'cancel' },
        { task_id: 'task-ready', condition_expr: 'status == "failed"', on_fail: 'skip' },
      ]);
      mockDb.evaluateCondition
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const result = handlers.handleWhatIf({
        workflow_id: 'wf-1',
        task_id: 'source',
        simulated_status: 'failed',
      });
      const text = textOf(result);

      expect(text).toContain('## What-If Analysis');
      expect(text).toContain('**Task:** source');
      expect(text).toContain('**Simulated Status:** failed');
      expect(text).toContain('**Simulated Exit Code:** 1');
      expect(text).toContain('| cancel-path | `exit_code == 0` | ✗ Fail | Cancel workflow |');
      expect(text).toContain('| ready-path | `status == "failed"` | ✓ Pass | Unblock |');
      expect(mockDb.evaluateCondition).toHaveBeenNthCalledWith(
        1,
        'exit_code == 0',
        expect.objectContaining({ exit_code: 1, status: 'failed' })
      );
    });
  });

  describe('handleBlockedTasks', () => {
    it('returns WORKFLOW_NOT_FOUND when the workflow does not exist', () => {
      mockDb.getWorkflow.mockReturnValue(null);

      const result = handlers.handleBlockedTasks({ workflow_id: 'wf-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('returns currently blocked tasks with their active blockers', () => {
      mockDb.getWorkflow.mockReturnValue({ id: 'wf-1', name: 'Ship It' });
      mockDb.getBlockedTasks.mockReturnValue([
        { id: 'task-deploy', workflow_id: 'wf-1', workflow_node_id: 'deploy' },
      ]);
      mockDb.getTaskDependencies.mockReturnValue([
        { depends_on_task_id: 'task-build', depends_on_status: 'running' },
        { depends_on_task_id: 'task-lint', depends_on_status: 'completed' },
      ]);
      mockDb.getTask.mockImplementation((taskId) => {
        if (taskId === 'task-build') {
          return { id: 'task-build', workflow_node_id: 'build' };
        }
        if (taskId === 'task-lint') {
          return { id: 'task-lint', workflow_node_id: 'lint' };
        }
        return null;
      });

      const result = handlers.handleBlockedTasks({ workflow_id: 'wf-1' });
      const text = textOf(result);

      expect(text).toContain('## Blocked Tasks: Ship It');
      expect(text).toContain('| Task | Workflow | Reason | Waiting On |');
      expect(text).toContain('deploy');
      expect(text).toContain('build');
      expect(text).not.toContain('lint');
    });

    it('returns an empty-workflow message when no blocked tasks exist', () => {
      mockDb.getWorkflow.mockReturnValue({ id: 'wf-2', name: 'Empty Flow' });
      mockDb.getBlockedTasks.mockReturnValue([]);

      const result = handlers.handleBlockedTasks({ workflow_id: 'wf-2' });

      expect(textOf(result)).toContain('No blocked tasks found in workflow Empty Flow.');
    });
  });
});
