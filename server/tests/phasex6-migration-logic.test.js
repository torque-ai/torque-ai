'use strict';

// Phase X6: validates the reject-reason classifier embedded in the
// migration script. The script is standalone (HTTP-driven), so we
// re-implement the matching logic here in the test and ensure the
// invariants hold:
//   - All reject_reasons that the post-X4 routing uses are migratable
//   - Operator-rejected, scout-proven, and "no description" reasons
//     are NOT migratable

const MIGRATABLE_REASON_PATTERNS = [
  /^plan_quality_gate_rejected_after_2_attempts$/,
  /^plan_quality_exhausted_after_\d+_attempts$/,
  /^replan_generation_failed$/,
  /^empty_branch_after_execute$/,
  /^cannot_generate_plan:\s+(?!no description\b)/,
];

function isJsonPlanQualityReason(reason) {
  if (!reason || typeof reason !== 'string') return false;
  if (reason[0] !== '{') return false;
  try {
    const parsed = JSON.parse(reason);
    return parsed && parsed.code === 'plan_description_quality_below_threshold';
  } catch {
    return false;
  }
}

function isMigratable(reason) {
  if (!reason || typeof reason !== 'string') return false;
  if (MIGRATABLE_REASON_PATTERNS.some((re) => re.test(reason))) return true;
  if (isJsonPlanQualityReason(reason)) return true;
  return false;
}

describe('Phase X6: migration classifier', () => {
  describe('reasons that SHOULD migrate', () => {
    const migratable = [
      'plan_quality_gate_rejected_after_2_attempts',
      'plan_quality_exhausted_after_5_attempts',
      'plan_quality_exhausted_after_10_attempts',
      'replan_generation_failed',
      'empty_branch_after_execute',
      'cannot_generate_plan: ## Task Timed Out **Task ID:** 4ff...',
      'cannot_generate_plan: parse error at line 42',
      'cannot_generate_plan: generated plan output did not match Task schema',
      JSON.stringify({
        code: 'plan_description_quality_below_threshold',
        score: 60,
        threshold: 80,
        missing_specificity_signals: ['estimated_scope'],
      }),
    ];
    for (const reason of migratable) {
      it(`migrates: ${reason.slice(0, 80)}`, () => {
        expect(isMigratable(reason)).toBe(true);
      });
    }
  });

  describe('reasons that should NOT migrate (legitimately terminal)', () => {
    const notMigratable = [
      // Operator manual rejection
      'Rejected by user',
      'Rejected by user: not relevant',
      // Scout-proven impossibility / data validity
      'cannot_generate_plan: no description',
      // Branch policy violations (security/integrity)
      'branch_stale_vs_main',
      'branch_stale_vs_master',
      'branch_stale_vs_base',
      // Other terminal categories the user might extend later
      'meta_task_no_code_output',
      'pre_written_plan_rejected_by_quality_gate',
      // Empty / invalid input
      '',
      null,
      undefined,
    ];
    for (const reason of notMigratable) {
      it(`does NOT migrate: ${String(reason).slice(0, 60) || '<empty>'}`, () => {
        expect(isMigratable(reason)).toBe(false);
      });
    }
  });

  describe('JSON-payload rejection reasons', () => {
    it('matches the canonical rejectPayload shape', () => {
      const payload = {
        code: 'plan_description_quality_below_threshold',
        failing_task_index: 1,
        failing_task_title: 'Make X catchable',
        score: 60,
        threshold: 80,
        missing_specificity_signals: ['estimated_scope'],
        reasons: ['missing scope'],
      };
      expect(isMigratable(JSON.stringify(payload))).toBe(true);
    });

    it('does NOT match other JSON payloads', () => {
      const otherPayload = JSON.stringify({ code: 'something_else', score: 0 });
      expect(isMigratable(otherPayload)).toBe(false);
    });

    it('is robust to malformed JSON (does not throw)', () => {
      expect(isMigratable('{not really json')).toBe(false);
    });
  });
});
