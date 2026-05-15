// resolveStageContext — single source of truth for building a
// StageContext. Stages never construct their own context; the dispatcher
// (and tests) call this with the already-resolved project + instance.
//
// The store-construction dependencies are passed in because the helpers
// they wrap (updateInstanceAndSync, the selected-work-item cache,
// listTasksForFactoryBatch) still live in loop-controller for now. The
// callback shape is the seam that lets Phase 2c-adapt land before any
// of those helpers extract.

const baseLogger = require('../../logger');
const { buildStores } = require('./stores');

/**
 * @param {Object} args
 * @param {import('./types').ProjectRow} args.project
 * @param {import('./types').InstanceRow} args.instance
 * @param {import('./types').WorkItem|null} [args.workItem=null]
 * @param {string|null} [args.batchId=null]
 * @param {string|null} [args.stageName=null]    — for the bound logger; the
 *                                                  dispatcher fills this in
 * @param {Object} args.deps                     — see stages/stores/index.js#buildStores
 * @returns {import('./types').StageContext}
 */
function resolveStageContext({
  project,
  instance,
  workItem = null,
  batchId = null,
  stageName = null,
  deps,
}) {
  if (!project || project.id == null) {
    throw new Error('resolveStageContext: project with id is required');
  }
  if (!instance || instance.id == null) {
    throw new Error('resolveStageContext: instance with id is required');
  }
  if (!deps) {
    throw new Error('resolveStageContext: deps bundle is required (see stages/stores/index.js#buildStores)');
  }

  const stores = buildStores(deps);
  const logger = baseLogger.child
    ? baseLogger.child({
        component: 'factory-stage',
        project_id: project.id,
        instance_id: instance.id,
        stage: stageName || null,
      })
    : baseLogger;

  return {
    project,
    instance,
    workItem,
    batchId: batchId ?? instance.batch_id ?? null,
    ...stores,
    logger,
  };
}

module.exports = { resolveStageContext };
