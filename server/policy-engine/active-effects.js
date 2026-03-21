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
  applyActiveEffects,
};
