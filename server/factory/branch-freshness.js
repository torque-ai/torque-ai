'use strict';

const childProcess = require('node:child_process');

const DEFAULT_STALE_PATH_PATTERNS = Object.freeze([
  'tests/**/Approvals/**',
  '*.baseline*',
]);

function runGit(worktreePath, args) {
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
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      finish({ code: 1, stdout: '', stderr: err.message, error: err });
      return;
    }

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      finish({ code: 1, stdout, stderr: stderr || err.message, error: err });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr });
    });
  });
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

  const result = await runGit(worktreePath, ['rebase', baseRef]);
  if (result.code === 0) {
    return { ok: true };
  }

  await runGit(worktreePath, ['rebase', '--abort']);
  const error = (result.stderr || result.stdout || `git rebase exited with code ${result.code}`).trim();
  return { ok: false, error };
}

module.exports = {
  computeCommitsBehind,
  getMasterChangesSinceMergeBase,
  checkBranchFreshness,
  attemptRebase,
  DEFAULT_STALE_PATH_PATTERNS,
};
