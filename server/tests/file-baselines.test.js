/**
 * Tests for server/db/file-baselines.js
 *
 * Covers: baselines, backups, locks, rollbacks, auto-rollbacks,
 * expected output paths, file changes, location anomalies,
 * duplicate file detection, and similar-file search.
 */

const path = require('path');
const fs = require('fs');
const { setupTestDbModule, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');

let mod, testDir;

beforeAll(() => {
  ({ mod, testDir } = setupTestDbModule('../db/file-baselines', 'file-baselines'));
  // Disable FK enforcement — tests use bare task IDs without inserting task rows
  rawDb().pragma('foreign_keys = OFF');
});

afterAll(() => teardownTestDb());

beforeEach(() => {
  resetTables([
    'file_baselines', 'file_backups', 'file_locks', 'task_rollbacks',
    'auto_rollbacks', 'expected_output_paths', 'task_file_changes',
    'file_location_anomalies', 'duplicate_file_detections', 'similar_file_search',
    'tasks'
  ]);
});

// ============================================
// File Baselines
// ============================================

describe('captureFileBaseline', () => {
  it('captures baseline for an existing file', () => {
    const filePath = 'test-file.js';
    const content = 'const x = 1;\nconst y = 2;\n';
    fs.writeFileSync(path.join(testDir, filePath), content, 'utf8');

    const result = mod.captureFileBaseline(filePath, testDir, 'task-1');

    expect(result).not.toBeNull();
    expect(result.lines).toBe(3); // two lines + trailing newline
    expect(result.size).toBeGreaterThan(0);
    expect(result.checksum).toBeDefined();
    expect(typeof result.checksum).toBe('string');
    expect(result.checksum.length).toBe(64); // sha256 hex length
  });

  it('returns null for non-existent file', () => {
    const result = mod.captureFileBaseline('does-not-exist.js', testDir, 'task-1');
    expect(result).toBeNull();
  });

  it('upserts on conflict (same file_path + working_directory)', () => {
    const filePath = 'upsert-test.js';
    fs.writeFileSync(path.join(testDir, filePath), 'v1', 'utf8');
    mod.captureFileBaseline(filePath, testDir, 'task-1');

    // Modify and re-capture
    fs.writeFileSync(path.join(testDir, filePath), 'v2-longer-content', 'utf8');
    const result2 = mod.captureFileBaseline(filePath, testDir, 'task-2');

    expect(result2).not.toBeNull();
    // Should be only one row in the table due to UPSERT
    const rows = rawDb().prepare('SELECT * FROM file_baselines WHERE file_path = ? AND working_directory = ?').all(filePath, testDir);
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe('task-2');
  });
});

describe('getFileBaseline', () => {
  it('retrieves a previously captured baseline', () => {
    const filePath = 'get-baseline.ts';
    fs.writeFileSync(path.join(testDir, filePath), 'export const a = 1;', 'utf8');
    mod.captureFileBaseline(filePath, testDir);

    const baseline = mod.getFileBaseline(filePath, testDir);

    expect(baseline).toBeDefined();
    expect(baseline.file_path).toBe(filePath);
    expect(baseline.working_directory).toBe(testDir);
    expect(baseline.size_bytes).toBeGreaterThan(0);
  });

  it('returns undefined for unknown file', () => {
    const baseline = mod.getFileBaseline('unknown.js', testDir);
    expect(baseline).toBeUndefined();
  });
});

describe('compareFileToBaseline', () => {
  it('reports no baseline when file was never captured', () => {
    const result = mod.compareFileToBaseline('never-captured.js', testDir);
    expect(result.hasBaseline).toBe(false);
  });

  it('detects file size growth', () => {
    const filePath = 'compare-grow.js';
    fs.writeFileSync(path.join(testDir, filePath), 'a', 'utf8');
    mod.captureFileBaseline(filePath, testDir);

    // Now make the file bigger
    fs.writeFileSync(path.join(testDir, filePath), 'a'.repeat(1000), 'utf8');

    const result = mod.compareFileToBaseline(filePath, testDir);
    expect(result.hasBaseline).toBe(true);
    expect(result.sizeDelta).toBeGreaterThan(0);
    expect(result.isTruncated).toBe(false);
  });

  it('detects file truncation (>50% shrink)', () => {
    const filePath = 'compare-shrink.js';
    fs.writeFileSync(path.join(testDir, filePath), 'x'.repeat(200), 'utf8');
    mod.captureFileBaseline(filePath, testDir);

    // Shrink the file to less than 50%
    fs.writeFileSync(path.join(testDir, filePath), 'x'.repeat(10), 'utf8');

    const result = mod.compareFileToBaseline(filePath, testDir);
    expect(result.hasBaseline).toBe(true);
    expect(result.isTruncated).toBe(true);
    expect(result.isSignificantlyShrunk).toBe(true);
    expect(result.sizeChangePercent).toBeLessThan(-50);
  });

  it('detects significant shrink (>25%) but not truncation', () => {
    const filePath = 'compare-shrink-moderate.js';
    fs.writeFileSync(path.join(testDir, filePath), 'x'.repeat(100), 'utf8');
    mod.captureFileBaseline(filePath, testDir);

    // Shrink to ~60% (40% reduction)
    fs.writeFileSync(path.join(testDir, filePath), 'x'.repeat(60), 'utf8');

    const result = mod.compareFileToBaseline(filePath, testDir);
    expect(result.isSignificantlyShrunk).toBe(true);
    expect(result.isTruncated).toBe(false);
  });

  it('returns error if file was deleted after baseline', () => {
    const filePath = 'compare-deleted.js';
    fs.writeFileSync(path.join(testDir, filePath), 'content', 'utf8');
    mod.captureFileBaseline(filePath, testDir);

    fs.unlinkSync(path.join(testDir, filePath));

    const result = mod.compareFileToBaseline(filePath, testDir);
    expect(result.hasBaseline).toBe(true);
    expect(result.error).toBeDefined();
  });

  it('reports line delta correctly', () => {
    const filePath = 'compare-lines.js';
    fs.writeFileSync(path.join(testDir, filePath), 'a\nb\n', 'utf8');
    mod.captureFileBaseline(filePath, testDir);

    fs.writeFileSync(path.join(testDir, filePath), 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', 'utf8');

    const result = mod.compareFileToBaseline(filePath, testDir);
    expect(result.lineDelta).toBeGreaterThan(0);
    expect(result.current.lines).toBe(11);
  });
});

describe('captureDirectoryBaselines', () => {
  it('captures baselines for files matching extensions', () => {
    const subDir = path.join(testDir, 'dir-baseline-test');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'a.js'), 'const a = 1;', 'utf8');
    fs.writeFileSync(path.join(subDir, 'b.ts'), 'const b = 2;', 'utf8');
    fs.writeFileSync(path.join(subDir, 'c.txt'), 'not captured', 'utf8');

    const captured = mod.captureDirectoryBaselines(subDir, ['.js', '.ts']);

    expect(captured.length).toBe(2);
    expect(captured).toContain('a.js');
    expect(captured).toContain('b.ts');
  });

  it('recurses into subdirectories (skipping node_modules)', () => {
    const subDir = path.join(testDir, 'dir-recurse-test');
    const nested = path.join(subDir, 'src');
    const nodeModules = path.join(subDir, 'node_modules');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(path.join(nested, 'd.js'), 'x', 'utf8');
    fs.writeFileSync(path.join(nodeModules, 'lib.js'), 'y', 'utf8');

    const captured = mod.captureDirectoryBaselines(subDir, ['.js']);

    // Should capture nested/d.js but not node_modules/lib.js
    const capturedNames = captured.map(c => path.basename(c));
    expect(capturedNames).toContain('d.js');
    expect(capturedNames).not.toContain('lib.js');
  });

  it('skips bin and obj directories', () => {
    const subDir = path.join(testDir, 'dir-skip-test');
    const binDir = path.join(subDir, 'bin');
    const objDir = path.join(subDir, 'obj');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(objDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'output.js'), 'compiled', 'utf8');
    fs.writeFileSync(path.join(objDir, 'temp.js'), 'temp', 'utf8');

    const captured = mod.captureDirectoryBaselines(subDir, ['.js']);
    expect(captured).toHaveLength(0);
  });

  it('returns empty array for directory with no matching files', () => {
    const emptyDir = path.join(testDir, 'dir-empty-test');
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.writeFileSync(path.join(emptyDir, 'readme.md'), '# Hello', 'utf8');

    const captured = mod.captureDirectoryBaselines(emptyDir, ['.js', '.ts']);
    expect(captured).toHaveLength(0);
  });
});

// ============================================
// File Backups
// ============================================

describe('createFileBackup', () => {
  it('creates a backup of an existing file', () => {
    const filePath = 'backup-me.js';
    fs.writeFileSync(path.join(testDir, filePath), 'original content', 'utf8');

    const result = mod.createFileBackup('task-bk1', filePath, testDir);

    expect(result.created).toBe(true);
    expect(result.backupId).toBeDefined();
    expect(typeof result.backupId).toBe('string');
  });

  it('returns created=false for non-existent file', () => {
    const result = mod.createFileBackup('task-bk2', 'nope.js', testDir);
    expect(result.created).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('stores original content and size in the database', () => {
    const filePath = 'backup-content.js';
    const content = 'const important = true;';
    fs.writeFileSync(path.join(testDir, filePath), content, 'utf8');

    const { backupId } = mod.createFileBackup('task-bk-content', filePath, testDir);

    const row = rawDb().prepare('SELECT * FROM file_backups WHERE id = ?').get(backupId);
    expect(row.original_content).toBe(content);
    expect(row.original_size).toBe(Buffer.byteLength(content));
    expect(row.task_id).toBe('task-bk-content');
  });
});

describe('getTaskBackups', () => {
  it('lists backups for a task', () => {
    const filePath = 'multi-backup.js';
    fs.writeFileSync(path.join(testDir, filePath), 'v1', 'utf8');
    mod.createFileBackup('task-bk3', filePath, testDir);

    const filePath2 = 'multi-backup-2.js';
    fs.writeFileSync(path.join(testDir, filePath2), 'v2', 'utf8');
    mod.createFileBackup('task-bk3', filePath2, testDir);

    const backups = mod.getTaskBackups('task-bk3');
    expect(backups).toHaveLength(2);
    expect(backups[0].task_id).toBe('task-bk3');
  });

  it('returns empty array for task with no backups', () => {
    const backups = mod.getTaskBackups('task-no-backups');
    expect(backups).toEqual([]);
  });

  it('orders backups by created_at descending', () => {
    fs.writeFileSync(path.join(testDir, 'order-a.js'), 'a', 'utf8');
    fs.writeFileSync(path.join(testDir, 'order-b.js'), 'b', 'utf8');
    mod.createFileBackup('task-bk-order', 'order-a.js', testDir);
    mod.createFileBackup('task-bk-order', 'order-b.js', testDir);

    const backups = mod.getTaskBackups('task-bk-order');
    // Most recent first
    expect(backups[0].created_at >= backups[1].created_at).toBe(true);
  });
});

describe('restoreFileBackup', () => {
  it('restores a file from backup', () => {
    const filePath = 'restore-test.js';
    const originalContent = 'original-restore-content';
    fs.writeFileSync(path.join(testDir, filePath), originalContent, 'utf8');

    const { backupId } = mod.createFileBackup('task-restore', filePath, testDir);

    // Modify the file
    fs.writeFileSync(path.join(testDir, filePath), 'modified!', 'utf8');

    const result = mod.restoreFileBackup(backupId);
    expect(result.restored).toBe(true);

    // Verify file content is restored
    const restored = fs.readFileSync(path.join(testDir, filePath), 'utf8');
    expect(restored).toBe(originalContent);
  });

  it('returns restored=false for unknown backup id', () => {
    const result = mod.restoreFileBackup('nonexistent-backup-id');
    expect(result.restored).toBe(false);
    expect(result.reason).toContain('Backup not found');
  });

  it('sets restored_at timestamp after restore', () => {
    const filePath = 'restore-ts.js';
    fs.writeFileSync(path.join(testDir, filePath), 'data', 'utf8');
    const { backupId } = mod.createFileBackup('task-restore-ts', filePath, testDir);

    mod.restoreFileBackup(backupId);

    const row = rawDb().prepare('SELECT restored_at FROM file_backups WHERE id = ?').get(backupId);
    expect(row.restored_at).toBeDefined();
    expect(row.restored_at).not.toBeNull();
  });
});

// ============================================
// File Locks
// ============================================

describe('acquireFileLock', () => {
  it('acquires a lock on a file', () => {
    const result = mod.acquireFileLock('app.js', testDir, 'task-lk1');
    expect(result.acquired).toBe(true);
  });

  it('allows the same task to re-acquire its own lock', () => {
    mod.acquireFileLock('reacquire.js', testDir, 'task-lk2');
    const result = mod.acquireFileLock('reacquire.js', testDir, 'task-lk2');
    expect(result.acquired).toBe(true);
  });

  it('blocks a different task from acquiring a lock held by another', () => {
    mod.acquireFileLock('shared.js', testDir, 'task-lk3');
    const result = mod.acquireFileLock('shared.js', testDir, 'task-lk4');
    expect(result.acquired).toBe(false);
    expect(result.reason).toContain('locked by task');
    expect(result.lockedBy).toBe('task-lk3');
  });

  it('allows different files to be locked by different tasks', () => {
    const r1 = mod.acquireFileLock('file-a.js', testDir, 'task-lk-a');
    const r2 = mod.acquireFileLock('file-b.js', testDir, 'task-lk-b');
    expect(r1.acquired).toBe(true);
    expect(r2.acquired).toBe(true);
  });
});

describe('releaseFileLock', () => {
  it('releases a lock so another task can acquire it', () => {
    mod.acquireFileLock('release-me.js', testDir, 'task-lk5');
    mod.releaseFileLock('release-me.js', testDir, 'task-lk5');

    const result = mod.acquireFileLock('release-me.js', testDir, 'task-lk6');
    expect(result.acquired).toBe(true);
  });
});

describe('releaseAllFileLocks', () => {
  it('releases all active locks for a task', () => {
    mod.acquireFileLock('file-a.js', testDir, 'task-lk7');
    mod.acquireFileLock('file-b.js', testDir, 'task-lk7');

    mod.releaseAllFileLocks('task-lk7');

    const locks = mod.getActiveFileLocks('task-lk7');
    expect(locks).toHaveLength(0);
  });

  it('does not affect locks from other tasks', () => {
    mod.acquireFileLock('other-file.js', testDir, 'task-lk-other');
    mod.acquireFileLock('my-file.js', testDir, 'task-lk-mine');

    mod.releaseAllFileLocks('task-lk-mine');

    const otherLocks = mod.getActiveFileLocks('task-lk-other');
    expect(otherLocks).toHaveLength(1);
  });
});

describe('getActiveFileLocks', () => {
  it('returns active locks for a task', () => {
    mod.acquireFileLock('lock-list-a.js', testDir, 'task-lk8');
    mod.acquireFileLock('lock-list-b.js', testDir, 'task-lk8');

    const locks = mod.getActiveFileLocks('task-lk8');
    expect(locks).toHaveLength(2);
    expect(locks[0].task_id).toBe('task-lk8');
  });

  it('returns all active locks when no taskId given', () => {
    mod.acquireFileLock('global-a.js', testDir, 'task-lk9');
    mod.acquireFileLock('global-b.js', testDir, 'task-lk10');

    const allLocks = mod.getActiveFileLocks();
    expect(allLocks.length).toBeGreaterThanOrEqual(2);
  });

  it('does not return released locks', () => {
    mod.acquireFileLock('released.js', testDir, 'task-lk11');
    mod.releaseFileLock('released.js', testDir, 'task-lk11');

    const locks = mod.getActiveFileLocks('task-lk11');
    expect(locks).toHaveLength(0);
  });
});

// ============================================
// Task Rollbacks
// ============================================

describe('createRollback', () => {
  it('creates a rollback record', () => {
    const id = mod.createRollback('task-rb1', 'git', ['file1.js', 'file2.js'], 'abc123', 'build failed', 'system');

    expect(id).toBeDefined();
    expect(typeof id).toBe('string');

    const record = mod.getRollback('task-rb1');
    expect(record).toBeDefined();
    expect(record.task_id).toBe('task-rb1');
    expect(record.rollback_type).toBe('git');
    expect(record.reason).toBe('build failed');
    expect(record.status).toBe('pending');
    expect(record.initiated_by).toBe('system');
    expect(JSON.parse(record.files_affected)).toEqual(['file1.js', 'file2.js']);
  });
});

describe('getRollback', () => {
  it('returns a rollback for a task with multiple rollbacks', () => {
    mod.createRollback('task-rb-multi', 'git', [], 'c1', 'first', 'sys');
    mod.createRollback('task-rb-multi', 'manual', [], 'c2', 'second', 'user');

    const record = mod.getRollback('task-rb-multi');
    // Should return one of the rollbacks (ORDER BY initiated_at DESC LIMIT 1)
    expect(record).toBeDefined();
    expect(record.task_id).toBe('task-rb-multi');
    expect(['first', 'second']).toContain(record.reason);
  });

  it('returns undefined for task with no rollbacks', () => {
    const record = mod.getRollback('task-no-rollback');
    expect(record).toBeUndefined();
  });
});

describe('completeRollback', () => {
  it('marks a rollback as completed', () => {
    const id = mod.createRollback('task-rb2', 'git', [], 'def456', 'test failure', 'user');
    mod.completeRollback(id, 'ghi789', 'completed');

    const record = mod.getRollback('task-rb2');
    expect(record.status).toBe('completed');
    expect(record.commit_after).toBe('ghi789');
    expect(record.completed_at).toBeDefined();
  });

  it('supports custom status values', () => {
    const id = mod.createRollback('task-rb-fail', 'git', [], 'c1', 'reason', 'sys');
    mod.completeRollback(id, null, 'failed');

    const record = mod.getRollback('task-rb-fail');
    expect(record.status).toBe('failed');
  });
});

describe('listRollbacks', () => {
  it('lists all rollbacks', () => {
    mod.createRollback('task-rb3', 'git', [], 'c1', 'r1', 'sys');
    mod.createRollback('task-rb4', 'git', [], 'c2', 'r2', 'sys');

    const all = mod.listRollbacks();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by status', () => {
    const id1 = mod.createRollback('task-rb5', 'git', [], 'c3', 'r3', 'sys');
    mod.createRollback('task-rb6', 'git', [], 'c4', 'r4', 'sys');
    mod.completeRollback(id1, 'c5', 'completed');

    const pending = mod.listRollbacks('pending');
    expect(pending.every(r => r.status === 'pending')).toBe(true);

    const completed = mod.listRollbacks('completed');
    expect(completed.every(r => r.status === 'completed')).toBe(true);
    expect(completed.length).toBeGreaterThanOrEqual(1);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      mod.createRollback(`task-rb-lim-${i}`, 'git', [], `c${i}`, `r${i}`, 'sys');
    }

    const limited = mod.listRollbacks(null, 3);
    expect(limited).toHaveLength(3);
  });
});

// ============================================
// Auto-Rollbacks
// ============================================

describe('recordAutoRollback', () => {
  it('records an auto-rollback event', () => {
    const result = mod.recordAutoRollback('task-ar1', 'build_failure', [{ path: 'x.js', action: 'restored' }]);

    expect(result.task_id).toBe('task-ar1');
    expect(result.trigger_reason).toBe('build_failure');
    expect(result.success).toBe(true);
  });

  it('records a failed auto-rollback', () => {
    const result = mod.recordAutoRollback('task-ar2', 'test_failure', [], {
      success: false,
      errorMessage: 'git checkout failed'
    });

    expect(result.success).toBe(false);

    // Verify error_message is stored
    const rows = mod.getAutoRollbackHistory('task-ar2');
    expect(rows).toHaveLength(1);
    expect(rows[0].error_message).toBe('git checkout failed');
  });

  it('stores rollback_commit when provided', () => {
    mod.recordAutoRollback('task-ar-commit', 'truncation', ['file.js'], {
      rollbackCommit: 'abc123'
    });

    const history = mod.getAutoRollbackHistory('task-ar-commit');
    expect(history).toHaveLength(1);
    expect(history[0].rollback_commit).toBe('abc123');
  });
});

describe('getAutoRollbackHistory', () => {
  it('retrieves history for a specific task', () => {
    mod.recordAutoRollback('task-ar3', 'reason1', []);
    mod.recordAutoRollback('task-ar3', 'reason2', []);

    const history = mod.getAutoRollbackHistory('task-ar3');
    expect(history).toHaveLength(2);
  });

  it('retrieves all history when no taskId given', () => {
    mod.recordAutoRollback('task-ar4', 'reason-a', []);
    mod.recordAutoRollback('task-ar5', 'reason-b', []);

    const allHistory = mod.getAutoRollbackHistory();
    expect(allHistory.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for task with no auto-rollbacks', () => {
    const history = mod.getAutoRollbackHistory('task-ar-none');
    expect(history).toEqual([]);
  });
});

// ============================================
// Expected Output Paths
// ============================================

describe('setExpectedOutputPath', () => {
  it('sets an expected output directory for a task', () => {
    const result = mod.setExpectedOutputPath('task-eo1', '/project/src');

    expect(result.task_id).toBe('task-eo1');
    expect(result.expected_directory).toBe('/project/src');
  });

  it('supports multiple expected paths per task', () => {
    mod.setExpectedOutputPath('task-eo2', '/project/src');
    mod.setExpectedOutputPath('task-eo2', '/project/tests');

    const paths = mod.getExpectedOutputPaths('task-eo2');
    expect(paths).toHaveLength(2);
  });

  it('stores allow_subdirs and file_patterns options', () => {
    mod.setExpectedOutputPath('task-eo3', '/project/strict', {
      allowSubdirs: false,
      filePatterns: ['*.ts', '*.js']
    });

    const paths = mod.getExpectedOutputPaths('task-eo3');
    expect(paths).toHaveLength(1);
    expect(paths[0].allow_subdirs).toBe(0);
    expect(JSON.parse(paths[0].file_patterns)).toEqual(['*.ts', '*.js']);
  });

  it('defaults allow_subdirs to true', () => {
    mod.setExpectedOutputPath('task-eo-default', '/project/src');

    const paths = mod.getExpectedOutputPaths('task-eo-default');
    expect(paths[0].allow_subdirs).toBe(1);
  });
});

describe('getExpectedOutputPaths', () => {
  it('returns empty array for unknown task', () => {
    const paths = mod.getExpectedOutputPaths('task-no-paths');
    expect(paths).toEqual([]);
  });
});

// ============================================
// File Changes
// ============================================

describe('recordFileChange', () => {
  it('records a created file change', () => {
    const result = mod.recordFileChange('task-fc1', '/project/new.js', 'created');

    expect(result.task_id).toBe('task-fc1');
    expect(result.file_path).toBe('/project/new.js');
  });

  it('detects file outside working directory', () => {
    const result = mod.recordFileChange('task-fc2', '/other/dir/file.js', 'modified', {
      workingDirectory: '/project'
    });

    expect(result.is_outside_workdir).toBe(true);
  });

  it('computes relative path when inside working directory', () => {
    const workDir = path.join(testDir, 'fc-workdir');
    const filePath = path.join(workDir, 'src', 'main.js');

    const result = mod.recordFileChange('task-fc3', filePath, 'modified', {
      workingDirectory: workDir
    });

    expect(result.is_outside_workdir).toBe(false);

    const changes = mod.getTaskFileChanges('task-fc3');
    expect(changes).toHaveLength(1);
    // relative_path should be something like 'src/main.js' or 'src\main.js'
    expect(changes[0].relative_path).toMatch(/src/);
    expect(changes[0].is_outside_workdir).toBe(0);
  });

  it('stores file_size_bytes when provided', () => {
    mod.recordFileChange('task-fc-size', '/project/big.js', 'created', {
      fileSizeBytes: 12345
    });

    const changes = mod.getTaskFileChanges('task-fc-size');
    expect(changes[0].file_size_bytes).toBe(12345);
  });
});

describe('getTaskFileChanges', () => {
  it('returns all changes for a task', () => {
    mod.recordFileChange('task-fc4', 'file1.js', 'created');
    mod.recordFileChange('task-fc4', 'file2.js', 'modified');
    mod.recordFileChange('task-fc4', 'file3.js', 'deleted');

    const changes = mod.getTaskFileChanges('task-fc4');
    expect(changes).toHaveLength(3);
    const types = changes.map(c => c.change_type);
    expect(types).toContain('created');
    expect(types).toContain('modified');
    expect(types).toContain('deleted');
  });

  it('returns empty array for unknown task', () => {
    const changes = mod.getTaskFileChanges('no-such-task');
    expect(changes).toEqual([]);
  });
});

// ============================================
// File Location Anomalies
// ============================================

describe('recordFileLocationAnomaly', () => {
  it('records an anomaly', () => {
    const result = mod.recordFileLocationAnomaly('task-fla1', 'outside_workdir', '/tmp/stray.js', {
      expectedDirectory: '/project',
      actualDirectory: '/tmp',
      severity: 'error',
      details: 'File created outside working directory'
    });

    expect(result.task_id).toBe('task-fla1');
    expect(result.anomaly_type).toBe('outside_workdir');
  });

  it('stores all optional fields', () => {
    mod.recordFileLocationAnomaly('task-fla-full', 'unexpected_location', '/wrong/file.js', {
      expectedDirectory: '/right',
      actualDirectory: '/wrong',
      severity: 'error',
      details: 'Wrong place'
    });

    const anomalies = mod.getFileLocationAnomalies('task-fla-full');
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].expected_directory).toBe('/right');
    expect(anomalies[0].actual_directory).toBe('/wrong');
    expect(anomalies[0].severity).toBe('error');
    expect(anomalies[0].details).toBe('Wrong place');
  });
});

describe('getFileLocationAnomalies', () => {
  it('returns unresolved anomalies by default', () => {
    mod.recordFileLocationAnomaly('task-fla2', 'outside_workdir', '/tmp/a.js');
    mod.recordFileLocationAnomaly('task-fla2', 'unexpected_location', '/project/wrong/b.js');

    const anomalies = mod.getFileLocationAnomalies('task-fla2');
    expect(anomalies).toHaveLength(2);
    expect(anomalies.every(a => a.resolved === 0)).toBe(true);
  });
});

describe('resolveFileLocationAnomaly', () => {
  it('marks an anomaly as resolved', () => {
    mod.recordFileLocationAnomaly('task-fla3', 'outside_workdir', '/tmp/c.js');
    const anomalies = mod.getFileLocationAnomalies('task-fla3');
    const anomalyId = anomalies[0].id;

    const resolved = mod.resolveFileLocationAnomaly(anomalyId);
    expect(resolved.resolved).toBe(1);
    expect(resolved.resolved_at).toBeDefined();

    // Should no longer appear in default (unresolved) query
    const remaining = mod.getFileLocationAnomalies('task-fla3');
    expect(remaining).toHaveLength(0);

    // But should appear when including resolved
    const all = mod.getFileLocationAnomalies('task-fla3', true);
    expect(all).toHaveLength(1);
  });
});

describe('checkFileLocationAnomalies', () => {
  it('detects files created outside working directory', () => {
    const workDir = path.normalize('/project/root');
    const outsideFile = path.normalize('/other/place/file.js');

    mod.recordFileChange('task-cla1', outsideFile, 'created', {
      workingDirectory: workDir
    });

    const anomalies = mod.checkFileLocationAnomalies('task-cla1', workDir);
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    expect(anomalies[0].anomaly_type).toBe('outside_workdir');
  });

  it('detects files in unexpected locations when expected paths are set', () => {
    const workDir = testDir;
    const expectedDir = path.join(testDir, 'src');
    const unexpectedFile = path.join(testDir, 'other', 'file.js');
    fs.mkdirSync(path.join(testDir, 'other'), { recursive: true });

    mod.setExpectedOutputPath('task-cla2', expectedDir, { allowSubdirs: true });
    mod.recordFileChange('task-cla2', unexpectedFile, 'created', {
      workingDirectory: workDir
    });

    const anomalies = mod.checkFileLocationAnomalies('task-cla2', workDir);
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    expect(anomalies[0].anomaly_type).toBe('unexpected_location');
  });

  it('returns no anomalies when files are in expected locations', () => {
    const workDir = testDir;
    const expectedDir = path.join(testDir, 'expected-src');
    const goodFile = path.join(expectedDir, 'good.js');
    fs.mkdirSync(expectedDir, { recursive: true });

    mod.setExpectedOutputPath('task-cla3', expectedDir, { allowSubdirs: true });
    mod.recordFileChange('task-cla3', goodFile, 'created', {
      workingDirectory: workDir
    });

    const anomalies = mod.checkFileLocationAnomalies('task-cla3', workDir);
    expect(anomalies).toHaveLength(0);
  });

  it('skips deleted file changes', () => {
    mod.recordFileChange('task-cla-del', '/outside/deleted.js', 'deleted', {
      workingDirectory: testDir
    });

    const anomalies = mod.checkFileLocationAnomalies('task-cla-del', testDir);
    expect(anomalies).toHaveLength(0);
  });
});

// ============================================
// Duplicate File Detection
// ============================================

describe('recordDuplicateFile', () => {
  it('records a duplicate file detection', () => {
    const locations = ['/project/src/Foo.ts', '/project/lib/Foo.ts'];
    const result = mod.recordDuplicateFile('task-dup1', 'Foo.ts', locations, {
      severity: 'warning',
      likelyCorrectPath: '/project/src/Foo.ts'
    });

    expect(result.task_id).toBe('task-dup1');
    expect(result.file_name).toBe('Foo.ts');
    expect(result.location_count).toBe(2);
  });
});

describe('getDuplicateFileDetections', () => {
  it('returns unresolved detections by default', () => {
    mod.recordDuplicateFile('task-dup2', 'Bar.ts', ['/a/Bar.ts', '/b/Bar.ts']);

    const dups = mod.getDuplicateFileDetections('task-dup2');
    expect(dups).toHaveLength(1);
    expect(dups[0].resolved).toBe(0);
  });
});

describe('resolveDuplicateFile', () => {
  it('marks a duplicate detection as resolved', () => {
    mod.recordDuplicateFile('task-dup3', 'Baz.ts', ['/x/Baz.ts', '/y/Baz.ts']);
    const dups = mod.getDuplicateFileDetections('task-dup3');
    const detId = dups[0].id;

    const resolved = mod.resolveDuplicateFile(detId);
    expect(resolved.resolved).toBe(1);

    const remaining = mod.getDuplicateFileDetections('task-dup3');
    expect(remaining).toHaveLength(0);
  });
});

describe('checkDuplicateFiles', () => {
  it('detects duplicate filenames in a directory tree', () => {
    const scanDir = path.join(testDir, 'dup-scan');
    const dirA = path.join(scanDir, 'dirA');
    const dirB = path.join(scanDir, 'dirB');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'Widget.js'), 'export class Widget {}', 'utf8');
    fs.writeFileSync(path.join(dirB, 'Widget.js'), 'export class Widget2 {}', 'utf8');

    const dups = mod.checkDuplicateFiles('task-dup4', scanDir, { fileExtensions: ['.js'] });

    expect(dups.length).toBeGreaterThanOrEqual(1);
    const widgetDup = dups.find(d => d.file_name === 'Widget.js');
    expect(widgetDup).toBeDefined();
    expect(widgetDup.location_count).toBe(2);
    expect(widgetDup.locations).toHaveLength(2);
  });

  it('returns empty when no duplicates', () => {
    const scanDir = path.join(testDir, 'no-dup');
    fs.mkdirSync(scanDir, { recursive: true });
    fs.writeFileSync(path.join(scanDir, 'unique.js'), 'x', 'utf8');

    const dups = mod.checkDuplicateFiles('task-dup5', scanDir, { fileExtensions: ['.js'] });
    expect(dups).toHaveLength(0);
  });

  it('skips node_modules and .git directories', () => {
    const scanDir = path.join(testDir, 'dup-skip');
    const nmDir = path.join(scanDir, 'node_modules', 'pkg');
    const srcDir = path.join(scanDir, 'src');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'x', 'utf8');
    fs.writeFileSync(path.join(srcDir, 'index.js'), 'y', 'utf8');

    const dups = mod.checkDuplicateFiles('task-dup-skip', scanDir, { fileExtensions: ['.js'] });
    // index.js in node_modules should be skipped, so no duplicate
    expect(dups).toHaveLength(0);
  });
});

// ============================================
// getAllFileLocationIssues
// ============================================

describe('getAllFileLocationIssues', () => {
  it('aggregates anomalies and duplicates', () => {
    mod.recordFileLocationAnomaly('task-all1', 'outside_workdir', '/tmp/x.js');
    mod.recordDuplicateFile('task-all1', 'Y.js', ['/a/Y.js', '/b/Y.js']);

    const issues = mod.getAllFileLocationIssues('task-all1');
    expect(issues.total_issues).toBe(2);
    expect(issues.anomalies).toHaveLength(1);
    expect(issues.duplicates).toHaveLength(1);
    expect(Array.isArray(issues.duplicates[0].locations)).toBe(true);
  });

  it('returns zero issues for clean task', () => {
    const issues = mod.getAllFileLocationIssues('task-clean');
    expect(issues.total_issues).toBe(0);
    expect(issues.anomalies).toHaveLength(0);
    expect(issues.duplicates).toHaveLength(0);
  });

  it('parses JSON locations in duplicates', () => {
    mod.recordDuplicateFile('task-all-json', 'Z.ts', ['/p/Z.ts', '/q/Z.ts', '/r/Z.ts']);

    const issues = mod.getAllFileLocationIssues('task-all-json');
    expect(issues.duplicates[0].locations).toEqual(['/p/Z.ts', '/q/Z.ts', '/r/Z.ts']);
  });
});

// ============================================
// Similar File Search
// ============================================

describe('searchSimilarFiles', () => {
  it('finds files by filename match', () => {
    const searchDir = path.join(testDir, 'similar-search');
    fs.mkdirSync(searchDir, { recursive: true });
    fs.writeFileSync(path.join(searchDir, 'UserService.ts'), 'export class UserService {}', 'utf8');
    fs.writeFileSync(path.join(searchDir, 'UserController.ts'), 'export class UserController {}', 'utf8');
    fs.writeFileSync(path.join(searchDir, 'OrderService.ts'), 'export class OrderService {}', 'utf8');

    const result = mod.searchSimilarFiles('task-sf1', 'UserService', searchDir, 'filename');

    expect(result.matches_found).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe('similar_files_exist');
    expect(result.matches.some(m => m.includes('UserService'))).toBe(true);
    expect(result.recommendation).toContain('similar file');
  });

  it('returns no matches for non-existent term', () => {
    const searchDir = path.join(testDir, 'similar-empty');
    fs.mkdirSync(searchDir, { recursive: true });
    fs.writeFileSync(path.join(searchDir, 'App.js'), 'x', 'utf8');

    const result = mod.searchSimilarFiles('task-sf2', 'ZzzzNonExistent', searchDir, 'filename');

    expect(result.matches_found).toBe(0);
    expect(result.status).toBe('no_matches');
    expect(result.recommendation).toBeNull();
  });

  it('searches by classname inside file content', () => {
    const searchDir = path.join(testDir, 'class-search');
    fs.mkdirSync(searchDir, { recursive: true });
    fs.writeFileSync(path.join(searchDir, 'services.ts'), 'export class PaymentProcessor { }', 'utf8');
    fs.writeFileSync(path.join(searchDir, 'other.ts'), 'const x = 1;', 'utf8');

    const result = mod.searchSimilarFiles('task-sf3', 'PaymentProcessor', searchDir, 'classname');

    expect(result.matches_found).toBe(1);
    expect(result.matches[0]).toContain('services.ts');
  });

  it('finds partial filename matches', () => {
    const searchDir = path.join(testDir, 'partial-match');
    fs.mkdirSync(searchDir, { recursive: true });
    fs.writeFileSync(path.join(searchDir, 'AuthService.js'), 'x', 'utf8');
    fs.writeFileSync(path.join(searchDir, 'AuthMiddleware.js'), 'y', 'utf8');

    const result = mod.searchSimilarFiles('task-sf-partial', 'Auth', searchDir, 'filename');

    expect(result.matches_found).toBeGreaterThanOrEqual(2);
  });

  it('records search result to database', () => {
    const searchDir = path.join(testDir, 'search-record');
    fs.mkdirSync(searchDir, { recursive: true });

    mod.searchSimilarFiles('task-sf-record', 'Something', searchDir, 'filename');

    const rows = rawDb().prepare('SELECT * FROM similar_file_search WHERE task_id = ?').all('task-sf-record');
    expect(rows).toHaveLength(1);
    expect(rows[0].search_term).toBe('Something');
    expect(rows[0].search_type).toBe('filename');
  });
});

describe('getSimilarFileSearchResults', () => {
  it('retrieves past search results for a task', () => {
    const searchDir = path.join(testDir, 'similar-history');
    fs.mkdirSync(searchDir, { recursive: true });
    fs.writeFileSync(path.join(searchDir, 'Foo.js'), 'x', 'utf8');

    mod.searchSimilarFiles('task-sf4', 'Foo', searchDir, 'filename');
    mod.searchSimilarFiles('task-sf4', 'Bar', searchDir, 'filename');

    const results = mod.getSimilarFileSearchResults('task-sf4');
    expect(results).toHaveLength(2);
    expect(Array.isArray(results[0].match_files)).toBe(true);
    expect(results[0].search_term).toBeDefined();
  });

  it('returns empty array for task with no searches', () => {
    const results = mod.getSimilarFileSearchResults('task-no-searches');
    expect(results).toEqual([]);
  });

  it('parses match_files JSON into array', () => {
    const searchDir = path.join(testDir, 'similar-parse');
    fs.mkdirSync(searchDir, { recursive: true });
    fs.writeFileSync(path.join(searchDir, 'Target.ts'), 'x', 'utf8');

    mod.searchSimilarFiles('task-sf-parse', 'Target', searchDir, 'filename');

    const results = mod.getSimilarFileSearchResults('task-sf-parse');
    expect(results).toHaveLength(1);
    expect(Array.isArray(results[0].match_files)).toBe(true);
    expect(results[0].match_files.length).toBeGreaterThanOrEqual(1);
    expect(results[0].match_files[0]).toContain('Target.ts');
  });
});
