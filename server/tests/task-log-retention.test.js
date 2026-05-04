'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const dataDir = require('../data-dir');
const {
  compressTaskLogs,
  pruneOldTaskLogs,
  getTaskLogDiskUsage,
} = require('../utils/task-log-retention');

function makeTaskLog(taskId, { stdout = '', stderr = '', mtimeAgeMs = 0, prompt = null } = {}) {
  const dir = dataDir.getTaskLogDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  if (stdout) fs.writeFileSync(path.join(dir, 'stdout.log'), stdout);
  if (stderr) fs.writeFileSync(path.join(dir, 'stderr.log'), stderr);
  if (prompt) fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
  if (mtimeAgeMs > 0) {
    const past = (Date.now() - mtimeAgeMs) / 1000;
    for (const name of fs.readdirSync(dir)) {
      try { fs.utimesSync(path.join(dir, name), past, past); } catch { /* ignore */ }
    }
  }
  return dir;
}

beforeEach(() => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-task-log-retention-'));
  dataDir.setDataDir(tmpRoot);
});

afterEach(() => {
  // setDataDir(null) so dataDir reresolves on the next test, then sweep
  // the tmp dir we created. Best-effort.
  const root = dataDir.getDataDir();
  dataDir.setDataDir(null);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('compressTaskLogs', () => {
  it('gzips stdout.log and stderr.log and removes the originals', () => {
    const dir = makeTaskLog('t-compress', {
      stdout: 'hello stdout '.repeat(200),
      stderr: 'hello stderr '.repeat(200),
    });

    const summary = compressTaskLogs('t-compress');

    expect(summary.compressed.sort()).toEqual(['stderr.log.gz', 'stdout.log.gz']);
    expect(fs.existsSync(path.join(dir, 'stdout.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'stderr.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'stdout.log.gz'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'stderr.log.gz'))).toBe(true);

    // Sanity: the gz round-trips back to the original bytes.
    const decompressed = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'stdout.log.gz'))).toString('utf8');
    expect(decompressed).toBe('hello stdout '.repeat(200));
  });

  it('drops empty log files instead of gzipping them', () => {
    const dir = makeTaskLog('t-empty', { stdout: '', stderr: 'real content' });
    fs.writeFileSync(path.join(dir, 'stdout.log'), '');

    const summary = compressTaskLogs('t-empty');

    expect(summary.compressed).toEqual(['stderr.log.gz']);
    expect(fs.existsSync(path.join(dir, 'stdout.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'stdout.log.gz'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'stderr.log.gz'))).toBe(true);
  });

  it('is idempotent — calling twice is a no-op the second time', () => {
    makeTaskLog('t-idem', { stdout: 'one', stderr: 'two' });

    compressTaskLogs('t-idem');
    const summary = compressTaskLogs('t-idem');

    // Both files were already gzipped — second pass reports them as
    // skipped (no longer present as raw .log files).
    expect(summary.compressed).toEqual([]);
    expect(summary.skipped).toEqual(expect.arrayContaining(['stdout.log', 'stderr.log']));
  });

  it('leaves prompt.txt alone (only stdout.log + stderr.log are compressed)', () => {
    const dir = makeTaskLog('t-prompt', { stdout: 'out', prompt: 'the prompt' });

    compressTaskLogs('t-prompt');

    expect(fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8')).toBe('the prompt');
  });

  it('rejects empty / non-string taskId', () => {
    expect(() => compressTaskLogs('')).toThrow(/non-empty taskId/);
    expect(() => compressTaskLogs(null)).toThrow(/non-empty taskId/);
  });
});

describe('pruneOldTaskLogs', () => {
  it('deletes dirs whose newest mtime is older than retentionDays', () => {
    makeTaskLog('t-fresh', { stdout: 'still warm' });
    makeTaskLog('t-stale', { stdout: 'cold', mtimeAgeMs: 60 * 24 * 60 * 60 * 1000 });

    const result = pruneOldTaskLogs(30);

    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].taskId).toBe('t-stale');
    expect(result.deleted[0].age_days).toBeGreaterThanOrEqual(30);
    expect(result.kept).toBe(1);
    expect(fs.existsSync(dataDir.getTaskLogDir('t-fresh'))).toBe(true);
    expect(fs.existsSync(dataDir.getTaskLogDir('t-stale'))).toBe(false);
  });

  it('uses the retention window strictly: a dir at the boundary is kept', () => {
    // 30 days minus a buffer — should still be inside retention.
    const justInside = 30 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
    makeTaskLog('t-edge', { stdout: 'x', mtimeAgeMs: justInside });

    const result = pruneOldTaskLogs(30);

    expect(result.deleted).toHaveLength(0);
    expect(result.kept).toBe(1);
  });

  it('clears empty task-log dirs but does not list them as deleted', () => {
    const dir = dataDir.getTaskLogDir('t-empty');
    fs.mkdirSync(dir, { recursive: true });
    // Empty dir — nothing to forensically audit.

    const result = pruneOldTaskLogs(30);

    expect(result.deleted).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('returns zeros when the task-logs root does not exist', () => {
    const root = path.join(dataDir.getDataDir(), 'task-logs');
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });

    const result = pruneOldTaskLogs(30);

    expect(result).toEqual({ deleted: [], kept: 0, errors: 0 });
  });

  it('falls back to the default 30-day retention when the input is invalid', () => {
    makeTaskLog('t-default', { stdout: 'cold', mtimeAgeMs: 60 * 24 * 60 * 60 * 1000 });

    const result = pruneOldTaskLogs(NaN);

    expect(result.deleted).toHaveLength(1);
  });
});

describe('getTaskLogDiskUsage', () => {
  it('aggregates total bytes, task count, and oldest-log age', () => {
    makeTaskLog('t-1', { stdout: 'aaa' });
    makeTaskLog('t-2', { stdout: 'bbbbb', mtimeAgeMs: 10 * 24 * 60 * 60 * 1000 });

    const usage = getTaskLogDiskUsage({ retentionDays: 30 });

    expect(usage.task_count).toBe(2);
    expect(usage.total_bytes).toBe(8); // 3 + 5
    expect(usage.oldest_log_age_days).toBeGreaterThanOrEqual(9.5);
    expect(usage.retention_days).toBe(30);
  });

  it('returns zeros + null oldest_log_age_days when no logs exist', () => {
    const usage = getTaskLogDiskUsage({ retentionDays: 30 });

    expect(usage).toEqual({
      total_bytes: 0,
      task_count: 0,
      oldest_log_age_days: null,
      retention_days: 30,
    });
  });

  it('skips empty task-log dirs in the count', () => {
    makeTaskLog('t-real', { stdout: 'real' });
    fs.mkdirSync(dataDir.getTaskLogDir('t-empty'), { recursive: true });

    const usage = getTaskLogDiskUsage({ retentionDays: 30 });

    expect(usage.task_count).toBe(1);
    expect(usage.total_bytes).toBe(4);
  });
});
