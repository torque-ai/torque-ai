'use strict';

const fs = require('fs');
const path = require('path');

describe('runArchitectCycle: poll-only, no wall-clock deadline', () => {
  const archSrc = fs.readFileSync(
    path.join(__dirname, '..', 'factory', 'architect-runner.js'),
    'utf8',
  );

  describe('no hardcoded wall-clock deadline (2026-05-02 policy)', () => {
    it('does not declare a deadlineMs constant in architect-runner.js', () => {
      // 2026-05-02: the previous Phase T/W alignment kept hardcoded
      // wall-clock budgets (15min) on both architect entry points. Even
      // aligned, those budgets killed viable codex work that legitimately
      // exceeded the cap on busy days. The new policy: poll until the
      // task reaches a terminal state, and let stall detection bound
      // hung tasks. Regression guard: no deadlineMs declarations.
      expect(archSrc).not.toMatch(/deadlineMs\s*=/);
    });

    it('does not bound the architect poll loop by Date.now()', () => {
      // The poll loops should be `while (true)` with terminal-state exits,
      // not `while (Date.now() < deadline)`.
      expect(archSrc).not.toMatch(/while\s*\(\s*Date\.now\(\)\s*</);
    });

    it('passes timeout_minutes: 0 (unbounded) to submitFactoryInternalTask', () => {
      // 0 explicitly opts into "no timeout" at the provider layer.
      // Omitting the field would default to 10 in internal-task-submit,
      // which is the destructive behavior we removed.
      const zeroTimeoutHits = archSrc.match(/timeout_minutes:\s*0\b/g) || [];
      expect(zeroTimeoutHits.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('structured warns survive (Phase Q parity)', () => {
    // Each non-deadline failure mode still emits its tagged warn so
    // operators can grep [architect-cycle] in logs.
    const expectedWarns = [
      '[architect-cycle] no_task_id',
      '[architect-cycle] submit_failed',
      '[architect-cycle] task_vanished',
    ];

    for (const tag of expectedWarns) {
      it(`emits "${tag}" warn`, () => {
        expect(archSrc).toContain(tag);
      });
    }

    it('emits task_failed/task_cancelled warn with provider + error_tail', () => {
      expect(archSrc).toMatch(/\[architect-cycle\] task_\$\{task\.status\}/);
      expect(archSrc).toMatch(/error_tail=/);
    });

    it('drops the deadline_exceeded warn (poll-only policy)', () => {
      expect(archSrc).not.toMatch(/\[architect-cycle\] deadline_exceeded/);
    });

    it('drops the legacy "Architect task timed out" logger.warn call', () => {
      expect(archSrc).not.toMatch(/logger\.warn\([^)]*Architect task timed out/);
    });

    it('drops the legacy "Failed to submit architect task" logger.warn call', () => {
      expect(archSrc).not.toMatch(/logger\.warn\([^)]*Failed to submit architect task/);
    });
  });
});
