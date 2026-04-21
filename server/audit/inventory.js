'use strict';

const fsPromises = require('node:fs/promises');
const path = require('node:path');

const { SOURCE_EXTENSIONS } = require('../constants');

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '__pycache__',
  '.venv',
  '.cache',
]);

const SMALL_THRESHOLD = 400;
const LARGE_THRESHOLD = 1200;

const IMPORT_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx']);

const toSet = (value, fallback) => {
  if (!value) return new Set(fallback);
  if (value instanceof Set) {
    return new Set(Array.from(value));
  }

  return new Set(Array.isArray(value) ? value : [...fallback]);
};

const normalizeExtensionSet = (extensions) => {
  const extensionSet = toSet(extensions, SOURCE_EXTENSIONS);
  const normalized = new Set();

  for (const ext of extensionSet) {
    if (typeof ext !== 'string') {
      continue;
    }

    const lower = ext.toLowerCase();
    normalized.add(lower.startsWith('.') ? lower : `.${lower}`);
  }

  return normalized;
};

const normalizeIgnoreDirs = (ignoreDirs) => {
  const set = toSet(ignoreDirs, DEFAULT_IGNORE_DIRS);
  const normalized = new Set();

  for (const item of set) {
    if (typeof item !== 'string') {
      continue;
    }

    normalized.add(item.toLowerCase());
  }

  return normalized;
};

const classifyTier = (lineCount) => {
  if (lineCount < SMALL_THRESHOLD) {
    return 'small';
  }

  if (lineCount < LARGE_THRESHOLD) {
    return 'medium';
  }

  return 'large';
};

const extractImportPaths = (content) => {
  if (typeof content !== 'string' || content.length === 0) {
    return [];
  }

  const importRegexes = [
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+(?:[^"'\n]*?\s+from\s+)?["']([^"']+)["']/g,
  ];
  const paths = [];
  const seen = new Set();

  for (const pattern of importRegexes) {
    let match;

    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1];
      if (importPath && !seen.has(importPath)) {
        seen.add(importPath);
        paths.push(importPath);
      }
    }
  }

  return paths;
};

const readFileContent = async (filePath) => {
  const buffer = await fsPromises.readFile(filePath);
  const content = buffer.toString('utf8');
  return {
    content,
    lines: content.split('\n').length,
    size: buffer.byteLength,
  };
};

const matchesPattern = (relativePath, patterns) => {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }

  const normalizedPath = relativePath.replace(/\\/g, '/');

  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      continue;
    }

    if (pattern.startsWith('*')) {
      if (normalizedPath.endsWith(pattern.slice(1))) {
        return true;
      }

      continue;
    }

    if (normalizedPath.includes(pattern)) {
      return true;
    }
  }

  return false;
};

const inventoryFiles = async (projectPath, options = {}) => {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    throw new TypeError('projectPath must be a non-empty string');
  }

  const {
    sourceDirs = ['src', 'server', 'lib'],
    ignoreDirs,
    ignorePatterns = [],
    extensions,
  } = options;

  const extensionSet = normalizeExtensionSet(extensions);
  const ignoreDirectorySet = normalizeIgnoreDirs(ignoreDirs);
  const absoluteProjectPath = path.resolve(projectPath);
  const results = [];

  const walkDir = async (dirPath) => {
    let entries;

    try {
      entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(absoluteProjectPath, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) {
          continue;
        }

        if (ignoreDirectorySet.has(entry.name.toLowerCase())) {
          continue;
        }

        await walkDir(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (matchesPattern(relativePath, ignorePatterns)) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!extensionSet.has(ext)) {
        continue;
      }

      const { content, lines, size } = await readFileContent(fullPath);
      const importPaths = IMPORT_EXTENSIONS.has(ext) ? extractImportPaths(content) : [];

      results.push({
        path: fullPath,
        relativePath,
        name: entry.name,
        ext,
        size,
        lines,
        tier: classifyTier(lines),
        importPaths,
      });
    }
  };

  for (const sourceDir of sourceDirs) {
    if (typeof sourceDir !== 'string' || sourceDir.trim().length === 0) {
      continue;
    }

    const sourcePath = path.join(absoluteProjectPath, sourceDir);
    await walkDir(sourcePath);
  }

  return results;
};

module.exports = {
  inventoryFiles,
  classifyTier,
  extractImportPaths,
  SMALL_THRESHOLD,
  LARGE_THRESHOLD,
  DEFAULT_IGNORE_DIRS,
};
