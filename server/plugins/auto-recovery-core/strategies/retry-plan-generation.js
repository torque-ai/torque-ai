'use strict';

module.exports = {
  name: 'retry_plan_generation',
  applicable_categories: ['plan_failure', 'never_started'],
  max_attempts_per_project: 3,

  async run({ project, decision, services }) {
    if (typeof services.retryPlanGeneration !== 'function') {
      throw new Error('retry_plan_generation requires services.retryPlanGeneration');
    }
    const workItemId = decision?.outcome?.work_item_id
                     || decision?.inputs?.work_item_id
                     || null;
    await services.retryPlanGeneration({ project_id: project.id, work_item_id: workItemId });
    return {
      success: true, next_action: 'retry',
      outcome: { strategy: 'retry_plan_generation', work_item_id: workItemId },
    };
  },
};
