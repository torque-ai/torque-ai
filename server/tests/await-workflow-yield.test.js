const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

/**
 * Helper: create a workflow, add tasks, return IDs.
 */
async function createTestWorkflow(db, name, taskDefs) {
  const workflowId = randomUUID();
  db.createWorkflow({
    id: workflowId,
    name
  });

  const taskIds = {};
  for (const def of taskDefs) {
    const taskArgs = {
      workflow_id: workflowId,
      node_id: def.node_id,
      task_description: def.task,
      depends_on: def.depends_on
    };
    if (Object.prototype.hasOwnProperty.call(def, 'verify_command')) {
      taskArgs.verify_command = def.verify_command;
    }
    if (Object.prototype.hasOwnProperty.call(def, 'verify_skip')) {
      taskArgs.verify_skip = def.verify_skip;
    }
    const result = await safeTool('add_workflow_task', taskArgs);
    const text = getText(result);
    taskIds[def.node_id] = extractUUID(text);
  }

  return { workflowId, taskIds };
}

function extractUUID(text) {
  const idMatch = text.match(/([a-f0-9-]{36})/);
  return idMatch ? idMatch[1] : null;
}

function parseTaskMetadata(task) {
  if (!task || !task.metadata) return {};
  if (typeof task.metadata === 'object') return task.metadata;
  try {
    return JSON.parse(task.metadata);
  } catch {
    return {};
  }
}

/**
 * Helper: force a task into terminal state by directly updating the DB.
 * We can't actually run tasks in unit tests, so simulate completion.
 * Transitions through valid states: blocked→pending→running→terminal.
 */
function forceTaskComplete(db, taskId, status = 'completed', opts = {}) {
  const task = db.getTask(taskId);
  if (task) {
    if (task.status === 'blocked') {
      db.updateTaskStatus(taskId, 'pending');
    }
    const current = db.getTask(taskId);
    if (current && current.status === 'pending') {
      db.updateTaskStatus(taskId, 'running', { started_at: new Date().toISOString() });
    }
  }
  db.updateTaskStatus(taskId, status, {
    output: opts.output || 'task output here',
    error_output: opts.error_output || null,
    exit_code: status === 'completed' ? 0 : 1,
    completed_at: new Date().toISOString(),
    files_modified: opts.files_modified || null
  });
}

describe('await_workflow yield-on-completion', () => {
  let db;

  beforeAll(() => {
    const setup = setupTestDb('await-workflow-yield');
    db = setup.db;
    require('../task-manager').initSubModules();
  });
  afterAll(() => { teardownTestDb(); });

  describe('incremental yield', () => {
    let workflowId, taskIds;

    beforeAll(async () => {
      const wf = await createTestWorkflow(db, 'yield-test', [
        { node_id: 'step1', task: 'First step' },
        { node_id: 'step2', task: 'Second step', depends_on: ['step1'] }
      ]);
      workflowId = wf.workflowId;
      taskIds = wf.taskIds;

      // Start the workflow
      await safeTool('run_workflow', { workflow_id: workflowId });
    });

    it('yields on first task completion (not all)', async () => {
      // Complete step1 only
      forceTaskComplete(db, taskIds.step1);

      const result = await safeTool('await_workflow', {
        workflow_id: workflowId,
        timeout_minutes: 1,
        poll_interval_ms: 50
      });
      const text = getText(result);

      // Should yield step1 details, not final summary
      expect(text).toContain('## Task Completed: step1');
      expect(text).not.toContain('## Workflow Completed');
      expect(text).toContain('Workflow Progress');
      expect(result.isError).toBeFalsy();
    });

    it('skips already-acknowledged tasks on next call', async () => {
      // step1 is already acknowledged from previous test
      // Complete step2 now
      forceTaskComplete(db, taskIds.step2);

      const result = await safeTool('await_workflow', {
        workflow_id: workflowId,
        timeout_minutes: 1,
        poll_interval_ms: 50
      });
      const text = getText(result);

      // Should yield step2, not step1 again
      expect(text).toContain('step2');
      // This is the final task, so should include final summary
      expect(text).toContain('## Workflow Completed');
    });

    it('acknowledged_tasks persisted in workflow context', () => {
      const workflow = db.getWorkflow(workflowId);
      expect(workflow.context).toBeTruthy();
      expect(workflow.context.acknowledged_tasks).toBeInstanceOf(Array);
      expect(workflow.context.acknowledged_tasks).toContain(taskIds.step1);
      expect(workflow.context.acknowledged_tasks).toContain(taskIds.step2);
    });

    it('returns final summary when called after all acknowledged', async () => {
      // All tasks already completed + acknowledged — calling again should give final summary
      const result = await safeTool('await_workflow', {
        workflow_id: workflowId,
        timeout_minutes: 1,
        poll_interval_ms: 50
      });
      const text = getText(result);

      expect(text).toContain('## Workflow Completed');
      expect(text).toContain('yield-test');
    });
  });

  describe('failed task yield', () => {
    it('yields a failed task (not just completed)', async () => {
      const wf = await createTestWorkflow(db, 'fail-yield-test', [
        { node_id: 'will-fail', task: 'This will fail' }
      ]);

      await safeTool('run_workflow', { workflow_id: wf.workflowId });
      forceTaskComplete(db, wf.taskIds['will-fail'], 'failed', {
        error_output: 'something went wrong'
      });

      const result = await safeTool('await_workflow', {
        workflow_id: wf.workflowId,
        timeout_minutes: 1,
        poll_interval_ms: 50
      });
      const text = getText(result);

      expect(text).toContain('## Task Completed: will-fail');
      expect(text).toContain('failed');
      // Final summary included since it's the only task
      expect(text).toContain('## Workflow Completed');
    });
  });

  describe('per-task verify metadata', () => {
    it('persists verify controls from create_workflow task objects', async () => {
      const result = await safeTool('create_workflow', {
        name: `verify-metadata-create-${randomUUID()}`,
        tasks: [
          {
            node_id: 'database',
            task_description: 'Update database migrations',
            verify_command: 'npx vitest run server/tests/schema-*.test.js'
          },
          {
            node_id: 'skip',
            task_description: 'Refresh generated note',
            verify_skip: true
          }
        ]
      });

      expect(result.isError).toBeFalsy();
      const workflowId = extractUUID(getText(result));
      expect(workflowId).toBeTruthy();
      const tasks = db.getWorkflowTasks(workflowId);
      const databaseTask = tasks.find(task => task.workflow_node_id === 'database');
      const skipTask = tasks.find(task => task.workflow_node_id === 'skip');

      expect(databaseTask).toBeTruthy();
      expect(skipTask).toBeTruthy();
      expect(parseTaskMetadata(databaseTask).verify_command).toBe('npx vitest run server/tests/schema-*.test.js');
      expect(parseTaskMetadata(skipTask).verify_skip).toBe(true);
    });

    it('persists verify controls from add_workflow_task payloads', async () => {
      const wf = await createTestWorkflow(db, `verify-metadata-add-${randomUUID()}`, [
        {
          node_id: 'frontend',
          task: 'Update frontend workflow UI',
          verify_command: 'npx playwright test dashboard/tests/workflow-specs.spec.js'
        },
        {
          node_id: 'skip',
          task: 'Update generated docs index',
          verify_skip: true
        }
      ]);

      expect(parseTaskMetadata(db.getTask(wf.taskIds.frontend)).verify_command)
        .toBe('npx playwright test dashboard/tests/workflow-specs.spec.js');
      expect(parseTaskMetadata(db.getTask(wf.taskIds.skip)).verify_skip).toBe(true);
    });
  });

  describe('verify/commit only on final', () => {
    it('does not run verify on intermediate yields', async () => {
      const wf = await createTestWorkflow(db, 'verify-timing-test', [
        { node_id: 'a', task: 'Step A' },
        { node_id: 'b', task: 'Step B' }
      ]);

      await safeTool('run_workflow', { workflow_id: wf.workflowId });
      forceTaskComplete(db, wf.taskIds.a);

      const result = await safeTool('await_workflow', {
        workflow_id: wf.workflowId,
        timeout_minutes: 1,
        poll_interval_ms: 50,
        verify_command: 'echo verify-ran'
      });
      const text = getText(result);

      // Intermediate yield — should NOT contain verify output
      expect(text).toContain('## Task Completed: a');
      expect(text).not.toContain('Verification');
      expect(text).not.toContain('verify-ran');
    });
  });

  describe('timeout during yield polling', () => {
    // Timing-sensitive: CI runners are too slow for sub-second timeout detection
    it.skipIf(process.env.CI === 'true')('returns partial progress on timeout', async () => {
      const wf = await createTestWorkflow(db, 'timeout-yield-test', [
        { node_id: 'slow', task: 'Slow task' }
      ]);

      // Manually set workflow to running and task to running without triggering startTask.
      // Use 'running' status so the queue won't pick up the task or emit retry events.
      db.updateWorkflow(wf.workflowId, { status: 'running' });
      db.updateTaskStatus(wf.taskIds.slow, 'running', { started_at: new Date().toISOString() });
      // Don't complete the task — let await_workflow timeout

      const result = await safeTool('await_workflow', {
        workflow_id: wf.workflowId,
        timeout_minutes: 0.1,  // ~6 seconds — CI runners can be very slow
        poll_interval_ms: 200
      });
      const text = getText(result);

      expect(text).toContain('Timed Out');
      expect(text).toContain('0 / 1');
    });
  });

  describe('add_workflow_task to running workflow', () => {
    it('auto-starts task with no deps when workflow is running', async () => {
      const wf = await createTestWorkflow(db, 'live-add-no-deps', [
        { node_id: 'initial', task: 'Initial task' }
      ]);

      await safeTool('run_workflow', { workflow_id: wf.workflowId });

      // Add a new task with no dependencies to the running workflow
      const addResult = await safeTool('add_workflow_task', {
        workflow_id: wf.workflowId,
        node_id: 'added-live',
        task_description: 'Dynamically added task'
      });
      const text = getText(addResult);

      // Should NOT be blocked — should be pending, queued, or running
      expect(text).not.toContain('**Status:** blocked');
      expect(addResult.isError).toBeFalsy();
    });

    it('auto-starts task with completed deps when workflow is running', async () => {
      const wf = await createTestWorkflow(db, 'live-add-with-deps', [
        { node_id: 'dep1', task: 'Dependency 1' }
      ]);

      await safeTool('run_workflow', { workflow_id: wf.workflowId });

      // Complete the dependency
      forceTaskComplete(db, wf.taskIds.dep1);

      // Add a new task that depends on the already-completed dep1
      const addResult = await safeTool('add_workflow_task', {
        workflow_id: wf.workflowId,
        node_id: 'added-after-dep',
        task_description: 'Added after dep completed',
        depends_on: ['dep1']
      });
      const text = getText(addResult);

      // Should be unblocked since dep1 is already completed
      expect(text).not.toContain('**Status:** blocked');
      expect(addResult.isError).toBeFalsy();
    });

    it('stays blocked when added to pending workflow', async () => {
      // Create workflow but DON'T run it
      const wf = await createTestWorkflow(db, 'pending-add-test', [
        { node_id: 'first', task: 'First task' }
      ]);

      // Add a dependent task to the pending workflow
      const addResult = await safeTool('add_workflow_task', {
        workflow_id: wf.workflowId,
        node_id: 'second',
        task_description: 'Depends on first',
        depends_on: ['first']
      });
      const text = getText(addResult);

      // Should remain blocked since workflow isn't running
      expect(text).toContain('**Status:** blocked');
    });
  });
});
