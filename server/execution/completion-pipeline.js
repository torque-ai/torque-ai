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

// ─── Main handler ────────────────────────────────────────────────────────

/**
 * Phase 8: Provider usage recording, webhooks, workflow deps, pipeline advancement.
 */
function handlePostCompletion(ctx) {
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

  // Record provider usage
  try {
    const duration = task && task.started_at
      ? Math.round((Date.now() - new Date(task.started_at).getTime()) / 1000)
      : null;
    deps.db.recordProviderUsage(task?.provider || 'codex', taskId, {
      duration_seconds: duration,
      success: code === 0,
      error_type: ctx.status === 'pending_provider_switch' ? 'quota' : (code !== 0 ? 'failure' : null)
    });
  } catch (usageErr) {
    logger.info('Failed to record provider usage:', usageErr.message);
  }

  // Record model outcome for adaptive scoring (uses updatedTask for completed_at)
  try {
    const outcomeTask = deps.db.getTask(taskId);
    const outcomeMetadata = deps.parseTaskMetadata(outcomeTask?.metadata);
    const finalizedByTaskFinalizer = Boolean(outcomeMetadata?.finalization?.finalized_at);
    if (!finalizedByTaskFinalizer) {
      recordModelOutcome(outcomeTask, code === 0);
    }
    recordProviderHealth(outcomeTask, code === 0);
  } catch (outcomeErr) {
    logger.info('[Outcomes] Non-fatal error:', outcomeErr.message);
  }

  // Trigger webhooks + workflow dependencies
  try {
    const updatedTask = deps.db.getTask(taskId);
    const { triggerWebhooks } = require('../handlers/webhook-handlers');
    triggerWebhooks(ctx.status, updatedTask).catch(err => {
      logger.info('Webhook trigger error:', err.message);
    });

    if (updatedTask && updatedTask.workflow_id) {
      deps.handleWorkflowTermination(taskId);
    }

    deps.handleProjectDependencyResolution(taskId, ctx.status);

    if (ctx.status === 'completed' || ctx.status === 'failed' || ctx.status === 'cancelled') {
      deps.handlePipelineStepCompletion(taskId, ctx.status);
    }

    deps.runOutputSafeguards(taskId, ctx.status, updatedTask).catch(err => {
      logger.info(`[Safeguard] Error in output safeguards for ${taskId}: ${err.message}`);
    });

    // Push MCP SSE notifications to subscribed sessions
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent(ctx.status, updatedTask);
    } catch (mcpErr) {
      logger.info('[MCP Notify] Non-fatal error:', mcpErr.message);
    }

    // Clean up partial output streaming buffer + NULL out partial_output
    try {
      const { clearPartialOutputBuffer } = require('../db/webhooks-streaming');
      clearPartialOutputBuffer(taskId);
    } catch (poErr) {
      // Non-fatal
    }

    // Release coordination claims for this task
    try {
      const coord = require('../db/coordination');
      const claims = coord.listClaims({ task_id: taskId, status: 'active' });
      for (const claim of claims) {
        coord.releaseTaskClaim(claim.id);
      }
    } catch (e) {
      // Non-fatal
    }
  } catch (webhookErr) {
    logger.info('Post-completion webhook/workflow error:', webhookErr.message);
  }
}

module.exports = {
  init,
  fireTerminalTaskHook,
  recordModelOutcome,
  recordProviderHealth,
  handlePostCompletion,
};
