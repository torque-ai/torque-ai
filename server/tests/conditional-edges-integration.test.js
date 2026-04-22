'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;
let testDir;

beforeAll(() => {
  const env = setupTestDb('conditional-edges');
  db = env.db;
  testDir = env.testDir;
});

afterAll(() => teardownTestDb());

function extractUUID(text) {
  return text.match(/([a-f0-9-]{36})/)?.[1];
}

describe('conditional edges', () => {
  it('routes to ship branch only when scan succeeds', async () => {
    const result = await safeTool('create_workflow', {
      name: 'cond-1',
      working_directory: testDir,
      tasks: [
        { node_id: 'scan', task_description: 'scan' },
        { node_id: 'ship', task_description: 'ship', depends_on: ['scan'], condition: 'outcome=success' },
        { node_id: 'escalate', task_description: 'escalate', depends_on: ['scan'], condition: 'outcome=fail' },
      ],
    });

    const wfId = extractUUID(getText(result));
    expect(wfId).toBeTruthy();

    const tasks = db.getWorkflowTasks(wfId);
    const scan = tasks.find(t => t.workflow_node_id === 'scan');
    const ship = tasks.find(t => t.workflow_node_id === 'ship');
    const escalate = tasks.find(t => t.workflow_node_id === 'escalate');

    db.updateTaskStatus(scan.id, 'completed', { exit_code: 0 });

    const wfEngine = require('../db/workflow-engine');
    expect(wfEngine.isTaskUnblockable(ship.id)).toBe(true);
    expect(wfEngine.isTaskUnblockable(escalate.id)).toBe(false);
    expect(db.getTask(escalate.id).status).toBe('skipped');
  });

  it('failure_class condition routes to fix node', async () => {
    const result = await safeTool('create_workflow', {
      name: 'cond-2',
      working_directory: testDir,
      tasks: [
        { node_id: 'impl', task_description: 'impl' },
        { node_id: 'retry', task_description: 'retry', depends_on: ['impl'], condition: 'failure_class=transient_infra' },
        { node_id: 'escalate', task_description: 'escalate', depends_on: ['impl'], condition: 'failure_class=deterministic' },
      ],
    });

    const wfId = extractUUID(getText(result));
    expect(wfId).toBeTruthy();

    const tasks = db.getWorkflowTasks(wfId);
    const impl = tasks.find(t => t.workflow_node_id === 'impl');
    const retry = tasks.find(t => t.workflow_node_id === 'retry');
    const escalate = tasks.find(t => t.workflow_node_id === 'escalate');

    db.updateTaskStatus(impl.id, 'failed', {
      exit_code: 1,
      metadata: { failure_class: 'transient_infra' },
    });

    const wfEngine = require('../db/workflow-engine');
    expect(wfEngine.isTaskUnblockable(retry.id)).toBe(true);
    expect(wfEngine.isTaskUnblockable(escalate.id)).toBe(false);
    expect(db.getTask(escalate.id).status).toBe('skipped');
  });
});
