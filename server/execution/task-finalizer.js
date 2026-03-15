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
const { smartDiagnosisStage } = require('./smart-diagnosis-stage');
const { strategicReviewStage } = require('./strategic-review-stage');

let deps = {};
const finalizationLocks = new Map();

function init(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
  if (deps.db && typeof deps.db.getDbInstance === 'function') {
    perfTracker.setDb(deps.db);
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
  const metadata = parseMetadata(task?.metadata);
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

async function acquireTaskLock(taskId) {
  while (true) {
    await waitForTaskLock(taskId);
    if (!finalizationLocks.get(taskId)) {
      finalizationLocks.set(taskId, true);
      return;
    }
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
      status: rawExitCode === 0 ? 'completed' : 'failed',
      task,
      proc: {
        ...procState,
        output,
        errorOutput,
        provider: procState.provider || task.provider || null,
        baselineCommit: procState.baselineCommit || null,
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

    await runStage(ctx, 'fuzzy_repair', deps.handleFuzzyRepair, typeof deps.handleFuzzyRepair === 'function');
    await runStage(ctx, 'no_file_change_detection', deps.handleNoFileChangeDetection, typeof deps.handleNoFileChangeDetection === 'function');
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
    const sanitizedOutput = typeof deps.sanitizeAiderOutput === 'function'
      ? deps.sanitizeAiderOutput(ctx.output)
      : ctx.output;
    const updateTaskStatus = deps.safeUpdateTaskStatus || deps.db.updateTaskStatus;
    updateTaskStatus(taskId, ctx.status, {
      exit_code: ctx.code,
      output: sanitizedOutput,
      error_output: ctx.errorOutput,
      files_modified: ctx.filesModified,
      progress_percent: ctx.status === 'completed' ? 100 : 0,
      metadata,
    });

    ctx.task = deps.db.getTask(taskId) || task;

    if (typeof deps.handlePostCompletion === 'function') {
      await Promise.resolve(deps.handlePostCompletion(ctx));
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

    const updateTaskStatus = deps.safeUpdateTaskStatus || deps.db.updateTaskStatus;
    updateTaskStatus(taskId, 'failed', {
      exit_code: fallbackCtx.code,
      output: typeof deps.sanitizeAiderOutput === 'function'
        ? deps.sanitizeAiderOutput(fallbackCtx.output)
        : fallbackCtx.output,
      error_output: fallbackCtx.errorOutput,
      files_modified: fallbackCtx.filesModified || [],
      progress_percent: 0,
      metadata: buildValidationMetadata(currentTask, fallbackCtx, rawExitCode),
    });

    fallbackCtx.task = deps.db.getTask(taskId) || currentTask;

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

module.exports = {
  init,
  finalizeTask,
  _testing: {
    get finalizationLocks() {
      return finalizationLocks;
    },
    categorizeFailure,
    resetForTest() {
      finalizationLocks.clear();
    },
  },
};
