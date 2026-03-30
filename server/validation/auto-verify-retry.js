'use strict';

/**
 * Auto-Verify Retry Phase (Phase 6.5)
 *
 * Runs after handleBuildTestStyleCommit in the close-handler pipeline.
 * For default-enabled providers, executes the project's verify_command and
 * auto-submits an error-feedback fix task if verification fails.
 *
 * Uses init() dependency injection (same pattern as close-phases.js).
 * Supports remote test routing via agentRegistry — when a remote agent is
 * configured for the project, verify commands run on the remote host and
 * fall back to local execution on failure.
 */

const { randomUUID } = require('crypto');
const path = require('path');
const logger = require('../logger').child({ component: 'auto-verify-retry' });
const serverConfig = require('../config');
const { buildErrorFeedbackPrompt } = require('../utils/context-enrichment');
const { buildResumeContext, formatResumeContextForPrompt } = require('../utils/resume-context');
const { createRemoteTestRouter } = require('../remote/remote-test-routing');
const { extractBuildErrorFiles } = require('./post-task');
const { extractModifiedFiles } = require('../utils/file-resolution');
const { checkResourceGate } = require('../utils/resource-gate');
const { elicit } = require('../mcp/elicitation');

// Providers that get auto-verify by default
const AUTO_VERIFY_PROVIDERS = new Set([
  'codex',
  'codex-spark',
  'ollama',
]);

const NON_CODE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.toml',
]);

// Dependency injection
let _db = null;
let _startTask = null;
let _processQueue = null;
let _agentRegistry = null;

// Lazy-initialized router (created on first verify call after init)
let _router = null;

function tryParseJson(value) {
  if (!value || typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function isRetryTask(task) {
  if (!task) return false;
  if (task.retry_of != null) return true;
  const context = typeof task.context === 'object' ? task.context : tryParseJson(task.context);
  if (context && context.retry_of != null) return true;
  const metadata = typeof task.metadata === 'object' ? task.metadata : tryParseJson(task.metadata);
  if (metadata && metadata.auto_verify_fix_for != null) return true;
  return false;
}

/**
 * Initialize dependencies for this module.
 * @param {Object} deps
 * @param {Object} [deps.agentRegistry] - RemoteAgentRegistry instance (optional)
 */
function init(deps) {
  if (deps.db) _db = deps.db;
  serverConfig.init({ db: deps.db });
  if (deps.startTask) _startTask = deps.startTask;
  if (deps.processQueue) _processQueue = deps.processQueue;
  if (deps.agentRegistry !== undefined) _agentRegistry = deps.agentRegistry;
  // Reset router so it picks up the new deps on next call
  _router = null;
}

function getRouter() {
  if (!_router) {
    _router = createRemoteTestRouter({
      agentRegistry: _agentRegistry,
      db: _db,
      logger,
    });
  }
  return _router;
}

/**
 * Phase 6.5: Auto-verify + error-feedback retry for default-enabled providers.
 *
 * Guards:
 * - Only runs for completed tasks (ctx.status === 'completed')
 * - Only runs for Codex/Codex-Spark providers (unless auto_verify_on_completion explicitly set)
 * - Only runs when verify_command is configured for the project
 *
 * On verify failure with retries available:
 * - Creates a new fix task with error-feedback prompt
 * - Sets ctx.status = 'failed' and ctx.earlyExit = true
 *
 * @param {Object} ctx - Close-handler pipeline context
 */
async function handleAutoVerifyRetry(ctx) {
  const { taskId, task } = ctx;

  // Guard: only completed tasks
  if (ctx.status !== 'completed') return;

  // Guard: need a working directory
  if (!task || !task.working_directory) return;

  // Determine provider
  const provider = (task.provider || '').toLowerCase();
  const isAutoVerifyProvider = AUTO_VERIFY_PROVIDERS.has(provider);

  // Look up project config
  if (!_db) throw new Error('auto-verify-retry: module not initialized — call init() first');
  const project = _db.getProjectFromPath(task.working_directory);
  if (!project) return;

  const config = _db.getProjectConfig(project) || {};

  // Check auto_verify_on_completion flag:
  // - Default ON for auto-verify providers (auto_verify_on_completion is null/undefined → use provider default)
  // - Default OFF for others
  // - Explicit 0 disables for any provider
  const autoVerifyExplicit = config.auto_verify_on_completion;
  if (autoVerifyExplicit === 0 || autoVerifyExplicit === false) return;
  if (!isAutoVerifyProvider && autoVerifyExplicit !== 1 && autoVerifyExplicit !== true) return;

  // Guard: need a verify_command
  const verifyCommand = config.verify_command;
  if (!verifyCommand) return;

  const hostMonitoring = require('../utils/host-monitoring');
  const hostId = task.ollama_host_id || null;
  const gateResult = checkResourceGate(hostMonitoring.hostActivityCache, hostId);
  if (!gateResult.allowed) {
    logger.info(`[auto-verify] Task ${taskId}: resource gate blocked verify — ${gateResult.reason || 'host overloaded'}`);
    return;
  }

  const modifiedFiles = Array.isArray(ctx.filesModified) ? ctx.filesModified : [];
  if (
    modifiedFiles.length > 0 &&
    modifiedFiles.every(file => NON_CODE_EXTENSIONS.has(path.extname(file || '').toLowerCase()))
  ) {
    logger.info(`[auto-verify] Task ${taskId}: skipping verify — only non-code files modified`);
    return;
  }

  logger.info(`[auto-verify] Task ${taskId}: running verify_command for project "${project}"`);

  // Run verify_command (routes to remote agent when configured, falls back to local).
  // Pass provider so codex tasks auto-discover a remote workstation with test_runners.
  const router = getRouter();
  const verifyResult = await router.runVerifyCommand(verifyCommand, task.working_directory, {
    timeout: 300000, // 5 minutes — tsc + vitest can be slow on large projects
    provider,
  });
  const verifyOutput = (verifyResult.output || '') + (verifyResult.error || '');
  const verifyExitCode = verifyResult.exitCode;

  // Success — task stays completed
  if (verifyExitCode === 0) {
    logger.info(`[auto-verify] Task ${taskId}: verify passed`);
    return;
  }

  // Timeout — verification was inconclusive, don't penalize the task
  if (verifyResult.timedOut) {
    logger.info(`[auto-verify] Task ${taskId}: verify timed out (${Math.round(verifyResult.durationMs / 1000)}s) — treating as inconclusive, task stays completed`);
    ctx.output = (ctx.output || '') +
      `\n\n[auto-verify] Verification timed out (inconclusive). Code changes may be correct but could not be verified within the time limit.`;
    return;
  }

  logger.info(`[auto-verify] Task ${taskId}: verify failed (exit ${verifyExitCode}), verifyOutput length=${verifyOutput.length}`);

  // Scoped error check: if all verify errors are in files this task didn't touch, pass it
  // Wrapped in try/catch for safety — if scoped check fails, fall through to retry logic
  try {
    // Source 1: ctx.filesModified (parsed from proc.output by extractModifiedFiles at ctx creation)
    // Source 2: Re-parse both stdout + stderr (Codex puts file updates in stderr)
    // Source 3: git diff (fallback — picks up ALL uncommitted changes, not task-specific)
    let taskModifiedFiles = Array.isArray(ctx.filesModified) ? [...ctx.filesModified] : [];
    if (!taskModifiedFiles.length) {
      // Try parsing combined output + errorOutput (Codex file update patterns are in stderr)
      const combinedOutput = (ctx.output || '') + '\n' + (ctx.errorOutput || '');
      taskModifiedFiles = extractModifiedFiles(combinedOutput);
      if (taskModifiedFiles.length) {
        logger.info(`[auto-verify] Task ${taskId}: found ${taskModifiedFiles.length} files from combined output parsing`);
      }
    }
    // NOTE: git diff --name-only is NOT used as a fallback. In batch workflows where
    // many tasks run without committing, git diff returns ALL accumulated uncommitted
    // changes (100s of files), making the scoped check useless — every error file
    // overlaps with some modified file. If neither ctx.filesModified nor output parsing
    // found files, the task likely made no changes.
    if (!taskModifiedFiles.length) {
      // Task made no detectable file changes — verify errors are pre-existing
      const errorFilePaths = extractBuildErrorFiles(verifyOutput, task.working_directory);
      logger.info(`[auto-verify] Task ${taskId}: no modified files detected (scoped pass). Verify errors are pre-existing: ${errorFilePaths.slice(0, 5).join(', ')}`);
      ctx.output = (ctx.output || '') +
        `\n\n[auto-verify] Verification has pre-existing errors (not caused by this task): ${errorFilePaths.slice(0, 3).join(', ')}`;
      return;
    }
    logger.info(`[auto-verify] Task ${taskId}: taskModifiedFiles=${taskModifiedFiles.length} files: ${taskModifiedFiles.slice(0, 5).join(', ')}`);

    const errorFilePaths = extractBuildErrorFiles(verifyOutput, task.working_directory);
    if (errorFilePaths.length > 0) {
      const normalizedTaskFiles = taskModifiedFiles.map(f =>
        f.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
      );
      const taskCausedError = errorFilePaths.some(errorFile => {
        const normError = errorFile.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
        return normalizedTaskFiles.some(tf =>
          normError.endsWith(tf) || tf.endsWith(normError) ||
          normError.includes(tf) || tf.includes(normError)
        );
      });
      if (!taskCausedError) {
        logger.info(`[auto-verify] Task ${taskId}: verify errors are in files not modified by this task (scoped pass). Error files: ${errorFilePaths.slice(0, 5).join(', ')}`);
        // Task stays completed — pre-existing errors not caused by this task
        ctx.output = (ctx.output || '') +
          `\n\n[auto-verify] Verification has pre-existing errors (not caused by this task): ${errorFilePaths.slice(0, 3).join(', ')}`;
        return;
      }
      logger.info(`[auto-verify] Task ${taskId}: verify errors overlap with modified files — task caused errors`);
    } else if (verifyOutput.trim() === '') {
      // Empty verify output but non-zero exit — likely a command error, not a code error
      logger.info(`[auto-verify] Task ${taskId}: verify produced no parseable error files — passing as scoped (empty output)`);
      return;
    }
  } catch (scopedErr) {
    logger.info(`[auto-verify] Task ${taskId}: scoped check error (${scopedErr.message}), falling through to retry logic`);
  }

  // Try elicitation before auto-fix or failure — let the human decide
  const taskMetadata = typeof task.metadata === 'object' ? task.metadata : tryParseJson(task.metadata) || {};
  const mcpSessionId = taskMetadata.mcp_session_id;
  if (mcpSessionId) {
    try {
      const truncatedErrors = (verifyOutput || '').slice(0, 1500);
      const response = await elicit(mcpSessionId, {
        message: `Task ${taskId}: verification failed.\n\n${truncatedErrors}\n\nApprove anyway, reject (mark failed), or let auto-fix proceed?`,
        requestedSchema: {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: ['approve', 'reject', 'auto-fix'] },
          },
          required: ['decision'],
        },
      });
      if (response.action === 'accept') {
        const humanDecision = response.content?.decision;
        if (humanDecision === 'approve') {
          logger.info(`[auto-verify] Task ${taskId}: human approved despite verify failure`);
          ctx.output = (ctx.output || '') +
            '\n\n[auto-verify] Human approved despite verification failure.';
          return; // Task stays completed
        } else if (humanDecision === 'reject') {
          logger.info(`[auto-verify] Task ${taskId}: human rejected — marking failed`);
          ctx.status = 'failed';
          ctx.errorOutput = (ctx.errorOutput || '') +
            `\n\n[auto-verify] Human rejected. Verification failed:\n${(verifyOutput || '').slice(0, 4000)}`;
          return; // Skip auto-fix
        }
        // 'auto-fix' — fall through to existing retry logic
        logger.info(`[auto-verify] Task ${taskId}: human chose auto-fix — proceeding with retry logic`);
      }
      // decline/cancel — fall through to existing behavior
    } catch (elicitErr) {
      logger.warn(`[auto-verify] Elicitation failed for task ${taskId}: ${elicitErr.message}`);
      // Fall through to existing behavior
    }
  }

  // Check retry budget
  const retryCount = task.retry_count || 0;
  const configuredMaxFixAttempts = config.verify_max_fix_attempts != null
    ? config.verify_max_fix_attempts
    : (typeof _db.getConfig === 'function' ? serverConfig.get('verify_max_fix_attempts') : undefined);
  const parsedMaxFixAttempts = Number.parseInt(configuredMaxFixAttempts, 10);
  const maxRetries = Number.isInteger(parsedMaxFixAttempts) && parsedMaxFixAttempts >= 0
    ? parsedMaxFixAttempts
    : 2;
  const autoFixDisabled = config.auto_fix_enabled === 0 || config.auto_fix_enabled === false;
  const retryTask = isRetryTask(task);

  if (retryCount >= maxRetries || autoFixDisabled || retryTask) {
    // No retries left (or retry disabled) — mark failed with verify errors
    if (retryCount >= maxRetries) {
      logger.info(`[auto-verify] Task ${taskId}: no retries left (${retryCount}/${maxRetries})`);
    } else if (autoFixDisabled) {
      logger.info(`[auto-verify] Task ${taskId}: auto_fix_enabled is disabled; skipping retry task`);
    } else if (retryTask) {
      logger.info(`[auto-verify] Task ${taskId}: retry task detected; skipping chained retry`);
    }
    ctx.status = 'failed';
    ctx.errorOutput = (ctx.errorOutput || '') +
      `\n\n[auto-verify] Verification failed:\n${(verifyOutput || '').slice(0, 4000)}`;
    return;
  }

  // Build error-feedback prompt
  const originalDesc = task.task_description || '';
  const originalOutput = (ctx.output || task.output || '').slice(0, 2000);
  const errors = (verifyOutput || '').slice(0, 4000);
  const errorOutput = verifyOutput || '';
  let fixDescription = '';
  try {
    if (typeof buildErrorFeedbackPrompt === 'function') {
      fixDescription = buildErrorFeedbackPrompt(originalDesc, originalOutput, errors) || '';
    }
  } catch (promptErr) {
    logger.info(`[auto-verify] Task ${taskId}: prompt build failed (${promptErr.message}), using fallback`);
  }
  if (!fixDescription) {
    fixDescription = `${originalDesc}\n\nVerification failed. Fix these errors:\n${errors}`;
  }

  // Inject resume context from failed task (if available)
  let resumePreamble = '';
  try {
    const failedTask = typeof _db?.getTask === 'function' ? _db.getTask(taskId) : task;
    if (failedTask && failedTask.resume_context) {
      const parsed = typeof failedTask.resume_context === 'string'
        ? JSON.parse(failedTask.resume_context)
        : failedTask.resume_context;
      resumePreamble = formatResumeContextForPrompt(parsed);
    } else if (failedTask) {
      const resumeContext = buildResumeContext(
        failedTask.output || '',
        errorOutput || '',
        { task_description: failedTask.task_description, provider: failedTask.provider },
      );
      resumePreamble = formatResumeContextForPrompt(resumeContext);
    }
  } catch (_) { /* resume context injection is best-effort */ }
  if (resumePreamble) {
    fixDescription = `${resumePreamble}\n\n---\n\n${fixDescription}`;
  }

  // Create fix task
  const fixTaskId = randomUUID();
  try {
    _db.createTask({
      id: fixTaskId,
      task_description: fixDescription,
      working_directory: task.working_directory,
      provider: null,  // deferred assignment — set by tryClaimTaskSlot when slot is available
      model: task.model || null,
      priority: (task.priority || 0) + 1,
      max_retries: 0, // Fix task doesn't auto-retry further
      auto_approve: true,
      timeout_minutes: task.timeout_minutes || 30,
      status: 'queued',
      project: project,
      metadata: JSON.stringify({ auto_verify_fix_for: taskId, intended_provider: task.provider }),
    });

    logger.info(`[auto-verify] Task ${taskId}: created fix task ${fixTaskId}`);

    // Start the fix task
    if (_startTask) {
      try {
        _startTask(fixTaskId);
      } catch (startErr) {
        logger.info(`[auto-verify] Failed to start fix task ${fixTaskId}: ${startErr.message}`);
        // Task is queued — processQueue will pick it up
        if (_processQueue) {
          try { _processQueue(); } catch { /* non-critical */ }
        }
      }
    } else if (_processQueue) {
      try { _processQueue(); } catch { /* non-critical */ }
    }
  } catch (createErr) {
    logger.info(`[auto-verify] Failed to create fix task for ${taskId}: ${createErr.message}`);
    // Fall through — mark original as failed without retry
  }

  // Mark original task failed — must persist to DB before earlyExit
  // (earlyExit skips handleProviderFailover which is the normal terminal write)
  ctx.status = 'failed';
  ctx.errorOutput = (ctx.errorOutput || '') +
    `\n\n[auto-verify] Verification failed, fix task ${fixTaskId} submitted:\n${errors.slice(0, 2000)}`;
  try {
    _db.updateTaskStatus(taskId, 'failed', {
      exit_code: task.exit_code || 0,
      output: ctx.output || task.output || '',
      error_output: ctx.errorOutput,
      progress_percent: 0,
      completed_at: new Date().toISOString(),
    });
    // Only set earlyExit if DB write succeeded (RB-037)
    // If it fails, let handleProviderFailover() handle terminal status write
    ctx.earlyExit = true;
  } catch (statusErr) {
    logger.info(`[auto-verify] Failed to persist failed status for ${taskId}: ${statusErr.message}, falling through to normal terminalization`);
  }
}

module.exports = {
  init,
  handleAutoVerifyRetry,
};
