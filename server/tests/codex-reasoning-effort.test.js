'use strict';

const { classifyReasoningEffort } = require('../execution/codex-reasoning-effort');

describe('classifyReasoningEffort', () => {
  describe('explicit metadata.reasoning_effort override', () => {
    it('honors valid explicit value (low) over heuristics', () => {
      const result = classifyReasoningEffort({
        task_description: 'You are the Architect for a software factory...',
        metadata: { factory_internal: true, reasoning_effort: 'low' },
      });
      expect(result.tier).toBe('explicit');
      expect(result.reasoning_effort).toBe('low');
    });

    it('honors valid explicit value (xhigh) on a shell-only task', () => {
      const result = classifyReasoningEffort({
        task_description: 'Run `bash scripts/foo.sh`',
        metadata: { reasoning_effort: 'xhigh' },
      });
      expect(result.tier).toBe('explicit');
      expect(result.reasoning_effort).toBe('xhigh');
    });

    it('ignores invalid explicit value and falls back to heuristics', () => {
      const result = classifyReasoningEffort({
        task_description: 'Run `bash scripts/foo.sh`',
        metadata: { reasoning_effort: 'banana' },
      });
      expect(result.tier).toBe('simple');
      expect(result.reasoning_effort).toBe('low');
    });
  });

  describe('shell-execute-only detection (simple tier → low)', () => {
    it('matches "Run `cmd`" first-line pattern', () => {
      const result = classifyReasoningEffort({
        task_description: 'Run `bash scripts/prune-merged-worktrees.sh --apply` and report which orphan worktrees got removed.',
      });
      expect(result.tier).toBe('simple');
      expect(result.reasoning_effort).toBe('low');
      expect(result.reason).toBe('shell_execute_only');
    });

    it('matches "Execute `cmd`"', () => {
      const result = classifyReasoningEffort({
        task_description: 'Execute `npm install` and report the dependency count.',
      });
      expect(result.tier).toBe('simple');
      expect(result.reasoning_effort).toBe('low');
    });

    it('matches "Invoke `cmd`"', () => {
      const result = classifyReasoningEffort({
        task_description: 'Invoke `git status` to check the working tree.',
      });
      expect(result.tier).toBe('simple');
    });

    it('case insensitive', () => {
      const result = classifyReasoningEffort({
        task_description: 'RUN `ls -la`',
      });
      expect(result.tier).toBe('simple');
    });

    it('does NOT match when description is too long (>1500 chars)', () => {
      const longDesc = 'Run `bash foo.sh` ' + ('extra prose '.repeat(200));
      const result = classifyReasoningEffort({ task_description: longDesc });
      expect(result.tier).toBe('complex');
    });

    it('does NOT match when first line is plain prose', () => {
      const result = classifyReasoningEffort({
        task_description: 'Update the prune script to handle Windows file locks.\n\nRun `bash scripts/prune.sh` after.',
      });
      expect(result.tier).toBe('complex');
    });
  });

  describe('factory_internal (normal tier → high)', () => {
    it('factory_internal=true returns high', () => {
      const result = classifyReasoningEffort({
        task_description: 'You are the Architect for a software factory...',
        metadata: { factory_internal: true, kind: 'architect_cycle' },
      });
      expect(result.tier).toBe('normal');
      expect(result.reasoning_effort).toBe('high');
      expect(result.reason).toBe('factory_internal');
    });

    it('handles JSON-string metadata', () => {
      const result = classifyReasoningEffort({
        task_description: 'You are a quality reviewer...',
        metadata: JSON.stringify({ factory_internal: true }),
      });
      expect(result.reasoning_effort).toBe('high');
    });
  });

  describe('factory_internal kind-specific low (simple tier → low)', () => {
    it('plan_quality_review returns low', () => {
      const result = classifyReasoningEffort({
        task_description: 'You are a quality reviewer...',
        metadata: { factory_internal: true, kind: 'plan_quality_review' },
      });
      expect(result.tier).toBe('simple');
      expect(result.reasoning_effort).toBe('low');
      expect(result.reason).toContain('plan_quality_review');
    });

    it('replan_rewrite returns low', () => {
      const result = classifyReasoningEffort({
        task_description: 'Rewrite this work item...',
        metadata: { factory_internal: true, kind: 'replan_rewrite' },
      });
      expect(result.reasoning_effort).toBe('low');
    });

    it('verify_review returns low', () => {
      const result = classifyReasoningEffort({
        task_description: 'Review verify failure...',
        metadata: { factory_internal: true, kind: 'verify_review' },
      });
      expect(result.reasoning_effort).toBe('low');
    });

    it('factory_internal with non-low kind still returns high', () => {
      const result = classifyReasoningEffort({
        task_description: 'You are the Architect...',
        metadata: { factory_internal: true, kind: 'architect_cycle' },
      });
      expect(result.tier).toBe('normal');
      expect(result.reasoning_effort).toBe('high');
    });
  });

  describe('factory scout (normal tier → high)', () => {
    it('generic mode=scout returns high', () => {
      const result = classifyReasoningEffort({
        task_description: 'You are a codebase analyst...',
        metadata: { mode: 'scout', diffusion: true, reason: 'manual_diffusion' },
      });
      expect(result.tier).toBe('normal');
      expect(result.reasoning_effort).toBe('high');
      expect(result.reason).toBe('factory_scout');
    });

    it('bounded starvation recovery scouts return low', () => {
      const result = classifyReasoningEffort({
        task_description: 'You are a bounded work-item scout...',
        metadata: { mode: 'scout', diffusion: true, reason: 'factory_starvation_recovery' },
      });
      expect(result.tier).toBe('simple');
      expect(result.reasoning_effort).toBe('low');
      expect(result.reason).toBe('factory_scout_low_reasoning_reason:factory_starvation_recovery');
    });
  });

  describe('complex tier (default → no override)', () => {
    it('returns null reasoning_effort for plain coding tasks', () => {
      const result = classifyReasoningEffort({
        task_description: 'Implement a new feature in src/foo.js that adds a retry loop.',
      });
      expect(result.tier).toBe('complex');
      expect(result.reasoning_effort).toBeNull();
    });

    it('returns null when metadata is missing', () => {
      const result = classifyReasoningEffort({ task_description: 'Refactor the database layer.' });
      expect(result.reasoning_effort).toBeNull();
    });

    it('returns null when metadata is malformed JSON', () => {
      const result = classifyReasoningEffort({
        task_description: 'Multi-file refactor across server/factory/.',
        metadata: '{not valid json',
      });
      expect(result.reasoning_effort).toBeNull();
    });

    it('returns null when task is null/undefined-shaped', () => {
      const result = classifyReasoningEffort({});
      expect(result.reasoning_effort).toBeNull();
    });
  });

  describe('precedence', () => {
    it('explicit override beats shell-detection', () => {
      const result = classifyReasoningEffort({
        task_description: 'Run `bash foo.sh`',
        metadata: { reasoning_effort: 'high' },
      });
      expect(result.tier).toBe('explicit');
      expect(result.reasoning_effort).toBe('high');
    });

    it('shell-detection beats factory_internal', () => {
      // Edge case: a factory_internal task that's also shell-shaped should
      // still get treated as simple. In practice factory_internal tasks
      // aren't shell-shaped, but the heuristic is consistent: simple wins
      // because the description is the strongest signal.
      const result = classifyReasoningEffort({
        task_description: 'Run `npm test`',
        metadata: { factory_internal: true },
      });
      expect(result.tier).toBe('simple');
      expect(result.reasoning_effort).toBe('low');
    });
  });
});
