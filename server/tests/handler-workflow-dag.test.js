const workflowEngine = require('../db/workflow-engine');
const taskCore = require('../db/task-core');
const handlers = require('../handlers/workflow/dag');

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

describe('workflow-dag handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('handleDependencyGraph', () => {
    it('returns WORKFLOW_NOT_FOUND for unknown workflow', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue(null);

      const result = handlers.handleDependencyGraph({ workflow_id: 'wf-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
      expect(textOf(result)).toContain('Workflow not found');
    });

    it('returns JSON graph with nodes and edges', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'WF' });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'task-a', workflow_node_id: 'A', status: 'completed' },
        { id: 'task-b', workflow_node_id: 'B', status: 'blocked' }
      ]);
      vi.spyOn(workflowEngine, 'getWorkflowDependencies').mockReturnValue([
        { depends_on_task_id: 'task-a', task_id: 'task-b', condition_expr: 'exit_code == 0', on_fail: 'skip' }
      ]);

      const result = handlers.handleDependencyGraph({ workflow_id: 'wf-1', format: 'json' });
      const parsed = JSON.parse(textOf(result));

      expect(parsed.nodes).toHaveLength(2);
      expect(parsed.edges).toHaveLength(1);
      expect(parsed.edges[0]).toEqual({
        from: 'task-a',
        to: 'task-b',
        condition: 'exit_code == 0',
        on_fail: 'skip'
      });
    });

    it('renders mermaid output with status classes and condition labels', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'Build Workflow' });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'task-a', workflow_node_id: 'A', status: 'completed' },
        { id: 'task-b', workflow_node_id: 'B', status: 'running' }
      ]);
      vi.spyOn(workflowEngine, 'getWorkflowDependencies').mockReturnValue([
        { depends_on_task_id: 'task-a', task_id: 'task-b', condition_expr: 'exit_code == 0 && very_long_condition', on_fail: 'skip' }
      ]);

      const result = handlers.handleDependencyGraph({ workflow_id: 'wf-1', format: 'mermaid' });
      const text = textOf(result);

      expect(text).toContain('```mermaid');
      expect(text).toContain('A["A"]:::completed');
      expect(text).toContain('B["B"]:::running');
      expect(text).toContain('|exit_code == 0 && ve|');
      expect(text).toContain('Dependency Graph: Build Workflow');
    });

    it('renders ASCII fallback for non-json/non-mermaid format', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'ASCII WF' });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'task-a', workflow_node_id: 'A', status: 'completed' },
        { id: 'task-b', workflow_node_id: 'B', status: 'blocked' }
      ]);
      vi.spyOn(workflowEngine, 'getWorkflowDependencies').mockReturnValue([
        { depends_on_task_id: 'task-a', task_id: 'task-b' }
      ]);

      const result = handlers.handleDependencyGraph({ workflow_id: 'wf-1', format: 'ascii' });
      const text = textOf(result);

      expect(text).toContain('Dependency Graph: ASCII WF');
      expect(text).toContain('[A] (completed)');
      expect(text).toContain('[B] (blocked) <- A');
    });
  });

  describe('handleCriticalPath', () => {
    it('returns WORKFLOW_NOT_FOUND for unknown workflow', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue(null);

      const result = handlers.handleCriticalPath({ workflow_id: 'wf-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('finds the longest path in a DAG', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'CP WF' });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'A', workflow_node_id: 'A' },
        { id: 'B', workflow_node_id: 'B' },
        { id: 'C', workflow_node_id: 'C' },
        { id: 'D', workflow_node_id: 'D' }
      ]);
      vi.spyOn(workflowEngine, 'getWorkflowDependencies').mockReturnValue([
        { depends_on_task_id: 'A', task_id: 'B' },
        { depends_on_task_id: 'B', task_id: 'C' },
        { depends_on_task_id: 'A', task_id: 'D' }
      ]);

      const result = handlers.handleCriticalPath({ workflow_id: 'wf-1' });
      const text = textOf(result);

      expect(text).toContain('Critical Path: CP WF');
      expect(text).toContain('Length:** 3 tasks');
      expect(text).toContain('1. A');
      expect(text).toContain('2. B');
      expect(text).toContain('3. C');
    });

    it('handles disconnected graphs and chooses the longest component', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'Disconnected WF' });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'X1', workflow_node_id: 'X1' },
        { id: 'X2', workflow_node_id: 'X2' },
        { id: 'Y1', workflow_node_id: 'Y1' }
      ]);
      vi.spyOn(workflowEngine, 'getWorkflowDependencies').mockReturnValue([
        { depends_on_task_id: 'X1', task_id: 'X2' }
      ]);

      const result = handlers.handleCriticalPath({ workflow_id: 'wf-1' });
      const text = textOf(result);

      expect(text).toContain('Length:** 2 tasks');
      expect(text).toContain('1. X1');
      expect(text).toContain('2. X2');
    });

    it('reports zero-length path when a cycle removes all start nodes', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'Cycle WF' });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'A', workflow_node_id: 'A' },
        { id: 'B', workflow_node_id: 'B' }
      ]);
      vi.spyOn(workflowEngine, 'getWorkflowDependencies').mockReturnValue([
        { depends_on_task_id: 'A', task_id: 'B' },
        { depends_on_task_id: 'B', task_id: 'A' }
      ]);

      const result = handlers.handleCriticalPath({ workflow_id: 'wf-1' });
      expect(textOf(result)).toContain('Length:** 0 tasks');
    });
  });

  describe('handleWhatIf', () => {
    it('returns WORKFLOW_NOT_FOUND when workflow does not exist', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue(null);
      const result = handlers.handleWhatIf({
        workflow_id: 'wf-missing',
        task_id: 'task-1',
        simulated_status: 'completed'
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('returns TASK_NOT_FOUND when task is not in the workflow', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'WF' });
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-x', workflow_id: 'wf-other' });

      const result = handlers.handleWhatIf({
        workflow_id: 'wf-1',
        task_id: 'task-x',
        simulated_status: 'completed'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(textOf(result)).toContain('Task not found in workflow');
    });

    it('reports no downstream effects for leaf tasks', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'WF' });
      vi.spyOn(taskCore, 'getTask').mockReturnValue({
        id: 'task-a',
        workflow_id: 'wf-1',
        workflow_node_id: 'task-a'
      });
      vi.spyOn(workflowEngine, 'getTaskDependents').mockReturnValue([]);

      const result = handlers.handleWhatIf({
        workflow_id: 'wf-1',
        task_id: 'task-a',
        simulated_status: 'completed'
      });

      expect(textOf(result)).toContain('no downstream effects');
    });

    it('uses exit code 1 by default for simulated failed status', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'WF' });
      vi.spyOn(taskCore, 'getTask').mockReturnValue({
        id: 'task-a',
        workflow_id: 'wf-1',
        workflow_node_id: 'task-a'
      });
      vi.spyOn(workflowEngine, 'getTaskDependents').mockReturnValue([]);

      const result = handlers.handleWhatIf({
        workflow_id: 'wf-1',
        task_id: 'task-a',
        simulated_status: 'failed'
      });

      expect(textOf(result)).toContain('Simulated Exit Code:** 1');
    });

    it('evaluates conditions and maps fail actions for dependents', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'WF' });
      vi.spyOn(taskCore, 'getTask').mockImplementation((id) => {
        const map = {
          source: { id: 'source', workflow_id: 'wf-1', workflow_node_id: 'source' },
          d1: { id: 'd1', workflow_id: 'wf-1', workflow_node_id: 'dep-1' },
          d2: { id: 'd2', workflow_id: 'wf-1', workflow_node_id: 'dep-2' },
          d3: { id: 'd3', workflow_id: 'wf-1', workflow_node_id: 'dep-3' },
          d4: { id: 'd4', workflow_id: 'wf-1', workflow_node_id: 'dep-4' },
          d5: { id: 'd5', workflow_id: 'wf-1', workflow_node_id: 'dep-5' }
        };
        return map[id] || null;
      });
      vi.spyOn(workflowEngine, 'getTaskDependents').mockReturnValue([
        { task_id: 'd1', condition_expr: 'exit_code == 0', on_fail: 'cancel' },
        { task_id: 'd2', condition_expr: 'exit_code == 0', on_fail: 'continue' },
        { task_id: 'd3', condition_expr: 'exit_code == 0', on_fail: 'run_alternate' },
        { task_id: 'd4', condition_expr: 'exit_code == 0', on_fail: 'skip' },
        { task_id: 'd5' }
      ]);
      vi.spyOn(workflowEngine, 'evaluateCondition')
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false);

      const result = handlers.handleWhatIf({
        workflow_id: 'wf-1',
        task_id: 'source',
        simulated_status: 'failed'
      });

      const text = textOf(result);
      expect(text).toContain('Cancel workflow');
      expect(text).toContain('Continue anyway');
      expect(text).toContain('Run alternate');
      expect(text).toContain('Skip task');
      expect(text).toContain('| dep-5 | `(none)` | ✓ Pass | Unblock |');
    });
  });

  describe('handleBlockedTasks', () => {
    it('returns an empty message when there are no blocked tasks', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'WF' });
      vi.spyOn(workflowEngine, 'getBlockedTasks').mockReturnValue([]);
      const result = handlers.handleBlockedTasks({ workflow_id: 'wf-1' });
      expect(textOf(result)).toContain('No blocked tasks found');
    });

    it('shows only unmet dependencies in waiting-on column', () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({ id: 'wf-1', name: 'WF' });
      vi.spyOn(workflowEngine, 'getBlockedTasks').mockReturnValue([
        { id: 'task-b', workflow_id: 'wf-1', workflow_node_id: 'B', status: 'blocked' }
      ]);
      vi.spyOn(workflowEngine, 'getTaskDependencies').mockReturnValue([
        { depends_on_task_id: 'task-a', depends_on_status: 'running' },
        { depends_on_task_id: 'task-c', depends_on_status: 'completed' }
      ]);
      vi.spyOn(taskCore, 'getTask').mockImplementation((id) => {
        if (id === 'task-a') return { id: 'task-a', workflow_node_id: 'A' };
        if (id === 'task-c') return { id: 'task-c', workflow_node_id: 'C' };
        return null;
      });

      const result = handlers.handleBlockedTasks({ workflow_id: 'wf-1' });
      const text = textOf(result);

      expect(text).toContain('Blocked Tasks');
      expect(text).toContain('| B | wf-1 | A |');
      expect(text).not.toContain('C');
    });
  });
});
