'use strict';

/**
 * Canonical task finalization path.
 *
 * All close/error handlers should route terminalization through finalizeTask()
 * so validation, fallback checks, metadata recording, and completion/failure
 * event emission happen exactly once.
 */

const logger = require('../logger').child({ component: 'task-finalizer' });
const modelCapabilities = require('../db/model-capabilities');
const perfTracker = require('../db/provider-performance');
const { recordStudyTaskCompleted } = require('../db/study-telemetry');
const { smartDiagnosisStage } = require('./smart-diagnosis-stage');
const { strategicReviewStage } = require('./strategic-review-stage');
const { createVerificationLedgerStage } = require('./verification-ledger-stage');
const { createAdversarialReviewStage } = require('./adversarial-review-stage');
const { runPhantomSuccessDetection } = require('../validation/phantom-success-detector');
const { parseDiffusionSignal } = require('../diffusion/signal-parser');
const { parseComputeOutput, validateComputeSchema } = require('../diffusion/compute-output-parser');
const { expandApplyTaskDescription } = require('../diffusion/planner');
const resumeContextUtils = require('../utils/resume-context');
const { v4: uuidv4 } = require('uuid');

let deps = {};
let handleVerificationLedger = null;
let handleAdversarialReview = null;
const finalizationLocks = new Map();

function resetForTest() {
  deps = {};
  handleVerificationLedger = null;
  handleAdversarialReview = null;
  finalizationLocks.clear();
}

function init(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
  if (deps.db && typeof deps.db.getDbInstance === 'function') {
    perfTracker.setDb(deps.db);
  }

  handleVerificationLedger = typeof deps.handleVerificationLedger === 'function' ? deps.handleVerificationLedger : handleVerificationLedger;
  handleAdversarialReview = typeof deps.handleAdversarialReview === 'function' ? deps.handleAdversarialReview : handleAdversarialReview;

  try {
    const { defaultContainer } = require('../container');
    if (typeof handleVerificationLedger !== 'function' && defaultContainer && typeof defaultContainer.has === 'function' && typeof defaultContainer.get === 'function') {
      const vl = defaultContainer.has('verificationLedger') ? defaultContainer.get('verificationLedger') : null;
      const pc = defaultContainer.has('projectConfigCore') ? defaultContainer.get('projectConfigCore') : null;
      if (vl && pc) {
        handleVerificationLedger = createVerificationLedgerStage({
          verificationLedger: vl,
          projectConfigCore: pc,
        });
      }
    }
  } catch (_) {
    // not available
  }

  try {
    const { defaultContainer } = require('../container');
    if (typeof handleAdversarialReview !== 'function' && defaultContainer && typeof defaultContainer.has === 'function' && typeof defaultContainer.get === 'function') {
      const ar = defaultContainer.has('adversarialReviews') ? defaultContainer.get('adversarialReviews') : null;
      const fra = defaultContainer.has('fileRiskAdapter') ? defaultContainer.get('fileRiskAdapter') : null;
      const tc = defaultContainer.has('taskCore') ? defaultContainer.get('taskCore') : null;
      const tm = defaultContainer.has('taskManager') ? defaultContainer.get('taskManager') : null;
      const pc = defaultContainer.has('projectConfigCore') ? defaultContainer.get('projectConfigCore') : null;
      if (ar && fra && tc && tm && pc) {
        handleAdversarialReview = createAdversarialReviewStage({
          adversarialReviews: ar,
          fileRiskAdapter: fra,
          taskCore: tc,
          taskManager: tm,
          verificationLedger: defaultContainer.has('verificationLedger') ? defaultContainer.get('verificationLedger') : null,
          projectConfigCore: pc,
        });
      }
    }
  } catch (_err) {
    // not available
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFinalizableStatus(status) {
  return status === 'running' || status === 'completion_pending';
}

function normalizeExitCode(exitCode) {
  if (exitCode === 0 || exitCode === '0') return 0;
  const parsed = Number.parseInt(exitCode, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

function buildCombinedOutput(output, errorOutput) {
  if (output && errorOutput) return `${output}\n${errorOutput}`;
  return output || errorOutput || '';
}

function appendErrorOutput(current, message) {
  if (!message) return current || '';
  if (!current) return message;
  return `${current}\n${message}`;
}

function parseMetadata(rawMetadata) {
  if (!rawMetadata) return {};
  if (typeof rawMetadata === 'object' && rawMetadata !== null) return { ...rawMetadata };
  if (typeof rawMetadata !== 'string') return {};
  try {
    const parsed = JSON.parse(rawMetadata);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

function mergeTaskMetadata(task, ctx) {
  return {
    ...parseMetadata(task?.metadata),
    ...parseMetadata(ctx?.task?.metadata),
  };
}

function parseFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstFiniteNumber(candidates) {
  for (const candidate of candidates) {
    const numeric = parseFiniteNumber(candidate);
    if (numeric !== null) return numeric;
  }
  return null;
}

function normalizeQualityScore(value) {
  const numeric = parseFiniteNumber(value);
  if (numeric === null) return null;
  const normalized = numeric > 1 ? numeric / 100 : numeric;
  if (normalized <= 0) return 0;
  if (normalized >= 1) return 1;
  return normalized;
}

function parseTimestampMs(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getProviderScoringService() {
  if (deps.providerScoring && typeof deps.providerScoring.recordTaskCompletion === 'function') {
    return deps.providerScoring;
  }
  return require('../db/provider-scoring');
}

function getRawDbInstance() {
  if (deps.rawDb && typeof deps.rawDb.prepare === 'function') return deps.rawDb;
  if (deps.db && typeof deps.db.getDbInstance === 'function') return deps.db.getDbInstance();
  if (deps.db && typeof deps.db.prepare === 'function') return deps.db;

  try {
    const { getModule } = require('../container');
    const injectedDb = getModule('db');
    if (injectedDb && typeof injectedDb.getDbInstance === 'function') {
      return injectedDb.getDbInstance();
    }
    return injectedDb && typeof injectedDb.prepare === 'function' ? injectedDb : null;
  } catch (_err) {
    return null;
  }
}

function getDurationMsForScoring(task) {
  const startedAt = parseTimestampMs(task?.started_at);
  if (!startedAt) return 0;

  const completedAt = parseTimestampMs(task?.completed_at) || Date.now();
  return Math.max(0, completedAt - startedAt);
}

function buildFailedTaskResumeContext(task, taskOutput, errorOutput, durationMs) {
  try {
    return resumeContextUtils.buildResumeContext(
      taskOutput || task?.output || '',
      errorOutput || task?.error_output || '',
      {
        task_description: task?.task_description,
        durationMs,
        provider: task?.provider,
      }
    );
  } catch (err) {
    logger.info(`[finalizer] Resume context build failed: ${err.message}`);
    return null;
  }
}

function getCostUsdForScoring(task, metadata) {
  const cost = firstFiniteNumber([
    task?.cost_usd,
    task?.estimated_cost_usd,
    task?.estimated_cost,
    task?.cost_estimate,
    metadata?.cost_usd,
    metadata?.estimated_cost_usd,
    metadata?.estimated_cost,
    metadata?.cost_estimate,
    metadata?.provider_usage?.cost_estimate,
    metadata?.token_usage?.estimated_cost_usd,
    metadata?.token_usage?.cost_usd,
    metadata?.agentic_token_usage?.estimated_cost_usd,
    metadata?.agentic_token_usage?.cost_usd,
  ]);

  return cost !== null && cost > 0 ? cost : 0;
}

function getQualityScoreForScoring(task, success, metadata) {
  const explicitQuality = firstFiniteNumber([
    task?.quality_score,
    task?.qualityScore,
    metadata?.provider_scoring?.quality_score,
    metadata?.provider_scoring?.qualityScore,
    metadata?.quality_score,
    metadata?.qualityScore,
    metadata?.finalization?.quality_score,
    metadata?.finalization?.qualityScore,
    metadata?.finalization?.verify_command_result?.quality_score,
    metadata?.finalization?.verify_command_result?.qualityScore,
    metadata?.verify_command_result?.quality_score,
    metadata?.verify_command_result?.qualityScore,
    metadata?.verification?.quality_score,
    metadata?.verification?.qualityScore,
    metadata?.strategic_review?.quality_score,
    metadata?.strategic_review?.qualityScore,
  ]);
  const normalizedExplicit = normalizeQualityScore(explicitQuality);
  if (normalizedExplicit !== null) return normalizedExplicit;

  try {
    if (deps.db && typeof deps.db.getQualityScore === 'function' && task?.id) {
      const row = deps.db.getQualityScore(task.id);
      const persisted = normalizeQualityScore(row?.overall_score);
      if (persisted !== null) return persisted;
    }
  } catch (err) {
    logger.info(`[finalizer] Provider quality score lookup failed: ${err.message}`);
  }

  return success ? 0.7 : 0.0;
}

function recordProviderScoring(ctx) {
  try {
    const task = ctx?.task || {};
    const provider = String(task.provider || ctx?.proc?.provider || '').trim();
    if (!provider) return;

    const scoring = getProviderScoringService();
    const rawDb = getRawDbInstance();
    if (rawDb && typeof scoring.init === 'function') {
      scoring.init(rawDb);
    }

    const metadata = parseMetadata(task.metadata);
    const success = ctx.status === 'completed';
    scoring.recordTaskCompletion({
      provider,
      success,
      durationMs: getDurationMsForScoring(task),
      costUsd: getCostUsdForScoring(task, metadata),
      qualityScore: getQualityScoreForScoring(task, success, metadata),
    });
  } catch (err) {
    logger.info(`[finalizer] Provider scoring recording failed: ${err.message}`);
  }
}

async function indexRunArtifacts(taskId, workflowId = null) {
  try {
    const { defaultContainer } = require('../container');
    if (!defaultContainer || typeof defaultContainer.has !== 'function' || !defaultContainer.has('runDirManager')) {
      return;
    }
    const manager = defaultContainer.get('runDirManager');
    if (!manager || typeof manager.indexFiles !== 'function') {
      return;
    }
    await manager.indexFiles(taskId, { workflowId });
  } catch (err) {
    logger.info(`[finalizer] Run artifact indexing failed for ${taskId}: ${err.message}`);
  }
}

function snapshotCtx(ctx) {
  return {
    status: ctx.status,
    code: ctx.code,
    earlyExit: ctx.earlyExit === true,
    output: ctx.output || '',
    errorOutput: ctx.errorOutput || '',
  };
}

function describeStageOutcome(before, after) {
  if (after.earlyExit && !before.earlyExit) return 'early_exit';
  if (before.status !== after.status) return `status:${after.status}`;
  if (before.code !== after.code) return 'exit_code_adjusted';
  if (before.output !== after.output || before.errorOutput !== after.errorOutput) return 'output_mutated';
  return 'no_change';
}

function buildValidationMetadata(task, ctx, rawExitCode) {
  const metadata = mergeTaskMetadata(task, ctx);
  const priorFinalization = (metadata.finalization && typeof metadata.finalization === 'object')
    ? metadata.finalization
    : {};
  return {
    ...metadata,
    finalization: {
      ...priorFinalization,
      finalized_at: new Date().toISOString(),
      raw_exit_code: rawExitCode,
      final_exit_code: ctx.code,
      final_status: ctx.status,
      validation_stage_outcomes: ctx.validationStages,
    },
  };
}

function categorizeFailure(ctx) {
  const output = typeof ctx?.output === 'string' ? ctx.output.trim() : ctx?.output;
  const errorOutput = typeof ctx?.errorOutput === 'string' ? ctx.errorOutput.trim() : '';
  const validationText = ctx?.validationStages ? JSON.stringify(ctx.validationStages) : '';
  const haystack = `${errorOutput}\n${validationText}`;

  if (/ERROR:\s*\{"detail":/i.test(haystack) || /\bmodel\b.*\bnot (supported|found)\b/i.test(haystack) || /\binvalid\s+api\s*key\b/i.test(haystack) || /\bauthentication\s+failed\b/i.test(haystack) || /\binsufficient[_ ]quota\b/i.test(haystack)) {
    return 'api_error';
  }
  if (/parse error|no edits found/i.test(haystack) || (/HASHLINE_EDIT/i.test(haystack) && /failed/i.test(haystack))) {
    return 'parse_error';
  }
  if (/SyntaxError|syntax gate|brace imbalance/i.test(haystack)) {
    return 'syntax_error';
  }
  if (/TS\d{4}/i.test(haystack) || /\bTypeError\b/i.test(haystack)) {
    return 'type_error';
  }
  if ((/FAIL/i.test(haystack) && /\btest\b/i.test(haystack)) || /AssertionError|vitest/i.test(haystack)) {
    return 'test_failure';
  }
  if (/timeout|timed out|SIGTERM/i.test(haystack)) {
    return 'timeout';
  }
  if (!output && !errorOutput) {
    return 'empty_output';
  }
  if (/\[auto-verify\]/i.test(haystack)) {
    return 'verify_failure';
  }
  if ((/format/i.test(haystack) && /mismatch/i.test(haystack)) || (/SEARCH\/REPLACE/i.test(haystack) && /fail/i.test(haystack))) {
    return 'format_mismatch';
  }
  return 'unknown';
}

async function runStage(ctx, name, handler, shouldRun = true) {
  if (!shouldRun) {
    ctx.validationStages[name] = {
      outcome: 'skipped',
      status_before: ctx.status,
      status_after: ctx.status,
      code_before: ctx.code,
      code_after: ctx.code,
      early_exit: ctx.earlyExit === true,
    };
    return;
  }

  const before = snapshotCtx(ctx);
  const startedAt = Date.now();

  try {
    await Promise.resolve(handler(ctx));
  } catch (err) {
    ctx.pipelineError = true;
    ctx.status = 'failed';
    ctx.code = normalizeExitCode(ctx.code);
    if (ctx.code === 0) ctx.code = 1;
    ctx.errorOutput = appendErrorOutput(ctx.errorOutput, `[FINALIZER ${name} ERROR] ${err.message}`);
    ctx.validationStages[name] = {
      outcome: 'error',
      status_before: before.status,
      status_after: ctx.status,
      code_before: before.code,
      code_after: ctx.code,
      early_exit: ctx.earlyExit === true,
      duration_ms: Date.now() - startedAt,
      error: err.message,
    };
    logger.info(`[TaskFinalizer] Stage ${name} failed for ${ctx.taskId}: ${err.message}`);
    return;
  }

  if (ctx.status === 'failed' && ctx.code === 0) {
    ctx.code = 1;
  }

  const after = snapshotCtx(ctx);
  ctx.validationStages[name] = {
    outcome: describeStageOutcome(before, after),
    status_before: before.status,
    status_after: after.status,
    code_before: before.code,
    code_after: after.code,
    early_exit: after.earlyExit,
    duration_ms: Date.now() - startedAt,
  };
}

async function waitForTaskLock(taskId) {
  const startedAt = Date.now();
  while (finalizationLocks.get(taskId)) {
    await sleep(10);
    if (Date.now() - startedAt > 10000) {
      break;
    }
  }
}

async function acquireTaskLock(taskId, options = {}) {
  const maxWaitMs = options.maxWaitMs || 300000; // 5 minutes default
  const startTime = Date.now();

  while (true) {
    if (Date.now() - startTime > maxWaitMs) {
      throw new Error(`acquireTaskLock timed out after ${maxWaitMs}ms for task ${taskId}`);
    }
    await waitForTaskLock(taskId);
    if (!finalizationLocks.get(taskId)) {
      finalizationLocks.set(taskId, true);
      return;
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

function triggerStrategicHooks(ctx) {
  try {
    const strategicHooks = require('./strategic-hooks');
    if (ctx.status === 'failed') {
      setImmediate(() => strategicHooks.onTaskFailed(ctx).catch(() => {}));
    } else if (ctx.status === 'completed') {
      setImmediate(() => strategicHooks.onTaskCompleted(ctx).catch(() => {}));
    }
  } catch (err) {
    logger.info(`[TaskFinalizer] Strategic hook dispatch failed for ${ctx?.taskId || 'unknown'}: ${err.message}`);
  }
}

function recordProviderPerformance(ctx) {
  try {
    const provider = ctx?.task?.provider;
    if (!provider) return;
    const durationSeconds = ctx.task.started_at
      ? Math.round((Date.now() - new Date(ctx.task.started_at).getTime()) / 1000)
      : null;
    perfTracker.recordTaskOutcome({
      provider,
      taskType: perfTracker.inferTaskType(ctx.task.task_description || ''),
      durationSeconds,
      success: ctx.status === 'completed',
      resubmitted: false,
      autoCheckPassed: ctx.status === 'completed',
    });
  } catch (err) {
    logger.info(`[finalizer] Provider performance recording failed: ${err.message}`);
  }
}

function handleDiffusionSignalDetection(ctx) {
  try {
    const signal = parseDiffusionSignal(ctx.output || '');
    if (signal) {
      const task = deps.db.getTask(ctx.taskId);
      const existingMeta = task && task.metadata
        ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata)
        : {};
      existingMeta.diffusion_request = signal;
      if (typeof deps.db.updateTask === 'function') {
        deps.db.updateTask(ctx.taskId, { metadata: JSON.stringify(existingMeta) });
      }
      logger.info(`[Diffusion] Task ${ctx.taskId} emitted diffusion request: ${signal.summary}`);
    }
  } catch (err) {
    logger.debug(`[Diffusion] Phase 2.5 non-critical error: ${err.message}`);
  }
}

function handleComputeApplyCreation(ctx) {
  try {
    const task = deps.db.getTask(ctx.taskId);
    const meta = task?.metadata
      ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata)
      : {};

    if (meta.diffusion_role !== 'compute' || ctx.status !== 'completed') return;

    const parsed = parseComputeOutput(ctx.output || '');
    if (!parsed) {
      logger.info(`[Diffusion] Compute task ${ctx.taskId} produced unparseable output — marking failed`);
      if (typeof deps.db.updateTaskStatus === 'function') {
        deps.db.updateTaskStatus(ctx.taskId, 'failed');
      }
      ctx.status = 'failed';
      return;
    }

    const validation = validateComputeSchema(parsed);
    if (!validation.valid) {
      logger.info(`[Diffusion] Compute task ${ctx.taskId} schema invalid: ${validation.errors.join('; ')}`);
      if (typeof deps.db.updateTaskStatus === 'function') {
        deps.db.updateTaskStatus(ctx.taskId, 'failed');
      }
      ctx.status = 'failed';
      return;
    }

    // Create the apply task dynamically — round-robin across available providers
    const applyProviderList = Array.isArray(meta.apply_providers) && meta.apply_providers.length > 0
      ? meta.apply_providers
      : [meta.apply_provider || 'ollama'];
    const applyIndex = parseInt(ctx.taskId.replace(/[^0-9a-f]/g, '').slice(-4), 16) % applyProviderList.length;
    const applyProvider = applyProviderList[applyIndex];
    const workingDir = task.working_directory;
    const applyDesc = expandApplyTaskDescription(parsed, workingDir);
    const applyId = uuidv4();

    deps.db.createTask({
      id: applyId,
      status: 'queued',
      task_description: applyDesc,
      working_directory: workingDir,
      workflow_id: task.workflow_id,
      provider: applyProvider,
      metadata: JSON.stringify({
        diffusion: true,
        diffusion_role: 'apply',
        compute_task_id: ctx.taskId,
        compute_output: parsed,
        auto_verify_on_completion: true,
        verify_command: meta.verify_command || null,
        user_provider_override: true,
        requested_provider: applyProvider,
      }),
    });

    logger.info(`[Diffusion] Created apply task ${applyId} from compute ${ctx.taskId} (${parsed.file_edits.length} file edits)`);

    // Update workflow counts so await_workflow tracks the new apply task
    if (task.workflow_id) {
      try {
        const workflowEngine = require('../db/workflow-engine');
        workflowEngine.updateWorkflowCounts(task.workflow_id);
        const wf = workflowEngine.getWorkflow(task.workflow_id);
        if (wf && wf.status === 'completed') {
          workflowEngine.updateWorkflow(task.workflow_id, { status: 'running' });
          logger.info(`[Diffusion] Reopened workflow ${task.workflow_id} — apply tasks still pending`);
        }
      } catch (wfErr) {
        logger.info(`[Diffusion] Workflow count update error: ${wfErr.message}`);
      }
    }

    // Start the apply task
    try {
      const taskManager = require('../task-manager');
      const startPromise = taskManager.startTask(applyId);
      if (startPromise && typeof startPromise.catch === 'function') {
        startPromise.catch(err => logger.info(`[Diffusion] Async failure starting apply task ${applyId}: ${err.message}`));
      }
    } catch (err) {
      logger.info(`[Diffusion] Failed to auto-start apply task ${applyId}: ${err.message}`);
    }
  } catch (err) {
    logger.debug(`[Diffusion] Compute→apply hook non-critical error: ${err.message}`);
  }
}

async function finalizeTask(taskId, options = {}) {
  if (!deps.db || typeof deps.db.getTask !== 'function') {
    throw new Error('task-finalizer not initialized with db dependency');
  }

  await acquireTaskLock(taskId);

  let ctx = null;
  try {
    const task = deps.db.getTask(taskId);
    if (!task) {
      return { finalized: false, queueManaged: false, task: null, reason: 'not_found' };
    }
    if (!isFinalizableStatus(task.status)) {
      return {
        finalized: false,
        queueManaged: false,
        task,
        reason: `status:${task.status}`,
      };
    }

    const rawExitCode = normalizeExitCode(options.exitCode);
    const procState = options.procState || options.proc || {};
    const output = options.output !== undefined
      ? options.output
      : (procState.output !== undefined ? procState.output : (task.output || ''));
    const errorOutput = options.errorOutput !== undefined
      ? options.errorOutput
      : (procState.errorOutput !== undefined ? procState.errorOutput : (task.error_output || ''));
    const combinedOutput = buildCombinedOutput(output, errorOutput);
    const filesModified = Array.isArray(options.filesModified)
      ? [...new Set(options.filesModified)]
      : (typeof deps.extractModifiedFiles === 'function'
        ? deps.extractModifiedFiles(combinedOutput)
        : []);

    ctx = {
      taskId,
      code: rawExitCode,
      rawExitCode,  // immutable — original process exit code before pipeline stages modify ctx.code
      status: rawExitCode === 0 ? 'completed' : 'failed',
      task,
      proc: {
        ...procState,
        output,
        errorOutput,
        provider: procState.provider || task.provider || null,
        baselineCommit: procState.baselineCommit || null,
        rawExitCode,  // also on proc for close-phases access
      },
      filesModified,
      output,
      errorOutput,
      earlyExit: false,
      validationStages: {},
      pipelineError: false,
    };

    await runStage(ctx, 'retry_logic', deps.handleRetryLogic, ctx.code !== 0);
    if (ctx.earlyExit) {
      return {
        finalized: false,
        queueManaged: true,
        task: deps.db.getTask(taskId) || task,
        status: deps.db.getTask(taskId)?.status || ctx.status,
        validationStages: ctx.validationStages,
        reason: 'early_exit',
      };
    }

    await runStage(ctx, 'safeguard_checks', deps.handleSafeguardChecks, typeof deps.handleSafeguardChecks === 'function');
    if (ctx.earlyExit) {
      return {
        finalized: false,
        queueManaged: true,
        task: deps.db.getTask(taskId) || task,
        status: deps.db.getTask(taskId)?.status || ctx.status,
        validationStages: ctx.validationStages,
        reason: 'early_exit',
      };
    }

    // Phase 2.5: Diffusion signal detection — check output for __DIFFUSION_REQUEST__ blocks
    await runStage(ctx, 'diffusion_signal_detection', handleDiffusionSignalDetection, ctx.code === 0);

    await runStage(ctx, 'compute_apply_creation', handleComputeApplyCreation, ctx.code === 0);

    await runStage(ctx, 'fuzzy_repair', deps.handleFuzzyRepair, typeof deps.handleFuzzyRepair === 'function');
    await runStage(ctx, 'no_file_change_detection', deps.handleNoFileChangeDetection, typeof deps.handleNoFileChangeDetection === 'function');
    await runStage(ctx, 'phantom_success_detection', (stageCtx) => runPhantomSuccessDetection(stageCtx, {
      getRawDb: getRawDbInstance,
      logDecision: deps.logFactoryDecision,
    }), ctx.status === 'completed');
    if (ctx.earlyExit) {
      return {
        finalized: false,
        queueManaged: true,
        task: deps.db.getTask(taskId) || task,
        status: deps.db.getTask(taskId)?.status || ctx.status,
        validationStages: ctx.validationStages,
        reason: 'early_exit',
      };
    }

    await runStage(ctx, 'sandbox_revert_detection', deps.handleSandboxRevertDetection, typeof deps.handleSandboxRevertDetection === 'function');
    await runStage(ctx, 'auto_validation', deps.handleAutoValidation, typeof deps.handleAutoValidation === 'function');
    await runStage(ctx, 'build_test_style_commit', deps.handleBuildTestStyleCommit, typeof deps.handleBuildTestStyleCommit === 'function');
    await runStage(ctx, 'auto_verify_retry', deps.handleAutoVerifyRetry, typeof deps.handleAutoVerifyRetry === 'function');
    await runStage(ctx, 'verification_ledger', handleVerificationLedger, typeof handleVerificationLedger === 'function');
    if (ctx.earlyExit) {
      return {
        finalized: false,
        queueManaged: true,
        task: deps.db.getTask(taskId) || task,
        status: deps.db.getTask(taskId)?.status || ctx.status,
        validationStages: ctx.validationStages,
        reason: 'early_exit',
      };
    }

    await runStage(ctx, 'adversarial_review', handleAdversarialReview, typeof handleAdversarialReview === 'function' && ctx.status === 'completed');

    // Experiment 5: Smart failure diagnosis — analyzes error patterns and
    // sets recovery hints (suggested_provider, needs_escalation) for downstream stages
    await runStage(ctx, 'smart_diagnosis', smartDiagnosisStage, ctx.status === 'failed');

    // Experiment 4: Strategic review — deterministic quality gate for tasks
    // flagged needs_review: true. Rejects tasks with critical validation failures.
    await runStage(ctx, 'strategic_review', strategicReviewStage, ctx.status === 'completed');

    ctx.proc.output = ctx.output;
    ctx.proc.errorOutput = ctx.errorOutput;

    await runStage(
      ctx,
      'provider_failover',
      deps.handleProviderFailover,
      typeof deps.handleProviderFailover === 'function' && !ctx.pipelineError
    );
    if (ctx.earlyExit) {
      return {
        finalized: false,
        queueManaged: true,
        task: deps.db.getTask(taskId) || task,
        status: deps.db.getTask(taskId)?.status || ctx.status,
        validationStages: ctx.validationStages,
        reason: 'early_exit',
      };
    }

    recordProviderPerformance(ctx);

    ctx.code = ctx.status === 'completed'
      ? 0
      : (ctx.code === 0 ? 1 : normalizeExitCode(ctx.code));

    try {
      const taskType = modelCapabilities.classifyTaskType(ctx.task.task_description || '');
      const language = modelCapabilities.detectTaskLanguage(ctx.task.task_description || '', ctx.filesModified || []);
      const success = ctx.status === 'completed';
      const duration = ctx.task.started_at
        ? Math.round((Date.now() - new Date(ctx.task.started_at).getTime()) / 1000)
        : null;
      const failureCategory = success ? null : categorizeFailure(ctx);
      modelCapabilities.recordTaskOutcome(
        ctx.task.model || ctx.task.provider || 'unknown',
        taskType,
        language,
        success,
        duration,
        failureCategory
      );
    } catch (outcomeErr) {
      logger.info(`[finalizer] Outcome recording failed: ${outcomeErr.message}`);
    }

    const metadata = buildValidationMetadata(task, ctx, rawExitCode);
    const sanitizedOutput = typeof deps.sanitizeTaskOutput === 'function'
      ? deps.sanitizeTaskOutput(ctx.output)
      : ctx.output;
    const resumeDurationMs = getDurationMsForScoring(task);
    const resumeContext = ctx.status === 'failed'
      ? buildFailedTaskResumeContext(task, sanitizedOutput, ctx.errorOutput, resumeDurationMs)
      : null;
    const statusFields = {
      exit_code: ctx.code,
      output: sanitizedOutput,
      error_output: ctx.errorOutput,
      files_modified: ctx.filesModified,
      progress_percent: ctx.status === 'completed' ? 100 : 0,
      metadata,
    };
    if (resumeContext) {
      statusFields.resume_context = resumeContext;
    }
    const updateTaskStatus = deps.safeUpdateTaskStatus || deps.db.updateTaskStatus;
    updateTaskStatus(taskId, ctx.status, statusFields);

    ctx.task = deps.db.getTask(taskId) || task;
    try {
      const { snapshotTaskState } = require('../checkpoints/snapshot');
      // Fire-and-forget — checkpoint must not block finalization
      Promise.resolve().then(() => snapshotTaskState({
        project_root: ctx.task.working_directory,
        task_id: taskId,
        task_label: (ctx.task.task_description || '').slice(0, 80),
      })).catch(err => logger.info(`[checkpoints] snapshot failed: ${err.message}`));
    } catch { /* module unavailable */ }

    await indexRunArtifacts(taskId, ctx.task?.workflow_id || task?.workflow_id || null);
    try {
      recordStudyTaskCompleted(ctx.task);
    } catch (studyTelemetryErr) {
      logger.info(`[finalizer] Study telemetry recording failed: ${studyTelemetryErr.message}`);
    }

    recordProviderScoring(ctx);

    try {
      const budgetWatcher = require('../db/budget-watcher');
      const inst = getRawDbInstance();
      if (inst && task.provider) {
        budgetWatcher.init(inst);
        const check = budgetWatcher.checkBudgetThresholds(task.provider);
        if (check && check.thresholdBreached === 'downgrade') {
          try { require('../logger').info('[budget] ' + task.provider + ' at ' + check.spendPercent + '% — activating Cost Saver template'); } catch {}
          try {
            const routing = require('../db/provider-routing-core');
            if (typeof routing.activateRoutingTemplate === 'function') {
              routing.activateRoutingTemplate('Cost Saver');
            }
          } catch { /* routing template activation is best-effort */ }
        }
      }
    } catch (_e) { /* non-critical */ }

    if (typeof deps.handlePostCompletion === 'function') {
      try {
        await Promise.resolve(deps.handlePostCompletion(ctx));
      } catch (postErr) {
        logger.error(`[finalizer] Post-completion failed for ${taskId}: ${postErr.message}`);
        // Don't re-throw — the task IS completed, only the cleanup/notification step failed
      }
    }

    // Strategic brain hooks (fire-and-forget, never blocks finalization)
    triggerStrategicHooks(ctx);

    return {
      finalized: true,
      queueManaged: false,
      task: deps.db.getTask(taskId) || ctx.task,
      status: ctx.status,
      validationStages: ctx.validationStages,
    };
  } catch (err) {
    logger.info(`[TaskFinalizer] finalizeTask fatal error for ${taskId}: ${err.message}`);

    const currentTask = deps.db.getTask(taskId);
    if (!currentTask || !isFinalizableStatus(currentTask.status)) {
      return {
        finalized: false,
        queueManaged: false,
        task: currentTask,
        reason: `fatal:${err.message}`,
      };
    }

    const rawExitCode = normalizeExitCode(options.exitCode);
    const fallbackCtx = ctx || {
      taskId,
      code: rawExitCode === 0 ? 1 : rawExitCode,
      status: 'failed',
      output: options.output || '',
      errorOutput: options.errorOutput || '',
      validationStages: {},
      task: currentTask,
      proc: {
        output: options.output || '',
        errorOutput: options.errorOutput || '',
        provider: currentTask.provider || null,
        baselineCommit: null,
      },
    };

    fallbackCtx.status = 'failed';
    fallbackCtx.code = fallbackCtx.code === 0 ? 1 : normalizeExitCode(fallbackCtx.code);
    fallbackCtx.errorOutput = appendErrorOutput(
      fallbackCtx.errorOutput,
      `Internal finalizer error: ${err.message}`
    );
    fallbackCtx.validationStages.fatal = {
      outcome: 'error',
      error: err.message,
      status_after: 'failed',
      code_after: fallbackCtx.code,
      early_exit: false,
    };

    const fallbackOutput = typeof deps.sanitizeTaskOutput === 'function'
      ? deps.sanitizeTaskOutput(fallbackCtx.output)
      : fallbackCtx.output;
    const fallbackResumeContext = buildFailedTaskResumeContext(
      currentTask,
      fallbackOutput,
      fallbackCtx.errorOutput,
      getDurationMsForScoring(currentTask)
    );
    const fallbackFields = {
      exit_code: fallbackCtx.code,
      output: fallbackOutput,
      error_output: fallbackCtx.errorOutput,
      files_modified: fallbackCtx.filesModified || [],
      progress_percent: 0,
      metadata: buildValidationMetadata(currentTask, fallbackCtx, rawExitCode),
    };
    if (fallbackResumeContext) {
      fallbackFields.resume_context = fallbackResumeContext;
    }
    const updateTaskStatus = deps.safeUpdateTaskStatus || deps.db.updateTaskStatus;
    updateTaskStatus(taskId, 'failed', fallbackFields);

    fallbackCtx.task = deps.db.getTask(taskId) || currentTask;
    await indexRunArtifacts(taskId, fallbackCtx.task?.workflow_id || currentTask?.workflow_id || null);
    recordProviderScoring(fallbackCtx);

    if (typeof deps.handlePostCompletion === 'function') {
      try {
        await Promise.resolve(deps.handlePostCompletion(fallbackCtx));
      } catch (postErr) {
        logger.info(`[TaskFinalizer] Post-completion failed after fatal finalization error for ${taskId}: ${postErr.message}`);
      }
    }

    // Strategic brain hooks (fire-and-forget, never blocks finalization)
    triggerStrategicHooks(fallbackCtx);

    return {
      finalized: true,
      queueManaged: false,
      task: deps.db.getTask(taskId) || fallbackCtx.task,
      status: 'failed',
      validationStages: fallbackCtx.validationStages,
      reason: `fatal:${err.message}`,
    };
  } finally {
    finalizationLocks.delete(taskId);
  }
}

// ── Factory (DI Phase 3) ─────────────────────────────────────────────────

function createTaskFinalizer(_deps) {
  // _deps reserved for dependency-boundary follow-up
  return {
    init,
    finalizeTask,
    _testing: {
      get finalizationLocks() {
        return finalizationLocks;
      },
      categorizeFailure,
      resetForTest,
    },
  };
}

module.exports = {
  init,
  finalizeTask,
  _testing: {
    get finalizationLocks() {
      return finalizationLocks;
    },
    categorizeFailure,
    resetForTest,
  },
  createTaskFinalizer,
};
