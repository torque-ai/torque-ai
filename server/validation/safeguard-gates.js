'use strict';

/**
 * LLM output safeguard gates — Phase 2 of the close-handler sequence.
 *
 * Handles:
 *   - File quality and size regression checks
 *   - Placeholder/stub artifact detection
 *   - Scoped rollback on safeguard failure
 *   - Auto-retry on safeguard failure (if retries remain)
 *
 * Extracted from task-manager.js (D4.3 optional extraction).
 */

const logger = require('../logger').child({ component: 'safeguard-gates' });

let deps = {};

function init(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
}

/**
 * Phase 2: LLM output safeguards, scoped rollback, auto-retry on safeguard failure.
 * Sets ctx.earlyExit = true if auto-retry is triggered.
 */
function handleSafeguardChecks(ctx) {
  const { taskId, task, proc } = ctx;
  if (ctx.status !== 'completed' || !task) return;

  // Skip safeguard checks for Codex — it runs in its own sandbox with built-in
  // approval gates. Our safeguards (file-quality, size regression) are designed
  // for aider/ollama output and produce false failures on Codex tasks.
  if (task.provider === 'codex') return;

  const workingDir = task.working_directory || process.cwd();
  const projectConfig = deps.db.getProjectConfig(task.project || deps.db.getProjectFromPath(workingDir));
  const safeguardsEnabled = !projectConfig || projectConfig.llm_safeguards_enabled !== false;
  const actuallyModifiedFiles = deps.getActualModifiedFiles(workingDir) || [];

  if (!safeguardsEnabled) return;

  if (actuallyModifiedFiles.length > 0) {
    logger.info(`[Safeguard] Checking ${actuallyModifiedFiles.length} actually modified files: ${actuallyModifiedFiles.join(', ')}`);
  }

  const expectsGeneratedEdits = /\b(implement|build|create|wire|add|write|generate|make|edit|modify|update|fix)\b/i.test(task.task_description || '');
  const safeguardResult = deps.runLLMSafeguards(taskId, workingDir, actuallyModifiedFiles, {
    outputText: proc?.output || ctx.errorOutput || '',
    checkOutputMarkers: expectsGeneratedEdits,
  });
  if (safeguardResult.passed) return;

  logger.info(`[Safeguard] Task ${taskId} failed safeguard checks`);
  const safeguardArtifactFiles = safeguardResult.details?.placeholderArtifacts?.artifacts?.map(artifact => artifact.path) || [];
  const safeguardFiles = [...new Set([...actuallyModifiedFiles, ...safeguardArtifactFiles])];

  // Use dedicated safeguard rollback config if set, fall back to build failure config
  const rollbackOnSafeguard = projectConfig && (projectConfig.rollback_on_safeguard_failure ?? projectConfig.rollback_on_build_failure);
  if (rollbackOnSafeguard && safeguardFiles.length > 0) {
    const rollback = deps.scopedRollback(taskId, workingDir, 'SafeguardRollback');
    logger.info(`[Safeguard] Scoped rollback of ${rollback.reverted.length} file(s) for task ${taskId}`);
  }

  // Auto-retry safeguard failures if retries remain
  const retryCount = (task.retry_count || 0);
  const maxRetries = (task.max_retries || 0);
  if (retryCount < maxRetries) {
    logger.info(`[Safeguard] Auto-retrying task ${taskId} (attempt ${retryCount + 1}/${maxRetries}) after safeguard failure`);
    if (safeguardFiles.length > 0) {
      deps.scopedRollback(taskId, workingDir, 'Safeguard P87');
    }

    ctx.errorOutput = (ctx.errorOutput || '') +
      '\n\n[LLM SAFEGUARD FAILED - AUTO-RETRY]\n' +
      safeguardResult.issues.join('\n');

    deps.taskCleanupGuard.delete(taskId);

    deps.safeUpdateTaskStatus(taskId, 'queued', {
      error_output: ctx.errorOutput,
      retry_count: retryCount + 1,
      started_at: null,
      pid: null,
      progress_percent: 0
    });
    deps.dashboard.notifyTaskUpdated(taskId);
    deps.processQueue();
    ctx.earlyExit = true;
    return;
  }

  // No retries left - mark as failed
  ctx.status = 'failed';
  ctx.errorOutput = (ctx.errorOutput || '') +
    '\n\n[LLM SAFEGUARD FAILED]\n' +
    safeguardResult.issues.join('\n');
}

module.exports = { init, handleSafeguardChecks };
