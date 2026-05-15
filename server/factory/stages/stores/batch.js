// Batch store. Thin facade over factoryIntake batch helpers + the
// loop-controller-local `listTasksForFactoryBatch` helper (which itself
// wraps `db/task-core.listTasks` with a factory:batch_id tag filter).
//
// `getOrCreate` deferred: the current code path threads batch_id through
// the EXECUTE stages and constructs it inline. When EXECUTE extracts in
// Phase 3, that construction will move here. For Phase 2c-scaffold the
// store only exposes the lookups stages currently perform.

/**
 * @param {Object} deps
 * @param {(batchId: string) => Array<{ id: string, status: string, tags?: string[] }>} deps.listTasksForFactoryBatch
 *   The current loop-controller helper. The store wraps it instead of
 *   re-implementing task lookup, so a future change to the batch-task
 *   shape (e.g. richer status filtering) updates one site.
 *
 * @returns {import('../types').BatchStore}
 */
function createBatchStore({ listTasksForFactoryBatch }) {
  if (typeof listTasksForFactoryBatch !== 'function') {
    throw new Error('createBatchStore requires listTasksForFactoryBatch dep');
  }

  return {
    getOrCreate(_projectId, _workItemId) {
      throw new Error('batchStore.getOrCreate is not yet implemented — batch creation still happens inside EXECUTE; will move here in Phase 3 stage extraction');
    },

    listTasks(batchId) {
      return listTasksForFactoryBatch(batchId) || [];
    },
  };
}

module.exports = { createBatchStore };
