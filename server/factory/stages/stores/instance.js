// Instance store. Thin facade over server/db/factory/loop-instances.js
// plus the selected-work-item cache that lives in loop-controller today.
//
// The selected-work-item cache (`rememberSelectedWorkItem` /
// `clearSelectedWorkItem` / `getSelectedWorkItem`) is currently a
// module-private map in loop-controller. The store takes a callback
// during Phase 2c-adapt; once the cache extracts to its own module
// (a later phase), the callback wiring goes away.

const factoryLoopInstances = require('../../../db/factory/loop-instances');
const {
  getActiveInstances,
  getOldestActiveInstance,
} = require('../../lifecycle/active-instances');

/**
 * @param {Object} deps
 * @param {(id: any, fields: object) => any} deps.updateInstanceAndSync
 *   The current loop-controller helper. Replaces direct DB writes plus
 *   the legacy-project sync side effects.
 * @param {(instanceId: any, workItem: any|null) => void} deps.rememberSelectedWorkItem
 * @param {(instanceId: any) => void} deps.clearSelectedWorkItem
 * @param {(instance: any, projectId: any, opts: object) => any|null} deps.getSelectedWorkItem
 *
 * @returns {import('../types').InstanceStore}
 */
function createInstanceStore({
  updateInstanceAndSync,
  rememberSelectedWorkItem,
  clearSelectedWorkItem,
  getSelectedWorkItem,
}) {
  if (typeof updateInstanceAndSync !== 'function'
    || typeof rememberSelectedWorkItem !== 'function'
    || typeof clearSelectedWorkItem !== 'function'
    || typeof getSelectedWorkItem !== 'function') {
    throw new Error('createInstanceStore requires updateInstanceAndSync, rememberSelectedWorkItem, clearSelectedWorkItem, and getSelectedWorkItem deps');
  }

  return {
    load(id) {
      return factoryLoopInstances.getInstance
        ? factoryLoopInstances.getInstance(id)
        : null;
    },

    updateAndSync(id, fields) {
      return updateInstanceAndSync(id, fields);
    },

    rememberSelectedWorkItem(instanceId, workItem) {
      rememberSelectedWorkItem(instanceId, workItem);
    },

    clearSelectedWorkItem(instanceId) {
      clearSelectedWorkItem(instanceId);
    },

    getSelectedWorkItem(instance, projectId, opts = {}) {
      return getSelectedWorkItem(instance, projectId, opts);
    },

    listActive(projectId) {
      return getActiveInstances(projectId);
    },

    getOldestActive(projectId) {
      return getOldestActiveInstance(projectId);
    },
  };
}

module.exports = { createInstanceStore };
