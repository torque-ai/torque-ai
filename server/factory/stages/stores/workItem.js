// Work-item store. Thin facade over server/db/factory/intake.js +
// server/factory/recovery/index.js. Stages consume this instead of
// reaching into factoryIntake directly.
//
// Scope is deliberately the union of operations the current seven stage
// executors call. Add methods here as future stages need them — the
// boundary is what stages need, not the full intake surface.

const factoryIntake = require('../../../db/factory/intake');

/**
 * @returns {import('../types').WorkItemStore}
 */
function createWorkItemStore() {
  return {
    load(id) {
      return factoryIntake.getWorkItem ? factoryIntake.getWorkItem(id) : null;
    },

    update(id, fields) {
      return factoryIntake.updateWorkItem(id, fields);
    },

    listOpen(projectId, { limit = 100 } = {}) {
      return factoryIntake.listOpenWorkItems({ project_id: projectId, limit });
    },

    /**
     * Atomic claim wrapper. The actual `claimNextWorkItemForInstance` lives
     * in loop-controller for now; this method takes a callback so callers
     * can pass the live implementation during the in-place Phase 2c-adapt
     * step. Once `claimNextWorkItemForInstance` extracts (later phase),
     * this method can call the extracted version directly.
     *
     * @param {string|number} projectId
     * @param {string|number} instanceId
     * @param {(projectId: any, instanceId: any) => Promise<{ openItems: any[], workItem: any|null }>} impl
     * @returns {Promise<{ openItems: any[], workItem: any|null }>}
     */
    async claimNext(projectId, instanceId, impl) {
      if (typeof impl !== 'function') {
        throw new Error('workItemStore.claimNext requires the claim implementation as the third argument until Phase 3 extracts it');
      }
      return impl(projectId, instanceId);
    },

    releaseClaim(instanceId) {
      return factoryIntake.releaseClaimForInstance(instanceId);
    },

    /**
     * Routes a work item to needs_replan. Delegates to the recovery cluster
     * function that already encapsulates the routing decision (extracted in
     * Phase 1c). Kept here because conceptually it's a workItem mutation.
     * @param {(workItem: any, opts: object) => any} routeFn
     */
    routeToNeedsReplan(workItem, opts, routeFn) {
      if (typeof routeFn !== 'function') {
        throw new Error('workItemStore.routeToNeedsReplan requires the routing function as the third argument until Phase 3 extracts the routing helper');
      }
      return routeFn(workItem, opts);
    },

    getTerminalEscalationEvidence(workItem) {
      return typeof factoryIntake.getTerminalEscalationEvidence === 'function'
        ? factoryIntake.getTerminalEscalationEvidence(workItem)
        : null;
    },

    getCodexFallbackPolicy({ db, projectId }) {
      const { getCodexFallbackPolicy } = require('../../../db/factory/intake');
      return getCodexFallbackPolicy({ db, projectId });
    },
  };
}

module.exports = { createWorkItemStore };
