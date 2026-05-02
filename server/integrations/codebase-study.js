'use strict';

const { STUDY_PROFILE_OVERRIDE_FILE, resolveStudyProfile, getStudyProfileOverridePath, readStudyProfileOverride, createStudyProfileOverrideTemplate, detectStudyProfileSignals } = require('./codebase-study-profiles');
const { STUDY_EVALUATION_FILE, STUDY_BENCHMARK_FILE, DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL, DEFAULT_PROPOSAL_MIN_SCORE, normalizeStudyThresholdLevel, evaluateStudyArtifacts, benchmarkStudyArtifacts, buildStudyBootstrapPlan } = require('./codebase-study-engine');
const symbolIndexer = require('../utils/symbol-indexer');
const { createScanner } = require('./codebase-study/scan');
const { createEvaluator } = require('./codebase-study/evaluate');
const { createProposer } = require('./codebase-study/proposal');
const { createParsers } = require('./codebase-study/parsers');
const { createProfileManager } = require('./codebase-study/profile');
const { createFlows } = require('./codebase-study/flows');
const { createHotspotsAnalyzer } = require('./codebase-study/hotspots');
const { createSummary } = require('./codebase-study/summary');
const { createSubsystems } = require('./codebase-study/subsystems');
const { createFlowDefinitions } = require('./codebase-study/flow-definitions');
const { createTestsIndex } = require('./codebase-study/tests-index');
const { createProfileSerializer } = require('./codebase-study/profile-serializer');
const { createExpertise } = require('./codebase-study/expertise');
const { createProposals } = require('./codebase-study/proposals');
const { createOrchestratorHelpers } = require('./codebase-study/orchestrator-helpers');
const { createArtifactFiles } = require('./codebase-study/artifact-files');
const {
  STUDY_DIR,
  STATE_FILE,
  MODULE_INDEX_FILE,
  KNOWLEDGE_PACK_FILE,
  STUDY_DELTA_FILE,
  STUDY_BENCHMARK_FILE_LOCAL,
  SUMMARY_FILE,
  SUMMARY_PLACEHOLDER,
  LOCAL_ONLY_STRATEGY,
  resolveWorkingDirectory,
  toRepoPath,
  uniqueStrings,
  uniquePaths,
  buildInitialState,
  normalizeState,
  normalizeModuleEntry,
  normalizeModuleIndex,
  readJsonIfPresent,
  readTextIfPresent,
  loadRepoMetadata,
  ensureStudyDocs,
  readStudyState,
  writeStudyState,
} = require('./codebase-study/state-docs');

const STUDY_OUTPUT_FILES = [MODULE_INDEX_FILE, KNOWLEDGE_PACK_FILE, STUDY_DELTA_FILE, STUDY_EVALUATION_FILE, STUDY_BENCHMARK_FILE_LOCAL, SUMMARY_FILE, STATE_FILE].map(filePath => filePath.replace(/\\/g, '/'));
const GENERATED_STUDY_FILES = new Set(['docs/architecture/module-index.json', 'docs/architecture/study-state.json', 'docs/architecture/knowledge-pack.json', 'docs/architecture/study-delta.json', 'docs/architecture/study-evaluation.json', 'docs/architecture/study-benchmark.json', 'docs/architecture/SUMMARY.md']);
const ALLOWED_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.json', '.py', '.cs']);
const JS_LIKE_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']);
const SYMBOL_INDEX_EXTENSIONS = new Set([...JS_LIKE_EXTENSIONS, '.py', '.cs']);
const DEFAULT_LOCAL_BATCH_SIZE = 100;
const DEFAULT_MANUAL_RUN_BATCH_COUNT = 5;
const MAX_RUN_BATCH_COUNT = 25;
const SUMMARY_SUBSYSTEM_LIMIT = 6;
const SUMMARY_FLOW_LIMIT = 5;
const HOTSPOT_LIMIT = 6;
const RELATIONSHIP_LIMIT = 8;
const NAVIGATION_HINT_LIMIT = 6;
const SUMMARY_INVARIANT_LIMIT = 5;
const SUMMARY_FAILURE_MODE_LIMIT = 5;
const SUMMARY_PLAYBOOK_LIMIT = 5;
const TRACE_LIMIT = 5;
const TEST_MATRIX_LIMIT = 6;
const SIGNIFICANCE_REASON_LIMIT = 4;
const KNOWLEDGE_PACK_VERSION = 3;
const STUDY_DELTA_VERSION = 1;
const ROOT_DOC_FILES = new Set(['README.md', 'CLAUDE.md', 'CONTRIBUTING.md']);
const LOW_SIGNAL_EXPORT_NAMES = new Set(['default', 'test', 'tests', 'value', 'values', 'data', 'result', 'results', 'foo', 'bar', 'baz']);
const LOW_SIGNAL_HOTSPOT_BASENAMES = new Set(['logger.js', 'constants.js']);
const TEST_FILE_PATTERN = /(?:^|\/)(?:tests?|__tests__)\/|(?:\.test|\.spec|\.e2e|\.integration)\.[^.]+$/i;
const TEST_SUFFIX_PATTERN = /(?:\.test|\.spec|\.e2e|\.integration)$/i;
const TOKEN_STOP_WORDS = new Set(['js', 'ts', 'jsx', 'tsx', 'index', 'main', 'test', 'tests', 'spec', 'e2e', 'integration', 'server', 'src', 'lib', 'app']);
const MAX_PROPOSAL_LIMIT = 5;
const GENERIC_FLOW_IDS = Object.freeze({ ENTRY_RUNTIME: 'generic-entry-runtime', CONFIG_CONTRACTS: 'generic-config-contracts', CHANGE_VALIDATION: 'generic-change-validation' });

function createNoopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function createCodebaseStudy({ db: _db, taskCore, logger, batchSize } = {}) {
  if (!taskCore || typeof taskCore.listTasks !== 'function') {
    throw new Error('createCodebaseStudy requires taskCore.listTasks(options)');
  }

  const studyLogger = logger || createNoopLogger();
  const effectiveBatchSize = Number.isInteger(batchSize) && batchSize > 0
    ? batchSize
    : DEFAULT_LOCAL_BATCH_SIZE;
  const scanner = createScanner({ symbolIndexer, logger: studyLogger });
  const evaluator = createEvaluator({ db: _db, logger: studyLogger });
  const proposer = createProposer({ taskCore, logger: studyLogger, db: _db });
  const parsers = createParsers({ logger: studyLogger });
  const profileManager = createProfileManager({ db: _db, logger: studyLogger });
  const buildModuleEntryMap = parsers.buildModuleEntryMap;
  const buildModuleExportLookup = parsers.buildModuleExportLookup;
  const buildInterfaceImplementationMap = parsers.buildInterfaceImplementationMap;
  const buildServiceRegistrationLookup = parsers.buildServiceRegistrationLookup;
  const extractCSharpExplicitExports = parsers.extractCSharpExplicitExports;
  const extractCSharpImplementedInterfaces = parsers.extractCSharpImplementedInterfaces;
  const extractCSharpReferenceHints = parsers.extractCSharpReferenceHints;
  const extractServiceRegistrations = parsers.extractServiceRegistrations;
  const resolveCSharpDependencyCandidates = parsers.resolveCSharpDependencyCandidates;
  let flowDefinitions = null;
  let hotspotsAnalyzer = null;
  let testsIndex = null;
  const isLikelyEntrypoint = (...args) => flowDefinitions.isLikelyEntrypoint(...args);
  const isTestFile = (...args) => testsIndex.isTestFile(...args);
  const isStructuredContentFile = (...args) => hotspotsAnalyzer.isStructuredContentFile(...args);
  const isExecutableSurfaceFile = (...args) => hotspotsAnalyzer.isExecutableSurfaceFile(...args);
  const buildReverseDependencyMap = (...args) => hotspotsAnalyzer.buildReverseDependencyMap(...args);
  const getEntrypointCorePathBoost = (...args) => hotspotsAnalyzer.getEntrypointCorePathBoost(...args);
  const selectDiverseHotspots = (...args) => hotspotsAnalyzer.selectDiverseHotspots(...args);

  const orchestratorHelpers = createOrchestratorHelpers({
    GENERATED_STUDY_FILES,
    ALLOWED_EXTENSIONS,
    MAX_RUN_BATCH_COUNT,
    scanner,
    logger: studyLogger,
    buildModuleExportLookup,
    buildModuleEntryMap,
    buildInterfaceImplementationMap,
    buildServiceRegistrationLookup,
    extractCSharpExplicitExports,
    extractCSharpImplementedInterfaces,
    extractCSharpReferenceHints,
    extractServiceRegistrations,
    resolveCSharpDependencyCandidates,
    toRepoPath,
    uniqueStrings,
    uniquePaths,
  });
  const normalizeNonNegativeInteger = orchestratorHelpers.normalizeNonNegativeInteger;
  const normalizePositiveInteger = orchestratorHelpers.normalizePositiveInteger;
  const buildCounts = orchestratorHelpers.buildCounts;
  const writeTextFileIfChanged = orchestratorHelpers.writeTextFileIfChanged;
  const safeHeadSha = orchestratorHelpers.safeHeadSha;
  const loadTrackedFiles = orchestratorHelpers.loadTrackedFiles;
  const loadDeltaChanges = orchestratorHelpers.loadDeltaChanges;
  const mergeUnique = orchestratorHelpers.mergeUnique;
  const buildScanLookup = orchestratorHelpers.buildScanLookup;
  const enrichModuleEntries = orchestratorHelpers.enrichModuleEntries;
  const buildModuleEntry = orchestratorHelpers.buildModuleEntry;
  const formatInlineList = orchestratorHelpers.formatInlineList;
  const formatCodeList = orchestratorHelpers.formatCodeList;
  const artifactFiles = createArtifactFiles({
    ensureStudyDocs,
    normalizeModuleIndex,
    STUDY_DIR,
    STATE_FILE,
    MODULE_INDEX_FILE,
    KNOWLEDGE_PACK_FILE,
    STUDY_DELTA_FILE,
    STUDY_EVALUATION_FILE,
    STUDY_BENCHMARK_FILE_LOCAL,
    SUMMARY_FILE,
  });
  const readModuleIndex = artifactFiles.readModuleIndex;
  const writeModuleIndex = artifactFiles.writeModuleIndex;
  const writeKnowledgePack = artifactFiles.writeKnowledgePack;
  const writeStudyDelta = artifactFiles.writeStudyDelta;
  const writeStudyBenchmark = artifactFiles.writeStudyBenchmark;

  const subsystems = createSubsystems({
    ROOT_DOC_FILES,
    LOW_SIGNAL_EXPORT_NAMES,
    RELATIONSHIP_LIMIT,
    isLikelyEntrypoint,
    toRepoPath,
    uniqueStrings,
    uniquePaths,
    formatInlineList,
    formatCodeList,
  });
  const buildSubsystemRows = subsystems.buildSubsystemRows;
  const getSubsystemForFile = subsystems.getSubsystemForFile;
  const buildSubsystemLookup = subsystems.buildSubsystemLookup;
  const getSubsystemPriority = subsystems.getSubsystemPriority;
  const buildDetectionSummary = subsystems.buildDetectionSummary;
  const buildSubsystemRelationships = subsystems.buildSubsystemRelationships;

  flowDefinitions = createFlowDefinitions({
    GENERIC_FLOW_IDS,
    SYMBOL_INDEX_EXTENSIONS,
    getSubsystemForFile,
    buildModuleEntryMap,
    isTestFile,
    isStructuredContentFile,
    isExecutableSurfaceFile,
    buildReverseDependencyMap,
    getEntrypointCorePathBoost,
    selectDiverseHotspots,
    toRepoPath,
    uniqueStrings,
    uniquePaths,
  });
  const buildFlowSummaries = flowDefinitions.buildFlowSummaries;
  const buildEntrypoints = flowDefinitions.buildEntrypoints;

  hotspotsAnalyzer = createHotspotsAnalyzer({
    HOTSPOT_LIMIT,
    LOW_SIGNAL_HOTSPOT_BASENAMES,
    SYMBOL_INDEX_EXTENSIONS,
    getSubsystemForFile,
    isLikelyEntrypoint,
    toRepoPath,
    uniqueStrings,
    uniquePaths,
  });

  testsIndex = createTestsIndex({
    TEST_FILE_PATTERN,
    TEST_SUFFIX_PATTERN,
    TOKEN_STOP_WORDS,
    TEST_MATRIX_LIMIT,
    getSubsystemForFile,
    getSubsystemPriority,
    toRepoPath,
    uniqueStrings,
    uniquePaths,
  });
  const buildTestInventory = testsIndex.buildTestInventory;
  const findTestsForFiles = testsIndex.findTestsForFiles;
  const buildValidationCommands = testsIndex.buildValidationCommands;

  const expertise = createExpertise({
    GENERIC_FLOW_IDS,
    SUMMARY_SUBSYSTEM_LIMIT,
    TRACE_LIMIT,
    NAVIGATION_HINT_LIMIT,
    findTestsForFiles,
    buildValidationCommands,
    uniqueStrings,
    uniquePaths,
  });
  const buildOperationalInvariants = expertise.buildOperationalInvariants;
  const buildFailureModes = expertise.buildFailureModes;
  const buildCanonicalTraces = expertise.buildCanonicalTraces;
  const buildChangePlaybooks = expertise.buildChangePlaybooks;
  const buildImpactGuidance = expertise.buildImpactGuidance;
  const buildExpertiseOnramp = expertise.buildExpertiseOnramp;
  const buildCapabilityList = expertise.buildCapabilityList;
  const buildNavigationHints = expertise.buildNavigationHints;

  const profileSerializer = createProfileSerializer({
    STUDY_PROFILE_OVERRIDE_FILE,
    buildDetectionSummary,
    resolveWorkingDirectory,
    loadRepoMetadata,
    resolveStudyProfile,
    detectStudyProfileSignals,
    getStudyProfileOverridePath,
    readStudyProfileOverride,
    createStudyProfileOverrideTemplate,
    uniqueStrings,
  });
  const serializeStudyProfile = profileSerializer.serializeStudyProfile;
  const maybeWriteStudyProfileOverrideScaffold = profileSerializer.maybeWriteStudyProfileOverrideScaffold;
  const describeStudyProfile = profileSerializer.describeStudyProfile;

  const summary = createSummary({
    SUMMARY_PLACEHOLDER,
    KNOWLEDGE_PACK_FILE,
    STUDY_DELTA_FILE,
    MODULE_INDEX_FILE,
    HOTSPOT_LIMIT,
    NAVIGATION_HINT_LIMIT,
    SUMMARY_SUBSYSTEM_LIMIT,
    SUMMARY_FLOW_LIMIT,
    SUMMARY_INVARIANT_LIMIT,
    SUMMARY_FAILURE_MODE_LIMIT,
    SUMMARY_PLAYBOOK_LIMIT,
    SIGNIFICANCE_REASON_LIMIT,
    LOCAL_ONLY_STRATEGY,
    DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL,
    DEFAULT_PROPOSAL_MIN_SCORE,
    uniquePaths,
    uniqueStrings,
    formatInlineList,
    formatCodeList,
  });
  const buildSummaryFromKnowledgePack = summary.buildSummaryFromKnowledgePack;
  const buildStatusPayload = summary.buildStatusPayload;
  const toPercent = summary.toPercent;

  const studyProposals = createProposals({
    STUDY_DELTA_FILE,
    KNOWLEDGE_PACK_FILE,
    STUDY_DELTA_VERSION,
    DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL,
    DEFAULT_PROPOSAL_MIN_SCORE,
    SIGNIFICANCE_REASON_LIMIT,
    MAX_PROPOSAL_LIMIT,
    getSubsystemForFile,
    getSubsystemPriority,
    findTestsForFiles,
    buildValidationCommands,
    toRepoPath,
    uniqueStrings,
    uniquePaths,
  });
  const buildStudyDelta = studyProposals.buildStudyDelta;

  const flows = createFlows({
    db: _db,
    logger: studyLogger,
    scanner,
    evaluator,
    proposer,
    profileManager,
    hotspotsAnalyzer,
    taskCore,
    effectiveBatchSize,
    helpers: {
      resolveWorkingDirectory,
      readStudyState,
      writeStudyState,
      safeHeadSha,
      loadTrackedFiles,
      loadDeltaChanges,
      mergeUnique,
      uniquePaths,
      updateStudyDocs,
      normalizeState,
      buildCounts,
      buildStatusPayload,
      buildInitialState,
      loadRepoMetadata,
      describeStudyProfile,
      maybeWriteStudyProfileOverrideScaffold,
      readJsonIfPresent,
      normalizeNonNegativeInteger,
      normalizePositiveInteger,
      normalizeStudyThresholdLevel,
      buildStudyBootstrapPlan,
      benchmarkStudy,
    },
    constants: {
      DEFAULT_LOCAL_BATCH_SIZE,
      DEFAULT_MANUAL_RUN_BATCH_COUNT,
      DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL,
      DEFAULT_PROPOSAL_MIN_SCORE,
      LOCAL_ONLY_STRATEGY,
      STUDY_OUTPUT_FILES,
      STUDY_BENCHMARK_FILE_LOCAL,
      STUDY_EVALUATION_FILE,
    },
  });

  async function buildKnowledgePack(workingDirectory, modules, context = {}) {
    const repoMetadata = await loadRepoMetadata(workingDirectory);
    const trackedFiles = uniquePaths(context.trackedFiles || modules.map(entry => entry.file));
    const pendingFiles = uniquePaths(context.pendingFiles || []);
    const availableFiles = new Set(trackedFiles);
    const profile = resolveStudyProfile({
      repoMetadata,
      trackedFiles,
      workingDirectory,
    });
    const repoSignals = detectStudyProfileSignals({
      repoMetadata,
      trackedFiles,
      profile,
    });
    const subsystemLookup = buildSubsystemLookup([...trackedFiles, ...modules.map(entry => entry.file)], profile);
    const reverseDeps = hotspotsAnalyzer.buildReverseDependencyMap(modules);
    const subsystems = buildSubsystemRows(modules, {
      trackedFiles,
      pendingFiles,
      reverseDeps,
      subsystemLookup,
      activeProfile: profile,
    });
    const relationships = buildSubsystemRelationships(modules, subsystemLookup, profile);
    const hotspots = hotspotsAnalyzer.analyzeHotspots({
      entries: modules,
      reverseDeps,
      subsystemLookup,
      activeProfile: profile,
      repoSignals,
    });
    const entrypoints = buildEntrypoints(repoMetadata, availableFiles, hotspots, modules, subsystemLookup, profile, repoSignals);
    const flows = buildFlowSummaries({
      repoMetadata,
      trackedFiles,
      modules,
      entrypoints,
      hotspots,
      subsystemLookup,
      activeProfile: profile,
    });
    const testInventory = buildTestInventory(modules, trackedFiles, subsystemLookup, flows, profile, workingDirectory);
    const invariants = buildOperationalInvariants(subsystems, flows, testInventory, profile);
    const failureModes = buildFailureModes(flows, hotspots, testInventory, profile);
    const canonicalTraces = buildCanonicalTraces(flows, testInventory, profile);
    const changePlaybooks = buildChangePlaybooks(subsystems, flows, testInventory, profile, workingDirectory, invariants);
    const impactGuidance = buildImpactGuidance(subsystems, flows, invariants, testInventory, profile, workingDirectory);
    const onramp = buildExpertiseOnramp(profile, entrypoints, flows, invariants, subsystems);
    const publicProfile = serializeStudyProfile({ ...profile, detection: repoSignals });
    const coverage = {
      tracked_files: trackedFiles.length,
      indexed_modules: modules.length,
      pending_files: pendingFiles.length,
      indexed_percent: toPercent(modules.length, trackedFiles.length),
    };

    return {
      version: KNOWLEDGE_PACK_VERSION,
      generated_at: context.generatedAt || new Date().toISOString(),
      study_profile: publicProfile,
      repo: {
        name: repoMetadata.name,
        description: repoMetadata.description,
        working_directory: workingDirectory,
        current_sha: context.currentSha || null,
        study_strategy: LOCAL_ONLY_STRATEGY,
        detection: buildDetectionSummary(repoSignals),
        capabilities: buildCapabilityList(subsystems, flows),
      },
      coverage,
      artifacts: {
        summary: SUMMARY_FILE.replace(/\\/g, '/'),
        module_index: MODULE_INDEX_FILE.replace(/\\/g, '/'),
        knowledge_pack: KNOWLEDGE_PACK_FILE.replace(/\\/g, '/'),
        study_evaluation: STUDY_EVALUATION_FILE.replace(/\\/g, '/'),
        study_benchmark: STUDY_BENCHMARK_FILE.replace(/\\/g, '/'),
      },
      entrypoints,
      subsystems,
      subsystem_relationships: relationships,
      flows,
      hotspots,
      navigation_hints: buildNavigationHints(flows, subsystems, entrypoints),
      expertise: {
        onramp,
        invariants,
        failure_modes: failureModes,
        canonical_traces: canonicalTraces,
        test_matrix: testInventory.coverage,
        change_playbooks: changePlaybooks,
        impact_guidance: impactGuidance,
      },
    };
  }

  async function updateStudyDocs(workingDirectory, batchFiles, removedFiles, context = {}) {
    const paths = await ensureStudyDocs(workingDirectory);
    const previousKnowledgePack = await readJsonIfPresent(paths.knowledgePackPath);
    const { moduleIndex } = await readModuleIndex(workingDirectory);
    const entryMap = new Map(moduleIndex.modules.map(entry => [entry.file, entry]));
    const trackedFiles = uniquePaths(context.trackedFiles || []);
    const scanTargets = uniquePaths([
      ...uniquePaths(batchFiles),
      ...trackedFiles.filter(file => !entryMap.has(file)),
    ]);
    const scanLookup = scanTargets.length > 0
      ? buildScanLookup(await scanner.scanRepo(workingDirectory, { files: scanTargets }))
      : buildScanLookup({ files: [], symbols: [], imports: [] });

    for (const removedFile of uniquePaths(removedFiles)) {
      entryMap.delete(removedFile);
    }

    const updatedEntries = [];
    for (const batchFile of uniquePaths(batchFiles)) {
      const entry = await buildModuleEntry(workingDirectory, batchFile, scanLookup);
      if (entry) {
        entryMap.set(entry.file, entry);
        updatedEntries.push(entry.file);
      }
    }

    // Self-heal stale module indexes when tracked study candidates expand without a git diff.
    for (const trackedFile of trackedFiles) {
      if (entryMap.has(trackedFile)) {
        continue;
      }
      const entry = await buildModuleEntry(workingDirectory, trackedFile, scanLookup);
      if (entry) {
        entryMap.set(entry.file, entry);
        updatedEntries.push(entry.file);
      }
    }

    const nextModules = await enrichModuleEntries(
      Array.from(entryMap.values()).sort((left, right) => left.file.localeCompare(right.file)),
      workingDirectory
    );
    const dateStamp = new Date().toISOString().slice(0, 10);
    await writeModuleIndex(workingDirectory, {
      modules: nextModules,
      last_updated: dateStamp,
    });

    const knowledgePack = await buildKnowledgePack(workingDirectory, nextModules, {
      trackedFiles,
      pendingFiles: context.pendingFiles || [],
      currentSha: context.currentSha || null,
      generatedAt: context.generatedAt || new Date().toISOString(),
    });
    const activeProfile = resolveStudyProfile({
      repoMetadata: {
        name: knowledgePack?.repo?.name,
        description: knowledgePack?.repo?.description,
      },
      trackedFiles: trackedFiles.length > 0 ? trackedFiles : nextModules.map(entry => entry.file),
      workingDirectory,
    });
    await writeKnowledgePack(workingDirectory, knowledgePack);
    const studyDelta = buildStudyDelta(previousKnowledgePack, knowledgePack, {
      workingDirectory,
      currentSha: context.currentSha || null,
      previousSha: context.previousSha || null,
      signalFiles: context.signalFiles || [],
      processedFiles: batchFiles,
      removedFiles,
      generatedAt: context.generatedAt || new Date().toISOString(),
      batchCount: context.batchCount || 0,
      manualRunNow: context.manualRunNow === true,
      forceRefresh: context.forceRefresh === true,
      scheduleId: context.scheduleId || null,
      scheduleName: context.scheduleName || null,
      scheduleRunId: context.scheduleRunId || null,
      currentTaskId: context.currentTaskId || null,
      activeProfile,
      subsystemLookup: buildSubsystemLookup([
        ...trackedFiles,
        ...nextModules.map(entry => entry.file),
        ...(context.signalFiles || []),
      ], activeProfile),
      isBaseline: !context.previousSha,
    });
    const evaluationResult = await evaluator.evaluateStudy(workingDirectory, {
      workingDirectory,
      state: {
        file_counts: {
          tracked: trackedFiles.length,
          pending: (context.pendingFiles || []).length,
        },
      },
      moduleIndex: {
        modules: nextModules,
      },
      knowledgePack,
      studyDelta,
      activeProfile,
      persistState: false,
    });
    const filteredProposals = proposer.filterProposals(
      evaluationResult.proposals?.suggested || [],
      {
        studyDelta,
        project: context.project,
        workingDirectory,
        submitProposals: context.submitProposals === true,
        proposalSignificanceLevel: context.proposalSignificanceLevel,
        proposalMinScore: context.proposalMinScore,
      }
    );
    const proposalResult = await proposer.submitProposals(workingDirectory, {
      workingDirectory,
      project: context.project,
      proposalLimit: context.proposalLimit,
      proposalSignificanceLevel: context.proposalSignificanceLevel,
      proposalMinScore: context.proposalMinScore,
      proposals: filteredProposals,
    });
    studyDelta.proposals = proposalResult;
    await writeStudyDelta(workingDirectory, studyDelta);
    const studyEvaluation = await readJsonIfPresent(paths.evaluationPath);
    const studyBenchmark = await readJsonIfPresent(paths.benchmarkPath);
    const summaryText = buildSummaryFromKnowledgePack(knowledgePack, studyDelta, studyEvaluation, studyBenchmark);
    const summaryUpdated = await writeTextFileIfChanged(paths.summaryPath, summaryText);

    return {
      module_entry_count: nextModules.length,
      module_entries_updated: updatedEntries.length,
      module_entries_removed: uniquePaths(removedFiles).length,
      subsystem_count: knowledgePack.subsystems.length,
      flow_count: knowledgePack.flows.length,
      hotspot_count: knowledgePack.hotspots.length,
      invariant_count: knowledgePack.expertise?.invariants?.length || 0,
      failure_mode_count: knowledgePack.expertise?.failure_modes?.length || 0,
      trace_count: knowledgePack.expertise?.canonical_traces?.length || 0,
      playbook_count: knowledgePack.expertise?.change_playbooks?.length || 0,
      test_area_count: knowledgePack.expertise?.test_matrix?.length || 0,
      delta_significance_level: studyDelta.significance.level,
      delta_significance_score: studyDelta.significance.score,
      proposal_count: proposalResult?.suggested?.length || 0,
      submitted_proposal_count: proposalResult?.submitted?.length || 0,
      proposal_significance_level: proposalResult?.policy?.threshold_level || normalizeStudyThresholdLevel(context.proposalSignificanceLevel),
      proposal_min_score: proposalResult?.policy?.threshold_score ?? normalizeNonNegativeInteger(context.proposalMinScore, DEFAULT_PROPOSAL_MIN_SCORE),
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
      study_delta: studyDelta,
      study_evaluation: studyEvaluation,
      study_benchmark: studyBenchmark,
      summary_updated: summaryUpdated,
    };
  }

  async function getStudyStatus(workingDirectory) {
    const resolvedWorkingDirectory = resolveWorkingDirectory(workingDirectory);
    const { state } = await readStudyState(resolvedWorkingDirectory);
    return buildStatusPayload(resolvedWorkingDirectory, state, safeHeadSha(resolvedWorkingDirectory));
  }

  async function evaluateStudy(workingDirectory) {
    const resolvedWorkingDirectory = resolveWorkingDirectory(workingDirectory);
    const { paths, state } = await readStudyState(resolvedWorkingDirectory);
    const { moduleIndex } = await readModuleIndex(resolvedWorkingDirectory);
    const knowledgePack = await readJsonIfPresent(paths.knowledgePackPath);
    const studyDelta = await readJsonIfPresent(paths.deltaPath);

    if (!knowledgePack?.generated_at) {
      throw new Error('Study artifacts are not ready yet. Run the codebase study before evaluating it.');
    }

    await evaluator.evaluateStudy(resolvedWorkingDirectory, {
      workingDirectory: resolvedWorkingDirectory,
      state,
      moduleIndex,
      knowledgePack,
      studyDelta,
      persistState: false,
    });
    const studyEvaluation = await readJsonIfPresent(paths.evaluationPath);
    const studyBenchmark = await readJsonIfPresent(paths.benchmarkPath);
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
    });
    await writeStudyState(resolvedWorkingDirectory, nextState);

    return {
      ...buildStatusPayload(resolvedWorkingDirectory, nextState, safeHeadSha(resolvedWorkingDirectory)),
      study_evaluation: studyEvaluation,
      study_benchmark: studyBenchmark,
      files_modified: [
        STUDY_EVALUATION_FILE.replace(/\\/g, '/'),
        STUDY_BENCHMARK_FILE_LOCAL.replace(/\\/g, '/'),
      ],
    };
  }

  async function benchmarkStudy(workingDirectory) {
    const resolvedWorkingDirectory = resolveWorkingDirectory(workingDirectory);
    const { paths, state } = await readStudyState(resolvedWorkingDirectory);
    const { moduleIndex } = await readModuleIndex(resolvedWorkingDirectory);
    const knowledgePack = await readJsonIfPresent(paths.knowledgePackPath);
    const studyDelta = await readJsonIfPresent(paths.deltaPath);
    const studyEvaluation = await readJsonIfPresent(paths.evaluationPath);

    if (!knowledgePack?.generated_at) {
      throw new Error('Study artifacts are not ready yet. Run the codebase study before benchmarking it.');
    }

    const benchmarkSourceEvaluation = studyEvaluation?.summary
      ? studyEvaluation
      : evaluateStudyArtifacts({
          knowledgePack,
          studyDelta,
          state,
          moduleIndex,
          workingDirectory: resolvedWorkingDirectory,
        });
    const studyBenchmark = benchmarkStudyArtifacts({
      knowledgePack,
      studyDelta,
      studyEvaluation: benchmarkSourceEvaluation,
      moduleIndex,
      workingDirectory: resolvedWorkingDirectory,
    });
    await writeStudyBenchmark(resolvedWorkingDirectory, studyBenchmark);
    const nextState = normalizeState({
      ...state,
      benchmark_score: studyBenchmark.summary.score,
      benchmark_grade: studyBenchmark.summary.grade,
      benchmark_readiness: studyBenchmark.summary.readiness,
      benchmark_findings_count: studyBenchmark.findings.length,
      benchmark_case_count: studyBenchmark.summary.total_cases,
      benchmark_generated_at: studyBenchmark.generated_at,
    });
    await writeStudyState(resolvedWorkingDirectory, nextState);

    return {
      ...buildStatusPayload(resolvedWorkingDirectory, nextState, safeHeadSha(resolvedWorkingDirectory)),
      study_benchmark: studyBenchmark,
      files_modified: [STUDY_BENCHMARK_FILE_LOCAL.replace(/\\/g, '/')],
    };
  }

  return {
    runStudyCycle: flows.runStudyCycle,
    getStudyStatus,
    evaluateStudy,
    benchmarkStudy,
    getStudyProfileOverrideStatus: (workingDirectory) => profileManager.getOverrideStatus(workingDirectory),
    saveStudyProfileOverride: (workingDirectory, overrideValue, options = {}) => (
      profileManager.saveOverride(workingDirectory, overrideValue, options)
    ),
    previewBootstrapStudy: flows.previewBootstrapStudy,
    bootstrapStudy: flows.bootstrapStudy,
    resetStudy: flows.resetStudy,
    _testing: {
      buildInterfaceImplementationMap,
      buildModuleEntryMap,
      buildModuleExportLookup,
      buildServiceRegistrationLookup,
      extractCSharpReferenceHints,
      extractServiceRegistrations,
      resolveCSharpDependencyCandidates,
    },
  };
}

module.exports = {
  createNoopLogger,
  createCodebaseStudy,
  resolveWorkingDirectory,
  toRepoPath,
  uniqueStrings,
  uniquePaths,
  buildInitialState,
  normalizeState,
  normalizeModuleEntry,
  normalizeModuleIndex,
  readJsonIfPresent,
  readTextIfPresent,
  loadRepoMetadata,
  ensureStudyDocs,
  readStudyState,
};
