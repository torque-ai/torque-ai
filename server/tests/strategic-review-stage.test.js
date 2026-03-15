'use strict';

const { strategicReviewStage } = require('../execution/strategic-review-stage');

function makeCtx(overrides = {}) {
  return {
    taskId: 'test-task-001',
    status: 'completed',
    code: 0,
    output: 'Task completed successfully',
    errorOutput: '',
    task: {
      id: 'test-task-001',
      metadata: JSON.stringify({ needs_review: true }),
      task_description: 'Implement the notification system',
    },
    validationStages: {},
    proc: { provider: 'codex' },
    ...overrides,
  };
}

describe('strategicReviewStage (Experiment 4)', () => {
  describe('skip conditions', () => {
    it('skips when task status is not completed', () => {
      const ctx = makeCtx({ status: 'failed' });
      strategicReviewStage(ctx);
      expect(ctx.status).toBe('failed');
    });

    it('skips when needs_review is not set in metadata', () => {
      const ctx = makeCtx({
        task: { metadata: JSON.stringify({}) },
      });
      strategicReviewStage(ctx);
      expect(ctx.status).toBe('completed');
    });

    it('skips when metadata is null', () => {
      const ctx = makeCtx({
        task: { metadata: null },
      });
      strategicReviewStage(ctx);
      expect(ctx.status).toBe('completed');
    });

    it('skips when metadata is malformed JSON', () => {
      const ctx = makeCtx({
        task: { metadata: 'not-json' },
      });
      strategicReviewStage(ctx);
      expect(ctx.status).toBe('completed');
    });
  });

  describe('approval path', () => {
    it('approves task with no validation failures and no size delta', () => {
      const ctx = makeCtx();
      strategicReviewStage(ctx);
      expect(ctx.status).toBe('completed');
      expect(ctx.code).toBe(0);

      const metadata = JSON.parse(ctx.task.metadata);
      expect(metadata.strategic_review).toBeDefined();
      expect(metadata.strategic_review.decision).toBe('approve');
    });

    it('approves task with warning-level stage outcomes', () => {
      const ctx = makeCtx({
        validationStages: {
          safeguard_checks: { outcome: 'no_change' },
          fuzzy_repair: { outcome: 'output_mutated' },
        },
      });
      strategicReviewStage(ctx);
      expect(ctx.status).toBe('completed');
    });
  });

  describe('rejection path', () => {
    it('rejects task when validation stages have errors', () => {
      const ctx = makeCtx({
        validationStages: {
          safeguard_checks: { outcome: 'error', error: 'File truncated' },
        },
        task: {
          metadata: JSON.stringify({ needs_review: true }),
        },
      });
      strategicReviewStage(ctx);
      expect(ctx.status).toBe('failed');
      expect(ctx.code).toBe(1);
      expect(ctx.errorOutput).toContain('[STRATEGIC REVIEW] Rejected');
    });

    it('rejects task when file size delta exceeds threshold', () => {
      const ctx = makeCtx({
        task: {
          metadata: JSON.stringify({
            needs_review: true,
            finalization: { file_size_delta_pct: -65 },
          }),
        },
      });
      strategicReviewStage(ctx);
      expect(ctx.status).toBe('failed');
      expect(ctx.code).toBe(1);
      expect(ctx.errorOutput).toContain('65%');
    });

    it('stores review result in metadata on rejection', () => {
      const ctx = makeCtx({
        task: {
          metadata: JSON.stringify({
            needs_review: true,
            finalization: { file_size_delta_pct: -75 },
          }),
        },
      });
      strategicReviewStage(ctx);
      const metadata = JSON.parse(ctx.task.metadata);
      expect(metadata.strategic_review.decision).toBe('reject');
      expect(metadata.strategic_review.source).toBe('deterministic');
    });
  });

  describe('metadata handling', () => {
    it('handles already-parsed object metadata', () => {
      const ctx = makeCtx({
        task: {
          metadata: { needs_review: true },
        },
      });
      strategicReviewStage(ctx);
      expect(ctx.status).toBe('completed');
    });

    it('preserves existing metadata fields', () => {
      const ctx = makeCtx({
        task: {
          metadata: JSON.stringify({
            needs_review: true,
            existing_field: 'keep_me',
          }),
        },
      });
      strategicReviewStage(ctx);
      const metadata = JSON.parse(ctx.task.metadata);
      expect(metadata.existing_field).toBe('keep_me');
      expect(metadata.strategic_review).toBeDefined();
    });
  });
});
