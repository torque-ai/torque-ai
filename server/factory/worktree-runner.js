'use strict';

const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { prepareLocalVerifyEnv } = require('../utils/local-verify-env');

const CHILD_CLOSE_GRACE_MS = 250;
const NON_CODE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.toml',
]);

function spawnTrackedProcessAsync(cmd, args, options = {}, spawnImpl = spawn) {
  return new Promise((resolve) => {
    const child = spawnImpl(cmd, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timer = null;
    let exitFallbackTimer = null;
    let timedOut = false;
    let settled = false;
    let exitCode = null;
    let exitSignal = null;

    const finish = ({ status, error = null, signal = exitSignal }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitFallbackTimer) clearTimeout(exitFallbackTimer);
      resolve({
        status: typeof status === 'number' ? status : 1,
        stdout,
        stderr,
        error,
        signal,
      });
    };

    const scheduleExitFallback = () => {
      if (settled || exitFallbackTimer) return;
      exitFallbackTimer = setTimeout(() => {
        const error = timedOut ? { message: `timeout after ${options.timeout}ms` } : null;
        finish({
          status: exitCode,
          error,
          signal: exitSignal,
        });
      }, CHILD_CLOSE_GRACE_MS);
    };

    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch (_e) { void _e; }
        scheduleExitFallback();
      }, options.timeout);
    }

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      finish({ status: 1, error: err });
    });
    child.on('exit', (code, signal) => {
      exitCode = typeof code === 'number' ? code : 1;
      exitSignal = signal;
      scheduleExitFallback();
    });
    child.on('close', (code, signal) => {
      exitCode = typeof code === 'number' ? code : (typeof exitCode === 'number' ? exitCode : 1);
      exitSignal = signal || exitSignal;
      const error = timedOut ? { message: `timeout after ${options.timeout}ms` } : null;
      finish({
        status: exitCode,
        error,
        signal: exitSignal,
      });
    });
  });
}

// Async variant of spawnInBash that returns a Promise — used for verify
// commands that can run up to 30 minutes. spawnSync would block the Node
// event loop for the entire duration, freezing all HTTP responses and
// other factory loops.
function spawnInBashAsync(bashCmd, options = {}) {
  let cmd, args;
  if (process.platform === 'win32') {
    const bashPath = resolveBashOnWindows();
    if (!bashPath) {
      return Promise.resolve({
        status: 1,
        stdout: '',
        stderr: 'Git Bash not found on this Windows host',
        error: { message: 'bash_not_found' },
      });
    }
    cmd = bashPath;
    args = ['-lc', bashCmd];
  } else {
    cmd = 'bash';
    args = ['-lc', bashCmd];
  }
  return spawnTrackedProcessAsync(cmd, args, options);
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
  const { cmd, args } = resolveSystemShellCommand(process.platform, command);
  return spawnTrackedProcessAsync(cmd, args, options);
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


// Pure resolver: deterministic branch name for a factory work item. Callers
// (loop-controller) need this BEFORE createForBatch so stale state can be
// cleaned up against the target branch prior to creation. Must match the
// branch pipeline in worktree-manager.createWorktree exactly: sanitizeSlug
// on the title, then the same slugify+buildBranchName the manager uses.
function resolveBranchName({ workItem } = {}) {
  if (!workItem || !workItem.id) {
    throw new Error('resolveBranchName requires workItem.id');
  }
  const slug = sanitizeSlug(workItem.title || `item-${workItem.id}`);
  const featureName = `factory-${workItem.id}-${slug}`;
  const branchSlug = String(featureName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'worktree';
  return `feat/${branchSlug}`;
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
    || text.includes('no suitable python runtime found')
    || text.includes('pylauncher_allow_install')
    || text.includes('microsoft store to the requested version')
    || (text.includes('torque-remote') && (
      text.includes('not found')
      || text.includes('is not recognized')
      || text.includes('enoent')
    ))
  );
}

function buildRemoteVerifyInvocation(command) {
  const normalized = String(command || '').trim();
  return `torque-remote bash -lc ${JSON.stringify(normalized)}`;
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
  const verifyResult = await spawnInBashAsync(buildRemoteVerifyInvocation(command), baseEnv);
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
  const preparedEnv = prepareLocalVerifyEnv(command);
  try {
    const result = await spawnInSystemShellAsync(command, {
      cwd: resolvedCwd,
      timeout: 30 * 60 * 1000,
      ...(preparedEnv.env ? { env: preparedEnv.env } : {}),
    });
    return {
      exitCode: typeof result.status === 'number' ? result.status : 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error ? result.error.message : null,
    };
  } finally {
    preparedEnv.cleanup();
  }
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

function defaultListChangedFiles({ cwd, baseBranch, branch }) {
  if (!cwd || !baseBranch || !branch) return [];
  try {
    if (!fs.existsSync(cwd)) return [];
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'git',
      ['diff', '--name-only', `${baseBranch}...${branch}`],
      { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    return String(out || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (_e) {
    void _e;
    return [];
  }
}

function isNonCodeOnlyDiff(files = []) {
  return Array.isArray(files)
    && files.length > 0
    && files.every((file) => NON_CODE_EXTENSIONS.has(require('path').extname(file || '').toLowerCase()));
}

// Detect the repo's default branch (main/master/custom) from origin/HEAD or
// fallback to whichever of master/main actually exists locally. Returns 'main'
// if nothing resolves so callers still get a sensible default.
function detectDefaultBranch(cwd) {
  if (!cwd) return 'main';
  try {
    const fs = require('fs');
    if (!fs.existsSync(cwd)) return 'main';
  } catch { return 'main'; }
  const { execFileSync } = require('child_process');
  try {
    const headRef = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim().replace(/^refs\/remotes\/origin\//, '');
    if (headRef) return headRef;
  } catch { /* fall through */ }
  for (const candidate of ['master', 'main']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', candidate], {
        cwd, windowsHide: true, timeout: 5000, stdio: 'ignore',
      });
      return candidate;
    } catch { /* try next */ }
  }
  return 'main';
}

// True if the worktree has uncommitted changes (tracked or staged) at HEAD.
function isWorktreeDirty(cwd) {
  if (!cwd) return false;
  // `git diff --quiet HEAD` exits non-zero on any tracked change vs HEAD.
  try {
    execFileSync('git', ['diff', '--quiet', 'HEAD'], {
      cwd, windowsHide: true, timeout: 5000, stdio: 'ignore',
    });
    return false;
  } catch {
    return true;
  }
}

// Force the worktree's tracked files to match HEAD exactly. Used before
// verify() so a stale or hand-edited worktree (especially after a long
// human-retry pause — see Bug B / f9cf2275 audit) can't pass verify by
// accident while the BRANCH HEAD that ultimately gets merged is broken.
function resyncWorktreeToHead(cwd, logger) {
  if (!cwd) return false;
  try {
    execFileSync('git', ['reset', '--hard', 'HEAD'], {
      cwd, windowsHide: true, timeout: 30000, stdio: 'ignore',
    });
    execFileSync('git', ['clean', '-fd'], {
      cwd, windowsHide: true, timeout: 30000, stdio: 'ignore',
    });
    if (logger) logger.warn('factory worktree resynced to HEAD before verify', { cwd });
    return true;
  } catch (err) {
    if (logger) logger.warn('factory worktree resync failed', { cwd, error: err.message });
    return false;
  }
}

function createWorktreeRunner({
  worktreeManager,
  runRemoteVerify = defaultRunRemoteVerify,
  runLocalVerify = defaultRunLocalVerify,
  countCommitsAhead = defaultCountCommitsAhead,
  listChangedFiles = defaultListChangedFiles,
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

    const baseBranch = detectDefaultBranch(project.path);

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
      baseBranch,
    };
  }

  async function verify({ worktreePath, branch, verifyCommand, workingDirectory, baseBranch }) {
    if (!branch) throw new Error('verify requires branch');
    const command = String(verifyCommand || 'cd server && npx vitest run').trim();
    const cwd = workingDirectory || worktreePath;
    const resolvedBaseBranch = baseBranch || detectDefaultBranch(cwd);
    const start = Date.now();

    // Fix 3: pre-flight empty-branch check. If the branch has no commits
    // ahead of base, skip remote/local verify entirely and report the
    // accurate state (failed + reason=empty_branch) instead of false-passing.
    const aheadCount = countCommitsAhead({ cwd, baseBranch: resolvedBaseBranch, branch });
    if (aheadCount === 0) {
      if (logger) {
        logger.warn('factory worktree verify: skipped (empty branch)', {
          branch,
          base_branch: resolvedBaseBranch,
          worktree_path: worktreePath,
        });
      }
      return {
        passed: false,
        output: `[empty-branch] Branch ${branch} has no commits ahead of ${resolvedBaseBranch}; nothing to verify.`,
        stdout: '',
        stderr: `[empty-branch] Branch ${branch} has no commits ahead of ${resolvedBaseBranch}; nothing to verify.`,
        exitCode: 1,
        error: null,
        timedOut: false,
        durationMs: Date.now() - start,
        reason: 'empty_branch',
      };
    }

    const changedFiles = listChangedFiles({ cwd, baseBranch: resolvedBaseBranch, branch });
    if (isNonCodeOnlyDiff(changedFiles)) {
      if (logger) {
        logger.info('factory worktree verify: skipped (non-code-only diff)', {
          branch,
          base_branch: resolvedBaseBranch,
          worktree_path: worktreePath,
          changed_files: changedFiles,
        });
      }
      return {
        passed: true,
        output: `[non-code-only] Branch ${branch} only changes non-code files; skipping verify command.`,
        stdout: `[non-code-only] ${changedFiles.join(', ')}`,
        stderr: '',
        exitCode: 0,
        error: null,
        timedOut: false,
        durationMs: Date.now() - start,
        reason: 'non_code_only',
      };
    }

    // Bug B fix: before running verify, ensure the worktree exactly matches
    // its branch HEAD. A long-paused human-retry can land on a worktree that
    // was edited / partially built / left dirty in the intervening hours;
    // running verify against that stale state produced false-positive passes
    // (the f9cf2275 / batch-831 incident on 2026-04-23).
    if (isWorktreeDirty(cwd)) {
      resyncWorktreeToHead(cwd, logger);
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
    return {
      passed,
      output,
      stdout: out && typeof out.stdout === 'string' ? out.stdout : '',
      stderr: out && typeof out.stderr === 'string' ? out.stderr : '',
      exitCode: out && typeof out.exitCode === 'number' ? out.exitCode : null,
      error: out && out.error ? String(out.error) : null,
      timedOut: Boolean(out && out.timedOut),
      durationMs,
    };
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
  resolveBranchName,
  detectDefaultBranch,
  resolveSystemShellCommand,
  _internalForTests: {
    CHILD_CLOSE_GRACE_MS,
    buildRemoteVerifyInvocation,
    defaultListChangedFiles,
    isNonCodeOnlyDiff,
    spawnTrackedProcessAsync,
    spawnInBashAsync,
    spawnInSystemShellAsync,
  },
};
