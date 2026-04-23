'use strict';

const path = require('path');

function splitPathList(value) {
  return typeof value === 'string'
    ? value.split(path.win32.delimiter).map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function normalizeForCompare(value) {
  return String(value || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/g, '')
    .toLowerCase();
}

function uniquePathEntries(entries) {
  const seen = new Set();
  const result = [];

  for (const entry of entries) {
    const key = normalizeForCompare(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }

  return result;
}

function getEnvValue(env, name) {
  const lowerName = name.toLowerCase();
  const key = Object.keys(env || {}).find((candidate) => candidate.toLowerCase() === lowerName);
  return key ? env[key] : undefined;
}

function deleteEnvKeyCaseInsensitive(env, name) {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lowerName) {
      delete env[key];
    }
  }
}

function isPowerShellCoreModulePath(entry) {
  const normalized = normalizeForCompare(entry);
  if (!normalized) return false;
  if (normalized.includes('\\windowspowershell\\modules')) return false;
  if (normalized.endsWith('\\documents\\powershell\\modules')) return true;
  if (normalized.endsWith('\\program files\\powershell\\modules')) return true;
  if (normalized.endsWith('\\program files (x86)\\powershell\\modules')) return true;
  return /\\program files(?: \(x86\))?\\powershell\\[^\\]+\\modules$/.test(normalized);
}

function isWindowsPowerShellCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;

  return command
    .replace(/["']/g, ' ')
    .split(/[\s;&|()]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .some((token) => {
      const baseName = token.replace(/^.*[\\/]/, '').toLowerCase();
      return baseName === 'powershell' || baseName === 'powershell.exe';
    });
}

function buildWindowsPowerShellModulePath(env = process.env) {
  const systemRoot = getEnvValue(env, 'SystemRoot') || 'C:\\Windows';
  const programFiles = getEnvValue(env, 'ProgramFiles') || 'C:\\Program Files';
  const userProfile = getEnvValue(env, 'USERPROFILE') || '';
  const existingEntries = splitPathList(getEnvValue(env, 'PSModulePath'))
    .filter((entry) => !isPowerShellCoreModulePath(entry));

  const defaults = [
    userProfile ? path.win32.join(userProfile, 'Documents', 'WindowsPowerShell', 'Modules') : null,
    path.win32.join(programFiles, 'WindowsPowerShell', 'Modules'),
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
  ].filter(Boolean);

  return uniquePathEntries([...existingEntries, ...defaults]).join(path.win32.delimiter);
}

function resolveWindowsPowerShellEnv(command, env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32' || !isWindowsPowerShellCommand(command)) {
    return undefined;
  }

  const nextEnv = { ...env };
  deleteEnvKeyCaseInsensitive(nextEnv, 'PSModulePath');
  nextEnv.PSModulePath = buildWindowsPowerShellModulePath(env);
  return nextEnv;
}

module.exports = {
  buildWindowsPowerShellModulePath,
  isPowerShellCoreModulePath,
  isWindowsPowerShellCommand,
  resolveWindowsPowerShellEnv,
};
