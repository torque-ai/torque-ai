'use strict';

module.exports = {
  name: 'retry',
  applicable_categories: ['transient', 'unknown', 'infrastructure', 'any'],
  max_attempts_per_project: 3,

  async run({ project, decision, services }) {
    if (typeof services.retryFactoryVerify !== 'function') {
      throw new Error('retry strategy requires services.retryFactoryVerify');
    }
    await services.retryFactoryVerify({ project_id: project.id });
    return {
      success: true, next_action: 'retry',
      outcome: { strategy: 'retry', batch_id: decision?.batch_id || null },
    };
  },
};
