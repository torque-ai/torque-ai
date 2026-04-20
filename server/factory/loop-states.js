'use strict';

const LOOP_STATES = Object.freeze({
  SENSE: 'SENSE',
  PRIORITIZE: 'PRIORITIZE',
  PLAN: 'PLAN',
  PLAN_REVIEW: 'PLAN_REVIEW',
  EXECUTE: 'EXECUTE',
  VERIFY: 'VERIFY',
  LEARN: 'LEARN',
  IDLE: 'IDLE',
  PAUSED: 'PAUSED',
  STARVED: 'STARVED',
});

const TRANSITIONS = Object.freeze({
  [LOOP_STATES.SENSE]: LOOP_STATES.PRIORITIZE,
  [LOOP_STATES.PRIORITIZE]: LOOP_STATES.PLAN,
  [LOOP_STATES.PLAN]: LOOP_STATES.EXECUTE,
  [LOOP_STATES.EXECUTE]: LOOP_STATES.VERIFY,
  [LOOP_STATES.VERIFY]: LOOP_STATES.LEARN,
  [LOOP_STATES.LEARN]: LOOP_STATES.IDLE,
});

const APPROVAL_GATES = Object.freeze({
  supervised: Object.freeze([
    LOOP_STATES.PRIORITIZE,
    LOOP_STATES.PLAN,
    LOOP_STATES.VERIFY,
    LOOP_STATES.LEARN,
  ]),
  guided: Object.freeze([
    LOOP_STATES.PLAN,
    LOOP_STATES.LEARN,
  ]),
  autonomous: Object.freeze([
    LOOP_STATES.LEARN,
  ]),
  dark: Object.freeze([]),
});

const EXIT_GATED_STATES = Object.freeze({
  supervised: Object.freeze([LOOP_STATES.VERIFY]),
  guided: Object.freeze([]),
  autonomous: Object.freeze([]),
  dark: Object.freeze([]),
});

const VALID_STATES = new Set(Object.values(LOOP_STATES));
const VALID_APPROVAL_STATUSES = new Set(['approved', 'pending', 'rejected']);

function isValidState(state) {
  return VALID_STATES.has(state);
}

function isValidTrustLevel(trustLevel) {
  return Object.prototype.hasOwnProperty.call(APPROVAL_GATES, trustLevel);
}

function isValidApprovalStatus(approvalStatus) {
  return approvalStatus === null || VALID_APPROVAL_STATUSES.has(approvalStatus);
}

function assertValidState(state) {
  if (!isValidState(state)) {
    throw new TypeError(`Invalid loop state: ${String(state)}`);
  }
}

function assertValidTrustLevel(trustLevel) {
  if (!isValidTrustLevel(trustLevel)) {
    throw new TypeError(`Invalid trust level: ${String(trustLevel)}`);
  }
}

function assertValidApprovalStatus(approvalStatus) {
  if (!isValidApprovalStatus(approvalStatus)) {
    throw new TypeError(`Invalid approval status: ${String(approvalStatus)}`);
  }
}

function getGatesForTrustLevel(trustLevel) {
  assertValidTrustLevel(trustLevel);
  return APPROVAL_GATES[trustLevel].slice();
}

function isExitGatedStage(stage, trustLevel) {
  assertValidState(stage);
  assertValidTrustLevel(trustLevel);
  return EXIT_GATED_STATES[trustLevel].includes(stage);
}

function getPendingGateStage(currentState, trustLevel) {
  assertValidState(currentState);
  assertValidTrustLevel(trustLevel);

  if (currentState === LOOP_STATES.IDLE || currentState === LOOP_STATES.PAUSED) {
    return null;
  }

  if (isExitGatedStage(currentState, trustLevel)) {
    return currentState;
  }

  const nextState = TRANSITIONS[currentState];
  if (!nextState) {
    return null;
  }

  const gatedStates = APPROVAL_GATES[trustLevel];
  if (gatedStates.includes(nextState) && !isExitGatedStage(nextState, trustLevel)) {
    return nextState;
  }

  return null;
}

function getResumeStateForApprovedGate(stage, trustLevel) {
  assertValidState(stage);
  assertValidTrustLevel(trustLevel);
  if (stage === LOOP_STATES.PLAN_REVIEW) {
    return LOOP_STATES.EXECUTE;
  }
  return isExitGatedStage(stage, trustLevel)
    ? (TRANSITIONS[stage] || stage)
    : stage;
}

function getNextState(currentState, trustLevel, approvalStatus) {
  assertValidState(currentState);
  assertValidTrustLevel(trustLevel);
  assertValidApprovalStatus(approvalStatus);

  if (currentState === LOOP_STATES.STARVED) {
    return LOOP_STATES.STARVED;
  }

  if (currentState === LOOP_STATES.IDLE || currentState === LOOP_STATES.PAUSED) {
    return currentState;
  }

  if (approvalStatus === 'rejected') {
    return LOOP_STATES.IDLE;
  }

  const pendingGateStage = getPendingGateStage(currentState, trustLevel);
  if (pendingGateStage && approvalStatus !== 'approved') {
    return LOOP_STATES.PAUSED;
  }

  return TRANSITIONS[currentState];
}

module.exports = {
  LOOP_STATES,
  TRANSITIONS,
  APPROVAL_GATES,
  EXIT_GATED_STATES,
  getNextState,
  getPendingGateStage,
  getResumeStateForApprovedGate,
  isExitGatedStage,
  isValidState,
  getGatesForTrustLevel,
};
