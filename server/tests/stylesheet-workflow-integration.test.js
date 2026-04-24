'use strict';

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;
let testDir;

beforeAll(() => {
  const env = setupTestDb('stylesheet-workflow-integration');
  db = env.db;
  testDir = env.testDir;
});

afterAll(() => teardownTestDb());

function extractUUID(text) {
  return text.match(/([a-f0-9-]{36})/)?.[1];
}

describe('create_workflow with model_stylesheet', () => {
  it('applies universal rule to tasks without explicit provider', async () => {
    const result = await safeTool('create_workflow', {
      name: 'ss-test-1',
      working_directory: testDir,
      model_stylesheet: '* { provider: ollama; }',
      tasks: [
        { node_id: 'a', task_description: 'A' },
        { node_id: 'b', task_description: 'B' },
      ],
    });

    expect(result.isError).toBeFalsy();
    const wfId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(wfId);
    expect(tasks.every((task) => task.provider === 'ollama')).toBe(true);
  });

  it('tag selector overrides universal selector', async () => {
    const result = await safeTool('create_workflow', {
      name: 'ss-test-2',
      working_directory: testDir,
      model_stylesheet: `
        * { provider: ollama; }
        .coding { provider: codex; }
      `,
      tasks: [
        { node_id: 'doc', task_description: 'docs', tags: ['docs'] },
        { node_id: 'code', task_description: 'code', tags: ['coding'] },
      ],
    });

    expect(result.isError).toBeFalsy();
    const wfId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(wfId);
    const doc = tasks.find((task) => task.workflow_node_id === 'doc');
    const code = tasks.find((task) => task.workflow_node_id === 'code');
    expect(doc.provider).toBe('ollama');
    expect(code.provider).toBe('codex');
  });

  it('explicit task provider beats stylesheet', async () => {
    const result = await safeTool('create_workflow', {
      name: 'ss-test-3',
      working_directory: testDir,
      model_stylesheet: '* { provider: ollama; }',
      tasks: [
        { node_id: 'override', task_description: 'x', provider: 'codex' },
      ],
    });

    expect(result.isError).toBeFalsy();
    const wfId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(wfId);
    expect(tasks[0].provider).toBe('codex');
  });

  it('returns a clear error for invalid stylesheet', async () => {
    const result = await safeTool('create_workflow', {
      name: 'ss-test-4',
      working_directory: testDir,
      model_stylesheet: '* { provider: not-a-provider; }',
      tasks: [{ node_id: 'a', task_description: 'x' }],
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/invalid.*stylesheet|provider/i);
  });
});
