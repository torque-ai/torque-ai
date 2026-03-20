'use strict';
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const { randomUUID } = require('crypto');

describe('Debug run_workflow', () => {
  let db;
  beforeAll(() => {
    const env = setupTestDb('debug-run-wf');
    db = env.db;
  });
  afterAll(() => teardownTestDb());

  it('shows actual error from run_workflow', async () => {
    const id = randomUUID();
    db.createWorkflow({ id, name: 'test-wf', status: 'pending' });
    await safeTool('add_workflow_task', { workflow_id: id, node_id: 'n1', task_description: 'test task' });
    const result = await safeTool('run_workflow', { workflow_id: id });
    console.log('RESULT:', JSON.stringify(result, null, 2));
    expect(true).toBe(true);
  });
});
