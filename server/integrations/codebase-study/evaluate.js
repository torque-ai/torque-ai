'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const {
  STUDY_STATE_FILE,
  KNOWLEDGE_PACK_FILE,
  STUDY_DELTA_FILE,
  STUDY_EVALUATION_FILE,
  STUDY_BENCHMARK_FILE,
  DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL,
  DEFAULT_PROPOSAL_MIN_SCORE,
  normalizeStudyThresholdLevel,
  shouldSubmitStudyProposals,
  filterDuplicateStudyProposals,
  readStudyArtifacts,
  evaluateStudyArtifacts,
  benchmarkStudyArtifacts,
} = require('../codebase-study-engine');

const fsPromises = fs.promises;

const TEST_SUFFIX_PATTERN = /(?:\.test|\.spec|\.e2e|\.integration)$/i;
const TOKEN_STOP_WORDS = new Set(['js', 'ts', 'jsx', 'tsx', 'index', 'main', 'test', 'tests', 'spec', 'e2e', 'integration', 'server', 'src', 'lib', 'app']);
const LOCAL_ONLY_STRATEGY = 'local-deterministic';
const SIGNIFICANCE_REASON_LIMIT = 4;
const DEFAULT_PROPOSAL_LIMIT = 2;
const MAX_PROPOSAL_LIMIT = 5;
const STUDY_PROPOSAL_RULE_NAME = 'Study proposal review';
const STUDY_PROPOSAL_RULE_TYPE = 'all';
const STUDY_BENCHMARK_FILE_LOCAL = STUDY_BENCHMARK_FILE;

function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function createEvaluator(deps = {}) {
  const { db: _db, taskCore, logger } = deps;
  const studyLogger = logger || createNoopLogger();

  function resolveWorkingDirectory(workingDirectory) {
    if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) {
      throw new Error('workingDirectory must be a non-empty string');
    }

    const resolved = path.resolve(workingDirectory.trim());
    if (!fs.existsSync(resolved)) {
      throw new Error(`Working directory not found: ${resolved}`);
    }

    return resolved;
  }

  function toRepoPath(filePath) {
    return String(filePath || '').trim().replace(/\\/g, '/');
  }

  function uniqueStrings(values) {
    const seen = new Set();
    const output = [];
    for (const value of Array.isArray(values) ? values : []) {
      const normalized = String(value || '').trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      output.push(normalized);
    }
    return output;
  }

  function uniquePaths(values) {
    const seen = new Set();
    const output = [];
    for (const value of Array.isArray(values) ? values : []) {
      const normalized = toRepoPath(value);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      output.push(normalized);
    }
    return output;
  }

  function normalizeNonNegativeInteger(value, fallback = 0) {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  function normalizePositiveInteger(value, fallback = 1, maxValue = Number.MAX_SAFE_INTEGER) {
    if (!Number.isInteger(value) || value <= 0) {
      return fallback;
    }
    return Math.min(value, maxValue);
  }

  function getPaths(workingDirectory) {
    return {
      statePath: path.join(workingDirectory, STUDY_STATE_FILE),
      knowledgePackPath: path.join(workingDirectory, KNOWLEDGE_PACK_FILE),
      deltaPath: path.join(workingDirectory, STUDY_DELTA_FILE),
      evaluationPath: path.join(workingDirectory, STUDY_EVALUATION_FILE),
      benchmarkPath: path.join(workingDirectory, STUDY_BENCHMARK_FILE_LOCAL),
    };
  }

  function buildInitialState() {
    return {
      run_count: 0,
      last_sha: null,
      last_task_id: null,
      last_batch: [],
      last_run_at: null,
      last_completed_at: null,
      last_result: null,
      last_error: null,
      tracked_files: [],
      pending_files: [],
      file_counts: {
        tracked: 0,
        pending: 0,
        up_to_date: 0,
      },
      index_strategy: LOCAL_ONLY_STRATEGY,
      summary_strategy: LOCAL_ONLY_STRATEGY,
      last_processed_count: 0,
      last_removed_count: 0,
      last_summary_updated_at: null,
      knowledge_pack_updated_at: null,
      last_delta_updated_at: null,
      module_entry_count: 0,
      subsystem_count: 0,
      flow_count: 0,
      hotspot_count: 0,
      invariant_count: 0,
      failure_mode_count: 0,
      trace_count: 0,
      playbook_count: 0,
      test_area_count: 0,
      delta_significance_level: 'none',
      delta_significance_score: 0,
      proposal_count: 0,
      submitted_proposal_count: 0,
      proposal_significance_level: DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL,
      proposal_min_score: DEFAULT_PROPOSAL_MIN_SCORE,
      evaluation_score: 0,
      evaluation_grade: null,
      evaluation_readiness: null,
      evaluation_findings_count: 0,
      evaluation_generated_at: null,
      benchmark_score: 0,
      benchmark_grade: null,
      benchmark_readiness: null,
      benchmark_findings_count: 0,
      benchmark_case_count: 0,
      benchmark_generated_at: null,
    };
  }

  function buildCounts(trackedFiles, pendingFiles) {
    return {
      tracked: trackedFiles.length,
      pending: pendingFiles.length,
      up_to_date: Math.max(0, trackedFiles.length - pendingFiles.length),
    };
  }

  function normalizeState(rawState) {
    const initial = buildInitialState();
    const source = rawState && typeof rawState === 'object' && !Array.isArray(rawState)
      ? rawState
      : {};
    const trackedFiles = uniquePaths(source.tracked_files);
    const pendingFiles = uniquePaths(source.pending_files).filter(file => trackedFiles.includes(file));
    const fileCounts = buildCounts(trackedFiles, pendingFiles);

    return {
      ...initial,
      ...source,
      last_sha: typeof source.last_sha === 'string' && source.last_sha.trim() ? source.last_sha.trim() : null,
      last_task_id: typeof source.last_task_id === 'string' && source.last_task_id.trim() ? source.last_task_id.trim() : null,
      last_batch: uniquePaths(source.last_batch),
      tracked_files: trackedFiles,
      pending_files: pendingFiles,
      file_counts: fileCounts,
      index_strategy: typeof source.index_strategy === 'string' && source.index_strategy.trim()
        ? source.index_strategy.trim()
        : LOCAL_ONLY_STRATEGY,
      summary_strategy: typeof source.summary_strategy === 'string' && source.summary_strategy.trim()
        ? source.summary_strategy.trim()
        : LOCAL_ONLY_STRATEGY,
      last_processed_count: normalizeNonNegativeInteger(source.last_processed_count),
      last_removed_count: normalizeNonNegativeInteger(source.last_removed_count),
      last_summary_updated_at: typeof source.last_summary_updated_at === 'string' && source.last_summary_updated_at.trim()
        ? source.last_summary_updated_at.trim()
        : null,
      knowledge_pack_updated_at: typeof source.knowledge_pack_updated_at === 'string' && source.knowledge_pack_updated_at.trim()
        ? source.knowledge_pack_updated_at.trim()
        : null,
      last_delta_updated_at: typeof source.last_delta_updated_at === 'string' && source.last_delta_updated_at.trim()
        ? source.last_delta_updated_at.trim()
        : null,
      module_entry_count: normalizeNonNegativeInteger(source.module_entry_count),
      subsystem_count: normalizeNonNegativeInteger(source.subsystem_count),
      flow_count: normalizeNonNegativeInteger(source.flow_count),
      hotspot_count: normalizeNonNegativeInteger(source.hotspot_count),
      invariant_count: normalizeNonNegativeInteger(source.invariant_count),
      failure_mode_count: normalizeNonNegativeInteger(source.failure_mode_count),
      trace_count: normalizeNonNegativeInteger(source.trace_count),
      playbook_count: normalizeNonNegativeInteger(source.playbook_count),
      test_area_count: normalizeNonNegativeInteger(source.test_area_count),
      delta_significance_level: typeof source.delta_significance_level === 'string' && source.delta_significance_level.trim()
        ? source.delta_significance_level.trim()
        : 'none',
      delta_significance_score: normalizeNonNegativeInteger(source.delta_significance_score),
      proposal_count: normalizeNonNegativeInteger(source.proposal_count),
      submitted_proposal_count: normalizeNonNegativeInteger(source.submitted_proposal_count),
      proposal_significance_level: normalizeStudyThresholdLevel(
        source.proposal_significance_level,
        DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL
      ),
      proposal_min_score: normalizeNonNegativeInteger(source.proposal_min_score, DEFAULT_PROPOSAL_MIN_SCORE),
      evaluation_score: normalizeNonNegativeInteger(source.evaluation_score),
      evaluation_grade: typeof source.evaluation_grade === 'string' && source.evaluation_grade.trim()
        ? source.evaluation_grade.trim()
        : null,
      evaluation_readiness: typeof source.evaluation_readiness === 'string' && source.evaluation_readiness.trim()
        ? source.evaluation_readiness.trim()
        : null,
      evaluation_findings_count: normalizeNonNegativeInteger(source.evaluation_findings_count),
      evaluation_generated_at: typeof source.evaluation_generated_at === 'string' && source.evaluation_generated_at.trim()
        ? source.evaluation_generated_at.trim()
        : null,
      benchmark_score: normalizeNonNegativeInteger(source.benchmark_score),
      benchmark_grade: typeof source.benchmark_grade === 'string' && source.benchmark_grade.trim()
        ? source.benchmark_grade.trim()
        : null,
      benchmark_readiness: typeof source.benchmark_readiness === 'string' && source.benchmark_readiness.trim()
        ? source.benchmark_readiness.trim()
        : null,
      benchmark_findings_count: normalizeNonNegativeInteger(source.benchmark_findings_count),
      benchmark_case_count: normalizeNonNegativeInteger(source.benchmark_case_count),
      benchmark_generated_at: typeof source.benchmark_generated_at === 'string' && source.benchmark_generated_at.trim()
        ? source.benchmark_generated_at.trim()
        : null,
    };
  }

  function normalizeModuleEntry(rawEntry) {
    const entry = rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry)
      ? rawEntry
      : {};
    const file = toRepoPath(entry.file);
    if (!file) {
      return null;
    }
    return {
      file,
      purpose: typeof entry.purpose === 'string' ? entry.purpose.trim() : '',
      exports: uniqueStrings(entry.exports),
      deps: uniqueStrings(entry.deps),
    };
  }

  function normalizeModuleIndex(rawIndex) {
    const source = rawIndex && typeof rawIndex === 'object' && !Array.isArray(rawIndex)
      ? rawIndex
      : {};
    const modules = [];
    const seen = new Set();
    for (const rawEntry of Array.isArray(source.modules) ? source.modules : []) {
      const entry = normalizeModuleEntry(rawEntry);
      if (!entry || seen.has(entry.file)) {
        continue;
      }
      seen.add(entry.file);
      modules.push(entry);
    }
    modules.sort((left, right) => left.file.localeCompare(right.file));
    return {
      modules,
      last_updated: typeof source.last_updated === 'string' && source.last_updated.trim()
        ? source.last_updated.trim()
        : null,
    };
  }

  async function ensureParentDirectory(filePath) {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  }

  async function writeJsonFile(filePath, value) {
    await ensureParentDirectory(filePath);
    await fsPromises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  async function writeStudyEvaluation(workingDirectory, studyEvaluation) {
    const paths = getPaths(workingDirectory);
    await writeJsonFile(paths.evaluationPath, studyEvaluation);
    return { paths, studyEvaluation };
  }

  async function writeStudyBenchmark(workingDirectory, studyBenchmark) {
    const paths = getPaths(workingDirectory);
    await writeJsonFile(paths.benchmarkPath, studyBenchmark);
    return { paths, studyBenchmark };
  }

  async function writeStudyState(workingDirectory, state) {
    const paths = getPaths(workingDirectory);
    const normalized = normalizeState(state);
    await writeJsonFile(paths.statePath, normalized);
    return { paths, state: normalized };
  }

  function getSubsystemPriority(activeProfile, subsystemId) {
    return activeProfile?.subsystem_priority?.[subsystemId] || 30;
  }

  function scoreStudyDelta(delta, activeProfile) {
    if (delta?.run?.mode === 'baseline') {
      return {
        level: 'baseline',
        score: 10,
        reasons: ['Initial baseline generated for the repository.'],
      };
    }

    let score = 0;
    const reasons = [];
    const addReason = (points, message) => {
      score += points;
      reasons.push(message);
    };

    if ((delta?.changed_files?.repo_delta || []).length > 0) {
      addReason(Math.min(18, delta.changed_files.repo_delta.length * 3), `${delta.changed_files.repo_delta.length} repo files changed since the previous study SHA.`);
    }
    if ((delta?.affected_flows || []).length > 0) {
      addReason(Math.min(18, delta.affected_flows.length * 7), `${delta.affected_flows.length} canonical flows were touched by the change set.`);
    }
    if ((delta?.invariant_hits || []).length > 0) {
      addReason(Math.min(16, delta.invariant_hits.length * 6), `${delta.invariant_hits.length} critical invariants were touched.`);
    }
    if ((delta?.failure_mode_hits || []).length > 0) {
      addReason(Math.min(16, delta.failure_mode_hits.length * 6), `${delta.failure_mode_hits.length} known failure modes intersect the changed seams.`);
    }
    const hotspotPressure = (delta?.hotspot_changes?.entered?.length || 0) + (delta?.hotspot_changes?.touched?.length || 0);
    if (hotspotPressure > 0) {
      addReason(Math.min(14, hotspotPressure * 5), `${hotspotPressure} hotspot files moved or were directly touched.`);
    }
    const highPrioritySubsystems = (delta?.changed_subsystems || []).filter(item => getSubsystemPriority(activeProfile, item.id) >= 85);
    if (highPrioritySubsystems.length > 0) {
      addReason(Math.min(14, highPrioritySubsystems.length * 5), `${highPrioritySubsystems.length} high-priority subsystems changed.`);
    }
    if ((delta?.changed_files?.processed || []).length > 0 && (delta?.changed_files?.repo_delta || []).length === 0) {
      addReason(Math.min(8, Math.ceil(delta.changed_files.processed.length / 25)), 'The study advanced coverage without any new repository delta.');
    }

    const level = score >= 55
      ? 'critical'
      : score >= 35
        ? 'high'
        : score >= 18
          ? 'medium'
          : score > 0
            ? 'low'
            : 'none';

    return {
      level,
      score,
      reasons: reasons.slice(0, SIGNIFICANCE_REASON_LIMIT),
    };
  }

  function createProposalRecord(key, proposal) {
    return {
      key,
      title: proposal.title,
      rationale: proposal.rationale,
      task: proposal.task,
      tags: uniqueStrings(proposal.tags),
      files: uniquePaths(proposal.files),
      related_tests: uniquePaths(proposal.related_tests),
      validation_commands: uniqueStrings(proposal.validation_commands),
      affected_invariants: uniqueStrings(proposal.affected_invariants),
      priority: Number.isInteger(proposal.priority) ? proposal.priority : 50,
      kind: proposal.kind || 'study-followup',
      trace: proposal.trace && typeof proposal.trace === 'object'
        ? { ...proposal.trace }
        : null,
    };
  }

  function buildStudyProposalTrace(studyDelta, focus = {}) {
    const significance = studyDelta?.significance || {};
    const run = studyDelta?.run || {};

    return {
      study_delta_path: STUDY_DELTA_FILE.replace(/\\/g, '/'),
      study_delta_generated_at: studyDelta?.generated_at || null,
      delta_significance_level: significance.level || 'none',
      delta_significance_score: significance.score || 0,
      significance_reasons: uniqueStrings(significance.reasons || []),
      run_mode: run.mode || null,
      manual_run_now: run.manual_run_now === true,
      schedule_id: run.schedule_id || null,
      schedule_name: run.schedule_name || null,
      schedule_run_id: run.schedule_run_id || null,
      wrapper_task_id: run.wrapper_task_id || null,
      changed_subsystems: uniqueStrings((studyDelta?.changed_subsystems || []).map((item) => item.label || item.id)),
      affected_flows: uniqueStrings((studyDelta?.affected_flows || []).map((item) => item.label || item.id)),
      focus_scope_id: focus.scope_id || null,
      focus_label: focus.label || null,
    };
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
      if (leftSet.has(item)) {
        count += 1;
      }
    }
    return count;
  }

  function scoreFileAffinity(leftFile, rightFile) {
    const leftStem = toFileStem(leftFile);
    const rightStem = toFileStem(rightFile);
    const leftTokens = toPathTokens(leftFile);
    const rightTokens = toPathTokens(rightFile);
    let score = intersectCount(leftTokens, rightTokens);
    if (leftStem && rightStem && leftStem === rightStem) {
      score += 8;
    }
    const leftDir = path.basename(path.dirname(toRepoPath(leftFile)));
    const rightDir = path.basename(path.dirname(toRepoPath(rightFile)));
    if (leftDir && rightDir && leftDir === rightDir) {
      score += 2;
    }
    return score;
  }

  function findTestsForFiles(files, testInventory, limit = 4) {
    const targetSet = new Set(uniquePaths(files));
    if (targetSet.size === 0) {
      return [];
    }
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
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) {
        return null;
      }
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
    const pyprojectRaw = fs.existsSync(pyprojectPath)
      ? fs.readFileSync(pyprojectPath, 'utf8')
      : '';
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
    if (Array.isArray(profileCommands)) {
      commands.push(...profileCommands);
    }

    const uniqueRelatedTests = uniquePaths(relatedTests);
    const serverTests = uniqueRelatedTests.filter(file => file.startsWith('server/tests/')).slice(0, 5);
    const dashboardTests = uniqueRelatedTests
      .filter(file => file.startsWith('dashboard/'))
      .map(file => file.replace(/^dashboard\//, ''))
      .slice(0, 5);
    const repoTests = uniqueRelatedTests.filter(file => !file.startsWith('dashboard/')).slice(0, 5);
    const relatedRepoFiles = uniquePaths(relatedFiles);

    if (serverTests.length > 0) {
      commands.push(`npx vitest run ${serverTests.join(' ')}`);
    }

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
      if (validationCatalog.hasPytest) {
        commands.push('pytest');
      } else {
        commands.push('python -m pytest');
      }
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

  function buildStudyProposals(studyDelta, knowledgePack, workingDirectory) {
    if (!studyDelta || studyDelta.significance?.level === 'none' || studyDelta.run?.mode === 'baseline') {
      return [];
    }

    const proposals = [];
    const seen = new Set();
    const impactGuidance = Array.isArray(knowledgePack?.expertise?.impact_guidance)
      ? knowledgePack.expertise.impact_guidance
      : [];
    const impactByScopeId = new Map(impactGuidance.map((item) => [item.scope_id, item]));
    const addProposal = (key, proposal) => {
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      proposals.push(createProposalRecord(key, proposal));
    };
    const priorityBase = studyDelta.significance.level === 'critical'
      ? 80
      : studyDelta.significance.level === 'high'
        ? 70
        : studyDelta.significance.level === 'moderate'
          ? 60
          : 45;

    for (const hit of (studyDelta.invariant_hits || []).slice(0, 2)) {
      const impact = impactByScopeId.get(hit.scope_id);
      const trace = buildStudyProposalTrace(studyDelta, {
        scope_id: hit.scope_id,
        label: hit.label,
      });
      addProposal(`invariant:${hit.scope_id}`, {
        title: `Review ${hit.label} changes for invariant drift`,
        rationale: `Changed files intersect a critical invariant for ${hit.label}.`,
        task: [
          `Review recent changes in ${workingDirectory} that touched the ${hit.label} seam.`,
          `Focus on this invariant: ${hit.statement}`,
          `Changed files: ${hit.matched_files.join(', ') || 'n/a'}.`,
          `Inspect first: ${hit.evidence_files.join(', ') || 'n/a'}.`,
          `Relevant tests: ${(hit.related_tests || []).join(', ') || 'none identified'}.`,
          `Validation commands: ${(impact?.validation_commands || []).join(' ; ') || 'none suggested'}.`,
          'Return findings in APPROVE/FLAG style and call out any missing validation or architectural drift.',
        ].join('\n'),
        tags: ['study-delta', 'study-followup', 'invariant-review'],
        files: [...(hit.matched_files || []), ...(hit.evidence_files || [])],
        related_tests: [...(hit.related_tests || []), ...(impact?.related_tests || [])],
        validation_commands: impact?.validation_commands || [],
        affected_invariants: [hit.statement],
        priority: priorityBase,
        kind: 'invariant-review',
        trace,
      });
    }

    for (const hit of (studyDelta.failure_mode_hits || []).slice(0, 1)) {
      const impact = impactByScopeId.get(hit.scope_id);
      const trace = buildStudyProposalTrace(studyDelta, {
        scope_id: hit.scope_id,
        label: hit.label,
      });
      addProposal(`failure:${hit.scope_id}`, {
        title: `Validate ${hit.label} risk after recent changes`,
        rationale: `The change set intersects a known failure mode: ${hit.label}.`,
        task: [
          `Investigate the ${hit.label} risk in ${workingDirectory}.`,
          `Symptoms to guard against: ${hit.symptoms}`,
          `Changed files: ${hit.matched_files.join(', ') || 'n/a'}.`,
          `Investigate first: ${(hit.investigate_first || []).join(', ') || 'n/a'}.`,
          `Relevant tests: ${(hit.related_tests || []).join(', ') || 'none identified'}.`,
          `Validation commands: ${(impact?.validation_commands || []).join(' ; ') || 'none suggested'}.`,
          'Decide whether the current changes need follow-up fixes, stronger tests, or no action.',
        ].join('\n'),
        tags: ['study-delta', 'study-followup', 'failure-mode-review'],
        files: [...(hit.matched_files || []), ...(hit.investigate_first || [])],
        related_tests: [...(hit.related_tests || []), ...(impact?.related_tests || [])],
        validation_commands: impact?.validation_commands || [],
        affected_invariants: (impact?.invariants_to_recheck || []).map(item => item.statement),
        priority: priorityBase - 5,
        kind: 'failure-mode-review',
        trace,
      });
    }

    const hotspotFiles = uniquePaths([
      ...((studyDelta.hotspot_changes?.entered || []).map(item => item.file)),
      ...((studyDelta.hotspot_changes?.touched || []).map(item => item.file)),
    ]);
    if (hotspotFiles.length > 0) {
      const trace = buildStudyProposalTrace(studyDelta, {
        scope_id: 'hotspot-audit',
        label: path.basename(hotspotFiles[0]),
      });
      addProposal(`hotspot:${hotspotFiles[0]}`, {
        title: `Audit hotspot coupling around ${path.basename(hotspotFiles[0])}`,
        rationale: 'A hotspot file entered or was touched by the latest repo delta.',
        task: [
          `Audit the coupling and blast radius around these hotspot files in ${workingDirectory}:`,
          hotspotFiles.join(', '),
          `Use the current knowledge pack at ${KNOWLEDGE_PACK_FILE.replace(/\\/g, '/')} and the study delta at ${STUDY_DELTA_FILE.replace(/\\/g, '/')} for context.`,
          'Identify whether the change increased architectural risk, hidden dependencies, or missing regression coverage.',
        ].join('\n'),
        tags: ['study-delta', 'study-followup', 'hotspot-audit'],
        files: hotspotFiles,
        related_tests: findTestsForFiles(hotspotFiles, { tests: knowledgePack?.expertise?.test_matrix ? [] : [] }),
        validation_commands: buildValidationCommands({
          workingDirectory,
          relatedTests: findTestsForFiles(hotspotFiles, { tests: [] }),
          relatedFiles: hotspotFiles,
          activeProfile: null,
          scopeId: 'hotspot-audit',
        }),
        priority: priorityBase - 10,
        kind: 'hotspot-audit',
        trace,
      });
    }

    const changedLabels = (studyDelta.changed_subsystems || []).slice(0, 3).map(item => item.label);
    if ((studyDelta.affected_flows || []).length >= 2 || changedLabels.length >= 2) {
      const trace = buildStudyProposalTrace(studyDelta, {
        scope_id: 'cross-subsystem-impact',
        label: 'Cross-subsystem impact',
      });
      addProposal('cross-subsystem-impact', {
        title: 'Validate cross-subsystem impact from recent architectural delta',
        rationale: 'The change set touched multiple core subsystems or flows.',
        task: [
          `Review the latest architectural delta in ${workingDirectory}.`,
          `Changed subsystems: ${changedLabels.join(', ') || 'n/a'}.`,
          `Affected flows: ${(studyDelta.affected_flows || []).map(item => item.label).join(', ') || 'n/a'}.`,
          `Use ${STUDY_DELTA_FILE.replace(/\\/g, '/')} and ${KNOWLEDGE_PACK_FILE.replace(/\\/g, '/')} to assess whether any follow-up work is needed.`,
          'Focus on cross-subsystem regressions, missing tests, and scheduler/provider workflow interactions.',
        ].join('\n'),
        tags: ['study-delta', 'study-followup', 'cross-subsystem-review'],
        files: uniquePaths((studyDelta.changed_files?.repo_delta || []).slice(0, 10)),
        related_tests: uniquePaths(
          (studyDelta.affected_flows || []).flatMap(item => impactByScopeId.get(item.id)?.related_tests || [])
        ),
        validation_commands: uniqueStrings(
          (studyDelta.affected_flows || []).flatMap(item => impactByScopeId.get(item.id)?.validation_commands || [])
        ),
        affected_invariants: uniqueStrings(
          (studyDelta.invariant_hits || []).map(item => item.statement)
        ),
        priority: priorityBase - 8,
        kind: 'cross-subsystem-review',
        trace,
      });
    }

    return proposals.slice(0, MAX_PROPOSAL_LIMIT);
  }

  function ensureStudyProposalApprovalRule(schedulingAutomation, projectName) {
    const existingRule = (schedulingAutomation.listApprovalRules?.({
      project: projectName,
      enabledOnly: false,
      limit: 200,
    }) || []).find((rule) => rule.name === STUDY_PROPOSAL_RULE_NAME);

    if (existingRule?.id) {
      return existingRule.id;
    }

    return schedulingAutomation.createApprovalRule(
      STUDY_PROPOSAL_RULE_NAME,
      STUDY_PROPOSAL_RULE_TYPE,
      {},
      {
        project: projectName,
        requiredApprovers: 1,
      }
    );
  }

  async function submitStudyProposals(proposals, workingDirectory, options = {}) {
    if (
      options.submitProposals !== true
      || !Array.isArray(proposals)
      || proposals.length === 0
      || !taskCore
      || typeof taskCore.createTask !== 'function'
    ) {
      return { submitted: [], errors: [] };
    }

    const proposalLimit = normalizePositiveInteger(options.proposalLimit, DEFAULT_PROPOSAL_LIMIT, MAX_PROPOSAL_LIMIT);
    const projectName = typeof options.project === 'string' && options.project.trim()
      ? options.project.trim()
      : path.basename(workingDirectory);
    const schedulingAutomation = require('../../db/scheduling-automation');
    const submitted = [];
    const errors = [];
    const approvalRuleId = ensureStudyProposalApprovalRule(schedulingAutomation, projectName);

    for (const proposal of proposals.slice(0, proposalLimit)) {
      try {
        const taskId = randomUUID();
        const studyProposalMetadata = {
          source: 'codebase-study',
          key: proposal.key,
          title: proposal.title,
          rationale: proposal.rationale,
          kind: proposal.kind,
          files: uniquePaths(proposal.files),
          related_tests: uniquePaths(proposal.related_tests),
          validation_commands: uniqueStrings(proposal.validation_commands),
          affected_invariants: uniqueStrings(proposal.affected_invariants),
          trace: proposal.trace && typeof proposal.trace === 'object'
            ? { ...proposal.trace }
            : null,
          created_at: new Date().toISOString(),
        };

        taskCore.createTask({
          id: taskId,
          status: 'pending',
          task_description: `[Study Proposal] ${proposal.title}\n\n${proposal.task}`,
          working_directory: workingDirectory,
          project: projectName,
          tags: uniqueStrings([...(proposal.tags || []), 'study-delta-proposal', 'pending-approval']),
          timeout_minutes: 30,
          auto_approve: false,
          priority: proposal.priority,
          approval_status: 'pending',
          metadata: {
            version_intent: 'internal',
            study_proposal: studyProposalMetadata,
          },
        });
        const approvalId = schedulingAutomation.createApprovalRequest(taskId, approvalRuleId);
        submitted.push({
          title: proposal.title,
          task_id: taskId,
          approval_id: approvalId,
        });
      } catch (error) {
        errors.push({
          title: proposal.title,
          error: error.message || String(error),
        });
      }
    }

    return { submitted, errors };
  }

  async function evaluateStudy(studyId, artifacts = {}) {
    const resolvedWorkingDirectory = resolveWorkingDirectory(artifacts.workingDirectory || studyId);
    const bundle = readStudyArtifacts(resolvedWorkingDirectory, {
      includeState: true,
      includeModuleIndex: true,
      includeKnowledgePack: true,
      includeDelta: true,
      includeEvaluation: true,
      includeBenchmark: true,
    });
    const state = normalizeState(artifacts.state || bundle.state || {});
    const moduleIndex = normalizeModuleIndex(artifacts.moduleIndex || bundle.moduleIndex || {});
    const knowledgePack = artifacts.knowledgePack || bundle.knowledgePack;
    const studyDeltaSource = artifacts.studyDelta || bundle.studyDelta || null;

    if (!knowledgePack?.generated_at) {
      throw new Error('Study artifacts are not ready yet. Run the codebase study before evaluating it.');
    }

    const studyDelta = studyDeltaSource && typeof studyDeltaSource === 'object'
      ? {
          ...studyDeltaSource,
          significance: studyDeltaSource.significance || scoreStudyDelta(studyDeltaSource, artifacts.activeProfile || null),
          proposals: {
            policy: studyDeltaSource.proposals?.policy || {},
            suggested: Array.isArray(studyDeltaSource.proposals?.suggested)
              ? studyDeltaSource.proposals.suggested.slice()
              : [],
            submitted: Array.isArray(studyDeltaSource.proposals?.submitted)
              ? studyDeltaSource.proposals.submitted.slice()
              : [],
            errors: Array.isArray(studyDeltaSource.proposals?.errors)
              ? studyDeltaSource.proposals.errors.slice()
              : [],
          },
        }
      : null;

    const suggestedProposals = studyDelta?.proposals?.suggested?.length
      ? studyDelta.proposals.suggested
      : buildStudyProposals(studyDelta, knowledgePack, resolvedWorkingDirectory);
    const projectName = typeof artifacts.project === 'string' && artifacts.project.trim()
      ? artifacts.project.trim()
      : path.basename(resolvedWorkingDirectory);
    const proposalGate = shouldSubmitStudyProposals(studyDelta, {
      submitProposals: artifacts.submitProposals === true,
      proposalSignificanceLevel: artifacts.proposalSignificanceLevel,
      proposalMinScore: artifacts.proposalMinScore,
    });
    const dedupedProposalSet = taskCore && typeof taskCore.listTasks === 'function'
      ? filterDuplicateStudyProposals(suggestedProposals, taskCore, { project: projectName })
      : { proposals: suggestedProposals, suppressed: [] };

    const proposalPolicy = {
      allowed: proposalGate.allowed,
      reason: proposalGate.reason || null,
      threshold_level: proposalGate.threshold_level || normalizeStudyThresholdLevel(artifacts.proposalSignificanceLevel),
      threshold_score: proposalGate.threshold_score ?? normalizeNonNegativeInteger(artifacts.proposalMinScore, DEFAULT_PROPOSAL_MIN_SCORE),
      suppressed_count: dedupedProposalSet.suppressed.length,
    };
    const proposalErrors = dedupedProposalSet.suppressed.length > 0
      ? dedupedProposalSet.suppressed.map((item) => ({
          title: item.title,
          error: proposalGate.allowed
            ? `Suppressed duplicate proposal (${item.reason})`
            : `Proposal gate closed (${proposalGate.reason})`,
          existing_task_id: item.existing_task_id || null,
        }))
      : [];
    const proposalSubmission = await submitStudyProposals(dedupedProposalSet.proposals, resolvedWorkingDirectory, {
      submitProposals: proposalGate.allowed,
      proposalLimit: normalizePositiveInteger(artifacts.proposalLimit, DEFAULT_PROPOSAL_LIMIT, MAX_PROPOSAL_LIMIT),
      project: projectName,
    });
    const proposals = {
      policy: proposalPolicy,
      suggested: dedupedProposalSet.proposals,
      submitted: proposalSubmission.submitted,
      errors: [...proposalErrors, ...proposalSubmission.errors],
    };

    if (studyDelta?.proposals) {
      studyDelta.proposals = proposals;
    }

    const studyEvaluation = evaluateStudyArtifacts({
      knowledgePack,
      studyDelta,
      state,
      moduleIndex,
      workingDirectory: resolvedWorkingDirectory,
    });
    const studyBenchmark = benchmarkStudyArtifacts({
      knowledgePack,
      studyDelta,
      studyEvaluation,
      moduleIndex,
      workingDirectory: resolvedWorkingDirectory,
    });

    await writeStudyEvaluation(resolvedWorkingDirectory, studyEvaluation);
    await writeStudyBenchmark(resolvedWorkingDirectory, studyBenchmark);

    const nextState = normalizeState({
      ...state,
      evaluation_score: studyEvaluation.summary.score,
      evaluation_grade: studyEvaluation.summary.grade,
      evaluation_readiness: studyEvaluation.summary.readiness,
      evaluation_findings_count: studyEvaluation.summary.findings_count,
      evaluation_generated_at: studyEvaluation.generated_at,
      benchmark_score: studyBenchmark.summary.score,
      benchmark_grade: studyBenchmark.summary.grade,
      benchmark_readiness: studyBenchmark.summary.readiness,
      benchmark_findings_count: studyBenchmark.findings.length,
      benchmark_case_count: studyBenchmark.summary.total_cases,
      benchmark_generated_at: studyBenchmark.generated_at,
      proposal_count: proposals.suggested.length,
      submitted_proposal_count: proposals.submitted.length,
      proposal_significance_level: proposalPolicy.threshold_level,
      proposal_min_score: proposalPolicy.threshold_score,
    });

    if (artifacts.persistState !== false) {
      await writeStudyState(resolvedWorkingDirectory, nextState);
    }

    studyLogger.debug?.('[codebase-study:evaluate] evaluated study artifacts', {
      workingDirectory: resolvedWorkingDirectory,
      evaluationScore: studyEvaluation.summary.score,
      benchmarkScore: studyBenchmark.summary.score,
      proposalCount: proposals.suggested.length,
    });

    return {
      scores: {
        evaluation: studyEvaluation.summary,
        benchmark: studyBenchmark.summary,
      },
      proposals,
    };
  }

  return { evaluateStudy };
}

module.exports = { createEvaluator };
