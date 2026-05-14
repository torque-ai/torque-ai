'use strict';

const fs = require('fs');
const path = require('path');

describe('runArchitectCycle: terminal-state polling with bounded provider tasks', () => {
  const archSrc = fs.readFileSync(
    path.join(__dirname, '..', 'factory', 'architect-runner.js'),
    'utf8',
  );

  describe('no outer poll-loop wall-clock deadline', () => {
    it('does not declare a deadlineMs constant in architect-runner.js', () => {
      // The runner should not maintain a second independent deadline on top
      // of the submitted task timeout. Poll terminal task state instead.
      expect(archSrc).not.toMatch(/deadlineMs\s*=/);
    });

    it('does not bound the architect poll loop by Date.now()', () => {
      // The poll loops should be `while (true)` with terminal-state exits,
      // not `while (Date.now() < deadline)`.
      expect(archSrc).not.toMatch(/while\s*\(\s*Date\.now\(\)\s*</);
    });

    it('passes the bounded architect timeout to submitFactoryInternalTask', () => {
      expect(archSrc).toMatch(/const\s+ARCHITECT_TASK_TIMEOUT_MINUTES\s*=\s*30\b/);
      const boundedTimeoutHits = archSrc.match(/timeout_minutes:\s*ARCHITECT_TASK_TIMEOUT_MINUTES\b/g) || [];
      expect(boundedTimeoutHits.length).toBeGreaterThanOrEqual(2);
      expect(archSrc).not.toMatch(/timeout_minutes:\s*0\b/);
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
