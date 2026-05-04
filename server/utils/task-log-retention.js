'use strict';

/**
 * Task-log retention utilities (Phase E of the subprocess-detachment arc).
 *
 * Two halves of the §2.5.2 retention model:
 *
 *   1. **Compress on finalize.** When a detached subprocess terminates,
 *      gzip the per-task stdout.log / stderr.log to .gz. Log text gzips
 *      ~10× — irreversible win, runs once per task, costs nothing for live
 *      operations. Not configurable; there's no operational reason to
 *      keep logs uncompressed once the task is terminal.
 *
 *   2. **Prune after task_log_retention_days.** Periodic maintenance
 *      scans <data-dir>/task-logs/<taskId>/, deletes any task-log
 *      directory whose newest mtime is older than the retention window
 *      (DB config `task_log_retention_days`, default 30), and returns
 *      counts plus a per-deletion audit array so the maintenance
 *      scheduler can record a forensics row per delete.
 *
 * Operator-visible status surface: `getTaskLogDiskUsage()` returns the
 * total on-disk bytes, the oldest log age, the count of task-log dirs,
 * and the configured retention so operators know when to extend it.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { getDataDir } = require('../data-dir');

const TASK_LOGS_DIRNAME = 'task-logs';
const DEFAULT_RETENTION_DAYS = 30;
const LOG_FILE_NAMES = ['stdout.log', 'stderr.log'];

function taskLogsRoot() {
  return path.join(getDataDir(), TASK_LOGS_DIRNAME);
}

/**
 * Synchronous gzip of a single log file. Returns the new path on success
 * or null when the source is missing / already compressed. The original
 * is removed only after the .gz is fully written. Idempotent — calling
 * twice on the same path is a no-op the second time.
 */
function compressOneFile(srcPath) {
  if (!srcPath) return null;
  if (srcPath.endsWith('.gz')) return srcPath;
  let stat;
  try {
    stat = fs.statSync(srcPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (!stat.isFile()) return null;
  if (stat.size === 0) {
    // Drop empty logs entirely — gzip overhead outweighs the win and
    // the absence is itself useful information.
    try { fs.unlinkSync(srcPath); } catch { /* ignore */ }
    return null;
  }
  const gzPath = `${srcPath}.gz`;
  // Already-gzipped sibling means a previous finalize ran. Leave it.
  if (fs.existsSync(gzPath)) {
    try { fs.unlinkSync(srcPath); } catch { /* ignore */ }
    return gzPath;
  }
  const buf = fs.readFileSync(srcPath);
  const gzipped = zlib.gzipSync(buf);
  fs.writeFileSync(gzPath, gzipped);
  fs.unlinkSync(srcPath);
  return gzPath;
}

/**
 * Compress stdout.log + stderr.log inside a task's log directory. Any
 * other files (prompt.txt, etc.) are left as-is — they're small and
 * may need to be human-readable for forensics.
 *
 * @param {string} taskId
 * @returns {{compressed: string[], skipped: string[]}}
 */
function compressTaskLogs(taskId) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('compressTaskLogs requires a non-empty taskId string');
  }
  // Reuse the same sanitization rule as data-dir.getTaskLogDir so the
  // compressed and uncompressed paths agree without duplicating logic.
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') {
    throw new Error(`compressTaskLogs: taskId sanitized to an unsafe value: ${JSON.stringify(taskId)}`);
  }
  const dir = path.join(taskLogsRoot(), safe);
  const compressed = [];
  const skipped = [];
  for (const name of LOG_FILE_NAMES) {
    const src = path.join(dir, name);
    try {
      const out = compressOneFile(src);
      if (out) compressed.push(path.basename(out));
      else skipped.push(name);
    } catch (err) {
      skipped.push(`${name} (error: ${err.message})`);
    }
  }
  return { compressed, skipped };
}

/**
 * Recursively size a directory's content. Handles missing entries and
 * permission errors by skipping, so a partial walk is preferred to a
 * thrown exception during a maintenance sweep.
 */
function dirSizeBytes(dir) {
  let total = 0;
  let newestMtimeMs = 0;
  let entryCount = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { total, newestMtimeMs, entryCount };
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = dirSizeBytes(full);
      total += sub.total;
      if (sub.newestMtimeMs > newestMtimeMs) newestMtimeMs = sub.newestMtimeMs;
      entryCount += sub.entryCount;
      continue;
    }
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    total += stat.size;
    if (stat.mtimeMs > newestMtimeMs) newestMtimeMs = stat.mtimeMs;
    entryCount += 1;
  }
  return { total, newestMtimeMs, entryCount };
}

/**
 * Delete every task-log directory whose newest mtime is older than
 * `retentionDays`. The newest-mtime comparison ensures actively-written
 * detached subprocesses (Phase B) are never reaped while the parent is
 * still tailing them — fresh writes bump the mtime.
 *
 * @param {number} retentionDays
 * @param {Object} [opts]
 * @param {number} [opts.now] - clock injection for tests.
 * @returns {{deleted: Array<{taskId: string, age_days: number, bytes: number}>, kept: number, errors: number}}
 */
function pruneOldTaskLogs(retentionDays, opts = {}) {
  const days = Number.isFinite(Number(retentionDays)) && Number(retentionDays) > 0
    ? Number(retentionDays)
    : DEFAULT_RETENTION_DAYS;
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const cutoffMs = now - days * 24 * 60 * 60 * 1000;
  const root = taskLogsRoot();

  const result = { deleted: [], kept: 0, errors: 0 };
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return result;
    result.errors += 1;
    return result;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const taskId = ent.name;
    const dirPath = path.join(root, taskId);
    let info;
    try { info = dirSizeBytes(dirPath); } catch { result.errors += 1; continue; }
    if (!info.entryCount || !info.newestMtimeMs) {
      // Empty dir — drop it cheaply; not counted as a delete in the
      // audit since there's nothing forensic about an empty dir.
      try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { result.errors += 1; }
      continue;
    }
    if (info.newestMtimeMs >= cutoffMs) {
      result.kept += 1;
      continue;
    }
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      result.deleted.push({
        taskId,
        age_days: Math.round((now - info.newestMtimeMs) / (24 * 60 * 60 * 1000) * 10) / 10,
        bytes: info.total,
      });
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

/**
 * Aggregate disk-usage snapshot for the task-logs root.
 *
 * @param {Object} [opts]
 * @param {number} [opts.now] - clock injection for tests.
 * @param {number} [opts.retentionDays] - included in the response so
 *   callers can present "you have N% of retention used" without
 *   redoing the config lookup.
 * @returns {{total_bytes: number, task_count: number, oldest_log_age_days: number|null, retention_days: number}}
 */
function getTaskLogDiskUsage(opts = {}) {
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const retentionDays = Number.isFinite(Number(opts.retentionDays))
    ? Number(opts.retentionDays)
    : DEFAULT_RETENTION_DAYS;
  const root = taskLogsRoot();
  const out = {
    total_bytes: 0,
    task_count: 0,
    oldest_log_age_days: null,
    retention_days: retentionDays,
  };
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return out;
    throw err;
  }
  let oldestMtimeMs = Infinity;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dirPath = path.join(root, ent.name);
    const info = dirSizeBytes(dirPath);
    if (info.entryCount === 0) continue;
    out.total_bytes += info.total;
    out.task_count += 1;
    if (info.newestMtimeMs && info.newestMtimeMs < oldestMtimeMs) {
      oldestMtimeMs = info.newestMtimeMs;
    }
  }
  if (Number.isFinite(oldestMtimeMs)) {
    out.oldest_log_age_days = Math.round((now - oldestMtimeMs) / (24 * 60 * 60 * 1000) * 10) / 10;
  }
  return out;
}

module.exports = {
  compressTaskLogs,
  pruneOldTaskLogs,
  getTaskLogDiskUsage,
  // Exported for tests:
  _taskLogsRoot: taskLogsRoot,
  _DEFAULT_RETENTION_DAYS: DEFAULT_RETENTION_DAYS,
};
