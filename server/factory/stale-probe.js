'use strict';

const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const { DEFAULT_PROMOTION_CONFIG } = require('./promotion-policy');

const PROBE_TIMEOUT_MS = 3000;

function defaultGitRunner(cwd, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    // Use execFile rather than spawn. spawn('git', ...) on Windows can
    // emit spurious errors because it doesn't auto-resolve git.exe /
    // git.cmd in PATH the same way execFile does.
    //
    // Strip GIT_* env vars that may have leaked from the parent (TORQUE
    // tests, vitest test-runner, etc.) — GIT_DIR / GIT_WORK_TREE override
    // cwd-based repo discovery and make `git log` run against the wrong
    // repo. Observed on the Omen remote.
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
    );
    // execFile's `timeout` option SIGKILLs the child when exceeded — without
    // it, the previous Promise.race-based wrapper would reject the JS-side
    // promise on timeout but leave the git child process running and
    // accumulating across probes. Each probe runs frequently in the
    // factory tick, so the leak compounded under repeated timeouts.
    const execOpts = {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: cleanEnv,
    };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      execOpts.timeout = timeoutMs;
      execOpts.killSignal = 'SIGKILL';
    }
    childProcess.execFile('git', args, execOpts, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          reject(err);
          return;
        }
        if (err.killed && err.signal === 'SIGKILL') {
          const t = new Error('probe_timeout');
          t.code = 'PROBE_TIMEOUT';
          reject(t);
          return;
        }
        const wrapped = new Error(`git exited: ${err.message}; stderr=${String(stderr || '').trim()}`);
        wrapped.code = err.code || 'GIT_ERROR';
        reject(wrapped);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function probeStaleness(item, {
  projectPath,
  promotionConfig = DEFAULT_PROMOTION_CONFIG,
  gitRunner = defaultGitRunner,
} = {}) {
  const start = Date.now();
  const makeResult = (partial) => ({
    stale: false,
    reason: 'unknown',
    commits_since_scan: 0,
    probe_ms: Date.now() - start,
    ...partial,
  });

  // Gate 1: eligibility
  if (!item || item.source !== 'scout') {
    return makeResult({ reason: 'not_scout_eligible' });
  }
  const targetFile = item.origin?.target_file;
  if (typeof targetFile !== 'string' || targetFile.length === 0) {
    return makeResult({ reason: 'no_target_file' });
  }
  if (promotionConfig?.stale_probe_enabled === false) {
    return makeResult({ reason: 'probe_disabled' });
  }
  if (!projectPath) {
    return makeResult({ reason: 'no_project_path' });
  }

  // Gate 2: path safety
  const resolvedRoot = path.resolve(projectPath);
  const abs = path.resolve(resolvedRoot, targetFile);
  if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
    return makeResult({ reason: 'invalid_target_path' });
  }

  // Gate 3: file existence
  if (!fs.existsSync(abs)) {
    return makeResult({ stale: true, reason: 'target_file_deleted', commits_since_scan: 0 });
  }

  // Gate 4: git log since scan
  const scanTs = item.origin?.scan_timestamp || item.created_at;
  if (!scanTs) {
    return makeResult({ reason: 'no_scan_timestamp' });
  }

  let stdout = '';
  try {
    const result = await gitRunner(projectPath, [
      'log',
      `--since=${scanTs}`,
      '--pretty=format:%H',
      '--',
      targetFile,
    ], { timeoutMs: PROBE_TIMEOUT_MS });
    stdout = String(result?.stdout || '');
  } catch (err) {
    if (err && (err.message === 'probe_timeout' || err.code === 'PROBE_TIMEOUT')) {
      return makeResult({ reason: 'probe_timeout' });
    }
    if (err && err.code === 'ENOENT') {
      return makeResult({ reason: 'git_unavailable' });
    }
    return makeResult({ reason: 'probe_errored' });
  }

  const commits = stdout.trim().split(/\r?\n/).filter(Boolean);
  const threshold = promotionConfig?.stale_churn_threshold
    ?? DEFAULT_PROMOTION_CONFIG.stale_churn_threshold;

  if (commits.length === 0) {
    return makeResult({ reason: 'no_commits_since_scan', commits_since_scan: 0 });
  }
  if (commits.length < threshold) {
    return makeResult({
      reason: 'minor_churn_probably_valid',
      commits_since_scan: commits.length,
    });
  }
  return makeResult({
    stale: true,
    reason: 'substantial_churn',
    commits_since_scan: commits.length,
  });
}

module.exports = { probeStaleness, defaultGitRunner, PROBE_TIMEOUT_MS };
