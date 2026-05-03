'use strict';

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`Missing SENSE stage dependency: ${name}`);
  }
}

function createSenseStage({
  LOOP_STATES,
  createPlanFileIntake,
  createShippedDetector,
  database,
  factoryHealth,
  factoryIntake,
  getDecisionBatchId,
  getNextState,
  getPendingGateStage,
  getProjectOrThrow,
  logger,
  resolvePlansRepoRoot,
  safeLogDecision,
  tryMoveInstanceToStage,
} = {}) {
  assertFunction(createPlanFileIntake, 'createPlanFileIntake');
  assertFunction(createShippedDetector, 'createShippedDetector');
  assertFunction(factoryHealth?.getProjectHealthSummary, 'factoryHealth.getProjectHealthSummary');
  assertFunction(getDecisionBatchId, 'getDecisionBatchId');
  assertFunction(getNextState, 'getNextState');
  assertFunction(getPendingGateStage, 'getPendingGateStage');
  assertFunction(getProjectOrThrow, 'getProjectOrThrow');
  assertFunction(resolvePlansRepoRoot, 'resolvePlansRepoRoot');
  assertFunction(safeLogDecision, 'safeLogDecision');
  assertFunction(tryMoveInstanceToStage, 'tryMoveInstanceToStage');

  function executeSenseStage(project_id, instance = null) {
    const project = getProjectOrThrow(project_id);
    const summary = factoryHealth.getProjectHealthSummary(project_id);
    const scanSummary = {
      plans_dir: project.config?.plans_dir || null,
      scanned: 0,
      created_count: 0,
      shipped_count: 0,
      skipped_count: 0,
    };

    if (project.config && project.config.plans_dir) {
      const db = database.getDbInstance();
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
        logger.info(
          `SENSE: scanned ${result.scanned} plan files - ${result.created.length} new, ${result.shipped_count} shipped, ${result.skipped.length} skipped`,
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
  }

  function handleSenseTransition({ project, instance, currentState }) {
    const pendingGate = getPendingGateStage(currentState, project.trust_level);
    const targetStage = pendingGate || getNextState(currentState, project.trust_level, 'approved');
    const moved = tryMoveInstanceToStage(instance, targetStage, {
      paused_at_stage: pendingGate === targetStage ? targetStage : null,
    });
    return {
      instance: moved.instance,
      stageResult: null,
      transitionReason: moved.blocked ? 'stage_occupied' : 'sense_completed',
      transitionWorkItem: null,
    };
  }

  return {
    executeSenseStage,
    handleSenseTransition,
  };
}

module.exports = {
  createSenseStage,
};
