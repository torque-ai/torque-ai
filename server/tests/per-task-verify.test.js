'use strict';

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;
let testDir;

function extractUUID(text) {
  return text.match(/([a-f0-9-]{36})/)?.[1] || null;
}

function parseMeta(task) {
  if (!task || !task.metadata) return {};
  if (typeof task.metadata === 'object') return task.metadata;
  try { return JSON.parse(task.metadata); } catch { return {}; }
}

describe('per-task verify metadata', () => {
  beforeAll(() => {
    const env = setupTestDb('per-task-verify');
    db = env.db;
    testDir = env.testDir;
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('stores verify_command and verify_skip from create_workflow tasks', async () => {
    const result = await safeTool('create_workflow', {
      name: 'per-task-verify-create',
      working_directory: testDir,
      tasks: [
        { node_id: 'docs', task_description: 'Update docs', verify_command: 'markdownlint docs/' },
        { node_id: 'skip', task_description: 'Skip verify', verify_skip: true },
      ],
    });

    expect(result.isError).toBeFalsy();
    const workflowId = extractUUID(getText(result));
    expect(workflowId).toBeTruthy();

    const tasks = db.getWorkflowTasks(workflowId);
    const docs = tasks.find((task) => task.workflow_node_id === 'docs');
    const skip = tasks.find((task) => task.workflow_node_id === 'skip');

    expect(parseMeta(docs).verify_command).toBe('markdownlint docs/');
    expect(parseMeta(skip).verify_skip).toBe(true);
  });

  it('stores verify_command and verify_skip from add_workflow_task', async () => {
    const workflowResult = await safeTool('create_workflow', {
      name: 'per-task-verify-add',
      working_directory: testDir,
      tasks: [
        { node_id: 'seed', task_description: 'Seed task' },
      ],
    });
    const workflowId = extractUUID(getText(workflowResult));
    expect(workflowId).toBeTruthy();

    const addResult = await safeTool('add_workflow_task', {
      workflow_id: workflowId,
      node_id: 'added',
      task_description: 'Added docs task',
      verify_command: 'markdownlint README.md',
      verify_skip: true,
    });

    expect(addResult.isError).toBeFalsy();
    const tasks = db.getWorkflowTasks(workflowId);
    const added = tasks.find((task) => task.workflow_node_id === 'added');

    expect(parseMeta(added)).toEqual(expect.objectContaining({
      verify_command: 'markdownlint README.md',
      verify_skip: true,
    }));
  });
});
