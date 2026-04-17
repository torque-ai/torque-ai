'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

function sanitizeSlug(title = '', maxLen = 40) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
  return slug || 'work-item';
}

function resolveBashOnWindows() {
  const candidates = [
    process.env.GIT_BASH,
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      // ignore
    }
  }
  return null;
}

function spawnInBash(bashCmd, options) {
  if (process.platform === 'win32') {
    const bashPath = resolveBashOnWindows();
    if (!bashPath) {
      return {
        status: 1,
        stdout: '',
        stderr: 'Git Bash not found on this Windows host',
        error: { message: 'bash_not_found' },
      };
    }
    return spawnSync(bashPath, ['-lc', bashCmd], { ...options, windowsHide: true });
  }
  return spawnSync('bash', ['-lc', bashCmd], options);
}

function spawnInSystemShell(command, options) {
  if (process.platform === 'win32') {
    return spawnSync('cmd', ['/d', '/s', '/c', command], { ...options, windowsHide: true });
  }
  return spawnSync('sh', ['-lc', command], options);
}

function summarizeVerifyFailure(result) {
  const text = [result && result.stderr, result && result.error, result && result.stdout]
    .filter(Boolean)
    .join('\n');
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line || 'remote verify unavailable';
}

function shouldFallbackToLocalVerify(result) {
  const text = [result && result.stderr, result && result.error, result && result.stdout]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  if (!text) return false;
  return (
    text.includes('[push-worktree-branch]')
    || text.includes('could not resolve host')
    || text.includes('could not read from remote repository')
    || text.includes('repository not found')
    || text.includes('git bash not found')
    || text.includes('bash_not_found')
    || (text.includes('torque-remote') && (
      text.includes('not found')
      || text.includes('is not recognized')
      || text.includes('enoent')
    ))
  );
}

function defaultRunRemoteVerify({ branch, command, cwd, logger }) {
  const resolvedCwd = cwd || process.cwd();
  if (logger) logger.info('factory worktree verify: running torque-remote', { branch, command, cwd: resolvedCwd });
  // torque-remote auto-detects branch from cwd and forces remote to match
  // origin/<branch>. The worktree branch must be pushed first; do that here so
  // remote can sync. Use --no-verify on the push because the worktree branch is
  // a non-main feature branch (the gate skips tests for non-main pushes anyway).
  const baseEnv = { cwd: resolvedCwd, encoding: 'utf8', timeout: 30 * 60 * 1000 };
  const pushCmd = `git push --no-verify --force-with-lease origin HEAD:refs/heads/${branch}`;
  const pushResult = spawnInBash(pushCmd, baseEnv);
  if (pushResult.status !== 0) {
    return {
      exitCode: 1,
      stdout: pushResult.stdout || '',
      stderr: `[push-worktree-branch] ${pushResult.stderr || ''}`,
      error: pushResult.error ? pushResult.error.message : null,
    };
  }
  const verifyResult = spawnInBash(`torque-remote ${JSON.stringify(command)}`, baseEnv);
  return {
    exitCode: typeof verifyResult.status === 'number' ? verifyResult.status : 1,
    stdout: verifyResult.stdout || '',
    stderr: verifyResult.stderr || '',
    error: verifyResult.error ? verifyResult.error.message : null,
  };
}

function defaultRunLocalVerify({ branch, command, cwd, logger, fallbackReason }) {
  const resolvedCwd = cwd || process.cwd();
  if (logger) {
    logger.warn('factory worktree verify: falling back to local execution', {
      branch,
      command,
      cwd: resolvedCwd,
      fallback_reason: fallbackReason || null,
    });
  }
  const result = spawnInSystemShell(command, {
    cwd: resolvedCwd,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
  });
  return {
    exitCode: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
  };
}

function createWorktreeRunner({
  worktreeManager,
  runRemoteVerify = defaultRunRemoteVerify,
  runLocalVerify = defaultRunLocalVerify,
  logger,
} = {}) {
  if (!worktreeManager || typeof worktreeManager.createWorktree !== 'function') {
    throw new Error('worktree-runner requires a worktreeManager with createWorktree/mergeWorktree/cleanupWorktree');
  }

  async function createForBatch({ project, workItem, batchId }) {
    if (!project || !project.path) throw new Error('createForBatch requires project.path');
    if (!workItem || !workItem.id) throw new Error('createForBatch requires workItem.id');
    const slug = sanitizeSlug(workItem.title || `item-${workItem.id}`);
    const featureName = `factory-${workItem.id}-${slug}`;

    // Detect the default branch — some projects use 'master' not 'main'.
    let baseBranch = 'main';
    try {
      const headRef = spawnInBash(
        `cd "${project.path}" && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||'`,
        { encoding: 'utf8', windowsHide: true }
      );
      const detected = (headRef.stdout || '').trim();
      if (detected) {
        baseBranch = detected;
      } else {
        const masterCheck = spawnInBash(
          `cd "${project.path}" && git rev-parse --verify master 2>/dev/null`,
          { encoding: 'utf8', windowsHide: true }
        );
        if (masterCheck.status === 0) baseBranch = 'master';
      }
    } catch (_e) { void _e; }

    const record = worktreeManager.createWorktree(project.path, featureName, {
      baseBranch,
    });
    if (logger) {
      logger.info('factory worktree created', {
        project_id: project.id,
        work_item_id: workItem.id,
        batch_id: batchId || null,
        worktree_path: record.worktree_path,
        branch: record.branch,
      });
    }
    return {
      id: record.id,
      worktreePath: record.worktree_path,
      branch: record.branch,
    };
  }

  async function verify({ worktreePath, branch, verifyCommand, workingDirectory }) {
    if (!branch) throw new Error('verify requires branch');
    const command = String(verifyCommand || 'cd server && npx vitest run').trim();
    const cwd = workingDirectory || worktreePath;
    const start = Date.now();
    let out = await Promise.resolve(runRemoteVerify({ branch, command, cwd, logger }));
    if (out && out.exitCode !== 0 && shouldFallbackToLocalVerify(out)) {
      const fallbackSummary = summarizeVerifyFailure(out);
      const localResult = await Promise.resolve(runLocalVerify({
        branch,
        command,
        cwd,
        logger,
        fallbackReason: fallbackSummary,
      }));
      out = {
        exitCode: localResult.exitCode,
        stdout: localResult.stdout || '',
        stderr: [
          `[fallback-local-verify] ${fallbackSummary}`,
          localResult.stderr || '',
        ].filter(Boolean).join('\n'),
        error: localResult.error ? localResult.error : null,
      };
    }
    const durationMs = Date.now() - start;
    const passed = out && typeof out === 'object' ? out.exitCode === 0 : false;
    const output = [
      out && out.stdout ? out.stdout : '',
      out && out.stderr ? `\n[stderr]\n${out.stderr}` : '',
      out && out.error ? `\n[error] ${out.error}` : '',
    ].join('').trim();
    if (logger) {
      logger.info('factory worktree verify finished', {
        branch,
        worktree_path: worktreePath,
        passed,
        duration_ms: durationMs,
        exit_code: out && out.exitCode,
      });
    }
    return { passed, output, durationMs };
  }

  async function mergeToMain({ id, branch, target = 'main', strategy = 'merge' }) {
    if (!id && !branch) throw new Error('mergeToMain requires id or branch');
    let worktreeId = id;
    if (!worktreeId && typeof worktreeManager.listWorktrees === 'function') {
      const all = worktreeManager.listWorktrees();
      const match = all.find((w) => w.branch === branch);
      if (!match) throw new Error(`mergeToMain: no worktree found for branch ${branch}`);
      worktreeId = match.id;
    }
    const result = worktreeManager.mergeWorktree(worktreeId, {
      strategy,
      targetBranch: target,
      deleteAfter: true,
    });
    if (logger) {
      logger.info('factory worktree merged', {
        worktree_id: worktreeId,
        branch: result && result.branch,
        target_branch: target,
        strategy,
        cleaned: result && result.cleaned,
      });
    }
    return result;
  }

  async function abandon({ id, branch, reason }) {
    let worktreeId = id;
    if (!worktreeId && typeof worktreeManager.listWorktrees === 'function') {
      const all = worktreeManager.listWorktrees();
      const match = all.find((w) => w.branch === branch);
      if (!match) {
        if (logger) logger.warn('factory worktree abandon: no worktree found', { branch, reason });
        return null;
      }
      worktreeId = match.id;
    }
    const cleaned = worktreeManager.cleanupWorktree(worktreeId, {
      deleteBranch: true,
      force: true,
    });
    if (logger) {
      logger.warn('factory worktree abandoned', {
        worktree_id: worktreeId,
        branch,
        reason: reason || null,
      });
    }
    return cleaned;
  }

  return { createForBatch, verify, mergeToMain, abandon };
}

module.exports = {
  createWorktreeRunner,
  sanitizeSlug,
};
