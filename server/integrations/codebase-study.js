'use strict';

const { STUDY_PROFILE_OVERRIDE_FILE, resolveStudyProfile, getStudyProfileOverridePath, readStudyProfileOverride, createStudyProfileOverrideTemplate, detectStudyProfileSignals } = require('./codebase-study-profiles');
const { STUDY_EVALUATION_FILE, STUDY_BENCHMARK_FILE, DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL, DEFAULT_PROPOSAL_MIN_SCORE, normalizeStudyThresholdLevel, evaluateStudyArtifacts, benchmarkStudyArtifacts, buildStudyBootstrapPlan } = require('./codebase-study-engine');
const { createSymbolExtraction } = require('./codebase-study/symbol-extraction');
const { createEvaluator } = require('./codebase-study/evaluate');
const { createProposer } = require('./codebase-study/proposal');
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
const { createRepoScanner } = require('./codebase-study/repo-scanner');
const { createEvaluation } = require('./codebase-study/evaluation');
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
  const evaluator = createEvaluator({ db: _db, logger: studyLogger });
  const proposer = createProposer({ taskCore, logger: studyLogger, db: _db });
  const profileManager = createProfileManager({ db: _db, logger: studyLogger });
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
    logger: studyLogger,
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
  const formatCodeList = orchestratorHelpers.formatCodeList;

  const symbolExtraction = createSymbolExtraction({
    logger: studyLogger,
    toRepoPath,
    uniqueStrings,
    uniquePaths,
    buildScanLookup,
  });
  const scanner = symbolExtraction.scanner;
  const buildModuleEntryMap = symbolExtraction.buildModuleEntryMap;
  const buildModuleExportLookup = symbolExtraction.buildModuleExportLookup;
  const buildInterfaceImplementationMap = symbolExtraction.buildInterfaceImplementationMap;
  const buildServiceRegistrationLookup = symbolExtraction.buildServiceRegistrationLookup;
  const extractCSharpExplicitExports = symbolExtraction.extractCSharpExplicitExports;
  const extractCSharpImplementedInterfaces = symbolExtraction.extractCSharpImplementedInterfaces;
  const extractCSharpReferenceHints = symbolExtraction.extractCSharpReferenceHints;
  const extractServiceRegistrations = symbolExtraction.extractServiceRegistrations;
  const resolveCSharpDependencyCandidates = symbolExtraction.resolveCSharpDependencyCandidates;
  const enrichModuleEntries = symbolExtraction.enrichModuleEntries;
  const buildModuleEntry = symbolExtraction.buildModuleEntry;
  const formatInlineList = symbolExtraction.formatInlineList;
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

  const repoScanner = createRepoScanner({
    // Services
    evaluator,
    proposer,
    hotspotsAnalyzer,
    scanner,

    // Sub-modules
    symbolExtraction,
    artifactFiles,
    subsystems,
    flowDefinitions,
    testsIndex,
    expertise,
    summary,
    studyProposals,
    profileSerializer,

    // Helpers (from orchestrator-helpers)
    writeTextFileIfChanged,
    buildCounts,
    buildScanLookup,

    // State-docs functions
    resolveWorkingDirectory,
    readStudyState,
    writeStudyState,
    ensureStudyDocs,
    readJsonIfPresent,
    normalizeState,
    loadRepoMetadata,
    buildInitialState,

    // Profile functions
    resolveStudyProfile,
    detectStudyProfileSignals,
    normalizeStudyThresholdLevel,
    evaluateStudyArtifacts,
    benchmarkStudyArtifacts,

    // Utility
    uniquePaths,
    safeHeadSha,
    normalizeNonNegativeInteger,

    // Constants
    KNOWLEDGE_PACK_VERSION,
    LOCAL_ONLY_STRATEGY,
    STUDY_EVALUATION_FILE,
    STUDY_BENCHMARK_FILE,
    STUDY_BENCHMARK_FILE_LOCAL,
    SUMMARY_FILE,
    MODULE_INDEX_FILE,
    KNOWLEDGE_PACK_FILE,
    DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL,
    DEFAULT_PROPOSAL_MIN_SCORE,
  });
  const updateStudyDocs = repoScanner.updateStudyDocs;

  const evaluation = createEvaluation({
    // Services
    evaluator,

    // Sub-modules
    artifactFiles,
    summaryModule: summary,

    // Engine functions
    evaluateStudyArtifacts,
    benchmarkStudyArtifacts,

    // State-docs functions
    resolveWorkingDirectory,
    readStudyState,
    writeStudyState,
    readJsonIfPresent,
    normalizeState,

    // Utility
    safeHeadSha,

    // Constants
    STUDY_EVALUATION_FILE,
    STUDY_BENCHMARK_FILE_LOCAL,
  });
  const benchmarkStudy = evaluation.benchmarkStudy;

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
      buildStatusPayload: summary.buildStatusPayload,
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

  return {
    runStudyCycle: flows.runStudyCycle,
    getStudyStatus: repoScanner.getStudyStatus,
    evaluateStudy: evaluation.evaluateStudy,
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
