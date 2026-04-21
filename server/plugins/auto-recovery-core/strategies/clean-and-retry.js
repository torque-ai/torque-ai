'use strict';

module.exports = {
  name: 'clean_and_retry',
  applicable_categories: ['transient', 'infrastructure'],
  max_attempts_per_project: 2,

  async run({ project, decision, services }) {
    if (typeof services.cleanupWorktreeBuildArtifacts !== 'function') {
      throw new Error('clean_and_retry requires services.cleanupWorktreeBuildArtifacts');
    }
    if (typeof services.retryFactoryVerify !== 'function') {
      throw new Error('clean_and_retry requires services.retryFactoryVerify');
    }
    const cleanup = await services.cleanupWorktreeBuildArtifacts(project, decision?.batch_id);
    await services.retryFactoryVerify({ project_id: project.id });
    return {
      success: true, next_action: 'retry',
      outcome: { strategy: 'clean_and_retry', cleanup, batch_id: decision?.batch_id || null },
    };
  },
};
