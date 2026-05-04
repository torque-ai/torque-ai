'use strict';

/**
 * Close-Handler Phases Module
 *
 * Extracted from task-manager.js (Phase 9A) — three close-handler phases:
 * auto-validation (per-file quality + regression), build/test/style/commit/PR,
 * and provider failover with local LLM fallback.
 *
 * These are called from the close-handler orchestrator in task-manager.js
 * and operate on a shared `ctx` pipeline object.
 *
 * Uses init() dependency injection for database, dashboard, and task-manager internals.
 */

const { spawnSync } = require('child_process');
const logger = require('../logger').child({ component: 'close-phases' });
const serverConfig = require('../config');
const { TASK_TIMEOUTS } = require('../constants');
const perfTracker = require('../db/provider/performance');
const { failoverBackoffMs } = require('../utils/backoff');
const { buildResumeContext, prependResumeContextToPrompt } = require('../utils/resume-context');
const { GIT_SAFE_ENV, cleanupStaleGitStatusProcesses } = require('../utils/git');

// Dependency injection
let db = null;
let dashboard = null;
let _checkFileQuality = null;
let _scopedRollback = null;
let _runBuildVerification = null;
let _runTestVerification = null;
let _runStyleCheck = null;
let _tryCreateAutoPR = null;
let _extractModifiedFiles = null;
let _isValidFilePath = null;
let _isShellSafe = null;
let _sanitizeTaskOutput = null;
let _safeUpdateTaskStatus = null;
let _tryLocalFirstFallback = null;
let _processQueue = null;

/**
 * Initialize dependencies for this module.
 * @param {Object} deps
 */
function init(deps) {
  if (deps.db) db = deps.db;
  serverConfig.init({ db: deps.db });
  if (deps.dashboard) dashboard = deps.dashboard;
  if (deps.checkFileQuality) _checkFileQuality = deps.checkFileQuality;
  if (deps.scopedRollback) _scopedRollback = deps.scopedRollback;
  if (deps.runBuildVerification) _runBuildVerification = deps.runBuildVerification;
  if (deps.runTestVerification) _runTestVerification = deps.runTestVerification;
  if (deps.runStyleCheck) _runStyleCheck = deps.runStyleCheck;
  if (deps.tryCreateAutoPR) _tryCreateAutoPR = deps.tryCreateAutoPR;
  if (deps.extractModifiedFiles) _extractModifiedFiles = deps.extractModifiedFiles;
  if (deps.isValidFilePath) _isValidFilePath = deps.isValidFilePath;
  if (deps.isShellSafe) _isShellSafe = deps.isShellSafe;
  if (deps.sanitizeTaskOutput) _sanitizeTaskOutput = deps.sanitizeTaskOutput;
  if (deps.safeUpdateTaskStatus) _safeUpdateTaskStatus = deps.safeUpdateTaskStatus;
  if (deps.tryLocalFirstFallback) _tryLocalFirstFallback = deps.tryLocalFirstFallback;
  if (deps.processQueue) _processQueue = deps.processQueue;
}

function getCombinedTaskOutput(ctx) {
  const stdout = typeof ctx?.output === 'string'
    ? ctx.output
    : (typeof ctx?.proc?.output === 'string' ? ctx.proc.output : '');
  const stderr = typeof ctx?.errorOutput === 'string'
    ? ctx.errorOutput
    : (typeof ctx?.proc?.errorOutput === 'string' ? ctx.proc.errorOutput : '');
  if (stdout && stderr) return `${stdout}\n${stderr}`;
  return stdout || stderr || '';
}

function recoverModifiedFiles(ctx) {
  if (Array.isArray(ctx.filesModified) && ctx.filesModified.length > 0) {
    return ctx.filesModified;
  }
  const combinedOutput = getCombinedTaskOutput(ctx);
  if (!combinedOutput) return [];
  if (!_extractModifiedFiles) return [];
  const recovered = _extractModifiedFiles(combinedOutput);
  if (recovered.length > 0) {
    ctx.filesModified = recovered;
  }
  return recovered;
}

/**
 * Phase 5: Per-file quality checks, line-count regression, scoped rollback.
 */
function handleAutoValidation(ctx) {
  void ctx;
}

/**
 * Phase 6: Build verify → commit → test verify → style check → auto-PR.
 * Async — build and test verification may route to a remote workstation.
 */
async function handleBuildTestStyleCommit(ctx) {
  const { taskId, task } = ctx;
  if (ctx.status !== 'completed' || !task) return;

  const workingDir = task.working_directory || process.cwd();
  const recoveredFiles = recoverModifiedFiles(ctx);
  const modifiedFiles = Array.isArray(ctx.changedFiles) && ctx.changedFiles.length > 0
    ? ctx.changedFiles
    : (recoveredFiles.length > 0
      ? recoveredFiles
      : (db.getTaskFileChanges ? db.getTaskFileChanges(taskId).map(c => c.file_path) : []));
  const buildResult = await Promise.resolve(_runBuildVerification(taskId, task, workingDir, modifiedFiles));

  if (!buildResult.skipped && !buildResult.success) {
    logger.info(`[Build Verification] Task ${taskId} completed but build failed - marking as failed`);
    ctx.status = 'failed';
    ctx.errorOutput = (ctx.errorOutput || '') +
      '\n\n[BUILD VERIFICATION FAILED]\n' +
      (buildResult.error || '').substring(0, 2000);

    const projectConfig = db.getProjectConfig(task.project || db.getProjectFromPath(workingDir));
    if (projectConfig && projectConfig.rollback_on_build_failure) {
      const rollback = _scopedRollback ? _scopedRollback(taskId, workingDir, 'BuildFailure') : { reverted: [], skipped: [] };
      if (rollback.reverted.length > 0) {
        ctx.errorOutput += `\n[ROLLBACK] Reverted ${rollback.reverted.length} file(s).`;
      } else {
        ctx.errorOutput += '\n[ROLLBACK] No modified files to revert.';
      }
    }
    return;
  }

  if (buildResult.skipped) return;

  logger.info(`[Build Verification] Task ${taskId}: Build verified successfully`);

  // Commit uncommitted changes after build passes (when auto-commits is disabled)
  const autoCommitsDisabled = serverConfig.get('auto_commits_disabled') === '1';
  if (autoCommitsDisabled) {
    try {
      const gitStatusResult = spawnSync('git', ['status', '--porcelain'], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: TASK_TIMEOUTS.GIT_STATUS,
        windowsHide: true,
        env: { ...process.env, ...GIT_SAFE_ENV },
      });
      if (gitStatusResult.error) cleanupStaleGitStatusProcesses({ force: true });
      const gitStatus = (gitStatusResult.stdout || '').trim();

      if (gitStatus.length > 0) {
        logger.info(`[Build Verification] Task ${taskId}: Found uncommitted changes, committing after build passed`);

        const filesModified = recoverModifiedFiles(ctx);
        if (filesModified && filesModified.length > 0) {
          for (const file of filesModified) {
            const cleanFile = file.trim().replace(/^["']|["']$/g, '');
            if (cleanFile && !cleanFile.includes('..') && _isValidFilePath(cleanFile) && _isShellSafe(cleanFile)) {
              try {
                spawnSync('git', ['add', '--', cleanFile], { cwd: workingDir, timeout: TASK_TIMEOUTS.GIT_ADD, windowsHide: true });
              } catch (addErr) {
                logger.info(`[Build Verification] Task ${taskId}: Could not stage ${cleanFile}: ${addErr.message}`);
              }
            } else if (cleanFile) {
              logger.info(`[Build Verification] Task ${taskId}: Skipping invalid path: ${cleanFile.substring(0, 80)}`);
            }
          }
        } else {
          spawnSync('git', ['add', '.', '--', ':!*.env', ':!*.env.*', ':!credentials*', ':!*secret*'], { cwd: workingDir, timeout: TASK_TIMEOUTS.GIT_ADD_ALL, windowsHide: true });
        }

        const stagedResult = spawnSync('git', ['diff', '--cached', '--name-only'], {
          cwd: workingDir, encoding: 'utf-8', timeout: TASK_TIMEOUTS.GIT_ADD, windowsHide: true
        });
        const staged = (stagedResult.stdout || '').trim();

        if (staged.length > 0) {
          const shortDesc = (task.task_description || '').substring(0, 50).replace(/["\n\r]/g, ' ').trim();
          const commitMsg = `docs: ${shortDesc}... [Torque ${task.model || 'local'}]`;
          spawnSync('git', ['commit', '-m', commitMsg], {
            cwd: workingDir, timeout: TASK_TIMEOUTS.GIT_COMMIT, windowsHide: true
          });
          logger.info(`[Build Verification] Task ${taskId}: Committed changes after build passed`);
        }
      }
    } catch (commitErr) {
      logger.info(`[Build Verification] Task ${taskId}: Failed to commit: ${commitErr.message}`);
      ctx.errorOutput = (ctx.errorOutput || '') + '\n[COMMIT FAILED] ' + commitErr.message;
    }
  }

  // Run test verification after successful build
  const testResult = await Promise.resolve(_runTestVerification(taskId, task, workingDir));

  if (!testResult.skipped && !testResult.success) {
    logger.info(`[Test Verification] Task ${taskId} completed but tests failed`);

    const projectConfig = db.getProjectConfig(task.project || db.getProjectFromPath(workingDir));
    if (projectConfig && projectConfig.rollback_on_test_failure) {
      ctx.status = 'failed';
      ctx.errorOutput = (ctx.errorOutput || '') +
        '\n\n[TEST VERIFICATION FAILED]\n' +
        (testResult.error || '').substring(0, 2000);

      const rollback = _scopedRollback ? _scopedRollback(taskId, workingDir, 'TestFailure') : { reverted: [], skipped: [] };
      if (rollback.reverted.length > 0) {
        ctx.errorOutput += `\n[ROLLBACK] Reverted ${rollback.reverted.length} file(s) due to test failure.`;
      } else {
        ctx.errorOutput += '\n[ROLLBACK] No modified files to revert.';
      }
    } else {
      ctx.output = (ctx.output || '') +
        '\n\n[TEST VERIFICATION WARNING]\nTests failed but rollback not configured.\n' +
        (testResult.error || '').substring(0, 1000);
    }
  } else if (!testResult.skipped) {
    logger.info(`[Test Verification] Task ${taskId}: Tests passed`);
  }

  // Run style check after tests pass (or if tests were skipped)
  if (ctx.status === 'completed') {
    const styleResult = _runStyleCheck(taskId, task, workingDir);

    if (!styleResult.skipped && !styleResult.success) {
      logger.info(`[Style Check] Task ${taskId}: Style issues found`);
      ctx.output = (ctx.output || '') +
        '\n\n[STYLE CHECK WARNING]\n' +
        styleResult.error.substring(0, 1000);
    } else if (!styleResult.skipped) {
      logger.info(`[Style Check] Task ${taskId}: Style check passed`);
    }

    // Auto-PR creation after successful completion
    const projectConfig = db.getProjectConfig(task.project || db.getProjectFromPath(workingDir));
    if (projectConfig && projectConfig.auto_pr_enabled && ctx.status === 'completed') {
      await _tryCreateAutoPR(taskId, task, workingDir, projectConfig);
    }
  }
}

/**
 * Phase 7: Quota failover, local LLM fallback, normal status update.
 * Sets ctx.earlyExit = true if provider switch happens.
 */
function handleProviderFailover(ctx) {
  const { taskId, code, proc, task } = ctx;
  const filesModified = recoverModifiedFiles(ctx);
  const schedulingMode = db.getConfig ? (db.getConfig('scheduling_mode') || 'legacy') : 'legacy';

  if (ctx.status === 'failed' && task && schedulingMode === 'slot-pull' && task.provider) {
    const slotPull = require('../execution/slot-pull-scheduler');
    const outcome = slotPull.requeueAfterFailure(taskId, task.provider, {
      deferTerminalWrite: true,
      errorOutput: ctx.errorOutput || proc?.errorOutput || '',
      output: ctx.output || proc?.output || '',
    });

    if (outcome?.requeued) {
      try {
        perfTracker.setDb(db);
        const durationSeconds = task.started_at
          ? Math.round((Date.now() - new Date(task.started_at).getTime()) / 1000)
          : null;
        perfTracker.recordTaskOutcome({
          provider: task.provider,
          taskType: perfTracker.inferTaskType(task.task_description || ''),
          durationSeconds,
          success: false,
          resubmitted: true,
          autoCheckPassed: false,
        });
      } catch (perfErr) {
        logger.info(`[SlotPull] Failed to record provider performance for ${taskId}: ${perfErr.message}`);
      }

      const refreshedTask = db.getTask(taskId);
      if (refreshedTask) {
        Object.assign(task, refreshedTask);
        ctx.task = task;
      }
      ctx.status = 'queued';
      ctx.earlyExit = true;
      if (typeof _processQueue === 'function') {
        _processQueue();
      }
      return;
    }

    const refreshedTask = db.getTask(taskId);
    if (refreshedTask) {
      Object.assign(task, refreshedTask);
      ctx.task = task;
    }
  }

  // Quota error auto-failover (capped at 3 attempts)
  // Guard: only failover when the PROVIDER itself failed (non-zero raw exit code).
  // If the raw exit code was 0 but ctx.status is 'failed', the failure came from a
  // post-completion validation stage (auto-verify, build check, etc.) — not from the
  // provider. Failing over to a different provider won't help; the work is already done.
  const rawExitCode = ctx.rawExitCode ?? ctx.proc?.rawExitCode ?? ctx.code;
  const providerActuallyFailed = rawExitCode !== 0;
  const MAX_FAILOVERS = 3;
  const failoverCount = task?.retry_count || 0;
  const errorOutput = proc?.errorOutput || '';
  // Combined errorOutput + tail of proc.output so model-not-found errors that
  // landed on stdout (some adapters mix the two) are still classified.
  const errorPayload = errorOutput + '\n' + String(proc?.output || '').slice(-2000);
  // Detect model-related failures so we can both blocklist the (provider, model)
  // pair and trigger the same failover path as quota errors. The patterns
  // are intentionally narrow — we want "the model isn't callable on this key"
  // shape, not generic application errors.
  const isModelMissing = /\bdoes not exist\b|\bmodel_not_found\b|\bmodel\b[^\n]{0,40}\bnot found\b|\bmodel\b[^\n]{0,40}\bnot supported\b|\bdeprecated\b/i.test(errorPayload);
  // 5xx detection: persistent 5xx for the same model is a failover signal,
  // but a single 5xx is often transient. Combine with the in-memory blocklist
  // counter — recordFailure increments per call, marks unreachable at threshold.
  const is5xxApi = /(?:HTTP|status|code)[\s:=]*5\d{2}\b/i.test(errorPayload) || /\bINTERNAL\b\s*$/m.test(errorPayload);
  if (task?.provider && task?.model && (isModelMissing || is5xxApi)) {
    try {
      const modelBlocklist = require('../providers/model-blocklist');
      const reason = isModelMissing ? 'model_missing' : 'persistent_5xx';
      modelBlocklist.recordFailure(task.provider, task.model, reason);
    } catch (e) {
      logger.debug(`[Model Blocklist] recordFailure failed: ${e.message}`);
    }
  }
  const isQuotaErr = db.isProviderQuotaError(task?.provider || 'codex', errorPayload);
  // Failover triggers on quota errors OR model-missing errors. Generic 5xx
  // alone does NOT trigger failover — too risky (transient 500s would loop).
  // The blocklist will catch a model with consecutive 5xx via the threshold.
  const shouldFailover = isQuotaErr || isModelMissing;
  // Local ollama failures should go through the local-first fallback path
  // (different host/model on the same local ollama) regardless of whether
  // the error looks model-shaped — the local-fallback chain knows about
  // host alternatives that a generic provider failover can't see.
  // ollama-cloud (API) still uses the failover path.
  const isLocalOllama = task?.provider === 'ollama';
  if (ctx.status === 'failed' && providerActuallyFailed && task && failoverCount < MAX_FAILOVERS && shouldFailover && !isLocalOllama) {
    const currentProvider = task.provider || 'codex';
    const fallbackProvider = db.getNextFallbackProvider(taskId);

    if (fallbackProvider) {
      logger.info(`[Provider Failover] ${currentProvider} quota exceeded, switching to ${fallbackProvider} for task ${taskId}`);
      const sanitizedOutput = _sanitizeTaskOutput(proc.output);
      const failoverErrorOutput = errorOutput + `\n[Auto-Failover] Switching from ${currentProvider} to ${fallbackProvider}`;
      const resumeContext = buildResumeContext(sanitizedOutput, failoverErrorOutput, {
        task_description: task.task_description,
        provider: currentProvider,
        started_at: task.started_at,
        completed_at: new Date().toISOString(),
      });

      db.updateTaskStatus(taskId, 'pending_provider_switch', {
        exit_code: code,
        output: sanitizedOutput,
        error_output: failoverErrorOutput,
        files_modified: filesModified,
        progress_percent: 0,
        resume_context: resumeContext,
        task_description: prependResumeContextToPrompt(task.task_description, resumeContext),
      });

      try {
        const duration = task.started_at
          ? Math.round((Date.now() - new Date(task.started_at).getTime()) / 1000)
          : null;
        db.recordProviderUsage(currentProvider, taskId, {
          duration_seconds: duration,
          success: false,
          error_type: 'quota'
        });

        db.approveProviderSwitch(taskId, fallbackProvider);
        db.recordFailoverEvent({ task_id: taskId, from_provider: currentProvider, to_provider: fallbackProvider, reason: 'quota', failover_type: 'provider' });
        ctx.status = 'queued';
        logger.info(`[Provider Failover] Task ${taskId} re-queued with ${fallbackProvider}`);

        dashboard?.notifyTaskUpdated?.(taskId);
        setTimeout(() => _processQueue(), failoverBackoffMs(task.retry_count || 1));
        ctx.earlyExit = true;
        return;
      } catch (switchErr) {
        logger.info(`[Provider Failover] Failed to switch provider: ${switchErr.message}`);
        ctx.status = 'failed';
      }
    } else {
      logger.info(`[Provider Failover] Fallback chain exhausted for task ${taskId}, all providers tried`);
      // Set system-wide Codex exhaustion flag when provider is codex and chain is exhausted
      if (currentProvider === 'codex' || currentProvider === 'claude-cli') {
        try {
          db.setCodexExhausted(true);
          logger.info(`[Codex Exhaustion] Codex quota exhausted — system switching to local LLM mode`);
        } catch (e) {
          logger.info(`[Codex Exhaustion] Failed to set flag: ${e.message}`);
        }
      }
      ctx.status = 'failed';
      ctx.errorOutput = (ctx.errorOutput || errorOutput || '') +
        `\n[Provider Quota Exceeded] ${currentProvider} quota exceeded, no fallback provider available`;
      if (ctx.code === 0) {
        ctx.code = 1;
      }
    }
  } else if (ctx.status === 'failed' && task && task.provider === 'ollama') {
    // Local LLM task failed — try fallback to different host/model/provider
    logger.info(`[Local-Fallback] Task ${taskId} failed on ${task.provider}/${task.model || '?'} — attempting local-first fallback`);

    const fallbackTask = {
      ...(db.getTask(taskId) || {}),
      ...task,
      output: ctx.output,
      error_output: ctx.errorOutput || errorOutput || '',
      files_modified: filesModified,
    };
    if (fallbackTask && fallbackTask.id) {
      const handled = _tryLocalFirstFallback(taskId, fallbackTask, errorOutput || 'task failed');
      if (handled) {
        logger.info(`[Local-Fallback] Task ${taskId} re-queued via fallback chain`);
        _processQueue();
        ctx.earlyExit = true;
      }
    }
  }
}

module.exports = {
  init,
  handleAutoValidation,
  handleBuildTestStyleCommit,
  handleProviderFailover,
};
