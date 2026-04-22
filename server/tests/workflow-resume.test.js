'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db;
let rawDb;

beforeAll(() => {
  db = setupTestDb('wf-resume').db;
  rawDb = db.getDbInstance();
});

afterAll(() => teardownTestDb());

function setupWorkflow({ status = 'running', taskStates }) {
  const wfId = randomUUID();
  rawDb.prepare(`
    INSERT INTO workflows (id, name, status, created_at)
    VALUES (?, ?, ?, ?)
  `).run(wfId, 'wf', status, new Date().toISOString());

  const taskIds = {};
  for (const [nodeId, state] of Object.entries(taskStates)) {
    const id = randomUUID();
    taskIds[nodeId] = id;
    db.createTask({
      id,
      task_description: nodeId,
      working_directory: null,
      status: state.status || 'pending',
      workflow_id: wfId,
      workflow_node_id: nodeId,
      provider: 'codex',
    });

    if (state.depends_on) {
      for (const depNodeId of state.depends_on) {
        db.addTaskDependency({
          workflow_id: wfId,
          task_id: id,
          depends_on_task_id: taskIds[depNodeId],
        });
      }
    }
  }
  return { wfId, taskIds };
}

describe('resumeWorkflow', () => {
  it('unblocks tasks whose dependencies are now complete', () => {
    const { wfId, taskIds } = setupWorkflow({
      taskStates: {
        a: { status: 'completed' },
        b: { status: 'blocked', depends_on: ['a'] },
      },
    });

    const { resumeWorkflow } = require('../execution/workflow-resume');
    const result = resumeWorkflow(wfId);

    expect(result.unblocked).toBe(1);
    const b = db.getTask(taskIds.b);
    expect(b.status).toBe('queued');
  });

  it('does nothing for completed workflows', () => {
    const { wfId } = setupWorkflow({
      status: 'completed',
      taskStates: { a: { status: 'completed' } },
    });
    const { resumeWorkflow } = require('../execution/workflow-resume');
    const result = resumeWorkflow(wfId);
    expect(result.skipped).toBe(true);
  });

  it('finalizes workflow if all tasks are now terminal', () => {
    const { wfId } = setupWorkflow({
      status: 'running',
      taskStates: {
        a: { status: 'completed' },
        b: { status: 'completed' },
      },
    });
    const { resumeWorkflow } = require('../execution/workflow-resume');
    const result = resumeWorkflow(wfId);
    expect(result.finalized).toBe(true);
    const wf = db.getWorkflow(wfId);
    expect(wf.status).toBe('completed');
  });

  it('resumeAllRunningWorkflows iterates every running workflow', () => {
    setupWorkflow({
      taskStates: {
        a: { status: 'completed' },
        b: { status: 'blocked', depends_on: ['a'] },
      },
    });
    setupWorkflow({
      taskStates: {
        x: { status: 'completed' },
        y: { status: 'blocked', depends_on: ['x'] },
      },
    });
    const { resumeAllRunningWorkflows } = require('../execution/workflow-resume');
    const result = resumeAllRunningWorkflows();
    expect(result.workflows_evaluated).toBeGreaterThanOrEqual(2);
    expect(result.tasks_unblocked).toBeGreaterThanOrEqual(2);
  });
});
