'use strict';

/**
 * File Baselines Module
 *
 * Extracted from file-tracking.js — baselines, backups, locks, rollbacks,
 * file-location safeguards, and similar-file search.
 */

const {
  BASELINE_EXTENSIONS,
  FILE_SIZE_TRUNCATION_THRESHOLD,
  FILE_SIZE_SHRINK_THRESHOLD,
} = require('../../constants');
const { safeJsonParse } = require('../../utils/json');

let db;
let _getTaskFn;
const DIRECTORY_BASELINE_YIELD_BATCH_SIZE = 25;
const VALIDATION_SCAN_MAX_DEPTH = 10;
const DUPLICATE_SCAN_EXCLUDED_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', '.vs', '.idea']);
const SIMILAR_FILE_SCAN_EXCLUDED_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', '.vs', '.idea']);

function setDb(dbInstance) {
  db = dbInstance;
}

function setGetTask(fn) {
  _getTaskFn = fn;
}

function getTaskForScope(taskId) {
  if (!taskId) return null;

  if (typeof _getTaskFn === 'function') {
    try {
      return _getTaskFn(taskId);
    } catch {
      return null;
    }
  }

  try {
    const taskCore = require('../task-core');
    return typeof taskCore?.getTask === 'function' ? taskCore.getTask(taskId) : null;
  } catch {
    return null;
  }
}

function resolveScopedWorkingDirectory(taskId, workingDirectory) {
  const requestedWorkingDirectory = typeof workingDirectory === 'string' ? workingDirectory.trim() : '';
  if (!requestedWorkingDirectory) {
    return requestedWorkingDirectory;
  }

  const task = getTaskForScope(taskId);
  const taskWorkingDirectory = typeof task?.working_directory === 'string' ? task.working_directory.trim() : '';
  if (!taskWorkingDirectory) {
    return requestedWorkingDirectory;
  }

  const path = require('path');
  const taskRoot = path.resolve(taskWorkingDirectory);
  const resolvedWorkingDirectory = path.isAbsolute(requestedWorkingDirectory)
    ? path.resolve(requestedWorkingDirectory)
    : path.resolve(taskRoot, requestedWorkingDirectory);
  const relativePath = path.relative(taskRoot, resolvedWorkingDirectory);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('working_directory is outside task workspace root');
  }

  return resolvedWorkingDirectory;
}

async function walkValidationFiles(rootDirectory, options, onFile) {
  const fsPromises = require('fs').promises;
  const path = require('path');
  const {
    excludedDirectories = new Set(),
    maxDepth = VALIDATION_SCAN_MAX_DEPTH,
  } = options || {};

  async function walkDirectory(directory, depth) {
    if (depth > maxDepth) return;

    let dir;
    try {
      dir = await fsPromises.opendir(directory);
    } catch (_err) {
      void _err;
      return;
    }

    try {
      for await (const dirent of dir) {
        const fullPath = path.join(directory, dirent.name);

        if (dirent.isDirectory()) {
          if (!excludedDirectories.has(dirent.name)) {
            await walkDirectory(fullPath, depth + 1);
          }
        } else if (dirent.isFile()) {
          await onFile(fullPath, dirent);
        }
      }
    } catch (_err) {
      void _err;
    }
  }

  await walkDirectory(rootDirectory, 0);
}


function captureFileBaseline(filePath, workingDirectory, taskId = null) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');

  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workingDirectory, filePath);

  try {
    const stats = fs.statSync(fullPath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const lineCount = content.split('\n').length;
    const checksum = crypto.createHash('sha256').update(content).digest('hex');

    const stmt = db.prepare(`
      INSERT INTO file_baselines (file_path, working_directory, size_bytes, line_count, checksum, captured_at, task_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, working_directory) DO UPDATE SET
        size_bytes = excluded.size_bytes,
        line_count = excluded.line_count,
        checksum = excluded.checksum,
        captured_at = excluded.captured_at,
        task_id = excluded.task_id
    `);
    stmt.run(filePath, workingDirectory, stats.size, lineCount, checksum, new Date().toISOString(), taskId);

    return { size: stats.size, lines: lineCount, checksum };
  } catch (_err) {
    void _err;
    return null;
  }
}

async function captureFileBaselineAsync(filePath, workingDirectory, taskId = null) {
  const fsPromises = require('fs').promises;
  const path = require('path');
  const crypto = require('crypto');

  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workingDirectory, filePath);

  try {
    const stats = await fsPromises.stat(fullPath);
    const content = await fsPromises.readFile(fullPath, 'utf8');
    const lineCount = content.split('\n').length;
    const checksum = crypto.createHash('sha256').update(content).digest('hex');

    const stmt = db.prepare(`
      INSERT INTO file_baselines (file_path, working_directory, size_bytes, line_count, checksum, captured_at, task_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, working_directory) DO UPDATE SET
        size_bytes = excluded.size_bytes,
        line_count = excluded.line_count,
        checksum = excluded.checksum,
        captured_at = excluded.captured_at,
        task_id = excluded.task_id
    `);
    stmt.run(filePath, workingDirectory, stats.size, lineCount, checksum, new Date().toISOString(), taskId);

    return { size: stats.size, lines: lineCount, checksum };
  } catch (_err) {
    void _err;
    return null;
  }
}

/**
 * Get file baseline
 * @param {any} filePath
 * @param {any} workingDirectory
 * @returns {any}
 */

function getFileBaseline(filePath, workingDirectory) {
  const stmt = db.prepare('SELECT * FROM file_baselines WHERE file_path = ? AND working_directory = ?');
  return stmt.get(filePath, workingDirectory);
}

/**
 * Compare current file against baseline
 */

function compareFileToBaseline(filePath, workingDirectory) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');

  const baseline = getFileBaseline(filePath, workingDirectory);
  if (!baseline) return { hasBaseline: false };

  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workingDirectory, filePath);

  try {
    const stats = fs.statSync(fullPath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const currentLines = content.split('\n').length;
    const currentHash = crypto.createHash('sha256').update(content).digest('hex');
    const hasStoredHash = typeof baseline.checksum === 'string' && baseline.checksum.length > 0;
    const isHashChanged = hasStoredHash ? baseline.checksum !== currentHash : null;
    const isContentChanged = hasStoredHash ? isHashChanged : null;

    const sizeDelta = stats.size - baseline.size_bytes;
    const sizeChangePercent = baseline.size_bytes > 0 ? (sizeDelta / baseline.size_bytes) * 100 : 0;
    const lineDelta = currentLines - baseline.line_count;

    return {
      hasBaseline: true,
      baseline,
      current: { size: stats.size, lines: currentLines, hash: currentHash },
      sizeDelta,
      sizeChangePercent,
      lineDelta,
      isHashChanged,
      isContentChanged,
      hashMatch: hasStoredHash ? !isHashChanged : null,
      isTruncated: sizeChangePercent < FILE_SIZE_TRUNCATION_THRESHOLD,
      isSignificantlyShrunk: sizeChangePercent < FILE_SIZE_SHRINK_THRESHOLD
    };
  } catch (err) {
    return { hasBaseline: true, baseline, error: err.message };
  }
}

/**
 * Capture baselines for all files in a directory
 * @param {string} workingDirectory - Root directory to scan.
 * @param {Array<string>} [extensions=['.cs', '.xaml', '.ts', '.js', '.py']] - File extensions to include.
 * @returns {Array<string>} Relative paths captured.
 */

async function captureDirectoryBaselines(workingDirectory, extensions = BASELINE_EXTENSIONS) {
  const fsPromises = require('fs').promises;
  const path = require('path');

  const captured = [];
  let capturedSinceYield = 0;

  async function yieldAfterBatch() {
    capturedSinceYield += 1;
    if (capturedSinceYield >= DIRECTORY_BASELINE_YIELD_BATCH_SIZE) {
      capturedSinceYield = 0;
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  async function walkDir(dir) {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'bin' && entry.name !== 'obj') {
          await walkDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            const relativePath = path.relative(workingDirectory, fullPath);
            await captureFileBaselineAsync(relativePath, workingDirectory);
            captured.push(relativePath);
            await yieldAfterBatch();
          }
        }
      }
    } catch { /* skip unreadable directories (permission errors, broken symlinks) */ }
  }

  await walkDir(workingDirectory);
  return captured;
}

// ============================================
// Syntax Validation Functions
// ============================================

/**
 * Get syntax validators for a file extension
 * @param {any} extension
 * @returns {any}
 */

function createFileBackup(taskId, filePath, workingDirectory) {
  const fs = require('fs');
  const path = require('path');
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workingDirectory, filePath);

  try {
    if (!fs.existsSync(fullPath)) {
      return { created: false, reason: 'File does not exist' };
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const stats = fs.statSync(fullPath);
    const id = require('uuid').v4();

    const stmt = db.prepare(`
      INSERT INTO file_backups (id, task_id, file_path, working_directory, original_content, original_size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, taskId, filePath, workingDirectory, content, stats.size, new Date().toISOString());

    return { created: true, backupId: id };
  } catch (err) {
    return { created: false, reason: err.message };
  }
}

/**
 * Restore file from backup
 * @param {any} backupId
 * @returns {any}
 */

function restoreFileBackup(backupId) {
  const fs = require('fs');
  const path = require('path');

  const backup = db.prepare('SELECT * FROM file_backups WHERE id = ?').get(backupId);
  if (!backup) {
    return { restored: false, reason: 'Backup not found' };
  }

  try {
    const fullPath = path.isAbsolute(backup.file_path)
      ? backup.file_path
      : path.join(backup.working_directory, backup.file_path);

    fs.writeFileSync(fullPath, backup.original_content, 'utf8');

    db.prepare('UPDATE file_backups SET restored_at = ? WHERE id = ?')
      .run(new Date().toISOString(), backupId);

    return { restored: true };
  } catch (err) {
    return { restored: false, reason: err.message };
  }
}

function getTaskFileBackup(taskId, filePath) {
  return db.prepare(`
    SELECT * FROM file_backups
    WHERE task_id = ? AND file_path = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(taskId, filePath);
}

/**
 * Get backups for a task
 * @param {any} taskId
 * @returns {any}
 */

function getTaskBackups(taskId) {
  return db.prepare('SELECT * FROM file_backups WHERE task_id = ? ORDER BY created_at DESC').all(taskId);
}

// ============================================
// Security Scanning Functions
// ============================================

/**
 * Run security scan on a file
 * @param {any} taskId
 * @param {any} filePath
 * @param {any} content
 * @returns {any}
 */

function acquireFileLock(filePath, workingDirectory, taskId, lockType = 'exclusive', timeoutSeconds = 300) {
  const lockOp = db.transaction(() => {
    const expiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString();
    const now = new Date().toISOString();

    releaseExpiredFileLocks(now);

    // Check for existing locks (within transaction for atomicity)
    const existing = db.prepare(`
      SELECT * FROM file_locks
      WHERE file_path = ? AND working_directory = ? AND released_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    `).get(filePath, workingDirectory, now);

    if (existing && existing.task_id !== taskId) {
      return { acquired: false, reason: `File locked by task ${existing.task_id}`, lockedBy: existing.task_id };
    }

    const stmt = db.prepare(`
      INSERT INTO file_locks (file_path, working_directory, task_id, lock_type, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, working_directory, task_id) DO UPDATE SET
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        released_at = NULL
    `);
    stmt.run(filePath, workingDirectory, taskId, lockType, now, expiresAt);

    return { acquired: true };
  });
  return lockOp();
}

/**
 * Release file lock
 * @param {any} filePath
 * @param {any} workingDirectory
 * @param {any} taskId
 * @returns {any}
 */

function releaseFileLock(filePath, workingDirectory, taskId) {
  const stmt = db.prepare(`
    UPDATE file_locks SET released_at = ? WHERE file_path = ? AND working_directory = ? AND task_id = ?
  `);
  const result = stmt.run(new Date().toISOString(), filePath, workingDirectory, taskId);
  return result.changes;
}

/**
 * Release all locks for a task
 * @param {any} taskId
 * @returns {any}
 */

function releaseAllFileLocks(taskId) {
  const stmt = db.prepare('UPDATE file_locks SET released_at = ? WHERE task_id = ? AND released_at IS NULL');
  const result = stmt.run(new Date().toISOString(), taskId);
  return result.changes;
}

function releaseExpiredFileLocks(now = new Date().toISOString()) {
  const stmt = db.prepare(`
    UPDATE file_locks
    SET released_at = ?
    WHERE released_at IS NULL
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `);
  const result = stmt.run(now, now);
  return result.changes;
}

/**
 * Get active file locks
 */

function getActiveFileLocks(taskId = null) {
  const now = new Date().toISOString();
  releaseExpiredFileLocks(now);
  if (taskId) {
    return db.prepare(`
      SELECT * FROM file_locks WHERE task_id = ? AND released_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    `).all(taskId, now);
  }
  return db.prepare(`
    SELECT * FROM file_locks WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
  `).all(now);
}

// ============================================
// Backup Functions
// ============================================

/**
 * Create file backup before modification
 */

function createRollback(taskId, rollbackType, filesAffected, commitBefore, reason, initiatedBy) {
  const id = require('uuid').v4();
  const stmt = db.prepare(`
    INSERT INTO task_rollbacks (id, task_id, rollback_type, files_affected, commit_before, reason, status, initiated_at, initiated_by)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);
  stmt.run(id, taskId, rollbackType, JSON.stringify(filesAffected || []), commitBefore, reason, new Date().toISOString(), initiatedBy);
  return id;
}

/**
 * Get rollback for a task
 * @param {any} taskId
 * @returns {any}
 */

function getRollback(taskId) {
  const stmt = db.prepare('SELECT * FROM task_rollbacks WHERE task_id = ? ORDER BY initiated_at DESC LIMIT 1');
  return stmt.get(taskId);
}

/**
 * Complete a rollback
 */

function completeRollback(rollbackId, commitAfter, status = 'completed') {
  const stmt = db.prepare(`
    UPDATE task_rollbacks SET status = ?, commit_after = ?, completed_at = ? WHERE id = ?
  `);
  stmt.run(status, commitAfter, new Date().toISOString(), rollbackId);
}

/**
 * List rollbacks
 * @param {any} status
 * @param {any} limit
 * @returns {any}
 */

function listRollbacks(status = null, limit = 50) {
  if (status) {
    const stmt = db.prepare('SELECT * FROM task_rollbacks WHERE status = ? ORDER BY initiated_at DESC LIMIT ?');
    return stmt.all(status, limit);
  }
  const stmt = db.prepare('SELECT * FROM task_rollbacks ORDER BY initiated_at DESC LIMIT ?');
  return stmt.all(limit);
}

// ============================================
// Build Check Functions
// ============================================

/**
 * Run build check for a task
 * @param {any} taskId
 * @param {any} workingDirectory
 * @returns {any}
 */

function recordAutoRollback(taskId, triggerReason, filesRolledBack, options = {}) {
  const { rollbackCommit = null, success = true, errorMessage = null } = options;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO auto_rollbacks (task_id, trigger_reason, files_rolled_back, rollback_commit, success, error_message, rolled_back_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, triggerReason, JSON.stringify(filesRolledBack), rollbackCommit, success ? 1 : 0, errorMessage, now);

  return {
    task_id: taskId,
    trigger_reason: triggerReason,
    files_rolled_back: filesRolledBack,
    success
  };
}

/**
 * Get auto-rollback history
 * @param {any} taskId
 * @returns {any}
 */

function getAutoRollbackHistory(taskId = null) {
  if (taskId) {
    return db.prepare('SELECT * FROM auto_rollbacks WHERE task_id = ?').all(taskId);
  }
  return db.prepare('SELECT * FROM auto_rollbacks ORDER BY rolled_back_at DESC LIMIT 100').all();
}

/**
 * Perform auto-rollback for a task (restore files from git)
 * @param {string} taskId - The task ID
 * @param {string} workingDirectory - Working directory for git commands
 * @param {string} triggerReason - Reason for rollback
 * @returns {any}
 */

function performAutoRollback(taskId, workingDirectory, triggerReason) {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const fileChanges = getTaskFileChanges(taskId);
  const filesToRestore = [];
  const errors = [];
  const gitRefCache = new Map();

  function hasGitRef(currentWorkingDirectory, ref) {
    const cacheKey = `${currentWorkingDirectory}::${ref}`;
    if (gitRefCache.has(cacheKey)) {
      return gitRefCache.get(cacheKey);
    }

    let exists = false;
    try {
      execFileSync('git', ['rev-parse', '--verify', ref], {
        cwd: currentWorkingDirectory,
        stdio: 'pipe',
        timeout: 10000,
        windowsHide: true,
      });
      exists = true;
    } catch {
      exists = false;
    }

    gitRefCache.set(cacheKey, exists);
    return exists;
  }

  for (const change of fileChanges) {
    const currentWorkingDirectory = change.working_directory || workingDirectory || process.cwd();
    const filePath = path.isAbsolute(change.file_path)
      ? change.file_path
      : path.join(currentWorkingDirectory, change.file_path);

    if (change.change_type === 'created') {
      // For created files, delete them
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          filesToRestore.push({ path: filePath, action: 'deleted' });
        }
      } catch (e) {
        errors.push({ path: change.file_path, error: e.message });
      }
    } else if (change.change_type === 'modified') {
      try {
        const backup = getTaskFileBackup(taskId, change.file_path);

        if (backup && backup.original_content !== null && backup.original_content !== undefined) {
          fs.writeFileSync(filePath, backup.original_content, 'utf8');
          filesToRestore.push({ path: filePath, action: 'restored', source: 'backup', backup_id: backup.id });
          continue;
        }

        const gitPath = path.isAbsolute(change.file_path)
          ? path.relative(currentWorkingDirectory, change.file_path)
          : change.file_path;
        const normalizedGitPath = gitPath.split(path.sep).join('/');

        if (!hasGitRef(currentWorkingDirectory, 'HEAD~1')) {
          throw new Error('Cannot restore from HEAD~1: no previous commit exists');
        }

        const restoredContent = execFileSync('git', ['show', `HEAD~1:${normalizedGitPath}`], {
          cwd: currentWorkingDirectory,
          stdio: 'pipe',
          timeout: 10000,
          windowsHide: true,
        }).toString('utf8');

        fs.writeFileSync(filePath, restoredContent, 'utf8');
        filesToRestore.push({ path: filePath, action: 'restored', from_ref: 'HEAD~1' });
      } catch (e) {
        errors.push({ path: change.file_path, error: e.message });
      }
    }
  }

  const success = errors.length === 0;
  recordAutoRollback(taskId, triggerReason, filesToRestore, {
    success,
    errorMessage: errors.length > 0 ? JSON.stringify(errors) : null
  });

  return {
    task_id: taskId,
    trigger_reason: triggerReason,
    files_processed: filesToRestore.length,
    files: filesToRestore,
    errors,
    success
  };
}

// ============================================
// XAML Validation Safeguards (Wave 7)
// ============================================

/**
 * Validate XAML for semantic issues that pass compilation but fail at runtime
 */

function setExpectedOutputPath(taskId, expectedDirectory, options = {}) {
  const { allowSubdirs = true, filePatterns = null } = options;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO expected_output_paths (task_id, expected_directory, allow_subdirs, file_patterns, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, expectedDirectory, allowSubdirs ? 1 : 0, filePatterns ? JSON.stringify(filePatterns) : null, now);

  return { task_id: taskId, expected_directory: expectedDirectory };
}

/**
 * Get expected output paths for a task
 * @param {any} taskId
 * @returns {any}
 */

function getExpectedOutputPaths(taskId) {
  return db.prepare('SELECT * FROM expected_output_paths WHERE task_id = ?').all(taskId);
}

/**
 * Record a file change for a task
 * @param {any} taskId
 * @param {any} filePath
 * @param {any} changeType
 * @param {any} options
 * @returns {any}
 */

function recordFileChange(taskId, filePath, changeType, options = {}) {
  const { fileSizeBytes = null, workingDirectory = null } = options;
  const now = new Date().toISOString();

  let relativePath = filePath;
  let isOutsideWorkdir = 0;

  if (workingDirectory) {
    const path = require('path');
    const normalizedFile = path.normalize(filePath);
    const normalizedWorkdir = path.normalize(workingDirectory);

    const rel = path.relative(normalizedWorkdir, normalizedFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      isOutsideWorkdir = 1;
    } else {
      relativePath = rel;
    }
  }

  db.prepare(`
    INSERT INTO task_file_changes (task_id, file_path, change_type, file_size_bytes, working_directory, relative_path, is_outside_workdir, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, filePath, changeType, fileSizeBytes, workingDirectory, relativePath, isOutsideWorkdir, now);

  return { task_id: taskId, file_path: filePath, is_outside_workdir: isOutsideWorkdir === 1 };
}

/**
 * Get file changes for a task
 * @param {any} taskId
 * @returns {any}
 */

function getTaskFileChanges(taskId) {
  return db.prepare('SELECT * FROM task_file_changes WHERE task_id = ?').all(taskId);
}

/**
 * Record a file location anomaly
 * @param {any} taskId
 * @param {any} anomalyType
 * @param {any} filePath
 * @param {any} options
 * @returns {any}
 */

function recordFileLocationAnomaly(taskId, anomalyType, filePath, options = {}) {
  const { expectedDirectory = null, actualDirectory = null, severity = 'warning', details = null } = options;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO file_location_anomalies (task_id, anomaly_type, file_path, expected_directory, actual_directory, severity, details, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, anomalyType, filePath, expectedDirectory, actualDirectory, severity, details, now);

  return { task_id: taskId, anomaly_type: anomalyType, file_path: filePath };
}

/**
 * Get file location anomalies for a task
 * @param {any} taskId
 * @param {any} includeResolved
 * @returns {any}
 */

function getFileLocationAnomalies(taskId, includeResolved = false) {
  if (includeResolved) {
    return db.prepare('SELECT * FROM file_location_anomalies WHERE task_id = ?').all(taskId);
  }
  return db.prepare('SELECT * FROM file_location_anomalies WHERE task_id = ? AND resolved = 0').all(taskId);
}

/**
 * Resolve a file location anomaly
 * @param {any} anomalyId
 * @returns {any}
 */

function resolveFileLocationAnomaly(anomalyId) {
  const now = new Date().toISOString();
  db.prepare('UPDATE file_location_anomalies SET resolved = 1, resolved_at = ? WHERE id = ?').run(now, anomalyId);
  return db.prepare('SELECT * FROM file_location_anomalies WHERE id = ?').get(anomalyId);
}

/**
 * Record a duplicate file detection
 * @param {any} taskId
 * @param {any} fileName
 * @param {any} locations
 * @param {any} options
 * @returns {any}
 */

function recordDuplicateFile(taskId, fileName, locations, options = {}) {
  const { severity = 'warning', likelyCorrectPath = null, details = null } = options;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO duplicate_file_detections (task_id, file_name, locations, location_count, severity, likely_correct_path, details, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, fileName, JSON.stringify(locations), locations.length, severity, likelyCorrectPath, details, now);

  return { task_id: taskId, file_name: fileName, location_count: locations.length };
}

/**
 * Get duplicate file detections for a task
 * @param {any} taskId
 * @param {any} includeResolved
 * @returns {any}
 */

function getDuplicateFileDetections(taskId, includeResolved = false) {
  if (includeResolved) {
    return db.prepare('SELECT * FROM duplicate_file_detections WHERE task_id = ?').all(taskId);
  }
  return db.prepare('SELECT * FROM duplicate_file_detections WHERE task_id = ? AND resolved = 0').all(taskId);
}

/**
 * Resolve a duplicate file detection
 * @param {any} detectionId
 * @returns {any}
 */

function resolveDuplicateFile(detectionId) {
  const now = new Date().toISOString();
  db.prepare('UPDATE duplicate_file_detections SET resolved = 1, resolved_at = ? WHERE id = ?').run(now, detectionId);
  return db.prepare('SELECT * FROM duplicate_file_detections WHERE id = ?').get(detectionId);
}

/**
 * Check for files created outside expected directory
 * Returns anomalies if files were created outside the working directory or expected paths
 */

function checkFileLocationAnomalies(taskId, workingDirectory) {
  const fileChanges = getTaskFileChanges(taskId);
  const expectedPaths = getExpectedOutputPaths(taskId);
  const anomalies = [];
  const path = require('path');

  for (const change of fileChanges) {
    if (change.change_type !== 'created' && change.change_type !== 'modified') continue;

    const normalizedFile = path.normalize(change.file_path);
    const normalizedWorkdir = path.normalize(workingDirectory);

    // Check if file is outside working directory (use path.relative to prevent startsWith bypass)
    const rel = path.relative(normalizedWorkdir, normalizedFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      const anomaly = recordFileLocationAnomaly(taskId, 'outside_workdir', change.file_path, {
        expectedDirectory: workingDirectory,
        actualDirectory: path.dirname(change.file_path),
        severity: 'error',
        details: `File created outside working directory: expected within ${workingDirectory}`
      });
      anomalies.push(anomaly);
      continue;
    }

    // Check against specific expected paths if defined
    if (expectedPaths.length > 0) {
      let matchesExpected = false;
      for (const expected of expectedPaths) {
        const normalizedExpected = path.normalize(expected.expected_directory);
        if (expected.allow_subdirs) {
          const relativeToExpected = path.relative(normalizedExpected, normalizedFile);
          if (!relativeToExpected.startsWith('..') && !path.isAbsolute(relativeToExpected)) {
            matchesExpected = true;
            break;
          }
        } else {
          if (path.dirname(normalizedFile) === normalizedExpected) {
            matchesExpected = true;
            break;
          }
        }
      }

      if (!matchesExpected) {
        const anomaly = recordFileLocationAnomaly(taskId, 'unexpected_location', change.file_path, {
          expectedDirectory: expectedPaths.map(e => e.expected_directory).join(', '),
          actualDirectory: path.dirname(change.file_path),
          severity: 'warning',
          details: `File created in unexpected location`
        });
        anomalies.push(anomaly);
      }
    }
  }

  return anomalies;
}

/**
 * Check for duplicate files (same filename in multiple locations)
 * Scans the working directory after task completion
 */

async function checkDuplicateFiles(taskId, workingDirectory, options = {}) {
  const { fileExtensions = BASELINE_EXTENSIONS } = options;
  const path = require('path');
  const duplicates = [];
  const scopedWorkingDirectory = resolveScopedWorkingDirectory(taskId, workingDirectory);

  // Build a map of filename -> locations
  const fileMap = new Map();

  await walkValidationFiles(
    scopedWorkingDirectory,
    { excludedDirectories: DUPLICATE_SCAN_EXCLUDED_DIRS },
    async (fullPath, dirent) => {
      const ext = path.extname(dirent.name).toLowerCase();
      if (fileExtensions.includes(ext)) {
        const locations = fileMap.get(dirent.name) || [];
        locations.push(fullPath);
        fileMap.set(dirent.name, locations);
      }
    }
  );

  // Find duplicates
  for (const [fileName, locations] of fileMap) {
    if (locations.length > 1) {
      // Determine likely correct path (shortest path or most common parent)
      const likelyCorrect = locations.reduce((a, b) => a.length <= b.length ? a : b);

      const detection = recordDuplicateFile(taskId, fileName, locations, {
        severity: 'warning',
        likelyCorrectPath: likelyCorrect,
        details: `Found ${locations.length} files with same name in different locations`
      });
      duplicates.push({
        ...detection,
        locations: locations
      });
    }
  }

  return duplicates;
}

/**
 * Get all file location issues for a task (anomalies + duplicates)
 */

function getAllFileLocationIssues(taskId) {
  const anomalies = getFileLocationAnomalies(taskId);
  const duplicates = getDuplicateFileDetections(taskId);

  return {
    anomalies: anomalies,
    duplicates: duplicates.map(d => ({
      ...d,
      locations: safeJsonParse(d.locations, [])
    })),
    total_issues: anomalies.length + duplicates.length
  };
}

// ============================================
// Code Verification Safeguards (Wave 6)
// ============================================

// Delegated to db/code-analysis.js

async function searchSimilarFiles(taskId, searchTerm, workingDirectory, searchType = 'filename') {
  const fsPromises = require('fs').promises;
  const now = new Date().toISOString();
  const matches = [];
  const scopedWorkingDirectory = resolveScopedWorkingDirectory(taskId, workingDirectory);

  // Normalize search term
  const normalizedTerm = searchTerm.toLowerCase().replace(/\.(cs|ts|tsx|js|jsx|xaml)$/i, '');

  if (scopedWorkingDirectory) {
    await walkValidationFiles(
      scopedWorkingDirectory,
      { excludedDirectories: SIMILAR_FILE_SCAN_EXCLUDED_DIRS },
      async (fullPath, dirent) => {
        const fileName = dirent.name.toLowerCase().replace(/\.(cs|ts|tsx|js|jsx|xaml)$/i, '');

        if (searchType === 'filename') {
          // Exact or partial filename match
          if (fileName === normalizedTerm || fileName.includes(normalizedTerm) || normalizedTerm.includes(fileName)) {
            matches.push(fullPath);
          }
          return;
        }

        if (searchType === 'classname' && /\.(cs|ts|tsx|js|jsx)$/.test(dirent.name)) {
          // Search for class/interface definition inside source file contents.
          try {
            const content = await fsPromises.readFile(fullPath, 'utf8');
            const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const classPattern = new RegExp(`(class|interface)\\s+${escapedTerm}\\b`, 'i');
            if (classPattern.test(content)) {
              matches.push(fullPath);
            }
          } catch (_e) {
            void _e;
            /* skip */
          }
        }
      }
    );
  }

  // Generate recommendation
  let recommendation = null;
  if (matches.length > 0) {
    recommendation = `Found ${matches.length} similar file(s). Consider using existing file(s) instead of creating new ones.`;
  }

  // Record result
  db.prepare(`
    INSERT INTO similar_file_search (task_id, search_term, search_type, matches_found, match_files, recommendation, searched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, searchTerm, searchType, matches.length, JSON.stringify(matches), recommendation, now);

  return {
    task_id: taskId,
    search_term: searchTerm,
    search_type: searchType,
    matches_found: matches.length,
    matches,
    recommendation,
    status: matches.length > 0 ? 'similar_files_exist' : 'no_matches'
  };
}

/**
 * Get similar file search results
 * @param {any} taskId
 * @returns {any}
 */

function getSimilarFileSearchResults(taskId) {
  const results = db.prepare('SELECT * FROM similar_file_search WHERE task_id = ?').all(taskId);
  return results.map(r => ({
    ...r,
    match_files: safeJsonParse(r.match_files, [])
  }));
}

/**
 * Calculate task complexity score for routing decisions
 * @param {string} taskId - Task identifier.
 * @param {string} taskDescription - Task description text.
 * @param {object} [options={}] - Scoring options.
 * @returns {object} Complexity score details.
 */

module.exports = {
  setDb,
  setGetTask,
  captureFileBaseline,
  getFileBaseline,
  compareFileToBaseline,
  captureDirectoryBaselines,
  createFileBackup,
  restoreFileBackup,
  getTaskBackups,
  acquireFileLock,
  releaseFileLock,
  releaseAllFileLocks,
  releaseExpiredFileLocks,
  getActiveFileLocks,
  createRollback,
  getRollback,
  completeRollback,
  listRollbacks,
  recordAutoRollback,
  getAutoRollbackHistory,
  performAutoRollback,
  setExpectedOutputPath,
  getExpectedOutputPaths,
  recordFileChange,
  getTaskFileChanges,
  recordFileLocationAnomaly,
  getFileLocationAnomalies,
  resolveFileLocationAnomaly,
  recordDuplicateFile,
  getDuplicateFileDetections,
  resolveDuplicateFile,
  checkFileLocationAnomalies,
  checkDuplicateFiles,
  getAllFileLocationIssues,
  searchSimilarFiles,
  getSimilarFileSearchResults
};
