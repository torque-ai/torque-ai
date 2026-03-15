'use strict';

/**
 * Experiment 5: Smart Failure Diagnosis Pipeline Stage
 *
 * Runs deterministic error pattern matching on failed tasks to decide
 * the optimal recovery action: retry, switch_provider, fix_task, or escalate.
 *
 * Stores diagnosis in task metadata and sets hints for downstream stages
 * (e.g., suggested_provider for provider_failover).
 */

const { fallbackDiagnose } = require('../orchestrator/deterministic-fallbacks');
const logger = require('../logger').child({ component: 'smart-diagnosis' });

/**
 * Parses raw metadata into an object.
 *
 * @param {string|object|null} raw - The raw metadata to parse.
 * @returns {object} - Parsed metadata object.
 */
function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && raw !== null) return { ...raw };
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Pipeline stage handler for smart failure diagnosis.
 * Only acts on failed tasks. Analyzes error patterns and recommends
 * a recovery action.
 *
 * Actions:
 *   switch_provider → sets metadata.suggested_provider for provider_failover
 *   fix_task → appends diagnosis context for auto-verify-retry
 *   escalate → sets metadata.needs_escalation flag
 *   retry → no-op (existing retry_logic already handled retries)
 *
 * @param {object} ctx - Finalization pipeline context.
 * @returns {void}
 */
function smartDiagnosisStage(ctx) {
  // Only diagnose failed tasks
  if (ctx.status !== 'failed') {
    return;
  }

  const diagnosis = fallbackDiagnose({
    error_output: ctx.errorOutput || '',
    provider: ctx.proc?.provider || ctx.task?.provider || '',
    exit_code: ctx.code,
  });

  // Store diagnosis in metadata
  const metadata = parseMetadata(ctx.task?.metadata);
  metadata.strategic_diagnosis = diagnosis;

  switch (diagnosis.action) {
    case 'switch_provider':
      metadata.suggested_provider = diagnosis.suggested_provider;
      logger.info(`[SmartDiagnosis] Task ${ctx.taskId}: ${diagnosis.reason} → suggesting ${diagnosis.suggested_provider}`);
      break;

    case 'fix_task':
      // Store fix suggestion in metadata only — don't modify errorOutput
      // since it would pollute failure categorization downstream
      metadata.fix_suggestion = diagnosis.reason;
      logger.info(`[SmartDiagnosis] Task ${ctx.taskId}: ${diagnosis.reason} → fix task suggested`);
      break;

    case 'escalate':
      metadata.needs_escalation = true;
      logger.info(`[SmartDiagnosis] Task ${ctx.taskId}: ${diagnosis.reason} → escalation needed`);
      break;

    case 'retry':
      logger.info(`[SmartDiagnosis] Task ${ctx.taskId}: ${diagnosis.reason} → retry (handled by retry_logic)`);
      break;

    default:
      logger.info(`[SmartDiagnosis] Task ${ctx.taskId}: unknown action ${diagnosis.action}`);
  }

  ctx.task.metadata = typeof ctx.task.metadata === 'string'
    ? JSON.stringify(metadata)
    : metadata;
}

module.exports = { smartDiagnosisStage };
