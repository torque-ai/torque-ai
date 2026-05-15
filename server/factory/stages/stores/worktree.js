// Worktree store. Thin facade over server/db/factory/worktrees.js.
//
// `markMerged` is the only mutator the stages call today (from VERIFY's
// merge path). Lookups (`getActiveByBatch`, `getActiveByProject`) are
// hit from both EXECUTE and VERIFY. Adding new operations is just a
// new method here that delegates to factoryWorktrees.

const factoryWorktrees = require('../../../db/factory/worktrees');

/**
 * @returns {import('../types').WorktreeStore}
 */
function createWorktreeStore() {
  return {
    getActiveByBatch(batchId) {
      if (!batchId) return null;
      return factoryWorktrees.getActiveWorktreeByBatch
        ? factoryWorktrees.getActiveWorktreeByBatch(batchId)
        : null;
    },

    getActiveByProject(projectId) {
      return factoryWorktrees.getActiveWorktree
        ? factoryWorktrees.getActiveWorktree(projectId)
        : null;
    },

    markMerged(record, opts) {
      if (!record || typeof factoryWorktrees.markWorktreeMerged !== 'function') {
        return;
      }
      factoryWorktrees.markWorktreeMerged(record, opts);
    },
  };
}

module.exports = { createWorktreeStore };
