'use strict';

const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const { DEFAULT_PROMOTION_CONFIG } = require('./promotion-policy');
const {
  extractPlanDescriptionFilePaths,
  normalizePlanProjectRelativePath,
} = require('./shared/plan-path');

const PROBE_TIMEOUT_MS = 3000;
const TOOL_NAME_RE = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/gi;
const TOOL_REGISTRY_LIMIT = 250;
const PROSE_FILE_PATH_RE = new RegExp(
  String.raw`(?:^|[\s\`'"([])((?:[A-Za-z]:)?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)?`,
  'gi'
);
const MISSING_TOOL_CLAIM_FORWARD_RE = /\b(?:tool|mcp|tool-def|tooling|handler)\b[\s\S]{0,180}\b(?:does not exist|doesn't exist|not exist|no live|tool-not-found|missing|unregistered|not registered)\b/i;
const MISSING_TOOL_CLAIM_REVERSE_RE = /\b(?:does not exist|doesn't exist|not exist|no live|tool-not-found|missing|unregistered|not registered)\b[\s\S]{0,180}\b(?:tool|mcp|tool-def|tooling|handler)\b/i;

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getWorkItemProbeText(item) {
  const origin = item?.origin && typeof item.origin === 'object' ? item.origin : {};
  return [
    item?.title,
    item?.description,
    origin.title,
    origin.description,
    origin.summary,
    origin.finding,
    origin.evidence,
    origin.details,
    origin.reason,
    origin.why,
  ].filter((value) => typeof value === 'string' && value.trim().length > 0).join('\n');
}

function collectDescriptionFilePaths(text) {
  const out = new Set(extractPlanDescriptionFilePaths(text));
  PROSE_FILE_PATH_RE.lastIndex = 0;
  for (const match of String(text || '').matchAll(PROSE_FILE_PATH_RE)) {
    if (match[1]) out.add(match[1]);
  }
  return [...out];
}

function resolveProbeTargetFile(item, projectPath) {
  const explicit = typeof item?.origin?.target_file === 'string'
    ? item.origin.target_file.trim()
    : '';
  if (explicit) {
    return { targetFile: explicit, source: 'origin.target_file' };
  }

  for (const candidate of collectDescriptionFilePaths(getWorkItemProbeText(item))) {
    const normalized = normalizePlanProjectRelativePath(candidate, projectPath);
    if (normalized) {
      return { targetFile: normalized, source: 'description' };
    }
  }

  return { targetFile: null, source: null };
}

function isMissingToolClaim(text) {
  const value = String(text || '');
  return MISSING_TOOL_CLAIM_FORWARD_RE.test(value)
    || MISSING_TOOL_CLAIM_REVERSE_RE.test(value);
}

function extractMissingToolNames(text) {
  if (!isMissingToolClaim(text)) return [];
  TOOL_NAME_RE.lastIndex = 0;
  return [...new Set(
    [...String(text || '').matchAll(TOOL_NAME_RE)]
      .map((match) => match[1])
      .filter(Boolean)
  )];
}

function collectToolRegistryFiles(projectPath) {
  const root = path.resolve(projectPath);
  const out = [];
  const pushFile = (filePath) => {
    if (out.length < TOOL_REGISTRY_LIMIT && fs.existsSync(filePath)) {
      out.push(filePath);
    }
  };
  const walk = (dir) => {
    if (out.length >= TOOL_REGISTRY_LIMIT || !fs.existsSync(dir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= TOOL_REGISTRY_LIMIT) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  };

  walk(path.join(root, 'server', 'tool-defs'));
  pushFile(path.join(root, 'server', 'tool-metadata.js'));
  pushFile(path.join(root, 'server', 'tools.js'));
  return out;
}

function findRegisteredTool(projectPath, toolName) {
  if (!projectPath || !toolName) return null;
  const quotedName = new RegExp(`['"\`]${escapeRegExp(toolName)}['"\`]`);
  for (const filePath of collectToolRegistryFiles(projectPath)) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    if (quotedName.test(content)) {
      return filePath;
    }
  }
  return null;
}

function probeMissingToolClaim(item, projectPath) {
  const text = getWorkItemProbeText(item);
  for (const toolName of extractMissingToolNames(text)) {
    const match = findRegisteredTool(projectPath, toolName);
    if (match) {
      return {
        tool_name: toolName,
        registry_file: path.relative(path.resolve(projectPath), match).replace(/\\/g, '/'),
      };
    }
  }
  return null;
}

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
    const currentExecFile = childProcess.execFile;
    const isMockFunction = Boolean(currentExecFile && (currentExecFile._isMockFunction || currentExecFile.mock));
    const execFile = childProcess._realExecFile
      && currentExecFile?.__torqueTestGuard === true
      && !isMockFunction
      ? childProcess._realExecFile
      : currentExecFile;
    execFile.call(childProcess, 'git', args, execOpts, (err, stdout, stderr) => {
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
  if (promotionConfig?.stale_probe_enabled === false) {
    return makeResult({ reason: 'probe_disabled' });
  }
  const target = resolveProbeTargetFile(item, projectPath);
  const registeredMissingTool = projectPath ? probeMissingToolClaim(item, projectPath) : null;
  if (registeredMissingTool) {
    return makeResult({
      stale: true,
      reason: 'missing_tool_now_registered',
      commits_since_scan: 0,
      ...registeredMissingTool,
    });
  }
  const targetFile = target.targetFile;
  if (typeof targetFile !== 'string' || targetFile.length === 0) {
    return makeResult({ reason: 'no_target_file' });
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
