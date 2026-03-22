const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;

describe('Workflow Handlers', () => {
  beforeAll(() => {
    const env = setupTestDb('workflow-handlers');
    db = env.db;
    // initSubModules wires the extracted module graph (provider routing, execution, etc.)
    // In production this is called by index.js:init(); in tests we must call it explicitly.
    require('../task-manager').initSubModules();
  });
  afterAll(() => { teardownTestDb(); });

  // ── Helper: extract first UUID from text ──
  function extractUUID(text) {
    const m = text.match(/([a-f0-9-]{36})/);
    return m ? m[1] : null;
  }

  // Helper: create a workflow via DB directly
  function createWorkflowDirect(name, opts = {}) {
    const id = require('crypto').randomUUID();
    db.createWorkflow({
      id,
      name,
      description: opts.description || null,
      template_id: opts.template_id || null
    });
    if (opts.status) {
      db.updateWorkflow(id, { status: opts.status });
    }
    return db.getWorkflow(id);
  }

  // Helper: create a task directly via DB
  function createTaskDirect(description, opts = {}) {
    const id = require('crypto').randomUUID();
    db.createTask({
      id,
      task_description: description || 'test task',
      working_directory: opts.working_directory || process.env.TORQUE_DATA_DIR,
      status: opts.status || 'queued',
      priority: opts.priority || 0,
      workflow_id: opts.workflow_id || null,
      workflow_node_id: opts.workflow_node_id || null,
      project: opts.project || null
    });
    return db.getTask(id);
  }

  // ═══════════════════════════════════════════════════════════════════
  // create_workflow
  // ═══════════════════════════════════════════════════════════════════

  describe('dependency_graph', () => {
    let graphWfId;

    beforeAll(async () => {
      graphWfId = createWorkflowDirect('graph-wf').id;
      await safeTool('add_workflow_task', {
        workflow_id: graphWfId, node_id: 'g-a', task_description: 'Graph A'
      });
      await safeTool('add_workflow_task', {
        workflow_id: graphWfId, node_id: 'g-b', task_description: 'Graph B',
        depends_on: ['g-a']
      });
      await safeTool('add_workflow_task', {
        workflow_id: graphWfId, node_id: 'g-c', task_description: 'Graph C',
        depends_on: ['g-a']
      });
    });

    it('returns mermaid graph by default', async () => {
      const result = await safeTool('dependency_graph', { workflow_id: graphWfId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('mermaid');
      expect(text).toContain('g-a');
      expect(text).toContain('g-b');
    });

    it('returns json graph', async () => {
      const result = await safeTool('dependency_graph', {
        workflow_id: graphWfId,
        format: 'json'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const graph = JSON.parse(text);
      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges.length).toBeGreaterThanOrEqual(2);
    });

    it('returns ascii graph', async () => {
      const result = await safeTool('dependency_graph', {
        workflow_id: graphWfId,
        format: 'ascii'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('g-a');
      expect(text).toContain('<-');
    });

    it('returns error for nonexistent workflow', async () => {
      const result = await safeTool('dependency_graph', { workflow_id: 'no-graph-wf' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found');
    });
  });

  describe('critical_path', () => {
    let cpWfId;

    beforeAll(async () => {
      cpWfId = createWorkflowDirect('critical-path-wf').id;
      await safeTool('add_workflow_task', {
        workflow_id: cpWfId, node_id: 'cp-a', task_description: 'CP A'
      });
      await safeTool('add_workflow_task', {
        workflow_id: cpWfId, node_id: 'cp-b', task_description: 'CP B',
        depends_on: ['cp-a']
      });
      await safeTool('add_workflow_task', {
        workflow_id: cpWfId, node_id: 'cp-c', task_description: 'CP C',
        depends_on: ['cp-b']
      });
      // Parallel branch
      await safeTool('add_workflow_task', {
        workflow_id: cpWfId, node_id: 'cp-d', task_description: 'CP D',
        depends_on: ['cp-a']
      });
    });

    it('finds the longest path', async () => {
      const result = await safeTool('critical_path', { workflow_id: cpWfId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Critical Path');
      expect(text).toContain('3'); // length: A -> B -> C = 3 tasks
    });

    it('returns error for nonexistent workflow', async () => {
      const result = await safeTool('critical_path', { workflow_id: 'no-cp-wf' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found');
    });

    it('handles workflow with single task', async () => {
      const wfId = createWorkflowDirect('single-cp-wf').id;
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'only', task_description: 'Only task'
      });

      const result = await safeTool('critical_path', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('1');
    });
  });

  describe('what_if', () => {
    let wiWfId, wiTaskAId, wiTaskBId;

    beforeAll(async () => {
      wiWfId = createWorkflowDirect('what-if-wf').id;

      const tA = await safeTool('add_workflow_task', {
        workflow_id: wiWfId, node_id: 'wi-a', task_description: 'WI A'
      });
      wiTaskAId = extractUUID(getText(tA));

      const tB = await safeTool('add_workflow_task', {
        workflow_id: wiWfId, node_id: 'wi-b', task_description: 'WI B',
        depends_on: ['wi-a']
      });
      wiTaskBId = extractUUID(getText(tB));
    });

    it('simulates task success', async () => {
      const result = await safeTool('what_if', {
        workflow_id: wiWfId,
        task_id: wiTaskAId,
        simulated_status: 'completed'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('What-If Analysis');
      expect(text).toContain('completed');
    });

    it('simulates task failure', async () => {
      const result = await safeTool('what_if', {
        workflow_id: wiWfId,
        task_id: wiTaskAId,
        simulated_status: 'failed'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('What-If Analysis');
      expect(text).toContain('failed');
    });

    it('returns error for nonexistent workflow', async () => {
      const result = await safeTool('what_if', {
        workflow_id: 'no-wi-wf',
        task_id: wiTaskAId,
        simulated_status: 'completed'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found');
    });

    it('returns error for task not in workflow', async () => {
      const result = await safeTool('what_if', {
        workflow_id: wiWfId,
        task_id: 'random-task-id',
        simulated_status: 'completed'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Task not found');
    });

    it('reports no downstream effects for leaf task', async () => {
      const result = await safeTool('what_if', {
        workflow_id: wiWfId,
        task_id: wiTaskBId,
        simulated_status: 'completed'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('no dependents');
    });

    it('uses custom simulated_exit_code', async () => {
      const result = await safeTool('what_if', {
        workflow_id: wiWfId,
        task_id: wiTaskAId,
        simulated_status: 'failed',
        simulated_exit_code: 42
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('42');
    });
  });

  describe('blocked_tasks', () => {
    it('returns blocked tasks list or empty message', async () => {
      const result = await safeTool('blocked_tasks', {});
      expect(result.isError).toBeFalsy();
    });

    it('filters by workflow_id', async () => {
      const wfId = createWorkflowDirect('blocked-filter-wf').id;
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'bf-a', task_description: 'BF A'
      });
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'bf-b', task_description: 'BF B',
        depends_on: ['bf-a']
      });

      const result = await safeTool('blocked_tasks', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
    });

    it('returns no blocked tasks message when none blocked', async () => {
      const wfId = createWorkflowDirect('no-blocked-wf').id;
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'nb-a', task_description: 'No block A'
      });

      const result = await safeTool('blocked_tasks', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
      // If task A has no deps, it is not blocked -> "No blocked tasks found"
    });
  });

  describe('retry_workflow_from', () => {
    let retryWfId, retryTaskAId;

    beforeAll(async () => {
      retryWfId = createWorkflowDirect('retry-wf').id;

      const tA = await safeTool('add_workflow_task', {
        workflow_id: retryWfId, node_id: 'ret-a', task_description: 'Retry A'
      });
      retryTaskAId = extractUUID(getText(tA));

      await safeTool('add_workflow_task', {
        workflow_id: retryWfId, node_id: 'ret-b', task_description: 'Retry B',
        depends_on: ['ret-a']
      });
    });

    it('rejects retry when the workflow still has live runnable work', async () => {
      const result = await safeTool('retry_workflow_from', {
        workflow_id: retryWfId,
        from_task_id: retryTaskAId
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
      const text = getText(result);
      expect(text).toContain('still has live runnable work');
    });

    it('returns error for nonexistent workflow', async () => {
      const result = await safeTool('retry_workflow_from', {
        workflow_id: 'no-retry-wf',
        from_task_id: retryTaskAId
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found');
    });

    it('returns error for task not in workflow', async () => {
      const result = await safeTool('retry_workflow_from', {
        workflow_id: retryWfId,
        from_task_id: 'random-task-xyz'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Task not found in workflow');
    });
  });

  describe('skip_task', () => {
    it('skips a blocked task', async () => {
      const wfId = createWorkflowDirect('skip-wf').id;
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'sk-a', task_description: 'Skip A'
      });
      const tB = await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'sk-b', task_description: 'Skip B',
        depends_on: ['sk-a']
      });
      const taskBId = extractUUID(getText(tB));

      const result = await safeTool('skip_task', { task_id: taskBId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Skipped');
    });

    it('skips with reason', async () => {
      const wfId = createWorkflowDirect('skip-reason-wf').id;
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'sr-a', task_description: 'SR A'
      });
      const tB = await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'sr-b', task_description: 'SR B',
        depends_on: ['sr-a']
      });
      const taskBId = extractUUID(getText(tB));

      const result = await safeTool('skip_task', {
        task_id: taskBId,
        reason: 'Not needed'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Not needed');
    });

    it('returns error for nonexistent task', async () => {
      const result = await safeTool('skip_task', { task_id: 'no-such-task-id' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Task not found');
    });

    it('returns error for task not blocked', async () => {
      // Create a task that is not blocked (pending status, no deps)
      const task = createTaskDirect('not blocked task', { status: 'pending' });
      const result = await safeTool('skip_task', { task_id: task.id });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not blocked');
    });
  });

  describe('template_loop', () => {
    it('rejects missing template_id', async () => {
      const result = await safeTool('template_loop', {
        items: ['a', 'b', 'c']
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('template_id');
    });

    it('rejects empty items array', async () => {
      const result = await safeTool('template_loop', {
        template_id: 'some-tmpl',
        items: []
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('non-empty array');
    });

    it('rejects non-array items', async () => {
      const result = await safeTool('template_loop', {
        template_id: 'some-tmpl',
        items: 'not-an-array'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects more than 100 items', async () => {
      const result = await safeTool('template_loop', {
        template_id: 'some-tmpl',
        items: Array.from({ length: 101 }, (_, i) => `item-${i}`)
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('100 or fewer');
    });

    it('rejects nonexistent template', async () => {
      const result = await safeTool('template_loop', {
        template_id: 'nonexistent-loop-tmpl',
        items: ['a', 'b']
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Template not found');
    });
  });

  describe('fork_workflow', () => {
    let forkWfId;

    beforeAll(async () => {
      forkWfId = createWorkflowDirect('fork-wf').id;
    });

    it('forks a workflow into branches', async () => {
      const result = await safeTool('fork_workflow', {
        workflow_id: forkWfId,
        branches: [
          { name: 'branch-a', tasks: ['Task A1', 'Task A2'] },
          { name: 'branch-b', tasks: ['Task B1'] }
        ]
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Workflow Forked');
      expect(text).toContain('branch-a');
      expect(text).toContain('branch-b');
    });

    it('rejects fewer than 2 branches', async () => {
      const result = await safeTool('fork_workflow', {
        workflow_id: forkWfId,
        branches: [{ name: 'solo', tasks: ['Task 1'] }]
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('at least 2');
    });

    it('rejects missing workflow_id', async () => {
      const result = await safeTool('fork_workflow', {
        branches: [
          { name: 'a', tasks: ['t1'] },
          { name: 'b', tasks: ['t2'] }
        ]
      });
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent workflow', async () => {
      const result = await safeTool('fork_workflow', {
        workflow_id: 'no-fork-wf',
        branches: [
          { name: 'a', tasks: ['t1'] },
          { name: 'b', tasks: ['t2'] }
        ]
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found');
    });

    it('rejects invalid merge_strategy', async () => {
      const result = await safeTool('fork_workflow', {
        workflow_id: forkWfId,
        branches: [
          { name: 'a', tasks: ['t1'] },
          { name: 'b', tasks: ['t2'] }
        ],
        merge_strategy: 'invalid'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('merge_strategy');
    });

    it('accepts merge_strategy=any', async () => {
      const wfId = createWorkflowDirect('fork-any-wf').id;
      const result = await safeTool('fork_workflow', {
        workflow_id: wfId,
        branches: [
          { name: 'fast', tasks: ['fast task'] },
          { name: 'slow', tasks: ['slow task'] }
        ],
        merge_strategy: 'any'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('any');
    });

    it('accepts merge_strategy=first', async () => {
      const wfId = createWorkflowDirect('fork-first-wf').id;
      const result = await safeTool('fork_workflow', {
        workflow_id: wfId,
        branches: [
          { name: 'racer1', tasks: ['r1'] },
          { name: 'racer2', tasks: ['r2'] }
        ],
        merge_strategy: 'first'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('first');
    });
  });

  describe('merge_workflows', () => {
    it('rejects missing fork_id', async () => {
      const result = await safeTool('merge_workflows', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('fork_id');
    });

    it('rejects nonexistent fork', async () => {
      const result = await safeTool('merge_workflows', { fork_id: 'no-such-fork' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Fork not found');
    });

    it('merges an existing fork', async () => {
      // First create a fork
      const wfId = createWorkflowDirect('merge-test-wf').id;
      const forkResult = await safeTool('fork_workflow', {
        workflow_id: wfId,
        branches: [
          { name: 'merge-a', tasks: ['MA'] },
          { name: 'merge-b', tasks: ['MB'] }
        ]
      });
      const forkId = extractUUID(getText(forkResult));

      const result = await safeTool('merge_workflows', { fork_id: forkId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Workflow Branches Merged');
    });

    it('respects combine_outputs=false', async () => {
      const wfId = createWorkflowDirect('merge-no-combine-wf').id;
      const forkResult = await safeTool('fork_workflow', {
        workflow_id: wfId,
        branches: [
          { name: 'nc-a', tasks: ['NCA'] },
          { name: 'nc-b', tasks: ['NCB'] }
        ]
      });
      const forkId = extractUUID(getText(forkResult));

      const result = await safeTool('merge_workflows', {
        fork_id: forkId,
        combine_outputs: false
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('false');
    });
  });

  describe('replay_task', () => {
    let replayableTaskId;

    beforeAll(() => {
      const task = createTaskDirect('replayable task', { status: 'completed' });
      replayableTaskId = task.id;
    });

    it('replays a task', async () => {
      const result = await safeTool('replay_task', { task_id: replayableTaskId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Replayed');
      expect(text).toContain(replayableTaskId);
    });

    it('replays with modified inputs', async () => {
      const result = await safeTool('replay_task', {
        task_id: replayableTaskId,
        modified_inputs: { task: 'Modified task description' }
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Modified Inputs');
    });

    it('replays with new working directory', async () => {
      const result = await safeTool('replay_task', {
        task_id: replayableTaskId,
        new_working_directory: process.env.TORQUE_DATA_DIR
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Task Replayed');
    });

    it('rejects missing task_id', async () => {
      const result = await safeTool('replay_task', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('task_id');
    });

    it('rejects nonexistent task', async () => {
      const result = await safeTool('replay_task', { task_id: 'no-such-task-replay' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Task not found');
    });
  });

  describe('diff_task_runs', () => {
    let taskAId, taskBId;

    beforeAll(() => {
      const taskA = createTaskDirect('diff task A', { status: 'completed' });
      const taskB = createTaskDirect('diff task B', { status: 'completed' });
      taskAId = taskA.id;
      taskBId = taskB.id;
    });

    it('compares two tasks', async () => {
      const result = await safeTool('diff_task_runs', {
        task_id_a: taskAId,
        task_id_b: taskBId
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Comparison');
      expect(text).toContain('Field');
    });

    it('compares with custom fields', async () => {
      const result = await safeTool('diff_task_runs', {
        task_id_a: taskAId,
        task_id_b: taskBId,
        compare_fields: ['exit_code', 'status']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('exit_code');
      expect(text).toContain('status');
    });

    it('rejects missing task_id_a', async () => {
      const result = await safeTool('diff_task_runs', { task_id_b: taskBId });
      expect(result.isError).toBe(true);
    });

    it('rejects missing task_id_b', async () => {
      const result = await safeTool('diff_task_runs', { task_id_a: taskAId });
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task A', async () => {
      const result = await safeTool('diff_task_runs', {
        task_id_a: 'ghost-task-a',
        task_id_b: taskBId
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Task not found');
    });

    it('rejects nonexistent task B', async () => {
      const result = await safeTool('diff_task_runs', {
        task_id_a: taskAId,
        task_id_b: 'ghost-task-b'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Task not found');
    });

    it('shows same/different indicator', async () => {
      const result = await safeTool('diff_task_runs', {
        task_id_a: taskAId,
        task_id_b: taskBId,
        compare_fields: ['exit_code']
      });
      expect(result.isError).toBeFalsy();
      // Both tasks have no exit_code set, so they should be the "same"
      const text = getText(result);
      // The output includes either checkmark or X mark
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('duplicate_pipeline', () => {
    it('returns error for nonexistent pipeline', async () => {
      const result = await safeTool('duplicate_pipeline', {
        pipeline_id: '999999',
        new_name: 'cloned-pipeline'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Pipeline not found');
    });
  });

  describe('export_report', () => {
    beforeAll(() => {
      // Create some tasks for the report
      createTaskDirect('report task 1', { status: 'completed', project: 'proj-a' });
      createTaskDirect('report task 2', { status: 'failed', project: 'proj-a' });
      createTaskDirect('report task 3', { status: 'completed', project: 'proj-b' });
    });

    it('generates markdown report by default', async () => {
      const result = await safeTool('export_report', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Report');
    });

    it('generates CSV report', async () => {
      const result = await safeTool('export_report', { format: 'csv' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('csv');
      expect(text).toContain('id,status');
    });

    it('generates JSON report', async () => {
      const result = await safeTool('export_report', { format: 'json' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('JSON');
      expect(text).toContain('Summary');
    });

    it('filters by project', async () => {
      const result = await safeTool('export_report', { project: 'proj-a' });
      expect(result.isError).toBeFalsy();
    });

    it('filters by status', async () => {
      const result = await safeTool('export_report', { status: 'completed' });
      expect(result.isError).toBeFalsy();
    });

    it('filters by comma-separated statuses', async () => {
      const result = await safeTool('export_report', { status: 'completed,failed' });
      expect(result.isError).toBeFalsy();
    });

    it('filters by date range', async () => {
      const result = await safeTool('export_report', {
        start_date: '2020-01-01',
        end_date: '2030-01-01'
      });
      expect(result.isError).toBeFalsy();
    });

    it('returns no-results message for impossible filter', async () => {
      const result = await safeTool('export_report', {
        project: 'nonexistent-project-xyz'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('No tasks found');
    });

    it('includes output when include_output is true', async () => {
      const result = await safeTool('export_report', { include_output: true });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('await_workflow', () => {
    it('returns error for nonexistent workflow', async () => {
      const result = await safeTool('await_workflow', {
        workflow_id: 'no-await-wf',
        timeout_minutes: 0.01
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found');
    });

    it('times out quickly for workflow with no terminal tasks', async () => {
      const wfId = createWorkflowDirect('await-timeout-wf').id;
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'at-a', task_description: 'Await timeout A'
      });
      await safeTool('run_workflow', { workflow_id: wfId });

      const result = await safeTool('await_workflow', {
        workflow_id: wfId,
        timeout_minutes: 0.01,
        poll_interval_ms: 1000
      });
      // Should either timeout or return a task
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('returns completed task when all tasks are already terminal', async () => {
      // Create a workflow, add a task, mark it completed directly
      const wf = createWorkflowDirect('await-done-wf', { status: 'running' });
      const _task = createTaskDirect('Already done', {
        workflow_id: wf.id,
        workflow_node_id: 'done-node',
        status: 'completed'
      });
      db.updateWorkflowCounts(wf.id);

      const result = await safeTool('await_workflow', {
        workflow_id: wf.id,
        timeout_minutes: 0.1,
        poll_interval_ms: 1000
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      // Should contain either task yield or final summary
      expect(text).toContain('Completed');
    });
  });

  describe('create_feature_workflow', () => {
    it('creates full feature workflow with all steps', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'InventorySystem',
        working_directory: process.cwd(),
        types_task: 'Create inventory types',
        events_task: 'Add inventory events',
        data_task: 'Create inventory data',
        system_task: 'Create InventorySystem class',
        tests_task: 'Write inventory tests',
        wire_task: 'Wire inventory into GameScene'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Feature Workflow Created');
      expect(text).toContain('InventorySystem');
      expect(text).toContain('inventory-system-types');
      expect(text).toContain('inventory-system-events');
      expect(text).toContain('inventory-system-data');
      expect(text).toContain('inventory-system-system');
      expect(text).toContain('inventory-system-tests');
      expect(text).toContain('inventory-system-wire');
    });

    it('creates minimal feature workflow with only types', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'MinimalFeature',
        working_directory: process.cwd(),
        types_task: 'Create minimal types only'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('MinimalFeature');
    });

    it('creates feature workflow with parallel tasks', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'ParallelFeature',
        working_directory: process.cwd(),
        types_task: 'Create types',
        parallel_tasks: [
          { node_id: 'extra-test-1', task: 'Extra test 1' },
          { node_id: 'extra-test-2', task: 'Extra test 2' }
        ]
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('extra-test-1');
      expect(text).toContain('extra-test-2');
    });

    it('creates feature workflow with step_providers', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'ProviderFeature',
        working_directory: process.cwd(),
        types_task: 'Create types',
        system_task: 'Create system',
        step_providers: { types: 'ollama', system: 'codex' }
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('ollama');
      expect(text).toContain('codex');
    });

    it('creates feature workflow with custom name and description', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'CustomName',
        working_directory: process.cwd(),
        workflow_name: 'My Custom Workflow',
        description: 'A custom description',
        types_task: 'Create types'
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects missing feature_name', async () => {
      const result = await safeTool('create_feature_workflow', {
        working_directory: process.cwd()
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('feature_name');
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'NoDir'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('working_directory');
    });

    it('rejects non-string feature_name', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 42,
        working_directory: process.cwd()
      });
      expect(result.isError).toBe(true);
    });

    it('rejects non-string working_directory', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'BadDir',
        working_directory: 123
      });
      expect(result.isError).toBe(true);
    });

    it('handles CamelCase to kebab conversion correctly', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'QuestTrackingSystem',
        working_directory: process.cwd(),
        types_task: 'Create quest tracking types'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('quest-tracking-system-types');
    });

    it('creates only specified steps (no data, no events)', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'PartialFeature',
        working_directory: process.cwd(),
        types_task: 'Types only',
        system_task: 'System without data',
        tests_task: 'Tests for system'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('partial-feature-types');
      expect(text).toContain('partial-feature-system');
      expect(text).toContain('partial-feature-tests');
      // data and events should not appear
      expect(text).not.toContain('partial-feature-data');
      expect(text).not.toContain('partial-feature-events');
    });

    it('system step gets needs_review: true in metadata', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'ReviewFeature',
        working_directory: process.cwd(),
        system_task: 'Create ReviewFeatureSystem class'
      });

      expect(result.isError).toBeFalsy();

      const wfId = extractUUID(getText(result));
      const systemTask = db.getWorkflowTasks(wfId).find((task) => task.workflow_node_id === 'review-feature-system');

      expect(systemTask).toBeTruthy();
      expect(db.getTask(systemTask.id).metadata).toMatchObject({ needs_review: true });
    });

    it('types step does NOT get needs_review flag', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'NoReviewTypes',
        working_directory: process.cwd(),
        types_task: 'Create types only'
      });

      expect(result.isError).toBeFalsy();

      const wfId = extractUUID(getText(result));
      const typesTask = db.getWorkflowTasks(wfId).find((task) => task.workflow_node_id === 'no-review-types-types');

      expect(typesTask).toBeTruthy();
      expect(db.getTask(typesTask.id).metadata || {}).not.toHaveProperty('needs_review');
    });
  });

  describe('formatTaskYield via await_workflow', () => {
    it('formats completed task with output and progress', async () => {
      const wf = createWorkflowDirect('yield-format-wf', { status: 'running' });
      // Create task in 'queued' state, transition through running to completed
      const task = createTaskDirect('Yield format task', {
        workflow_id: wf.id,
        workflow_node_id: 'yield-node',
        status: 'queued'
      });
      db.updateTaskStatus(task.id, 'running');
      db.updateTaskStatus(task.id, 'completed', {
        output: 'Task completed successfully with some output.'
      });
      db.updateWorkflowCounts(wf.id);

      const result = await safeTool('await_workflow', {
        workflow_id: wf.id,
        timeout_minutes: 0.1,
        poll_interval_ms: 1000
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      // Should contain task details
      expect(text).toContain('yield-node');
    });

    it('formats failed task with error output', async () => {
      const wf = createWorkflowDirect('yield-fail-wf', { status: 'running' });
      // Create task in 'queued' state, transition through running to failed
      const task = createTaskDirect('Yield fail task', {
        workflow_id: wf.id,
        workflow_node_id: 'fail-node',
        status: 'queued'
      });
      db.updateTaskStatus(task.id, 'running');
      db.updateTaskStatus(task.id, 'failed', {
        error_output: 'Something went wrong'
      });
      db.updateWorkflowCounts(wf.id);

      const result = await safeTool('await_workflow', {
        workflow_id: wf.id,
        timeout_minutes: 0.1,
        poll_interval_ms: 1000
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('fail-node');
    });
  });

  describe('integration: workflow lifecycle', () => {
    it('full lifecycle: create -> add tasks -> run -> status -> cancel', async () => {
      // Create
      const wfId = createWorkflowDirect('lifecycle-wf').id;

      // Add tasks
      const t1 = await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'lc-a', task_description: 'Lifecycle A'
      });
      expect(t1.isError).toBeFalsy();

      const t2 = await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'lc-b', task_description: 'Lifecycle B',
        depends_on: ['lc-a']
      });
      expect(t2.isError).toBeFalsy();

      // Run
      const run = await safeTool('run_workflow', { workflow_id: wfId });
      expect(run.isError).toBeFalsy();

      // Status
      const status = await safeTool('workflow_status', { workflow_id: wfId });
      expect(status.isError).toBeFalsy();
      expect(getText(status)).toContain('lc-a');

      // Cancel
      const cancel = await safeTool('cancel_workflow', {
        workflow_id: wfId,
        reason: 'lifecycle test done'
      });
      expect(cancel.isError).toBeFalsy();
    });

    it('pause and resume workflow', async () => {
      const wfId = createWorkflowDirect('pause-resume-wf').id;
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'pr-a', task_description: 'PR A'
      });

      // Run
      await safeTool('run_workflow', { workflow_id: wfId });

      // Pause
      const pause = await safeTool('pause_workflow', { workflow_id: wfId });
      expect(pause.isError).toBeFalsy();

      // Resume (run_workflow on a paused workflow)
      const resume = await safeTool('run_workflow', { workflow_id: wfId });
      // Should work since paused is not 'running'
      expect(resume.isError).toBeFalsy();
    });
  });

  describe('edge: workflow with many tasks', () => {
    it('handles workflow with 20 tasks for status display', async () => {
      const wfId = createWorkflowDirect('many-tasks-wf').id;

      // Add 20 tasks
      for (let i = 0; i < 20; i++) {
        const prev = i > 0 ? [`mt-${i - 1}`] : undefined;
        await safeTool('add_workflow_task', {
          workflow_id: wfId,
          node_id: `mt-${i}`,
          task_description: `Many task ${i}`,
          ...(prev ? { depends_on: prev } : {})
        });
      }

      const status = await safeTool('workflow_status', { workflow_id: wfId });
      expect(status.isError).toBeFalsy();
      expect(getText(status)).toContain('Total');
    });
  });

  describe('edge: add task to completed/failed workflow re-opens it', () => {
    it('re-opens a completed workflow when task is added', async () => {
      const wf = createWorkflowDirect('reopen-wf', { status: 'completed' });

      const result = await safeTool('add_workflow_task', {
        workflow_id: wf.id,
        node_id: 'reopen-task',
        task_description: 'Re-open this workflow'
      });
      expect(result.isError).toBeFalsy();

      // Verify workflow is now running
      const updatedWf = db.getWorkflow(wf.id);
      expect(updatedWf.status).toBe('running');
    });

    it('re-opens a failed workflow when task is added', async () => {
      const wf = createWorkflowDirect('reopen-failed-wf', { status: 'failed' });

      const result = await safeTool('add_workflow_task', {
        workflow_id: wf.id,
        node_id: 'reopen-fail-task',
        task_description: 'Re-open failed workflow'
      });
      expect(result.isError).toBeFalsy();

      const updatedWf = db.getWorkflow(wf.id);
      expect(updatedWf.status).toBe('running');
    });
  });

});
