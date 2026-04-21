'use strict';

module.exports = {
  name: 'reject_and_advance',
  applicable_categories: ['transient', 'structural_failure'],
  max_attempts_per_project: 1,

  async run({ project, decision, services }) {
    const workItemId = decision?.outcome?.work_item_id
                     || decision?.inputs_json?.work_item_id
                     || null;
    if (typeof services.rejectWorkItem === 'function' && workItemId) {
      await services.rejectWorkItem({
        project_id: project.id, work_item_id: workItemId,
        reason: 'auto_recovery_reject_and_advance',
      });
    }
    if (typeof services.advanceLoop === 'function') {
      await services.advanceLoop({ project_id: project.id });
    }
    return {
      success: true, next_action: 'advance',
      outcome: { strategy: 'reject_and_advance', work_item_id: workItemId },
    };
  },
};
