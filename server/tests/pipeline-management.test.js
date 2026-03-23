/**
 * Tests for server/db/pipeline-management.js
 *
 * Pipeline CRUD, step management, status transitions,
 * parallel steps, reconciliation.
 */

const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb, rawDb: _rawDb } = require('./vitest-setup');

let testDir;
let db;
let taskCore;
let mod;

function setup() {
  ({ db, testDir } = setupTestDb('pipeline-'));
  taskCore = require('../db/task-core');
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;

  mod = require('../db/project-config-core');
  mod.setDb(db.getDb ? db.getDb() : db.getDbInstance());
  mod.setRecordEvent(() => {}); // no-op for tests
}

function teardown() {
  teardownTestDb();
}

function rawDb() {
  return _rawDb();
}

function createTask(overrides = {}) {
  const payload = {
    id: randomUUID(),
    task_description: overrides.task_description || 'pipeline test task',
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    ...overrides,
  };
  taskCore.createTask(payload);
  return taskCore.getTask(payload.id);
}

function mkPipeline(overrides = {}) {
  return mod.createPipeline({
    id: randomUUID(),
    name: overrides.name || 'Test Pipeline',
    description: overrides.description || 'pipeline for testing',
    working_directory: overrides.working_directory || testDir,
    ...overrides,
  });
}

function resetState() {
  const conn = rawDb();
  for (const table of ['pipeline_steps', 'pipelines', 'tasks']) {
    try { conn.prepare(`DELETE FROM ${table}`).run(); } catch {}
  }
}

describe('pipeline-management module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetState(); });

  // ====================================================
  // Pipeline CRUD
  // ====================================================
  describe('createPipeline / getPipeline', () => {
    it('creates a pipeline with pending status', () => {
      const p = mkPipeline({ name: 'Build Pipeline' });
      expect(p).toBeTruthy();
      expect(p.name).toBe('Build Pipeline');
      expect(p.status).toBe('pending');
      expect(p.created_at).toBeTruthy();
    });

    it('getPipeline returns pipeline with steps array', () => {
      const p = mkPipeline();
      const fetched = mod.getPipeline(p.id);
      expect(fetched).toBeTruthy();
      expect(fetched.id).toBe(p.id);
      expect(Array.isArray(fetched.steps)).toBe(true);
      expect(fetched.steps).toHaveLength(0);
    });

    it('getPipeline returns undefined for non-existent id', () => {
      const result = mod.getPipeline('non-existent-pipeline-id');
      expect(result).toBeUndefined();
    });
  });

  describe('listPipelines', () => {
    it('lists all pipelines ordered by created_at desc', () => {
      // Use explicit timestamps to ensure deterministic ordering
      const conn = rawDb();
      const id1 = randomUUID();
      const id2 = randomUUID();
      conn.prepare('INSERT INTO pipelines (id, name, status, created_at) VALUES (?, ?, ?, ?)').run(
        id1, 'First', 'pending', '2025-01-01T00:00:00Z'
      );
      conn.prepare('INSERT INTO pipelines (id, name, status, created_at) VALUES (?, ?, ?, ?)').run(
        id2, 'Second', 'pending', '2025-01-02T00:00:00Z'
      );

      const list = mod.listPipelines();
      expect(list.length).toBe(2);
      // Most recent first
      expect(list[0].name).toBe('Second');
      expect(list[1].name).toBe('First');
    });

    it('filters by status', () => {
      const _p1 = mkPipeline({ name: 'Pending' });
      const p2 = mkPipeline({ name: 'Running' });
      mod.updatePipelineStatus(p2.id, 'running');

      const pending = mod.listPipelines({ status: 'pending' });
      const running = mod.listPipelines({ status: 'running' });

      expect(pending.length).toBe(1);
      expect(pending[0].name).toBe('Pending');
      expect(running.length).toBe(1);
      expect(running[0].name).toBe('Running');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        mkPipeline({ name: `Pipeline ${i}` });
      }
      const list = mod.listPipelines({ limit: 3 });
      expect(list.length).toBe(3);
    });

    it('batch-fetches steps for all pipelines', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 'step1', task_template: 'echo 1' });

      const list = mod.listPipelines();
      expect(list[0].steps).toBeTruthy();
      expect(list[0].steps.length).toBe(1);
    });

    it('returns empty array for empty result', () => {
      const list = mod.listPipelines({ status: 'nonexistent' });
      expect(list).toEqual([]);
    });
  });

  // ====================================================
  // Pipeline steps
  // ====================================================
  describe('addPipelineStep / getPipelineSteps', () => {
    it('adds step with auto-incrementing step_order', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 'build', task_template: 'npm run build' });
      mod.addPipelineStep({ pipeline_id: p.id, name: 'test', task_template: 'npm test' });

      const steps = mod.getPipelineSteps(p.id);
      expect(steps.length).toBe(2);
      expect(steps[0].name).toBe('build');
      expect(steps[0].step_order).toBe(1);
      expect(steps[1].name).toBe('test');
      expect(steps[1].step_order).toBe(2);
    });

    it('respects explicit step_order', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 'late', task_template: 'task', step_order: 10 });

      const steps = mod.getPipelineSteps(p.id);
      expect(steps[0].step_order).toBe(10);
    });

    it('returns updated steps array after adding', () => {
      const p = mkPipeline();
      const result = mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
    });

    it('defaults status to pending and timeout to 30', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      const step = mod.getPipelineSteps(p.id)[0];
      expect(step.status).toBe('pending');
      expect(step.timeout_minutes).toBe(30);
    });
  });

  describe('updatePipelineStep', () => {
    it('updates step status and output_vars', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      const step = mod.getPipelineSteps(p.id)[0];

      mod.updatePipelineStep(step.id, { status: 'completed', output_vars: { artifact: 'dist.zip' } });

      const updated = mod.getPipelineSteps(p.id)[0];
      expect(updated.status).toBe('completed');
      expect(updated.output_vars).toEqual({ artifact: 'dist.zip' });
    });

    it('updates task_id for a step', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      const step = mod.getPipelineSteps(p.id)[0];
      const task = createTask();

      mod.updatePipelineStep(step.id, { task_id: task.id });

      const updated = mod.getPipelineSteps(p.id)[0];
      expect(updated.task_id).toBe(task.id);
    });
  });

  // ====================================================
  // Pipeline status
  // ====================================================
  describe('updatePipelineStatus', () => {
    it('sets started_at when transitioning to running', () => {
      const p = mkPipeline();
      const running = mod.updatePipelineStatus(p.id, 'running');
      expect(running.status).toBe('running');
      expect(running.started_at).toBeTruthy();
    });

    it('sets completed_at when transitioning to completed', () => {
      const p = mkPipeline();
      const completed = mod.updatePipelineStatus(p.id, 'completed');
      expect(completed.completed_at).toBeTruthy();
    });

    it('sets completed_at and error when failing', () => {
      const p = mkPipeline();
      const failed = mod.updatePipelineStatus(p.id, 'failed', { error: 'Step 3 timed out' });
      expect(failed.status).toBe('failed');
      expect(failed.completed_at).toBeTruthy();
      expect(failed.error).toBe('Step 3 timed out');
    });

    it('sets completed_at when cancelled', () => {
      const p = mkPipeline();
      const cancelled = mod.updatePipelineStatus(p.id, 'cancelled');
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.completed_at).toBeTruthy();
    });

    it('supports additional fields', () => {
      const p = mkPipeline();
      const updated = mod.updatePipelineStatus(p.id, 'running', { current_step: 3 });
      expect(updated.current_step).toBe(3);
    });
  });

  // ====================================================
  // Transition step status (atomic)
  // ====================================================
  describe('transitionPipelineStepStatus', () => {
    it('succeeds when current status matches fromStatus', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      const step = mod.getPipelineSteps(p.id)[0];

      const ok = mod.transitionPipelineStepStatus(step.id, 'pending', 'running');
      expect(ok).toBe(true);

      const updated = mod.getPipelineSteps(p.id)[0];
      expect(updated.status).toBe('running');
    });

    it('fails when current status does not match fromStatus', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      const step = mod.getPipelineSteps(p.id)[0];

      const ok = mod.transitionPipelineStepStatus(step.id, 'completed', 'running');
      expect(ok).toBe(false);
    });

    it('accepts array of valid fromStatuses', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      const step = mod.getPipelineSteps(p.id)[0];

      const ok = mod.transitionPipelineStepStatus(step.id, ['queued', 'pending'], 'running');
      expect(ok).toBe(true);
    });

    it('applies additional updates when transitioning', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      const step = mod.getPipelineSteps(p.id)[0];
      const task = createTask();

      const ok = mod.transitionPipelineStepStatus(step.id, 'pending', 'running', { task_id: task.id });
      expect(ok).toBe(true);

      const updated = mod.getPipelineSteps(p.id)[0];
      expect(updated.task_id).toBe(task.id);
    });

    it('handles output_vars in additional updates', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      const step = mod.getPipelineSteps(p.id)[0];

      const ok = mod.transitionPipelineStepStatus(step.id, 'pending', 'completed', {
        output_vars: { result: 'success' }
      });
      expect(ok).toBe(true);
    });
  });

  // ====================================================
  // Navigation: next step(s)
  // ====================================================
  describe('getNextPipelineStep', () => {
    it('returns the first pending step', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task1' });
      mod.addPipelineStep({ pipeline_id: p.id, name: 's2', task_template: 'task2' });

      const next = mod.getNextPipelineStep(p.id);
      expect(next).toBeTruthy();
      expect(next.name).toBe('s1');
    });

    it('skips completed steps', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task1' });
      mod.addPipelineStep({ pipeline_id: p.id, name: 's2', task_template: 'task2' });

      const steps = mod.getPipelineSteps(p.id);
      mod.updatePipelineStep(steps[0].id, { status: 'completed' });

      const next = mod.getNextPipelineStep(p.id);
      expect(next.name).toBe('s2');
    });

    it('returns undefined when all steps are done', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });

      const steps = mod.getPipelineSteps(p.id);
      mod.updatePipelineStep(steps[0].id, { status: 'completed' });

      const next = mod.getNextPipelineStep(p.id);
      expect(next).toBeUndefined();
    });
  });

  describe('getNextPipelineSteps', () => {
    it('returns single sequential step', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });

      const next = mod.getNextPipelineSteps(p.id);
      expect(next.length).toBe(1);
      expect(next[0].name).toBe('s1');
    });

    it('returns all pending steps in same parallel group', () => {
      const p = mkPipeline();
      mod.addParallelPipelineStep({ pipeline_id: p.id, name: 'a', task_template: 'A', parallel_group: 'grp1' });
      mod.addParallelPipelineStep({ pipeline_id: p.id, name: 'b', task_template: 'B', parallel_group: 'grp1' });
      mod.addPipelineStep({ pipeline_id: p.id, name: 'c', task_template: 'C' });

      const next = mod.getNextPipelineSteps(p.id);
      expect(next.length).toBe(2);
      expect(next.map(s => s.name).sort()).toEqual(['a', 'b']);
    });

    it('returns empty when no pending steps', () => {
      const p = mkPipeline();
      expect(mod.getNextPipelineSteps(p.id)).toEqual([]);
    });
  });

  // ====================================================
  // Parallel steps
  // ====================================================
  describe('addParallelPipelineStep / getParallelGroupSteps / isParallelGroupComplete', () => {
    it('adds step with parallel_group and default on_success condition', () => {
      const p = mkPipeline();
      mod.addParallelPipelineStep({
        pipeline_id: p.id,
        name: 'par-a',
        task_template: 'task A',
        parallel_group: 'grp1',
      });

      const steps = mod.getPipelineSteps(p.id);
      expect(steps.length).toBe(1);
      expect(steps[0].parallel_group).toBe('grp1');
      expect(steps[0].condition).toBe('on_success');
    });

    it('getParallelGroupSteps returns steps in group', () => {
      const p = mkPipeline();
      mod.addParallelPipelineStep({ pipeline_id: p.id, name: 'a', task_template: 'A', parallel_group: 'grp1' });
      mod.addParallelPipelineStep({ pipeline_id: p.id, name: 'b', task_template: 'B', parallel_group: 'grp1' });
      mod.addPipelineStep({ pipeline_id: p.id, name: 'c', task_template: 'C' });

      const groupSteps = mod.getParallelGroupSteps(p.id, 'grp1');
      expect(groupSteps.length).toBe(2);
      expect(groupSteps.map(s => s.name).sort()).toEqual(['a', 'b']);
    });

    it('isParallelGroupComplete returns false when steps are pending', () => {
      const p = mkPipeline();
      mod.addParallelPipelineStep({ pipeline_id: p.id, name: 'a', task_template: 'A', parallel_group: 'grp1' });
      mod.addParallelPipelineStep({ pipeline_id: p.id, name: 'b', task_template: 'B', parallel_group: 'grp1' });

      expect(mod.isParallelGroupComplete(p.id, 'grp1')).toBe(false);
    });

    it('isParallelGroupComplete returns true when all steps are terminal', () => {
      const p = mkPipeline();
      mod.addParallelPipelineStep({ pipeline_id: p.id, name: 'a', task_template: 'A', parallel_group: 'grp1' });
      mod.addParallelPipelineStep({ pipeline_id: p.id, name: 'b', task_template: 'B', parallel_group: 'grp1' });

      const steps = mod.getPipelineSteps(p.id);
      mod.updatePipelineStep(steps[0].id, { status: 'completed' });
      mod.updatePipelineStep(steps[1].id, { status: 'failed' });

      expect(mod.isParallelGroupComplete(p.id, 'grp1')).toBe(true);
    });

    it('isParallelGroupComplete considers skipped as terminal', () => {
      const p = mkPipeline();
      mod.addParallelPipelineStep({ pipeline_id: p.id, name: 'a', task_template: 'A', parallel_group: 'grp2' });

      const steps = mod.getPipelineSteps(p.id);
      mod.updatePipelineStep(steps[0].id, { status: 'skipped' });

      expect(mod.isParallelGroupComplete(p.id, 'grp2')).toBe(true);
    });
  });

  // ====================================================
  // Reconciliation
  // ====================================================
  describe('reconcilePipelineStepStatus', () => {
    it('fixes stuck running steps when task is completed', () => {
      const p = mkPipeline();
      mod.updatePipelineStatus(p.id, 'running');
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });

      const step = mod.getPipelineSteps(p.id)[0];
      const task = createTask({ status: 'completed' });
      mod.updatePipelineStep(step.id, { status: 'running', task_id: task.id });

      const result = mod.reconcilePipelineStepStatus();
      expect(result.stepsFixed).toBe(1);

      const updated = mod.getPipelineSteps(p.id)[0];
      expect(updated.status).toBe('completed');
    });

    it('fixes stuck running steps when task is cancelled', () => {
      const p = mkPipeline();
      mod.updatePipelineStatus(p.id, 'running');
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });

      const step = mod.getPipelineSteps(p.id)[0];
      const task = createTask({ status: 'cancelled' });
      mod.updatePipelineStep(step.id, { status: 'running', task_id: task.id });

      const result = mod.reconcilePipelineStepStatus();
      expect(result.stepsFixed).toBe(1);

      const updated = mod.getPipelineSteps(p.id)[0];
      expect(updated.status).toBe('failed');
    });

    it('marks pipeline as failed when step fails', () => {
      const p = mkPipeline();
      mod.updatePipelineStatus(p.id, 'running');
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });

      const step = mod.getPipelineSteps(p.id)[0];
      const task = createTask({ status: 'failed' });
      rawDb().prepare("UPDATE tasks SET error_output = 'build failed' WHERE id = ?").run(task.id);
      mod.updatePipelineStep(step.id, { status: 'running', task_id: task.id });

      const result = mod.reconcilePipelineStepStatus();
      expect(result.pipelinesFailed).toBe(1);

      const pipelineAfter = mod.getPipeline(p.id);
      expect(pipelineAfter.status).toBe('failed');
      expect(pipelineAfter.error).toBeTruthy();
    });

    it('returns zero counts when nothing to reconcile', () => {
      const result = mod.reconcilePipelineStepStatus();
      expect(result.stepsFixed).toBe(0);
      expect(result.pipelinesFailed).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it('does not affect steps that are not stuck', () => {
      const p = mkPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      // Step is pending, no task_id — should not be affected
      const result = mod.reconcilePipelineStepStatus();
      expect(result.stepsFixed).toBe(0);

      const step = mod.getPipelineSteps(p.id)[0];
      expect(step.status).toBe('pending');
    });
  });
});
