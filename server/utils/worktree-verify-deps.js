'use strict';

const fs = require('fs');
const path = require('path');

const PACKAGE_DIRS = ['', 'server', 'dashboard'];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function isSubpath(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findManagedWorktree(cwd) {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const parts = resolvedCwd.split(path.sep);
  const markerIndex = parts.lastIndexOf('.worktrees');
  if (markerIndex < 0 || markerIndex + 1 >= parts.length) {
    return null;
  }

  const repoRoot = parts.slice(0, markerIndex).join(path.sep) || path.parse(resolvedCwd).root;
  const worktreeRoot = parts.slice(0, markerIndex + 2).join(path.sep);
  if (!repoRoot || !worktreeRoot || repoRoot === worktreeRoot) {
    return null;
  }

  return {
    repoRoot: path.resolve(repoRoot),
    worktreeRoot: path.resolve(worktreeRoot),
  };
}

function readPackageDependencies(packageJsonPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const deps = new Set();
    for (const field of DEPENDENCY_FIELDS) {
      const values = parsed && parsed[field] && typeof parsed[field] === 'object'
        ? parsed[field]
        : null;
      if (!values || Array.isArray(values)) continue;
      for (const name of Object.keys(values)) {
        deps.add(name);
      }
    }
    return [...deps].sort();
  } catch {
    return [];
  }
}

function dependencyInstallPath(nodeModulesPath, dependencyName) {
  return path.join(nodeModulesPath, ...String(dependencyName).split('/').filter(Boolean));
}

function nodeModulesUsable(targetNodeModules, sourceNodeModules, dependencies) {
  if (!fs.existsSync(targetNodeModules)) return false;
  for (const dependency of dependencies) {
    const sourceDep = dependencyInstallPath(sourceNodeModules, dependency);
    if (!fs.existsSync(sourceDep)) continue;
    const targetDep = dependencyInstallPath(targetNodeModules, dependency);
    if (!fs.existsSync(targetDep)) return false;
  }
  return true;
}

function removeTargetNodeModules(targetNodeModules, worktreeRoot) {
  const resolvedTarget = path.resolve(targetNodeModules);
  if (path.basename(resolvedTarget) !== 'node_modules' || !isSubpath(resolvedTarget, worktreeRoot)) {
    throw new Error(`refusing to remove unsafe node_modules path: ${resolvedTarget}`);
  }
  if (!fs.existsSync(resolvedTarget)) return;

  const stat = fs.lstatSync(resolvedTarget);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(resolvedTarget);
    return;
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function linkTypeForPlatform() {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

function preparePackageNodeModules({ repoRoot, worktreeRoot, packageDir, logger }) {
  const relativeDir = packageDir || '';
  const sourcePackageRoot = path.join(repoRoot, relativeDir);
  const targetPackageRoot = path.join(worktreeRoot, relativeDir);
  const targetPackageJson = path.join(targetPackageRoot, 'package.json');
  const sourceNodeModules = path.join(sourcePackageRoot, 'node_modules');
  const targetNodeModules = path.join(targetPackageRoot, 'node_modules');
  const label = relativeDir || '.';

  if (!fs.existsSync(targetPackageJson)) {
    return { packageDir: label, action: 'skipped', reason: 'missing_package_json' };
  }
  if (!fs.existsSync(sourceNodeModules)) {
    return { packageDir: label, action: 'skipped', reason: 'missing_source_node_modules' };
  }

  const dependencies = readPackageDependencies(targetPackageJson);
  if (nodeModulesUsable(targetNodeModules, sourceNodeModules, dependencies)) {
    return { packageDir: label, action: 'unchanged' };
  }

  try {
    removeTargetNodeModules(targetNodeModules, worktreeRoot);
    fs.mkdirSync(path.dirname(targetNodeModules), { recursive: true });
    fs.symlinkSync(sourceNodeModules, targetNodeModules, linkTypeForPlatform());
    return {
      packageDir: label,
      action: 'linked',
      source: sourceNodeModules,
      target: targetNodeModules,
    };
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn('factory worktree verify: could not link shared node_modules', {
        package_dir: label,
        source: sourceNodeModules,
        target: targetNodeModules,
        error: error && error.message ? error.message : String(error),
      });
    }
    return {
      packageDir: label,
      action: 'error',
      reason: error && error.message ? error.message : String(error),
    };
  }
}

function prepareWorktreeVerifyDependencies(cwd, logger) {
  const managed = findManagedWorktree(cwd);
  if (!managed) {
    return { prepared: false, reason: 'not_managed_worktree', packages: [] };
  }

  const packages = PACKAGE_DIRS.map((packageDir) => preparePackageNodeModules({
    repoRoot: managed.repoRoot,
    worktreeRoot: managed.worktreeRoot,
    packageDir,
    logger,
  }));

  const linked = packages.filter((entry) => entry.action === 'linked');
  if (linked.length > 0 && logger && typeof logger.info === 'function') {
    logger.info('factory worktree verify: linked shared node_modules', {
      worktree_path: managed.worktreeRoot,
      packages: linked.map((entry) => entry.packageDir),
    });
  }

  return {
    prepared: true,
    repoRoot: managed.repoRoot,
    worktreeRoot: managed.worktreeRoot,
    packages,
  };
}

module.exports = {
  prepareWorktreeVerifyDependencies,
  _internalForTests: {
    PACKAGE_DIRS,
    dependencyInstallPath,
    findManagedWorktree,
    isSubpath,
    nodeModulesUsable,
    preparePackageNodeModules,
    readPackageDependencies,
    removeTargetNodeModules,
  },
};
