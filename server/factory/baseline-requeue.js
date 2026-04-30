'use strict';

const factoryIntake = require('../db/factory-intake');

const REQUEUEABLE_STATUSES = new Set(['rejected', 'unactionable']);

function captureBlockedWorkItemEvidence(workItem) {
  if (!workItem) {
    return {};
  }
  return {
    work_item_id: workItem.id ?? null,
    work_item_title: workItem.title || null,
    work_item_status_before_baseline_pause: workItem.status || null,
    work_item_requeue_on_clear: true,
  };
}

function normalizeWorkItemId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function getBlockedWorkItemId(config) {
  const evidence = config?.baseline_broken_evidence;
  if (!evidence || typeof evidence !== 'object') {
    return null;
  }
  return normalizeWorkItemId(evidence.work_item_id);
}

function maybeRequeueBaselineBlockedWorkItem({ project_id, config } = {}) {
  const workItemId = getBlockedWorkItemId(config);
  if (!workItemId) {
    return { requeued: false, reason: 'no_blocked_work_item' };
  }

  const expectedRejectReason = typeof config?.baseline_broken_reason === 'string'
    ? config.baseline_broken_reason
    : null;
  const workItem = factoryIntake.getWorkItem(workItemId);
  if (!workItem) {
    return { requeued: false, reason: 'work_item_not_found', work_item_id: workItemId };
  }
  if (project_id && workItem.project_id !== project_id) {
    return {
      requeued: false,
      reason: 'work_item_project_mismatch',
      work_item_id: workItemId,
      work_item_project_id: workItem.project_id,
    };
  }
  if (!REQUEUEABLE_STATUSES.has(workItem.status)) {
    return {
      requeued: false,
      reason: 'work_item_not_closed',
      work_item_id: workItemId,
      status: workItem.status,
    };
  }
  if (
    expectedRejectReason
    && workItem.reject_reason
    && workItem.reject_reason !== expectedRejectReason
  ) {
    return {
      requeued: false,
      reason: 'reject_reason_changed',
      work_item_id: workItemId,
      previous_reject_reason: workItem.reject_reason,
      expected_reject_reason: expectedRejectReason,
    };
  }

  const updated = factoryIntake.updateWorkItem(workItemId, {
    status: 'pending',
    reject_reason: null,
    claimed_by_instance_id: null,
  });
  return {
    requeued: true,
    work_item_id: workItemId,
    previous_status: workItem.status,
    previous_reject_reason: workItem.reject_reason || null,
    status: updated?.status || 'pending',
    priority: updated?.priority ?? workItem.priority ?? null,
  };
}

module.exports = {
  captureBlockedWorkItemEvidence,
  maybeRequeueBaselineBlockedWorkItem,
};
