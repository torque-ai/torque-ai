'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const { createForker } = require('../workflow-state/forker');
const { createCheckpointStore } = require('../workflow-state/checkpoint-store');
const { createWorkflowState } = require('../workflow-state/workflow-state');

describe('workflow-state/forker', () => {
  let db;
  let checkpointStore;
  let workflowState;
  let forker;

  beforeEach(() => {
    setupTestDbOnly('forker');
    db = rawDb();
    checkpointStore = createCheckpointStore({ db });
    workflowState = createWorkflowState({ db });
    forker = createForker({ db, checkpointStore, workflowState });

    const createdAt = '2026-04-23T00:00:00.000Z';
    db.prepare(`
      INSERT INTO workflows (id, name, status, created_at)
      VALUES (?, ?, ?, ?)
    `).run('wf-orig', 'orig', 'completed', createdAt);

    db.prepare(`
      INSERT INTO tasks (
        id,
        status,
        task_description,
        created_at,
        provider,
        workflow_id,
        workflow_node_id
      )
      VALUES
        ('t1', 'completed', 'plan', ?, 'codex', 'wf-orig', 'plan'),
        ('t2', 'completed', 'build', ?, 'codex', 'wf-orig', 'build'),
        ('t3', 'completed', 'verify', ?, 'codex', 'wf-orig', 'verify')
    `).run(createdAt, createdAt, createdAt);

    db.prepare(`
      INSERT INTO task_dependencies (
        workflow_id,
        task_id,
        depends_on_task_id,
        condition_expr,
        on_fail,
        alternate_task_id,
        created_at
      )
      VALUES
        ('wf-orig', 't2', 't1', NULL, 'skip', NULL, ?),
        ('wf-orig', 't3', 't2', NULL, 'skip', NULL, ?)
    `).run(createdAt, createdAt);

    workflowState.setStateSchema('wf-orig', null, { logs: 'append' });
    workflowState.applyPatch('wf-orig', { logs: ['plan done'] });
    checkpointStore.writeCheckpoint({
      workflowId: 'wf-orig',
      stepId: 'plan',
      taskId: 't1',
      state: { logs: ['plan done'] },
      version: 2,
    });
    workflowState.applyPatch('wf-orig', { logs: ['build done'] });
    checkpointStore.writeCheckpoint({
      workflowId: 'wf-orig',
      stepId: 'build',
      taskId: 't2',
      state: { logs: ['plan done', 'build done'] },
      version: 3,
    });
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('forks from a checkpoint with a new workflow id and seeded state', () => {
    const checkpoint = checkpointStore.listCheckpoints('wf-orig')[0];

    const result = forker.fork({
      checkpointId: checkpoint.checkpoint_id,
      name: 'forked-1',
    });

    expect(result.new_workflow_id).toMatch(/^wf_/);
    expect(result.new_workflow_id).not.toBe('wf-orig');
    expect(result.resumes_from_step).toBe('plan');
    expect(workflowState.getState(result.new_workflow_id)).toEqual({ logs: ['plan done'] });

    const forkedWorkflow = db.prepare(`
      SELECT name, status, parent_workflow_id, fork_checkpoint_id
      FROM workflows
      WHERE id = ?
    `).get(result.new_workflow_id);
    expect(forkedWorkflow).toEqual({
      name: 'forked-1',
      status: 'pending',
      parent_workflow_id: 'wf-orig',
      fork_checkpoint_id: checkpoint.checkpoint_id,
    });
  });

  it('clones steps after the fork point and preserves internal dependencies', () => {
    const checkpoint = checkpointStore.listCheckpoints('wf-orig')[0];

    const result = forker.fork({ checkpointId: checkpoint.checkpoint_id });

    const clonedTasks = db.prepare(`
      SELECT workflow_node_id, status
      FROM tasks
      WHERE workflow_id = ?
      ORDER BY workflow_node_id
    `).all(result.new_workflow_id);
    const clonedStepIds = clonedTasks.map((task) => task.workflow_node_id);

    expect(clonedStepIds).toContain('build');
    expect(clonedStepIds).toContain('verify');
    expect(clonedStepIds).not.toContain('plan');
    expect(clonedTasks.every((task) => task.status === 'pending')).toBe(true);

    const clonedDependencies = db.prepare(`
      SELECT
        child.workflow_node_id AS task_node_id,
        parent.workflow_node_id AS depends_on_node_id
      FROM task_dependencies dep
      JOIN tasks child ON child.id = dep.task_id
      JOIN tasks parent ON parent.id = dep.depends_on_task_id
      WHERE dep.workflow_id = ?
      ORDER BY child.workflow_node_id
    `).all(result.new_workflow_id);

    expect(clonedDependencies).toEqual([
      {
        task_node_id: 'verify',
        depends_on_node_id: 'build',
      },
    ]);
  });

  it('applies state overrides on fork', () => {
    const checkpoint = checkpointStore.listCheckpoints('wf-orig')[1];

    const result = forker.fork({
      checkpointId: checkpoint.checkpoint_id,
      state_overrides: { logs: ['rewritten'] },
    });

    expect(workflowState.getState(result.new_workflow_id)).toEqual({ logs: ['rewritten'] });
  });
});
