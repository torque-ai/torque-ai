'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PACKAGE_DIRS = Object.freeze(['', 'server', 'dashboard']);

function packageLabel(packageDir) {
  return packageDir || '.';
}

function removeDirectoryLink(linkPath) {
  try {
    fs.unlinkSync(linkPath);
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'ENOTDIR'].includes(error.code)) {
      throw error;
    }
    fs.rmdirSync(linkPath);
  }
}

function unlinkWorktreeNodeModulesLinks(worktreePath, options = {}) {
  const packageDirs = Array.isArray(options.packageDirs)
    ? options.packageDirs
    : DEFAULT_PACKAGE_DIRS;
  const removed = [];
  const skipped = [];
  const errors = [];

  for (const packageDir of packageDirs) {
    const relativeDir = String(packageDir || '');
    const nodeModulesPath = path.join(worktreePath, relativeDir, 'node_modules');
    const label = packageLabel(relativeDir);
    let stat;

    try {
      stat = fs.lstatSync(nodeModulesPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        skipped.push({ packageDir: label, path: nodeModulesPath, reason: 'missing' });
      } else {
        errors.push({
          packageDir: label,
          path: nodeModulesPath,
          error: error && error.message ? error.message : String(error),
        });
      }
      continue;
    }

    if (!stat.isSymbolicLink()) {
      skipped.push({ packageDir: label, path: nodeModulesPath, reason: 'not_link' });
      continue;
    }

    try {
      removeDirectoryLink(nodeModulesPath);
      removed.push({ packageDir: label, path: nodeModulesPath });
    } catch (error) {
      errors.push({
        packageDir: label,
        path: nodeModulesPath,
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  return {
    ok: errors.length === 0,
    removed,
    skipped,
    errors,
  };
}

module.exports = {
  DEFAULT_PACKAGE_DIRS,
  unlinkWorktreeNodeModulesLinks,
};
