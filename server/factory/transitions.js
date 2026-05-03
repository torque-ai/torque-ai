'use strict';

const { LOOP_STATES: DEFAULT_LOOP_STATES, getNextState } = require('./loop-states');

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`Missing transition dependency: ${name}`);
  }
}

function createTryMoveInstanceToStage({
  moveInstanceToStage,
  parkInstanceForStage,
  StageOccupiedError,
} = {}) {
  assertFunction(moveInstanceToStage, 'moveInstanceToStage');
  assertFunction(parkInstanceForStage, 'parkInstanceForStage');
  assertFunction(StageOccupiedError, 'StageOccupiedError');

  return function tryMoveInstanceToStage(instance, stage, updates = {}) {
    try {
      return {
        instance: moveInstanceToStage(instance, stage, updates),
        blocked: false,
      };
    } catch (error) {
      if (error instanceof StageOccupiedError) {
        return {
          instance: parkInstanceForStage(instance, stage),
          blocked: true,
          error,
        };
      }
      throw error;
    }
  };
}

function normalizeDecisionDependencies({
  LOOP_STATES,
  loopStates,
  safeLogDecision,
  getDecisionBatchId,
  getWorkItemDecisionContext,
} = {}) {
  assertFunction(safeLogDecision, 'safeLogDecision');
  assertFunction(getDecisionBatchId, 'getDecisionBatchId');
  assertFunction(getWorkItemDecisionContext, 'getWorkItemDecisionContext');

  return {
    LOOP_STATES: loopStates || LOOP_STATES || DEFAULT_LOOP_STATES,
    safeLogDecision,
    getDecisionBatchId,
    getWorkItemDecisionContext,
  };
}

function logTransitionDecision({
  project,
  currentState,
  nextState,
  pausedAtStage,
  reason,
  workItem,
  batchId,
}, dependencies = {}) {
  const {
    LOOP_STATES,
    safeLogDecision,
    getDecisionBatchId,
    getWorkItemDecisionContext,
  } = normalizeDecisionDependencies(dependencies);
  const effectiveBatchId = getDecisionBatchId(project, workItem, batchId);

  if (nextState === LOOP_STATES.PAUSED) {
    safeLogDecision({
      project_id: project.id,
      stage: pausedAtStage,
      actor: 'human',
      action: 'paused_at_gate',
      reasoning: `Loop paused awaiting approval for ${pausedAtStage}.`,
      inputs: {
        previous_state: currentState,
        trust_level: project.trust_level,
      },
      outcome: {
        from_state: currentState,
        to_state: nextState,
        gate_stage: pausedAtStage || null,
        reason: reason || null,
        ...getWorkItemDecisionContext(workItem),
      },
      confidence: 1,
      batch_id: effectiveBatchId,
    });
    return;
  }

  if (nextState === LOOP_STATES.EXECUTE && currentState !== LOOP_STATES.EXECUTE) {
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'started_execution',
      reasoning: `Loop advanced into ${LOOP_STATES.EXECUTE}.`,
      inputs: {
        previous_state: currentState,
        trust_level: project.trust_level,
      },
      outcome: {
        from_state: currentState,
        to_state: nextState,
        reason: reason || null,
        batch_id: effectiveBatchId,
        ...getWorkItemDecisionContext(workItem),
      },
      confidence: 1,
      batch_id: effectiveBatchId,
    });
    return;
  }

  if (nextState === LOOP_STATES.VERIFY && currentState === LOOP_STATES.EXECUTE) {
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.VERIFY,
      action: 'entered_from_execute',
      reasoning: `Loop advanced from ${currentState} to ${nextState}.`,
      inputs: {
        previous_state: currentState,
        trust_level: project.trust_level,
      },
      outcome: {
        from_state: currentState,
        to_state: nextState,
        paused_at_stage: pausedAtStage || null,
        reason: reason || null,
        batch_id: effectiveBatchId,
        ...getWorkItemDecisionContext(workItem),
      },
      confidence: 1,
      batch_id: effectiveBatchId,
    });
    return;
  }

  safeLogDecision({
    project_id: project.id,
    stage: currentState,
    action: `advance_from_${String(currentState).toLowerCase()}`,
    reasoning: `Loop advanced from ${currentState} to ${nextState}.`,
    inputs: {
      previous_state: currentState,
      trust_level: project.trust_level,
    },
    outcome: {
      from_state: currentState,
      to_state: nextState,
      paused_at_stage: pausedAtStage || null,
      reason: reason || null,
      batch_id: effectiveBatchId,
      ...getWorkItemDecisionContext(workItem),
    },
    confidence: 1,
    batch_id: effectiveBatchId,
  });
}

function createTransitionDecisionLogger(dependencies = {}) {
  const boundDependencies = normalizeDecisionDependencies(dependencies);
  return function boundLogTransitionDecision(args) {
    return logTransitionDecision(args, boundDependencies);
  };
}

function createTransitionHelpers(dependencies = {}) {
  return {
    tryMoveInstanceToStage: createTryMoveInstanceToStage(dependencies),
    logTransitionDecision: createTransitionDecisionLogger(dependencies),
  };
}

function createLoopStageDispatcher({ LOOP_STATES, loopStates, handlers = {} } = {}) {
  const states = loopStates || LOOP_STATES || DEFAULT_LOOP_STATES;
  const {
    handleSenseTransition,
    handlePrioritizeTransition,
    handlePlanTransition,
    handleExecuteTransition,
    handleVerifyTransition,
    handleLearnTransition,
  } = handlers;

  assertFunction(handleSenseTransition, 'handleSenseTransition');
  assertFunction(handlePrioritizeTransition, 'handlePrioritizeTransition');
  assertFunction(handlePlanTransition, 'handlePlanTransition');
  assertFunction(handleExecuteTransition, 'handleExecuteTransition');
  assertFunction(handleVerifyTransition, 'handleVerifyTransition');
  assertFunction(handleLearnTransition, 'handleLearnTransition');

  return async function dispatchAdvanceLoopStage(context) {
    switch (context.currentState) {
      case states.SENSE:
        return handleSenseTransition(context);
      case states.PRIORITIZE:
        return handlePrioritizeTransition(context);
      case states.PLAN:
        return handlePlanTransition(context);
      case states.EXECUTE:
        return handleExecuteTransition(context);
      case states.VERIFY:
        return handleVerifyTransition(context);
      case states.LEARN:
        return handleLearnTransition(context);
      default:
        throw new Error(`Unsupported loop state: ${context.currentState}`);
    }
  };
}

module.exports = {
  createLoopStageDispatcher,
  createTransitionDecisionLogger,
  createTransitionHelpers,
  createTryMoveInstanceToStage,
  getNextState,
  logTransitionDecision,
};
