// SENSE stage executor — Phase 3 (executor body lifted out of loop-controller).
//
// `executeSenseStage` scans the project's configured plans directory for
// new plan files (intake), records a `scanned_plans` decision, and returns
// the project-health summary. The body moved verbatim from
// loop-controller.js; loop-controller keeps a one-line wiring:
//   const executeSenseStage = createSenseStage({ ...injected deps });
//
// Leaf modules are required directly. loop-controller-internal helpers
// (getProjectOrThrow, getDatabaseHandle, safeLogDecision,
// getDecisionBatchId) are injected — they have not been extracted from
// loop-controller, so passing them keeps this module free of a require
// cycle back into loop-controller.js.

const factoryHealth = require('../../db/factory/health');
const factoryIntake = require('../../db/factory/intake');
const { createPlanFileIntake } = require('../plan-file-intake');
const { createShippedDetector } = require('../shipped-detector');
const { resolvePlansRepoRoot } = require('../shared/plan-path');
const { LOOP_STATES } = require('../loop-states');
const logger = require('../../logger').child({ component: 'factory-sense-stage' });

const REQUIRED_DEPS = [
  'getProjectOrThrow',
  'getDatabaseHandle',
  'safeLogDecision',
  'getDecisionBatchId',
];

/**
 * @param {{
 *   getProjectOrThrow: (projectId: number|string) => object,
 *   getDatabaseHandle: () => object|null,
 *   safeLogDecision: (entry: object) => any,
 *   getDecisionBatchId: (project: object, workItem: object|null, batch: object|null, instance: object|null) => string|null,
 * }} deps
 * @returns {(projectId: number|string, instance?: object|null) => object}
 */
function createSenseStage(deps = {}) {
  for (const name of REQUIRED_DEPS) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`createSenseStage: dep '${name}' is required`);
    }
  }
  const {
    getProjectOrThrow,
    getDatabaseHandle,
    safeLogDecision,
    getDecisionBatchId,
  } = deps;

  return function executeSenseStage(project_id, instance = null) {
    const project = getProjectOrThrow(project_id);
    const summary = factoryHealth.getProjectHealthSummary(project_id);
    const scanSummary = {
      plans_dir: project.config?.plans_dir || null,
      scanned: 0,
      created_count: 0,
      shipped_count: 0,
      skipped_count: 0,
      reconciled_count: 0,
    };

    if (project.config && project.config.plans_dir) {
      const db = getDatabaseHandle();
      if (!db || typeof db.prepare !== 'function') {
        logger.warn('SENSE: skipped plan-file intake because database is unavailable', {
          project_id,
          plans_dir: project.config.plans_dir,
        });
      } else {
        const shippedDetector = createShippedDetector({
          repoRoot: resolvePlansRepoRoot(project.path, project.config.plans_dir),
        });
        const planIntake = createPlanFileIntake({ db, factoryIntake, shippedDetector });
        const result = planIntake.scan({
          project_id: project.id,
          plans_dir: project.config.plans_dir,
        });
        scanSummary.scanned = result.scanned;
        scanSummary.created_count = result.created.length;
        scanSummary.shipped_count = result.shipped_count;
        scanSummary.skipped_count = result.skipped.length;
        scanSummary.reconciled_count = Array.isArray(result.reconciled) ? result.reconciled.length : 0;
        logger.info(
          `SENSE: scanned ${result.scanned} plan files - ${result.created.length} new, ${result.shipped_count} shipped, ${result.skipped.length} skipped, ${scanSummary.reconciled_count} reconciled`,
          { project_id }
        );
      }
    }

    safeLogDecision({
      project_id,
      stage: LOOP_STATES.SENSE,
      action: 'scanned_plans',
      reasoning: scanSummary.plans_dir
        ? 'SENSE stage scanned the configured plans directory.'
        : 'SENSE stage completed without a configured plans directory.',
      inputs: {
        plans_dir: scanSummary.plans_dir,
      },
      outcome: {
        ...scanSummary,
        balance: summary?.balance ?? null,
        dimension_count: summary?.dimension_count ?? 0,
        weakest_dimension: summary?.weakest_dimension || null,
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, null, null, instance),
    });

    logger.info('SENSE stage executed', { project_id });
    return summary;
  };
}

module.exports = { createSenseStage };
