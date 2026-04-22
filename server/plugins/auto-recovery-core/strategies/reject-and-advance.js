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
        const isPausedGate = /loop is paused/i.test(String(err?.message || ''));
        const gateStage = typeof decision?.stage === 'string'
          ? decision.stage.trim().toUpperCase()
          : '';
        if (!isPausedGate || !gateStage || typeof services.rejectGate !== 'function') {
          throw err;
        }
        await services.rejectGate({ project_id: project.id, stage: gateStage });
        gateRejected = true;
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
      },
    };
  },
};
