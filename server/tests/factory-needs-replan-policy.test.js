'use strict';

const {
  NEEDS_REPLAN_COOLDOWN_MS,
  getNeedsReplanCooldownInfo,
  getNeedsReplanSelectionPenalty,
  parseFactoryTimestampMs,
} = require('../factory/needs-replan-policy');

describe('factory needs_replan policy', () => {
  it('parses SQLite UTC timestamps as UTC instants', () => {
    expect(parseFactoryTimestampMs('2026-05-18 13:05:00')).toBe(Date.parse('2026-05-18T13:05:00Z'));
  });

  it('reports cooldown state for recently updated needs_replan items', () => {
    const updatedAt = Date.parse('2026-05-18T13:00:00Z');
    const info = getNeedsReplanCooldownInfo({
      status: 'needs_replan',
      updated_at: '2026-05-18 13:00:00',
    }, updatedAt + 60_000);

    expect(info).toMatchObject({
      active: true,
      updatedAtMs: updatedAt,
      remainingMs: NEEDS_REPLAN_COOLDOWN_MS - 60_000,
    });
  });

  it('penalizes repeated plan-quality replan candidates more than generic failures', () => {
    const planQuality = getNeedsReplanSelectionPenalty({
      status: 'needs_replan',
      reject_reason: 'plan_quality_gate_rejected_after_intrabatch_retries',
      origin_json: JSON.stringify({
        escalation_history: [
          { reason: 'pre_written_plan_rejected_by_quality_gate' },
          { reason: 'plan_quality_gate_rejected_after_intrabatch_retries' },
        ],
      }),
    });
    const generic = getNeedsReplanSelectionPenalty({
      status: 'needs_replan',
      reject_reason: 'cannot_generate_plan: parser returned no tasks',
      origin_json: JSON.stringify({
        escalation_history: [
          { reason: 'cannot_generate_plan' },
        ],
      }),
    });

    expect(planQuality).toEqual({ penalty: 36, label: 'plan_quality_or_noop_rejection' });
    expect(generic).toEqual({ penalty: 16, label: 'prior_replan_rejection' });
  });
});
