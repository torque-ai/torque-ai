const fs = require('fs');
const os = require('os');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { getVitestTemplateBufferPath } = require('./vitest-template-paths');

const TEMPLATE_BUF = getVitestTemplateBufferPath();

let templateBuffer;
let db;
let taskCore;
let routingCore;

function rawDb() {
  return db.getDb ? db.getDb() : db.getDbInstance();
}

function bindRoutingCore() {
  routingCore.setDb(rawDb());
  routingCore.setGetTask((id) => taskCore.getTask(id));
}

function createTask(id, {
  status = 'completed',
  createdAt = '2026-01-01T00:00:00.000Z',
} = {}) {
  taskCore.createTask({
    id,
    task_description: `Task ${id}`,
    working_directory: os.tmpdir(),
    status,
    provider: 'codex',
  });
  rawDb().prepare(`
    UPDATE tasks
    SET created_at = ?,
        completed_at = CASE WHEN status IN ('completed', 'failed', 'cancelled') THEN ? ELSE completed_at END
    WHERE id = ?
  `).run(createdAt, createdAt, id);
  return id;
}

function addTaskChildren(taskId) {
  const now = '2026-01-02T00:00:00.000Z';
  const streamId = `stream-${taskId}`;
  rawDb().prepare(`
    INSERT INTO task_streams (id, task_id, stream_type, created_at)
    VALUES (?, ?, ?, ?)
  `).run(streamId, taskId, 'output', now);
  rawDb().prepare(`
    INSERT INTO stream_chunks (stream_id, chunk_data, chunk_type, sequence_num, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(streamId, 'chunk', 'stdout', 1, now);
  rawDb().prepare(`
    INSERT INTO task_checkpoints (task_id, checkpoint_data, checkpoint_type, created_at)
    VALUES (?, ?, ?, ?)
  `).run(taskId, '{}', 'pause', now);
  rawDb().prepare(`
    INSERT INTO task_events (task_id, type, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, 'task.completed', 'task.completed', '{}', now);
  rawDb().prepare(`
    INSERT INTO file_locks (file_path, working_directory, task_id, lock_type, acquired_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(`${taskId}.txt`, os.tmpdir(), taskId, 'exclusive', now);
}

function countRows(tableName, whereSql = '', params = []) {
  return rawDb().prepare(`SELECT COUNT(*) AS count FROM ${tableName} ${whereSql}`).get(...params).count;
}

function countTaskChildren(taskIds) {
  const placeholders = taskIds.map(() => '?').join(',');
  return {
    task_streams: countRows('task_streams', `WHERE task_id IN (${placeholders})`, taskIds),
    task_checkpoints: countRows('task_checkpoints', `WHERE task_id IN (${placeholders})`, taskIds),
    task_events: countRows('task_events', `WHERE task_id IN (${placeholders})`, taskIds),
    file_locks: countRows('file_locks', `WHERE task_id IN (${placeholders})`, taskIds),
    stream_chunks: countRows(
      'stream_chunks',
      `WHERE stream_id IN (${taskIds.map(() => '?').join(',')})`,
      taskIds.map((taskId) => `stream-${taskId}`),
    ),
  };
}

describe('task retention pruning', () => {
  beforeAll(() => {
    templateBuffer = fs.readFileSync(TEMPLATE_BUF);
    ({ db } = setupTestDbOnly('task-retention-prune'));
    taskCore = require('../db/task-core');
    routingCore = require('../db/provider/routing-core');
    bindRoutingCore();
  });

  beforeEach(() => {
    db.resetForTest(templateBuffer);
    rawDb().pragma('foreign_keys = ON');
    bindRoutingCore();
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('prunes old terminal tasks after deleting dependent rows in FK order', () => {
    const oldest = createTask('retention-oldest', {
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const middle = createTask('retention-middle', {
      status: 'failed',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const newest = createTask('retention-newest', {
      status: 'cancelled',
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    const queued = createTask('retention-queued', {
      status: 'queued',
      createdAt: '2025-12-31T00:00:00.000Z',
    });

    for (const taskId of [oldest, middle]) {
      addTaskChildren(taskId);
    }

    const result = routingCore.pruneOldTasks(1);

    expect(result.pruned).toBe(2);
    expect(result.task_ids).toEqual([middle, oldest]);
    expect(result.related_deleted.stream_chunks).toBe(2);
    expect(result.related_deleted.task_streams).toBe(2);
    expect(result.related_deleted.task_checkpoints).toBe(2);
    expect(result.related_deleted.task_events).toBeGreaterThanOrEqual(2);
    expect(result.related_deleted.file_locks).toBe(2);

    expect(countRows('tasks', 'WHERE id IN (?, ?)', [oldest, middle])).toBe(0);
    expect(countRows('tasks', 'WHERE id IN (?, ?)', [newest, queued])).toBe(2);
    expect(countTaskChildren([oldest, middle])).toEqual({
      task_streams: 0,
      task_checkpoints: 0,
      task_events: 0,
      file_locks: 0,
      stream_chunks: 0,
    });
  });

  it('uses the same child cleanup for explicit task deletion', () => {
    const taskId = createTask('delete-one-with-streams', {
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    addTaskChildren(taskId);

    const result = taskCore.deleteTask(taskId);

    expect(result).toEqual({ deleted: true, id: taskId, status: 'completed' });
    expect(countRows('tasks', 'WHERE id = ?', [taskId])).toBe(0);
    expect(countTaskChildren([taskId])).toEqual({
      task_streams: 0,
      task_checkpoints: 0,
      task_events: 0,
      file_locks: 0,
      stream_chunks: 0,
    });
  });

  it('chunks large retention deletes across SQLite variable limits', () => {
    const taskIds = [];
    for (let index = 0; index < 405; index += 1) {
      const taskId = `retention-bulk-${String(index).padStart(3, '0')}`;
      taskIds.push(taskId);
      createTask(taskId, {
        status: 'completed',
        createdAt: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      });
      addTaskChildren(taskId);
    }

    const result = routingCore.pruneOldTasks(0);

    expect(result.pruned).toBe(405);
    expect(result.task_ids).toHaveLength(405);
    expect(result.related_deleted.stream_chunks).toBe(405);
    expect(result.related_deleted.task_streams).toBe(405);
    expect(result.related_deleted.task_checkpoints).toBe(405);
    expect(result.related_deleted.file_locks).toBe(405);
    expect(countRows('tasks')).toBe(0);
    expect(countTaskChildren(taskIds)).toEqual({
      task_streams: 0,
      task_checkpoints: 0,
      task_events: 0,
      file_locks: 0,
      stream_chunks: 0,
    });
  });
});
