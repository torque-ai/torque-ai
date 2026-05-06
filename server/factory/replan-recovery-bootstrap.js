'use strict';

const { defaultRegistry } = require('./recovery-strategies/registry');
// Recovery-decisions.md conflict #5 (2026-05-06): rejected-recovery.js is the
// single source of truth for B2 sweep patterns. Earlier this file maintained a
// hand-rolled copy of those patterns (REJECTED_RECOVERY_PATTERNS), and the
// disjointness check here would have gone silent if B2 added a new pattern
// without bootstrap being updated. Importing the live arrays closes that gap.
const {
  AUTO_REJECT_REASON_PATTERNS,
  AUTO_UNACTIONABLE_REASON_PATTERNS,
  NON_RECOVERABLE_REJECT_REASON_PATTERNS,
} = require('./rejected-recovery');

// reject_reason routing has three pattern sets, but only B1 and B2 are mutually
// exclusive — they're the two auto-action paths and double-dispatch on the
// same reject_reason would cause a tick to both rewrite AND reopen the same
// work item.
//
//   - B1 strategies (recovery-strategies/) modify the work item: rewrite
//     description, decompose into children, escalate provider, discard
//     regenerable merge files.
//   - B2 sweep (rejected-recovery.js AUTO_REJECT_REASON_PATTERNS +
//     AUTO_UNACTIONABLE_REASON_PATTERNS) reopens the item — resets status
//     to pending without modifying the item.
//   - NON_RECOVERABLE_REJECT_REASON_PATTERNS (also in rejected-recovery.js)
//     is a **B2 veto list**: matchesRecoverableReason() checks NON_RECOVERABLE
//     first and returns false (not auto-recoverable by B2) before checking
//     AUTO_REJECT. It does NOT prevent B1 from acting — B1 strategies like
//     rewrite-description INTENTIONALLY match `cannot_generate_plan:` (which
//     is in NON_RECOVERABLE) because rewriting the description is the right
//     cure. The veto only stops B2's blind reopen.
//
// So the disjointness contract is narrow: B1 ∩ B2 must be empty. B1's overlap
// with NON_RECOVERABLE is intentional and allowed.
const B2_REASON_PATTERNS = Object.freeze([
  ...AUTO_REJECT_REASON_PATTERNS,
  ...AUTO_UNACTIONABLE_REASON_PATTERNS,
]);

function patternStringsOverlap(a, b) {
  const sourceA = a.source.toLowerCase();
  const sourceB = b.source.toLowerCase();
  if (sourceA === sourceB) return true;
  return sourceA.includes(sourceB) || sourceB.includes(sourceA);
}

function assertDisjointReasonPatterns() {
  const b1Patterns = defaultRegistry.allReasonPatterns();
  // B1 ∩ B2 must be empty (otherwise the same reject_reason would be both
  // rewritten by replan-recovery and reopened by rejected-recovery in the
  // same tick).
  for (const r of b1Patterns) {
    for (const j of B2_REASON_PATTERNS) {
      if (patternStringsOverlap(r, j)) {
        throw new Error(
          `replan-recovery (B1) / rejected-recovery (B2) pattern overlap: ${r} vs ${j}. ` +
          `One sweep would double-dispatch. Make patterns disjoint.`,
        );
      }
    }
  }
  // B2 AUTO_REJECT ∩ NON_RECOVERABLE redundant-listing check. If a pattern
  // appears in BOTH arrays, NON_RECOVERABLE wins inside matchesRecoverableReason
  // and the AUTO_REJECT entry never fires — it's dead. Flag it so the redundant
  // entry can be removed (this is a code-hygiene check, not a routing-correctness
  // one — the runtime behavior is well-defined either way).
  for (const j of B2_REASON_PATTERNS) {
    for (const n of NON_RECOVERABLE_REJECT_REASON_PATTERNS) {
      if (patternStringsOverlap(j, n)) {
        throw new Error(
          `rejected-recovery (B2) AUTO ∩ NON_RECOVERABLE pattern overlap: ${j} vs ${n}. ` +
          `NON_RECOVERABLE wins and the AUTO entry is dead — remove the redundant pattern.`,
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
