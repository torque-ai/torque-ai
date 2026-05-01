'use strict';

const VERIFY_PAUSE_STAGES = new Set(['VERIFY', 'VERIFY_FAIL']);

function readPausedStage(project, decision) {
  const fromProject = (project?.loop_paused_at_stage || '').toString().trim().toUpperCase();
  if (fromProject) return fromProject;
  const fromDecisionOutcome = (decision?.outcome?.paused_at_stage || '').toString().trim().toUpperCase();
  if (fromDecisionOutcome) return fromDecisionOutcome;
  const fromDecisionStage = (decision?.stage || '').toString().trim().toUpperCase();
  return fromDecisionStage || null;
}

module.exports = {
  name: 'retry',
  applicable_categories: ['transient', 'unknown', 'infrastructure', 'any'],
  max_attempts_per_project: 3,

  async run({ project, decision, services }) {
    const pausedStage = readPausedStage(project, decision);
    const isVerify = pausedStage && VERIFY_PAUSE_STAGES.has(pausedStage);

    if (isVerify) {
      if (typeof services.retryFactoryVerify !== 'function') {
        throw new Error('retry strategy requires services.retryFactoryVerify for verify-stage retry');
      }
      await services.retryFactoryVerify({ project_id: project.id });
      return {
        success: true,
        next_action: 'retry',
        outcome: { strategy: 'retry', mode: 'verify', paused_stage: pausedStage, batch_id: decision?.batch_id || null },
      };
    }

    // READY_FOR_X is a paused-but-staged-to-advance state, not a paused-AT-X
    // gate. approveGate's assertValidGateStage rejects any READY_FOR_* value
    // ("Invalid gate stage: READY_FOR_PLAN") because READY_FOR_PLAN is not a
    // member of LOOP_STATES — it's the prefix form returned by getReadyStage.
    // The right operation here is advanceLoop, which transitions the loop out
    // of the ready-state into the named target stage. Without this branch the
    // retry path threw on every READY_FOR_* recovery and forced escalation
    // (seen on DLPhone item #2163: rewriteWorkItem returned non-string from a
    // stalled Codex call → retry → "Invalid gate stage: READY_FOR_PLAN" →
    // escalate → project paused).
    const isReadyForStage = pausedStage && pausedStage.startsWith('READY_FOR_');

    if (pausedStage && !isReadyForStage && typeof services.approveGate === 'function') {
      // Non-verify pause (EXECUTE, PLAN, SENSE, etc.): clearing the pause via
      // approveGate lets the loop tick re-enter the same stage on its own.
      // Without this branch retry would call retryFactoryVerify and throw
      // "Loop is not in VERIFY", dead-ending recovery on every non-verify
      // exception (seen on DLPhone item #708 after a smart_submit_task
      // workflow auto-decompose was mis-classified as execute_exception).
      await services.approveGate({ project_id: project.id, stage: pausedStage });
      return {
        success: true,
        next_action: 'retry',
        outcome: { strategy: 'retry', mode: 'approve_gate', paused_stage: pausedStage, batch_id: decision?.batch_id || null },
      };
    }

    // advanceLoop branch covers two cases:
    //   1. Loop not paused at all (transient classification on running loop)
    //   2. Loop paused at READY_FOR_X — the loop is staged to advance, kicking
    //      advanceLoop transitions it out of the ready state into stage X.
    if (typeof services.advanceLoop === 'function') {
      await services.advanceLoop({ project_id: project.id });
      return {
        success: true,
        next_action: 'retry',
        outcome: {
          strategy: 'retry',
          mode: isReadyForStage ? 'advance_loop_from_ready' : 'advance_loop',
          paused_stage: pausedStage || null,
          batch_id: decision?.batch_id || null,
        },
      };
    }

    throw new Error(
      `retry strategy has no actionable service for paused_stage=${pausedStage || 'unknown'} `
      + '(needs retryFactoryVerify, approveGate, or advanceLoop)'
    );
  },
};
