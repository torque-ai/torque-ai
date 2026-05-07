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

function wrapVerifyCommandForTestLane(command, { projectPath } = {}) {
  const normalized = String(command || '').trim();
  if (!normalized) return normalized;
  if (!hasTestLaneLauncher(projectPath)) return normalized;
  if (isAlreadyLaneCommand(normalized) || isRemoteVerifyCommand(normalized)) return normalized;
  return `node scripts/test-lane.js --lane auto --command-base64 ${encodeVerifyCommand(normalized)}`;
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
  wrapVerifyCommandForTestLane,
};
