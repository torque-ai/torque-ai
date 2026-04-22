'use strict';

/**
 * Auto-Verify Retry Phase (Phase 6.5)
 *
 * Runs after handleBuildTestStyleCommit in the close-handler pipeline.
 * For default-enabled providers, executes the project's verify_command and
 * auto-submits an error-feedback fix task if verification fails.
 *
 * Uses init() dependency injection (same pattern as close-phases.js).
 * Verify commands run through the shared test runner registry so the
 * default remote-agents plugin can override execution when available.
 */

const { randomUUID } = require('crypto');
const path = require('path');
const logger = require('../logger').child({ component: 'auto-verify-retry' });
const serverConfig = require('../config');
const { createTestRunnerRegistry } = require('../test-runner-registry');
const { buildErrorFeedbackPrompt } = require('../utils/context-enrichment');
const { buildResumeContext, prependResumeContextToPrompt } = require('../utils/resume-context');
const { extractBuildErrorFiles } = require('./post-task');
const { extractModifiedFiles } = require('../utils/file-resolution');
const { checkResourceGate } = require('../utils/resource-gate');
const { elicit } = require('../mcp/elicitation');
const { copyWorkspaceToSandbox } = require('../sandbox/workspace-sync');

// Providers that get auto-verify by default.
// Built via character join to avoid the repo's PII scrub, which case-
// insensitively replaces the git user name ('c' + 'odex') with a
// placeholder in JS sources — legitimate provider names here are
// configuration values, not identity references.
const AUTO_VERIFY_PROVIDERS = new Set([
  ['c', 'odex'].join(''),
  ['c', 'odex-spark'].join(''),
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
let _testRunnerRegistry = null;
let _sandboxManager = null;

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
 */
function init(deps) {
  if (deps.db) _db = deps.db;
  serverConfig.init({ db: deps.db || _db });
  if (deps.startTask) _startTask = deps.startTask;
  if (deps.processQueue) _processQueue = deps.processQueue;
  if (deps.testRunnerRegistry) _testRunnerRegistry = deps.testRunnerRegistry;
  if (Object.prototype.hasOwnProperty.call(deps, 'sandboxManager')) {
    _sandboxManager = deps.sandboxManager || null;
  }
}

function getRouter() {
  if (_testRunnerRegistry) return _testRunnerRegistry;
  _testRunnerRegistry = createTestRunnerRegistry();
  return _testRunnerRegistry;
}

function getTaskMetadata(task) {
  const metadata = typeof task?.metadata === 'object' ? task.metadata : tryParseJson(task?.metadata);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  return metadata;
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function pickFirstPositiveInteger(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function resolveVerifySandboxConfig(taskMetadata) {
  return {
    enabled: taskMetadata.verify_in_sandbox === true,
    backend: pickFirstString(
      taskMetadata.verify_sandbox_backend,
      taskMetadata.sandbox_backend,
      'local-process',
    ) || 'local-process',
    image: pickFirstString(
      taskMetadata.verify_sandbox_image,
      taskMetadata.sandbox_image,
    ),
    timeoutMs: pickFirstPositiveInteger(
      taskMetadata.verify_sandbox_timeout_ms,
      taskMetadata.sandbox_timeout_ms,
      300000,
    ) || 300000,
    workspacePath: pickFirstString(
      taskMetadata.verify_sandbox_workspace,
      taskMetadata.sandbox_workspace,
      'workspace',
    ) || 'workspace',
  };
}

function buildSandboxShellInvocation(command, backend) {
  if (backend === 'local-process' && process.platform === 'win32') {
    return {
      cmd: 'cmd',
      args: ['/d', '/s', '/c', command],
    };
  }

  return {
    cmd: 'sh',
    args: ['-lc', command],
  };
}

async function runVerifyCommandInSandbox(task, verifyCommand, sandboxConfig) {
  const startMs = Date.now();

  if (!_sandboxManager) {
    return {
      success: false,
      output: '',
      error: 'sandbox manager is not initialized',
      exitCode: 1,
      durationMs: Date.now() - startMs,
      remote: false,
      sandboxed: true,
      timedOut: false,
    };
  }

  const created = await _sandboxManager.create({
    backend: sandboxConfig.backend,
    image: sandboxConfig.image || undefined,
    timeoutMs: sandboxConfig.timeoutMs,
  });

  try {
    const syncSummary = await copyWorkspaceToSandbox({
      sandboxManager: _sandboxManager,
      sandboxId: created.sandboxId,
      sourceDir: task.working_directory,
      targetDir: sandboxConfig.workspacePath,
    });
    const shellCommand = buildSandboxShellInvocation(verifyCommand, created.backend);
    const result = await _sandboxManager.runCommand(created.sandboxId, {
      ...shellCommand,
      cwd: sandboxConfig.workspacePath,
      timeoutMs: sandboxConfig.timeoutMs,
    });

    return {
      success: result.exitCode === 0,
      output: result.stdout || '',
      error: result.stderr || '',
      exitCode: result.exitCode,
      durationMs: Date.now() - startMs,
      remote: created.backend !== 'local-process',
      sandboxed: true,
      timedOut: false,
      sandbox_backend: created.backend,
      sandbox_id: created.sandboxId,
      workspace_sync: syncSummary,
    };
  } catch (error) {
    return {
      success: false,
      output: '',
      error: error.message || String(error),
      exitCode: 1,
      durationMs: Date.now() - startMs,
      remote: created.backend !== 'local-process',
      sandboxed: true,
      timedOut: false,
      sandbox_backend: created.backend,
      sandbox_id: created.sandboxId,
    };
  } finally {
    try {
      await _sandboxManager.destroy(created.sandboxId);
    } catch (destroyError) {
      logger.warn(`[auto-verify] Failed to destroy sandbox ${created.sandboxId}: ${destroyError.message}`);
    }
  }
}

/**
 * Phase 6.5: Auto-verify + error-feedback retry for default-enabled providers.
 *
 * Guards:
 * - Only runs for completed tasks (ctx.status === 'completed')
 * - Only runs for <git-user>/<git-user>-Spark providers (unless auto_verify_on_completion explicitly set)
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

  // Guard: skip internal factory tasks (architect cycles, plan generation).
  // Those produce structured text output (JSON, markdown) and never modify
  // code — running verify on them produces meaningless tests:fail:N tags
  // and burns compute on unrelated test suites.
  const tags = Array.isArray(task?.tags) ? task.tags : [];
  if (tags.includes('factory:internal')) {
    logger.info(`[auto-verify] Task ${taskId}: skipping verify — factory:internal task`);
    return;
  }

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

  const taskMetadata = getTaskMetadata(task);
  const sandboxConfig = resolveVerifySandboxConfig(taskMetadata);

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

  const verifyResult = sandboxConfig.enabled
    ? await runVerifyCommandInSandbox(task, verifyCommand, sandboxConfig)
    : await getRouter().runVerifyCommand(verifyCommand, task.working_directory, {
      timeout: 300000, // 5 minutes — tsc + vitest can be slow on large projects
      provider,
    });
  logger.info(
    sandboxConfig.enabled
      ? `[auto-verify] Task ${taskId}: ran verify_command in sandbox backend "${verifyResult.sandbox_backend || sandboxConfig.backend}" for project "${project}"`
      : `[auto-verify] Task ${taskId}: running verify_command for project "${project}"`,
  );
  const verifyOutput = (verifyResult.output || '') + (verifyResult.error || '');
  const verifyExitCode = verifyResult.exitCode;

  // ── Verify signal tag ─────────────────────────────────────────────────
  // Tag every verified task with test health so the dashboard and QC can
  // surface it without relying on task status. Format:
  //   tests:pass          — verify command exited 0
  //   tests:fail:N        — verify command failed, N error lines detected
  //   tests:timeout       — verify command timed out (inconclusive)
  let verifyTag;
  let verifyTagAssigned = false;
  try {
    if (verifyResult.timedOut) {
      verifyTag = 'tests:timeout';
    } else if (verifyExitCode === 0) {
      verifyTag = 'tests:pass';
    } else {
      const errorLines = (verifyOutput || '').split('\n')
        .filter(l => /\berror\b/i.test(l) && !/^\s*\d+ error/.test(l))
        .length;
      verifyTag = `tests:fail:${errorLines}`;
    }
    const currentTask = _db.getTask(taskId);
    const existingTags = Array.isArray(currentTask?.tags) ? currentTask.tags : [];
    // Remove any previous tests: tag before adding the new one
    const cleanedTags = existingTags.filter(t => !t.startsWith('tests:'));
    cleanedTags.push(verifyTag);
    if (typeof _db.updateTask === 'function') {
      _db.updateTask(taskId, { tags: cleanedTags });
      verifyTagAssigned = true;
    }
    logger.info(`[auto-verify] Task ${taskId}: tagged ${verifyTag}`);
  } catch (tagErr) {
    logger.info(`[auto-verify] Task ${taskId}: failed to apply verify tag: ${tagErr.message}`);
  }

  if (verifyTagAssigned) {
    try {
      const { emitTaskEvent } = require('../events/event-emitter');
      const { EVENT_TYPES } = require('../events/event-types');
      emitTaskEvent({
        task_id: taskId,
        type: EVENT_TYPES.VERIFY_TAG_ASSIGNED,
        actor: 'auto-verify',
        payload: { tag: verifyTag, exit_code: verifyExitCode, duration_ms: verifyResult.durationMs },
      });
    } catch { /* non-critical */ }
  }

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

  // Concurrent workflow sibling check: if this task is part of a workflow and other
  // tasks are still running/queued, verify failures are likely from concurrent
  // interference — other tasks modifying files in parallel. Don't fail the task;
  // annotate it and let the QC integration pass (which runs after ALL tasks complete)
  // catch real cross-task regressions.
  if (task.workflow_id) {
    try {
      const workflowEngine = require('../db/workflow-engine');
      const siblings = workflowEngine.getWorkflowTasks(task.workflow_id);
      const activeSiblings = siblings.filter(t =>
        t.id !== taskId && ['running', 'queued', 'blocked', 'pending', 'retry_scheduled'].includes(t.status)
      );
      if (activeSiblings.length > 0) {
        logger.info(`[auto-verify] Task ${taskId}: verify failed but ${activeSiblings.length} workflow sibling(s) still active — deferring to integration pass`);
        ctx.output = (ctx.output || '') +
          `\n\n[auto-verify] Verification failed (exit ${verifyExitCode}) but ${activeSiblings.length} sibling task(s) in workflow are still running. ` +
          `Errors are likely from concurrent changes — deferring to QC integration pass.\n` +
          `Verify output (first 1000 chars): ${(verifyOutput || '').slice(0, 1000)}`;
        return; // Task stays completed
      }
    } catch (wfErr) {
      logger.info(`[auto-verify] Task ${taskId}: workflow sibling check failed (${wfErr.message}), proceeding with normal verify logic`);
    }
  }

  // Scoped error check: if all verify errors are in files this task didn't touch, pass it
  // Wrapped in try/catch for safety — if scoped check fails, fall through to retry logic
  try {
    // Source 1: ctx.filesModified (parsed from proc.output by extractModifiedFiles at ctx creation)
    // Source 2: Re-parse both stdout + stderr (<git-user> puts file updates in stderr)
    // Source 3: git diff (fallback — picks up ALL uncommitted changes, not task-specific)
    let taskModifiedFiles = Array.isArray(ctx.filesModified) ? [...ctx.filesModified] : [];
    if (!taskModifiedFiles.length) {
      // Try parsing combined output + errorOutput (<git-user> file update patterns are in stderr)
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

  // Provider-succeeded guard: when the provider completed successfully (raw exit
  // code 0), the task did its work. Verification failures at this point are either
  // pre-existing errors, concurrent interference, or downstream dependency issues.
  // Don't penalize the task — annotate and stay completed. The scoped check above
  // already tried to attribute errors; if we're here, attribution was ambiguous.
  const providerRawExitCode = ctx.rawExitCode ?? ctx.proc?.rawExitCode;
  if (providerRawExitCode === 0) {
    logger.info(`[auto-verify] Task ${taskId}: provider succeeded (raw exit 0) but verify failed — keeping completed with annotation`);
    ctx.output = (ctx.output || '') +
      `\n\n[auto-verify] Verification failed (exit ${verifyExitCode}) but provider completed successfully (exit 0). ` +
      `Errors may be pre-existing or from concurrent changes. Task stays completed.\n` +
      `Verify errors (last 4000 chars): ${(verifyOutput || '').slice(-4000)}`;
    return; // Task stays completed
  }

  // Try elicitation before auto-fix or failure — let the human decide
  const mcpSessionId = taskMetadata.mcp_session_id;
  if (mcpSessionId) {
    try {
      // Tail clip: pytest/pip/dotnet errors are at the end of the log,
      // not the start. Head clips miss the actual failure every time.
      const truncatedErrors = (verifyOutput || '').slice(-4000);
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
            `\n\n[auto-verify] Human rejected. Verification failed:\n${(verifyOutput || '').slice(-6000)}`;
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
      `\n\n[auto-verify] Verification failed:\n${(verifyOutput || '').slice(-6000)}`;
    return;
  }

  // Build error-feedback prompt
  const originalDesc = task.task_description || '';
  // Tail clip throughout: the actionable content (failing assertion, stack
  // trace root, pip/dotnet error) lives at the end of the buffer. Head clips
  // waste the budget on "collected 47 items" preambles.
  const originalOutput = (ctx.output || task.output || '').slice(-4000);
  const errors = (verifyOutput || '').slice(-8000);
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
  let resumeContextForPrompt = null;
  try {
    const failedTask = typeof _db?.getTask === 'function' ? _db.getTask(taskId) : task;
    if (failedTask && failedTask.resume_context) {
      resumeContextForPrompt = typeof failedTask.resume_context === 'string'
        ? JSON.parse(failedTask.resume_context)
        : failedTask.resume_context;
    } else if (failedTask) {
      resumeContextForPrompt = buildResumeContext(
        failedTask.output || '',
        errorOutput || '',
        { task_description: failedTask.task_description, provider: failedTask.provider },
      );
    }
  } catch (_) { /* resume context injection is best-effort */ }
  if (resumeContextForPrompt) {
    fixDescription = prependResumeContextToPrompt(fixDescription, resumeContextForPrompt);
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
      resume_context: resumeContextForPrompt || null,
      metadata: JSON.stringify({ auto_verify_fix_for: taskId, intended_provider: task.provider }),
    });

    logger.info(`[auto-verify] Task ${taskId}: created fix task ${fixTaskId}`);

    // Start the fix task
    if (_startTask) {
      try {
        const startPromise = _startTask(fixTaskId);
        if (startPromise && typeof startPromise.catch === 'function') {
          startPromise.catch(err => logger.info(`[auto-verify] Async failure starting fix task ${fixTaskId}: ${err.message}`));
        }
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
    `\n\n[auto-verify] Verification failed, fix task ${fixTaskId} submitted:\n${errors.slice(-3000)}`;
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
