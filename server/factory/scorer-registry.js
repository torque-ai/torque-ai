'use strict';

const fs = require('fs');
const path = require('path');
const { SOURCE_EXTENSIONS, UI_EXTENSIONS } = require('../constants');

const scorers = {
  structural: require('./scorers/structural'),
  test_coverage: require('./scorers/test-coverage'),
  security: require('./scorers/security'),
  user_facing: require('./scorers/user-facing'),
  api_completeness: require('./scorers/api-completeness'),
  documentation: require('./scorers/documentation'),
  dependency_health: require('./scorers/dependency-health'),
  build_ci: require('./scorers/build-ci'),
  performance: require('./scorers/performance'),
  debt_ratio: require('./scorers/debt-ratio'),
};

const HEALTH_SCAN_DEFAULT_SOURCE_DIRS = ['server', 'dashboard', 'src'];
const HEALTH_SCAN_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'coverage',
  'dist',
  'build',
  'bin',
  'obj',
]);
const HEALTH_SCAN_TEST_DIR_RE = /(?:^|[._-])(test|tests|spec|specs)(?:$|[._-])/i;
const DOTNET_PROJECT_FILE_RE = /\.(?:sln|csproj)$/i;

function projectHasDotnetArtifacts(projectPath) {
  const stack = [projectPath];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!HEALTH_SCAN_IGNORED_DIRS.has(entry.name.toLowerCase())) {
          stack.push(fullPath);
        }
        continue;
      }

      if (entry.isFile() && DOTNET_PROJECT_FILE_RE.test(entry.name)) {
        return true;
      }
    }
  }

  return false;
}

function directoryHasRelevantScanSource(dirPath) {
  const stack = [dirPath];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!HEALTH_SCAN_IGNORED_DIRS.has(entry.name.toLowerCase())) {
          stack.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext) || UI_EXTENSIONS.has(ext) || DOTNET_PROJECT_FILE_RE.test(entry.name)) {
        return true;
      }
    }
  }

  return false;
}

function listHealthScanSourceDirs(projectPath) {
  let entries = [];

  try {
    entries = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !HEALTH_SCAN_IGNORED_DIRS.has(entry.name.toLowerCase()))
    .filter((entry) => !HEALTH_SCAN_TEST_DIR_RE.test(entry.name))
    .filter((entry) => directoryHasRelevantScanSource(path.join(projectPath, entry.name)))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function resolveHealthScanSourceDirs(projectPath) {
  const defaultSourceDirs = HEALTH_SCAN_DEFAULT_SOURCE_DIRS.filter((dir) =>
    fs.existsSync(path.join(projectPath, dir))
  );
  const fallbackSourceDirs = listHealthScanSourceDirs(projectPath);

  if (projectHasDotnetArtifacts(projectPath)) {
    return fallbackSourceDirs.length > 0 ? fallbackSourceDirs : defaultSourceDirs;
  }

  if (defaultSourceDirs.length > 0) {
    return defaultSourceDirs;
  }

  return fallbackSourceDirs.length > 0 ? fallbackSourceDirs : undefined;
}

function scoreDimension(dimension, projectPath, scanReport, findingsDir) {
  const scorer = scorers[dimension];
  if (!scorer) throw new Error(`Unknown dimension: ${dimension}`);
  return scorer.score(projectPath, scanReport, findingsDir);
}

function scoreAll(projectPath, scanReport, findingsDir, dimensions) {
  const dims = dimensions || Object.keys(scorers);
  const results = {};
  for (const dim of dims) {
    try {
      results[dim] = scoreDimension(dim, projectPath, scanReport, findingsDir);
    } catch (err) {
      results[dim] = { score: 50, details: { error: err.message, source: 'error' }, findings: [] };
    }
  }
  return results;
}

module.exports = {
  scoreDimension,
  scoreAll,
  DIMENSIONS: Object.keys(scorers),
  resolveHealthScanSourceDirs,
};
