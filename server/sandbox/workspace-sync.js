'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORED_NAMES = new Set(['.git']);
const DEFAULT_IGNORED_PREFIXES = [
  path.normalize('.torque/sandbox'),
];

function normalizeRelativePath(relativePath) {
  return path.normalize(relativePath || '.');
}

function normalizeForMatch(value) {
  const normalized = normalizeRelativePath(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function toSandboxPath(...parts) {
  const segments = parts
    .flatMap((part) => String(part || '').split(/[\\/]+/))
    .filter(Boolean);
  return segments.length > 0 ? segments.join('/') : '.';
}

function isWithinRoot(rootDir, targetPath) {
  const relativePath = path.relative(rootDir, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function shouldIgnore(relativePath, entryName, ignoredNames, ignoredPrefixes) {
  if (ignoredNames.has(entryName)) {
    return true;
  }

  const normalizedRelativePath = normalizeForMatch(relativePath);
  return ignoredPrefixes.some((prefix) => (
    normalizedRelativePath === prefix
    || normalizedRelativePath.startsWith(`${prefix}${path.sep}`)
  ));
}

async function copyWorkspaceToSandbox({
  sandboxManager,
  sandboxId,
  sourceDir,
  targetDir = 'workspace',
  ignoredNames = DEFAULT_IGNORED_NAMES,
  ignoredRelativePrefixes = DEFAULT_IGNORED_PREFIXES,
} = {}) {
  if (!sandboxManager || typeof sandboxManager.writeFile !== 'function') {
    throw new Error('copyWorkspaceToSandbox requires a sandboxManager with writeFile');
  }
  if (!sandboxId || typeof sandboxId !== 'string') {
    throw new Error('copyWorkspaceToSandbox requires a sandboxId');
  }
  if (!sourceDir || typeof sourceDir !== 'string') {
    throw new Error('copyWorkspaceToSandbox requires a sourceDir');
  }

  const rootDir = path.resolve(sourceDir);
  const normalizedIgnoredPrefixes = ignoredRelativePrefixes.map(normalizeForMatch);
  const directoryStack = new Set();
  let filesCopied = 0;
  let bytesCopied = 0;
  let symlinksFollowed = 0;
  let ignoredEntries = 0;

  async function copyFile(absolutePath, relativePath) {
    const content = fs.readFileSync(absolutePath);
    await sandboxManager.writeFile(
      sandboxId,
      toSandboxPath(targetDir, relativePath),
      content,
    );
    filesCopied += 1;
    bytesCopied += content.length;
  }

  async function walkDirectory(absoluteDir, relativeDir) {
    const realDir = fs.realpathSync.native
      ? fs.realpathSync.native(absoluteDir)
      : fs.realpathSync(absoluteDir);
    if (directoryStack.has(realDir)) {
      return;
    }

    directoryStack.add(realDir);
    try {
      for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
        const absolutePath = path.join(absoluteDir, entry.name);
        const relativePath = relativeDir
          ? path.join(relativeDir, entry.name)
          : entry.name;

        if (shouldIgnore(relativePath, entry.name, ignoredNames, normalizedIgnoredPrefixes)) {
          ignoredEntries += 1;
          continue;
        }

        const stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink()) {
          const realPath = fs.realpathSync.native
            ? fs.realpathSync.native(absolutePath)
            : fs.realpathSync(absolutePath);
          if (!isWithinRoot(rootDir, realPath)) {
            ignoredEntries += 1;
            continue;
          }

          symlinksFollowed += 1;
          const realStat = fs.statSync(realPath);
          if (realStat.isDirectory()) {
            await walkDirectory(realPath, relativePath);
            continue;
          }
          if (realStat.isFile()) {
            await copyFile(realPath, relativePath);
          }
          continue;
        }

        if (stat.isDirectory()) {
          await walkDirectory(absolutePath, relativePath);
          continue;
        }

        if (stat.isFile()) {
          await copyFile(absolutePath, relativePath);
        }
      }
    } finally {
      directoryStack.delete(realDir);
    }
  }

  await walkDirectory(rootDir, '');

  return {
    source_dir: rootDir,
    target_dir: targetDir,
    files_copied: filesCopied,
    bytes_copied: bytesCopied,
    symlinks_followed: symlinksFollowed,
    ignored_entries: ignoredEntries,
  };
}

module.exports = {
  copyWorkspaceToSandbox,
};
