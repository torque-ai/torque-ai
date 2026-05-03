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

function readPackageJson(packageJsonPath) {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function packageBinEntries(nodeModulesPath, dependencyName) {
  const packageRoot = dependencyInstallPath(nodeModulesPath, dependencyName);
  const packageJson = readPackageJson(path.join(packageRoot, 'package.json'));
  if (!packageJson || !packageJson.bin) return [];

  if (typeof packageJson.bin === 'string') {
    const fallbackName = String(packageJson.name || dependencyName).split('/').filter(Boolean).pop();
    return fallbackName ? [{ name: fallbackName, target: packageJson.bin }] : [];
  }

  if (typeof packageJson.bin !== 'object' || Array.isArray(packageJson.bin)) {
    return [];
  }

  return Object.entries(packageJson.bin)
    .filter(([name, target]) => typeof name === 'string' && typeof target === 'string')
    .map(([name, target]) => ({ name, target }));
}

function isSafeBinName(name) {
  return Boolean(name)
    && !name.includes('/')
    && !name.includes('\\')
    && name !== '.'
    && name !== '..';
}

function platformBinPath(binDir, binName) {
  return process.platform === 'win32'
    ? path.join(binDir, `${binName}.cmd`)
    : path.join(binDir, binName);
}

function packageBinsUsable(nodeModulesPath, dependencyName) {
  const entries = packageBinEntries(nodeModulesPath, dependencyName);
  if (entries.length === 0) return true;

  const binDir = path.join(nodeModulesPath, '.bin');
  return entries.every(({ name, target }) => {
    if (!isSafeBinName(name)) return true;
    const packageRoot = dependencyInstallPath(nodeModulesPath, dependencyName);
    const targetPath = path.resolve(packageRoot, target);
    if (!fs.existsSync(targetPath)) return true;
    return fs.existsSync(platformBinPath(binDir, name));
  });
}

function writeFileIfMissing(filePath, content, mode) {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, mode ? { encoding: 'utf8', mode } : 'utf8');
  return true;
}

function writeWindowsBinShim(binDir, binName, targetPath) {
  const relativeTarget = path.relative(binDir, targetPath);
  const cmdTarget = relativeTarget.replace(/\//g, '\\');
  const psTarget = relativeTarget.replace(/\\/g, '/');
  let created = 0;

  if (writeFileIfMissing(
    path.join(binDir, `${binName}.cmd`),
    `@ECHO off\r\nnode "%~dp0\\${cmdTarget}" %*\r\n`,
  )) {
    created += 1;
  }

  if (writeFileIfMissing(
    path.join(binDir, `${binName}.ps1`),
    `$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent\n& node "$basedir/${psTarget}" @args\nexit $LASTEXITCODE\n`,
  )) {
    created += 1;
  }

  return created;
}

function writePosixBinShim(binPath, binDir, targetPath) {
  if (fs.existsSync(binPath)) return false;

  const relativeTarget = path.relative(binDir, targetPath).replace(/\\/g, '/');
  try {
    fs.symlinkSync(relativeTarget, binPath, 'file');
  } catch {
    writeFileIfMissing(
      binPath,
      `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\nexec node "$basedir/${relativeTarget}" "$@"\n`,
      0o755,
    );
  }
  try { fs.chmodSync(binPath, 0o755); } catch { /* best effort */ }
  return true;
}

function ensurePackageBins(nodeModulesPath, dependencies, logger) {
  let repaired = 0;

  for (const dependency of dependencies) {
    const packageRoot = dependencyInstallPath(nodeModulesPath, dependency);
    if (!fs.existsSync(packageRoot)) continue;

    for (const { name, target } of packageBinEntries(nodeModulesPath, dependency)) {
      if (!isSafeBinName(name)) continue;
      const targetPath = path.resolve(packageRoot, target);
      if (!isSubpath(targetPath, packageRoot) || !fs.existsSync(targetPath)) continue;

      try {
        const binDir = path.join(nodeModulesPath, '.bin');
        fs.mkdirSync(binDir, { recursive: true });
        if (process.platform === 'win32') {
          repaired += writeWindowsBinShim(binDir, name, targetPath);
        } else if (writePosixBinShim(path.join(binDir, name), binDir, targetPath)) {
          repaired += 1;
        }
      } catch (error) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('factory worktree verify: could not repair package bin shim', {
            dependency,
            bin: name,
            node_modules: nodeModulesPath,
            error: error && error.message ? error.message : String(error),
          });
        }
      }
    }
  }

  return repaired;
}

function nodeModulesUsable(targetNodeModules, sourceNodeModules, dependencies) {
  if (!fs.existsSync(targetNodeModules)) return false;
  for (const dependency of dependencies) {
    const sourceDep = dependencyInstallPath(sourceNodeModules, dependency);
    if (!fs.existsSync(sourceDep)) continue;
    const targetDep = dependencyInstallPath(targetNodeModules, dependency);
    if (!fs.existsSync(targetDep)) return false;
    if (!packageBinsUsable(targetNodeModules, dependency)) return false;
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
  const repairedBins = ensurePackageBins(sourceNodeModules, dependencies, logger);
  if (nodeModulesUsable(targetNodeModules, sourceNodeModules, dependencies)) {
    return { packageDir: label, action: 'unchanged', repairedBins };
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
      repairedBins,
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
    ensurePackageBins,
    findManagedWorktree,
    isSubpath,
    nodeModulesUsable,
    packageBinEntries,
    packageBinsUsable,
    preparePackageNodeModules,
    readPackageDependencies,
    removeTargetNodeModules,
  },
};
