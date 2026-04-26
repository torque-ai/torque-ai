'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const { buildBundle } = require('../runs/build-bundle');
const { replayWorkflow } = require('../runs/replay');

let db;
let testDir;
let conn;

beforeAll(() => {
  const setup = setupTestDbOnly('replay');
  db = setup.db;
  testDir = setup.testDir;
  conn = rawDb();
});

afterAll(() => teardownTestDb());

describe('replayWorkflow', () => {
  it('recreates a workflow from a bundle with same DAG and task descriptions', () => {
    const origWfId = randomUUID();
    conn.prepare(`
      INSERT INTO workflows (id, name, status, created_at, working_directory)
      VALUES (?, 'orig', 'completed', ?, ?)
    `).run(origWfId, '2026-04-11T10:00:00Z', testDir);

    const taskA = randomUUID();
    const taskB = randomUUID();
    db.createTask({
      id: taskA,
      task_description: 'A',
      working_directory: testDir,
      status: 'pending',
      workflow_id: origWfId,
      workflow_node_id: 'a',
      provider: 'codex',
    });
    db.createTask({
      id: taskB,
      task_description: 'B',
      working_directory: testDir,
      status: 'pending',
      workflow_id: origWfId,
      workflow_node_id: 'b',
      provider: 'codex',
    });
    db.addTaskDependency({
      workflow_id: origWfId,
      task_id: taskB,
      depends_on_task_id: taskA,
    });
    conn.prepare('UPDATE tasks SET status = ? WHERE workflow_id = ?')
      .run('completed', origWfId);
    conn.prepare('UPDATE workflows SET status = ?, completed_at = ? WHERE id = ?')
      .run('completed', '2026-04-11T10:01:00Z', origWfId);

    const bundleDir = buildBundle(origWfId, { rootDir: testDir });

    const result = replayWorkflow(bundleDir);
    expect(result.ok).toBe(true);
    const newWfId = result.workflow_id;
    expect(newWfId).not.toBe(origWfId);

    const newWf = db.getWorkflow(newWfId);
    expect(newWf.name).toMatch(/orig.*replay|replay.*orig/i);

    const newTasks = db.getWorkflowTasks(newWfId);
    expect(newTasks).toHaveLength(2);
    const a = newTasks.find(task => task.workflow_node_id === 'a');
    const b = newTasks.find(task => task.workflow_node_id === 'b');
    expect(a.task_description).toBe('A');
    expect(b.task_description).toBe('B');

    const deps = db.getTaskDependencies(b.id);
    expect(deps.some(dep => dep.depends_on_task_id === a.id)).toBe(true);
  });

  it('returns error for missing bundle', () => {
    const result = replayWorkflow(path.join(testDir, 'no-such-dir'));
    expect(result.ok).toBe(false);
  });
});
