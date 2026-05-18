import { describe, it, expect } from 'vitest';

import {
  PLAN_DESCRIPTION_QUALITY_THRESHOLD,
  buildPlanDescriptionQualityRejectPayload,
  buildPlanQualityGateRejectPayload,
  buildTerminalEscalationRejectReason,
} from '../factory/plan-builders/quality-reject.js';

// ---------------------------------------------------------------------------
// Constant sanity check
// ---------------------------------------------------------------------------
describe('PLAN_DESCRIPTION_QUALITY_THRESHOLD', () => {
  it('is 80', () => {
    expect(PLAN_DESCRIPTION_QUALITY_THRESHOLD).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// buildPlanDescriptionQualityRejectPayload
// ---------------------------------------------------------------------------
describe('buildPlanDescriptionQualityRejectPayload', () => {
  it('maps a single failure into the payload', () => {
    const input = {
      threshold: 75,
      failures: [
        {
          task_index: 2,
          task_title: 'Add auth module',
          score: 40,
          threshold: 75,
          missing_signals: ['file_paths', 'line_numbers'],
          reasons: ['Too vague', 'No file references'],
        },
      ],
    };

    const result = buildPlanDescriptionQualityRejectPayload(input);

    expect(result).toEqual({
      code: 'plan_description_quality_below_threshold',
      failing_task_index: 2,
      failing_task_title: 'Add auth module',
      score: 40,
      threshold: 75,
      missing_specificity_signals: ['file_paths', 'line_numbers'],
      reasons: ['Too vague', 'No file references'],
      failing_tasks: [
        {
          task_index: 2,
          task_title: 'Add auth module',
          score: 40,
          threshold: 75,
          missing_specificity_signals: ['file_paths', 'line_numbers'],
          reasons: ['Too vague', 'No file references'],
        },
      ],
    });
  });

  it('maps multiple failures and uses the first for top-level fields', () => {
    const input = {
      threshold: 70,
      failures: [
        {
          task_index: 0,
          task_title: 'First task',
          score: 30,
          threshold: 70,
          missing_signals: ['imports'],
          reasons: ['Missing imports'],
        },
        {
          task_index: 3,
          task_title: 'Fourth task',
          score: 50,
          threshold: 70,
          missing_signals: ['tests'],
          reasons: ['No test plan'],
        },
      ],
    };

    const result = buildPlanDescriptionQualityRejectPayload(input);

    // Top-level fields come from first failure
    expect(result.failing_task_index).toBe(0);
    expect(result.failing_task_title).toBe('First task');
    expect(result.score).toBe(30);
    expect(result.threshold).toBe(70);
    expect(result.missing_specificity_signals).toEqual(['imports']);
    expect(result.reasons).toEqual(['Missing imports']);

    // All failures are preserved in failing_tasks
    expect(result.failing_tasks).toHaveLength(2);
    expect(result.failing_tasks[1].task_index).toBe(3);
    expect(result.failing_tasks[1].task_title).toBe('Fourth task');
  });

  it('handles empty failures array', () => {
    const result = buildPlanDescriptionQualityRejectPayload({ failures: [], threshold: 90 });

    expect(result).toEqual({
      code: 'plan_description_quality_below_threshold',
      failing_task_index: null,
      failing_task_title: null,
      score: null,
      threshold: 90,
      missing_specificity_signals: [],
      reasons: [],
      failing_tasks: [],
    });
  });

  it('handles null input — defaults threshold to PLAN_DESCRIPTION_QUALITY_THRESHOLD', () => {
    const result = buildPlanDescriptionQualityRejectPayload(null);

    expect(result.code).toBe('plan_description_quality_below_threshold');
    expect(result.failing_tasks).toEqual([]);
    expect(result.threshold).toBe(PLAN_DESCRIPTION_QUALITY_THRESHOLD);
    expect(result.failing_task_index).toBeNull();
    expect(result.score).toBeNull();
    expect(result.missing_specificity_signals).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  it('handles undefined input', () => {
    const result = buildPlanDescriptionQualityRejectPayload(undefined);

    expect(result.threshold).toBe(PLAN_DESCRIPTION_QUALITY_THRESHOLD);
    expect(result.failing_tasks).toEqual([]);
  });

  it('renames missing_signals to missing_specificity_signals in mapped tasks', () => {
    const input = {
      failures: [
        {
          task_index: 1,
          task_title: 'T',
          score: 55,
          threshold: 60,
          missing_signals: ['exact_line', 'function_name'],
          reasons: [],
        },
      ],
    };

    const result = buildPlanDescriptionQualityRejectPayload(input);
    expect(result.failing_tasks[0].missing_specificity_signals).toEqual([
      'exact_line',
      'function_name',
    ]);
    // The original key name should not leak through
    expect(result.failing_tasks[0]).not.toHaveProperty('missing_signals');
  });
});

// ---------------------------------------------------------------------------
// buildPlanQualityGateRejectPayload
// ---------------------------------------------------------------------------
describe('buildPlanQualityGateRejectPayload', () => {
  it('maps hard fails with rule, detail, and taskNumber', () => {
    const verdict = {
      hardFails: [
        { rule: 'no_empty_tasks', detail: 'Task 2 has empty body', taskNumber: 2 },
      ],
      feedbackPrompt: 'Please add task bodies.',
    };

    const result = buildPlanQualityGateRejectPayload(verdict);

    expect(result).toEqual({
      code: 'plan_quality_gate_failed',
      failing_task_index: 1, // taskNumber 2 → index 1
      failing_task_title: null,
      score: null,
      threshold: null,
      missing_specificity_signals: ['no_empty_tasks'],
      reasons: ['Task 2 has empty body'],
      failing_tasks: [
        {
          task_index: 1,
          task_title: null,
          score: null,
          threshold: null,
          missing_specificity_signals: ['no_empty_tasks'],
          reasons: ['Task 2 has empty body'],
          rule: 'no_empty_tasks',
          task_number: 2,
        },
      ],
      feedback_prompt: 'Please add task bodies.',
    });
  });

  it('deduplicates rules in top-level missing_specificity_signals', () => {
    const verdict = {
      hardFails: [
        { rule: 'no_stubs', detail: 'Stub in task 1', taskNumber: 1 },
        { rule: 'no_stubs', detail: 'Stub in task 3', taskNumber: 3 },
        { rule: 'min_lines', detail: 'Task 2 too short', taskNumber: 2 },
      ],
    };

    const result = buildPlanQualityGateRejectPayload(verdict);

    // Rules are deduplicated via Set
    expect(result.missing_specificity_signals).toEqual(['no_stubs', 'min_lines']);
    // Reasons preserve all entries
    expect(result.reasons).toEqual(['Stub in task 1', 'Stub in task 3', 'Task 2 too short']);
    // All failing tasks are present
    expect(result.failing_tasks).toHaveLength(3);
  });

  it('handles empty hardFails array', () => {
    const result = buildPlanQualityGateRejectPayload({ hardFails: [] });

    expect(result).toEqual({
      code: 'plan_quality_gate_failed',
      failing_task_index: null,
      failing_task_title: null,
      score: null,
      threshold: null,
      missing_specificity_signals: [],
      reasons: [],
      failing_tasks: [],
      feedback_prompt: null,
    });
  });

  it('handles null/undefined input', () => {
    const resultNull = buildPlanQualityGateRejectPayload(null);
    const resultUndef = buildPlanQualityGateRejectPayload(undefined);

    for (const result of [resultNull, resultUndef]) {
      expect(result.code).toBe('plan_quality_gate_failed');
      expect(result.failing_tasks).toEqual([]);
      expect(result.missing_specificity_signals).toEqual([]);
      expect(result.reasons).toEqual([]);
      expect(result.feedback_prompt).toBeNull();
    }
  });

  it('falls back rule to detail when detail is missing', () => {
    const verdict = {
      hardFails: [{ rule: 'max_tasks', taskNumber: 5 }],
    };

    const result = buildPlanQualityGateRejectPayload(verdict);

    // detail is undefined, so reasons falls back to rule
    expect(result.reasons).toEqual(['max_tasks']);
    expect(result.failing_tasks[0].reasons).toEqual(['max_tasks']);
  });

  it('handles hardFail entries with no rule and no detail', () => {
    const verdict = {
      hardFails: [{ taskNumber: 1 }],
    };

    const result = buildPlanQualityGateRejectPayload(verdict);

    // rule is falsy → filtered out of top-level rules
    expect(result.missing_specificity_signals).toEqual([]);
    // detail || rule are both falsy → filtered by .filter(Boolean)
    expect(result.reasons).toEqual([]);
    expect(result.failing_tasks[0].rule).toBeNull();
    expect(result.failing_tasks[0].reasons).toEqual([]);
    expect(result.failing_tasks[0].missing_specificity_signals).toEqual([]);
  });

  it('sets task_index to null when taskNumber is not a number', () => {
    const verdict = {
      hardFails: [{ rule: 'r1', detail: 'd1', taskNumber: 'three' }],
    };

    const result = buildPlanQualityGateRejectPayload(verdict);

    expect(result.failing_task_index).toBeNull();
    expect(result.failing_tasks[0].task_index).toBeNull();
    expect(result.failing_tasks[0].task_number).toBeNull();
  });

  it('passes feedbackPrompt through as feedback_prompt', () => {
    const verdict = {
      hardFails: [],
      feedbackPrompt: 'Rework the plan with more detail.',
    };

    const result = buildPlanQualityGateRejectPayload(verdict);
    expect(result.feedback_prompt).toBe('Rework the plan with more detail.');
  });

  it('handles non-array hardFails gracefully', () => {
    const verdict = { hardFails: 'not-an-array' };
    const result = buildPlanQualityGateRejectPayload(verdict);

    expect(result.failing_tasks).toEqual([]);
    expect(result.missing_specificity_signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildTerminalEscalationRejectReason
// ---------------------------------------------------------------------------
describe('buildTerminalEscalationRejectReason', () => {
  it('returns existing reject_reason when it already starts with "escalation_exhausted"', () => {
    const workItem = { reject_reason: 'escalation_exhausted: some_kind (some_shape)' };
    const evidence = { kind: 'new_kind', reason_shape: 'new_shape' };

    const result = buildTerminalEscalationRejectReason(workItem, evidence);
    expect(result).toBe('escalation_exhausted: some_kind (some_shape)');
  });

  it('is case-insensitive on the idempotency guard', () => {
    const workItem = { reject_reason: 'ESCALATION_EXHAUSTED: old' };
    const result = buildTerminalEscalationRejectReason(workItem, { kind: 'new' });
    expect(result).toBe('ESCALATION_EXHAUSTED: old');
  });

  it('constructs new reason from evidence.kind and evidence.reason_shape', () => {
    const workItem = { reject_reason: 'some_other_reason' };
    const evidence = { kind: 'stall_loop', reason_shape: 'repeated_timeout' };

    const result = buildTerminalEscalationRejectReason(workItem, evidence);
    expect(result).toBe('escalation_exhausted: stall_loop (repeated_timeout)');
  });

  it('omits shape suffix when evidence.reason_shape is absent', () => {
    const workItem = {};
    const evidence = { kind: 'plan_rejected' };

    const result = buildTerminalEscalationRejectReason(workItem, evidence);
    expect(result).toBe('escalation_exhausted: plan_rejected');
  });

  it('defaults kind to "terminal_escalation" when evidence.kind is missing', () => {
    const workItem = {};
    const evidence = {};

    const result = buildTerminalEscalationRejectReason(workItem, evidence);
    expect(result).toBe('escalation_exhausted: terminal_escalation');
  });

  it('handles null evidence — defaults kind and omits shape', () => {
    const result = buildTerminalEscalationRejectReason({}, null);
    expect(result).toBe('escalation_exhausted: terminal_escalation');
  });

  it('handles undefined evidence', () => {
    const result = buildTerminalEscalationRejectReason({}, undefined);
    expect(result).toBe('escalation_exhausted: terminal_escalation');
  });

  it('handles null workItem — no existing reject_reason to guard', () => {
    const result = buildTerminalEscalationRejectReason(null, { kind: 'budget_blown' });
    expect(result).toBe('escalation_exhausted: budget_blown');
  });

  it('handles undefined workItem', () => {
    const result = buildTerminalEscalationRejectReason(undefined, { kind: 'max_retries' });
    expect(result).toBe('escalation_exhausted: max_retries');
  });

  it('trims whitespace from existing reject_reason before checking guard', () => {
    const workItem = { reject_reason: '  escalation_exhausted: trimmed  ' };
    const result = buildTerminalEscalationRejectReason(workItem, { kind: 'new' });
    expect(result).toBe('escalation_exhausted: trimmed');
  });

  it('does not trigger guard for partial prefix match', () => {
    // "escalation_exhausted_extra" should NOT match /^escalation_exhausted\b/
    // because \b requires a word boundary right after "exhausted"
    const workItem = { reject_reason: 'escalation_exhaustedfoo' };
    const result = buildTerminalEscalationRejectReason(workItem, { kind: 'k1' });
    // "exhaustedfoo" — no word boundary after "exhausted", so guard does not fire
    expect(result).toBe('escalation_exhausted: k1');
  });

  it('fires guard for "escalation_exhausted" with word boundary', () => {
    const workItem = { reject_reason: 'escalation_exhausted' };
    const result = buildTerminalEscalationRejectReason(workItem, { kind: 'ignored' });
    expect(result).toBe('escalation_exhausted');
  });

  it('handles both workItem and evidence being null', () => {
    const result = buildTerminalEscalationRejectReason(null, null);
    expect(result).toBe('escalation_exhausted: terminal_escalation');
  });
});
