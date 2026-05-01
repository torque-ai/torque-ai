'use strict';

const MIN_DESCRIPTION_LENGTH = 100;

const reasonPatterns = [
  /^cannot_generate_plan:/i,
  /^pre_written_plan_rejected_by_quality_gate$/i,
  /^Rejected by user$/i,
  // Phase P (2026-04-30): Phase N's pre-submission guard surfaces here
  // as `task_targets_missing_files: task_N`. Without this pattern, the
  // reject_reason fell through to rejected-recovery's `task_.+_failed`
  // pattern and just retried the same broken plan (DLPhone #2117 thrash).
  /^task_targets_missing_files(:|$)/i,
  // The heavy-validation guard's violation also benefits from a rewrite
  // (the plan called for a heavy local validation step that won't survive
  // the runtime guard — rewrite to skip that step or route it elsewhere).
  /^task_avoids_local_heavy_validation(:|$)/i,
];

function validateRewriteResponse(response) {
  if (!response || typeof response !== 'object') {
    return { ok: false, reason: 'rewrite_response_invalid: not an object' };
  }
  if (typeof response.title !== 'string' || !response.title.trim()) {
    return { ok: false, reason: 'rewrite_response_invalid: missing title' };
  }
  if (typeof response.description !== 'string' || response.description.length < MIN_DESCRIPTION_LENGTH) {
    return { ok: false, reason: `rewrite_response_invalid: description shorter than ${MIN_DESCRIPTION_LENGTH} chars` };
  }
  if (!Array.isArray(response.acceptance_criteria) || response.acceptance_criteria.length === 0) {
    return { ok: false, reason: 'rewrite_response_invalid: no acceptance criteria' };
  }
  return { ok: true };
}

function appendAcceptanceCriteria(description, criteria) {
  const lines = ['', '## Acceptance Criteria', ''];
  for (const c of criteria) {
    lines.push(`- ${String(c).trim()}`);
  }
  return `${description.trimEnd()}\n${lines.join('\n')}`;
}

async function replan({ workItem, history, deps }) {
  const { architectRunner, logger } = deps;
  let response;
  try {
    response = await architectRunner.rewriteWorkItem({ workItem, history });
  } catch (err) {
    if (logger?.warn) {
      logger.warn('rewrite-description: architect call threw', {
        work_item_id: workItem.id,
        err: err.message,
      });
    }
    throw err;
  }

  const validation = validateRewriteResponse(response);
  if (!validation.ok) {
    return { outcome: 'unrecoverable', reason: validation.reason };
  }

  const updatedDescription = appendAcceptanceCriteria(response.description, response.acceptance_criteria);
  return {
    outcome: 'rewrote',
    updates: {
      title: response.title.trim(),
      description: updatedDescription,
    },
  };
}

module.exports = {
  name: 'rewrite-description',
  reasonPatterns,
  replan,
};
