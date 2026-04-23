'use strict';

const fs = require('fs');
const path = require('path');

function defaultToRepoPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

function defaultUniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function createDefaultUniquePaths(toRepoPath) {
  return function uniquePaths(values) {
    const seen = new Set();
    const output = [];
    for (const value of Array.isArray(values) ? values : []) {
      const normalized = toRepoPath(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      output.push(normalized);
    }
    return output;
  };
}

function createTestsIndex(deps = {}) {
  const toRepoPath = typeof deps.toRepoPath === 'function' ? deps.toRepoPath : defaultToRepoPath;
  const uniqueStrings = typeof deps.uniqueStrings === 'function' ? deps.uniqueStrings : defaultUniqueStrings;
  const uniquePaths = typeof deps.uniquePaths === 'function' ? deps.uniquePaths : createDefaultUniquePaths(toRepoPath);
  const getSubsystemForFile = typeof deps.getSubsystemForFile === 'function'
    ? deps.getSubsystemForFile
    : (() => ({ id: 'unknown', label: 'unknown' }));
  const getSubsystemPriority = typeof deps.getSubsystemPriority === 'function' ? deps.getSubsystemPriority : (() => 30);
  const TEST_FILE_PATTERN = deps.TEST_FILE_PATTERN instanceof RegExp
    ? deps.TEST_FILE_PATTERN
    : /(?:^|\/)(?:tests?|__tests__)\/|(?:\.test|\.spec|\.e2e|\.integration)\.[^.]+$/i;
  const TEST_SUFFIX_PATTERN = deps.TEST_SUFFIX_PATTERN instanceof RegExp
    ? deps.TEST_SUFFIX_PATTERN
    : /(?:\.test|\.spec|\.e2e|\.integration)$/i;
  const TOKEN_STOP_WORDS = deps.TOKEN_STOP_WORDS instanceof Set
    ? deps.TOKEN_STOP_WORDS
    : new Set(['js', 'ts', 'jsx', 'tsx', 'index', 'main', 'test', 'tests', 'spec', 'e2e', 'integration', 'server', 'src', 'lib', 'app']);
  const TEST_MATRIX_LIMIT = Number.isInteger(deps.TEST_MATRIX_LIMIT) && deps.TEST_MATRIX_LIMIT > 0 ? deps.TEST_MATRIX_LIMIT : 6;

  function isTestFile(repoPath) {
    return TEST_FILE_PATTERN.test(toRepoPath(repoPath));
  }

  function toPathTokens(value) {
    return uniqueStrings(
      String(value || '')
        .toLowerCase()
        .split(/[\\/._-]+/)
        .map(token => token.trim())
        .filter(token => token && token.length > 1 && !TOKEN_STOP_WORDS.has(token))
    );
  }

  function toFileStem(repoPath) {
    const normalized = toRepoPath(repoPath);
    const base = path.basename(normalized, path.extname(normalized));
    return base.replace(TEST_SUFFIX_PATTERN, '').toLowerCase();
  }

  function intersectCount(left, right) {
    const leftSet = new Set(left || []);
    let count = 0;
    for (const item of right || []) {
      if (leftSet.has(item)) count += 1;
    }
    return count;
  }

  function scoreFileAffinity(leftFile, rightFile) {
    const leftStem = toFileStem(leftFile);
    const rightStem = toFileStem(rightFile);
    const leftTokens = toPathTokens(leftFile);
    const rightTokens = toPathTokens(rightFile);
    let score = intersectCount(leftTokens, rightTokens);
    if (leftStem && rightStem && leftStem === rightStem) score += 8;
    const leftDir = path.basename(path.dirname(toRepoPath(leftFile)));
    const rightDir = path.basename(path.dirname(toRepoPath(rightFile)));
    if (leftDir && rightDir && leftDir === rightDir) score += 2;
    return score;
  }

  function buildFlowTestCandidates(flow, testInventory) {
    return (testInventory?.tests || [])
      .map((testCase) => {
        const directMatches = (testCase.target_files || []).filter(file => (flow.files || []).includes(file)).length;
        const flowTokens = toPathTokens([flow.id, flow.label, ...(flow.files || [])].join(' '));
        const lexicalOverlap = intersectCount(flowTokens, toPathTokens(testCase.file));
        return {
          file: testCase.file,
          score: (directMatches * 10) + lexicalOverlap,
        };
      })
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
      .map(item => item.file);
  }

  function buildTestInventory(entries, trackedFiles, subsystemLookup, flows, activeProfile, workingDirectory) {
    const moduleEntries = new Map((entries || []).map(entry => [entry.file, entry]));
    const moduleFiles = new Set((entries || []).map(entry => entry.file));
    const testFiles = uniquePaths(trackedFiles).filter(isTestFile);
    const productionFiles = uniquePaths(trackedFiles).filter(file => !isTestFile(file));
    const tests = testFiles.map((testFile) => {
      const entry = moduleEntries.get(testFile);
      const directTargets = uniquePaths((entry?.deps || []).filter(dep => moduleFiles.has(dep) && !isTestFile(dep)));
      const fallbackTargets = directTargets.length > 0
        ? []
        : productionFiles
          .map((candidate) => ({ file: candidate, score: scoreFileAffinity(testFile, candidate) }))
          .filter(candidate => candidate.score >= 6)
          .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
          .slice(0, 4)
          .map(candidate => candidate.file);
      const targetFiles = uniquePaths([...directTargets, ...fallbackTargets]);
      const subsystems = uniqueStrings(targetFiles.map(file => (subsystemLookup.get(file) || getSubsystemForFile(file, activeProfile)).id));
      const relatedFlows = uniqueStrings((flows || [])
        .filter(flow => targetFiles.some(file => (flow.files || []).includes(file)))
        .map(flow => flow.id));
      return {
        file: testFile,
        target_files: targetFiles,
        subsystem_ids: subsystems,
        flow_ids: relatedFlows,
        matching_strategy: directTargets.length > 0 ? 'imports' : (fallbackTargets.length > 0 ? 'name-affinity' : 'unmapped'),
      };
    });

    const subsystemCoverage = Array.from(new Set(tests.flatMap(testCase => testCase.subsystem_ids || [])))
      .map((subsystemId) => {
        const subsystem = subsystemLookup.get(
          productionFiles.find(file => (subsystemLookup.get(file) || getSubsystemForFile(file, activeProfile)).id === subsystemId)
        ) || { id: subsystemId, label: subsystemId };
        const relatedTests = tests
          .filter(testCase => (testCase.subsystem_ids || []).includes(subsystemId))
          .map(testCase => testCase.file)
          .slice(0, 5);
        return {
          scope_type: 'subsystem',
          scope_id: subsystemId,
          label: subsystem.label,
          tests: relatedTests,
          rationale: 'Tests import or name-match files inside this subsystem.',
          sort_score: (getSubsystemPriority(activeProfile, subsystemId) * 10) + relatedTests.length,
        };
      });

    const flowCoverage = (flows || [])
      .map((flow) => {
        const flowTests = uniquePaths(buildFlowTestCandidates(flow, { tests })).slice(0, 5);
        return {
          scope_type: 'flow',
          scope_id: flow.id,
          label: flow.label,
          tests: flowTests,
          rationale: 'Tests touch files that participate in this canonical flow.',
          sort_score: 1000 + flowTests.length,
        };
      })
      .filter(item => item.tests.length > 0);

    const validationCoverage = [];
    if (tests.length === 0) {
      const validationCatalog = getValidationScriptCatalog(workingDirectory);
      const commands = [];
      if (validationCatalog.rootScripts.build) commands.push('npm run build');
      if (validationCatalog.rootScripts.test) commands.push('npm test');
      if (validationCatalog.rootScripts.lint) commands.push('npm run lint');
      if (commands.length > 0) {
        validationCoverage.push({
          scope_type: 'validation',
          scope_id: 'repo-validation-surface',
          label: 'Build and validation surface',
          tests: uniqueStrings(commands).slice(0, 4),
          rationale: 'No representative test files were found, so the pack points to the repo-level validation commands instead.',
          sort_score: 900,
        });
      }
    }

    return {
      tests,
      coverage: [...flowCoverage, ...subsystemCoverage, ...validationCoverage]
        .sort((left, right) => (right.sort_score || 0) - (left.sort_score || 0) || left.label.localeCompare(right.label))
        .slice(0, TEST_MATRIX_LIMIT)
        .map(({ sort_score: _sortScore, ...rest }) => ({
          ...rest,
          confidence: rest.scope_type === 'validation' ? 'medium' : 'high',
          evidence_quality: rest.scope_type === 'validation' ? 'script-derived' : 'test-derived',
        })),
    };
  }

  function findTestsForFiles(files, testInventory, limit = 4) {
    const targetSet = new Set(uniquePaths(files));
    if (targetSet.size === 0) return [];
    return (testInventory?.tests || [])
      .map((testCase) => {
        const directMatches = (testCase.target_files || []).filter(file => targetSet.has(file)).length;
        const lexicalOverlap = Math.max(...Array.from(targetSet).map(file => scoreFileAffinity(testCase.file, file)), 0);
        return {
          file: testCase.file,
          score: (directMatches * 10) + lexicalOverlap,
        };
      })
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
      .slice(0, limit)
      .map(item => item.file);
  }

  function readJsonFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function getValidationScriptCatalog(workingDirectory) {
    const rootPackage = readJsonFile(path.join(workingDirectory, 'package.json'));
    const dashboardPackage = readJsonFile(path.join(workingDirectory, 'dashboard', 'package.json'));
    const rootEntries = fs.existsSync(workingDirectory)
      ? fs.readdirSync(workingDirectory, { withFileTypes: true })
      : [];
    const solutionFiles = rootEntries
      .filter((entry) => entry && typeof entry.name === 'string' && entry.isFile && entry.isFile() && entry.name.toLowerCase().endsWith('.sln'))
      .map((entry) => toRepoPath(entry.name));
    const pyprojectPath = path.join(workingDirectory, 'pyproject.toml');
    const pyprojectRaw = fs.existsSync(pyprojectPath) ? fs.readFileSync(pyprojectPath, 'utf8') : '';
    const rootScripts = rootPackage?.scripts && typeof rootPackage.scripts === 'object' ? rootPackage.scripts : {};
    const dashboardScripts = dashboardPackage?.scripts && typeof dashboardPackage.scripts === 'object' ? dashboardPackage.scripts : {};
    const dependencyBag = {
      ...(rootPackage?.dependencies || {}),
      ...(rootPackage?.devDependencies || {}),
      ...(rootPackage?.peerDependencies || {}),
    };
    const testScript = typeof rootScripts.test === 'string' ? rootScripts.test : '';

    return {
      rootScripts,
      dashboardScripts,
      solutionFiles,
      hasDotnet: solutionFiles.length > 0 || fs.existsSync(path.join(workingDirectory, 'global.json')),
      hasPytest: /\bpytest\b/i.test(pyprojectRaw) || fs.existsSync(path.join(workingDirectory, 'pytest.ini')),
      hasPythonProject: Boolean(pyprojectRaw) || fs.existsSync(path.join(workingDirectory, 'requirements.txt')) || fs.existsSync(path.join(workingDirectory, 'setup.py')),
      hasPowerShellBuild: fs.existsSync(path.join(workingDirectory, 'scripts', 'build.ps1')),
      hasVitest: Boolean(dependencyBag.vitest) || /\bvitest\b/i.test(testScript),
      hasJest: Boolean(dependencyBag.jest) || /\bjest\b/i.test(testScript),
      hasNodeTest: /\bnode\b[^\n]*\s--test\b/i.test(testScript),
    };
  }

  function buildValidationCommands({ workingDirectory, relatedTests, relatedFiles, activeProfile, scopeId }) {
    const commands = [];
    const validationCatalog = getValidationScriptCatalog(workingDirectory);
    const profileCommands = activeProfile?.validation_commands?.[scopeId];
    if (Array.isArray(profileCommands)) commands.push(...profileCommands);

    const uniqueRelatedTests = uniquePaths(relatedTests);
    const serverTests = uniqueRelatedTests.filter(file => file.startsWith('server/tests/')).slice(0, 5);
    const dashboardTests = uniqueRelatedTests
      .filter(file => file.startsWith('dashboard/'))
      .map(file => file.replace(/^dashboard\//, ''))
      .slice(0, 5);
    const repoTests = uniqueRelatedTests.filter(file => !file.startsWith('dashboard/')).slice(0, 5);
    const relatedRepoFiles = uniquePaths(relatedFiles);

    if (serverTests.length > 0) commands.push(`npx vitest run ${serverTests.join(' ')}`);

    if (repoTests.length > 0) {
      if (validationCatalog.hasVitest) {
        commands.push(`npx vitest run ${repoTests.join(' ')}`);
      } else if (validationCatalog.hasJest) {
        commands.push(`npx jest ${repoTests.join(' ')}`);
      } else if (validationCatalog.hasNodeTest) {
        commands.push(`node --test ${repoTests.join(' ')}`);
      } else if (validationCatalog.rootScripts.test) {
        commands.push('npm test');
      }
    }

    if (dashboardTests.length > 0 && validationCatalog.dashboardScripts.test) {
      commands.push(`cd dashboard && npm run test -- --run ${dashboardTests.join(' ')}`);
    }

    const relatedExtensions = new Set(relatedRepoFiles.map((filePath) => path.extname(filePath).toLowerCase()));
    if (validationCatalog.hasDotnet && (relatedExtensions.has('.cs') || uniqueRelatedTests.some((file) => file.toLowerCase().endsWith('.cs')))) {
      const solutionFile = validationCatalog.solutionFiles[0];
      commands.push(solutionFile ? `dotnet build ${solutionFile}` : 'dotnet build');
      commands.push(solutionFile ? `dotnet test ${solutionFile} --no-build` : 'dotnet test --no-build');
    }
    if (validationCatalog.hasPythonProject && (relatedExtensions.has('.py') || uniqueRelatedTests.some((file) => file.toLowerCase().endsWith('.py')))) {
      commands.push(validationCatalog.hasPytest ? 'pytest' : 'python -m pytest');
    }
    if (commands.length === 0 && validationCatalog.hasPowerShellBuild) {
      commands.push('pwsh scripts/build.ps1');
    }

    if (relatedRepoFiles.some(file => file.startsWith('dashboard/')) && validationCatalog.rootScripts['build:dashboard']) {
      commands.push('npm run build:dashboard');
    }
    if (relatedRepoFiles.some(file => !file.startsWith('dashboard/')) && validationCatalog.rootScripts.build) {
      commands.push('npm run build');
    }
    if (relatedRepoFiles.some(file => !file.startsWith('dashboard/')) && validationCatalog.rootScripts.lint) {
      commands.push('npm run lint');
    }
    if (commands.length === 0 && validationCatalog.rootScripts.test) {
      commands.push('npm test');
    }

    return uniqueStrings(commands).slice(0, 4);
  }

  return {
    buildTestInventory,
    buildFlowTestCandidates,
    findTestsForFiles,
    isTestFile,
    toPathTokens,
    toFileStem,
    intersectCount,
    scoreFileAffinity,
    readJsonFile,
    getValidationScriptCatalog,
    buildValidationCommands,
  };
}

module.exports = { createTestsIndex };
