'use strict';

// B1 (work-item replan) wrapper for the discard-regenerable-merge-block
// recovery. Dispatched via reasonPattern match in replan-recovery.js when
// a work item is rejected with reject_reason matching `merge_target_dirty`.
// Shared logic lives in ./discard-regenerable-merge-block-core.js — both
// this B1 wrapper and the A-side strategy in
// server/plugins/auto-recovery-core/strategies/discard-regenerable-merge-block.js
// delegate to attemptDiscard() and translate the outcome into their own
// contract shape.

const core = require('./discard-regenerable-merge-block-core');

const reasonPatterns = [
  /^merge_target_dirty(:|$)/i,
];

async function replan({ workItem, history: _history, deps }) {
  const { factoryHealth, logger } = deps;

  // Resolve the project's repo root — that's the merge target.
  const project = factoryHealth?.getProject?.(workItem.project_id);
  const repoRoot = project?.path;
  if (!repoRoot) {
    return {
      outcome: 'unrecoverable',
      reason: 'merge_target_dirty_discard: project repo path unavailable',
    };
  }

  const result = await core.attemptDiscard(repoRoot, {
    logger,
    contextLog: { work_item_id: workItem.id },
  });

  if (result.outcome === 'unavailable') {
    return { outcome: 'unrecoverable', reason: result.reason };
  }
  if (result.outcome === 'refused') {
    return { outcome: 'unrecoverable', reason: result.reason };
  }
  if (result.outcome === 'clean') {
    return { outcome: 'unblocked', updates: null, reason: result.reason };
  }
  // 'discarded' — engine treats `outcome: 'unblocked'` as "loop can resume
  // from where it was paused" — same shape replan strategies use when
  // they fix the condition without modifying the work item. The loop's
  // next tick will re-attempt LEARN's merge, which should now succeed
  // against a clean master.
  return {
    outcome: 'unblocked',
    updates: null,
    reason: result.reason,
    details: result.details || null,
  };
}

module.exports = {
  name: 'discard-regenerable-merge-block',
  reasonPatterns,
  replan,
  // Exposed for tests — re-export from core to keep existing test imports
  // working without changes.
  REGENERABLE_PATH_PATTERNS: core.REGENERABLE_PATH_PATTERNS,
  classifyDirtyEntries: core.classifyDirtyEntries,
  parsePorcelainLine: core.parsePorcelainLine,
};
