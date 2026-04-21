'use strict';

module.exports = {
  name: 'fresh_worktree',
  applicable_categories: ['infrastructure'],
  max_attempts_per_project: 1,

  async run({ project, decision, services }) {
    if (typeof services.recreateWorktree !== 'function') {
      throw new Error('fresh_worktree requires services.recreateWorktree');
    }
    const branch = decision?.outcome?.branch || null;
    const batchId = decision?.batch_id || null;
    const recreated = await services.recreateWorktree({
      project_id: project.id, batch_id: batchId, branch,
    });
    if (typeof services.retryFactoryVerify === 'function') {
      await services.retryFactoryVerify({ project_id: project.id });
    }
    return {
      success: true, next_action: 'retry',
      outcome: { strategy: 'fresh_worktree', new_worktree_path: recreated?.worktree_path || null },
    };
  },
};
