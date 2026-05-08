'use strict';

const decisionLog = require('./decision-log');

// Frozen enum of valid auto-ship reasons. New auto-ship paths must add a
// reason value here BEFORE calling emitAutoShipped — runtime validation
// enforces this. Catalog stays clean: one decision action, multiple reasons.
const AUTO_SHIPPED_REASONS = Object.freeze({
  AT_PRIORITIZE: 'at_prioritize',
  EMPTY_BRANCH_MERGE_FAIL: 'empty_branch_merge_fail',
  AT_VERIFY_FAIL: 'at_verify_fail',
});

const VALID_REASONS = new Set(Object.values(AUTO_SHIPPED_REASONS));

/**
 * Emit a unified auto_shipped decision for a work item the shipped-detector
 * has identified as already done.
 */
function emitAutoShipped({
  project_id,
  stage,
  reason,
  work_item_id,
  confidence,
  signals,
  batch_id = null,
  extra = {},
  reasoning,
}) {
  if (!VALID_REASONS.has(reason)) {
    throw new Error(
      `emitAutoShipped: unknown reason "${reason}". Add it to AUTO_SHIPPED_REASONS first. Valid: ${[...VALID_REASONS].join(', ')}`
    );
  }

  const outcome = {
    work_item_id,
    confidence,
    signals,
    reason,
    ...extra,
  };

  const defaultReasoning = `Auto-shipped at ${stage} (reason=${reason}, confidence=${confidence}). Shipped-detector found matching commits on main.`;

  return decisionLog.logDecision({
    project_id,
    stage,
    actor: 'factory-loop',
    action: 'auto_shipped',
    reasoning: reasoning || defaultReasoning,
    inputs: { reason },
    outcome,
    confidence: 1,
    batch_id,
  });
}

module.exports = { emitAutoShipped, AUTO_SHIPPED_REASONS };
