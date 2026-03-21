'use strict';

/**
 * Active policy effects — extend the policy engine with effects that modify
 * task data rather than just blocking/reporting.
 *
 * Effects:
 * - rewrite_description: prepend/append text to task descriptions
 * - compress_output: truncate task output to max_lines
 *
 * These are applied by the task hooks layer after policy evaluation,
 * not by the core engine itself.
 */

const logger = require('../logger').child({ component: 'policy-active-effects' });

/**
 * Apply rewrite_description effect to a task description.
 *
 * @param {string} description - Original task description
 * @param {Object} effect - { prepend?: string, append?: string }
 * @returns {string} Modified description
 */
function applyRewriteDescription(description, effect) {
  if (!effect || typeof effect !== 'object') return description;
  let result = description || '';
  if (effect.prepend && typeof effect.prepend === 'string') {
    result = effect.prepend + '\n' + result;
  }
  if (effect.append && typeof effect.append === 'string') {
    result = result + '\n' + effect.append;
  }
  return result;
}

/**
 * Apply compress_output effect to task output.
 *
 * @param {string} output - Full task output
 * @param {Object} effect - { max_lines?: number, keep?: 'last'|'first', summary_header?: string }
 * @returns {string} Compressed output
 */
function applyCompressOutput(output, effect) {
  if (!output || typeof output !== 'string') return output || '';
  if (!effect || typeof effect !== 'object') return output;

  const maxLines = effect.max_lines || 500;
  const keep = effect.keep || 'last';
  const header = effect.summary_header || '[Output truncated]';

  const lines = output.split('\n');
  if (lines.length <= maxLines) return output;

  let kept;
  if (keep === 'first') {
    kept = lines.slice(0, maxLines);
  } else {
    kept = lines.slice(-maxLines);
  }

  return header + '\n' + kept.join('\n');
}

/**
 * Apply trigger_tool effect — call an MCP tool as a policy side-effect.
 *
 * @param {Object} effect - { tool_name: string, tool_args?: Object, background?: boolean, block_on_failure?: boolean }
 * @param {Object} taskData - Task data for template variable interpolation
 * @returns {{ triggered: boolean, blocked?: boolean, result?: any, error?: string }}
 */
function applyTriggerTool(effect, taskData) {
  if (!effect.tool_name) {
    logger.info('[active-effects] trigger_tool: missing tool_name');
    return { triggered: false };
  }

  // Interpolate template variables in tool_args (e.g., {{task.working_directory}})
  let args = effect.tool_args || {};
  if (typeof args === 'object') {
    args = JSON.parse(JSON.stringify(args)); // deep clone
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
        const path = value.slice(2, -2).trim();
        const parts = path.split('.');
        let resolved = taskData;
        for (const part of parts) {
          resolved = resolved?.[part];
        }
        if (resolved !== undefined) args[key] = resolved;
      }
    }
  }

  try {
    // Lazy-load the tool dispatch — may not be available during policy evaluation
    const { handleToolCall } = require('../tools');
    if (effect.background) {
      // Fire-and-forget — don't block policy evaluation
      Promise.resolve(handleToolCall(effect.tool_name, args)).catch(err => {
        logger.info(`[active-effects] trigger_tool background error (${effect.tool_name}): ${err.message}`);
      });
      logger.info(`[active-effects] Triggered ${effect.tool_name} in background for task ${taskData.id || 'unknown'}`);
      return { triggered: true };
    }

    // Synchronous — but we can't actually await here since applyActiveEffects is sync.
    // For non-background triggers, queue the call and mark as triggered.
    // The caller (task-hooks) should await pending triggers after applyActiveEffects returns.
    if (!taskData._pendingTriggers) taskData._pendingTriggers = [];
    taskData._pendingTriggers.push({
      tool_name: effect.tool_name,
      tool_args: args,
      block_on_failure: effect.block_on_failure || false,
    });
    logger.info(`[active-effects] Queued trigger_tool ${effect.tool_name} for task ${taskData.id || 'unknown'}`);
    return { triggered: true };
  } catch (err) {
    logger.info(`[active-effects] trigger_tool error (${effect.tool_name}): ${err.message}`);
    if (effect.block_on_failure) {
      return { triggered: true, blocked: true, error: err.message };
    }
    return { triggered: true };
  }
}

/**
 * Apply all active effects from a policy evaluation result to task data.
 *
 * Scans evaluation results for profiles with active_effects configured.
 * Profiles define effects in their metadata:
 *   { active_effects: [{ type: 'rewrite_description', prepend: '...' }] }
 *
 * @param {Object} policyResult - Result from engine.evaluatePolicies()
 * @param {Object} taskData - Mutable task data object
 * @returns {{ applied: string[], taskData: Object }} Applied effect names + modified task data
 */
function applyActiveEffects(policyResult, taskData) {
  const applied = [];
  if (!policyResult || !policyResult.evaluations) return { applied, taskData };

  for (const evaluation of policyResult.evaluations) {
    const effects = evaluation.active_effects || evaluation.rule?.active_effects;
    if (!Array.isArray(effects)) continue;
    // Only apply effects from rules that matched (not skipped/degraded)
    if (evaluation.outcome === 'skipped' || evaluation.outcome === 'degraded') continue;

    for (const effect of effects) {
      if (!effect || !effect.type) continue;

      try {
        switch (effect.type) {
          case 'rewrite_description':
            if (taskData.task_description != null) {
              taskData.task_description = applyRewriteDescription(taskData.task_description, effect);
              applied.push('rewrite_description');
              logger.info(`[active-effects] Applied rewrite_description to task ${taskData.id || 'unknown'}`);
            }
            break;

          case 'compress_output':
            if (taskData.output != null) {
              taskData.output = applyCompressOutput(taskData.output, effect);
              applied.push('compress_output');
              logger.info(`[active-effects] Applied compress_output to task ${taskData.id || 'unknown'}`);
            }
            break;

          case 'trigger_tool': {
            const result = applyTriggerTool(effect, taskData);
            if (result.triggered) {
              applied.push('trigger_tool');
              if (result.blocked) {
                taskData._blocked_by_trigger = true;
                taskData._block_reason = result.error || 'trigger_tool blocked';
              }
            }
            break;
          }

          default:
            logger.info(`[active-effects] Unknown effect type: ${effect.type}`);
        }
      } catch (err) {
        logger.info(`[active-effects] Error applying ${effect.type}: ${err.message}`);
      }
    }
  }

  return { applied, taskData };
}

module.exports = {
  applyRewriteDescription,
  applyCompressOutput,
  applyTriggerTool,
  applyActiveEffects,
};
