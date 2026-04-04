const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const taskCore = require('../db/task-core');

let testDir;
let db;

function setupDb() {
  ({ db, testDir } = setupTestDbOnly('db-stats-cache'));
}

function teardownDb() {
  teardownTestDb();
}

function createTaskWithStatus(status) {
  taskCore.createTask({
    id: randomUUID(),
    task_description: `status ${status}`,
    status,
    working_directory: testDir,
  });
}

describe('db.countTasksByStatus', () => {
  beforeAll(() => {
    setupDb();
  });

  afterAll(() => {
    teardownDb();
  });

  it('returns aggregated status counts and zero for missing statuses', () => {
    db.getDbInstance().prepare('DELETE FROM tasks').run();

    createTaskWithStatus('running');
    createTaskWithStatus('running');
    createTaskWithStatus('queued');
    createTaskWithStatus('completed');
    createTaskWithStatus('completed');
    createTaskWithStatus('completed');
    createTaskWithStatus('failed');
    createTaskWithStatus('pending');

    const counts = taskCore.countTasksByStatus();

    expect(counts).toEqual({
      running: 2,
      queued: 1,
      completed: 3,
      failed: 1,
      pending: 1,
      cancelled: 0,
      blocked: 0,
    });
  });
});
