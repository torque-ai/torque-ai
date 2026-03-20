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

const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const logger = require('../logger').child({ component: 'close-phases' });
const serverConfig = require('../config');
const { TASK_TIMEOUTS } = require('../constants');
const perfTracker = require('../db/provider-performance');
const { failoverBackoffMs } = require('../utils/backoff');

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
let _sanitizeAiderOutput = null;
let _safeUpdateTaskStatus = null;
let _tryLocalFirstFallback = null;
let _tryHashlineTieredFallback = null;
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
  if (deps.sanitizeAiderOutput) _sanitizeAiderOutput = deps.sanitizeAiderOutput;
  if (deps.safeUpdateTaskStatus) _safeUpdateTaskStatus = deps.safeUpdateTaskStatus;
  if (deps.tryLocalFirstFallback) _tryLocalFirstFallback = deps.tryLocalFirstFallback;
  if (deps.tryHashlineTieredFallback) _tryHashlineTieredFallback = deps.tryHashlineTieredFallback;
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
  const { taskId, proc, task } = ctx;
  if (ctx.status !== 'completed' || !task || task.provider !== 'aider-ollama') return;

  const workingDir = task.working_directory || process.cwd();
  try {
    // Get modified files from git — scoped to this task's changes only.
    const tryGitDiff = (args) => {
      try {
        return execFileSync('git', args, { cwd: workingDir, encoding: 'utf-8', timeout: TASK_TIMEOUTS.GIT_DIFF, windowsHide: true }).trim();
      } catch { return ''; }
    };
    let gitOutput = tryGitDiff(['diff', '--name-only']);
    if (!gitOutput) gitOutput = tryGitDiff(['diff', '--name-only', '--cached']);
    if (!gitOutput && proc.baselineCommit) {
      gitOutput = tryGitDiff(['diff', '--name-only', proc.baselineCommit, 'HEAD']);
    } else if (!gitOutput) {
      gitOutput = tryGitDiff(['diff', '--name-only', 'HEAD~1', 'HEAD']);
    }

    const changedFiles = gitOutput.split('\n').filter(f => f.trim());
    for (const relFile of changedFiles) {
      const absPath = path.join(workingDir, relFile);
      if (!fs.existsSync(absPath)) continue;
      const content = fs.readFileSync(absPath, 'utf-8');

      const qualityResult = _checkFileQuality ? _checkFileQuality(absPath) : { issues: [] };
      const issues = qualityResult.issues || [];

      // Line-count regression check (>40% reduction = likely destruction)
      const currentLines = content.split('\n').length;
      let previousLines = 0;
      const baselineRef = proc.baselineCommit || 'HEAD~1';
      try {
        const prevContent = execFileSync('git', ['show', baselineRef + ':' + relFile], {
          cwd: workingDir, encoding: 'utf-8', timeout: TASK_TIMEOUTS.GIT_STATUS, windowsHide: true
        }).trim();
        previousLines = prevContent.split('\n').length;
      } catch {
        try {
          const stagedContent = execFileSync('git', ['show', 'HEAD:' + relFile], {
            cwd: workingDir, encoding: 'utf-8', timeout: TASK_TIMEOUTS.GIT_STATUS, windowsHide: true
          }).trim();
          previousLines = stagedContent.split('\n').length;
        } catch { /* new file, no baseline */ }
      }
      if (previousLines > 20 && currentLines < previousLines * 0.6) {
        issues.push(`File shrank from ${previousLines} to ${currentLines} lines (${Math.round((1 - currentLines/previousLines) * 100)}% reduction — likely code destruction)`);
      }

      if (issues.length > 0) {
        logger.warn(`[Auto-Validation] Task ${taskId} file ${relFile} has quality issues: ${issues.join(', ')}`);
        const rollback = _scopedRollback ? _scopedRollback(taskId, workingDir, 'Auto-Validation') : { reverted: [], skipped: [] };
        logger.info(`[Auto-Validation] Rolled back ${rollback.reverted.length} file(s) for task ${taskId}`);
        ctx.status = 'failed';
        ctx.errorOutput = (ctx.errorOutput || '') +
          `\n\n[AUTO-VALIDATION FAILED] ${relFile}: ${issues.join('; ')}`;
        break;
      }
    }
  } catch (e) {
    logger.warn(`[Auto-Validation] Error validating task ${taskId}: ${e.message}`);
  }
}

/**
 * Phase 6: Build verify → commit → test verify → style check → auto-PR.
 */
function handleBuildTestStyleCommit(ctx) {
  const { taskId, task } = ctx;
  if (ctx.status !== 'completed' || !task) return;

  const workingDir = task.working_directory || process.cwd();
  const recoveredFiles = recoverModifiedFiles(ctx);
  const modifiedFiles = Array.isArray(ctx.changedFiles) && ctx.changedFiles.length > 0
    ? ctx.changedFiles
    : (recoveredFiles.length > 0
      ? recoveredFiles
      : (db.getTaskFileChanges ? db.getTaskFileChanges(taskId).map(c => c.file_path) : []));
  const buildResult = _runBuildVerification(taskId, task, workingDir, modifiedFiles);

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

  // Commit uncommitted changes after build passes (when aider auto-commits is disabled)
  const autoCommitsDisabled = serverConfig.get('aider_auto_commits') === '0';
  if (autoCommitsDisabled) {
    try {
      const gitStatusResult = spawnSync('git', ['status', '--porcelain'], {
        cwd: workingDir, encoding: 'utf-8', timeout: TASK_TIMEOUTS.GIT_ADD_ALL
      });
      const gitStatus = (gitStatusResult.stdout || '').trim();

      if (gitStatus.length > 0) {
        logger.info(`[Build Verification] Task ${taskId}: Found uncommitted changes, committing after build passed`);

        const filesModified = recoverModifiedFiles(ctx);
        if (filesModified && filesModified.length > 0) {
          for (const file of filesModified) {
            const cleanFile = file.trim().replace(/^["']|["']$/g, '');
            if (cleanFile && !cleanFile.includes('..') && _isValidFilePath(cleanFile) && _isShellSafe(cleanFile)) {
              try {
                spawnSync('git', ['add', '--', cleanFile], { cwd: workingDir, timeout: TASK_TIMEOUTS.GIT_ADD });
              } catch (addErr) {
                logger.info(`[Build Verification] Task ${taskId}: Could not stage ${cleanFile}: ${addErr.message}`);
              }
            } else if (cleanFile) {
              logger.info(`[Build Verification] Task ${taskId}: Skipping invalid path: ${cleanFile.substring(0, 80)}`);
            }
          }
        } else {
          spawnSync('git', ['add', '.', '--', ':!*.env', ':!*.env.*', ':!credentials*', ':!*secret*'], { cwd: workingDir, timeout: TASK_TIMEOUTS.GIT_ADD_ALL });
        }

        const stagedResult = spawnSync('git', ['diff', '--cached', '--name-only'], {
          cwd: workingDir, encoding: 'utf-8', timeout: TASK_TIMEOUTS.GIT_ADD
        });
        const staged = (stagedResult.stdout || '').trim();

        if (staged.length > 0) {
          const shortDesc = (task.task_description || '').substring(0, 50).replace(/["\n\r]/g, ' ').trim();
          const commitMsg = `docs: ${shortDesc}... [Torque ${task.model || 'local'}]`;
          spawnSync('git', ['commit', '-m', commitMsg], {
            cwd: workingDir, timeout: TASK_TIMEOUTS.GIT_COMMIT
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
  const testResult = _runTestVerification(taskId, task, workingDir);

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
      _tryCreateAutoPR(taskId, task, workingDir, projectConfig);
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
    const outcome = slotPull.requeueAfterFailure(taskId, task.provider, { deferTerminalWrite: true });

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
  const MAX_FAILOVERS = 3;
  const failoverCount = task?.retry_count || 0;
  const errorOutput = proc?.errorOutput || '';
  if (ctx.status === 'failed' && task && failoverCount < MAX_FAILOVERS && db.isProviderQuotaError(task.provider || 'codex', errorOutput)) {
    const currentProvider = task.provider || 'codex';
    const fallbackProvider = db.getNextFallbackProvider(taskId);

    if (fallbackProvider) {
      logger.info(`[Provider Failover] ${currentProvider} quota exceeded, switching to ${fallbackProvider} for task ${taskId}`);

      db.updateTaskStatus(taskId, 'pending_provider_switch', {
        exit_code: code,
        output: _sanitizeAiderOutput(proc.output),
        error_output: errorOutput + `\n[Auto-Failover] Switching from ${currentProvider} to ${fallbackProvider}`,
        files_modified: filesModified,
        progress_percent: 0
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
  } else if (ctx.status === 'failed' && task && ['aider-ollama', 'ollama', 'hashline-ollama'].includes(task.provider)) {
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
      const handled = task.provider === 'hashline-ollama'
        ? _tryHashlineTieredFallback(taskId, fallbackTask, errorOutput || 'task failed')
        : _tryLocalFirstFallback(taskId, fallbackTask, errorOutput || 'task failed');
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
