'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');

// Async variant of spawnInBash that returns a Promise — used for verify
// commands that can run up to 30 minutes. spawnSync would block the Node
// event loop for the entire duration, freezing all HTTP responses and
// other factory loops.
function spawnInBashAsync(bashCmd, options = {}) {
  return new Promise((resolve) => {
    let cmd, args;
    if (process.platform === 'win32') {
      const bashPath = resolveBashOnWindows();
      if (!bashPath) {
        resolve({ status: 1, stdout: '', stderr: 'Git Bash not found on this Windows host', error: { message: 'bash_not_found' } });
        return;
      }
      cmd = bashPath;
      args = ['-lc', bashCmd];
    } else {
      cmd = 'bash';
      args = ['-lc', bashCmd];
    }
    const child = spawn(cmd, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timer = null;
    let timedOut = false;
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch (_e) { void _e; }
      }, options.timeout);
    }
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ status: 1, stdout, stderr, error: err });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const error = timedOut ? { message: `timeout after ${options.timeout}ms` } : null;
      resolve({ status: typeof code === 'number' ? code : 1, stdout, stderr, error, signal });
    });
  });
}

// Resolve the system shell binary + args for the given platform. On Windows
// we use process.env.ComSpec (typically C:\Windows\System32\cmd.exe) so the
// spawn doesn't rely on `cmd` being on PATH — child processes inherited from
// some parents have a stripped PATH and `spawn('cmd', ...)` fails with ENOENT.
function resolveSystemShellCommand(platform, command) {
  if (platform === 'win32') {
    const cmd = process.env.ComSpec || 'cmd.exe';
    return { cmd, args: ['/d', '/s', '/c', command] };
  }
  return { cmd: 'sh', args: ['-lc', command] };
}

function spawnInSystemShellAsync(command, options = {}) {
  return new Promise((resolve) => {
    const { cmd, args } = resolveSystemShellCommand(process.platform, command);
    const child = spawn(cmd, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timer = null;
    let timedOut = false;
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch (_e) { void _e; }
      }, options.timeout);
    }
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ status: 1, stdout, stderr, error: err });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const error = timedOut ? { message: `timeout after ${options.timeout}ms` } : null;
      resolve({ status: typeof code === 'number' ? code : 1, stdout, stderr, error, signal });
    });
  });
}

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
  const { cmd, args } = resolveSystemShellCommand(process.platform, command);
  return spawnSync(cmd, args, { ...options, windowsHide: true });
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

async function defaultRunRemoteVerify({ branch, command, cwd, logger }) {
  const resolvedCwd = cwd || process.cwd();
  if (logger) logger.info('factory worktree verify: running torque-remote', { branch, command, cwd: resolvedCwd });
  // torque-remote auto-detects branch from cwd and forces remote to match
  // origin/<branch>. The worktree branch must be pushed first; do that here so
  // remote can sync. Use --no-verify on the push because the worktree branch is
  // a non-main feature branch (the gate skips tests for non-main pushes anyway).
  // Use async spawn so the Node event loop stays responsive during the up-to-30-minute
  // verify command — spawnSync would freeze all HTTP responses and other factory loops.
  const baseEnv = { cwd: resolvedCwd, timeout: 30 * 60 * 1000 };
  const pushCmd = `git push --no-verify --force-with-lease origin HEAD:refs/heads/${branch}`;
  const pushResult = await spawnInBashAsync(pushCmd, baseEnv);
  if (pushResult.status !== 0) {
    return {
      exitCode: 1,
      stdout: pushResult.stdout || '',
      stderr: `[push-worktree-branch] ${pushResult.stderr || ''}`,
      error: pushResult.error ? pushResult.error.message : null,
    };
  }
  const verifyResult = await spawnInBashAsync(`torque-remote ${JSON.stringify(command)}`, baseEnv);
  return {
    exitCode: typeof verifyResult.status === 'number' ? verifyResult.status : 1,
    stdout: verifyResult.stdout || '',
    stderr: verifyResult.stderr || '',
    error: verifyResult.error ? verifyResult.error.message : null,
  };
}

async function defaultRunLocalVerify({ branch, command, cwd, logger, fallbackReason }) {
  const resolvedCwd = cwd || process.cwd();
  if (logger) {
    logger.warn('factory worktree verify: falling back to local execution', {
      branch,
      command,
      cwd: resolvedCwd,
      fallback_reason: fallbackReason || null,
    });
  }
  const result = await spawnInSystemShellAsync(command, {
    cwd: resolvedCwd,
    timeout: 30 * 60 * 1000,
  });
  return {
    exitCode: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
  };
}

// Fix 3: count commits on `branch` that are not on `baseBranch`. Used as a
// pre-flight inside verify() so we don't push or remote-test an empty branch
// (which previously false-passed the verify and then collapsed at LEARN with
// "refusing to merge empty branch", looping the same work item forever).
function defaultCountCommitsAhead({ cwd, baseBranch, branch }) {
  if (!cwd || !baseBranch || !branch) return 0;
  try {
    if (!fs.existsSync(cwd)) return 0;
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'git',
      ['rev-list', '--count', `${baseBranch}..${branch}`],
      { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] },
    ).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : 0;
  } catch (_e) {
    void _e;
    return 0;
  }
}

function createWorktreeRunner({
  worktreeManager,
  runRemoteVerify = defaultRunRemoteVerify,
  runLocalVerify = defaultRunLocalVerify,
  countCommitsAhead = defaultCountCommitsAhead,
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
      const { execFileSync } = require('child_process');
      const headRef = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
        cwd: project.path,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim().replace(/^refs\/remotes\/origin\//, '');
      if (headRef) {
        baseBranch = headRef;
      }
    } catch (_e) {
      void _e;
      // Fallback: check if 'master' branch exists locally
      try {
        const { execFileSync } = require('child_process');
        execFileSync('git', ['rev-parse', '--verify', 'master'], {
          cwd: project.path,
          windowsHide: true,
          timeout: 5000,
          stdio: 'ignore',
        });
        baseBranch = 'master';
      } catch (_e2) { void _e2; }
    }

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

  async function verify({ worktreePath, branch, verifyCommand, workingDirectory, baseBranch = 'main' }) {
    if (!branch) throw new Error('verify requires branch');
    const command = String(verifyCommand || 'cd server && npx vitest run').trim();
    const cwd = workingDirectory || worktreePath;
    const start = Date.now();

    // Fix 3: pre-flight empty-branch check. If the branch has no commits
    // ahead of base, skip remote/local verify entirely and report the
    // accurate state (failed + reason=empty_branch) instead of false-passing.
    const aheadCount = countCommitsAhead({ cwd, baseBranch, branch });
    if (aheadCount === 0) {
      if (logger) {
        logger.warn('factory worktree verify: skipped (empty branch)', {
          branch,
          base_branch: baseBranch,
          worktree_path: worktreePath,
        });
      }
      return {
        passed: false,
        output: `[empty-branch] Branch ${branch} has no commits ahead of ${baseBranch}; nothing to verify.`,
        durationMs: Date.now() - start,
        reason: 'empty_branch',
      };
    }

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
  resolveSystemShellCommand,
};
