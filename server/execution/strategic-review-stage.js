'use strict';

/**
 * Experiment 4: Strategic Review Pipeline Stage
 *
 * Runs deterministic quality review on completed tasks flagged with
 * needs_review: true in their metadata. If the review rejects,
 * the task is marked failed with the review reason.
 *
 * Uses deterministic rules only (no LLM call) to keep the pipeline fast.
 */

const { fallbackReview } = require('../orchestrator/deterministic-fallbacks');
const logger = require('../logger').child({ component: 'strategic-review-stage' });

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
 * Pipeline stage handler for strategic review.
 * Only acts on completed tasks with needs_review: true metadata.
 *
 * Gathers validation failures from prior pipeline stages and file size
 * delta from metadata, then runs the deterministic review.
 *
 * @param {object} ctx - Finalization pipeline context
 */
function strategicReviewStage(ctx) {
  const metadata = parseMetadata(ctx.task?.metadata);

  // Only review tasks completing successfully AND flagged for review
  if (ctx.status !== 'completed' || !metadata.needs_review) {
    return;
  }

  // Gather validation failures from prior pipeline stages
  const validationFailures = [];
  for (const [stageName, stageResult] of Object.entries(ctx.validationStages || {})) {
    if (stageResult.outcome === 'error') {
      validationFailures.push({
        severity: 'error',
        rule: stageName,
        details: stageResult.error || 'Stage failed',
      });
    }
  }

  // Check file size delta from sandbox revert detection or safeguards
  const fileSizeDelta = metadata.finalization?.file_size_delta_pct || 0;

  const review = fallbackReview({
    validation_failures: validationFailures,
    file_size_delta_pct: fileSizeDelta,
  });

  // Store review result in context metadata
  metadata.strategic_review = review;
  ctx.task.metadata = typeof ctx.task.metadata === 'string'
    ? JSON.stringify(metadata)
    : metadata;

  if (review.decision === 'reject') {
    ctx.status = 'failed';
    ctx.code = 1;
    const msg = `[STRATEGIC REVIEW] Rejected: ${review.reason}`;
    ctx.errorOutput = ctx.errorOutput ? `${ctx.errorOutput}\n${msg}` : msg;
    logger.info(`[StrategicReviewStage] Task ${ctx.taskId} rejected: ${review.reason}`);
  } else {
    const warnCount = review.warnings?.length || 0;
    logger.info(`[StrategicReviewStage] Task ${ctx.taskId} approved${warnCount ? ` (${warnCount} warnings)` : ''}`);
  }
}

module.exports = { strategicReviewStage };
