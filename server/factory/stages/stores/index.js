// Aggregate factory + re-exports. Lets callers build the full set of
// stores with a single call:
//
//   const { buildStores } = require('./stages/stores');
//   const stores = buildStores({ updateInstanceAndSync, ... });
//
// The dispatcher uses this from `stages/context.js`.

const { createWorkItemStore } = require('./workItem');
const { createInstanceStore } = require('./instance');
const { createDecisionStore } = require('./decision');
const { createBatchStore } = require('./batch');
const { createWorktreeStore } = require('./worktree');

/**
 * @param {Object} deps  — see each store's `create…` for required fields.
 * @returns {{
 *   workItemStore: import('../types').WorkItemStore,
 *   instanceStore: import('../types').InstanceStore,
 *   decisionStore: import('../types').DecisionStore,
 *   batchStore:    import('../types').BatchStore,
 *   worktreeStore: import('../types').WorktreeStore,
 * }}
 */
function buildStores(deps) {
  return {
    workItemStore: createWorkItemStore(),
    instanceStore: createInstanceStore({
      updateInstanceAndSync: deps.updateInstanceAndSync,
      rememberSelectedWorkItem: deps.rememberSelectedWorkItem,
      clearSelectedWorkItem: deps.clearSelectedWorkItem,
      getSelectedWorkItem: deps.getSelectedWorkItem,
    }),
    decisionStore: createDecisionStore(),
    batchStore: createBatchStore({
      listTasksForFactoryBatch: deps.listTasksForFactoryBatch,
    }),
    worktreeStore: createWorktreeStore(),
  };
}

module.exports = {
  buildStores,
  createWorkItemStore,
  createInstanceStore,
  createDecisionStore,
  createBatchStore,
  createWorktreeStore,
};
