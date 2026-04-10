'use strict';

/**
 * server/providers/agentic-git-safety.js — Git safety net for agentic tasks.
 *
 * Snapshots git state before a task runs, then after completion reverts any
 * file changes that were not authorized by the task description. Prevents
 * agentic tools from silently dirtying unrelated files.
 *
 * Usage:
 *   const { captureSnapshot, checkAndRevert } = require('./agentic-git-safety');
 *   const snapshot = captureSnapshot(workingDir);
 *   // ... run task ...
 *   const { reverted, kept, report } = checkAndRevert(workingDir, snapshot, taskDesc, 'enforce');
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('../logger');

/** Max ms to wait for any git subprocess — prevents hanging in non-repo dirs. */
const GIT_TIMEOUT_MS = 8000;

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Run a git command in workingDir. Returns stdout string or throws on failure.
 * @param {string[]} args
 * @param {string} workingDir
 * @returns {string}
 */
function gitExec(args, workingDir) {
  return execFileSync('git', args, {
    cwd: workingDir,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
}

/**
 * Parse `git diff --name-only` output into a Set of file paths.
 * @param {string} output
 * @returns {Set<string>}
 */
function parseDirtyFiles(output) {
  const files = new Set();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) files.add(trimmed);
  }
  return files;
}

/**
 * Parse `git status --porcelain` output into a Set of untracked entries.
 * Only lines starting with `??` are untracked.
 * Entries may be files OR directories (e.g., `?? Accounting/`).
 * @param {string} output
 * @returns {Set<string>}
 */
function parseUntrackedFiles(output) {
  const files = new Set();
  for (const line of output.split('\n')) {
    if (line.startsWith('?? ')) {
      // Format: "?? path/to/file" or "?? SomeDir/" — strip the "?? " prefix
      const filePath = line.slice(3).trim();
      if (filePath) files.add(filePath);
    }
  }
  return files;
}

/**
 * Expand an untracked entry into individual file paths.
 * If the entry is a directory path (ends with '/'), use `git ls-files --others`
 * to enumerate the actual files within it. Otherwise return the path as-is.
 * @param {string} entry  — as returned by `git status --porcelain` (may end with '/')
 * @param {string} workingDir
 * @returns {string[]}
 */
function expandUntrackedEntry(entry, workingDir) {
  if (!entry.endsWith('/')) return [entry];
  try {
    const output = gitExec(
      ['ls-files', '--others', '--exclude-standard', entry],
      workingDir
    );
    const files = output.split('\n').map(l => l.trim()).filter(Boolean);
    return files.length > 0 ? files : [entry];
  } catch {
    return [entry];
  }
}

/**
 * Check whether a task description authorizes changes to a given file.
 * Authorization is granted if any path component of the file (basename,
 * parent directory, etc.) appears in the task description (case-insensitive).
 * @param {string} filePath
 * @param {string} taskDescription
 * @returns {boolean}
 */
function isAuthorized(filePath, taskDescription) {
  if (!taskDescription) return false;
  const desc = taskDescription.toLowerCase();
  // Normalize separators and strip trailing slash (directory entries)
  const normalized = filePath.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/').filter(Boolean);
  // Require matched components to be at least 5 chars to prevent false positives
  // from very short dir names (e.g. "src", "lib", "bin") while still matching
  // filenames like "main.cs" (7), "App.cs" (6), "index.ts" (8)
  const components = parts.filter(c => c.length >= 5);
  for (const part of components) {
    if (part && desc.includes(part.toLowerCase())) return true;
  }
  return false;
}

function normalizeRelativePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/$/, '');
}

function isAuthorizedByPathScope(filePath, authorizedPaths) {
  if (!Array.isArray(authorizedPaths) || authorizedPaths.length === 0) return false;
  const normalizedFilePath = normalizeRelativePath(filePath);
  return authorizedPaths.some((entry) => {
    const normalizedEntry = normalizeRelativePath(entry);
    if (!normalizedEntry) return false;
    return normalizedFilePath === normalizedEntry || normalizedFilePath.startsWith(`${normalizedEntry}/`);
  });
}

/**
 * Check whether a file path is git-ignored in workingDir.
 * @param {string} filePath
 * @param {string} workingDir
 * @returns {boolean}
 */
function isGitIgnored(filePath, workingDir) {
  try {
    execFileSync('git', ['check-ignore', '-q', filePath], {
      cwd: workingDir,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return true; // exit code 0 → ignored
  } catch {
    return false; // non-zero → not ignored
  }
}

function captureCurrentGitState(workingDir) {
  const diffOutput = gitExec(['diff', '--name-only'], workingDir);
  const statusOutput = gitExec(['status', '--porcelain'], workingDir);
  return {
    currentDirty: parseDirtyFiles(diffOutput),
    currentUntracked: parseUntrackedFiles(statusOutput),
  };
}

function toScopedRelativePath(workingDir, filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return null;
  }
  const trimmed = filePath.trim();
  const relativePath = path.isAbsolute(trimmed)
    ? path.relative(workingDir, trimmed)
    : trimmed;
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.startsWith('..')) {
    return null;
  }
  return normalized;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Capture current git state in workingDir.
 *
 * @param {string} workingDir
 * @returns {{ dirtyFiles: Set<string>, untrackedFiles: Set<string>, isGitRepo: boolean }}
 */
function captureSnapshot(workingDir) {
  try {
    const diffOutput = gitExec(['diff', '--name-only'], workingDir);
    const statusOutput = gitExec(['status', '--porcelain'], workingDir);
    return {
      dirtyFiles: parseDirtyFiles(diffOutput),
      untrackedFiles: parseUntrackedFiles(statusOutput),
      isGitRepo: true,
    };
  } catch (err) {
    logger.warn(`[git-safety] Snapshot capture failed for ${workingDir}: ${err.message} — git safety checks will be skipped for this task`);
    return { dirtyFiles: new Set(), untrackedFiles: new Set(), isGitRepo: false, _snapshotFailed: true };
  }
}

/**
 * Check git state against a previously captured snapshot and revert unauthorized changes.
 *
 * @param {string} workingDir
 * @param {{ dirtyFiles: Set<string>, untrackedFiles: Set<string>, isGitRepo: boolean }} snapshot
 * @param {string} taskDescription
 * @param {'enforce'|'warn'|'off'} [mode='enforce']
 * @param {{ authorizedPaths?: string[] }} [options]
 * @returns {{ reverted: string[], kept: string[], report: string }}
 */
function checkAndRevert(workingDir, snapshot, taskDescription, mode = 'enforce', options = {}) {
  if (mode === 'off') {
    return { reverted: [], kept: [], report: '' };
  }

  if (!snapshot.isGitRepo) {
    return { reverted: [], kept: [], report: '' };
  }

  if (snapshot._snapshotFailed) {
    logger.warn(`[git-safety] Skipping revert — snapshot capture had failed for ${workingDir}`);
    return { reverted: [], kept: [], report: 'Skipped: snapshot capture failed' };
  }

  // Capture fresh state
  let currentDirty = new Set();
  let currentUntracked = new Set();
  try {
    ({ currentDirty, currentUntracked } = captureCurrentGitState(workingDir));
  } catch {
    return { reverted: [], kept: [], report: '' };
  }

  // Newly dirty tracked files (not in snapshot)
  const newlyDirty = [...currentDirty].filter(f => !snapshot.dirtyFiles.has(f));

  // Newly untracked entries (not in snapshot) — expand directories to individual files
  const newlyUntrackedEntries = [...currentUntracked].filter(f => !snapshot.untrackedFiles.has(f));
  const newlyUntracked = newlyUntrackedEntries.flatMap(e => expandUntrackedEntry(e, workingDir));

  const reverted = [];
  const kept = [];
  const authorizedPaths = Array.isArray(options.authorizedPaths) ? options.authorizedPaths : [];

  // Handle newly dirty tracked files
  for (const filePath of newlyDirty) {
    if (isAuthorizedByPathScope(filePath, authorizedPaths) || isAuthorized(filePath, taskDescription)) {
      kept.push(filePath);
      continue;
    }
    if (mode === 'warn') {
      logger.warn(`[agentic-git-safety] Unauthorized change (warn mode, not reverted): ${filePath}`);
      kept.push(filePath);
    } else {
      try {
        gitExec(['checkout', '--', filePath], workingDir);
        reverted.push(filePath);
      } catch (err) {
        logger.warn(`[agentic-git-safety] Failed to revert ${filePath}: ${err.message}`);
        kept.push(filePath);
      }
    }
  }

  // Handle newly untracked files
  for (const filePath of newlyUntracked) {
    if (isAuthorizedByPathScope(filePath, authorizedPaths) || isAuthorized(filePath, taskDescription)) {
      kept.push(filePath);
      continue;
    }
    // Check gitignore before deleting
    if (isGitIgnored(filePath, workingDir)) {
      kept.push(filePath);
      continue;
    }
    if (mode === 'warn') {
      logger.warn(`[agentic-git-safety] Unauthorized new file (warn mode, not deleted): ${filePath}`);
      kept.push(filePath);
    } else {
      const fullPath = path.resolve(workingDir, filePath);
      try {
        fs.unlinkSync(fullPath);
        reverted.push(filePath);
      } catch (err) {
        logger.warn(`[agentic-git-safety] Failed to delete ${filePath}: ${err.message}`);
        kept.push(filePath);
      }
    }
  }

  let report = '';
  if (reverted.length > 0) {
    report = `Reverted ${reverted.length} unauthorized change${reverted.length === 1 ? '' : 's'}: ${reverted.join(', ')}`;
  }

  return { reverted, kept, report };
}

/**
 * Revert only the specified files if they were changed after the snapshot.
 * Preserves pre-existing dirty/untracked state by only touching snapshot deltas.
 *
 * @param {string} workingDir
 * @param {{ dirtyFiles: Set<string>, untrackedFiles: Set<string>, isGitRepo: boolean }} snapshot
 * @param {string[]} targetFiles
 * @returns {{ reverted: string[], kept: string[], report: string }}
 */
function revertScopedChanges(workingDir, snapshot, targetFiles) {
  if (!snapshot?.isGitRepo || snapshot?._snapshotFailed) {
    return { reverted: [], kept: [], report: '' };
  }

  const requestedPaths = new Set(
    (Array.isArray(targetFiles) ? targetFiles : [])
      .map((filePath) => toScopedRelativePath(workingDir, filePath))
      .filter(Boolean)
  );
  if (requestedPaths.size === 0) {
    return { reverted: [], kept: [], report: '' };
  }

  let currentDirty = new Set();
  let currentUntracked = new Set();
  try {
    ({ currentDirty, currentUntracked } = captureCurrentGitState(workingDir));
  } catch {
    return { reverted: [], kept: [...requestedPaths], report: '' };
  }

  const newlyDirty = [...currentDirty]
    .filter((filePath) => !snapshot.dirtyFiles.has(filePath))
    .filter((filePath) => requestedPaths.has(normalizeRelativePath(filePath)));

  const newlyUntrackedEntries = [...currentUntracked].filter((filePath) => !snapshot.untrackedFiles.has(filePath));
  const newlyUntracked = newlyUntrackedEntries
    .flatMap((entry) => expandUntrackedEntry(entry, workingDir))
    .filter((filePath) => requestedPaths.has(normalizeRelativePath(filePath)));

  const reverted = [];
  const kept = [];

  for (const filePath of newlyDirty) {
    try {
      gitExec(['checkout', '--', filePath], workingDir);
      reverted.push(filePath);
    } catch (err) {
      logger.warn(`[agentic-git-safety] Failed to revert scoped tracked file ${filePath}: ${err.message}`);
      kept.push(filePath);
    }
  }

  for (const filePath of newlyUntracked) {
    if (isGitIgnored(filePath, workingDir)) {
      kept.push(filePath);
      continue;
    }
    const fullPath = path.resolve(workingDir, filePath);
    try {
      fs.unlinkSync(fullPath);
      reverted.push(filePath);
    } catch (err) {
      logger.warn(`[agentic-git-safety] Failed to delete scoped untracked file ${filePath}: ${err.message}`);
      kept.push(filePath);
    }
  }

  const reportParts = [];
  if (reverted.length > 0) {
    reportParts.push(`Reverted ${reverted.length} failed task change${reverted.length === 1 ? '' : 's'}: ${reverted.join(', ')}`);
  }
  if (kept.length > 0) {
    reportParts.push(`Could not automatically revert ${kept.length} task change${kept.length === 1 ? '' : 's'}: ${kept.join(', ')}`);
  }

  return {
    reverted,
    kept,
    report: reportParts.join('\n'),
  };
}

module.exports = { captureSnapshot, checkAndRevert, revertScopedChanges };
