'use strict';

const fs = require('fs');
const path = require('path');

const LINT_CONFIG_FILES = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
  '.eslintrc.cjs',
  'eslint.config.js',
  'eslint.config.cjs',
  'eslint.config.mjs',
];

const IGNORED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'coverage',
  'dist',
  'build',
  'bin',
  'obj',
]);

const BUILD_SIGNAL_PATTERN = /\b(?:dotnet\s+build|(?:npm|pnpm|yarn)\s+(?:run\s+)?build|build\.ps1)\b/i;
const TEST_SIGNAL_PATTERN = /\b(?:dotnet\s+test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|vitest\b|jest\b|pytest\b|test\.ps1)\b/i;
const DOTNET_TEST_PROJECT_NAME_PATTERN = /\.Tests?\.csproj$/i;
const DOTNET_TEST_PROJECT_REFERENCE_PATTERN = /<PackageReference\b[^>]*Include\s*=\s*"(?:Microsoft\.NET\.Test\.Sdk|xunit(?:\.[^"]*)?|NUnit(?:\.[^"]*)?|MSTest(?:\.[^"]*)?)"/i;

function clampScore(value) {
  return Math.max(0, Math.min(100, value));
}

function isDirectory(dirPath) {
  return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
}

function directoryHasFile(dirPath) {
  if (!isDirectory(dirPath)) {
    return false;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries.some((entry) => entry.isFile());
}

function loadPackageScripts(packageJsonPath) {
  if (!fs.existsSync(packageJsonPath)) {
    return {};
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  } catch {
    return {};
  }
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
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

  return DOTNET_TEST_PROJECT_REFERENCE_PATTERN.test(readTextFile(filePath));
}

function scanWorkflowSignals(workflowsDir) {
  let ciWorkflowCount = 0;
  let workflowHasBuildSignal = false;
  let workflowHasTestSignal = false;

  if (!isDirectory(workflowsDir)) {
    return { ciWorkflowCount, workflowHasBuildSignal, workflowHasTestSignal };
  }

  for (const name of fs.readdirSync(workflowsDir)) {
    if (!/\.ya?ml$/i.test(name)) {
      continue;
    }

    ciWorkflowCount += 1;
    const workflowText = readTextFile(path.join(workflowsDir, name));
    workflowHasBuildSignal = workflowHasBuildSignal || BUILD_SIGNAL_PATTERN.test(workflowText);
    workflowHasTestSignal = workflowHasTestSignal || TEST_SIGNAL_PATTERN.test(workflowText);
  }

  return { ciWorkflowCount, workflowHasBuildSignal, workflowHasTestSignal };
}

function scanProjectSignals(projectPath) {
  const signals = {
    hasDotnetProject: fs.existsSync(path.join(projectPath, 'global.json')),
    hasDotnetTestProject: false,
    hasPowerShellBuildScript: false,
    hasPowerShellTestScript: false,
    // Python ecosystem
    hasPythonProject: fs.existsSync(path.join(projectPath, 'pyproject.toml'))
      || fs.existsSync(path.join(projectPath, 'setup.py'))
      || fs.existsSync(path.join(projectPath, 'setup.cfg')),
    hasPythonTests: false,
    hasPythonBuild: fs.existsSync(path.join(projectPath, 'pyproject.toml'))
      || fs.existsSync(path.join(projectPath, 'Makefile')),
    hasPythonLint: fs.existsSync(path.join(projectPath, 'pyproject.toml'))
      || fs.existsSync(path.join(projectPath, '.flake8'))
      || fs.existsSync(path.join(projectPath, 'ruff.toml'))
      || fs.existsSync(path.join(projectPath, '.ruff.toml')),
  };

  walkFiles(projectPath, (filePath) => {
    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
    const fileName = path.basename(filePath).toLowerCase();

    if (fileName === 'build.ps1' || normalizedPath.endsWith('/build.ps1')) {
      signals.hasPowerShellBuildScript = true;
    }
    if (fileName === 'test.ps1' || normalizedPath.endsWith('/test.ps1')) {
      signals.hasPowerShellTestScript = true;
    }
    if (normalizedPath.endsWith('.sln') || normalizedPath.endsWith('.csproj')) {
      signals.hasDotnetProject = true;
    }
    if (!signals.hasDotnetTestProject && normalizedPath.endsWith('.csproj') && isDotnetTestProject(filePath)) {
      signals.hasDotnetTestProject = true;
    }
    // Python test detection: test_*.py, *_test.py, conftest.py, pytest.ini
    if (!signals.hasPythonTests && (
      /^test_.*\.py$/i.test(fileName) ||
      /_test\.py$/i.test(fileName) ||
      fileName === 'conftest.py' ||
      fileName === 'pytest.ini'
    )) {
      signals.hasPythonTests = true;
    }
  });

  return signals;
}

function score(projectPath, scanReport, findingsDir) {
  void scanReport;
  void findingsDir;

  if (!projectPath || String(projectPath).trim() === '') {
    return {
      score: 50,
      details: { source: 'build_ci_signals', reason: 'no_project_path' },
      findings: [{ severity: 'low', title: 'No project path supplied', file: null }],
    };
  }

  try {
    const findings = [];

    const workflowsDir = path.join(projectPath, '.github', 'workflows');
    const {
      ciWorkflowCount,
      workflowHasBuildSignal,
      workflowHasTestSignal,
    } = scanWorkflowSignals(workflowsDir);

    const hasGitlabCi = fs.existsSync(path.join(projectPath, '.gitlab-ci.yml'));
    const hasJenkinsfile = fs.existsSync(path.join(projectPath, 'Jenkinsfile'));
    const hasCircleCi = isDirectory(path.join(projectPath, '.circleci'));
    const hasAzurePipelines = fs.existsSync(path.join(projectPath, 'azure-pipelines.yml'));
    const hasOtherCiTool = hasGitlabCi || hasJenkinsfile || hasCircleCi || hasAzurePipelines;

    const projectSignals = scanProjectSignals(projectPath);
    let hasBuild = false;
    let hasTest = false;
    let hasLint = false;
    let hasTypecheck = false;

    const packageJsonPaths = [
      path.join(projectPath, 'package.json'),
      path.join(projectPath, 'server', 'package.json'),
      path.join(projectPath, 'dashboard', 'package.json'),
    ];

    for (const packageJsonPath of packageJsonPaths) {
      const scripts = loadPackageScripts(packageJsonPath);
      hasBuild = hasBuild || Boolean(scripts.build);
      hasTest = hasTest || Boolean(scripts.test);
      hasLint = hasLint || Boolean(scripts.lint);
      hasTypecheck = hasTypecheck || Boolean(scripts.typecheck || scripts['type-check'] || scripts.tsc);
    }

    hasBuild = hasBuild ||
      workflowHasBuildSignal ||
      projectSignals.hasPowerShellBuildScript ||
      projectSignals.hasPythonBuild;
    hasTest = hasTest ||
      workflowHasTestSignal ||
      projectSignals.hasPowerShellTestScript ||
      projectSignals.hasDotnetTestProject ||
      projectSignals.hasPythonTests;
    hasLint = hasLint || projectSignals.hasPythonLint;

    const lintSearchDirs = [
      projectPath,
      path.join(projectPath, 'server'),
      path.join(projectPath, 'dashboard'),
    ];
    const hasLintConfig = lintSearchDirs.some((dirPath) =>
      LINT_CONFIG_FILES.some((fileName) => fs.existsSync(path.join(dirPath, fileName))),
    ) || projectSignals.hasPythonLint;

    const hasPreCommit =
      directoryHasFile(path.join(projectPath, '.husky')) ||
      fs.existsSync(path.join(projectPath, '.git', 'hooks', 'pre-commit')) ||
      fs.existsSync(path.join(projectPath, '.pre-commit-config.yaml'));

    let totalScore = 0;

    if (ciWorkflowCount > 0) {
      totalScore += 20;
    }
    if (ciWorkflowCount >= 3 || hasOtherCiTool) {
      totalScore += 5;
    }

    if (hasBuild) {
      totalScore += 6;
    }
    if (hasTest) {
      totalScore += 6;
    }
    if (hasLint) {
      totalScore += 6;
    }
    if (hasTypecheck) {
      totalScore += 6;
    }
    if (hasBuild && hasTest && hasLint && hasTypecheck) {
      totalScore += 1;
    }

    if (hasLintConfig) {
      totalScore += 25;
    }

    if (hasPreCommit) {
      totalScore += 25;
    }

    if (ciWorkflowCount === 0 && !hasOtherCiTool) {
      findings.push({ severity: 'medium', title: 'No CI configuration detected', file: null });
    }
    if (!hasTest) {
      findings.push({ severity: 'medium', title: 'No test script in any package.json', file: 'package.json' });
    }
    if (!hasLintConfig) {
      findings.push({ severity: 'low', title: 'No ESLint config detected', file: null });
    }
    if (!hasPreCommit) {
      findings.push({ severity: 'low', title: 'No pre-commit hooks detected (.husky or .git/hooks/pre-commit)', file: null });
    }
    if (!hasTypecheck) {
      findings.push({ severity: 'low', title: 'No typecheck script detected', file: null });
    }

    return {
      score: clampScore(totalScore),
      details: {
        source: 'build_ci_signals',
        ciWorkflowCount,
        hasBuild,
        hasTest,
        hasLint,
        hasTypecheck,
        hasLintConfig,
        hasPreCommit,
        hasDotnetProject: projectSignals.hasDotnetProject,
        hasDotnetTestProject: projectSignals.hasDotnetTestProject,
        hasPowerShellBuildScript: projectSignals.hasPowerShellBuildScript,
        hasPowerShellTestScript: projectSignals.hasPowerShellTestScript,
        hasPythonProject: projectSignals.hasPythonProject,
        hasPythonTests: projectSignals.hasPythonTests,
        hasPythonBuild: projectSignals.hasPythonBuild,
        hasPythonLint: projectSignals.hasPythonLint,
        workflowHasBuildSignal,
        workflowHasTestSignal,
      },
      findings: findings.slice(0, 5),
    };
  } catch (err) {
    return {
      score: 50,
      details: {
        source: 'build_ci_signals',
        reason: 'scan_error',
        error: err && err.message ? err.message : String(err),
      },
      findings: [],
    };
  }
}

module.exports = { score };
