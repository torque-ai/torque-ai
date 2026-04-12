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
    let ciWorkflowCount = 0;
    if (isDirectory(workflowsDir)) {
      ciWorkflowCount = fs.readdirSync(workflowsDir)
        .filter((name) => /\.ya?ml$/i.test(name))
        .length;
    }

    const hasGitlabCi = fs.existsSync(path.join(projectPath, '.gitlab-ci.yml'));
    const hasJenkinsfile = fs.existsSync(path.join(projectPath, 'Jenkinsfile'));
    const hasCircleCi = isDirectory(path.join(projectPath, '.circleci'));
    const hasAzurePipelines = fs.existsSync(path.join(projectPath, 'azure-pipelines.yml'));
    const hasOtherCiTool = hasGitlabCi || hasJenkinsfile || hasCircleCi || hasAzurePipelines;

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

    const lintSearchDirs = [
      projectPath,
      path.join(projectPath, 'server'),
      path.join(projectPath, 'dashboard'),
    ];
    const hasLintConfig = lintSearchDirs.some((dirPath) =>
      LINT_CONFIG_FILES.some((fileName) => fs.existsSync(path.join(dirPath, fileName))),
    );

    const hasPreCommit =
      directoryHasFile(path.join(projectPath, '.husky')) ||
      fs.existsSync(path.join(projectPath, '.git', 'hooks', 'pre-commit'));

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
