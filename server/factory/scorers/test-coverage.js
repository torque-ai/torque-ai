'use strict';

const fs = require('fs');
const path = require('path');

const IGNORED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'coverage',
  'dist',
  'build',
  'bin',
  'obj',
]);

const GENERIC_TEST_FILE_PATTERN = /\.test\.|\.spec\.|_test\./i;
const PYTHON_TEST_FILE_PATTERN = /^test_.*\.py$|_test\.py$|conftest\.py$/i;
const DOTNET_TEST_FILE_PATTERN = /Tests?\.cs$/i;
const DOTNET_TEST_PROJECT_NAME_PATTERN = /\.Tests?\.csproj$/i;
const DOTNET_TEST_PROJECT_REFERENCE_PATTERN = /<PackageReference\b[^>]*Include\s*=\s*"(?:Microsoft\.NET\.Test\.Sdk|xunit(?:\.[^"]*)?|NUnit(?:\.[^"]*)?|MSTest(?:\.[^"]*)?)"/i;

function isDirectory(dirPath) {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function walkFiles(rootDir, visitor) {
  if (!isDirectory(rootDir)) {
    return;
  }

  const stack = [rootDir];
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
        if (!IGNORED_DIR_NAMES.has(entry.name.toLowerCase())) {
          stack.push(fullPath);
        }
        continue;
      }

      if (entry.isFile()) {
        visitor(fullPath);
      }
    }
  }
}

function isDotnetTestProject(filePath) {
  const fileName = path.basename(filePath);
  if (!fileName.toLowerCase().endsWith('.csproj')) {
    return false;
  }

  if (DOTNET_TEST_PROJECT_NAME_PATTERN.test(fileName)) {
    return true;
  }

  try {
    const projectFile = fs.readFileSync(filePath, 'utf8');
    return DOTNET_TEST_PROJECT_REFERENCE_PATTERN.test(projectFile);
  } catch {
    return false;
  }
}

function isTestAsset(filePath) {
  const fileName = path.basename(filePath);

  return GENERIC_TEST_FILE_PATTERN.test(fileName) ||
    PYTHON_TEST_FILE_PATTERN.test(fileName) ||
    DOTNET_TEST_FILE_PATTERN.test(fileName) ||
    isDotnetTestProject(filePath);
}

function countTestAssets(projectPath) {
  let testFileCount = 0;

  walkFiles(projectPath, (filePath) => {
    if (isTestAsset(filePath)) {
      testFileCount += 1;
    }
  });

  return testFileCount;
}

function score(projectPath, scanReport, findingsDir) {
  void findingsDir;

  const mt = scanReport?.missingTests;

  // If scan_project reports coverage, use it
  if (mt && mt.total > 0 && mt.coveragePercent > 0) {
    const findings = [];
    if (mt.missing > 0 && Array.isArray(mt.missingFiles)) {
      for (const f of mt.missingFiles.slice(0, 5)) {
        findings.push({
          severity: f.lines > 300 ? 'high' : f.lines > 100 ? 'medium' : 'low',
          title: `Missing test for ${f.file} (${f.lines} lines)`,
          file: f.file,
        });
      }
    }
    return {
      score: Math.max(0, Math.min(100, mt.coveragePercent)),
      details: { source: 'scan_project', covered: mt.covered, missing: mt.missing, total: mt.total, coveragePercent: mt.coveragePercent },
      findings,
    };
  }

  // Fallback: count recognized test assets directly, including .NET test projects/files.
  const testFileCount = countTestAssets(projectPath);
  let sourceFileCount = mt?.total || scanReport?.fileSizes?.totalCodeFiles || 0;

  if (testFileCount === 0 && sourceFileCount === 0) {
    return { score: 50, details: { source: 'no_data' }, findings: [] };
  }

  // Estimate coverage ratio from test file count vs source file count
  const ratio = sourceFileCount > 0 ? Math.min(testFileCount / sourceFileCount, 1.0) : 0;
  const coveragePercent = Math.round(ratio * 100);

  return {
    score: Math.max(0, Math.min(100, coveragePercent)),
    details: {
      source: 'file_count_heuristic',
      test_files: testFileCount,
      source_files: sourceFileCount,
      coveragePercent,
    },
    findings: coveragePercent < 50 ? [{ severity: 'medium', title: `Test file ratio is ${coveragePercent}% (${testFileCount} test files / ${sourceFileCount} source files)`, file: null }] : [],
  };
}

module.exports = { score };
