'use strict';

const fs = require('fs');
const path = require('path');

describe('Phase W: runArchitectCycle deadline + structured warns', () => {
  const archSrc = fs.readFileSync(
    path.join(__dirname, '..', 'factory', 'architect-runner.js'),
    'utf8',
  );

  describe('deadline parity with submitArchitectJsonPrompt (Phase T)', () => {
    it('runArchitectCycle uses a deadlineMs constant of at least 15 * 60 * 1000', () => {
      // Both architect entry points (runArchitectLLM/runArchitectCycle and
      // submitArchitectJsonPrompt) must give codex enough time to finish
      // when the queue is congested. Phase T fixed one; Phase W fixed the
      // other.
      const matches = [...archSrc.matchAll(/deadlineMs\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/g)];
      expect(matches.length).toBeGreaterThanOrEqual(2);
      for (const m of matches) {
        const minutes = Number(m[1]);
        expect(minutes).toBeGreaterThanOrEqual(15);
      }
    });

    it('no architect deadline is hardcoded as 5 * 60 * 1000', () => {
      // Regression guard: a future patch must not silently revert either
      // architect deadline back to the old 5min that left tasks giving up
      // before codex could land them. \b prevents matching inside 15*60*1000.
      const fiveMinHits = archSrc.match(/\b5\s*\*\s*60\s*\*\s*1000\b/g) || [];
      expect(fiveMinHits.length).toBe(0);
    });
  });

  describe('structured warn parity with submitArchitectJsonPrompt (Phase Q)', () => {
    // Phase Q tagged the 5 null-return paths in submitArchitectJsonPrompt
    // with [architect-submit] <mode>. Phase W gives the parallel paths in
    // runArchitectCycle the same treatment under the [architect-cycle] tag.
    const expectedWarns = [
      '[architect-cycle] no_task_id',
      '[architect-cycle] submit_failed',
      '[architect-cycle] task_vanished',
      '[architect-cycle] deadline_exceeded',
    ];

    for (const tag of expectedWarns) {
      it(`emits "${tag}" warn`, () => {
        expect(archSrc).toContain(tag);
      });
    }

    it('emits task_failed/task_cancelled warn with provider + error_tail', () => {
      // Same shape as Phase Q's task_${task.status} warn.
      expect(archSrc).toMatch(/\[architect-cycle\] task_\$\{task\.status\}/);
      expect(archSrc).toMatch(/error_tail=/);
    });

    it('drops the legacy "Architect task timed out" logger.warn call', () => {
      // The old generic message gave operators no way to grep by mode.
      // Phase W replaced it with the structured deadline_exceeded warn.
      // Match only logger.warn invocations, not comments referencing the
      // old wording.
      expect(archSrc).not.toMatch(/logger\.warn\([^)]*Architect task timed out/);
    });

    it('drops the legacy "Failed to submit architect task" logger.warn call', () => {
      expect(archSrc).not.toMatch(/logger\.warn\([^)]*Failed to submit architect task/);
    });
  });
});
