'use strict';

const path = require('path');

const taskCore = require('../db/task-core');
const schedulingAutomation = require('../db/scheduling-automation');
const { getStudyImpactSummary } = require('../db/study-telemetry');
const baseLogger = require('../logger').child({ component: 'codebase-study-handlers' });
const { ErrorCodes, makeError } = require('./shared');
const { createCodebaseStudy } = require('../integrations/codebase-study');
const {
  DEFAULT_BOOTSTRAP_CRON,
  DEFAULT_BOOTSTRAP_BATCHES,
  DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL,
  DEFAULT_PROPOSAL_MIN_SCORE,
  normalizeStudyThresholdLevel,
} = require('../integrations/codebase-study-engine');

const DEFAULT_CRON = '*/15 * * * *';
const DEFAULT_VERSION_INTENT = 'fix';
const VALID_VERSION_INTENTS = new Set(['feature', 'fix', 'breaking', 'internal']);

let _db = null;

function init(deps = {}) {
  if (deps.db) {
    _db = deps.db;
  }
  return module.exports;
}

function normalizeVersionIntent(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return VALID_VERSION_INTENTS.has(normalized) ? normalized : null;
}

function resolveVersionIntent(value) {
  return normalizeVersionIntent(value) || DEFAULT_VERSION_INTENT;
}

function buildStudyService() {
  if (!_db) {
    throw new Error('Codebase study handlers require init({ db }) before use');
  }

  return createCodebaseStudy({
    db: _db,
    taskCore,
    logger: baseLogger,
  });
}

function resolveWorkingDirectoryArg(args) {
  const workingDirectory = typeof args?.working_directory === 'string' ? args.working_directory.trim() : '';
  if (!workingDirectory) {
    return { error: makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required') };
  }
  return { workingDirectory: path.resolve(workingDirectory) };
}

function formatStudyStatus(title, payload) {
  let text = `## ${title}\n\n`;
  text += `**Working Directory:** ${payload.working_directory}\n`;
  if (payload.reason) {
    text += `**Reason:** ${payload.reason}\n`;
  }
  if (payload.task_id) {
    text += `**Task ID:** ${payload.task_id}\n`;
  }
  if (payload.task_status) {
    text += `**Task Status:** ${payload.task_status}\n`;
  }
  text += `**Run Count:** ${payload.run_count ?? 0}\n`;
  text += `**Tracked Files:** ${payload.tracked_count ?? 0}\n`;
  text += `**Pending Files:** ${payload.pending_count ?? 0}\n`;
  text += `**Up To Date Files:** ${payload.up_to_date_count ?? 0}\n`;
  if (payload.module_entry_count !== undefined) {
    text += `**Module Entries:** ${payload.module_entry_count}\n`;
  }
  if (payload.subsystem_count !== undefined) {
    text += `**Subsystems:** ${payload.subsystem_count}\n`;
  }
  if (payload.flow_count !== undefined) {
    text += `**Flow Maps:** ${payload.flow_count}\n`;
  }
  if (payload.hotspot_count !== undefined) {
    text += `**Hotspots:** ${payload.hotspot_count}\n`;
  }
  if (payload.invariant_count !== undefined) {
    text += `**Invariants:** ${payload.invariant_count}\n`;
  }
  if (payload.failure_mode_count !== undefined) {
    text += `**Failure Modes:** ${payload.failure_mode_count}\n`;
  }
  if (payload.trace_count !== undefined) {
    text += `**Canonical Traces:** ${payload.trace_count}\n`;
  }
  if (payload.playbook_count !== undefined) {
    text += `**Change Playbooks:** ${payload.playbook_count}\n`;
  }
  if (payload.test_area_count !== undefined) {
    text += `**Test Areas:** ${payload.test_area_count}\n`;
  }
  if (payload.delta_significance_level) {
    text += `**Delta Significance:** ${payload.delta_significance_level}\n`;
  }
  if (payload.delta_significance_score !== undefined) {
    text += `**Delta Score:** ${payload.delta_significance_score}\n`;
  }
  if (payload.proposal_count !== undefined) {
    text += `**Suggested Proposals:** ${payload.proposal_count}\n`;
  }
  if (payload.submitted_proposal_count !== undefined) {
    text += `**Submitted Proposals:** ${payload.submitted_proposal_count}\n`;
  }
  if (payload.proposal_significance_level) {
    text += `**Proposal Threshold Level:** ${payload.proposal_significance_level}\n`;
  }
  if (payload.proposal_min_score !== undefined) {
    text += `**Proposal Minimum Score:** ${payload.proposal_min_score}\n`;
  }
  if (payload.evaluation_grade || payload.evaluation_score !== undefined) {
    text += `**Pack Evaluation:** ${payload.evaluation_grade || 'n/a'} (${payload.evaluation_score ?? 0})\n`;
  }
  if (payload.evaluation_readiness) {
    text += `**Pack Readiness:** ${payload.evaluation_readiness}\n`;
  }
  if (payload.evaluation_findings_count !== undefined) {
    text += `**Evaluation Findings:** ${payload.evaluation_findings_count}\n`;
  }
  if (payload.index_strategy) {
    text += `**Index Strategy:** ${payload.index_strategy}\n`;
  }
  if (payload.summary_strategy) {
    text += `**Summary Strategy:** ${payload.summary_strategy}\n`;
  }
  if (payload.last_processed_count) {
    text += `**Processed This Run:** ${payload.last_processed_count}\n`;
  }
  if (payload.batch_count) {
    text += `**Batches This Run:** ${payload.batch_count}\n`;
  }
  if (payload.last_removed_count) {
    text += `**Removed This Run:** ${payload.last_removed_count}\n`;
  }
  if (payload.last_sha) {
    text += `**Last SHA:** ${payload.last_sha}\n`;
  }
  if (payload.current_sha) {
    text += `**Current SHA:** ${payload.current_sha}\n`;
  }
  if (payload.last_run_at) {
    text += `**Last Run:** ${payload.last_run_at}\n`;
  }
  if (payload.last_completed_at) {
    text += `**Last Completed:** ${payload.last_completed_at}\n`;
  }
  if (payload.last_summary_updated_at) {
    text += `**Summary Updated:** ${payload.last_summary_updated_at}\n`;
  }
  if (payload.knowledge_pack_updated_at) {
    text += `**Knowledge Pack Updated:** ${payload.knowledge_pack_updated_at}\n`;
  }
  if (payload.evaluation_generated_at) {
    text += `**Evaluation Updated:** ${payload.evaluation_generated_at}\n`;
  }
  if (payload.benchmark_grade || payload.benchmark_score !== undefined) {
    text += `**Pack Benchmark:** ${payload.benchmark_grade || 'n/a'} (${payload.benchmark_score ?? 0})\n`;
  }
  if (payload.benchmark_readiness) {
    text += `**Benchmark Readiness:** ${payload.benchmark_readiness}\n`;
  }
  if (payload.benchmark_findings_count !== undefined) {
    text += `**Benchmark Findings:** ${payload.benchmark_findings_count}\n`;
  }
  if (payload.benchmark_case_count !== undefined) {
    text += `**Benchmark Cases:** ${payload.benchmark_case_count}\n`;
  }
  if (payload.benchmark_generated_at) {
    text += `**Benchmark Updated:** ${payload.benchmark_generated_at}\n`;
  }
  if (payload.study_impact?.task_outcomes) {
    const withContext = payload.study_impact.task_outcomes.with_context || {};
    const withoutContext = payload.study_impact.task_outcomes.without_context || {};
    text += `**Impact Window:** ${payload.study_impact.window_days || 30} days\n`;
    text += `**Impact Samples:** ${withContext.count || 0} with study context / ${withoutContext.count || 0} without\n`;
    if (payload.study_impact.task_outcomes.delta?.comparison_available) {
      text += `**Success Rate Delta:** ${payload.study_impact.task_outcomes.delta.success_rate_points ?? 0} pts\n`;
    }
  }
  if (payload.last_delta_updated_at) {
    text += `**Study Delta Updated:** ${payload.last_delta_updated_at}\n`;
  }
  if (payload.last_result) {
    text += `**Last Result:** ${payload.last_result}\n`;
  }
  if (payload.last_error) {
    text += `\n### Last Error\n${payload.last_error}\n`;
  }
  if (Array.isArray(payload.batch_files) && payload.batch_files.length > 0) {
    text += `\n### Batch Files\n`;
    payload.batch_files.forEach(file => {
      text += `- ${file}\n`;
    });
  }
  if (Array.isArray(payload.pending_files) && payload.pending_files.length > 0) {
    text += `\n### Pending Files\n`;
    payload.pending_files.slice(0, 10).forEach(file => {
      text += `- ${file}\n`;
    });
    if (payload.pending_files.length > 10) {
      text += `- ... and ${payload.pending_files.length - 10} more\n`;
    }
  }
  if (Array.isArray(payload.removed_files) && payload.removed_files.length > 0) {
    text += `\n### Removed Files\n`;
    payload.removed_files.forEach(file => {
      text += `- ${file}\n`;
    });
  }
  return text.trim();
}

function withStudyImpact(workingDirectory, payload) {
  return {
    ...payload,
    study_impact: getStudyImpactSummary({
      workingDirectory,
      sinceDays: 30,
    }),
  };
}

function buildStudyScheduleTaskConfig({
  workingDirectory,
  project,
  versionIntent,
  submitProposals,
  proposalLimit,
  proposalSignificanceLevel,
  proposalMinScore,
}) {
  const normalizedProject = project || path.basename(workingDirectory);
  const taskConfig = {
    task: `Run the codebase study loop for ${workingDirectory}`,
    working_directory: workingDirectory,
    project: normalizedProject,
    version_intent: versionIntent,
    timeout_minutes: 30,
    auto_approve: true,
    tags: ['codebase-study', 'auto-generated'],
    tool_name: 'run_codebase_study',
    tool_args: {
      working_directory: workingDirectory,
      project: normalizedProject,
      submit_proposals: submitProposals,
      proposal_significance_level: proposalSignificanceLevel,
      proposal_min_score: proposalMinScore ?? DEFAULT_PROPOSAL_MIN_SCORE,
    },
  };
  if (proposalLimit) {
    taskConfig.tool_args.proposal_limit = proposalLimit;
  }
  return taskConfig;
}

function createOrUpdateStudySchedule({
  workingDirectory,
  scheduleName,
  cronExpression,
  enabled,
  timezone,
  versionIntent,
  project,
  submitProposals,
  proposalLimit,
  proposalSignificanceLevel,
  proposalMinScore,
}) {
  const existing = schedulingAutomation
    .listScheduledTasks({ enabled_only: false, limit: 1000 })
    .find((schedule) => schedule && schedule.name === scheduleName);

  const taskConfig = buildStudyScheduleTaskConfig({
    workingDirectory,
    project,
    versionIntent,
    submitProposals,
    proposalLimit,
    proposalSignificanceLevel,
    proposalMinScore,
  });

  const schedule = existing
    ? schedulingAutomation.updateScheduledTask(existing.id, {
        cron_expression: cronExpression,
        timezone,
        enabled,
        version_intent: versionIntent,
        task_description: taskConfig.task,
        task_config: taskConfig,
      })
    : schedulingAutomation.createCronScheduledTask({
        name: scheduleName,
        cron_expression: cronExpression,
        enabled,
        timezone,
        version_intent: versionIntent,
        task_config: taskConfig,
      });

  return {
    schedule,
    created: !existing,
    updated: Boolean(existing),
    taskConfig,
  };
}

async function handleRunCodebaseStudy(args) {
  try {
    const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
    if (error) {
      return error;
    }

    if (args?.proposal_significance_level !== undefined
      && !normalizeStudyThresholdLevel(args?.proposal_significance_level, null)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'proposal_significance_level must be one of: none, baseline, low, moderate, high, critical');
    }
    if (args?.proposal_min_score !== undefined
      && (!Number.isInteger(args.proposal_min_score) || args.proposal_min_score < 0)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'proposal_min_score must be a non-negative integer');
    }

    const result = await buildStudyService().runStudyCycle(workingDirectory, {
      currentTaskId: typeof args?.__scheduledTaskId === 'string' ? args.__scheduledTaskId : null,
      manualRunNow: args?.__manualRunNow === true,
      forceRefresh: args?.force_refresh === true || args?.__manualRunNow === true,
      scheduleId: typeof args?.__scheduledScheduleId === 'string' ? args.__scheduledScheduleId : null,
      scheduleName: typeof args?.__scheduledScheduleName === 'string' ? args.__scheduledScheduleName : null,
      scheduleRunId: typeof args?.__scheduledRunId === 'string' ? args.__scheduledRunId : null,
      maxBatches: Number.isInteger(args?.max_batches) ? args.max_batches : undefined,
      submitProposals: args?.submit_proposals === true,
      proposalLimit: Number.isInteger(args?.proposal_limit) ? args.proposal_limit : undefined,
      proposalSignificanceLevel: normalizeStudyThresholdLevel(
        args?.proposal_significance_level,
        DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL
      ),
      proposalMinScore: Number.isInteger(args?.proposal_min_score) ? args.proposal_min_score : undefined,
      project: typeof args?.project === 'string' ? args.project : undefined,
    });
    const payload = withStudyImpact(workingDirectory, result);
    return {
      content: [{ type: 'text', text: formatStudyStatus(result.skipped ? 'Codebase Study Skipped' : 'Codebase Study Run', payload) }],
      structuredData: payload,
    };
  } catch (studyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, studyError.message || String(studyError));
  }
}

async function handleGetStudyStatus(args) {
  try {
    const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
    if (error) {
      return error;
    }

    const result = withStudyImpact(workingDirectory, await buildStudyService().getStudyStatus(workingDirectory));
    return {
      content: [{ type: 'text', text: formatStudyStatus('Codebase Study Status', result) }],
      structuredData: result,
    };
  } catch (studyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, studyError.message || String(studyError));
  }
}

async function handleEvaluateCodebaseStudy(args) {
  try {
    const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
    if (error) {
      return error;
    }

    const result = withStudyImpact(workingDirectory, await buildStudyService().evaluateStudy(workingDirectory));
    return {
      content: [{ type: 'text', text: formatStudyStatus('Codebase Study Evaluation', result) }],
      structuredData: result,
    };
  } catch (studyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, studyError.message || String(studyError));
  }
}

async function handleBenchmarkCodebaseStudy(args) {
  try {
    const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
    if (error) {
      return error;
    }

    const result = withStudyImpact(workingDirectory, await buildStudyService().benchmarkStudy(workingDirectory));
    return {
      content: [{ type: 'text', text: formatStudyStatus('Codebase Study Benchmark', result) }],
      structuredData: result,
    };
  } catch (studyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, studyError.message || String(studyError));
  }
}

async function handleGetCodebaseStudyProfileOverride(args) {
  try {
    const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
    if (error) {
      return error;
    }

    const result = await buildStudyService().getStudyProfileOverrideStatus(workingDirectory);
    return {
      content: [{ type: 'text', text: formatStudyStatus('Codebase Study Profile Override', result) }],
      structuredData: result,
    };
  } catch (studyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, studyError.message || String(studyError));
  }
}

async function handleSaveCodebaseStudyProfileOverride(args) {
  try {
    const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
    if (error) {
      return error;
    }

    const override = args?.override;
    if ((override === undefined || override === null || override === '') && args?.clear !== true) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'override is required unless clear is true');
    }

    const result = await buildStudyService().saveStudyProfileOverride(workingDirectory, override, {
      clear: args?.clear === true,
    });
    return {
      content: [{ type: 'text', text: formatStudyStatus('Saved Codebase Study Profile Override', result) }],
      structuredData: result,
    };
  } catch (studyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, studyError.message || String(studyError));
  }
}

async function handlePreviewCodebaseStudyBootstrap(args) {
  try {
    const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
    if (error) {
      return error;
    }

    const proposalSignificanceLevel = args?.proposal_significance_level === undefined || args?.proposal_significance_level === null || args?.proposal_significance_level === ''
      ? DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL
      : normalizeStudyThresholdLevel(args?.proposal_significance_level, null);
    const proposalMinScore = Number.isInteger(args?.proposal_min_score) ? args?.proposal_min_score : null;
    const initialMaxBatches = Number.isInteger(args?.initial_max_batches) ? args.initial_max_batches : DEFAULT_BOOTSTRAP_BATCHES;

    if (args?.proposal_significance_level !== undefined && !proposalSignificanceLevel) {
      return makeError(ErrorCodes.INVALID_PARAM, 'proposal_significance_level must be one of: none, baseline, low, moderate, high, critical');
    }
    if (args?.proposal_min_score !== undefined && (!Number.isInteger(args.proposal_min_score) || args.proposal_min_score < 0)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'proposal_min_score must be a non-negative integer');
    }
    if (args?.proposal_limit !== undefined && (!Number.isInteger(args.proposal_limit) || args.proposal_limit <= 0)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'proposal_limit must be a positive integer');
    }
    if (args?.initial_max_batches !== undefined && (!Number.isInteger(args.initial_max_batches) || args.initial_max_batches <= 0)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'initial_max_batches must be a positive integer');
    }

    const result = withStudyImpact(workingDirectory, await buildStudyService().previewBootstrapStudy(workingDirectory, {
      project: typeof args?.project === 'string' ? args.project : undefined,
      scheduleName: typeof args?.name === 'string' ? args.name : undefined,
      cronExpression: typeof args?.cron_expression === 'string' ? args.cron_expression : undefined,
      timezone: typeof args?.timezone === 'string' ? args.timezone : undefined,
      versionIntent: resolveVersionIntent(args?.version_intent),
      submitProposals: args?.submit_proposals === true,
      proposalLimit: Number.isInteger(args?.proposal_limit) ? args.proposal_limit : undefined,
      proposalSignificanceLevel,
      proposalMinScore: proposalMinScore ?? DEFAULT_PROPOSAL_MIN_SCORE,
      initialMaxBatches,
    }));
    return {
      content: [{ type: 'text', text: formatStudyStatus('Codebase Study Bootstrap Preview', result) }],
      structuredData: result,
    };
  } catch (studyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, studyError.message || String(studyError));
  }
}

async function handleBootstrapCodebaseStudy(args) {
  try {
    const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
    if (error) {
      return error;
    }

    const cronExpression = typeof args?.cron_expression === 'string' && args.cron_expression.trim()
      ? args.cron_expression.trim()
      : DEFAULT_BOOTSTRAP_CRON;
    const scheduleName = typeof args?.name === 'string' && args.name.trim()
      ? args.name.trim()
      : `codebase-study:${path.basename(workingDirectory)}`;
    const enabled = args?.enabled !== false;
    const timezone = typeof args?.timezone === 'string' && args.timezone.trim()
      ? args.timezone.trim()
      : null;
    const versionIntent = resolveVersionIntent(args?.version_intent);
    const submitProposals = args?.submit_proposals === true;
    const proposalLimit = Number.isInteger(args?.proposal_limit) ? args.proposal_limit : null;
    const proposalSignificanceLevel = args?.proposal_significance_level === undefined || args?.proposal_significance_level === null || args?.proposal_significance_level === ''
      ? DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL
      : normalizeStudyThresholdLevel(args?.proposal_significance_level, null);
    const proposalMinScore = Number.isInteger(args?.proposal_min_score) ? args?.proposal_min_score : null;
    const initialMaxBatches = Number.isInteger(args?.initial_max_batches) ? args.initial_max_batches : DEFAULT_BOOTSTRAP_BATCHES;
    const createSchedule = args?.create_schedule !== false;
    const runInitialStudy = args?.run_initial_study !== false;
    const runBenchmark = args?.run_benchmark !== false;
    const writeProfileScaffold = args?.write_profile_scaffold === true;

    if (args?.proposal_significance_level !== undefined && !proposalSignificanceLevel) {
      return makeError(ErrorCodes.INVALID_PARAM, 'proposal_significance_level must be one of: none, baseline, low, moderate, high, critical');
    }
    if (args?.proposal_min_score !== undefined && (!Number.isInteger(args.proposal_min_score) || args.proposal_min_score < 0)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'proposal_min_score must be a non-negative integer');
    }
    if (args?.proposal_limit !== undefined && (!Number.isInteger(args.proposal_limit) || args.proposal_limit <= 0)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'proposal_limit must be a positive integer');
    }
    if (args?.initial_max_batches !== undefined && (!Number.isInteger(args.initial_max_batches) || args.initial_max_batches <= 0)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'initial_max_batches must be a positive integer');
    }

    const result = withStudyImpact(workingDirectory, await buildStudyService().bootstrapStudy(workingDirectory, {
      project: typeof args?.project === 'string' ? args.project : undefined,
      runInitialStudy,
      runBenchmark,
      initialMaxBatches,
      scheduleName,
      cronExpression,
      timezone,
      versionIntent,
      submitProposals,
      proposalLimit,
      proposalSignificanceLevel,
      proposalMinScore: proposalMinScore ?? DEFAULT_PROPOSAL_MIN_SCORE,
      writeProfileScaffold,
    }));

    let scheduleMetadata = null;
    if (createSchedule) {
      const scheduleResult = createOrUpdateStudySchedule({
        workingDirectory,
        scheduleName,
        cronExpression,
        enabled,
        timezone,
        versionIntent,
        project: typeof args?.project === 'string' ? args.project : undefined,
        submitProposals,
        proposalLimit,
        proposalSignificanceLevel: proposalSignificanceLevel || DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL,
        proposalMinScore: proposalMinScore ?? DEFAULT_PROPOSAL_MIN_SCORE,
      });
      scheduleMetadata = {
        schedule_id: scheduleResult.schedule.id,
        name: scheduleResult.schedule.name,
        cron_expression: scheduleResult.schedule.cron_expression,
        enabled: scheduleResult.schedule.enabled,
        timezone: scheduleResult.schedule.timezone || null,
        next_run_at: scheduleResult.schedule.next_run_at || null,
        created: scheduleResult.created,
        updated: scheduleResult.updated,
      };
    }

    const structuredData = {
      ...result,
      schedule: scheduleMetadata,
    };
    return {
      content: [{ type: 'text', text: formatStudyStatus('Codebase Study Bootstrap', structuredData) }],
      structuredData,
    };
  } catch (studyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, studyError.message || String(studyError));
  }
}

async function handleResetCodebaseStudy(args) {
  try {
    const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
    if (error) {
      return error;
    }

    const result = await buildStudyService().resetStudy(workingDirectory);
    return {
      content: [{ type: 'text', text: formatStudyStatus('Codebase Study Reset', result) }],
      structuredData: result,
    };
  } catch (studyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, studyError.message || String(studyError));
  }
}

async function handleConfigureStudySchedule(args) {
  try {
    const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
    if (error) {
      return error;
    }

    const cronExpression = typeof args?.cron_expression === 'string' && args.cron_expression.trim()
      ? args.cron_expression.trim()
      : DEFAULT_CRON;
    const scheduleName = typeof args?.name === 'string' && args.name.trim()
      ? args.name.trim()
      : `codebase-study:${path.basename(workingDirectory)}`;
    const enabled = args?.enabled !== false;
    const timezone = typeof args?.timezone === 'string' && args.timezone.trim()
      ? args.timezone.trim()
      : null;
    const versionIntent = resolveVersionIntent(args?.version_intent);
    const submitProposals = args?.submit_proposals === true;
    const proposalLimit = Number.isInteger(args?.proposal_limit) ? args.proposal_limit : null;
    const proposalSignificanceLevel = args?.proposal_significance_level === undefined || args?.proposal_significance_level === null || args?.proposal_significance_level === ''
      ? DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL
      : normalizeStudyThresholdLevel(args?.proposal_significance_level, null);
    const proposalMinScore = Number.isInteger(args?.proposal_min_score) ? args.proposal_min_score : null;
    if (args?.version_intent !== undefined && typeof args.version_intent !== 'string') {
      return makeError(ErrorCodes.INVALID_PARAM, 'version_intent must be a string');
    }
    if (args?.version_intent !== undefined && !normalizeVersionIntent(args.version_intent)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'version_intent must be one of: feature, fix, breaking, internal');
    }
    if (args?.submit_proposals !== undefined && typeof args.submit_proposals !== 'boolean') {
      return makeError(ErrorCodes.INVALID_PARAM, 'submit_proposals must be a boolean');
    }
    if (args?.proposal_limit !== undefined && (!Number.isInteger(args.proposal_limit) || args.proposal_limit <= 0)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'proposal_limit must be a positive integer');
    }
    if (args?.proposal_significance_level !== undefined && !proposalSignificanceLevel) {
      return makeError(ErrorCodes.INVALID_PARAM, 'proposal_significance_level must be one of: none, baseline, low, moderate, high, critical');
    }
    if (args?.proposal_min_score !== undefined && (!Number.isInteger(args.proposal_min_score) || args.proposal_min_score < 0)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'proposal_min_score must be a non-negative integer');
    }

    const { schedule } = createOrUpdateStudySchedule({
      workingDirectory,
      scheduleName,
      cronExpression,
      enabled,
      timezone,
      versionIntent,
      project: args?.project || path.basename(workingDirectory),
      submitProposals,
      proposalLimit,
      proposalSignificanceLevel,
      proposalMinScore: proposalMinScore ?? DEFAULT_PROPOSAL_MIN_SCORE,
    });

    let text = '## Codebase Study Schedule\n\n';
    text += `**Name:** ${schedule.name}\n`;
    text += `**ID:** ${schedule.id}\n`;
    text += `**Cron:** \`${schedule.cron_expression}\`\n`;
    text += `**Working Directory:** ${workingDirectory}\n`;
    text += `**Enabled:** ${schedule.enabled ? 'Yes' : 'No'}\n`;
    if (schedule.timezone) {
      text += `**Timezone:** ${schedule.timezone}\n`;
    }
    if (schedule.next_run_at) {
      text += `**Next Run:** ${schedule.next_run_at}\n`;
    }
    text += `**Tool:** run_codebase_study\n`;
    text += `**Auto-Submit Proposals:** ${submitProposals ? 'Yes' : 'No'}\n`;
    text += `**Proposal Threshold Level:** ${proposalSignificanceLevel}\n`;
    text += `**Proposal Minimum Score:** ${proposalMinScore ?? DEFAULT_PROPOSAL_MIN_SCORE}\n`;
    if (proposalLimit) {
      text += `**Proposal Limit:** ${proposalLimit}\n`;
    }

    return {
      content: [{ type: 'text', text }],
      structuredData: {
        schedule_id: schedule.id,
        name: schedule.name,
        cron_expression: schedule.cron_expression,
        working_directory: workingDirectory,
        enabled: schedule.enabled,
        timezone: schedule.timezone || null,
        next_run_at: schedule.next_run_at || null,
        submit_proposals: submitProposals,
        proposal_significance_level: proposalSignificanceLevel,
        proposal_min_score: proposalMinScore ?? DEFAULT_PROPOSAL_MIN_SCORE,
        proposal_limit: proposalLimit,
      },
    };
  } catch (scheduleError) {
    return makeError(ErrorCodes.OPERATION_FAILED, scheduleError.message || String(scheduleError));
  }
}

module.exports = {
  init,
  handleRunCodebaseStudy,
  handleGetStudyStatus,
  handleEvaluateCodebaseStudy,
  handleBenchmarkCodebaseStudy,
  handleGetCodebaseStudyProfileOverride,
  handleSaveCodebaseStudyProfileOverride,
  handlePreviewCodebaseStudyBootstrap,
  handleBootstrapCodebaseStudy,
  handleResetCodebaseStudy,
  handleConfigureStudySchedule,
};
