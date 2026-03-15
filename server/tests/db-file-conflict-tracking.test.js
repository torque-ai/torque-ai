const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { setupTestDbModule, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');

// Module is now merged into file-tracking.js; file-conflict-tracking.js re-exports it
let mod;
let testDir;

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function insertTask(overrides = {}) {
  const task = {
    id: overrides.id || crypto.randomUUID(),
    task_description: overrides.task_description || 'file-conflict-tracking test task',
    status: overrides.status || 'completed',
    working_directory: Object.prototype.hasOwnProperty.call(overrides, 'working_directory')
      ? overrides.working_directory
      : null,
    provider: overrides.provider || 'codex',
    created_at: overrides.created_at || new Date().toISOString(),
    workflow_id: Object.prototype.hasOwnProperty.call(overrides, 'workflow_id')
      ? overrides.workflow_id
      : null,
  };

  rawDb().prepare(`
    INSERT INTO tasks (id, task_description, status, working_directory, provider, created_at, workflow_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.task_description,
    task.status,
    task.working_directory,
    task.provider,
    task.created_at,
    task.workflow_id
  );

  return task;
}

function writeFile(rootDir, relativePath, content) {
  const absolutePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
  return absolutePath;
}

describe('db/file-conflict-tracking', () => {
  beforeAll(() => {
    ({ mod, testDir } = setupTestDbModule('../db/file-tracking', 'file-conflict-tracking'));
  });

  afterAll(() => teardownTestDb());

  beforeEach(() => {
    resetTables(['tasks', 'task_file_writes']);
    const snapshotRoot = path.join(testDir, `data-${Date.now()}`);
    fs.mkdirSync(snapshotRoot, { recursive: true });
    mod.setDataDir(snapshotRoot);
  });

  afterEach(() => {
    mod.setDataDir(null);
    vi.restoreAllMocks();
  });

  describe('helper behavior', () => {
    it('getTaskFileSnapshot returns null for missing hashes', () => {
      expect(mod.getTaskFileSnapshot(null)).toBeNull();
      expect(mod.getTaskFileSnapshot('nonexistent-hash')).toBeNull();
    });

    it('getTaskFileSnapshot round-trips persisted snapshot content', () => {
      const workDir = path.join(testDir, 'workspace-snap');
      const task = insertTask({
        id: 'task-snapshot-roundtrip',
        workflow_id: 'workflow-snap',
        working_directory: workDir,
      });
      writeFile(workDir, 'src/snap.js', 'snapshot text');
      const result = mod.recordTaskFileWrite(task.id, 'src/snap.js');

      expect(mod.getTaskFileSnapshot(result.content_hash)).toEqual({
        exists: true,
        content: 'snapshot text',
      });
    });

    it('getTaskFileSnapshot returns null for malformed JSON snapshots', () => {
      // Write a malformed file directly to the snapshot dir — need to get the current data dir
      // setDataDir was called in beforeEach, so we need to access it
      const snapshotDir = path.join(testDir, 'malformed-snap', 'task-file-write-snapshots');
      fs.mkdirSync(snapshotDir, { recursive: true });
      // Point dataDir to the parent so the module looks in snapshotDir
      mod.setDataDir(path.join(testDir, 'malformed-snap'));
      const contentHash = 'malformed-snapshot';
      fs.writeFileSync(path.join(snapshotDir, `${contentHash}.json`), '{bad json', 'utf8');

      expect(mod.getTaskFileSnapshot(contentHash)).toBeNull();
    });
  });

  describe('recordTaskFileWrite', () => {
    it('requires initialization through setDb before recording writes', () => {
      // Temporarily clear db, test, then restore
      mod.setDb(null);
      expect(() => mod.recordTaskFileWrite('task-1', 'src/app.js')).toThrow(
        'database has not been initialized'
      );
      mod.setDb(rawDb());
    });

    it('rejects invalid task ids', () => {
      expect(() => mod.recordTaskFileWrite('', 'src/app.js')).toThrow('taskId must be a non-empty string');
    });

    it('rejects blank file paths', () => {
      const task = insertTask({ id: 'task-empty-file', working_directory: path.join(testDir, 'workspace') });

      expect(() => mod.recordTaskFileWrite(task.id, '   ')).toThrow('filePath must be a non-empty string');
    });

    it('rejects unknown task ids', () => {
      expect(() => mod.recordTaskFileWrite('missing-task', 'src/app.js')).toThrow('Task not found: missing-task');
    });

    it('records relative file writes, stores the live hash, and persists the snapshot', () => {
      const workDir = path.join(testDir, 'workspace-a');
      const task = insertTask({
        id: 'task-relative-write',
        workflow_id: 'workflow-relative',
        working_directory: workDir,
      });
      const absolutePath = writeFile(workDir, 'src/app.js', 'const value = 1;\n');
      const result = mod.recordTaskFileWrite(task.id, absolutePath);

      expect(result).toMatchObject({
        task_id: task.id,
        workflow_id: 'workflow-relative',
        file_path: 'src/app.js',
        content_hash: sha256('const value = 1;\n'),
        exists: true,
      });

      expect(mod.getTaskFileSnapshot(result.content_hash)).toEqual({
        exists: true,
        content: 'const value = 1;\n',
      });

      const storedRow = rawDb().prepare('SELECT * FROM task_file_writes WHERE task_id = ?').get(task.id);
      expect(storedRow.file_path).toBe('src/app.js');
      expect(storedRow.content_hash).toBe(result.content_hash);
    });

    it('ignores a mismatched provided content hash and uses the live file contents', () => {
      const workDir = path.join(testDir, 'workspace-b');
      const task = insertTask({
        id: 'task-mismatch-hash',
        workflow_id: 'workflow-mismatch',
        working_directory: workDir,
      });
      writeFile(workDir, 'src/app.js', 'live content\n');

      const result = mod.recordTaskFileWrite(task.id, 'src/app.js', sha256('stale content\n'));

      expect(result.content_hash).toBe(sha256('live content\n'));
      expect(mod.getTaskFileSnapshot(result.content_hash)).toEqual({
        exists: true,
        content: 'live content\n',
      });
    });

    it('tracks deleted files using the deleted sentinel hash and snapshot payload', () => {
      const workDir = path.join(testDir, 'workspace-c');
      const task = insertTask({
        id: 'task-deleted-file',
        workflow_id: 'workflow-deleted',
        working_directory: workDir,
      });
      const result = mod.recordTaskFileWrite(task.id, 'src/missing.js');

      expect(result.exists).toBe(false);
      expect(result.file_path).toBe('src/missing.js');
      expect(result.content_hash).toBe(sha256('__deleted__'));
      expect(mod.getTaskFileSnapshot(result.content_hash)).toEqual({
        exists: false,
        content: '',
      });
    });

    it('stores outside-workdir paths as normalized absolute paths', () => {
      const workDir = path.join(testDir, 'workspace-d');
      const task = insertTask({
        id: 'task-outside-file',
        workflow_id: 'workflow-outside',
        working_directory: workDir,
      });
      const outsidePath = writeFile(path.join(testDir, 'outside'), 'artifact.js', 'module.exports = 1;\n');
      const result = mod.recordTaskFileWrite(task.id, outsidePath);

      expect(result.file_path).toBe(outsidePath.replace(/\\/g, '/'));
      expect(result.exists).toBe(true);
    });

    it('uses normalized raw paths when the task has no working directory', () => {
      const task = insertTask({
        id: 'task-no-workdir',
        workflow_id: 'workflow-no-workdir',
        working_directory: null,
      });
      const result = mod.recordTaskFileWrite(task.id, '__torque_missing__\\nested\\file.js');

      expect(result.file_path).toBe('__torque_missing__/nested/file.js');
      expect(result.exists).toBe(false);
    });
  });

  describe('conflict queries', () => {
    it('getConflictedFiles aggregates workflow conflicts, ignores same-task duplicates, and sorts by file path', () => {
      const workDir = path.join(testDir, 'workflow-conflicts');
      const taskA = insertTask({ id: 'task-a', workflow_id: 'workflow-1', working_directory: workDir });
      const taskB = insertTask({ id: 'task-b', workflow_id: 'workflow-1', working_directory: workDir });
      const taskC = insertTask({ id: 'task-c', workflow_id: 'workflow-1', working_directory: workDir });

      writeFile(workDir, 'src/zeta.js', 'from a\n');
      mod.recordTaskFileWrite(taskA.id, 'src/zeta.js');
      writeFile(workDir, 'src/zeta.js', 'from a again\n');
      mod.recordTaskFileWrite(taskA.id, 'src/zeta.js');
      writeFile(workDir, 'src/alpha.js', 'from a alpha\n');
      mod.recordTaskFileWrite(taskA.id, 'src/alpha.js');

      writeFile(workDir, 'src/alpha.js', 'from b alpha\n');
      mod.recordTaskFileWrite(taskB.id, 'src/alpha.js');
      writeFile(workDir, 'src/zeta.js', 'from b\n');
      mod.recordTaskFileWrite(taskB.id, 'src/zeta.js');

      writeFile(workDir, 'src/solo.js', 'from c only\n');
      mod.recordTaskFileWrite(taskC.id, 'src/solo.js');

      const conflicts = mod.getConflictedFiles('workflow-1').map((row) => ({
        ...row,
        task_ids: [...row.task_ids].sort(),
      }));

      expect(conflicts).toEqual([
        {
          file_path: 'src/alpha.js',
          task_count: 2,
          task_ids: ['task-a', 'task-b'],
        },
        {
          file_path: 'src/zeta.js',
          task_count: 2,
          task_ids: ['task-a', 'task-b'],
        },
      ]);
    });

    it('getConflictedFiles requires a workflow id', () => {
      expect(() => mod.getConflictedFiles('')).toThrow('workflowId must be a non-empty string');
    });

    it('getWorkflowFileWrites returns the latest write per task for a specific file and workflow', () => {
      const workDir = path.join(testDir, 'workflow-writes');
      const taskA = insertTask({ id: 'task-latest-a', workflow_id: 'workflow-2', working_directory: workDir });
      const taskB = insertTask({ id: 'task-latest-b', workflow_id: 'workflow-2', working_directory: workDir });
      const taskOtherWorkflow = insertTask({
        id: 'task-other-workflow',
        workflow_id: 'workflow-3',
        working_directory: workDir,
      });

      writeFile(workDir, 'src/shared.js', 'task a first\n');
      mod.recordTaskFileWrite(taskA.id, 'src/shared.js');
      writeFile(workDir, 'src/shared.js', 'task a second\n');
      mod.recordTaskFileWrite(taskA.id, 'src/shared.js');

      writeFile(workDir, 'src/shared.js', 'task b only\n');
      mod.recordTaskFileWrite(taskB.id, 'src/shared.js');

      writeFile(workDir, 'src/other.js', 'other file\n');
      mod.recordTaskFileWrite(taskA.id, 'src/other.js');

      writeFile(workDir, 'src/shared.js', 'other workflow\n');
      mod.recordTaskFileWrite(taskOtherWorkflow.id, 'src/shared.js');

      const writes = mod.getWorkflowFileWrites('workflow-2', 'src/shared.js');

      expect(writes).toHaveLength(2);
      expect(writes.map((row) => row.task_id).sort()).toEqual(['task-latest-a', 'task-latest-b']);
      expect(writes.find((row) => row.task_id === 'task-latest-a').content_hash).toBe(sha256('task a second\n'));
      expect(writes.find((row) => row.task_id === 'task-latest-b').content_hash).toBe(sha256('task b only\n'));
      expect(writes.every((row) => row.workflow_id === 'workflow-2')).toBe(true);
      expect(writes.every((row) => row.file_path === 'src/shared.js')).toBe(true);
    });

    it('getWorkflowFileWrites returns an empty array when no writes match', () => {
      expect(mod.getWorkflowFileWrites('workflow-missing', 'src/none.js')).toEqual([]);
    });

    it('getWorkflowFileWrites enforces database initialization', () => {
      mod.setDb(null);
      expect(() => mod.getWorkflowFileWrites('workflow-4', 'src/app.js')).toThrow(
        'database has not been initialized'
      );
      mod.setDb(rawDb());
    });
  });
});
