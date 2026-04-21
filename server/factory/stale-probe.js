'use strict';

const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const { DEFAULT_PROMOTION_CONFIG } = require('./promotion-policy');

const PROBE_TIMEOUT_MS = 3000;

function defaultGitRunner(cwd, args) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = childProcess.spawn('git', args, {
      cwd,
      windowsHide: true,
    });
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`git exited ${code}: ${stderr.trim()}`);
        err.code = `GIT_EXIT_${code}`;
        reject(err);
      }
    });
  });
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('probe_timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function probeStaleness(item, {
  projectPath,
  promotionConfig = DEFAULT_PROMOTION_CONFIG,
  now = new Date(),
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
    const result = await withTimeout(
      Promise.resolve(gitRunner(projectPath, [
        'log',
        `--since=${scanTs}`,
        '--pretty=format:%H',
        '--',
        targetFile,
      ])),
      PROBE_TIMEOUT_MS,
    );
    stdout = String(result?.stdout || '');
  } catch (err) {
    if (err && err.message === 'probe_timeout') {
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
