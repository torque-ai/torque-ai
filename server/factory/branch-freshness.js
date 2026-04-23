'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STALE_PATH_PATTERNS = Object.freeze([
  'tests/**/Approvals/**',
  '*.baseline*',
]);
const NON_PRODUCT_REBASE_CLEANUP_PATTERNS = Object.freeze([
  /^runs\//i,
  /^logs\//i,
  /^\.torque-checkpoints\//i,
  /^\.tmp\//i,
  /^tmp\//i,
  /^docs\/superpowers\/plans\//i,
]);

function runGit(worktreePath, args, options = {}) {
  if (!worktreePath || !Array.isArray(args) || args.length === 0) {
    return Promise.resolve({ code: 1, stdout: '', stderr: 'invalid git invocation' });
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      child = childProcess.spawn('git', args, {
        cwd: worktreePath,
        stdio: [options.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      finish({ code: 1, stdout: '', stderr: err.message, error: err });
      return;
    }

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    if (options.stdin != null && child.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
    child.on('error', (err) => {
      finish({ code: 1, stdout, stderr: stderr || err.message, error: err });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

function normalizeRelativePath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
}

function normalizePaths(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isStaleSensitivePath(filePath, patterns = DEFAULT_STALE_PATH_PATTERNS) {
  if (!filePath) return false;
  const activePatterns = Array.isArray(patterns) && patterns.length > 0
    ? patterns
    : DEFAULT_STALE_PATH_PATTERNS;

  return activePatterns.some((pattern) => {
    if (pattern === 'tests/**/Approvals/**') {
      return filePath.includes('/Approvals/') || filePath.includes('\\Approvals\\');
    }
    if (pattern === '*.baseline*') {
      return /\.baseline/.test(filePath);
    }
    return filePath.includes(pattern);
  });
}

function isNonProductRebaseCleanupPath(filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (!normalized) return false;
  return NON_PRODUCT_REBASE_CLEANUP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function extractPorcelainPath(line) {
  if (typeof line !== 'string' || line === '') {
    return null;
  }
  if (line.length >= 3 && line[2] === ' ') {
    return line.slice(3).trim();
  }
  if (line.length >= 2 && line[1] === ' ') {
    return line.slice(2).trim();
  }
  return line.trim();
}

function parsePorcelainEntries(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const filePath = extractPorcelainPath(line);
      if (!filePath) {
        return null;
      }
      const normalized = filePath.includes(' -> ')
        ? filePath.split(' -> ').pop()
        : filePath;
      return {
        path: normalizeRelativePath(normalized.replace(/^"+|"+$/g, '')),
        untracked: line.startsWith('?? '),
      };
    })
    .filter((entry) => entry && entry.path);
}

function assertPathInsideWorktree(worktreePath, relativePath) {
  const root = path.resolve(worktreePath);
  const resolved = path.resolve(root, relativePath);
  const rootCompare = root.replace(/\\/g, '/').toLowerCase();
  const resolvedCompare = resolved.replace(/\\/g, '/').toLowerCase();
  if (resolvedCompare !== rootCompare && !resolvedCompare.startsWith(`${rootCompare}/`)) {
    throw new Error(`Refusing to clean path outside worktree: ${relativePath}`);
  }
  return resolved;
}

function removeEmptyParents(worktreePath, filePath) {
  const root = path.resolve(worktreePath);
  let current = path.dirname(filePath);
  while (current && current !== root && current.startsWith(root)) {
    try {
      fs.rmdirSync(current);
      current = path.dirname(current);
    } catch {
      return;
    }
  }
}

async function cleanupNonProductWorktreeChanges(worktreePath) {
  const statusResult = await runGit(worktreePath, ['status', '--porcelain']);
  if (statusResult.code !== 0) {
    return {
      restored: [],
      removed: [],
      error: (statusResult.stderr || statusResult.stdout || `git status exited with code ${statusResult.code}`).trim(),
    };
  }

  const entries = parsePorcelainEntries(statusResult.stdout)
    .filter((entry) => isNonProductRebaseCleanupPath(entry.path));
  const tracked = entries.filter((entry) => !entry.untracked).map((entry) => entry.path);
  const untracked = entries.filter((entry) => entry.untracked).map((entry) => entry.path);
  const restored = [];
  const removed = [];

  if (tracked.length > 0) {
    const restoreResult = await runGit(
      worktreePath,
      ['restore', '--worktree', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { stdin: tracked.join('\0') },
    );
    if (restoreResult.code !== 0) {
      return {
        restored,
        removed,
        error: (restoreResult.stderr || restoreResult.stdout || `git restore exited with code ${restoreResult.code}`).trim(),
      };
    }
    restored.push(...tracked);
  }

  for (const relativePath of untracked) {
    const target = assertPathInsideWorktree(worktreePath, relativePath);
    if (!fs.existsSync(target)) {
      continue;
    }
    const stat = fs.lstatSync(target);
    fs.rmSync(target, { recursive: stat.isDirectory(), force: true });
    removed.push(relativePath);
    removeEmptyParents(worktreePath, target);
  }

  return { restored, removed };
}

async function computeCommitsBehind(worktreePath, branch, baseRef) {
  if (!worktreePath || !branch || !baseRef) return null;
  const result = await runGit(worktreePath, ['rev-list', '--count', `${branch}..${baseRef}`]);
  if (result.code !== 0) return null;
  const count = Number.parseInt(String(result.stdout || '').trim(), 10);
  return Number.isFinite(count) ? count : null;
}

async function getMasterChangesSinceMergeBase(worktreePath, branch, baseRef, patterns = DEFAULT_STALE_PATH_PATTERNS) {
  if (!worktreePath || !branch || !baseRef) return [];

  const mergeBaseResult = await runGit(worktreePath, ['merge-base', baseRef, branch]);
  if (mergeBaseResult.code !== 0) return [];

  const mergeBase = String(mergeBaseResult.stdout || '').trim();
  if (!mergeBase) return [];

  const diffResult = await runGit(worktreePath, ['diff', '--name-only', `${mergeBase}..${baseRef}`]);
  if (diffResult.code !== 0) return [];

  return normalizePaths(diffResult.stdout)
    .filter((filePath) => isStaleSensitivePath(filePath, patterns));
}

async function checkBranchFreshness({
  worktreePath,
  branch,
  baseRef = 'master',
  threshold = 5,
  stalePathPatterns = DEFAULT_STALE_PATH_PATTERNS,
} = {}) {
  const normalizedThreshold = Number.isFinite(Number(threshold)) ? Number(threshold) : 5;
  const [commitsBehind, staleFiles] = await Promise.all([
    computeCommitsBehind(worktreePath, branch, baseRef),
    getMasterChangesSinceMergeBase(worktreePath, branch, baseRef, stalePathPatterns),
  ]);

  if (staleFiles.length > 0) {
    return {
      stale: true,
      reason: 'stale_sensitive_paths',
      commitsBehind,
      staleFiles,
    };
  }

  if (commitsBehind !== null && commitsBehind > normalizedThreshold) {
    return {
      stale: true,
      reason: 'commits_behind',
      commitsBehind,
      staleFiles,
    };
  }

  return {
    stale: false,
    reason: null,
    commitsBehind,
    staleFiles,
  };
}

async function attemptRebase(worktreePath, branch, baseRef) {
  if (!worktreePath || !branch || !baseRef) {
    return { ok: false, error: 'worktreePath, branch, and baseRef are required' };
  }

  const cleanupResult = await cleanupNonProductWorktreeChanges(worktreePath);
  if (cleanupResult.error) {
    return withCleanupOutcome({
      ok: false,
      error: `failed to clean non-product changes before rebase: ${cleanupResult.error}`,
    }, cleanupResult);
  }

  const result = await runGit(worktreePath, ['rebase', baseRef]);
  if (result.code === 0) {
    return withCleanupOutcome({ ok: true }, cleanupResult);
  }

  await runGit(worktreePath, ['rebase', '--abort']);
  const error = (result.stderr || result.stdout || `git rebase exited with code ${result.code}`).trim();
  return withCleanupOutcome({ ok: false, error }, cleanupResult);
}

function withCleanupOutcome(result, cleanupResult) {
  if (cleanupResult?.restored?.length) {
    result.restoredNonProductPaths = cleanupResult.restored;
  }
  if (cleanupResult?.removed?.length) {
    result.removedNonProductPaths = cleanupResult.removed;
  }
  return result;
}

module.exports = {
  computeCommitsBehind,
  getMasterChangesSinceMergeBase,
  checkBranchFreshness,
  attemptRebase,
  cleanupNonProductWorktreeChanges,
  DEFAULT_STALE_PATH_PATTERNS,
  NON_PRODUCT_REBASE_CLEANUP_PATTERNS,
};
