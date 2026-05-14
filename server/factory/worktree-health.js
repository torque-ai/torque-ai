'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { TASK_TIMEOUTS } = require('../constants');
const { GIT_SAFE_ENV, cleanupStaleGitStatusProcesses } = require('../utils/git');

const DEFAULT_TIMEOUT_MS = TASK_TIMEOUTS.GIT_STATUS || 5000;

function buildGitEnv(env = process.env) {
  const next = { ...env, ...GIT_SAFE_ENV };
  delete next.GIT_DIR;
  delete next.GIT_WORK_TREE;
  delete next.GIT_INDEX_FILE;
  delete next.GIT_OBJECT_DIRECTORY;
  delete next.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  return next;
}

function normalizeGitPathForCompare(value) {
  let normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  normalized = normalized.replace(/^\/([A-Za-z])\//, (_, drive) => `${drive.toUpperCase()}:/`);
  try {
    normalized = path.resolve(normalized).replace(/\\/g, '/').replace(/\/+$/, '');
  } catch {
    // Keep the normalized string from above.
  }
  return normalized.toLowerCase();
}

function extractGitError(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n') || 'git probe failed';
}

function runGit(worktreePath, args, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeout)) ? Number(options.timeout) : DEFAULT_TIMEOUT_MS;
  const isStatusProbe = args[0] === 'status' && args.some((arg) => /^--porcelain(?:=|$)/.test(String(arg || '')));

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timeoutHandle = null;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(result);
    };

    try {
      child = childProcess.spawn('git', args, {
        cwd: worktreePath,
        env: buildGitEnv(options.env || process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish(error);
      return;
    }

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      if (isStatusProbe) cleanupStaleGitStatusProcesses({ force: true });
      finish(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(null, stdout);
        return;
      }
      const suffix = signal ? ` signal ${signal}` : ` code ${code}`;
      finish(new Error(`git ${args.join(' ')} failed with${suffix}`));
    });
  });
}

async function checkWorktreeGitHealth(worktreePath, options = {}) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { ok: false, reason: 'missing', error: 'worktree path is missing' };
  }

  let topLevel = '';
  try {
    topLevel = String(await runGit(worktreePath, ['rev-parse', '--show-toplevel'], options)).trim();
  } catch (error) {
    return {
      ok: false,
      reason: 'git_probe_failed',
      error: extractGitError(error),
    };
  }

  const expectedRoot = normalizeGitPathForCompare(worktreePath);
  const actualRoot = normalizeGitPathForCompare(topLevel);
  if (!actualRoot || actualRoot !== expectedRoot) {
    return {
      ok: false,
      reason: 'not_worktree_root',
      error: `git top-level ${topLevel || '<empty>'} did not match ${worktreePath}`,
      topLevel,
    };
  }

  try {
    await runGit(worktreePath, ['status', '--porcelain', '--untracked-files=no'], options);
  } catch (error) {
    return {
      ok: false,
      reason: 'git_status_failed',
      error: extractGitError(error),
      topLevel,
    };
  }

  return {
    ok: true,
    reason: null,
    topLevel,
  };
}

module.exports = {
  checkWorktreeGitHealth,
  _internalForTests: {
    buildGitEnv,
    normalizeGitPathForCompare,
    extractGitError,
  },
};
