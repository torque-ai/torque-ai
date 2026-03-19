/**
 * Tests for streamId-to-taskId cache in webhooks-streaming.js
 *
 * Phase 2 Task 1: Verifies that _streamToTask Map is populated by
 * createTaskStream and getOrCreateTaskStream, and that getStreamTaskId
 * returns the correct taskId for a given streamId.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir, origDataDir, db, mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-partial-output-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;
  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  mod = require('../db/webhooks-streaming');
  mod.setDb(db.getDb ? db.getDb() : db.getDbInstance());
}

function teardown() {
  if (db) try { db.close(); } catch {}
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    if (origDataDir !== undefined) process.env.TORQUE_DATA_DIR = origDataDir;
    else delete process.env.TORQUE_DATA_DIR;
  }
}

/**
 * Create a task row in the DB so that task_streams foreign key constraints
 * are satisfied (task_id must exist in the tasks table).
 */
function makeTask(id) {
  db.createTask({
    id,
    task_description: 'partial-output-streaming test task',
    working_directory: testDir,
    status: 'queued',
    priority: 0,
    project: null,
    provider: 'codex',
  });
}

beforeEach(() => {
  setup();
});

afterEach(() => {
  teardown();
});

describe('streamToTask cache', () => {
  test('createTaskStream populates _streamToTask cache', () => {
    const taskId = `test-task-1-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.createTaskStream(taskId, 'output');
    expect(streamId).toBeDefined();
    expect(mod.getStreamTaskId(streamId)).toBe(taskId);
  });

  test('getOrCreateTaskStream populates _streamToTask cache', () => {
    const taskId = `test-task-2-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.getOrCreateTaskStream(taskId, 'output');
    expect(mod.getStreamTaskId(streamId)).toBe(taskId);
  });

  test('getOrCreateTaskStream returns cached streamId on second call', () => {
    const taskId = `test-task-3-${randomUUID()}`;
    makeTask(taskId);
    const id1 = mod.getOrCreateTaskStream(taskId, 'output');
    const id2 = mod.getOrCreateTaskStream(taskId, 'output');
    expect(id1).toBe(id2);
    expect(mod.getStreamTaskId(id1)).toBe(taskId);
  });

  test('getStreamTaskId returns null for unknown streamId', () => {
    expect(mod.getStreamTaskId('nonexistent-stream-id')).toBeNull();
  });

  test('createTaskStream creates independent streams for different tasks', () => {
    const taskId1 = `test-task-a-${randomUUID()}`;
    const taskId2 = `test-task-b-${randomUUID()}`;
    makeTask(taskId1);
    makeTask(taskId2);
    const streamId1 = mod.createTaskStream(taskId1, 'output');
    const streamId2 = mod.createTaskStream(taskId2, 'output');
    expect(streamId1).not.toBe(streamId2);
    expect(mod.getStreamTaskId(streamId1)).toBe(taskId1);
    expect(mod.getStreamTaskId(streamId2)).toBe(taskId2);
  });
});
