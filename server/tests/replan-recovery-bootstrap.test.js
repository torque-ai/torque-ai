'use strict';

/**
 * Regression tests for the cross-registry reject_reason disjointness check
 * in `replan-recovery-bootstrap.js`. Recovery-decisions.md conflict #5:
 * three pattern sets exist, but only B1 ∩ B2 must be strictly disjoint:
 *
 *   - B1: per-strategy `reasonPatterns` registered in
 *     `recovery-strategies/registry.js` (rewrite, decompose, escalate,
 *     discard) — modify the work item.
 *   - B2 AUTO: `AUTO_REJECT_REASON_PATTERNS` + `AUTO_UNACTIONABLE_REASON_PATTERNS`
 *     in `rejected-recovery.js` — reopen the work item.
 *   - NON_RECOVERABLE: `NON_RECOVERABLE_REJECT_REASON_PATTERNS` in
 *     `rejected-recovery.js` — a B2 **veto list** (NON_RECOVERABLE is checked
 *     first inside `matchesRecoverableReason`; if matched, returns false
 *     before AUTO_REJECT is consulted).
 *
 * B1 may overlap with NON_RECOVERABLE — that's intentional. For example,
 * `rewrite-description` (B1) handles `cannot_generate_plan:` by rewriting
 * the description, and the same pattern is in NON_RECOVERABLE so B2 won't
 * blindly reopen the rejection. The two paths cooperate: B1 fixes the cause
 * via rewrite; if B1 declines or fails, B2 stays out and the operator owns it.
 *
 * The disjointness check enforces:
 *   - B1 ∩ B2 = ∅ (hard requirement — would cause double-dispatch).
 *   - B2_AUTO ∩ NON_RECOVERABLE = ∅ (code hygiene — overlap means the AUTO
 *     entry is dead because NON_RECOVERABLE wins inside the matching code).
 */

const path = require('node:path');

describe('replan-recovery-bootstrap disjointness', () => {
  let registryModule;
  let rejectedRecovery;
  let bootstrap;

  beforeEach(() => {
    // Force reloads so each test sees a clean default registry.
    delete require.cache[require.resolve('../factory/recovery-strategies/registry')];
    delete require.cache[require.resolve('../factory/rejected-recovery')];
    delete require.cache[require.resolve('../factory/replan-recovery-bootstrap')];
    delete require.cache[require.resolve('../factory/recovery-strategies/rewrite-description')];
    delete require.cache[require.resolve('../factory/recovery-strategies/decompose')];
    delete require.cache[require.resolve('../factory/recovery-strategies/escalate-architect')];
    delete require.cache[require.resolve('../factory/recovery-strategies/discard-regenerable-merge-block')];

    registryModule = require('../factory/recovery-strategies/registry');
    rejectedRecovery = require('../factory/rejected-recovery');
    bootstrap = require('../factory/replan-recovery-bootstrap');
  });

  it('live B1 strategies are disjoint from live B2 patterns (regression guard)', () => {
    bootstrap.bootstrapReplanRecovery();
    // bootstrap calls assertDisjointReasonPatterns at the end. If any pattern
    // overlapped between B1 and B2 (or B1 and NON_RECOVERABLE, or B2 and
    // NON_RECOVERABLE), bootstrap would have thrown.
    expect(() => bootstrap.assertDisjointReasonPatterns()).not.toThrow();
  });

  it('rejected-recovery exports the three pattern arrays', () => {
    expect(Array.isArray(rejectedRecovery.AUTO_REJECT_REASON_PATTERNS)).toBe(true);
    expect(rejectedRecovery.AUTO_REJECT_REASON_PATTERNS.length).toBeGreaterThan(0);
    expect(Array.isArray(rejectedRecovery.AUTO_UNACTIONABLE_REASON_PATTERNS)).toBe(true);
    expect(rejectedRecovery.AUTO_UNACTIONABLE_REASON_PATTERNS.length).toBeGreaterThan(0);
    expect(Array.isArray(rejectedRecovery.NON_RECOVERABLE_REJECT_REASON_PATTERNS)).toBe(true);
    expect(rejectedRecovery.NON_RECOVERABLE_REJECT_REASON_PATTERNS.length).toBeGreaterThan(0);
  });

  it('throws when a B1 strategy overlaps a B2 pattern', () => {
    bootstrap.bootstrapReplanRecovery();
    // Synthesize a strategy with a pattern that overlaps a known B2 entry.
    // /^auto_/i is in AUTO_REJECT_REASON_PATTERNS — register a B1 strategy
    // whose pattern is a superstring of it.
    const overlappingStrategy = {
      name: 'test-bad-overlap-b2',
      reasonPatterns: [/^auto_foo/i],
      replan: () => ({ outcome: 'unrecoverable', reason: 'test' }),
    };
    registryModule.defaultRegistry.register(overlappingStrategy);
    expect(() => bootstrap.assertDisjointReasonPatterns())
      .toThrow(/B1\) \/ rejected-recovery \(B2\) pattern overlap/);
  });

  it('B1 ∩ NON_RECOVERABLE overlap is allowed and does NOT throw', () => {
    bootstrap.bootstrapReplanRecovery();
    // rewrite-description (a live B1 strategy) already overlaps NON_RECOVERABLE
    // on /^cannot_generate_plan:/i — that's the existing cooperative pattern.
    // The disjointness check should NOT flag this. Confirm by registering an
    // additional B1 strategy whose patterns also overlap NON_RECOVERABLE —
    // assertDisjointReasonPatterns must still pass.
    const intentionallyOverlapping = {
      name: 'test-b1-non-recoverable-overlap-allowed',
      reasonPatterns: [/^pre_written_plan_rejected_by_quality_gate$/i],
      replan: () => ({ outcome: 'unrecoverable', reason: 'test' }),
    };
    // Note: rewrite-description already has this exact pattern, so we'd hit
    // the within-B1 overlap guard. Use a fresh-but-still-NON_RECOVERABLE
    // pattern instead.
    const synthetic = {
      name: 'test-b1-touches-nonrec',
      reasonPatterns: [/^dismissed_from_inbox:_synthetic/i],
      replan: () => ({ outcome: 'unrecoverable', reason: 'test' }),
    };
    void intentionallyOverlapping;
    registryModule.defaultRegistry.register(synthetic);
    expect(() => bootstrap.assertDisjointReasonPatterns()).not.toThrow();
  });

  it('throws when a B2 AUTO pattern overlaps a NON_RECOVERABLE pattern (dead code hygiene)', () => {
    bootstrap.bootstrapReplanRecovery();
    // The disjointness check guards against redundant listings between
    // AUTO_REJECT (or AUTO_UNACTIONABLE) and NON_RECOVERABLE. The live arrays
    // are Object.freeze()d as of 2c54533a (single-source-of-truth fix), so we
    // can't push into them. Swap the export reference instead — the fresh
    // require of bootstrap below pulls the augmented value from
    // rejectedRecovery's still-cached module.exports.
    const original = rejectedRecovery.AUTO_REJECT_REASON_PATTERNS;
    rejectedRecovery.AUTO_REJECT_REASON_PATTERNS = [
      ...original,
      // /^dismissed_from_inbox:/i is in NON_RECOVERABLE and is the only entry
      // there that no live B1 strategy claims, so this AUTO_REJECT pattern
      // (a superstring of it) trips the B2∩NON_RECOVERABLE check without
      // being short-circuited by an earlier B1∩B2 hit.
      /^dismissed_from_inbox:bogus/i,
    ];
    try {
      delete require.cache[require.resolve('../factory/replan-recovery-bootstrap')];
      const fresh = require('../factory/replan-recovery-bootstrap');
      expect(() => fresh.assertDisjointReasonPatterns())
        .toThrow(/B2\) AUTO ∩ NON_RECOVERABLE pattern overlap/);
    } finally {
      rejectedRecovery.AUTO_REJECT_REASON_PATTERNS = original;
    }
  });

  it('disjointness check uses live B2 patterns from rejected-recovery (no hand-rolled copy)', () => {
    // The contract of conflict #5's fix: the bootstrap module must not maintain
    // its own copy of B2 patterns. Verify by reading the source and confirming
    // it imports from rejected-recovery rather than defining its own array.
    const fs = require('node:fs');
    const sourcePath = path.join(__dirname, '..', 'factory', 'replan-recovery-bootstrap.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).toContain("require('./rejected-recovery')");
    // The hand-rolled REJECTED_RECOVERY_PATTERNS array name should no longer
    // be present (replaced by B2_REASON_PATTERNS computed from the import).
    expect(source).not.toMatch(/^const REJECTED_RECOVERY_PATTERNS\s*=/m);
  });

  it('every B2 AUTO_REJECT pattern would block a colliding B1 strategy', () => {
    // For each live B2 AUTO_REJECT pattern, register a B1 strategy whose
    // pattern is a superstring of it and confirm disjointness check throws.
    // This is a coverage proof that all B2 entries participate in the check.
    for (const b2 of rejectedRecovery.AUTO_REJECT_REASON_PATTERNS) {
      // Reset registry for each iteration.
      registryModule.defaultRegistry.clear();
      bootstrap.bootstrapReplanRecovery();
      const synthetic = {
        name: `test-${b2.source.replace(/[^a-z0-9]/gi, '-')}`,
        // Wrap b2's source as a superstring so patternStringsOverlap matches.
        reasonPatterns: [new RegExp(`${b2.source}_synthetic_suffix`, b2.flags)],
        replan: () => ({ outcome: 'unrecoverable', reason: 't' }),
      };
      registryModule.defaultRegistry.register(synthetic);
      expect(() => bootstrap.assertDisjointReasonPatterns()).toThrow(/pattern overlap/);
    }
  });
});
