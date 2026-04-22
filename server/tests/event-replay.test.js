'use strict';

const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { listEvents } = require('../events/event-emitter');

let db;
let testDir;

beforeAll(() => {
  const setup = setupTestDb('event-replay');
  db = setup.db;
  testDir = setup.testDir;
});

afterAll(() => teardownTestDb());

describe('event log captures full task lifecycle', () => {
  it('emits create + queued + running + completed for a happy-path task', () => {
    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'x',
      working_directory: testDir,
      status: 'pending',
      provider: 'codex',
    });
    db.updateTaskStatus(taskId, 'queued');
    db.updateTaskStatus(taskId, 'running');
    db.updateTaskStatus(taskId, 'completed', { exit_code: 0 });

    const events = listEvents({ task_id: taskId });
    const types = events.map(e => e.type);
    expect(types).toContain('task.created');
    expect(types).toContain('task.queued');
    expect(types).toContain('task.running');
    expect(types).toContain('task.completed');
  });
});
