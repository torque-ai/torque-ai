'use strict';

module.exports = {
  name: 'reject_and_advance',
  applicable_categories: ['transient', 'structural_failure'],
  max_attempts_per_project: 1,

  async run({ project, decision, services }) {
    const workItemId = decision?.outcome?.work_item_id
                     || decision?.inputs_json?.work_item_id
                     || null;
    let rejected = false;
    let advanced = false;
    let gateRejected = false;
    let loopStarted = false;
    if (typeof services.rejectWorkItem === 'function' && workItemId) {
      await services.rejectWorkItem({
        project_id: project.id, work_item_id: workItemId,
        reason: 'auto_recovery_reject_and_advance',
      });
      rejected = true;
    }
    if (typeof services.advanceLoop === 'function') {
      try {
        await services.advanceLoop({ project_id: project.id });
        advanced = true;
      } catch (err) {
        const message = String(err?.message || '');
        const isPausedGate = /loop is paused/i.test(message);
        const isIdleLoop = /loop not started/i.test(message);
        const gateStage = typeof decision?.stage === 'string'
          ? decision.stage.trim().toUpperCase()
          : '';
        if (isPausedGate && gateStage && typeof services.rejectGate === 'function') {
          await services.rejectGate({ project_id: project.id, stage: gateStage });
          gateRejected = true;
        } else if (isIdleLoop && typeof services.startLoop === 'function') {
          await services.startLoop({ project_id: project.id, auto_advance: true });
          loopStarted = true;
        } else {
          throw err;
        }
      }
    } else if (typeof services.rejectGate === 'function' && decision?.action === 'paused_at_gate') {
      const gateStage = typeof decision?.stage === 'string'
        ? decision.stage.trim().toUpperCase()
        : '';
      if (gateStage) {
        await services.rejectGate({ project_id: project.id, stage: gateStage });
        gateRejected = true;
      }
    }
    return {
      success: true, next_action: 'advance',
      outcome: {
        strategy: 'reject_and_advance',
        work_item_id: workItemId,
        rejected,
        advanced,
        gate_rejected: gateRejected,
        loop_started: loopStarted,
      },
    };
  },
};
