/**
 * Workflow Engine Module Tests
 *
 * Unit tests for db/workflow-engine.js — workflow CRUD, dependency graph,
 * cycle detection, task queries, status, history, and templates.
 */

const { v4: uuidv4 } = require('uuid');
const workflowEngine = require('../db/workflow-engine');
const taskCore = require('../db/task-core');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');

let db;

function setupDb() {
  ({ db } = setupTestDbOnly('workflow'));
  return db;
}

function teardownDb() {
  teardownTestDb();
}

function createWorkflow(overrides = {}) {
  const id = overrides.id || `wf-${uuidv4()}`;
  return workflowEngine.createWorkflow({
    id,
    name: 'Test Workflow',
    description: 'test',
    ...overrides,
  });
}

function createTask(overrides = {}) {
  const id = overrides.id || uuidv4();
  taskCore.createTask({
    id,
    task_description: 'test task',
    provider: 'codex',
    status: 'pending',
    ...overrides,
  });
  return id;
}

describe('Workflow Engine Module', () => {
  beforeAll(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  // ── Workflow CRUD ──────────────────────────────────────────

  describe('createWorkflow', () => {
    it('creates and returns a workflow', () => {
      const wf = createWorkflow({ name: 'CRUD Test' });

      expect(wf).toBeDefined();
      expect(wf.name).toBe('CRUD Test');
      expect(wf.status).toBe('pending');
      expect(wf.created_at).toBeDefined();
    });

    it('persists workflow priority', () => {
      const wf = createWorkflow({
        name: 'Priority Test',
        priority: 7,
      });

      expect(wf.priority).toBe(7);
      expect(workflowEngine.getWorkflow(wf.id).priority).toBe(7);
    });

    it('stores context as JSON', () => {
      const wf = createWorkflow({
        name: 'Context Test',
        context: { feature: 'auth', step: 1 },
      });

      expect(wf.context).toEqual({ feature: 'auth', step: 1 });
    });
  });

  describe('getWorkflow', () => {
    it('returns null for nonexistent workflow', () => {
      const result = workflowEngine.getWorkflow('nonexistent-wf');
      expect(result).toBeUndefined();
    });

    it('parses context JSON', () => {
      const wf = createWorkflow({ context: { key: 'value' } });
      const fetched = workflowEngine.getWorkflow(wf.id);

      expect(fetched.context).toEqual({ key: 'value' });
    });
  });

  describe('updateWorkflow', () => {
    it('updates name and description', () => {
      const wf = createWorkflow();
      const updated = workflowEngine.updateWorkflow(wf.id, {
        name: 'Updated Name',
        description: 'Updated desc',
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.description).toBe('Updated desc');
    });

    it('updates status', () => {
      const wf = createWorkflow();
      const updated = workflowEngine.updateWorkflow(wf.id, { status: 'running' });

      expect(updated.status).toBe('running');
    });

    it('updates priority', () => {
      const wf = createWorkflow();
      const updated = workflowEngine.updateWorkflow(wf.id, { priority: 11 });

      expect(updated.priority).toBe(11);
      expect(workflowEngine.getWorkflow(wf.id).priority).toBe(11);
    });

    it('updates task counts', () => {
      const wf = createWorkflow();
      const updated = workflowEngine.updateWorkflow(wf.id, {
        total_tasks: 6,
        completed_tasks: 3,
        failed_tasks: 1,
      });

      expect(updated.total_tasks).toBe(6);
      expect(updated.completed_tasks).toBe(3);
      expect(updated.failed_tasks).toBe(1);
    });

    it('returns unchanged workflow when no updates provided', () => {
      const wf = createWorkflow({ name: 'No Change' });
      const result = workflowEngine.updateWorkflow(wf.id, {});

      expect(result.name).toBe('No Change');
    });
  });

  describe('transitionWorkflowStatus', () => {
    it('transitions from expected status', () => {
      const wf = createWorkflow();
      const result = workflowEngine.transitionWorkflowStatus(wf.id, 'pending', 'running');

      expect(result).toBe(true);
      expect(workflowEngine.getWorkflow(wf.id).status).toBe('running');
    });

    it('fails when current status does not match', () => {
      const wf = createWorkflow();
      const result = workflowEngine.transitionWorkflowStatus(wf.id, 'running', 'completed');

      expect(result).toBe(false);
      expect(workflowEngine.getWorkflow(wf.id).status).toBe('pending');
    });

    it('accepts array of valid from-statuses', () => {
      const wf = createWorkflow();
      const result = workflowEngine.transitionWorkflowStatus(wf.id, ['pending', 'paused'], 'running');

      expect(result).toBe(true);
    });

    it('applies additional updates on transition', () => {
      const wf = createWorkflow();
      const now = new Date().toISOString();
      workflowEngine.transitionWorkflowStatus(wf.id, 'pending', 'completed', {
        completed_at: now,
      });

      const updated = workflowEngine.getWorkflow(wf.id);
      expect(updated.status).toBe('completed');
      expect(updated.completed_at).toBe(now);
    });
  });

  describe('listWorkflows', () => {
    it('returns all workflows', () => {
      const list = workflowEngine.listWorkflows();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by status', () => {
      createWorkflow({ id: `wf-list-pending-${Date.now()}` });
      const list = workflowEngine.listWorkflows({ status: 'pending' });

      expect(list.every(w => w.status === 'pending')).toBe(true);
    });

    it('respects limit', () => {
      const list = workflowEngine.listWorkflows({ limit: 2 });
      expect(list.length).toBeLessThanOrEqual(2);
    });

    it('filters by since date', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const list = workflowEngine.listWorkflows({ since: future });

      expect(list).toHaveLength(0);
    });

    it('orders by created_at desc', () => {
      const list = workflowEngine.listWorkflows();
      for (let i = 1; i < list.length; i++) {
        expect(new Date(list[i - 1].created_at).getTime())
          .toBeGreaterThanOrEqual(new Date(list[i].created_at).getTime());
      }
    });
  });

  describe('deleteWorkflow', () => {
    it('deletes a workflow and its dependencies', () => {
      const wf = createWorkflow({ id: `wf-del-${Date.now()}` });
      const result = workflowEngine.deleteWorkflow(wf.id);

      expect(result).toBe(true);
      expect(workflowEngine.getWorkflow(wf.id)).toBeUndefined();
    });

    it('returns false for nonexistent workflow', () => {
      const result = workflowEngine.deleteWorkflow('nonexistent');
      expect(result).toBe(false);
    });
  });

  // ── Dependency Graph ──────────────────────────────────────

  describe('addTaskDependency', () => {
    it('adds a dependency between tasks', () => {
      const wf = createWorkflow({ id: `wf-dep-${Date.now()}` });
      const task1 = createTask({ workflow_id: wf.id });
      const task2 = createTask({ workflow_id: wf.id });

      const depId = workflowEngine.addTaskDependency({
        workflow_id: wf.id,
        task_id: task2,
        depends_on_task_id: task1,
      });

      expect(depId).toBeDefined();
    });

    it('throws on self-dependency', () => {
      const wf = createWorkflow({ id: `wf-self-${Date.now()}` });
      const task1 = createTask({ workflow_id: wf.id });

      expect(() => {
        workflowEngine.addTaskDependency({
          workflow_id: wf.id,
          task_id: task1,
          depends_on_task_id: task1,
        });
      }).toThrow(/circular/i);
    });

    it('throws on circular dependency', () => {
      const wf = createWorkflow({ id: `wf-cycle-${Date.now()}` });
      const task1 = createTask({ workflow_id: wf.id });
      const task2 = createTask({ workflow_id: wf.id });
      const task3 = createTask({ workflow_id: wf.id });

      // A -> B -> C
      workflowEngine.addTaskDependency({ workflow_id: wf.id, task_id: task2, depends_on_task_id: task1 });
      workflowEngine.addTaskDependency({ workflow_id: wf.id, task_id: task3, depends_on_task_id: task2 });

      // C -> A would create a cycle
      expect(() => {
        workflowEngine.addTaskDependency({ workflow_id: wf.id, task_id: task1, depends_on_task_id: task3 });
      }).toThrow(/circular/i);
    });
  });

  describe('getTaskDependencies', () => {
    it('returns dependencies with status info', () => {
      const wf = createWorkflow({ id: `wf-getdep-${Date.now()}` });
      const task1 = createTask({ workflow_id: wf.id, status: 'completed' });
      const task2 = createTask({ workflow_id: wf.id });

      workflowEngine.addTaskDependency({ workflow_id: wf.id, task_id: task2, depends_on_task_id: task1 });

      const deps = workflowEngine.getTaskDependencies(task2);
      expect(deps).toHaveLength(1);
      expect(deps[0].depends_on_task_id).toBe(task1);
      expect(deps[0].depends_on_status).toBe('completed');
    });
  });

  describe('getTaskDependents', () => {
    it('returns tasks that depend on a given task', () => {
      const wf = createWorkflow({ id: `wf-dependents-${Date.now()}` });
      const task1 = createTask({ workflow_id: wf.id });
      const task2 = createTask({ workflow_id: wf.id });
      const task3 = createTask({ workflow_id: wf.id });

      workflowEngine.addTaskDependency({ workflow_id: wf.id, task_id: task2, depends_on_task_id: task1 });
      workflowEngine.addTaskDependency({ workflow_id: wf.id, task_id: task3, depends_on_task_id: task1 });

      const dependents = workflowEngine.getTaskDependents(task1);
      expect(dependents).toHaveLength(2);
    });
  });

  describe('getWorkflowDependencies', () => {
    it('returns all dependencies in a workflow', () => {
      const wf = createWorkflow({ id: `wf-alldep-${Date.now()}` });
      const task1 = createTask({ workflow_id: wf.id });
      const task2 = createTask({ workflow_id: wf.id });

      workflowEngine.addTaskDependency({ workflow_id: wf.id, task_id: task2, depends_on_task_id: task1 });

      const allDeps = workflowEngine.getWorkflowDependencies(wf.id);
      expect(allDeps.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Workflow Task Queries ──────────────────────────────────

  describe('getWorkflowTasks', () => {
    it('returns tasks in a workflow', () => {
      const wf = createWorkflow({ id: `wf-tasks-${Date.now()}` });
      createTask({ workflow_id: wf.id, task_description: 'task A' });
      createTask({ workflow_id: wf.id, task_description: 'task B' });

      const tasks = workflowEngine.getWorkflowTasks(wf.id);
      expect(tasks).toHaveLength(2);
    });

    it('returns empty array for workflow with no tasks', () => {
      const wf = createWorkflow({ id: `wf-empty-${Date.now()}` });
      const tasks = workflowEngine.getWorkflowTasks(wf.id);
      expect(tasks).toEqual([]);
    });
  });

  // ── Workflow Status ──────────────────────────────────────

  describe('getWorkflowStatus', () => {
    it('returns null for nonexistent workflow', () => {
      const result = workflowEngine.getWorkflowStatus('nonexistent');
      expect(result).toBeNull();
    });

    it('returns workflow with tasks, dependencies, and summary', () => {
      const wf = createWorkflow({ id: `wf-status-${Date.now()}` });
      const task1 = createTask({ workflow_id: wf.id, status: 'completed' });
      const task2 = createTask({ workflow_id: wf.id, status: 'failed' });
      const _task3 = createTask({ workflow_id: wf.id, status: 'pending' });

      workflowEngine.addTaskDependency({ workflow_id: wf.id, task_id: task2, depends_on_task_id: task1 });

      const status = workflowEngine.getWorkflowStatus(wf.id);

      expect(status.name).toBe('Test Workflow');
      expect(status.tasks).toBeDefined();
      expect(Object.keys(status.tasks)).toHaveLength(3);
      expect(status.dependencies).toHaveLength(1);
      expect(status.summary.total).toBe(3);
      expect(status.summary.completed).toBe(1);
      expect(status.summary.failed).toBe(1);
      expect(status.summary.pending).toBe(1);
    });
  });

  // ── Workflow History ──────────────────────────────────────

  describe('getWorkflowHistory', () => {
    it('returns empty array for workflow with no tasks', () => {
      const wf = createWorkflow({ id: `wf-hist-empty-${Date.now()}` });
      const history = workflowEngine.getWorkflowHistory(wf.id);
      expect(history).toEqual([]);
    });

    it('returns timeline events for completed tasks', () => {
      const wf = createWorkflow({ id: `wf-hist-${Date.now()}` });
      const taskId = createTask({ workflow_id: wf.id });

      // Transition through running to completed to set both timestamps
      taskCore.updateTaskStatus(taskId, 'running');
      taskCore.updateTaskStatus(taskId, 'completed');

      const history = workflowEngine.getWorkflowHistory(wf.id);

      // Should have created, started, and completed events
      expect(history.length).toBeGreaterThanOrEqual(3);
      const types = history.map(e => e.type);
      expect(types).toContain('task_created');
      expect(types).toContain('task_started');
      expect(types).toContain('task_completed');

      // Verify all events have timestamps
      for (const event of history) {
        expect(event.timestamp).toBeDefined();
        expect(event.task_id).toBe(taskId);
      }
    });

    it('marks failed tasks correctly', () => {
      const wf = createWorkflow({ id: `wf-hist-fail-${Date.now()}` });
      const taskId = createTask({ workflow_id: wf.id });

      taskCore.updateTaskStatus(taskId, 'failed', {
        started_at: new Date().toISOString(),
      });

      const history = workflowEngine.getWorkflowHistory(wf.id);
      const failEvent = history.find(e => e.type === 'task_failed');
      expect(failEvent).toBeDefined();
    });
  });

  describe('cleanupDormantPendingWorkflows', () => {
    it('cancels only old pending workflows whose tasks never started', () => {
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const dormant = createWorkflow({ id: `wf-dormant-${uuidv4()}`, name: 'Dormant Pending' });
      const active = createWorkflow({ id: `wf-active-${uuidv4()}`, name: 'Active Pending' });
      const partial = createWorkflow({ id: `wf-partial-${uuidv4()}`, name: 'Partial Pending' });
      const paused = createWorkflow({ id: `wf-paused-${uuidv4()}`, name: 'Paused Workflow', status: 'paused' });
      const fresh = createWorkflow({ id: `wf-fresh-${uuidv4()}`, name: 'Fresh Pending' });
      rawDb().prepare('UPDATE workflows SET created_at = ? WHERE id IN (?, ?, ?, ?)')
        .run(old, dormant.id, active.id, partial.id, paused.id);

      const dormantPending = createTask({ id: `task-dormant-pending-${uuidv4()}`, workflow_id: dormant.id, status: 'pending' });
      const dormantBlocked = createTask({ id: `task-dormant-blocked-${uuidv4()}`, workflow_id: dormant.id, status: 'blocked' });
      const activeQueued = createTask({ id: `task-active-queued-${uuidv4()}`, workflow_id: active.id, status: 'queued' });
      const partialDone = createTask({ id: `task-partial-done-${uuidv4()}`, workflow_id: partial.id, status: 'completed' });
      const partialPending = createTask({ id: `task-partial-pending-${uuidv4()}`, workflow_id: partial.id, status: 'pending' });
      const pausedPending = createTask({ id: `task-paused-pending-${uuidv4()}`, workflow_id: paused.id, status: 'pending' });
      const freshPending = createTask({ id: `task-fresh-pending-${uuidv4()}`, workflow_id: fresh.id, status: 'pending' });

      const result = workflowEngine.cleanupDormantPendingWorkflows(60);

      expect(result).toMatchObject({
        workflows_cancelled: 1,
        tasks_cancelled: 2,
        workflow_ids: [dormant.id],
      });
      expect(workflowEngine.getWorkflow(dormant.id)).toMatchObject({
        status: 'cancelled',
      });
      expect(taskCore.getTask(dormantPending)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'stale_pending_workflow',
      });
      expect(taskCore.getTask(dormantBlocked)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'stale_pending_workflow',
      });
      expect(taskCore.getTask(dormantBlocked).error_output).toContain('pending for more than 60 minutes');
      expect(workflowEngine.getWorkflow(active.id)).toMatchObject({ status: 'pending' });
      expect(taskCore.getTask(activeQueued)).toMatchObject({ status: 'queued' });
      expect(workflowEngine.getWorkflow(partial.id)).toMatchObject({ status: 'pending' });
      expect(taskCore.getTask(partialDone)).toMatchObject({ status: 'completed' });
      expect(taskCore.getTask(partialPending)).toMatchObject({ status: 'pending' });
      expect(workflowEngine.getWorkflow(paused.id)).toMatchObject({ status: 'paused' });
      expect(taskCore.getTask(pausedPending)).toMatchObject({ status: 'pending' });
      expect(workflowEngine.getWorkflow(fresh.id)).toMatchObject({ status: 'pending' });
      expect(taskCore.getTask(freshPending)).toMatchObject({ status: 'pending' });
    });

    it('can be disabled with a nonpositive age', () => {
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const workflow = createWorkflow({ id: `wf-disabled-dormant-${uuidv4()}`, name: 'Disabled Dormant' });
      rawDb().prepare('UPDATE workflows SET created_at = ? WHERE id = ?').run(old, workflow.id);
      const taskId = createTask({ id: `task-disabled-dormant-${uuidv4()}`, workflow_id: workflow.id, status: 'pending' });

      const result = workflowEngine.cleanupDormantPendingWorkflows(0);

      expect(result).toMatchObject({
        workflows_cancelled: 0,
        tasks_cancelled: 0,
        skipped_reason: 'disabled',
      });
      expect(workflowEngine.getWorkflow(workflow.id)).toMatchObject({ status: 'pending' });
      expect(taskCore.getTask(taskId)).toMatchObject({ status: 'pending' });
    });
  });

  // ── Workflow Templates ──────────────────────────────────

  describe('Workflow Templates', () => {
    it('creates and retrieves a template', () => {
      const id = `tmpl-${Date.now()}`;
      workflowEngine.createWorkflowTemplate({
        id,
        name: 'Feature Template',
        description: 'Standard feature workflow',
        task_definitions: [{ node_id: 'types', task: 'Create types' }],
        dependency_graph: { events: ['types'] },
      });

      const tmpl = workflowEngine.getWorkflowTemplate(id);
      expect(tmpl.name).toBe('Feature Template');
      expect(tmpl.task_definitions).toHaveLength(1);
      expect(tmpl.dependency_graph).toEqual({ events: ['types'] });
    });

    it('lists templates', () => {
      const templates = workflowEngine.listWorkflowTemplates();
      expect(Array.isArray(templates)).toBe(true);
    });

    it('escapes LIKE metacharacters when filtering template names', () => {
      const id = Date.now();
      const literalId = `tmpl-like-literal-${id}`;
      const wildcardId = `tmpl-like-wildcard-${id}`;

      workflowEngine.createWorkflowTemplate({
        id: literalId,
        name: `Template ${id} %_ literal`,
        task_definitions: [],
        dependency_graph: {},
      });
      workflowEngine.createWorkflowTemplate({
        id: wildcardId,
        name: `Template ${id} ab literal`,
        task_definitions: [],
        dependency_graph: {},
      });

      const templates = workflowEngine.listWorkflowTemplates({ filter: `${id} %_` });

      expect(templates.map(t => t.id)).toEqual([literalId]);
    });

    it('finds template by name', () => {
      const id = `tmpl-name-${Date.now()}`;
      workflowEngine.createWorkflowTemplate({
        id,
        name: `Unique Name ${id}`,
        task_definitions: [],
        dependency_graph: {},
      });

      const tmpl = workflowEngine.getWorkflowTemplateByName(`Unique Name ${id}`);
      expect(tmpl).toBeDefined();
      expect(tmpl.id).toBe(id);
    });

    it('deletes a template', () => {
      const id = `tmpl-del-${Date.now()}`;
      workflowEngine.createWorkflowTemplate({
        id,
        name: 'Delete Me',
        task_definitions: [],
        dependency_graph: {},
      });

      const result = workflowEngine.deleteWorkflowTemplate(id);
      expect(result).toBe(true);
      expect(workflowEngine.getWorkflowTemplate(id)).toBeUndefined();
    });
  });
});
