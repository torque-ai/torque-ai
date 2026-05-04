'use strict';

const { defaultRegistry } = require('./recovery-strategies/registry');

const REJECTED_RECOVERY_PATTERNS = Object.freeze([
  /^auto_/i,
  /auto[-_ ]rejected/i,
  /^verify_failed_after_\d+_retries$/i,
  /^no_worktree_for_batch/i,
  /^consecutive_empty_executions$/i,
  /^stuck_executing_over_1h_no_progress/i,
  /^execute_spin_loop_\d+_starts_in_5min$/i,
  /^worktree_creation_failed:/i,
  /^execute_exception:/i,
  /^task_.+_failed$/i,
  /^worktree_and_branch_lost_during_verify$/i,
  /^dep_cascade_exhausted:/i,
  /^dep_resolver_unresolvable:/i,
  /^branch_stale_vs_base$/i,
  /^branch_stale_vs_master$/i,
]);

function patternStringsOverlap(a, b) {
  const sourceA = a.source.toLowerCase();
  const sourceB = b.source.toLowerCase();
  if (sourceA === sourceB) return true;
  return sourceA.includes(sourceB) || sourceB.includes(sourceA);
}

function assertDisjointReasonPatterns() {
  const replanPatterns = defaultRegistry.allReasonPatterns();
  for (const r of replanPatterns) {
    for (const j of REJECTED_RECOVERY_PATTERNS) {
      if (patternStringsOverlap(r, j)) {
        throw new Error(
          `replan-recovery / rejected-recovery pattern overlap: ${r} vs ${j}. ` +
          `One sweep would double-dispatch. Make patterns disjoint.`,
        );
      }
    }
  }
}

function bootstrapReplanRecovery() {
  const rewrite = require('./recovery-strategies/rewrite-description');
  const decompose = require('./recovery-strategies/decompose');
  const escalate = require('./recovery-strategies/escalate-architect');
  // Phase 3 (2026-05-03): merge_target_dirty wasn't matched by any
  // strategy; auto-recovery would log auto_recovery_no_strategy and
  // park the project at READY_FOR_LEARN forever. The discard-strategy
  // checks the dirty paths against an allowlist of regenerable files
  // (auto-generated plans, .codex-temp, etc.) and either discards +
  // signals retry, or refuses cleanly so the operator-pause path stands.
  const discardMergeBlock = require('./recovery-strategies/discard-regenerable-merge-block');
  for (const s of [rewrite, decompose, escalate, discardMergeBlock]) {
    const existing = defaultRegistry.list().find((x) => x.name === s.name);
    if (!existing) defaultRegistry.register(s);
  }
  assertDisjointReasonPatterns();
}

module.exports = {
  assertDisjointReasonPatterns,
  bootstrapReplanRecovery,
};
