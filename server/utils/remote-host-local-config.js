'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_RELATIVE_PATH = path.join('infrastructure', 'hosts', 'torque-remote.local.json');
const CONFIG_RELATIVE_POSIX = 'infrastructure/hosts/torque-remote.local.json';

const PUBLIC_FIELDS = [
  'host',
  'user',
  'remote_project_path',
  'remote_test_worktree_root',
  'remote_test_worktree_subdir',
  'lane_count',
];

const TEXT_FIELDS = [
  'host',
  'user',
  'key_path',
  'remote_project_path',
  'remote_test_worktree_root',
  'remote_test_worktree_subdir',
];

function makeConfigError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function getProjectRoot() {
  if (process.env.TORQUE_REMOTE_LOCAL_CONFIG_ROOT) {
    return path.resolve(process.env.TORQUE_REMOTE_LOCAL_CONFIG_ROOT);
  }
  return path.resolve(__dirname, '..', '..');
}

function getConfigPath(projectRoot = getProjectRoot()) {
  return path.join(projectRoot, CONFIG_RELATIVE_PATH);
}

function getStaticIgnoreStatus(projectRoot) {
  const rootIgnorePath = path.join(projectRoot, '.gitignore');
  const hostIgnorePath = path.join(projectRoot, 'infrastructure', 'hosts', '.gitignore');
  const rootPatterns = fs.existsSync(rootIgnorePath) ? fs.readFileSync(rootIgnorePath, 'utf8') : '';
  const hostPatterns = fs.existsSync(hostIgnorePath) ? fs.readFileSync(hostIgnorePath, 'utf8') : '';

  return (
    rootPatterns.includes('infrastructure/hosts/*.local.json') ||
    rootPatterns.includes('infrastructure/hosts/**/*.local.json') ||
    hostPatterns.includes('*.local.json')
  );
}

function getGitIgnoredStatus(projectRoot = getProjectRoot()) {
  let result;
  try {
    result = childProcess.spawnSync(
      'git',
      ['-C', projectRoot, 'check-ignore', '-q', CONFIG_RELATIVE_POSIX],
      { stdio: 'ignore' }
    );
  } catch {
    return getStaticIgnoreStatus(projectRoot) ? true : null;
  }

  if (!result.error && result.status === 0) return true;
  if (!result.error && result.status === 1) return getStaticIgnoreStatus(projectRoot);
  return getStaticIgnoreStatus(projectRoot) ? true : null;
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, value: {} };

  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config must be a JSON object');
    }
    return { exists: true, value: parsed };
  } catch (err) {
    return {
      exists: true,
      value: {},
      parseError: err.message,
    };
  }
}

function redactConfig(config) {
  const values = {};
  for (const field of PUBLIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(config, field)) {
      values[field] = config[field];
    }
  }
  return values;
}

function toResponse(payload, projectRoot = getProjectRoot()) {
  const config = payload.value || {};
  const keyPath = typeof config.key_path === 'string' ? config.key_path.trim() : '';

  return {
    path: CONFIG_RELATIVE_POSIX,
    exists: Boolean(payload.exists),
    valid: !payload.parseError,
    error: payload.parseError || null,
    git_ignored: getGitIgnoredStatus(projectRoot),
    values: redactConfig(config),
    has_key_path: Boolean(keyPath),
    key_path_hint: keyPath ? keyPath.split(/[\\/]/).filter(Boolean).pop() : null,
  };
}

function readRemoteHostLocalConfig(projectRoot = getProjectRoot()) {
  return toResponse(readJsonFile(getConfigPath(projectRoot)), projectRoot);
}

function parseLaneCount(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return undefined;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw makeConfigError('validation_error', 'lane_count must be a positive integer', 400);
  }
  return parsed;
}

function normalizeConfigPayload(payload, existingConfig = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw makeConfigError('validation_error', 'config body must be a JSON object', 400);
  }

  const next = {};
  for (const field of TEXT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const value = typeof payload[field] === 'string' ? payload[field].trim() : '';
    if (value) next[field] = value;
  }

  if (!next.key_path && existingConfig.key_path && payload.clear_key_path !== true) {
    next.key_path = existingConfig.key_path;
  }

  const laneCount = parseLaneCount(payload.lane_count);
  if (laneCount !== undefined) next.lane_count = laneCount;

  const missing = [];
  if (!next.host) missing.push('host');
  if (!next.user) missing.push('user');
  if (!next.key_path) missing.push('key_path');

  if (missing.length > 0) {
    throw makeConfigError('validation_error', `${missing.join(', ')} required`, 400);
  }

  return next;
}

function applyRestrictedPermissions(filePath) {
  const warnings = [];

  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    warnings.push(`chmod failed: ${err.message}`);
  }

  if (process.platform === 'win32') {
    const username = process.env.USERNAME;
    if (username) {
      let result;
      try {
        result = childProcess.spawnSync(
          'icacls',
          [filePath, '/inheritance:r', '/grant:r', `${username}:F`],
          { encoding: 'utf8' }
        );
      } catch (err) {
        warnings.push(`icacls failed: ${err.message}`);
        return warnings;
      }
      if (result.error || result.status !== 0) {
        warnings.push(`icacls failed: ${result.error?.message || result.stderr || result.status}`);
      }
    } else {
      warnings.push('USERNAME is not set; skipped Windows ACL restriction');
    }
  }

  return warnings;
}

function assertConfigFileIsIgnored(projectRoot) {
  if (getGitIgnoredStatus(projectRoot) !== true) {
    throw makeConfigError(
      'security_error',
      `${CONFIG_RELATIVE_POSIX} is not ignored by git; refusing to write local credentials`,
      500
    );
  }
}

function saveRemoteHostLocalConfig(payload, projectRoot = getProjectRoot()) {
  assertConfigFileIsIgnored(projectRoot);

  const filePath = getConfigPath(projectRoot);
  const existing = readJsonFile(filePath);
  const normalized = normalizeConfigPayload(payload, existing.value || {});
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serialized, { encoding: 'utf8', mode: 0o600 });
  const permissionWarnings = applyRestrictedPermissions(filePath);

  return {
    ...readRemoteHostLocalConfig(projectRoot),
    saved: true,
    permission_warnings: permissionWarnings,
  };
}

function deleteRemoteHostLocalConfig(projectRoot = getProjectRoot()) {
  const filePath = getConfigPath(projectRoot);
  const existed = fs.existsSync(filePath);
  if (existed) {
    fs.rmSync(filePath, { force: true });
  }
  return {
    ...readRemoteHostLocalConfig(projectRoot),
    removed: existed,
  };
}

function getBashExecutable(options = {}) {
  if (options.bashExecutable) return options.bashExecutable;
  if (process.env.TORQUE_REMOTE_BASH) return process.env.TORQUE_REMOTE_BASH;

  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
        'bash',
      ]
    : ['bash'];

  return candidates.find((candidate) => candidate === 'bash' || fs.existsSync(candidate)) || 'bash';
}

function parseProbeDetail(parts) {
  const detail = {};
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key && value) detail[key] = value;
  }
  return detail;
}

function messageForProbeStatus(status) {
  switch (status) {
    case 'available':
      return 'Remote host is reachable over SSH.';
    case 'not_configured':
      return 'Save remote host config before testing.';
    case 'invalid_config':
      return 'The saved remote host config is invalid JSON.';
    case 'missing_host':
      return 'Remote host is missing from the saved config.';
    case 'missing_user':
      return 'SSH user is missing from the saved config.';
    case 'missing_remote_project_path':
      return 'Remote project path is missing from the saved config.';
    case 'not_ssh_transport':
      return 'Remote transport is not SSH.';
    case 'ssh_unreachable':
      return 'SSH probe could not reach the remote host.';
    case 'probe_timeout':
      return 'Remote host probe timed out.';
    case 'probe_spawn_failed':
      return 'Unable to start the remote host probe.';
    default:
      return 'Remote host probe failed.';
  }
}

function parseProbeOutput(stdout, exitCode, elapsedMs) {
  const line = String(stdout || '').split(/\r?\n/).find((entry) => entry.trim())?.trim() || '';
  const parts = line.split(':');

  if (parts[0] === 'available') {
    return {
      available: true,
      status: 'available',
      target: parts[1] || null,
      message: messageForProbeStatus('available'),
      elapsed_ms: elapsedMs,
    };
  }

  if (parts[0] === 'unavailable') {
    const status = parts[1] || 'unavailable';
    return {
      available: false,
      status,
      detail: parseProbeDetail(parts.slice(2)),
      message: messageForProbeStatus(status),
      elapsed_ms: elapsedMs,
    };
  }

  return {
    available: false,
    status: exitCode === 0 ? 'unknown_probe_response' : 'probe_failed',
    message: messageForProbeStatus('probe_failed'),
    elapsed_ms: elapsedMs,
  };
}

function runProbeCommand(projectRoot, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = Number.parseInt(options.timeoutMs, 10) > 0
    ? Number.parseInt(options.timeoutMs, 10)
    : 10000;
  const availabilityTimeoutSecs = Number.parseInt(options.availabilityTimeoutSecs, 10) > 0
    ? Number.parseInt(options.availabilityTimeoutSecs, 10)
    : 5;

  return new Promise((resolve) => {
    let child;
    try {
      child = childProcess.spawn(
        getBashExecutable(options),
        ['-lc', './bin/torque-remote --__internal-probe-remote-availability'],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            TORQUE_REMOTE_AVAILABILITY_TIMEOUT_SECS: String(availabilityTimeoutSecs),
          },
          windowsHide: true,
        }
      );
    } catch {
      resolve({
        available: false,
        status: 'probe_spawn_failed',
        message: messageForProbeStatus('probe_spawn_failed'),
        elapsed_ms: Date.now() - startedAt,
      });
      return;
    }

    let stdout = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 2048) {
        stdout = stdout.slice(0, 2048);
      }
    });
    child.stderr?.on('data', () => {});

    child.on('error', () => {
      finish({
        available: false,
        status: 'probe_spawn_failed',
        message: messageForProbeStatus('probe_spawn_failed'),
        elapsed_ms: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish({
          available: false,
          status: 'probe_timeout',
          message: messageForProbeStatus('probe_timeout'),
          elapsed_ms: Date.now() - startedAt,
        });
        return;
      }

      finish(parseProbeOutput(stdout, code, Date.now() - startedAt));
    });
  });
}

async function testRemoteHostLocalConfig(projectRoot = getProjectRoot(), options = {}) {
  const filePath = getConfigPath(projectRoot);
  const current = readJsonFile(filePath);
  const configResponse = toResponse(current, projectRoot);

  if (!current.exists) {
    return {
      ...configResponse,
      probe: {
        available: false,
        status: 'not_configured',
        message: messageForProbeStatus('not_configured'),
        elapsed_ms: 0,
      },
    };
  }

  if (current.parseError) {
    return {
      ...configResponse,
      probe: {
        available: false,
        status: 'invalid_config',
        message: messageForProbeStatus('invalid_config'),
        elapsed_ms: 0,
      },
    };
  }

  return {
    ...configResponse,
    probe: await runProbeCommand(projectRoot, options),
  };
}

module.exports = {
  CONFIG_RELATIVE_PATH: CONFIG_RELATIVE_POSIX,
  deleteRemoteHostLocalConfig,
  getConfigPath,
  getGitIgnoredStatus,
  getProjectRoot,
  normalizeConfigPayload,
  parseProbeOutput,
  readRemoteHostLocalConfig,
  saveRemoteHostLocalConfig,
  testRemoteHostLocalConfig,
};
