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

module.exports = {
  CONFIG_RELATIVE_PATH: CONFIG_RELATIVE_POSIX,
  deleteRemoteHostLocalConfig,
  getConfigPath,
  getGitIgnoredStatus,
  getProjectRoot,
  normalizeConfigPayload,
  readRemoteHostLocalConfig,
  saveRemoteHostLocalConfig,
};
