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

    // Non-verify pause (EXECUTE, PLAN, SENSE, etc.): clearing the pause via
    // approveGate lets the loop tick re-enter the same stage on its own. Without
    // this branch retry would call retryFactoryVerify and throw "Loop is not in
    // VERIFY", dead-ending recovery on every non-verify exception (seen on
    // DLPhone item #708 after a smart_submit_task workflow auto-decompose was
    // mis-classified as execute_exception).
    if (pausedStage && typeof services.approveGate === 'function') {
      await services.approveGate({ project_id: project.id, stage: pausedStage });
      return {
        success: true,
        next_action: 'retry',
        outcome: { strategy: 'retry', mode: 'approve_gate', paused_stage: pausedStage, batch_id: decision?.batch_id || null },
      };
    }

    // Last resort: try advanceLoop directly. This is for cases where the loop
    // is not paused (e.g. transient classification on a running loop) — kicking
    // advance is the closest safe analog to "retry".
    if (typeof services.advanceLoop === 'function') {
      await services.advanceLoop({ project_id: project.id });
      return {
        success: true,
        next_action: 'retry',
        outcome: { strategy: 'retry', mode: 'advance_loop', paused_stage: pausedStage || null, batch_id: decision?.batch_id || null },
      };
    }

    throw new Error(
      `retry strategy has no actionable service for paused_stage=${pausedStage || 'unknown'} `
      + '(needs retryFactoryVerify, approveGate, or advanceLoop)'
    );
  },
};
