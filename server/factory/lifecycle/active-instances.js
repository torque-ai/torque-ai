// Active-loop-instance queries. Thin read-only wrappers over the
// factory_loop_instances table, used by lifecycle entry points and stage
// orchestrators to look up the live instance for a project.
//
// Extracted from server/factory/loop-controller.js as the first slice of
// Phase 2b. The deeper lifecycle entry points (getLoopState,
// awaitFactoryLoop, terminateInstanceAndSync, etc.) still live in
// loop-controller pending the lifecycle-spec reflection checkpoint at
// the end of Phase 2.

const factoryLoopInstances = require('../../db/factory/loop-instances');

function getActiveInstances(project_id) {
  return factoryLoopInstances.listInstances({ project_id, active_only: true });
}

function getOldestActiveInstance(project_id) {
  return getActiveInstances(project_id)[0] || null;
}

module.exports = {
  getActiveInstances,
  getOldestActiveInstance,
};
