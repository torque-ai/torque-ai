'use strict';

const path = require('path');

const DEFAULT_LOCAL_BATCH_SIZE = 100;
const DEFAULT_MANUAL_RUN_BATCH_COUNT = 5;
const DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL_FALLBACK = 'moderate';
const DEFAULT_PROPOSAL_MIN_SCORE_FALLBACK = 0;
const LOCAL_ONLY_STRATEGY_FALLBACK = 'local-deterministic';
const STUDY_OUTPUT_FILES_FALLBACK = [
  'docs/architecture/module-index.json',
  'docs/architecture/knowledge-pack.json',
  'docs/architecture/study-delta.json',
  'docs/architecture/study-evaluation.json',
  'docs/architecture/study-benchmark.json',
  'docs/architecture/SUMMARY.md',
  'docs/architecture/study-state.json',
];
const STUDY_BENCHMARK_FILE_LOCAL_FALLBACK = 'docs/architecture/study-benchmark.json';
const STUDY_EVALUATION_FILE_FALLBACK = 'docs/architecture/study-evaluation.json';

function createFlows(deps = {}) {
  const {
    db: _db,
    logger: _logger,
    scanner: _scanner,
    evaluator: _evaluator,
    proposer: _proposer,
    profileManager: _profileManager,
    taskCore,
  } = deps;
  if (!taskCore || typeof taskCore.listTasks !== 'function') {
    throw new Error('createFlows requires taskCore.listTasks(options)');
  }

  const helperBag = {
    ...(deps.helpers && typeof deps.helpers === 'object' ? deps.helpers : {}),
    ...(deps.ctx && typeof deps.ctx === 'object' ? deps.ctx : {}),
  };
  const constants = deps.constants && typeof deps.constants === 'object'
    ? deps.constants
    : {};

  const resolveWorkingDirectory = deps.resolveWorkingDirectory || helperBag.resolveWorkingDirectory;
  const readStudyState = deps.readStudyState || helperBag.readStudyState;
  const writeStudyState = deps.writeStudyState || helperBag.writeStudyState;
  const safeHeadSha = deps.safeHeadSha || helperBag.safeHeadSha;
  const loadTrackedFiles = deps.loadTrackedFiles || helperBag.loadTrackedFiles;
  const loadDeltaChanges = deps.loadDeltaChanges || helperBag.loadDeltaChanges;
  const mergeUnique = deps.mergeUnique || helperBag.mergeUnique;
  const uniquePaths = deps.uniquePaths || helperBag.uniquePaths;
  const updateStudyDocs = deps.updateStudyDocs || helperBag.updateStudyDocs;
  const normalizeState = deps.normalizeState || helperBag.normalizeState;
  const buildCounts = deps.buildCounts || helperBag.buildCounts;
  const buildStatusPayload = deps.buildStatusPayload || helperBag.buildStatusPayload;
  const buildInitialState = deps.buildInitialState || helperBag.buildInitialState;
  const loadRepoMetadata = deps.loadRepoMetadata || helperBag.loadRepoMetadata;
  const describeStudyProfile = deps.describeStudyProfile || helperBag.describeStudyProfile;
  const maybeWriteStudyProfileOverrideScaffold = deps.maybeWriteStudyProfileOverrideScaffold
    || helperBag.maybeWriteStudyProfileOverrideScaffold;
  const readJsonIfPresent = deps.readJsonIfPresent || helperBag.readJsonIfPresent;
  const normalizeNonNegativeInteger = deps.normalizeNonNegativeInteger || helperBag.normalizeNonNegativeInteger;
  const normalizePositiveInteger = deps.normalizePositiveInteger || helperBag.normalizePositiveInteger;
  const normalizeStudyThresholdLevel = deps.normalizeStudyThresholdLevel || helperBag.normalizeStudyThresholdLevel;
  const buildStudyBootstrapPlan = deps.buildStudyBootstrapPlan || helperBag.buildStudyBootstrapPlan;
  const benchmarkStudy = deps.benchmarkStudy || helperBag.benchmarkStudy;

  const effectiveBatchSize = Number.isInteger(deps.effectiveBatchSize) && deps.effectiveBatchSize > 0
    ? deps.effectiveBatchSize
    : (
      Number.isInteger(deps.batchSize) && deps.batchSize > 0
        ? deps.batchSize
        : (
          Number.isInteger(constants.DEFAULT_LOCAL_BATCH_SIZE) && constants.DEFAULT_LOCAL_BATCH_SIZE > 0
            ? constants.DEFAULT_LOCAL_BATCH_SIZE
            : DEFAULT_LOCAL_BATCH_SIZE
        )
    );
  const DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL = typeof constants.DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL === 'string'
    && constants.DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL.trim()
    ? constants.DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL.trim()
    : DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL_FALLBACK;
  const DEFAULT_PROPOSAL_MIN_SCORE = Number.isInteger(constants.DEFAULT_PROPOSAL_MIN_SCORE)
    ? constants.DEFAULT_PROPOSAL_MIN_SCORE
    : DEFAULT_PROPOSAL_MIN_SCORE_FALLBACK;
  const DEFAULT_MANUAL_RUN_BATCH_COUNT_VALUE = Number.isInteger(constants.DEFAULT_MANUAL_RUN_BATCH_COUNT)
    && constants.DEFAULT_MANUAL_RUN_BATCH_COUNT > 0
    ? constants.DEFAULT_MANUAL_RUN_BATCH_COUNT
    : DEFAULT_MANUAL_RUN_BATCH_COUNT;
  const LOCAL_ONLY_STRATEGY = typeof constants.LOCAL_ONLY_STRATEGY === 'string'
    && constants.LOCAL_ONLY_STRATEGY.trim()
    ? constants.LOCAL_ONLY_STRATEGY.trim()
    : LOCAL_ONLY_STRATEGY_FALLBACK;
  const STUDY_OUTPUT_FILES = Array.isArray(constants.STUDY_OUTPUT_FILES)
    ? constants.STUDY_OUTPUT_FILES
      .map(filePath => String(filePath || '').trim().replace(/\\/g, '/'))
      .filter(Boolean)
    : STUDY_OUTPUT_FILES_FALLBACK;
  const STUDY_BENCHMARK_FILE_LOCAL = typeof constants.STUDY_BENCHMARK_FILE_LOCAL === 'string'
    && constants.STUDY_BENCHMARK_FILE_LOCAL.trim()
    ? constants.STUDY_BENCHMARK_FILE_LOCAL.trim()
    : STUDY_BENCHMARK_FILE_LOCAL_FALLBACK;
  const STUDY_EVALUATION_FILE = typeof constants.STUDY_EVALUATION_FILE === 'string'
    && constants.STUDY_EVALUATION_FILE.trim()
    ? constants.STUDY_EVALUATION_FILE.trim()
    : STUDY_EVALUATION_FILE_FALLBACK;

  async function runStudyCycle(workingDirectory, options = {}) {
    const resolvedWorkingDirectory = resolveWorkingDirectory(workingDirectory);
    const currentTaskId = typeof options?.currentTaskId === 'string' && options.currentTaskId.trim()
      ? options.currentTaskId.trim()
      : null;
    const manualRunNow = options?.manualRunNow === true;
    const forceRefresh = options?.forceRefresh === true || manualRunNow;
    const scheduleId = typeof options?.scheduleId === 'string' && options.scheduleId.trim()
      ? options.scheduleId.trim()
      : null;
    const scheduleName = typeof options?.scheduleName === 'string' && options.scheduleName.trim()
      ? options.scheduleName.trim()
      : null;
    const scheduleRunId = typeof options?.scheduleRunId === 'string' && options.scheduleRunId.trim()
      ? options.scheduleRunId.trim()
      : null;
    const submitProposals = options?.submitProposals === true;
    const proposalLimit = Number.isInteger(options?.proposalLimit) ? options.proposalLimit : undefined;
    const proposalSignificanceLevel = normalizeStudyThresholdLevel(
      options?.proposalSignificanceLevel,
      DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL
    );
    const proposalMinScore = normalizeNonNegativeInteger(options?.proposalMinScore, DEFAULT_PROPOSAL_MIN_SCORE);
    const runBatchCount = normalizePositiveInteger(
      options?.maxBatches,
      manualRunNow ? DEFAULT_MANUAL_RUN_BATCH_COUNT_VALUE : 1
    );
    const runningTasks = taskCore
      .listTasks({ status: 'running', limit: 1000 })
      .filter(task => {
        if (currentTaskId && String(task?.id || '') === currentTaskId) return false;
        const tags = Array.isArray(task?.tags) ? task.tags : [];
        if (tags.includes('codebase-study') || tags.includes('auto-generated')) return false;
        return true;
      });
    if (runningTasks.length > 0) {
      return {
        skipped: true,
        reason: 'queue_active',
        running_task_count: runningTasks.length,
      };
    }

    let state = null;
    let currentSha = null;
    let trackedFiles = [];
    let pendingFiles = [];
    let removedFiles = [];

    try {
      ({ state } = await readStudyState(resolvedWorkingDirectory));
      currentSha = safeHeadSha(resolvedWorkingDirectory);
      trackedFiles = loadTrackedFiles(resolvedWorkingDirectory);
      const delta = loadDeltaChanges(resolvedWorkingDirectory, state.last_sha);
      const trackedFileSet = new Set(trackedFiles);
      const newlyTrackedFiles = trackedFiles.filter(file => !state.tracked_files.includes(file));
      pendingFiles = state.last_sha
        ? mergeUnique(
          state.pending_files.filter(file => trackedFileSet.has(file)),
          delta.changed.filter(file => trackedFileSet.has(file)),
          newlyTrackedFiles
        )
        : trackedFiles;
      removedFiles = uniquePaths([
        ...delta.removed,
        ...state.tracked_files.filter(file => !trackedFileSet.has(file)),
      ]);

      if (pendingFiles.length === 0 && removedFiles.length === 0 && !forceRefresh) {
        const nowIso = new Date().toISOString();
        const docsResult = await updateStudyDocs(resolvedWorkingDirectory, [], [], {
          trackedFiles,
          pendingFiles: [],
          currentSha,
          previousSha: state.last_sha,
          generatedAt: nowIso,
          signalFiles: [],
          batchCount: 0,
          manualRunNow,
          scheduleId,
          scheduleName,
          scheduleRunId,
          currentTaskId,
          submitProposals,
          proposalLimit,
          proposalSignificanceLevel,
          proposalMinScore,
          project: options?.project,
        });
        const nextState = normalizeState({
          ...state,
          last_sha: currentSha,
          last_run_at: nowIso,
          last_result: 'up_to_date',
          last_error: null,
          tracked_files: trackedFiles,
          pending_files: [],
          file_counts: buildCounts(trackedFiles, []),
          index_strategy: LOCAL_ONLY_STRATEGY,
          summary_strategy: LOCAL_ONLY_STRATEGY,
          last_processed_count: 0,
          last_removed_count: 0,
          last_summary_updated_at: nowIso,
          knowledge_pack_updated_at: nowIso,
          last_delta_updated_at: nowIso,
          module_entry_count: docsResult.module_entry_count,
          subsystem_count: docsResult.subsystem_count,
          flow_count: docsResult.flow_count,
          hotspot_count: docsResult.hotspot_count,
          invariant_count: docsResult.invariant_count,
          failure_mode_count: docsResult.failure_mode_count,
          trace_count: docsResult.trace_count,
          playbook_count: docsResult.playbook_count,
          test_area_count: docsResult.test_area_count,
          delta_significance_level: docsResult.delta_significance_level,
          delta_significance_score: docsResult.delta_significance_score,
          proposal_count: docsResult.proposal_count,
          submitted_proposal_count: docsResult.submitted_proposal_count,
          proposal_significance_level: docsResult.proposal_significance_level,
          proposal_min_score: docsResult.proposal_min_score,
          evaluation_score: docsResult.evaluation_score,
          evaluation_grade: docsResult.evaluation_grade,
          evaluation_readiness: docsResult.evaluation_readiness,
          evaluation_findings_count: docsResult.evaluation_findings_count,
          evaluation_generated_at: docsResult.evaluation_generated_at,
          benchmark_score: docsResult.benchmark_score,
          benchmark_grade: docsResult.benchmark_grade,
          benchmark_readiness: docsResult.benchmark_readiness,
          benchmark_findings_count: docsResult.benchmark_findings_count,
          benchmark_case_count: docsResult.benchmark_case_count,
          benchmark_generated_at: docsResult.benchmark_generated_at,
        });
        await writeStudyState(resolvedWorkingDirectory, nextState);
        return {
          skipped: true,
          reason: 'up_to_date',
          ...buildStatusPayload(resolvedWorkingDirectory, nextState, currentSha),
        };
      }

      const isRefreshOnly = forceRefresh && pendingFiles.length === 0 && removedFiles.length === 0;
      const batchFiles = isRefreshOnly
        ? []
        : pendingFiles.slice(0, effectiveBatchSize * runBatchCount);
      const remainingPending = isRefreshOnly
        ? []
        : pendingFiles.slice(batchFiles.length);
      const batchCount = isRefreshOnly
        ? 0
        : Math.max(1, Math.ceil(batchFiles.length / effectiveBatchSize));
      const docsResult = await updateStudyDocs(resolvedWorkingDirectory, batchFiles, removedFiles, {
        trackedFiles,
        pendingFiles: remainingPending,
        currentSha,
        previousSha: state.last_sha,
        signalFiles: mergeUnique(delta.changed.filter(file => trackedFileSet.has(file)), removedFiles),
        generatedAt: new Date().toISOString(),
        batchCount,
        manualRunNow,
        forceRefresh,
        scheduleId,
        scheduleName,
        scheduleRunId,
        currentTaskId,
        submitProposals,
        proposalLimit,
        proposalSignificanceLevel,
        proposalMinScore,
        project: options?.project,
      });
      const nowIso = new Date().toISOString();
      const nextState = normalizeState({
        ...state,
        run_count: (state.run_count || 0) + 1,
        last_sha: currentSha,
        last_task_id: null,
        last_batch: batchFiles,
        last_run_at: nowIso,
        last_completed_at: nowIso,
        last_result: isRefreshOnly
          ? 'refreshed_local'
          : (remainingPending.length > 0 ? 'partial_local' : 'completed_local'),
        last_error: null,
        tracked_files: trackedFiles,
        pending_files: remainingPending,
        file_counts: buildCounts(trackedFiles, remainingPending),
        index_strategy: LOCAL_ONLY_STRATEGY,
        summary_strategy: LOCAL_ONLY_STRATEGY,
        last_processed_count: batchFiles.length,
        last_removed_count: removedFiles.length,
        last_summary_updated_at: nowIso,
        knowledge_pack_updated_at: nowIso,
        last_delta_updated_at: nowIso,
        module_entry_count: docsResult.module_entry_count,
        subsystem_count: docsResult.subsystem_count,
        flow_count: docsResult.flow_count,
        hotspot_count: docsResult.hotspot_count,
        invariant_count: docsResult.invariant_count,
        failure_mode_count: docsResult.failure_mode_count,
        trace_count: docsResult.trace_count,
        playbook_count: docsResult.playbook_count,
        test_area_count: docsResult.test_area_count,
        delta_significance_level: docsResult.delta_significance_level,
        delta_significance_score: docsResult.delta_significance_score,
        proposal_count: docsResult.proposal_count,
        submitted_proposal_count: docsResult.submitted_proposal_count,
        proposal_significance_level: docsResult.proposal_significance_level,
        proposal_min_score: docsResult.proposal_min_score,
        evaluation_score: docsResult.evaluation_score,
        evaluation_grade: docsResult.evaluation_grade,
        evaluation_readiness: docsResult.evaluation_readiness,
        evaluation_findings_count: docsResult.evaluation_findings_count,
        evaluation_generated_at: docsResult.evaluation_generated_at,
        benchmark_score: docsResult.benchmark_score,
        benchmark_grade: docsResult.benchmark_grade,
        benchmark_readiness: docsResult.benchmark_readiness,
        benchmark_findings_count: docsResult.benchmark_findings_count,
        benchmark_case_count: docsResult.benchmark_case_count,
        benchmark_generated_at: docsResult.benchmark_generated_at,
      });
      await writeStudyState(resolvedWorkingDirectory, nextState);

      return {
        skipped: false,
        task_status: 'completed',
        batch_count: batchCount,
        batch_files: batchFiles,
        removed_files: removedFiles,
        docs_updated: docsResult,
        files_modified: [...STUDY_OUTPUT_FILES],
        ...buildStatusPayload(resolvedWorkingDirectory, nextState, currentSha),
      };
    } catch (error) {
      if (state) {
        const nowIso = new Date().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        const failedState = normalizeState({
          ...state,
          last_sha: currentSha || state.last_sha,
          last_task_id: null,
          last_run_at: nowIso,
          last_result: 'failed_local',
          last_error: message,
          tracked_files: trackedFiles,
          pending_files: pendingFiles,
          file_counts: buildCounts(trackedFiles, pendingFiles),
          index_strategy: LOCAL_ONLY_STRATEGY,
          summary_strategy: LOCAL_ONLY_STRATEGY,
        });
        await writeStudyState(resolvedWorkingDirectory, failedState);
      }
      throw error;
    }
  }

  async function previewBootstrapStudy(workingDirectory, options = {}) {
    const resolvedWorkingDirectory = resolveWorkingDirectory(workingDirectory);
    const repoMetadata = await loadRepoMetadata(resolvedWorkingDirectory);
    const trackedFiles = loadTrackedFiles(resolvedWorkingDirectory);
    const {
      profile,
      serializedProfile,
      profileOverride,
    } = await describeStudyProfile(resolvedWorkingDirectory, repoMetadata, trackedFiles);
    const bootstrapPlan = buildStudyBootstrapPlan({
      workingDirectory: resolvedWorkingDirectory,
      repoMetadata,
      trackedFiles,
      profile,
      project: options.project,
      scheduleName: options.scheduleName,
      cronExpression: options.cronExpression,
      timezone: options.timezone,
      versionIntent: options.versionIntent,
      proposalSignificanceLevel: options.proposalSignificanceLevel,
      proposalMinScore: options.proposalMinScore,
      proposalLimit: options.proposalLimit,
      submitProposals: options.submitProposals,
      initialMaxBatches: options.initialMaxBatches,
    });

    return {
      working_directory: resolvedWorkingDirectory,
      bootstrap_plan: bootstrapPlan,
      study_profile: serializedProfile,
      profile_override: profileOverride,
      schedule_preview: bootstrapPlan.recommendations?.schedule || null,
    };
  }

  async function bootstrapStudy(workingDirectory, options = {}) {
    const resolvedWorkingDirectory = resolveWorkingDirectory(workingDirectory);
    const repoMetadata = await loadRepoMetadata(resolvedWorkingDirectory);
    const trackedFiles = loadTrackedFiles(resolvedWorkingDirectory);
    const {
      profile,
      serializedProfile,
      profileOverride,
    } = await describeStudyProfile(resolvedWorkingDirectory, repoMetadata, trackedFiles);
    const bootstrapPlan = buildStudyBootstrapPlan({
      workingDirectory: resolvedWorkingDirectory,
      repoMetadata,
      trackedFiles,
      profile,
      project: options.project,
      scheduleName: options.scheduleName,
      cronExpression: options.cronExpression,
      timezone: options.timezone,
      versionIntent: options.versionIntent,
      proposalSignificanceLevel: options.proposalSignificanceLevel,
      proposalMinScore: options.proposalMinScore,
      proposalLimit: options.proposalLimit,
      submitProposals: options.submitProposals,
      initialMaxBatches: options.initialMaxBatches,
    });

    let studyRun = null;
    if (options.runInitialStudy !== false) {
      studyRun = await runStudyCycle(resolvedWorkingDirectory, {
        maxBatches: bootstrapPlan.recommendations.initial_run.max_batches,
        submitProposals: options.submitProposals === true,
        proposalLimit: options.proposalLimit,
        proposalSignificanceLevel: bootstrapPlan.recommendations.schedule.proposal_significance_level,
        proposalMinScore: bootstrapPlan.recommendations.schedule.proposal_min_score,
        project: options.project,
      });
    }

    let benchmarkResult = null;
    if (options.runInitialStudy === false && options.runBenchmark !== false) {
      benchmarkResult = await benchmarkStudy(resolvedWorkingDirectory);
    }

    const { state } = await readStudyState(resolvedWorkingDirectory);
    const currentSha = safeHeadSha(resolvedWorkingDirectory);
    const activeStatus = buildStatusPayload(resolvedWorkingDirectory, state, currentSha);
    const benchmarkPath = path.join(resolvedWorkingDirectory, STUDY_BENCHMARK_FILE_LOCAL);
    const evaluationPath = path.join(resolvedWorkingDirectory, STUDY_EVALUATION_FILE);
    const scaffoldResult = options.writeProfileScaffold === true
      ? await maybeWriteStudyProfileOverrideScaffold(resolvedWorkingDirectory, profile)
      : {
          ...profileOverride,
          scaffold_written: false,
        };

    return {
      ...activeStatus,
      bootstrap_plan: bootstrapPlan,
      study_profile: serializedProfile,
      profile_override: scaffoldResult,
      initial_run: studyRun
        ? {
            skipped: studyRun.skipped === true,
            reason: studyRun.reason || null,
            task_status: studyRun.task_status || null,
            pending_count: studyRun.pending_count ?? 0,
            batch_count: studyRun.batch_count ?? 0,
          }
        : null,
      study_evaluation: studyRun?.docs_updated?.study_evaluation || await readJsonIfPresent(evaluationPath),
      study_benchmark: studyRun?.docs_updated?.study_benchmark || benchmarkResult?.study_benchmark || await readJsonIfPresent(benchmarkPath),
    };
  }

  async function resetStudy(workingDirectory) {
    const resolvedWorkingDirectory = resolveWorkingDirectory(workingDirectory);
    const { paths, state } = await writeStudyState(resolvedWorkingDirectory, buildInitialState());
    return {
      reset: true,
      working_directory: resolvedWorkingDirectory,
      state_path: paths.statePath,
      ...buildStatusPayload(resolvedWorkingDirectory, state, safeHeadSha(resolvedWorkingDirectory)),
    };
  }

  return {
    runStudyCycle,
    resetStudy,
    previewBootstrapStudy,
    bootstrapStudy,
  };
}

module.exports = { createFlows };
