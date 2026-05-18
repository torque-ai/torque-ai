'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { normalizeDotnetTestSourceTargets } = require('../utils/dotnet-verify-normalizer');
const { prepareLocalVerifyEnv } = require('../utils/local-verify-env');
const { prepareWorktreeVerifyDependencies } = require('../utils/worktree-verify-deps');
const {
  defaultVerifyCommandForProject,
  wrapVerifyCommandForTestLane,
} = require('./test-lane-verify');

const CHILD_CLOSE_GRACE_MS = 250;
// Verify commands run up to 30 minutes (`dotnet test`, vitest, etc.) and can
// produce hundreds of MB of output. Cap stdout/stderr at 10 MB each so a
// single noisy test run can't OOM the server or bloat the DB row this output
// gets persisted to. Other parts of the codebase (test-runner-registry,
// remote-test-routing) already use the same 10 MB cap.
const MAX_CHILD_BUFFER_BYTES = 10 * 1024 * 1024;
const NON_CODE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.toml',
]);

function safeGitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sanitizeCoordinationLockName(name = 'main') {
  return String(name || 'main').toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

function isAbsoluteGitPath(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(String(value || ''));
}

function resolveCoordinationLockRoot(repoPath) {
  if (process.env.TORQUE_COORD_LOCK_ROOT) {
    return process.env.TORQUE_COORD_LOCK_ROOT;
  }
  const commonDir = execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    windowsHide: true,
    env: safeGitEnv(),
  }).trim();
  const absoluteCommonDir = isAbsoluteGitPath(commonDir)
    ? commonDir
    : path.join(repoPath, commonDir);
  return path.join(absoluteCommonDir, 'torque-coordination-locks');
}

function readCoordinationOwnerFile(filePath) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function isProcessAlive(pid) {
  const numeric = Number.parseInt(String(pid || ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function describeCoordinationLock(lockDir) {
  const owner = readCoordinationOwnerFile(path.join(lockDir, 'owner.env'));
  const startedAt = owner.started_at || 'unknown';
  const host = owner.host || 'unknown';
  const cwd = owner.cwd || 'unknown';
  const pid = owner.pid || 'unknown';
  const windowsPid = owner.windows_pid ? ` windows_pid=${owner.windows_pid}` : '';
  return `purpose=${owner.purpose || 'unknown'} pid=${pid}${windowsPid} host=${host} started_at=${startedAt} cwd=${cwd}`;
}

function removeCoordinationLockDir(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (_err) {
    // Best effort; the next acquire loop will retry or time out.
  }
}

function reapDeadOrStaleCoordinationLock(lockDir, nowEpochSeconds, logger = null) {
  const owner = readCoordinationOwnerFile(path.join(lockDir, 'owner.env'));
  const currentHost = os.hostname();
  const ownerHost = owner.host || '';
  if (ownerHost && ownerHost === currentHost) {
    const pidAlive = isProcessAlive(owner.windows_pid || owner.pid);
    if (!pidAlive) {
      if (logger) {
        logger.warn('Reaping dead same-host repo coordination lock before factory merge', {
          lock_dir: lockDir,
          owner: describeCoordinationLock(lockDir),
        });
      }
      removeCoordinationLockDir(lockDir);
      return true;
    }
  }

  const staleAfter = parsePositiveInteger(
    process.env.TORQUE_COORD_LOCK_STALE_SECS || owner.stale_after_seconds,
    7200,
  );
  const startedAt = Number.parseInt(String(owner.started_at_epoch || ''), 10);
  if (Number.isFinite(startedAt) && nowEpochSeconds - startedAt >= staleAfter) {
    if (logger) {
      logger.warn('Reaping stale repo coordination lock before factory merge', {
        lock_dir: lockDir,
        owner: describeCoordinationLock(lockDir),
        age_seconds: nowEpochSeconds - startedAt,
      });
    }
    removeCoordinationLockDir(lockDir);
    return true;
  }

  return false;
}

function writeCoordinationLockOwner(lockDir, { lockName, purpose, token, repoPath }) {
  const now = new Date();
  const startedAtEpoch = Math.floor(now.getTime() / 1000);
  const lines = [
    `lock_name=${lockName}`,
    `purpose=${purpose}`,
    `pid=${process.pid}`,
    `ppid=${process.ppid || 'unknown'}`,
    `user=${process.env.USER || process.env.USERNAME || 'unknown'}`,
    `host=${os.hostname()}`,
    `repo=${repoPath || 'unknown'}`,
    `cwd=${process.cwd()}`,
    `started_at=${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    `started_at_epoch=${startedAtEpoch}`,
    `stale_after_seconds=${process.env.TORQUE_COORD_LOCK_STALE_SECS || 7200}`,
    `command=${process.argv.join(' ')}`,
    '',
  ];
  fs.writeFileSync(path.join(lockDir, 'owner.env'), lines.join('\n'));
  fs.writeFileSync(path.join(lockDir, 'token'), `${token}\n`);
}

async function withRepoCoordinationLock({
  repoPath,
  lockName = 'main',
  purpose = 'factory merge worktree',
  logger = null,
}, fn) {
  if (typeof fn !== 'function') {
    throw new Error('withRepoCoordinationLock requires a callback');
  }
  if (!repoPath || typeof repoPath !== 'string') {
    if (logger) {
      logger.warn('factory merge proceeding without repo coordination lock; repo path unavailable', {
        lock_name: lockName,
        purpose,
      });
    }
    return fn();
  }

  const safeName = sanitizeCoordinationLockName(lockName);
  const lockRoot = resolveCoordinationLockRoot(repoPath);
  const lockDir = path.join(lockRoot, `${safeName}.lock`);
  const inheritedLockDir = process.env.TORQUE_COORD_LOCK_DIR;
  const inheritedToken = process.env.TORQUE_COORD_LOCK_TOKEN;
  if (inheritedLockDir && inheritedToken && path.resolve(inheritedLockDir) === path.resolve(lockDir)) {
    try {
      if (fs.readFileSync(path.join(lockDir, 'token'), 'utf8').trim() === inheritedToken) {
        if (logger) {
          logger.info('Reusing repo coordination lock for factory merge', { lock_name: lockName, purpose });
        }
        return fn();
      }
    } catch (_err) {
      // Fall through to a fresh acquire if the inherited lock metadata vanished.
    }
  }

  const waitSecs = parsePositiveInteger(process.env.TORQUE_COORD_LOCK_WAIT_SECS, 7200);
  const pollSecs = parsePositiveInteger(process.env.TORQUE_COORD_LOCK_POLL_SECS, 5);
  const noticeSecs = parsePositiveInteger(process.env.TORQUE_COORD_LOCK_NOTICE_SECS, 30);
  const deadline = Date.now() + waitSecs * 1000;
  let nextNotice = 0;
  const token = `${Math.floor(Date.now() / 1000)}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  let acquired = false;

  fs.mkdirSync(lockRoot, { recursive: true });

  while (!acquired) {
    try {
      fs.mkdirSync(lockDir);
      writeCoordinationLockOwner(lockDir, { lockName, purpose, token, repoPath });
      acquired = true;
      if (logger) {
        logger.info('Acquired repo coordination lock for factory merge', { lock_name: lockName, purpose });
      }
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }

    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    if (reapDeadOrStaleCoordinationLock(lockDir, nowEpochSeconds, logger)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${lockName} repo coordination lock held by: ${describeCoordinationLock(lockDir)}`);
    }
    if (Date.now() >= nextNotice) {
      if (logger) {
        logger.info('Waiting for repo coordination lock before factory merge', {
          lock_name: lockName,
          purpose,
          held_by: describeCoordinationLock(lockDir),
        });
      }
      nextNotice = Date.now() + noticeSecs * 1000;
    }
    await delay(pollSecs * 1000);
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        const currentToken = fs.readFileSync(path.join(lockDir, 'token'), 'utf8').trim();
        if (currentToken === token) {
          removeCoordinationLockDir(lockDir);
          if (logger) {
            logger.info('Released repo coordination lock after factory merge', { lock_name: lockName, purpose });
          }
        }
      } catch (_err) {
        // Missing lock metadata after the critical section is non-fatal.
      }
    }
  }
}

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

    let stdoutTruncated = false;
    let stderrTruncated = false;
    const truncationNotice = (stream, capBytes) =>
      `\n[truncated: ${stream} exceeded ${capBytes} bytes]`;
    child.stdout?.on('data', (chunk) => {
      if (stdout.length >= MAX_CHILD_BUFFER_BYTES) return;
      stdout += chunk.toString('utf8');
      if (!stdoutTruncated && stdout.length >= MAX_CHILD_BUFFER_BYTES) {
        stdoutTruncated = true;
        stdout = stdout.slice(0, MAX_CHILD_BUFFER_BYTES)
          + truncationNotice('stdout', MAX_CHILD_BUFFER_BYTES);
      }
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length >= MAX_CHILD_BUFFER_BYTES) return;
      stderr += chunk.toString('utf8');
      if (!stderrTruncated && stderr.length >= MAX_CHILD_BUFFER_BYTES) {
        stderrTruncated = true;
        stderr = stderr.slice(0, MAX_CHILD_BUFFER_BYTES)
          + truncationNotice('stderr', MAX_CHILD_BUFFER_BYTES);
      }
    });
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

function resolveLocalVerifyShellCommand(platform, command) {
  if (platform === 'win32') {
    const bashPath = resolveBashOnWindows();
    if (bashPath) return { cmd: bashPath, args: ['-lc', command] };
  }
  return resolveSystemShellCommand(platform, command);
}

function spawnInSystemShellAsync(command, options = {}) {
  const { cmd, args } = resolveSystemShellCommand(process.platform, command);
  return spawnTrackedProcessAsync(cmd, args, options);
}

function spawnInLocalVerifyShellAsync(command, options = {}) {
  const { cmd, args } = resolveLocalVerifyShellCommand(process.platform, command);
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
    || text.includes('ssh_unreachable')
    || text.includes('remote_probe_os')
    || text.includes('cannot determine remote os')
    || text.includes('ssh failed rc=255')
    || text.includes('uname+ver both failed')
    || text.includes('remote execution required; refusing local fallback')
    || (text.includes('remote') && text.includes('unreachable'))
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

function buildRemoteVerifyOptions(cwd, env = process.env) {
  return {
    cwd,
    timeout: 30 * 60 * 1000,
    env: {
      ...(env || {}),
      TORQUE_REMOTE_REQUIRE_REMOTE: '1',
    },
  };
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
  const baseEnv = buildRemoteVerifyOptions(resolvedCwd);
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
    const result = await spawnInLocalVerifyShellAsync(command, {
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
      { cwd, encoding: 'utf8', windowsHide: true, env: safeGitEnv(), timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] },
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
      { cwd, encoding: 'utf8', windowsHide: true, env: safeGitEnv(), timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] },
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
// fallback to whichever of main/master actually exists locally. Returns 'main'
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
      cwd, encoding: 'utf8', windowsHide: true, env: safeGitEnv(), timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim().replace(/^refs\/remotes\/origin\//, '');
    if (headRef) return headRef;
  } catch { /* fall through */ }
  for (const candidate of ['main', 'master']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', candidate], {
        cwd, windowsHide: true, env: safeGitEnv(), timeout: 5000, stdio: 'ignore',
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
      cwd, windowsHide: true, env: safeGitEnv(), timeout: 5000, stdio: 'ignore',
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
      cwd, windowsHide: true, env: safeGitEnv(), timeout: 30000, stdio: 'ignore',
    });
    execFileSync('git', ['clean', '-fd'], {
      cwd, windowsHide: true, env: safeGitEnv(), timeout: 30000, stdio: 'ignore',
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
  withMainCoordinationLock = null,
  logger,
} = {}) {
  if (!worktreeManager || typeof worktreeManager.createWorktree !== 'function') {
    throw new Error('worktree-runner requires a worktreeManager with createWorktree/mergeWorktree/cleanupWorktree');
  }

  async function createForBatch({ project, workItem, batchId, featureNameSuffix = null }) {
    if (!project || !project.path) throw new Error('createForBatch requires project.path');
    if (!workItem || !workItem.id) throw new Error('createForBatch requires workItem.id');
    const slug = sanitizeSlug(workItem.title || `item-${workItem.id}`);
    const suffix = featureNameSuffix ? `-${sanitizeSlug(featureNameSuffix, 24)}` : '';
    const featureName = `factory-${workItem.id}-${slug}${suffix}`;

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
    prepareWorktreeVerifyDependencies(record.worktree_path, logger);
    return {
      id: record.id,
      worktreePath: record.worktree_path,
      branch: record.branch,
      baseBranch,
    };
  }

  async function verify({ worktreePath, branch, verifyCommand, workingDirectory, baseBranch }) {
    if (!branch) throw new Error('verify requires branch');
    const cwd = workingDirectory || worktreePath;
    const rawCommand = String(verifyCommand || defaultVerifyCommandForProject(cwd)).trim();
    const normalizedRawCommand = normalizeDotnetTestSourceTargets(rawCommand, cwd);
    if (normalizedRawCommand !== rawCommand && logger) {
      logger.info('factory worktree verify: normalized dotnet test source-file target', {
        branch,
        original_command: rawCommand,
        normalized_command: normalizedRawCommand,
        cwd,
      });
    }
    const command = wrapVerifyCommandForTestLane(normalizedRawCommand, { projectPath: cwd });
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
    prepareWorktreeVerifyDependencies(cwd, logger);

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
    let worktreeRecord = null;
    if (!worktreeId && typeof worktreeManager.listWorktrees === 'function') {
      const all = worktreeManager.listWorktrees();
      const match = all.find((w) => w.branch === branch);
      if (!match) throw new Error(`mergeToMain: no worktree found for branch ${branch}`);
      worktreeRecord = match;
      worktreeId = match.id;
    } else if (worktreeId && typeof worktreeManager.listWorktrees === 'function') {
      worktreeRecord = worktreeManager.listWorktrees().find((w) => w.id === worktreeId) || null;
    }

    const lockRunner = typeof withMainCoordinationLock === 'function'
      ? withMainCoordinationLock
      : (ctx, fn) => withRepoCoordinationLock({ ...ctx, logger }, fn);
    const repoPath = worktreeRecord?.repo_path || worktreeRecord?.repoPath || null;
    const branchLabel = branch || worktreeRecord?.branch || worktreeId;
    const result = await lockRunner({
      repoPath,
      lockName: target,
      purpose: `factory merge worktree: ${branchLabel}`,
      worktreeId,
      branch: branchLabel,
    }, async () => {
      const mergeResult = worktreeManager.mergeWorktree(worktreeId, {
        strategy,
        targetBranch: target,
        deleteAfter: true,
      });
      if (logger) {
        logger.info('factory worktree merged', {
          worktree_id: worktreeId,
          branch: mergeResult && mergeResult.branch,
          target_branch: target,
          strategy,
          cleaned: mergeResult && mergeResult.cleaned,
        });
      }
      return mergeResult;
    });
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
    MAX_CHILD_BUFFER_BYTES,
    buildRemoteVerifyInvocation,
    buildRemoteVerifyOptions,
    defaultListChangedFiles,
    prepareWorktreeVerifyDependencies,
    isNonCodeOnlyDiff,
    spawnTrackedProcessAsync,
    spawnInBashAsync,
    resolveLocalVerifyShellCommand,
    spawnInLocalVerifyShellAsync,
    spawnInSystemShellAsync,
    withRepoCoordinationLock,
  },
};
