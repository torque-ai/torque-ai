const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

let db;
let taskCore;
let rawDb;
let testDir;

function makeTerminalTask(id, createdAt, outputSize) {
  taskCore.createTask({
    id,
    task_description: `retention ${id}`,
    working_directory: testDir,
    status: 'completed',
  });
  rawDb.prepare(`
    UPDATE tasks
    SET output = ?,
        error_output = ?,
        partial_output = ?,
        resume_context = ?,
        created_at = ?,
        completed_at = ?
    WHERE id = ?
  `).run(
    'o'.repeat(outputSize),
    'e'.repeat(20),
    'p'.repeat(10),
    JSON.stringify({ id }),
    createdAt,
    createdAt,
    id
  );
}

describe('task output retention', () => {
  beforeEach(() => {
    ({ db, testDir } = setupTestDbOnly('task-core-output-retention'));
    taskCore = require('../db/task-core');
    rawDb = db.getDbInstance();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('enforces a size cap by clearing oldest terminal task output blobs', () => {
    makeTerminalTask('retention-old-1', '2026-01-01T00:00:00.000Z', 100);
    makeTerminalTask('retention-old-2', '2026-01-02T00:00:00.000Z', 100);
    makeTerminalTask('retention-new', '2026-01-03T00:00:00.000Z', 100);

    const before = taskCore.getTerminalTaskOutputBytes();
    const result = taskCore.enforceTaskOutputSizeLimit(150);
    const old1 = taskCore.getTask('retention-old-1');
    const old2 = taskCore.getTask('retention-old-2');
    const current = taskCore.getTask('retention-new');

    expect(before).toBeGreaterThan(300);
    expect(result).toEqual(expect.objectContaining({
      purged: 2,
      bytes_before: before,
      bytes_after: taskCore.getTerminalTaskOutputBytes(),
      max_bytes: 150,
    }));
    expect(old1.output).toBeNull();
    expect(old1.error_output).toBeNull();
    expect(old1.partial_output).toBeNull();
    expect(JSON.parse(old1.resume_context)).toEqual({ id: 'retention-old-1' });
    expect(old2.output).toBeNull();
    expect(current.output).toHaveLength(100);
  });
});
