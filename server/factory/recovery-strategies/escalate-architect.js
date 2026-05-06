'use strict';

// B1 same-shape escalation strategy. Dispatched via reasonPattern in
// replan-recovery when a work item's tasks repeatedly produce no progress
// (zero_diff_across_retries / retry_off_scope). Bumps the architect to
// the next provider in the project's chain so the next task spawned for
// this work item gets a different architect provider.
//
// State model — coordinates with loop-controller.js Phase X5 (same-shape
// escalation in routeWorkItemToNeedsReplan, line ~7331):
//   - Both paths write `constraints.architect_provider_override` to track
//     the current chain position for this work item.
//   - Both paths read it back to determine the next chain entry.
//   - This is a recovery-decisions.md conflict #2 follow-up: an earlier
//     version of this module read a separate `last_used_provider` field
//     that no production code path ever wrote, so on the second
//     escalation it bumped from chain[0] → chain[1] AGAIN instead of
//     chain[1] → chain[2] (because lastUsed was always null). Aligning
//     to architect_provider_override makes B1 and X5 share a single
//     state model.

const reasonPatterns = [
  /^zero_diff_across_retries$/i,
  /^retry_off_scope$/i,
];

function readProviderChain(factoryHealth, projectId) {
  if (!factoryHealth || typeof factoryHealth.getProject !== 'function') return [];
  const project = factoryHealth.getProject(projectId);
  if (!project) return [];
  const raw = project.provider_chain_json;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string' && p) : [];
  } catch {
    return [];
  }
}

function readCurrentArchitectOverride(workItem) {
  const raw = workItem.constraints_json;
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed.architect_provider_override === 'string') {
      return parsed.architect_provider_override;
    }
  } catch { /* ignore */ }
  return null;
}

async function replan({ workItem, deps }) {
  const { factoryHealth, logger } = deps;
  const chain = readProviderChain(factoryHealth, workItem.project_id);
  if (chain.length === 0) {
    return { outcome: 'unrecoverable', reason: 'escalate_refused: project provider_chain empty or missing' };
  }
  // When no override is set, the project defaults to chain[0] — so the
  // first escalation must move PAST chain[0] to chain[1]. Mirrors
  // loop-controller.js Phase X5 logic exactly.
  const currentProvider = readCurrentArchitectOverride(workItem);
  let currentIdx = currentProvider ? chain.indexOf(currentProvider) : 0;
  if (currentIdx < 0) currentIdx = 0;
  const nextIdx = currentIdx + 1;
  if (nextIdx >= chain.length) {
    return { outcome: 'unrecoverable', reason: 'escalate_refused: already at top of chain' };
  }
  const nextProvider = chain[nextIdx];
  if (logger?.info) {
    logger.info('escalate-architect: bumping provider', {
      work_item_id: workItem.id,
      from: currentProvider || `chain[0]=${chain[0]}`,
      to: nextProvider,
    });
  }
  return {
    outcome: 'escalated',
    updates: {
      constraints: {
        architect_provider_override: nextProvider,
        execution_provider_override: nextProvider,
      },
    },
  };
}

module.exports = {
  name: 'escalate-architect',
  reasonPatterns,
  replan,
};
