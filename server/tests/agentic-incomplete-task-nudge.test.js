/**
 * Tests for the incomplete-task-nudge + no-edits-after-nudge heuristic in
 * the ollama agentic loop (server/providers/ollama-agentic.js).
 *
 * 2026-05-04 hardening:
 *   - Counter (incompleteTaskNudgeCount) replaces the emptySummaryRetried
 *     flag-collision guard so the nudge fires reliably even when the empty-
 *     summary retry already burned its single shot.
 *   - Up to MAX_INCOMPLETE_TASK_NUDGES corrective nudges are emitted; after
 *     that the loop exits with stopReason='no_edits_after_nudge' which
 *     execution.js maps to a hard-fail (exit_code=1, status=failed) via
 *     HARD_FAIL_AGENTIC_STOP_REASONS.
 *
 * The loop has too many runtime dependencies to invoke directly here, so
 * the test mirrors the production decision logic in a tight inline helper
 * and verifies each branch. The contract under test:
 *
 *   action = 'nudge' | 'hard_fail' | 'pass_through'
 *
 *   pre: !proposalOutputMode && !hasWriteTools && taskExpectsModification
 *        && toolLog.length > 0
 *
 *   if pre && nudgeCount < MAX_NUDGES        → 'nudge' (count++)
 *   else if pre && nudgeCount >= MAX_NUDGES  → 'hard_fail' (no_edits_after_nudge)
 *   else                                      → 'pass_through' (model_finished)
 */
import { describe, it, expect } from 'vitest';

const MAX_INCOMPLETE_TASK_NUDGES = 2;

function decideNudgeAction({
  toolLog,
  hasWriteTools,
  taskExpectsModification,
  proposalOutputMode,
  incompleteTaskNudgeCount,
}) {
  const pre = !proposalOutputMode
    && !hasWriteTools
    && taskExpectsModification
    && toolLog.length > 0;
  if (pre && incompleteTaskNudgeCount < MAX_INCOMPLETE_TASK_NUDGES) {
    const next = incompleteTaskNudgeCount + 1;
    return {
      action: 'nudge',
      isFinalNudge: next >= MAX_INCOMPLETE_TASK_NUDGES,
      newCount: next,
    };
  }
  if (pre && incompleteTaskNudgeCount >= MAX_INCOMPLETE_TASK_NUDGES) {
    return { action: 'hard_fail', stopReason: 'no_edits_after_nudge' };
  }
  return { action: 'pass_through', stopReason: 'model_finished' };
}

describe('incomplete-task-nudge — first nudge (counter=0)', () => {
  it('nudges when modification task has only read-only tools', () => {
    const r = decideNudgeAction({
      toolLog: [{ name: 'read_file' }, { name: 'read_file' }],
      hasWriteTools: false,
      taskExpectsModification: true,
      proposalOutputMode: false,
      incompleteTaskNudgeCount: 0,
    });
    expect(r.action).toBe('nudge');
    expect(r.isFinalNudge).toBe(false);
    expect(r.newCount).toBe(1);
  });

  it('does not nudge when a write tool was used', () => {
    const r = decideNudgeAction({
      toolLog: [{ name: 'read_file' }, { name: 'write_file' }],
      hasWriteTools: true,
      taskExpectsModification: true,
      proposalOutputMode: false,
      incompleteTaskNudgeCount: 0,
    });
    expect(r.action).toBe('pass_through');
    expect(r.stopReason).toBe('model_finished');
  });

  it('does not nudge when task is a pure inspection (no modification verbs)', () => {
    const r = decideNudgeAction({
      toolLog: [{ name: 'read_file' }],
      hasWriteTools: false,
      taskExpectsModification: false,
      proposalOutputMode: false,
      incompleteTaskNudgeCount: 0,
    });
    expect(r.action).toBe('pass_through');
  });

  it('does not nudge when no tools were called (different code path: empty_toolless)', () => {
    const r = decideNudgeAction({
      toolLog: [],
      hasWriteTools: false,
      taskExpectsModification: true,
      proposalOutputMode: false,
      incompleteTaskNudgeCount: 0,
    });
    expect(r.action).toBe('pass_through');
  });

  it('does not nudge in proposalOutputMode (a different correction prompt fires)', () => {
    const r = decideNudgeAction({
      toolLog: [{ name: 'read_file' }],
      hasWriteTools: false,
      taskExpectsModification: true,
      proposalOutputMode: true,
      incompleteTaskNudgeCount: 0,
    });
    expect(r.action).toBe('pass_through');
  });
});

describe('incomplete-task-nudge — second nudge (counter=1) marks final', () => {
  it('emits a second nudge that is flagged as final', () => {
    const r = decideNudgeAction({
      toolLog: [{ name: 'read_file' }, { name: 'read_file' }, { name: 'read_file' }],
      hasWriteTools: false,
      taskExpectsModification: true,
      proposalOutputMode: false,
      incompleteTaskNudgeCount: 1,
    });
    expect(r.action).toBe('nudge');
    expect(r.isFinalNudge).toBe(true);
    expect(r.newCount).toBe(2);
  });
});

describe('no-edits-after-nudge — hard fail (counter>=MAX)', () => {
  it('exits with no_edits_after_nudge after both nudges were ignored', () => {
    const r = decideNudgeAction({
      toolLog: [{ name: 'read_file' }],
      hasWriteTools: false,
      taskExpectsModification: true,
      proposalOutputMode: false,
      incompleteTaskNudgeCount: 2,
    });
    expect(r.action).toBe('hard_fail');
    expect(r.stopReason).toBe('no_edits_after_nudge');
  });

  it('does not hard-fail if the model finally wrote between nudges (counter still high but writes present)', () => {
    const r = decideNudgeAction({
      toolLog: [{ name: 'read_file' }, { name: 'edit_file' }],
      hasWriteTools: true,
      taskExpectsModification: true,
      proposalOutputMode: false,
      incompleteTaskNudgeCount: 2,
    });
    expect(r.action).toBe('pass_through');
    expect(r.stopReason).toBe('model_finished');
  });
});

describe('flag-decoupling regression — DLPhone task 8347e0a6 (2026-05-04)', () => {
  // Pre-hardening this case fell through to model_finished because the
  // incomplete-task-nudge gate was guarded by !emptySummaryRetried, which
  // could be set by an earlier empty-summary retry without the model
  // actually finishing the work. Now the nudge has its own counter and
  // fires regardless of any earlier flag state.
  it('still nudges even if a prior unrelated retry fired (counter is independent)', () => {
    // Simulating the post-hardening world: there is no `emptySummaryRetried`
    // input to decideNudgeAction at all. The contract is: counter alone
    // gates the nudge.
    const r = decideNudgeAction({
      toolLog: [{ name: 'read_file' }, { name: 'read_file' }],
      hasWriteTools: false,
      taskExpectsModification: true,
      proposalOutputMode: false,
      incompleteTaskNudgeCount: 0,
    });
    expect(r.action).toBe('nudge');
  });
});
