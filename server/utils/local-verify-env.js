'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveWindowsPowerShellEnv } = require('./windows-powershell-env');

const PYTEST_COMMAND_RE = /\bpytest(?:\.exe)?\b/i;

function getEnvKeyCaseInsensitive(env, name) {
  const lowerName = String(name || '').toLowerCase();
  return Object.keys(env || {}).find((key) => key.toLowerCase() === lowerName) || null;
}

function getEnvValueCaseInsensitive(env, name) {
  const key = getEnvKeyCaseInsensitive(env, name);
  return key ? env[key] : undefined;
}

function deleteEnvKeyCaseInsensitive(env, name) {
  const key = getEnvKeyCaseInsensitive(env, name);
  if (key) {
    delete env[key];
  }
}

function isPytestCommand(command) {
  return PYTEST_COMMAND_RE.test(String(command || ''));
}

function resolveTrustedTempBase(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const localAppData = getEnvValueCaseInsensitive(env, 'LOCALAPPDATA');
    if (localAppData) return path.win32.join(localAppData, 'Temp');

    const userProfile = getEnvValueCaseInsensitive(env, 'USERPROFILE');
    if (userProfile) return path.win32.join(userProfile, 'AppData', 'Local', 'Temp');

    const systemRoot = getEnvValueCaseInsensitive(env, 'SystemRoot') || 'C:\\Windows';
    return path.win32.join(systemRoot, 'Temp');
  }

  return os.tmpdir();
}

function bestEffortCleanup(pathToRemove) {
  if (!pathToRemove) return;
  try {
    fs.rmSync(pathToRemove, {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 50,
    });
  } catch {
    // Best-effort only. A stale temp root under the system temp directory is
    // far less dangerous than reusing a poisoned shared temp root mid-verify.
  }
}

function prepareLocalVerifyEnv(command, env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  const powerShellEnv = resolveWindowsPowerShellEnv(command, env, { platform });
  let nextEnv = powerShellEnv ? { ...powerShellEnv } : undefined;
  let cleanup = () => {};
  let runtimeRoot = null;

  if (platform === 'win32' && isPytestCommand(command)) {
    const mutableEnv = nextEnv || { ...(env || {}) };
    const baseRoot = options.tempBaseRoot || path.join(resolveTrustedTempBase(env, platform), 'torque-verify-runtime');
    fs.mkdirSync(baseRoot, { recursive: true });
    runtimeRoot = fs.mkdtempSync(path.join(baseRoot, 'pytest-'));
    const tempRoot = path.join(runtimeRoot, 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });

    deleteEnvKeyCaseInsensitive(mutableEnv, 'TEMP');
    deleteEnvKeyCaseInsensitive(mutableEnv, 'TMP');
    deleteEnvKeyCaseInsensitive(mutableEnv, 'TMPDIR');
    deleteEnvKeyCaseInsensitive(mutableEnv, 'PYTEST_DEBUG_TEMPROOT');

    mutableEnv.TEMP = tempRoot;
    mutableEnv.TMP = tempRoot;
    mutableEnv.TMPDIR = tempRoot;

    nextEnv = mutableEnv;
    cleanup = () => bestEffortCleanup(runtimeRoot);
  }

  return {
    env: nextEnv,
    cleanup,
    runtimeRoot,
  };
}

module.exports = {
  isPytestCommand,
  resolveTrustedTempBase,
  prepareLocalVerifyEnv,
  _internalForTests: {
    getEnvValueCaseInsensitive,
    deleteEnvKeyCaseInsensitive,
    bestEffortCleanup,
  },
};
