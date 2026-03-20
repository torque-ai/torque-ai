const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Workflow Handlers', () => {
  let db;

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

  function createWorkflowDirect(name, opts = {}) {
    const id = randomUUID();
    db.createWorkflow({
      id,
      name,
      description: opts.description || null,
      working_directory: opts.working_directory || null,
      status: opts.status || 'pending'
    });
    return id;
  }

  function createTaskDirect(description, opts = {}) {
    const id = randomUUID();
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
    return id;
  }

  // ═══════════════════════════════════════════════════════════════════
  // create_workflow
  // ═══════════════════════════════════════════════════════════════════

  describe('create_workflow', () => {
    it('creates a workflow with valid name', async () => {
      const result = await safeTool('create_workflow', {
        name: 'test-wf',
        tasks: [{ node_id: 'wf-a', task_description: 'Initial workflow task' }]
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Workflow Created');
      expect(text).toContain('test-wf');
      expect(text).toContain('**Tasks:** 1');
      expect(extractUUID(text)).toBeTruthy();
    });

    it('creates a workflow with description', async () => {
      const result = await safeTool('create_workflow', {
        name: 'desc-wf',
        description: 'A workflow with a description',
        tasks: [{ node_id: 'wf-desc', task_description: 'Initial workflow task' }]
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('A workflow with a description');
    });

    it('rejects missing tasks array', async () => {
      const result = await safeTool('create_workflow', { name: 'missing-tasks-wf' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Missing required parameter: "tasks"');
    });

    it('rejects empty name string', async () => {
      const result = await safeTool('create_workflow', { name: '', tasks: [{ description: 'test' }] });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('name');
    });

    it('rejects missing name', async () => {
      const result = await safeTool('create_workflow', {});
      expect(result.isError).toBe(true);
    });

    it('rejects whitespace-only name', async () => {
      const result = await safeTool('create_workflow', { name: '   ' });
      expect(result.isError).toBe(true);
    });

    it('rejects non-string name', async () => {
      const result = await safeTool('create_workflow', { name: 123 });
      expect(result.isError).toBe(true);
    });

    it('rejects name exceeding MAX_NAME_LENGTH', async () => {
      const result = await safeTool('create_workflow', { name: 'x'.repeat(200), tasks: [{ description: 'test' }] });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('name');
    });

    it('rejects non-string description', async () => {
      const result = await safeTool('create_workflow', { name: 'valid', description: 42 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Parameter "description" must be of type string');
    });

    it('rejects description exceeding MAX_DESCRIPTION_LENGTH', async () => {
      const result = await safeTool('create_workflow', {
        name: 'valid2',
        description: 'd'.repeat(1100),
        tasks: [{ description: 'test' }]
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('description');
    });

    it('trims name whitespace', async () => {
      const result = await safeTool('create_workflow', {
        name: '  trimmed-wf  ',
        tasks: [{ node_id: 'wf-trimmed', task_description: 'Initial workflow task' }]
      });
      expect(result.isError).toBeFalsy();
      // The handler trims, so the output should contain 'trimmed-wf'
      expect(getText(result)).toContain('trimmed-wf');
    });
  });

  describe('add_workflow_task', () => {
    let workflowId;

    beforeAll(async () => {
      workflowId = createWorkflowDirect('task-add-wf');
    });

    it('adds a task without dependencies', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        node_id: 'node-a',
        task_description: 'Step A of workflow'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Added to Workflow');
      expect(text).toContain('node-a');
    });

    it('adds a task with dependencies', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        node_id: 'node-b',
        task_description: 'Step B depends on A',
        depends_on: ['node-a']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('node-b');
      expect(text).toContain('Depends On');
      expect(text).toContain('node-a');
    });

    it('rejects empty task_description', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        node_id: 'bad-node',
        task_description: ''
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('non-empty string');
    });

    it('rejects missing task_description', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        node_id: 'bad-node'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects task_description exceeding MAX_TASK_LENGTH', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        node_id: 'huge-node',
        task_description: 't'.repeat(60000)
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toMatch(/characters|maximum is 50000/);
    });

    it('rejects non-array depends_on', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        node_id: 'bad-deps',
        task_description: 'bad deps type',
        depends_on: 'node-a'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Parameter "depends_on" must be of type array');
    });

    it('returns error for nonexistent workflow_id', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: 'nonexistent-wf-xyz',
        node_id: 'orphan',
        task_description: 'orphan task'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found');
    });

    it('returns error for nonexistent dependency node', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        node_id: 'node-c',
        task_description: 'Step C with bad dep',
        depends_on: ['nonexistent-dep']
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Dependency not found');
    });

    it('shows on_fail value in output', async () => {
      // Add a task that depends on node-a with on_fail=cancel
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        node_id: 'node-d',
        task_description: 'Step D with cancel on fail',
        depends_on: ['node-a'],
        on_fail: 'cancel'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('cancel');
    });

    it('shows condition in output when provided', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        node_id: 'node-e',
        task_description: 'Step E conditional',
        depends_on: ['node-a'],
        condition: 'exit_code == 0'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('exit_code == 0');
    });
  });

  describe('run_workflow', () => {
    it('starts a workflow with pending tasks', async () => {
      const wfId = createWorkflowDirect('runnable-wf');
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'run-a', task_description: 'Run step A'
      });

      const result = await safeTool('run_workflow', { workflow_id: wfId });
      if (result.isError) console.log('DEBUG starts-workflow:', getText(result));
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Workflow Started');
      expect(text).toContain('Total Tasks');
    });

    it('returns error for nonexistent workflow', async () => {
      const result = await safeTool('run_workflow', { workflow_id: 'fake-wf-id' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found');
    });

    it('returns error if workflow already running', async () => {
      const wfId = createWorkflowDirect('already-running');
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'run-x', task_description: 'Step X'
      });
      await safeTool('run_workflow', { workflow_id: wfId });

      const result = await safeTool('run_workflow', { workflow_id: wfId });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('already running');
    });

    it('returns error if workflow has no tasks', async () => {
      const wfId = createWorkflowDirect('empty-run-wf');

      const result = await safeTool('run_workflow', { workflow_id: wfId });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('no tasks');
    });

    it('reports blocked tasks count', async () => {
      const wfId = createWorkflowDirect('blocked-count-wf');
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'bc-a', task_description: 'BC Step A'
      });
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'bc-b', task_description: 'BC Step B',
        depends_on: ['bc-a']
      });

      const result = await safeTool('run_workflow', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Blocked Tasks');
    });

    it('preserves paused workflow resume when runnable tasks are still live', async () => {
      const wfId = createWorkflowDirect('paused-resume-wf', { status: 'paused' });
      db.updateWorkflow(wfId, { started_at: '2026-01-01T00:00:00.000Z' });
      createTaskDirect('Resume pending task', {
        workflow_id: wfId,
        workflow_node_id: 'resume-a',
        status: 'pending'
      });

      const result = await safeTool('run_workflow', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Workflow Started');
    });

    it('rejects non-paused restart when live runnable work is already present', async () => {
      const wfId = createWorkflowDirect('stale-runnable-wf', { status: 'completed' });
      createTaskDirect('Queued leftover task', {
        workflow_id: wfId,
        workflow_node_id: 'stale-a',
        status: 'queued'
      });

      const result = await safeTool('run_workflow', { workflow_id: wfId });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('still has live runnable work');
    });
  });

  describe('workflow_status', () => {
    it('returns error for nonexistent workflow', async () => {
      const result = await safeTool('workflow_status', { workflow_id: 'ghost-wf' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found');
    });

    it('returns status for existing workflow with tasks', async () => {
      const wfId = createWorkflowDirect('status-check-wf');
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'sc-a', task_description: 'Status step A'
      });

      const result = await safeTool('workflow_status', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Workflow Status');
      expect(text).toContain('sc-a');
      expect(text).toContain('Completed');
      expect(text).toContain('Running');
      expect(text).toContain('Pending');
    });

    it('shows task summary counts', async () => {
      const wfId = createWorkflowDirect('summary-wf');
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'sum-a', task_description: 'Sum A'
      });
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'sum-b', task_description: 'Sum B',
        depends_on: ['sum-a']
      });

      const result = await safeTool('workflow_status', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Total');
    });

    it('flags empty workflows as hygiene issues', async () => {
      const wfId = createWorkflowDirect('empty-hygiene-wf');

      const result = await safeTool('workflow_status', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('HYGIENE: empty workflow');
      expect(text).toContain('Actionable:** No');
      expect(text).toContain('has no tasks attached');
    });
  });

  describe('cancel_workflow', () => {
    it('cancels an existing workflow', async () => {
      const wfId = createWorkflowDirect('cancel-me-wf');
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'cm-a', task_description: 'Cancel step A'
      });

      const result = await safeTool('cancel_workflow', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Workflow Cancelled');
      expect(text).toContain('cancel-me-wf');
    });

    it('reports cancellation reason', async () => {
      const wfId = createWorkflowDirect('cancel-reason-wf');
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'cr-a', task_description: 'Reason step'
      });

      const result = await safeTool('cancel_workflow', {
        workflow_id: wfId,
        reason: 'No longer needed'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No longer needed');
    });

    it('returns error for nonexistent workflow', async () => {
      const result = await safeTool('cancel_workflow', { workflow_id: 'nope-wf' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found');
    });

    it('reports tasks cancelled count', async () => {
      const wfId = createWorkflowDirect('cancel-count-wf');
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'cc-a', task_description: 'CC A'
      });
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'cc-b', task_description: 'CC B'
      });

      const result = await safeTool('cancel_workflow', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Tasks Cancelled');
    });
  });

  describe('pause_workflow', () => {
    it('pauses a running workflow', async () => {
      const wfId = createWorkflowDirect('pause-wf');
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'pa-a', task_description: 'Pause A'
      });
      await safeTool('run_workflow', { workflow_id: wfId });

      const result = await safeTool('pause_workflow', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Workflow Paused');
      expect(text).toContain('pause-wf');
    });

    it('returns error for nonexistent workflow', async () => {
      const result = await safeTool('pause_workflow', { workflow_id: 'ghost-pause' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found');
    });

    it('returns error if workflow is not running', async () => {
      const wfId = createWorkflowDirect('not-running-pause');

      const result = await safeTool('pause_workflow', { workflow_id: wfId });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not running');
    });

    it('returns error if workflow is already paused', async () => {
      const wfId = createWorkflowDirect('double-pause');
      await safeTool('add_workflow_task', {
        workflow_id: wfId, node_id: 'dp-a', task_description: 'DP A'
      });
      await safeTool('run_workflow', { workflow_id: wfId });
      await safeTool('pause_workflow', { workflow_id: wfId });

      const result = await safeTool('pause_workflow', { workflow_id: wfId });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not running');
    });
  });

  describe('list_workflows', () => {
    it('lists workflows without filters', async () => {
      const result = await safeTool('list_workflows', {});
      expect(result.isError).toBeFalsy();
    });

    it('filters by status', async () => {
      const result = await safeTool('list_workflows', { status: 'pending' });
      expect(result.isError).toBeFalsy();
    });

    it('returns no-workflows message when none match', async () => {
      const result = await safeTool('list_workflows', { status: 'cancelled' });
      // May or may not find results depending on test order, but should not error
      expect(result.isError).toBeFalsy();
    });

    it('respects limit parameter', async () => {
      const result = await safeTool('list_workflows', { limit: 1 });
      expect(result.isError).toBeFalsy();
    });

    it('accepts since parameter', async () => {
      const result = await safeTool('list_workflows', {
        since: '2020-01-01T00:00:00Z'
      });
      expect(result.isError).toBeFalsy();
    });

    it('shows workflow table with columns', async () => {
      const result = await safeTool('list_workflows', {});
      const text = getText(result);
      if (text.includes('Workflows')) {
        expect(text).toContain('Visibility');
        expect(text).toContain('Open/Total');
      }
    });

    it('separates empty workflows into a hygiene section', async () => {
      createWorkflowDirect('empty-list-hygiene-wf');

      const result = await safeTool('list_workflows', { status: 'pending' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Workflow Hygiene Issues');
      expect(text).toContain('empty-list-hygiene-wf');
      expect(text).toContain('HYGIENE: empty workflow');
    });
  });

  describe('workflow_history', () => {
    it('returns error for nonexistent workflow', async () => {
      const result = await safeTool('workflow_history', { workflow_id: 'no-hist-wf' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found');
    });

    it('returns history for existing workflow', async () => {
      const wfId = createWorkflowDirect('history-wf');

      const result = await safeTool('workflow_history', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Workflow History');
    });

    it('shows "No events" for a fresh workflow', async () => {
      const wfId = createWorkflowDirect('no-events-wf');

      const result = await safeTool('workflow_history', { workflow_id: wfId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No events');
    });
  });

});
