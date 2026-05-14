'use strict';

const path = require('path');

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

function isWindowsAbsolutePath(value) {
  return typeof value === 'string' && WINDOWS_ABSOLUTE_PATH_RE.test(value);
}

function resolvePlatformPath(value) {
  const raw = String(value ?? '');
  if (isWindowsAbsolutePath(raw)) {
    return path.win32.resolve(raw);
  }
  return path.resolve(raw);
}

function joinPlatformPath(base, ...segments) {
  const rawBase = String(base ?? '');
  if (isWindowsAbsolutePath(rawBase)) {
    return path.win32.join(rawBase, ...segments);
  }
  return path.join(rawBase, ...segments);
}

function dirnamePlatformPath(value) {
  const raw = String(value ?? '');
  if (isWindowsAbsolutePath(raw)) {
    return path.win32.dirname(path.win32.normalize(raw));
  }
  return path.dirname(raw);
}

function isPathInsideDirectory(baseDir, targetDir) {
  const resolvedBase = resolvePlatformPath(baseDir);
  const resolvedTarget = resolvePlatformPath(targetDir);
  const baseIsWindows = isWindowsAbsolutePath(resolvedBase);
  const targetIsWindows = isWindowsAbsolutePath(resolvedTarget);

  if (baseIsWindows || targetIsWindows) {
    if (!baseIsWindows || !targetIsWindows) {
      return false;
    }
    if (path.win32.parse(resolvedBase).root.toLowerCase() !== path.win32.parse(resolvedTarget).root.toLowerCase()) {
      return false;
    }
    const rel = path.win32.relative(resolvedBase.toLowerCase(), resolvedTarget.toLowerCase());
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(rel));
  }

  const rel = path.relative(resolvedBase, resolvedTarget);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function normalizeStoredPath(value) {
  const resolved = resolvePlatformPath(value);
  return isWindowsAbsolutePath(resolved) || process.platform === 'win32'
    ? resolved.toLowerCase()
    : resolved;
}

module.exports = {
  dirnamePlatformPath,
  isPathInsideDirectory,
  isWindowsAbsolutePath,
  joinPlatformPath,
  normalizeStoredPath,
  resolvePlatformPath,
};
