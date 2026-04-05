'use strict';

const path = require('path');

/**
 * Normalize a filesystem path to forward slashes, lowercase, no trailing slash.
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  return p ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
}

/**
 * Resolve a potentially sandbox-mangled path to a canonical project path.
 *
 * Tries in order:
 *   1. Exact match (paths are identical)
 *   2. Normalized match (slash direction, trailing slash, case)
 *   3. Basename match (same directory name, different parent — Codex sandbox)
 *
 * @param {string} candidatePath - The path to resolve (may be a sandbox path)
 * @param {string} canonicalPath - The known-good project path
 * @returns {boolean} true if candidatePath refers to the same project as canonicalPath
 */
function pathMatchesProject(candidatePath, canonicalPath) {
  if (!candidatePath || !canonicalPath) return false;

  // 1. Exact
  if (candidatePath === canonicalPath) return true;

  // 2. Normalized
  const normCandidate = normalizePath(candidatePath);
  const normCanonical = normalizePath(canonicalPath);
  if (normCandidate === normCanonical) return true;

  // 3. Basename
  const candidateBase = normCandidate.split('/').filter(Boolean).pop();
  const canonicalBase = normCanonical.split('/').filter(Boolean).pop();
  if (candidateBase && canonicalBase && candidateBase === canonicalBase) return true;

  return false;
}

/**
 * Given an absolute file path from a sandbox environment and the canonical
 * project path, extract the project-relative portion of the file path.
 *
 * @param {string} absoluteFilePath - Absolute path to the file (possibly sandbox)
 * @param {string} projectPath - The canonical project root path
 * @returns {string|null} Relative path within the project, or null if unresolvable
 */
function resolveRelativePath(absoluteFilePath, projectPath) {
  if (!absoluteFilePath || !projectPath) return null;

  const resolvedProject = path.resolve(projectPath);
  const resolvedFile = path.resolve(absoluteFilePath);

  // 1. Standard resolution
  const relative = path.relative(resolvedProject, resolvedFile);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.replace(/\\/g, '/');
  }

  // 2. Suffix extraction — find project directory name in the file path
  const fwd = resolvedFile.replace(/\\/g, '/');
  const projectBase = normalizePath(resolvedProject).split('/').filter(Boolean).pop();
  if (projectBase) {
    const marker = '/' + projectBase + '/';
    const idx = fwd.toLowerCase().lastIndexOf(marker.toLowerCase());
    if (idx !== -1) {
      const suffix = fwd.slice(idx + marker.length);
      if (suffix && !suffix.startsWith('..')) {
        return suffix;
      }
    }
  }

  return null;
}

module.exports = { normalizePath, pathMatchesProject, resolveRelativePath };
