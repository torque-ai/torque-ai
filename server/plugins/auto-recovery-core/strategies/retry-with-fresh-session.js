'use strict';

module.exports = {
  name: 'retry_with_fresh_session',
  applicable_categories: ['sandbox_interrupt', 'provider_overload'],
  max_attempts_per_project: 2,

  async run({ project, decision, services }) {
    const stuckTaskId = decision?.outcome?.generation_task_id
                      || decision?.outcome?.task_id
                      || null;
    if (stuckTaskId && typeof services.cancelTask === 'function') {
      await services.cancelTask({ task_id: stuckTaskId, reason: 'auto_recovery_fresh_session' });
    }
    if (decision?.stage === 'plan' && typeof services.retryPlanGeneration === 'function') {
      const workItemId = decision?.outcome?.work_item_id || null;
      await services.retryPlanGeneration({ project_id: project.id, work_item_id: workItemId });
    } else if (typeof services.retryFactoryVerify === 'function') {
      await services.retryFactoryVerify({ project_id: project.id });
    }
    return {
      success: true, next_action: 'retry',
      outcome: { strategy: 'retry_with_fresh_session', cancelled_task_id: stuckTaskId },
    };
  },
};
