'use strict';

/**
 * Post-completion pipeline — Phase 8 of the close-handler sequence.
 *
 * Handles:
 *   - Terminal task hooks (task_complete / task_fail)
 *   - Provider usage recording
 *   - Model outcome recording (adaptive scoring)
 *   - Provider health recording
 *   - Webhook dispatch
 *   - Workflow dependency resolution
 *   - Plan project dependency resolution
 *   - Pipeline step advancement
 *   - Output safeguards
 *   - MCP SSE event dispatch
 *
 * Extracted from task-manager.js (Phase 4.1 decomposition).
 */

const logger = require('../logger').child({ component: 'completion-pipeline' });
const { safeJsonParse } = require('../utils/json');
const childProcess = require('child_process');
const { randomUUID } = require('crypto');

let deps = {};

function init(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
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
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Fire a terminal task lifecycle hook (task_complete or task_fail).
 * Non-fatal — errors are logged and swallowed.
 */
function fireTerminalTaskHook(eventType, context) {
  try {
    const { fireHook } = require('../hooks/post-tool-hooks');
    const hookPromise = fireHook(eventType, context);
    if (hookPromise && typeof hookPromise.catch === 'function') {
      hookPromise.catch((err) => {
        logger.info(`[Hooks] ${eventType} hook error for task ${context.taskId}: ${err.message}`);
      });
    }
  } catch (err) {
    logger.info(`[Hooks] Failed to dispatch ${eventType} hook for task ${context.taskId}: ${err.message}`);
  }
}

/**
 * Record model outcome for adaptive scoring.
 * Used as a legacy/manual fallback when post-completion runs outside the
 * canonical task-finalizer path. Non-fatal — failures are logged and swallowed.
 */
function recordModelOutcome(task, success) {
  try {
    if (!task || !task.provider) return;
    const modelName = task.model || task.provider;
    if (!modelName) return;
    const taskType = deps.db.classifyTaskType(task.task_description || '');
    const durationS = task.started_at && task.completed_at
      ? (new Date(task.completed_at) - new Date(task.started_at)) / 1000
      : null;
    if (typeof deps.db.recordModelOutcome === 'function') {
      deps.db.recordModelOutcome(modelName, taskType, success, {
        provider: task.provider,
        duration: durationS,
        exit_code: task.exit_code ?? null,
      });
      return;
    }

    const files = task.files ? (typeof task.files === 'string' ? safeJsonParse(task.files, []) : task.files) : [];
    const language = typeof deps.db.detectTaskLanguage === 'function'
      ? deps.db.detectTaskLanguage(task.task_description || '', files)
      : null;
    if (typeof deps.db.recordTaskOutcome === 'function') {
      deps.db.recordTaskOutcome(modelName, taskType, language, success, durationS, null);
    }
  } catch (err) {
    logger.warn(`[Outcomes] Failed to record: ${err.message}`);
  }
}

/**
 * Provider health should only reflect provider-native failures.
 * Local orchestration failures should not poison routing health.
 */
const PROVIDER_NATIVE_FAILURE_PATTERNS = [
  /ERROR:\s*\{"detail":/i,
  /\binvalid\s+api\s*key\b/i,
  /\bauthentication\s+failed\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\binsufficient[_ ]quota\b/i,
  /\bquota exceeded\b/i,
  /\brate limit/i,
  /\btoo many requests\b/i,
  /\b(?:HTTP[/\s]*|status[:\s]*)?(401|403|408|409|429|5\d{2})\b/i,
  /\bmodel\b.*\bnot (supported|found|available)\b/i,
  /\bcontext length\b/i,
  /\bmaximum context\b/i,
  /\bprovider timeout\b/i,
  /\btimeout while contacting provider\b/i,
  /\bservice unavailable\b/i,
  /\boverloaded\b/i,
];

const ORCHESTRATION_FAILURE_PATTERNS = [
  /\baccess denied\b/i,
  /\bEACCES\b/i,
  /\bEPERM\b/i,
  /\bESRCH\b/i,
  /\bENOENT\b/i,
  /\bno such file or directory\b/i,
  /\bcannot find the path\b/i,
  /\bzombie check\b/i,
  /\bSIGTERM\b/i,
  /\bkilled\b/i,
  /\btask timed out - retry with longer timeout\b/i,
  /\btimed out - retry with longer timeout\b/i,
  /\bspawn\b.*\b(?:EACCES|EPERM|ENOENT)\b/i,
];

function extractProviderHealthSignals(task, context = {}) {
  const parts = [];
  const taskMetadata = context.metadata !== undefined
    ? context.metadata
    : (typeof deps.parseTaskMetadata === 'function'
      ? deps.parseTaskMetadata(task?.metadata)
      : safeJsonParse(task?.metadata, {}));
  const strategicReason = typeof taskMetadata?.strategic_diagnosis?.reason === 'string'
    ? taskMetadata.strategic_diagnosis.reason
    : '';
  const validationOutcomes = taskMetadata?.finalization?.validation_stage_outcomes
    ? JSON.stringify(taskMetadata.finalization.validation_stage_outcomes)
    : '';

  for (const value of [
    context.errorOutput,
    context.output,
    context.proc?.errorOutput,
    context.proc?.output,
    task?.error_output,
    strategicReason,
    validationOutcomes,
  ]) {
    if (typeof value === 'string' && value.trim()) {
      parts.push(value.trim());
    }
  }

  return parts.join('\n');
}

function shouldRecordProviderHealth(task, success, context = {}) {
  if (!task || !task.provider) {
    return false;
  }
  if (success) {
    return true;
  }

  const failureSignals = extractProviderHealthSignals(task, context);
  if (!failureSignals) {
    return false;
  }
  if (ORCHESTRATION_FAILURE_PATTERNS.some((pattern) => pattern.test(failureSignals))) {
    return false;
  }
  return PROVIDER_NATIVE_FAILURE_PATTERNS.some((pattern) => pattern.test(failureSignals));
}

function recordProviderHealth(task, success, context = {}) {
  try {
    if (!shouldRecordProviderHealth(task, success, context)) return;
    deps.db.recordProviderOutcome(task.provider, success);
  } catch (err) {
    logger.warn(`[ProviderHealth] Failed to record: ${err.message}`);
  }
}

function triggerAutoRelease(repoPath, opts) {
  try {
    const rawDb = getRawDbInstance();
    if (!rawDb || typeof rawDb.prepare !== 'function') return;

    const { createReleaseManager } = require('../plugins/version-control/release-manager');
    const { createChangelogGenerator } = require('../plugins/version-control/changelog-generator');
    const { createAutoReleaseService } = require('../versioning/auto-release');

    const rm = createReleaseManager({ db: rawDb });
    const cg = createChangelogGenerator({ db: rawDb });
    const autoRelease = createAutoReleaseService({
      db: rawDb,
      releaseManager: rm,
      changelogGenerator: cg,
      logger,
    });

    autoRelease.cutRelease(repoPath, opts);
  } catch (err) {
    logger.info(`[auto-release] triggerAutoRelease failed: ${err.message}`);
  }
}

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, options, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }

      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function scanDirectCommitLog(projectPath, lastCommitHash) {
  const gitArgs = lastCommitHash && !lastCommitHash.startsWith('v')
    ? ['log', `${lastCommitHash}..HEAD`, '--format=%H|%s', '--no-merges']
    : ['log', '-20', '--format=%H|%s', '--no-merges'];

  const { stdout } = await execFileAsync('git', gitArgs, {
    cwd: projectPath,
    encoding: 'utf8',
    windowsHide: true,
  });

  return String(stdout || '').trim();
}

function parseDirectCommitLog(gitOutput, inferIntentFromCommitMessage) {
  if (!gitOutput) return [];

  return gitOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, ...msgParts] = line.split('|');
      const message = msgParts.join('|');
      const shortHash = hash ? hash.slice(0, 7) : null;
      if (!shortHash) return null;
      const typeMatch = message.match(/^([a-z]+)/i);

      return {
        id: randomUUID(),
        commit_hash: shortHash,
        message,
        commit_type: typeMatch ? typeMatch[1].toLowerCase() : 'chore',
        version_intent: inferIntentFromCommitMessage(message),
      };
    })
    .filter(Boolean);
}

function persistDirectCommits(rawDb, projectPath, commits) {
  if (!commits.length) return 0;

  const existingStmt = rawDb.prepare(
    'SELECT id FROM vc_commits WHERE repo_path = ? AND commit_hash = ?'
  );
  const insertStmt = rawDb.prepare(
    'INSERT INTO vc_commits (id, repo_path, branch, commit_hash, message, commit_type, scope, version_intent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const now = new Date().toISOString();

  const insertBatch = (records) => {
    let inserted = 0;
    for (const commit of records) {
      const existing = existingStmt.get(projectPath, commit.commit_hash);
      if (existing) continue;

      insertStmt.run(
        commit.id,
        projectPath,
        'main',
        commit.commit_hash,
        commit.message,
        commit.commit_type,
        null,
        commit.version_intent,
        now,
      );
      inserted += 1;
    }
    return inserted;
  };

  if (typeof rawDb.transaction === 'function') {
    return rawDb.transaction(insertBatch)(commits);
  }

  return insertBatch(commits);
}

// ─── Main handler ────────────────────────────────────────────────────────

/**
 * Phase 8: Provider usage recording, webhooks, workflow deps, pipeline advancement.
 */
async function handlePostCompletion(ctx) {
  const { taskId, code, task } = ctx;

  if (ctx.status === 'completed') {
    fireTerminalTaskHook('task_complete', {
      taskId,
      task_id: taskId,
      exitCode: code,
      exit_code: code,
      output: ctx.output || ctx.proc?.output || '',
      task,
    });
  } else if (ctx.status === 'failed') {
    fireTerminalTaskHook('task_fail', {
      taskId,
      task_id: taskId,
      exitCode: code,
      exit_code: code,
      error: ctx.errorOutput || ctx.proc?.errorOutput || '',
      error_output: ctx.errorOutput || ctx.proc?.errorOutput || '',
      output: ctx.output || ctx.proc?.output || '',
      task,
    });
  }

  // Record provider usage.
  // Use the final task status (not exit code) as the success indicator: a task with
  // exit code 0 but status 'failed' (e.g., output validation failure) should be
  // recorded as a failure, and vice versa.
  try {
    const duration = task && task.started_at
      ? Math.round((Date.now() - new Date(task.started_at).getTime()) / 1000)
      : null;
    const finalStatus = ctx.status || (code === 0 ? 'completed' : 'failed');
    const usageSuccess = finalStatus === 'completed';
    deps.db.recordProviderUsage(task?.provider || 'codex', taskId, {
      duration_seconds: duration,
      success: usageSuccess,
      error_type: finalStatus === 'pending_provider_switch' ? 'quota' : (!usageSuccess ? 'failure' : null)
    });
  } catch (usageErr) {
    logger.warn('Failed to record provider usage:', usageErr.message);
  }

  // Record circuit-breaker outcome for the provider after terminal status is finalized.
  try {
    const { defaultContainer } = require('../container');
    const hasCircuitBreaker = defaultContainer
      && typeof defaultContainer.has === 'function'
      && defaultContainer.has('circuitBreaker');
    const circuitBreaker = hasCircuitBreaker && typeof defaultContainer.get === 'function'
      ? defaultContainer.get('circuitBreaker')
      : null;
    if (circuitBreaker && task?.provider) {
      if (ctx.status === 'completed' && code === 0) {
        circuitBreaker.recordSuccess(task.provider);
      } else if (ctx.status === 'failed') {
        if (task.provider === 'codex' || task.provider === 'codex-spark') {
          circuitBreaker.recordFailureByCode(task.provider, {
            errorCode: task.error_code || ctx.errorCode || null,
            exitCode: task.exit_code != null ? task.exit_code : (code != null ? code : null),
          });
        } else {
          circuitBreaker.recordFailure(task.provider, ctx.errorOutput || '');
        }
      }
    }
  } catch (cbErr) {
    logger.warn('[CircuitBreaker] Failed to record completion outcome:', cbErr.message);
  }

  // Record model outcome for adaptive scoring (uses updatedTask for completed_at)
  try {
    const outcomeTask = deps.db.getTask(taskId);
    const outcomeMetadata = deps.parseTaskMetadata(outcomeTask?.metadata);
    const finalizedByTaskFinalizer = Boolean(outcomeMetadata?.finalization?.finalized_at);
    const outcomeSuccess = ctx.status === 'completed';
    if (!finalizedByTaskFinalizer) {
      recordModelOutcome(outcomeTask, outcomeSuccess);
    }
    recordProviderHealth(outcomeTask, outcomeSuccess, { ...ctx, metadata: outcomeMetadata });
  } catch (outcomeErr) {
    logger.warn('[Outcomes] Non-fatal error:', outcomeErr.message);
  }

  // Trigger webhooks + workflow dependencies
  try {
    const updatedTask = deps.db.getTask(taskId);

    try {
      const { defaultContainer } = require('../container');
      const governance = defaultContainer && typeof defaultContainer.get === 'function'
        ? defaultContainer.get('governanceHooks')
        : null;
      if (governance && typeof governance.evaluate === 'function') {
        await governance.evaluate('task_complete', updatedTask || task);
      }
    } catch (_e) {
      // Non-critical
    }

    const { triggerWebhooks } = require('../handlers/webhook-handlers');
    triggerWebhooks(ctx.status, updatedTask).catch(err => {
      logger.warn('Webhook trigger error:', err.message);
    });

    if (updatedTask && updatedTask.workflow_id) {
      try { deps.handleWorkflowTermination(taskId); } catch (e) { logger.error('Workflow termination failed:', e.message); }
    }

    try { deps.handleProjectDependencyResolution(taskId, ctx.status); } catch (e) { logger.error('Project dep resolution failed:', e.message); }

    if (ctx.status === 'completed' || ctx.status === 'failed' || ctx.status === 'cancelled') {
      try { deps.handlePipelineStepCompletion(taskId, ctx.status); } catch (e) { logger.error('Pipeline step completion failed:', e.message); }
    }

    if (ctx.status === 'completed' && updatedTask) {
      try {
        const { promoteScoutTaskOutputToIntake } = require('../factory/scout-output-intake');
        const scoutIntake = promoteScoutTaskOutputToIntake(updatedTask, { logger });
        if (scoutIntake.created.length > 0 || scoutIntake.skipped.length > 0) {
          logger.info('[ScoutIntake] Processed starvation recovery scout output', {
            task_id: taskId,
            created: scoutIntake.created.length,
            skipped: scoutIntake.skipped.length,
            reason: scoutIntake.reason || null,
          });
        }
      } catch (err) {
        logger.warn(`[ScoutIntake] Non-fatal error processing scout output for ${taskId}: ${err.message}`);
      }
    }

    // Release file locks synchronously BEFORE event dispatch so blocked tasks
    // can acquire them immediately when they receive the completion notification.
    // (The async safeguard chain also releases locks, but that races with event dispatch.)
    if (ctx.status === 'completed' || ctx.status === 'failed' || ctx.status === 'cancelled') {
      try {
        const fileBaselines = require('../db/file-baselines');
        const released = fileBaselines.releaseAllFileLocks(taskId);
        if (released > 0) {
          logger.info(`[FileLock] Released ${released} lock(s) for ${taskId} (pre-dispatch)`);
        }
      } catch (_lockErr) {
        logger.warn(`[FileLock] Non-fatal error releasing locks for ${taskId}: ${_lockErr.message}`);
      }
    }

    deps.runOutputSafeguards(taskId, ctx.status, updatedTask).catch(err => {
      logger.warn(`[Safeguard] Error in output safeguards for ${taskId}: ${err.message}`);
    });

    // Push MCP SSE notifications to subscribed sessions
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent(ctx.status, updatedTask);
    } catch (mcpErr) {
      logger.warn('[MCP Notify] Non-fatal error:', mcpErr.message);
    }

    // Clean up partial output streaming buffer + NULL out partial_output
    try {
      const { clearPartialOutputBuffer } = require('../db/webhooks-streaming');
      clearPartialOutputBuffer(taskId);
    } catch (_poErr) {
      // Non-fatal
    }

    // Release coordination claims for this task
    try {
      const coord = require('../db/coordination');
      const claims = coord.listClaims({ task_id: taskId, status: 'active' });
      for (const claim of claims) {
        coord.releaseTaskClaim(claim.id);
      }
    } catch (_e) {
      // Non-fatal
    }
  } catch (webhookErr) {
    logger.info('Post-completion webhook/workflow error:', webhookErr.message);
  }

  // Phase 9: Auto-track direct commits + auto-release for versioned projects
  if (ctx.status === 'completed') {
    try {
      const { resolveVersionedProject, inferIntentFromCommitMessage } = require('../versioning/version-intent');
      const rawDb = getRawDbInstance();
      const taskWorkDir = task?.working_directory || null;
      const registeredProject = rawDb && taskWorkDir ? resolveVersionedProject(rawDb, taskWorkDir) : null;
      if (registeredProject) {
        // Use registered project path for DB records and git operations
        // (taskWorkDir may be a Codex sandbox path that no longer exists)
        const projectPath = registeredProject;
        // Scan for untracked direct commits
        try {
          const lastCommit = rawDb.prepare(
            'SELECT commit_hash FROM vc_commits WHERE repo_path = ? ORDER BY created_at DESC LIMIT 1'
          ).get(projectPath);
          const gitOutput = await scanDirectCommitLog(projectPath, lastCommit?.commit_hash);
          const commits = parseDirectCommitLog(gitOutput, inferIntentFromCommitMessage);
          persistDirectCommits(rawDb, projectPath, commits);
        } catch (scanErr) {
          logger.warn(`[Phase 9] Git commit scan failed for ${projectPath}: ${scanErr.message}`);
        }
        const isWorkflowTask = Boolean(task?.workflow_id);

        if (isWorkflowTask) {
          // Only release when the entire workflow is complete
          try {
            const workflow = deps.db.getWorkflow(task.workflow_id);
            if (workflow && workflow.status === 'completed') {
              triggerAutoRelease(projectPath, {
                workflowId: task.workflow_id,
                taskId: null,
                trigger: 'workflow',
              });
            }
          } catch (_wfErr) { /* workflow lookup failed - skip */ }
        } else {
          // Standalone task - release immediately
          triggerAutoRelease(projectPath, {
            workflowId: null,
            taskId,
            trigger: 'task',
          });
        }
      }
    } catch (releaseErr) {
      logger.info(`[Phase 9] Auto-release error (non-fatal): ${releaseErr.message}`);
    }
  }
}

module.exports = {
  init,
  fireTerminalTaskHook,
  recordModelOutcome,
  recordProviderHealth,
  handlePostCompletion,
};
