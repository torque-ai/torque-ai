const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const { setupE2eDb, teardownE2eDb } = require('./e2e-helpers');

let ctx;
let db;
let fileTracking;
let workDir;

function setup() {
  ctx = setupE2eDb('file-tracking');
  db = ctx.db;
  fileTracking = require('../db/file-tracking');
  workDir = path.join(ctx.testDir, 'workspace');
  fs.mkdirSync(workDir, { recursive: true });
}

async function teardown() {
  vi.restoreAllMocks();
  if (ctx) await teardownE2eDb(ctx);
  ctx = null;
  db = null;
  fileTracking = null;
  workDir = null;
}

function rawDb() {
  return db.getDbInstance();
}

function resetTables() {
  const conn = rawDb();
  const tables = [
    'file_baselines',
    'task_file_changes',
    'task_file_writes',
    'diff_previews',
    'file_backups',
    'task_rollbacks',
    'auto_rollbacks',
    'security_scans',
    'expected_output_paths',
    'file_location_anomalies',
    'duplicate_file_detections',
    'tasks',
  ];

  for (const table of tables) {
    try {
      conn.prepare(`DELETE FROM ${table}`).run();
    } catch {
      // Ignore tables unavailable in older schema states.
    }
  }

  try {
    conn.prepare("DELETE FROM security_rules WHERE id LIKE 'test-%'").run();
  } catch {
    // Ignore if table missing.
  }

  if (workDir) {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures.
    }
    fs.mkdirSync(workDir, { recursive: true });
  }
}

function createTask(overrides = {}) {
  const payload = {
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'file-tracking test task',
    working_directory: overrides.working_directory || workDir,
    status: overrides.status || 'running',
    priority: overrides.priority ?? 0,
    provider: overrides.provider || 'codex',
    model: overrides.model || null,
    ...overrides,
  };

  db.createTask(payload);
  return db.getTask(payload.id);
}

function createTestFile(relativePath, content = 'line1\nline2\n') {
  const fullPath = path.join(workDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

function readTestFile(relativePath) {
  return fs.readFileSync(path.join(workDir, relativePath), 'utf8');
}

function toForwardSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

function insertSecurityRule({ id, name, description, pattern, extensions, severity = 'warning', category = 'quality' }) {
  rawDb().prepare(`
    INSERT INTO security_rules (id, name, description, pattern, file_extensions, severity, category, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, name, description, pattern, extensions, severity, category, new Date().toISOString());
}

describe('file-tracking module (db-integrated)', () => {
  beforeAll(() => {
    setup();
  });

  afterAll(() => {
    teardown();
  });

  beforeEach(() => {
    resetTables();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Baseline Management', () => {
    it('captureFileBaseline stores file snapshots for a task', () => {
      const task = createTask();
      const content = 'const a = 1;\nconst b = 2;\n';
      createTestFile('src/baseline.js', content);

      const result = db.captureFileBaseline('src/baseline.js', workDir, task.id);
      const stored = rawDb()
        .prepare('SELECT * FROM file_baselines WHERE file_path = ? AND working_directory = ?')
        .get('src/baseline.js', workDir);

      expect(result).toEqual({
        size: Buffer.byteLength(content, 'utf8'),
        lines: content.split('\n').length,
        checksum: crypto.createHash('sha256').update(content).digest('hex'),
      });
      expect(stored.task_id).toBe(task.id);
      expect(stored.checksum).toBe(result.checksum);
      expect(stored.size_bytes).toBe(result.size);
    });

    it('getFileBaseline retrieves stored baselines', () => {
      createTestFile('src/retrieve.js', 'export const x = 1;\n');
      db.captureFileBaseline('src/retrieve.js', workDir, 'task-baseline');

      const baseline = db.getFileBaseline('src/retrieve.js', workDir);
      expect(baseline).toBeTruthy();
      expect(baseline.file_path).toBe('src/retrieve.js');
      expect(baseline.working_directory).toBe(workDir);
      expect(baseline.task_id).toBe('task-baseline');
    });

    it('captureDirectoryBaselines handles empty file list', async () => {
      const captured = await db.captureDirectoryBaselines(workDir);
      expect(captured).toEqual([]);
    });

    it('captureFileBaseline handles non-existent files gracefully', () => {
      const result = db.captureFileBaseline('missing/file.js', workDir, 'task-x');
      expect(result).toBeNull();
    });

    it('captureDirectoryBaselines captures only configured source extensions', async () => {
      createTestFile('src/a.js', 'console.log("a");\n');
      createTestFile('src/b.ts', 'export const b = 1;\n');
      createTestFile('src/c.txt', 'ignore me\n');

      const captured = (await db.captureDirectoryBaselines(workDir)).map(toForwardSlashes);

      expect(captured).toContain('src/a.js');
      expect(captured).toContain('src/b.ts');
      expect(captured).not.toContain('src/c.txt');
    });

    it('captureDirectoryBaselines skips node_modules and hidden directories', async () => {
      createTestFile('node_modules/pkg/ignored.js', 'module.exports = 1;\n');
      createTestFile('.git/hooks/ignored.js', 'echo test\n');
      createTestFile('src/kept.js', 'export default 1;\n');

      const captured = await db.captureDirectoryBaselines(workDir);
      const normalized = captured.map(toForwardSlashes);

      expect(normalized).toContain('src/kept.js');
      expect(normalized.some(p => p.includes('node_modules'))).toBe(false);
      expect(normalized.some(p => p.startsWith('.git/'))).toBe(false);
    });

    it('captureFileBaseline overwrites an existing baseline for the same path', () => {
      createTestFile('src/overwrite.js', 'short\n');
      const first = db.captureFileBaseline('src/overwrite.js', workDir, 'task-1');

      createTestFile('src/overwrite.js', 'short\nlonger line\n');
      const second = db.captureFileBaseline('src/overwrite.js', workDir, 'task-2');

      const baseline = db.getFileBaseline('src/overwrite.js', workDir);
      expect(second.size).toBeGreaterThan(first.size);
      expect(baseline.task_id).toBe('task-2');
      expect(baseline.size_bytes).toBe(second.size);
    });

    it('getFileBaseline returns undefined for unknown file/task combo', () => {
      const baseline = db.getFileBaseline('src/not-found.js', workDir);
      expect(baseline).toBeUndefined();
    });
  });

  describe('Modified File Tracking', () => {
    it('recordFileChange stores file paths', () => {
      const task = createTask();
      const absPath = path.join(workDir, 'src/store.js');
      fileTracking.recordFileChange(task.id, absPath, 'modified', {
        fileSizeBytes: 41,
        workingDirectory: workDir,
      });

      const rows = fileTracking.getTaskFileChanges(task.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].task_id).toBe(task.id);
      expect(rows[0].file_path).toBe(absPath);
      expect(rows[0].file_size_bytes).toBe(41);
    });

    it('getTaskFileChanges retrieves recorded files', () => {
      const task = createTask();
      fileTracking.recordFileChange(task.id, path.join(workDir, 'a.js'), 'created', { workingDirectory: workDir });
      fileTracking.recordFileChange(task.id, path.join(workDir, 'b.js'), 'modified', { workingDirectory: workDir });

      const changes = fileTracking.getTaskFileChanges(task.id);
      expect(changes).toHaveLength(2);
      const types = changes.map(c => c.change_type).sort();
      expect(types).toEqual(['created', 'modified']);
    });

    it('getTaskFileChanges returns empty array for unknown task', () => {
      const changes = fileTracking.getTaskFileChanges('task-does-not-exist');
      expect(changes).toEqual([]);
    });

    it('recordFileChange handles duplicates by storing each event', () => {
      const task = createTask();
      const filePath = path.join(workDir, 'dup.js');

      fileTracking.recordFileChange(task.id, filePath, 'modified', { workingDirectory: workDir });
      fileTracking.recordFileChange(task.id, filePath, 'modified', { workingDirectory: workDir });

      const changes = fileTracking.getTaskFileChanges(task.id);
      expect(changes).toHaveLength(2);
      expect(changes.every(c => c.file_path === filePath)).toBe(true);
    });

    it('recordFileChange marks paths outside working directory', () => {
      const task = createTask();
      const outsidePath = path.join(path.dirname(workDir), 'outside.js');

      const result = fileTracking.recordFileChange(task.id, outsidePath, 'created', {
        workingDirectory: workDir,
      });

      expect(result.is_outside_workdir).toBe(true);
      const [row] = fileTracking.getTaskFileChanges(task.id);
      expect(row.is_outside_workdir).toBe(1);
    });

    it('recordFileChange computes relative_path for files inside workdir', () => {
      const task = createTask();
      const filePath = path.join(workDir, 'src', 'inside.js');

      fileTracking.recordFileChange(task.id, filePath, 'modified', { workingDirectory: workDir });

      const [row] = fileTracking.getTaskFileChanges(task.id);
      expect(toForwardSlashes(row.relative_path)).toBe('src/inside.js');
      expect(row.is_outside_workdir).toBe(0);
    });

    it('recordFileChange handles missing workingDirectory gracefully', () => {
      const task = createTask();
      const result = fileTracking.recordFileChange(task.id, 'relative/path.js', 'modified');

      expect(result.task_id).toBe(task.id);
      expect(result.is_outside_workdir).toBe(false);

      const [row] = fileTracking.getTaskFileChanges(task.id);
      expect(row.relative_path).toBe('relative/path.js');
    });

    it('recordFileChange stores mixed change types for one task', () => {
      const task = createTask();
      fileTracking.recordFileChange(task.id, path.join(workDir, 'a.js'), 'created', { workingDirectory: workDir });
      fileTracking.recordFileChange(task.id, path.join(workDir, 'b.js'), 'deleted', { workingDirectory: workDir });
      fileTracking.recordFileChange(task.id, path.join(workDir, 'c.js'), 'modified', { workingDirectory: workDir });

      const types = fileTracking.getTaskFileChanges(task.id).map(r => r.change_type).sort();
      expect(types).toEqual(['created', 'deleted', 'modified']);
    });
  });

  describe('File Diff/Comparison', () => {
    it('compareFileToBaseline returns additions/deletions as positive/negative deltas', () => {
      createTestFile('src/diff.js', 'a\nb\n');
      db.captureFileBaseline('src/diff.js', workDir, 'task-diff');

      createTestFile('src/diff.js', 'a\nb\nc\n');
      const grown = db.compareFileToBaseline('src/diff.js', workDir);
      expect(grown.hasBaseline).toBe(true);
      expect(grown.sizeDelta).toBeGreaterThan(0);
      expect(grown.lineDelta).toBeGreaterThan(0);

      createTestFile('src/diff.js', 'a\n');
      const shrunk = db.compareFileToBaseline('src/diff.js', workDir);
      expect(shrunk.sizeDelta).toBeLessThan(0);
      expect(shrunk.lineDelta).toBeLessThan(0);
    });

    it('compareFileToBaseline handles new files with no baseline', () => {
      createTestFile('src/new-file.js', 'new content\n');
      const result = db.compareFileToBaseline('src/new-file.js', workDir);
      expect(result).toEqual({ hasBaseline: false });
    });

    it('compareFileToBaseline handles deleted files', () => {
      createTestFile('src/deleted.js', 'to be removed\n');
      db.captureFileBaseline('src/deleted.js', workDir, 'task-delete');
      fs.unlinkSync(path.join(workDir, 'src/deleted.js'));

      const result = db.compareFileToBaseline('src/deleted.js', workDir);
      expect(result.hasBaseline).toBe(true);
      expect(result.error).toMatch(/ENOENT|no such file/i);
    });

    it('compareFileToBaseline computes size delta accurately', () => {
      const original = '12345\n';
      const updated = '12345\n67890\n';
      createTestFile('src/size-delta.js', original);
      db.captureFileBaseline('src/size-delta.js', workDir, 'task-size');
      createTestFile('src/size-delta.js', updated);

      const result = db.compareFileToBaseline('src/size-delta.js', workDir);
      expect(result.sizeDelta).toBe(Buffer.byteLength(updated, 'utf8') - Buffer.byteLength(original, 'utf8'));
    });

    it('compareFileToBaseline computes line delta accurately', () => {
      const original = 'l1\nl2\n';
      const updated = 'l1\nl2\nl3\n';
      createTestFile('src/line-delta.js', original);
      db.captureFileBaseline('src/line-delta.js', workDir, 'task-lines');
      createTestFile('src/line-delta.js', updated);

      const result = db.compareFileToBaseline('src/line-delta.js', workDir);
      expect(result.lineDelta).toBe(updated.split('\n').length - original.split('\n').length);
    });

    it('compareFileToBaseline exposes baseline and current metadata', () => {
      createTestFile('src/meta.js', 'const n = 1;\n');
      db.captureFileBaseline('src/meta.js', workDir, 'task-meta');
      createTestFile('src/meta.js', 'const n = 2;\n');

      const result = db.compareFileToBaseline('src/meta.js', workDir);
      expect(result.baseline).toBeTruthy();
      expect(result.current).toBeTruthy();
      expect(result.current.size).toBeGreaterThan(0);
    });

    it('compareFileToBaseline marks significant shrinkage when below -25%', () => {
      createTestFile('src/significant.js', '1234567890\n1234567890\n1234567890\n');
      db.captureFileBaseline('src/significant.js', workDir, 'task-significant');
      createTestFile('src/significant.js', '1234567890\n1234\n');

      const result = db.compareFileToBaseline('src/significant.js', workDir);
      expect(result.sizeChangePercent).toBeLessThan(-25);
      expect(result.isSignificantlyShrunk).toBe(true);
    });

    it('compareFileToBaseline leaves shrink flags false for normal growth', () => {
      createTestFile('src/grow.js', 'x\ny\n');
      db.captureFileBaseline('src/grow.js', workDir, 'task-grow');
      createTestFile('src/grow.js', 'x\ny\nz\nmore\n');

      const result = db.compareFileToBaseline('src/grow.js', workDir);
      expect(result.sizeDelta).toBeGreaterThan(0);
      expect(result.isSignificantlyShrunk).toBe(false);
      expect(result.isTruncated).toBe(false);
    });
  });

  describe('File Quality Checks', () => {
    it('checkFileShrinkage detects >50% size decrease via compareFileToBaseline', () => {
      createTestFile('src/truncate.js', '0123456789\n0123456789\n0123456789\n0123456789\n');
      db.captureFileBaseline('src/truncate.js', workDir, 'task-truncate');
      createTestFile('src/truncate.js', 'tiny\n');

      const result = db.compareFileToBaseline('src/truncate.js', workDir);
      expect(result.sizeChangePercent).toBeLessThan(-50);
      expect(result.isTruncated).toBe(true);
    });

    it('checkFileShrinkage passes for normal-size changes', () => {
      createTestFile('src/no-truncate.js', 'abcdefghij\nabcdefghij\n');
      db.captureFileBaseline('src/no-truncate.js', workDir, 'task-notrunc');
      createTestFile('src/no-truncate.js', 'abcdefghij\nabcdefghi\n');

      const result = db.compareFileToBaseline('src/no-truncate.js', workDir);
      expect(result.sizeChangePercent).toBeGreaterThan(-50);
      expect(result.isTruncated).toBe(false);
    });

    it('detectStubContent-style rule finds TODO patterns via runSecurityScan', () => {
      const task = createTask();
      insertSecurityRule({
        id: 'test-todo-rule',
        name: 'TODO stub detector',
        description: 'Detect TODO placeholders',
        pattern: 'TODO',
        extensions: '.stub',
      });

      const issues = db.runSecurityScan(task.id, 'src/file.stub', 'real line\nTODO: implement\n');
      expect(issues.length).toBeGreaterThanOrEqual(1);
      expect(issues.some(i => i.codeSnippet.includes('TODO'))).toBe(true);
    });

    it('detectStubContent-style rule finds placeholder patterns via runSecurityScan', () => {
      const task = createTask();
      insertSecurityRule({
        id: 'test-placeholder-rule',
        name: 'Placeholder detector',
        description: 'Detect placeholder text',
        pattern: 'placeholder',
        extensions: '.stub2',
      });

      const issues = db.runSecurityScan(task.id, 'src/file.stub2', 'value\nplaceholder content\n');
      expect(issues).toHaveLength(1);
      expect(issues[0].lineNumber).toBe(2);
    });

    it('runSecurityScan returns empty issues when no rules match extension', () => {
      const task = createTask();
      const issues = db.runSecurityScan(task.id, 'src/no-rules.zzz', 'TODO\nplaceholder\n');
      expect(issues).toEqual([]);
    });

    it('getSecurityScanResults retrieves persisted scan findings', () => {
      const task = createTask();
      insertSecurityRule({
        id: 'test-secret-rule',
        name: 'Secret detector',
        description: 'Detect fake secret',
        pattern: 'secret\\s*=\\s*"',
        extensions: '.safe',
        severity: 'critical',
        category: 'secrets',
      });

      db.runSecurityScan(task.id, 'src/keys.safe', 'const secret = "abc";\n');
      const stored = db.getSecurityScanResults(task.id);
      expect(stored.length).toBeGreaterThanOrEqual(1);
      expect(stored[0].task_id).toBe(task.id);
    });

    it('detectTruncation semantics include negative lineDelta on heavy shrink', () => {
      createTestFile('src/line-trunc.js', '1\n2\n3\n4\n5\n');
      db.captureFileBaseline('src/line-trunc.js', workDir, 'task-line-trunc');
      createTestFile('src/line-trunc.js', '1\n2\n');

      const result = db.compareFileToBaseline('src/line-trunc.js', workDir);
      expect(result.lineDelta).toBeLessThan(0);
      expect(result.isSignificantlyShrunk).toBe(true);
    });
  });

  describe('Artifact Tracking (diff previews/backups)', () => {
    it('createDiffPreview stores diff artifact metadata', () => {
      const task = createTask();
      const previewId = db.createDiffPreview(task.id, 'diff --git a/x b/x\n+new line\n', 1, 1, 0);

      const row = rawDb().prepare('SELECT * FROM diff_previews WHERE id = ?').get(previewId);
      expect(row).toBeTruthy();
      expect(row.task_id).toBe(task.id);
      expect(row.status).toBe('pending');
    });

    it('getDiffPreview retrieves artifacts for task', () => {
      const task = createTask();
      db.createDiffPreview(task.id, 'diff --git a/y b/y\n-old\n+new\n', 1, 1, 1);

      const preview = db.getDiffPreview(task.id);
      expect(preview).toBeTruthy();
      expect(preview.files_changed).toBe(1);
      expect(preview.lines_added).toBe(1);
      expect(preview.lines_removed).toBe(1);
    });

    it('markDiffReviewed updates review metadata on diff artifact', () => {
      const task = createTask();
      db.createDiffPreview(task.id, 'diff --git a/r b/r\n', 1, 0, 0);

      db.markDiffReviewed(task.id, 'qa-user');
      const preview = db.getDiffPreview(task.id);
      expect(preview.status).toBe('reviewed');
      expect(preview.reviewed_by).toBe('qa-user');
      expect(preview.reviewed_at).toBeTruthy();
    });

    it('createDiffPreview enforces one artifact record per task', () => {
      const task = createTask();
      db.createDiffPreview(task.id, 'first diff', 1, 1, 0);

      expect(() => db.createDiffPreview(task.id, 'second diff', 1, 2, 1)).toThrow();
    });

    it('isDiffReviewRequired follows config toggle', () => {
      db.setConfig('diff_preview_required', '1');
      expect(db.isDiffReviewRequired()).toBe(true);

      db.setConfig('diff_preview_required', '0');
      expect(db.isDiffReviewRequired()).toBe(false);
    });
  });

  describe('Rollback', () => {
    it('createRollback stores rollback record', () => {
      const task = createTask();
      const rollbackId = db.createRollback(
        task.id,
        'git',
        ['src/a.js', 'src/b.js'],
        'abc123',
        'bad deploy',
        'test-user'
      );

      const rollback = rawDb().prepare('SELECT * FROM task_rollbacks WHERE id = ?').get(rollbackId);
      expect(rollback).toBeTruthy();
      expect(rollback.task_id).toBe(task.id);
      expect(rollback.rollback_type).toBe('git');
      expect(rollback.status).toBe('pending');
    });

    it('getRollback retrieves latest rollback for task', () => {
      const task = createTask();
      db.createRollback(task.id, 'git', ['src/one.js'], '111', 'first', 'tester');

      const rollback = db.getRollback(task.id);
      expect(rollback).toBeTruthy();
      expect(rollback.task_id).toBe(task.id);
      expect(rollback.reason).toBe('first');
    });

    it('completeRollback marks rollback completed with commit_after', () => {
      const task = createTask();
      const rollbackId = db.createRollback(task.id, 'git', ['src/z.js'], 'before', 'reason', 'tester');

      db.completeRollback(rollbackId, 'after', 'completed');
      const rollback = rawDb().prepare('SELECT * FROM task_rollbacks WHERE id = ?').get(rollbackId);
      expect(rollback.status).toBe('completed');
      expect(rollback.commit_after).toBe('after');
      expect(rollback.completed_at).toBeTruthy();
    });

    it('listRollbacks filters by status and limit', () => {
      const task1 = createTask();
      const task2 = createTask();

      const id1 = db.createRollback(task1.id, 'git', ['a.js'], 'c1', 'r1', 'u1');
      const id2 = db.createRollback(task2.id, 'git', ['b.js'], 'c2', 'r2', 'u2');
      db.completeRollback(id1, 'after-1', 'completed');
      db.completeRollback(id2, 'after-2', 'failed');

      const completed = db.listRollbacks('completed', 10);
      expect(completed.length).toBeGreaterThanOrEqual(1);
      expect(completed.every(r => r.status === 'completed')).toBe(true);

      const limited = db.listRollbacks(null, 1);
      expect(limited).toHaveLength(1);
    });

    it('createFileBackup stores backup and getTaskBackups retrieves it', () => {
      const task = createTask();
      createTestFile('src/backup.js', 'original\ncontent\n');

      const created = db.createFileBackup(task.id, 'src/backup.js', workDir);
      expect(created.created).toBe(true);

      const backups = db.getTaskBackups(task.id);
      expect(backups).toHaveLength(1);
      expect(backups[0].id).toBe(created.backupId);
      expect(backups[0].file_path).toBe('src/backup.js');
    });

    it('restoreFileBackup restores baseline content', () => {
      const task = createTask();
      createTestFile('src/restore.js', 'before\n');
      const { backupId } = db.createFileBackup(task.id, 'src/restore.js', workDir);

      createTestFile('src/restore.js', 'after\nchanged\n');
      const restored = db.restoreFileBackup(backupId);

      expect(restored.restored).toBe(true);
      expect(readTestFile('src/restore.js')).toBe('before\n');
    });

    it('restoreFileBackup handles missing baselines gracefully', () => {
      const result = db.restoreFileBackup('missing-backup-id');
      expect(result).toEqual({ restored: false, reason: 'Backup not found' });
    });

    it('performAutoRollback deletes created files and checks out modified files', () => {
      const task = createTask();
      const createdPath = createTestFile('generated/new-file.js', 'new\n');
      const modifiedPath = createTestFile('src/existing.js', 'old\n');

      fileTracking.recordFileChange(task.id, createdPath, 'created', { workingDirectory: workDir });
      fileTracking.recordFileChange(task.id, modifiedPath, 'modified', { workingDirectory: workDir });

      const execSpy = vi.spyOn(require('child_process'), 'execFileSync').mockImplementation(() => Buffer.from('ok'));
      const result = fileTracking.performAutoRollback(task.id, workDir, 'test-trigger', 2);

      expect(result.success).toBe(true);
      expect(result.files_processed).toBe(2);
      expect(fs.existsSync(createdPath)).toBe(false);
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['show', expect.stringContaining('HEAD~1')],
        expect.objectContaining({ cwd: workDir, stdio: 'pipe' })
      );

      const history = fileTracking.getAutoRollbackHistory(task.id);
      expect(history).toHaveLength(1);
      expect(history[0].trigger_reason).toBe('test-trigger');
    });

    it('performAutoRollback skips git show when HEAD~1 does not exist', () => {
      const task = createTask();
      const modifiedPath = createTestFile('src/existing.js', 'old\n');

      fileTracking.recordFileChange(task.id, modifiedPath, 'modified', { workingDirectory: workDir });

      const execSpy = vi.spyOn(require('child_process'), 'execFileSync').mockImplementation((command, args) => {
        if (command === 'git' && args[0] === 'rev-parse') {
          throw new Error('missing HEAD~1');
        }
        return Buffer.from('ok');
      });

      const result = fileTracking.performAutoRollback(task.id, workDir, 'test-trigger', 2);

      expect(result.success).toBe(false);
      expect(result.files_processed).toBe(0);
      expect(result.errors).toEqual([
        expect.objectContaining({
          path: modifiedPath,
          error: 'Cannot restore from HEAD~1: no previous commit exists',
        }),
      ]);
      expect(execSpy.mock.calls.some(([, args]) => args[0] === 'show')).toBe(false);
    });
  });
});
