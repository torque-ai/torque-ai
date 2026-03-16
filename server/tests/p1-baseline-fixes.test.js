/**
 * Targeted regression tests for file-baseline correctness fixes:
 * - Auto-rollback uses stored backup content for modified files.
 * - Baseline diff detects content changes when size stays unchanged.
 * - Baselines store and compare SHA-256 checksums.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { setupTestDbModule, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');

let mod, testDir;

beforeAll(() => {
  ({ mod, testDir } = setupTestDbModule('../db/file-baselines', 'p1-baseline-fixes'));
});

afterAll(() => teardownTestDb());

beforeEach(() => {
  resetTables(['file_baselines', 'file_backups', 'task_file_changes', 'auto_rollbacks', 'tasks']);
});

describe('File baseline rollback and diff fixes', () => {
  it('restores modified file content from stored backup instead of git checkout', () => {
    const taskId = 'task-backup-rollback';
    rawDb().prepare('INSERT INTO tasks (id, status, task_description, working_directory, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, 'running', 'rollback test', testDir, new Date().toISOString());

    const relativePath = 'rollback-target.js';
    const fullPath = path.join(testDir, relativePath);
    const originalContent = 'original content from baseline';

    fs.writeFileSync(fullPath, originalContent, 'utf8');
    const backupResult = mod.createFileBackup(taskId, relativePath, testDir);
    expect(backupResult.created).toBe(true);

    fs.writeFileSync(fullPath, 'edited content that should be restored', 'utf8');
    mod.recordFileChange(taskId, relativePath, 'modified', { workingDirectory: testDir });

    const execSpy = vi.spyOn(require('child_process'), 'execFileSync');
    const result = mod.performAutoRollback(taskId, testDir, 'content test');

    expect(result.success).toBe(true);
    expect(execSpy).not.toHaveBeenCalled();
    expect(result.files).toHaveLength(1);
    expect(result.files[0].source).toBe('backup');
    expect(fs.readFileSync(fullPath, 'utf8')).toBe(originalContent);
  });

  it('detects content modifications when size does not change', () => {
    const taskId = 'task-size-stable';
    rawDb().prepare('INSERT INTO tasks (id, status, task_description, working_directory, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, 'running', 'size stable compare', testDir, new Date().toISOString());

    const filePath = 'same-size-change.js';
    const fullPath = path.join(testDir, filePath);
    fs.writeFileSync(fullPath, 'ABCDEF', 'utf8');

    const baseline = mod.captureFileBaseline(filePath, testDir, taskId);
    expect(baseline).toBeTruthy();

    fs.writeFileSync(fullPath, 'ABXDEF', 'utf8');
    const result = mod.compareFileToBaseline(filePath, testDir);

    expect(result.hasBaseline).toBe(true);
    expect(result.sizeDelta).toBe(0);
    expect(result.isContentChanged).toBe(true);
    expect(result.isHashChanged).toBe(true);
  });

  it('stores a sha256 checksum and compares it during diff', () => {
    const taskId = 'task-hash-diff';
    rawDb().prepare('INSERT INTO tasks (id, status, task_description, working_directory, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, 'running', 'hash compare', testDir, new Date().toISOString());

    const filePath = 'sha256-baseline.js';
    const fullPath = path.join(testDir, filePath);
    const originalContent = 'sha-checksum-content';
    const expectedHash = crypto.createHash('sha256').update(originalContent).digest('hex');

    fs.writeFileSync(fullPath, originalContent, 'utf8');
    const baselineResult = mod.captureFileBaseline(filePath, testDir, taskId);
    const row = mod.getFileBaseline(filePath, testDir);

    expect(baselineResult.checksum).toBe(expectedHash);
    expect(row.checksum).toBe(expectedHash);

    const unchanged = mod.compareFileToBaseline(filePath, testDir);
    expect(unchanged.hashMatch).toBe(true);
    expect(unchanged.isContentChanged).toBe(false);

    fs.writeFileSync(fullPath, `${originalContent}-edited`, 'utf8');
    const changed = mod.compareFileToBaseline(filePath, testDir);
    expect(changed.hashMatch).toBe(false);
    expect(changed.isContentChanged).toBe(true);
  });
});
