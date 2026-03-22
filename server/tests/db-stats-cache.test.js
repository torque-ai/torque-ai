const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

let testDir;
let origDataDir;
let db;
let taskCore;
let templateBuffer;

function setupDb() {
  testDir = path.join(os.tmpdir(), `torque-vtest-db-stats-cache-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  taskCore = require('../db/task-core');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
}

function teardownDb() {
  try { if (db) db.close(); } catch {}
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
  if (origDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = origDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }
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

    const counts = db.countTasksByStatus();

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
