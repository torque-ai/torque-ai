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

let deps = {};

function init(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
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
 * Record provider health outcome for all providers.
 * Non-fatal — used by provider health scoring to deprioritize unreliable providers.
 */
function recordProviderHealth(task, success) {
  try {
    if (!task || !task.provider) return;
    deps.db.recordProviderOutcome(task.provider, success);
  } catch (err) {
    logger.warn(`[ProviderHealth] Failed to record: ${err.message}`);
  }
}

function triggerAutoRelease(repoPath, opts) {
  try {
    const database = require('../database');
    const rawDb = database.getDbInstance();
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
        circuitBreaker.recordFailure(task.provider, ctx.errorOutput || '');
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
    recordProviderHealth(outcomeTask, outcomeSuccess);
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
      const database = require('../database');
      const rawDb = database.getDbInstance();
      const taskWorkDir = task?.working_directory || null;
      const registeredProject = rawDb && taskWorkDir ? resolveVersionedProject(rawDb, taskWorkDir) : null;
      if (registeredProject) {
        // Use registered project path for DB records and git operations
        // (taskWorkDir may be a Codex sandbox path that no longer exists)
        const projectPath = registeredProject;
        // Scan for untracked direct commits
        try {
          const { execFile } = require('child_process');
          const { promisify } = require('util');
          const execFileAsync = promisify(execFile);
          const { randomUUID } = require('crypto');
          const lastCommit = rawDb.prepare(
            'SELECT commit_hash FROM vc_commits WHERE repo_path = ? ORDER BY created_at DESC LIMIT 1'
          ).get(projectPath);
          const gitArgs = lastCommit?.commit_hash && !lastCommit.commit_hash.startsWith('v')
            ? ['log', `${lastCommit.commit_hash}..HEAD`, '--format=%H|%s', '--no-merges']
            : ['log', '-20', '--format=%H|%s', '--no-merges'];
          const { stdout: rawGitOutput } = await execFileAsync('git', gitArgs, {
            cwd: projectPath, encoding: 'utf8', windowsHide: true,
          });
          const gitOutput = rawGitOutput.trim();
          if (gitOutput) {
            const now = new Date().toISOString();
            for (const line of gitOutput.split('\n').filter(Boolean)) {
              const [hash, ...msgParts] = line.split('|');
              const message = msgParts.join('|');
              const shortHash = hash ? hash.slice(0, 7) : null;
              if (!shortHash) continue;
              const existing = rawDb.prepare(
                'SELECT id FROM vc_commits WHERE repo_path = ? AND commit_hash = ?'
              ).get(projectPath, shortHash);
              if (existing) continue;
              const intent = inferIntentFromCommitMessage(message);
              const typeMatch = message.match(/^([a-z]+)/i);
              rawDb.prepare(
                'INSERT INTO vc_commits (id, repo_path, branch, commit_hash, message, commit_type, scope, version_intent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
              ).run(randomUUID(), projectPath, 'main', shortHash, message, typeMatch ? typeMatch[1].toLowerCase() : 'chore', null, intent, now);
            }
          }
        } catch (_scanErr) {
          // Non-fatal — git scan may fail in non-git environments
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
