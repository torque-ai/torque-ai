const { randomUUID } = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fileTracking = require('../db/file/tracking');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const taskCore = require('../db/task-core');

let db, templateBuffer;

beforeAll(() => {
  templateBuffer = fs.readFileSync(path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf'));
  ({ db } = setupTestDbOnly('db-file-tracking'));
});

beforeEach(() => {
  db.resetForTest(templateBuffer);
});

afterAll(() => {
  teardownTestDb();
});

const tempWorkdirs = [];

afterEach(() => {
  while (tempWorkdirs.length > 0) {
    const dir = tempWorkdirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});

function nextTaskDir(taskId) {
  const dir = path.join(os.tmpdir(), 'torque-db-file-tracking', taskId || randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  tempWorkdirs.push(dir);
  return dir;
}

function toForwardSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

function createTask(overrides = {}) {
  return taskCore.createTask({
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'File-tracking module test',
    status: overrides.status || 'queued',
    working_directory: overrides.working_directory || os.tmpdir(),
    provider: overrides.provider || 'codex',
    model: overrides.model || 'codex',
    priority: overrides.priority ?? 0,
    timeout_minutes: overrides.timeout_minutes || 30,
    project: overrides.project || 'file-tracking-tests',
    tags: overrides.tags || null,
    ...overrides,
  });
}

function createFile(dir, relativePath, content) {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

describe('db/file/tracking module', () => {
  it('captures and compares file baselines', () => {
    const task = createTask();
    const workDir = nextTaskDir(task.id);
    const file = createFile(workDir, 'src/main.js', 'line 1\nline 2\n');

    const baseline = fileTracking.captureFileBaseline('src/main.js', workDir, task.id);
    expect(baseline).toMatchObject({
      size: 14,
      lines: 3,
      checksum: expect.any(String),
    });

    const stored = fileTracking.getFileBaseline('src/main.js', workDir);
    expect(stored.task_id).toBe(task.id);

    fs.writeFileSync(file, 'line 1\nline 2\nline 3\n', 'utf8');

    const comparison = fileTracking.compareFileToBaseline('src/main.js', workDir);
    expect(comparison.hasBaseline).toBe(true);
    expect(comparison.isHashChanged).toBe(true);
    expect(comparison.sizeDelta).toBeGreaterThan(0);
    expect(comparison.lineDelta).toBe(1);
  });

  it('captures directory baselines and filters by extension', async () => {
    const task = createTask();
    const workDir = nextTaskDir(task.id);
    createFile(workDir, 'src/keep.ts', 'export {}');
    createFile(workDir, 'src/ignore.md', '# readme');
    createFile(workDir, 'node_modules/skip.js', 'module.exports = 1;');

    const captured = await fileTracking.captureDirectoryBaselines(workDir, ['.ts', '.js']);
    const capturedForward = captured.map(toForwardSlashes);

    expect(capturedForward).toContain('src/keep.ts');
    expect(capturedForward).not.toContain('src/ignore.md');
    expect(captured.some((p) => p.includes('node_modules'))).toBe(false);

    const capturedPath = captured.find((entry) => toForwardSlashes(entry) === 'src/keep.ts');
    expect(capturedPath).toBeDefined();
    expect(toForwardSlashes(capturedPath)).toBe('src/keep.ts');
    const capturedAgain = fileTracking.compareFileToBaseline(capturedPath, workDir);
    expect(capturedAgain.hasBaseline).toBe(true);
  });

  it('records file changes and resolves task file history', () => {
    const task = createTask();
    const workDir = nextTaskDir(task.id);
    const file = createFile(workDir, 'src/app.ts', 'const v = 1;');

    fileTracking.recordFileChange(task.id, file, 'created', { workingDirectory: workDir, fileSizeBytes: 12 });
    fileTracking.recordFileChange(task.id, file, 'modified', { workingDirectory: workDir, fileSizeBytes: 14 });

    const history = fileTracking.getTaskFileChanges(task.id);
    expect(history).toHaveLength(2);
    expect(history.every((row) => row.task_id === task.id)).toBe(true);

    const [first, second] = history;
    expect(first.file_path).toBe(file);
    expect(first.change_type).toBe('created');
    expect(first.file_size_bytes).toBe(12);
    expect(toForwardSlashes(first.relative_path)).toBe('src/app.ts');

    expect(second.change_type).toBe('modified');
    expect(second.file_size_bytes).toBe(14);
  });

  it('marks file changes outside working directory', () => {
    const task = createTask();
    const workDir = nextTaskDir(task.id);
    const outside = path.join(path.dirname(workDir), 'outside.js');

    const result = fileTracking.recordFileChange(task.id, outside, 'created', { workingDirectory: workDir });
    expect(result.is_outside_workdir).toBe(true);

    const history = fileTracking.getTaskFileChanges(task.id);
    expect(history).toHaveLength(1);
    expect(history[0].is_outside_workdir).toBe(1);
  });

  it('tracks file location anomalies and resolves them', () => {
    const task = createTask();

    fileTracking.recordFileLocationAnomaly(task.id, 'outside_workdir', '/tmp/stray.js', {
      expectedDirectory: '/project',
      actualDirectory: '/tmp',
      severity: 'warning',
      details: 'Unexpected output path',
    });

    const issues = fileTracking.getFileLocationAnomalies(task.id);
    expect(issues).toHaveLength(1);
    expect(issues[0].resolved).toBe(0);
    expect(issues[0].anomaly_type).toBe('outside_workdir');

    const resolved = fileTracking.resolveFileLocationAnomaly(issues[0].id);
    expect(resolved.resolved).toBe(1);
    expect(typeof resolved.resolved_at).toBe('string');
    expect(resolved.resolved_at).toMatch(/\d{4}-\d{2}-\d{2}T/);

    const open = fileTracking.getFileLocationAnomalies(task.id);
    expect(open).toHaveLength(0);

    const all = fileTracking.getFileLocationAnomalies(task.id, true);
    expect(all).toHaveLength(1);
  });

  it('checks location anomalies for unexpected output locations', () => {
    const task = createTask();
    const workDir = nextTaskDir(task.id);
    const expected = path.join(workDir, 'src');
    fs.mkdirSync(expected, { recursive: true });
    const unexpected = path.join(workDir, 'tmp', 'artifact.js');
    fs.mkdirSync(path.dirname(unexpected), { recursive: true });
    fs.writeFileSync(unexpected, 'x', 'utf8');

    fileTracking.setExpectedOutputPath(task.id, expected, { allowSubdirs: false });
    fileTracking.recordFileChange(task.id, unexpected, 'created', { workingDirectory: workDir });

    const issues = fileTracking.checkFileLocationAnomalies(task.id, workDir);
    expect(Array.isArray(issues)).toBe(true);
    expect(issues).toHaveLength(1);
    expect(issues[0].anomaly_type).toBe('unexpected_location');

    const aggregate = fileTracking.getAllFileLocationIssues(task.id);
    expect(aggregate.total_issues).toBeGreaterThanOrEqual(1);
    expect(aggregate.anomalies).toHaveLength(1);
  });

  it('records and resolves duplicate detections', () => {
    const task = createTask();
    const result = fileTracking.recordDuplicateFile(task.id, 'widget.ts', ['/a/widget.ts', '/b/widget.ts'], {
      severity: 'warning',
      likelyCorrectPath: '/a/widget.ts',
    });

    expect(result.location_count).toBe(2);

    const duplicates = fileTracking.getDuplicateFileDetections(task.id);
    expect(duplicates).toHaveLength(1);

    const resolved = fileTracking.resolveDuplicateFile(duplicates[0].id);
    expect(resolved.resolved).toBe(1);

    const remaining = fileTracking.getDuplicateFileDetections(task.id);
    expect(remaining).toHaveLength(0);
  });

  it('supports rollback record lifecycle (create/read/complete)', () => {
    const task = createTask();

    const rollbackId = fileTracking.createRollback(
      task.id,
      'git',
      ['src/main.ts', 'src/old.ts'],
      'abc123',
      'pre-merge risk',
      'tester'
    );

    const latest = fileTracking.getRollback(task.id);
    expect(latest).toMatchObject({
      id: rollbackId,
      task_id: task.id,
      status: expect.any(String),
    });

    fileTracking.completeRollback(rollbackId, 'def456', 'completed');

    const completed = fileTracking.getRollback(task.id);
    expect(completed.status).toBe('completed');
    expect(completed.commit_after).toBe('def456');

    const completedRollbacks = fileTracking.listRollbacks('completed', 10);
    expect(completedRollbacks.length).toBeGreaterThanOrEqual(1);
  });

  it('backs up, restores, and records restore metadata', () => {
    const task = createTask();
    const workDir = nextTaskDir(task.id);
    const file = createFile(workDir, 'backup.js', 'original\n');

    const backup = fileTracking.createFileBackup(task.id, 'backup.js', workDir);
    expect(backup.created).toBe(true);

    const backups = fileTracking.getTaskBackups(task.id);
    expect(backups).toHaveLength(1);

    fs.writeFileSync(file, 'changed\n', 'utf8');
    const restored = fileTracking.restoreFileBackup(backups[0].id);
    expect(restored.restored).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('original\n');

    const backupRow = fileTracking.getTaskBackups(task.id).find((row) => row.id === backup.backupId);
    expect(typeof backupRow.restored_at).toBe('string');
    expect(backupRow.restored_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('creates and updates diff preview records', () => {
    const task = createTask();

    const previewId = fileTracking.createDiffPreview(task.id, 'diff --git a/x b/x\n+ok\n', 1, 0, 1);
    expect(previewId).toMatch(/^[a-f0-9-]{36}$/);

    const preview = fileTracking.getDiffPreview(task.id);
    expect(preview).toMatchObject({
      id: previewId,
      task_id: task.id,
      files_changed: 1,
      status: expect.any(String),
    });
    expect(preview.task_id).toBe(task.id);
    expect(preview.files_changed).toBe(1);

    fileTracking.markDiffReviewed(task.id, 'qa-tester');
    const reviewed = fileTracking.getDiffPreview(task.id);
    expect(reviewed.status).toBe('reviewed');
    expect(reviewed.reviewed_by).toBe('qa-tester');
    expect(typeof reviewed.reviewed_at).toBe('string');
    expect(reviewed.reviewed_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
