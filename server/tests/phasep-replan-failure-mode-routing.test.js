/**
 * Phase P (2026-04-30): replan-recovery routes failure-mode-specific
 * reject_reasons to the rewrite-description strategy AND the architect's
 * rewrite prompt includes failure-mode-specific guidance.
 *
 * Pre-Phase-P, when Phase N's pre-submission existence guard caught a
 * plan referencing missing files, the loop-controller surfaced the
 * failure as `reject_reason: "task_N_failed"` (a generic bucket). That
 * pattern matches `^task_.+_failed$` in rejected-recovery's pattern set,
 * which doesn't trigger replan — it just bumps the work item through
 * recovery strategies that retry the same broken plan.
 *
 * Phase P fix:
 * 1. loop-controller.js uses `${violation.rule}: task_${N}` when the
 *    executor surfaces a violation, preserving the specific failure mode.
 * 2. rewrite-description.js's reasonPatterns includes the new prefixes
 *    so replan-recovery routes Phase N violations to the rewrite path.
 * 3. architect-runner.js's buildRewritePrompt injects failure-mode-
 *    specific guidance via getFailureModeGuidance(priorReason) so codex
 *    knows HOW to pivot, not just THAT the prior attempt failed.
 *
 * This test covers (3) — the prompt content. The pattern matching in (2)
 * is covered by the existing reasonPatterns array semantics. The
 * loop-controller change in (1) is verified by reading the diff (it
 * preserves backward compatibility when no violation is set).
 */

'use strict';

const {
  buildRewritePrompt,
  getFailureModeGuidance,
} = require('../factory/architect-runner');

describe('Phase P: failure-mode-specific rewrite guidance', () => {
  describe('getFailureModeGuidance', () => {
    it('returns empty string for unknown reasons', () => {
      expect(getFailureModeGuidance('whatever_random_reason')).toBe('');
      expect(getFailureModeGuidance('')).toBe('');
      expect(getFailureModeGuidance(null)).toBe('');
      expect(getFailureModeGuidance(undefined)).toBe('');
    });

    it('returns missing-files guidance for task_targets_missing_files (with task suffix)', () => {
      const guidance = getFailureModeGuidance('task_targets_missing_files: task_1');
      expect(guidance).toContain('referenced files that do not exist');
      expect(guidance).toContain('greenfield');
      expect(guidance).toContain('Do NOT keep the same phantom path');
    });

    it('returns heavy-validation guidance for task_avoids_local_heavy_validation', () => {
      const guidance = getFailureModeGuidance('task_avoids_local_heavy_validation: task_1');
      expect(guidance).toContain('heavy local validation command');
      expect(guidance).toContain('verify_command');
      expect(guidance).toContain('git commit');
    });

    it('returns scope-cut guidance for cannot_generate_plan', () => {
      const guidance = getFailureModeGuidance('cannot_generate_plan: provider timeout after 600s');
      expect(guidance).toContain('Cut scope by ~50%');
      expect(guidance).toContain('1-3 SPECIFIC files');
    });

    it('returns specificity guidance for pre_written_plan_rejected_by_quality_gate', () => {
      const guidance = getFailureModeGuidance('pre_written_plan_rejected_by_quality_gate');
      expect(guidance).toContain('deterministic quality gate');
      expect(guidance).toContain('Backtick-wrapped paths');
      expect(guidance).toContain('verification command');
    });

    it('is case-insensitive on the reason prefix', () => {
      expect(getFailureModeGuidance('TASK_TARGETS_MISSING_FILES: task_1')).toContain('phantom path');
    });
  });

  describe('buildRewritePrompt', () => {
    const baseWorkItem = {
      id: 42,
      title: 'Fix the thing',
      description: 'Edit `src/foo.ts` to add bar.',
      reject_reason: null,
    };

    it('includes the original title and description', () => {
      const prompt = buildRewritePrompt({
        workItem: baseWorkItem,
        history: { priorReason: 'cannot_generate_plan: timeout', recoveryRecords: [] },
      });
      expect(prompt).toContain('Original title: Fix the thing');
      expect(prompt).toContain('Edit `src/foo.ts` to add bar.');
    });

    it('embeds failure-mode-specific guidance from history.priorReason', () => {
      const prompt = buildRewritePrompt({
        workItem: baseWorkItem,
        history: {
          priorReason: 'task_targets_missing_files: task_1',
          recoveryRecords: [],
        },
      });
      expect(prompt).toContain('FAILURE-MODE GUIDANCE');
      expect(prompt).toContain('referenced files that do not exist');
      expect(prompt).toContain('phantom path');
    });

    it('falls back to workItem.reject_reason when history.priorReason is missing', () => {
      const wi = { ...baseWorkItem, reject_reason: 'task_avoids_local_heavy_validation: task_2' };
      const prompt = buildRewritePrompt({
        workItem: wi,
        history: { recoveryRecords: [] },
      });
      expect(prompt).toContain('heavy local validation command');
    });

    it('omits guidance section when reason has no specific match', () => {
      const prompt = buildRewritePrompt({
        workItem: baseWorkItem,
        history: { priorReason: 'unknown_oddity_xyz', recoveryRecords: [] },
      });
      expect(prompt).not.toContain('FAILURE-MODE GUIDANCE');
      // Generic "rewrite to be specific" instructions still present.
      expect(prompt).toContain('Rewrite to be specific');
    });

    it('preserves the JSON output instructions (closing instruction)', () => {
      const prompt = buildRewritePrompt({
        workItem: baseWorkItem,
        history: {
          priorReason: 'task_targets_missing_files: task_1',
          recoveryRecords: [],
        },
      });
      // Guidance must come BEFORE the JSON output instructions, so the
      // model sees the constraints first and the output schema last.
      const guidanceIdx = prompt.indexOf('FAILURE-MODE GUIDANCE');
      const jsonIdx = prompt.indexOf('Output strict JSON ONLY');
      expect(guidanceIdx).toBeGreaterThan(0);
      expect(jsonIdx).toBeGreaterThan(guidanceIdx);
    });

    it('includes the recovery log when prior attempts exist', () => {
      const prompt = buildRewritePrompt({
        workItem: baseWorkItem,
        history: {
          priorReason: 'cannot_generate_plan: timeout',
          recoveryRecords: [
            { attempt: 1, strategy: 'rewrite-description', outcome: 'rewrote', timestamp: '2026-04-30T12:00:00Z' },
            { attempt: 2, strategy: 'decompose', outcome: 'unrecoverable', timestamp: '2026-04-30T13:00:00Z' },
          ],
        },
      });
      expect(prompt).toContain('attempt 1: strategy="rewrite-description"');
      expect(prompt).toContain('attempt 2: strategy="decompose"');
    });
  });

  describe('rewrite-description strategy reasonPatterns', () => {
    it('matches the new Phase N / heavy-validation patterns', () => {
      const { reasonPatterns } = require('../factory/recovery-strategies/rewrite-description');
      const matches = (reason) => reasonPatterns.some((p) => p.test(reason));

      // Phase P additions
      expect(matches('task_targets_missing_files: task_1')).toBe(true);
      expect(matches('task_targets_missing_files')).toBe(true);
      expect(matches('task_avoids_local_heavy_validation: task_2')).toBe(true);

      // Pre-existing patterns still match
      expect(matches('cannot_generate_plan: provider timed out')).toBe(true);
      expect(matches('pre_written_plan_rejected_by_quality_gate')).toBe(true);
      expect(matches('Rejected by user')).toBe(true);

      // Generic task_N_failed should NOT match (it goes to rejected-recovery)
      expect(matches('task_1_failed')).toBe(false);
      expect(matches('task_42_failed')).toBe(false);
    });
  });
});
