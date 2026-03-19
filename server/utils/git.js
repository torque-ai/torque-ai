'use strict';

/**
 * Git status parsing utilities for TORQUE
 *
 * Consolidates 4+ git status parsing patterns from task-manager.js
 * and automation-handlers.js into reusable functions.
 *
 * Includes a TTL-cached worktree fingerprint helper to prevent
 * git-status storms when multiple callers probe the same repo.
 */

const { execFileSync } = require('child_process');
const { TASK_TIMEOUTS } = require('../constants');

// Safe environment variables that prevent git from blocking on prompts
// or acquiring optional locks (which can hang on Windows).
const GIT_SAFE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

/**
 * Execute a git command with safe defaults that prevent orphaned processes.
 *
 * On Windows, vitest worker forks don't propagate SIGTERM to child processes.
 * Without a timeout, git.exe survives after the worker is killed — creating
 * orphaned processes that accumulate memory. This wrapper enforces:
 * - A mandatory timeout (defaults to GIT_STATUS 5s)
 * - windowsHide: true (prevents console window flicker)
 * - GIT_TERMINAL_PROMPT=0 (prevents credential/passphrase prompts)
 * - GIT_OPTIONAL_LOCKS=0 (prevents lock contention hangs)
 *
 * @param {string[]} args - Git subcommand and arguments (e.g. ['status', '--porcelain'])
 * @param {Object} [opts] - Options passed to execFileSync (cwd, encoding, etc.)
 * @param {number} [opts.timeout] - Override timeout (default: TASK_TIMEOUTS.GIT_STATUS)
 * @returns {string|Buffer} Git command output
 */
function safeGitExec(args, opts = {}) {
  const merged = {
    encoding: 'utf8',
    timeout: TASK_TIMEOUTS.GIT_STATUS,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...opts,
    env: { ...process.env, ...GIT_SAFE_ENV, ...(opts.env || {}) },
  };
  return execFileSync('git', args, merged);
}

// ─── Worktree fingerprint cache ─────────────────────────────────────
// Prevents git-status storms: multiple callers asking for the same
// working directory within the TTL share one cached result instead
// of each spawning their own git processes.
const _fingerprintCache = new Map(); // workingDir → { fingerprint, timestamp }
const DEFAULT_FINGERPRINT_TTL_MS = 10_000; // 10 seconds
const MAX_FINGERPRINT_CACHE = 500; // evict oldest entries beyond this limit

/**
 * Parse a single line of `git status --porcelain` output.
 * @param {string} line - e.g. "M  src/foo.ts", "?? new-file.js", ' D "quoted path.ts"'
 * @returns {{ indexStatus: string, workStatus: string, filePath: string, isNew: boolean, isModified: boolean, isDeleted: boolean, isRenamed: boolean } | null}
 */
function parseGitStatusLine(line) {
  if (!line || line.length < 4) return null;
  const indexStatus = line[0];   // X = staging area
  const workStatus = line[1];    // Y = working tree
  const filePath = line.slice(3).replace(/^"/, '').replace(/"$/, '').trim();
  if (!filePath) return null;
  return {
    indexStatus,
    workStatus,
    filePath,
    isNew: indexStatus === 'A' || (indexStatus === '?' && workStatus === '?'),
    isModified: indexStatus === 'M' || workStatus === 'M',
    isDeleted: indexStatus === 'D' || workStatus === 'D',
    isRenamed: indexStatus === 'R',
  };
}

/**
 * Run `git status --porcelain` and return parsed file entries.
 * @param {string} workingDir
 * @param {{ timeout?: number }} [opts]
 * @returns {Array<{ indexStatus: string, workStatus: string, filePath: string, isNew: boolean, isModified: boolean, isDeleted: boolean, isRenamed: boolean }>}
 */
function getModifiedFiles(workingDir, opts = {}) {
  const timeout = opts.timeout || TASK_TIMEOUTS.GIT_STATUS;
  const result = safeGitExec(['status', '--porcelain'], {
    cwd: workingDir, timeout,
  }).trim();
  if (!result) return [];
  return result.split('\n')
    .map(line => parseGitStatusLine(line))
    .filter(Boolean);
}

/**
 * Get a cached worktree fingerprint (HEAD SHA + porcelain status).
 * Returns a cached result if within TTL, otherwise shells out to git.
 * Prevents git-status storms when multiple callers probe concurrently.
 *
 * @param {string} workingDir - Absolute path to the git working directory
 * @param {{ ttl?: number }} [opts] - TTL in ms (default 10s)
 * @returns {string} Fingerprint string (empty if not a git repo)
 */
function getWorktreeFingerprint(workingDir, opts = {}) {
  const ttl = opts.ttl || DEFAULT_FINGERPRINT_TTL_MS;
  const now = Date.now();

  const cached = _fingerprintCache.get(workingDir);
  if (cached && (now - cached.timestamp) < ttl) {
    return cached.fingerprint;
  }

  let fingerprint = '';
  try {
    const head = safeGitExec(['rev-parse', 'HEAD'], {
      cwd: workingDir, timeout: 5000,
    }).trim();
    fingerprint += head;
  } catch { /* not a git repo or detached HEAD */ }

  try {
    const status = safeGitExec(['status', '--porcelain'], {
      cwd: workingDir, timeout: 5000,
    }).trim();
    fingerprint += '\n' + status;
  } catch { /* not a git repo */ }

  // Evict oldest entry when cache exceeds limit (Map preserves insertion order)
  if (_fingerprintCache.size >= MAX_FINGERPRINT_CACHE) {
    const oldestKey = _fingerprintCache.keys().next().value;
    _fingerprintCache.delete(oldestKey);
  }
  _fingerprintCache.set(workingDir, { fingerprint, timestamp: now });
  return fingerprint;
}

/**
 * Invalidate the fingerprint cache for a specific directory.
 * Useful after a known git operation (commit, checkout, etc.).
 * @param {string} [workingDir] - Dir to invalidate, or all if omitted
 */
function invalidateFingerprintCache(workingDir) {
  if (workingDir) {
    _fingerprintCache.delete(workingDir);
  } else {
    _fingerprintCache.clear();
  }
}

module.exports = {
  safeGitExec,
  GIT_SAFE_ENV,
  parseGitStatusLine,
  getModifiedFiles,
  getWorktreeFingerprint,
  invalidateFingerprintCache,
  _fingerprintCache, // exposed for testing
};
