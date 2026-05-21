'use strict';

const fs = require('fs');
const path = require('path');

const RAW_DEFAULT_VERIFY_COMMAND = 'cd server && npx vitest run';

function hasTestLaneLauncher(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return false;
  try {
    return fs.existsSync(path.join(projectPath, 'scripts', 'test-lane.js'));
  } catch (_err) {
    return false;
  }
}

function isAlreadyLaneCommand(command) {
  const normalized = String(command || '').replace(/\\/g, '/');
  return /\bscripts\/test-lane\.(?:js|ps1)\b/.test(normalized)
    || /\btest-lane\.js\b/.test(normalized);
}

function isRemoteVerifyCommand(command) {
  return /\btorque-remote\b/.test(String(command || ''));
}

function encodeVerifyCommand(command) {
  return Buffer.from(String(command || ''), 'utf8').toString('base64');
}

function hasShellControlOperator(command) {
  return /(?:&&|\|\||[;|`<>])/.test(String(command || ''));
}

function normalizeRootScopedRequirePaths(command) {
  return String(command || '').replace(
    /\brequire\(\s*(['"])((?:server|dashboard)[\\/][^'"]+)\1\s*\)/g,
    (_match, quote, filePath) => `require(${quote}./${filePath.replace(/\\/g, '/')}${quote})`
  );
}

function normalizeVerifyCommandForTestLane(command) {
  const text = normalizeRootScopedRequirePaths(command).trim();
  if (!text) return text;
  if (hasShellControlOperator(text)) return text;
  if (!/^(?:npx\s+)?vitest\s+run\b/.test(text)) return text;
  if (!/(^|\s)(["']?)server[\\/]/.test(text)) return text;

  const rewritten = text.replace(
    /(^|\s)(["']?)server[\\/](\S+?)\2(?=\s|$)/g,
    (_match, prefix, quote, filePath) => `${prefix}${quote}${filePath.replace(/\\/g, '/')}${quote}`
  );
  return `cd server && ${rewritten}`;
}

function hasVitestConfigLoader(command) {
  return /(?:^|\s)--config(?:L|-l)oader(?:=|\s)/.test(String(command || ''));
}

function isManagedWorktreePath(projectPath) {
  return /[\\/]\.worktrees[\\/][^\\/]+$/i.test(String(projectPath || ''));
}

function hasTypescriptVitestConfig(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return false;
  try {
    return fs.existsSync(path.join(projectPath, 'vitest.config.ts'))
      || fs.existsSync(path.join(projectPath, 'vitest.config.mts'))
      || fs.existsSync(path.join(projectPath, 'vitest.config.cts'));
  } catch (_err) {
    return false;
  }
}

function normalizeVitestConfigLoaderForWorktree(command, { projectPath } = {}) {
  const text = String(command || '').trim();
  if (!text) return text;
  if (hasShellControlOperator(text)) return text;
  if (!/^(?:npx\s+)?vitest\s+run\b/.test(text)) return text;
  if (hasVitestConfigLoader(text)) return text;
  if (!isManagedWorktreePath(projectPath)) return text;
  if (!hasTypescriptVitestConfig(projectPath)) return text;
  return `${text} --configLoader runner`;
}

function wrapVerifyCommandForTestLane(command, { projectPath } = {}) {
  const normalized = normalizeVitestConfigLoaderForWorktree(command, { projectPath });
  if (!normalized) return normalized;
  if (!hasTestLaneLauncher(projectPath)) return normalized;
  if (isAlreadyLaneCommand(normalized) || isRemoteVerifyCommand(normalized)) return normalized;
  return `node scripts/test-lane.js --lane auto --command-base64 ${encodeVerifyCommand(normalizeVerifyCommandForTestLane(normalized))}`;
}

function defaultVerifyCommandForProject(projectPath) {
  return wrapVerifyCommandForTestLane(RAW_DEFAULT_VERIFY_COMMAND, { projectPath });
}

module.exports = {
  RAW_DEFAULT_VERIFY_COMMAND,
  defaultVerifyCommandForProject,
  encodeVerifyCommand,
  hasTestLaneLauncher,
  isAlreadyLaneCommand,
  isRemoteVerifyCommand,
  normalizeVitestConfigLoaderForWorktree,
  normalizeRootScopedRequirePaths,
  normalizeVerifyCommandForTestLane,
  wrapVerifyCommandForTestLane,
};
