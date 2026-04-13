'use strict';

const fs = require('fs');
const path = require('path');

const { getNextState } = require('../factory/loop-states');

function loadFixture() {
  const fixturePath = path.join(__dirname, 'fixtures', 'factory-plan1-decision-log.json');
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function findDecision(decisions, predicate) {
  return decisions.find((entry) => {
    try {
      return predicate(entry);
    } catch {
      return false;
    }
  });
}

describe('factory bring-up regression — Plan 1 transitions', () => {
  it('SENSE -> PRIORITIZE gated under supervised until approved', () => {
    const fixture = loadFixture();
    const decision = findDecision(fixture.decision_log || [], (entry) => (
      entry.stage === 'sense'
        && entry.action === 'transition_approved'
        && entry.outcome
        && entry.outcome.from_state === 'SENSE'
        && entry.outcome.to_state === 'PRIORITIZE'
        && entry.outcome.approval === 'approved'
    ));

    expect(decision).toBeTruthy();
    expect(getNextState('SENSE', 'supervised', null)).toBe('PAUSED');
    expect(getNextState('SENSE', 'supervised', 'approved')).toBe('PRIORITIZE');
  });

  it('PLAN -> EXECUTE is the desired transition when plan_path present', () => {
    const fixture = loadFixture();
    const decision = findDecision(fixture.decision_log || [], (entry) => (
      entry.stage === 'plan'
        && entry.action === 'plan_stage_skipped'
        && entry.outcome
        && entry.outcome.to_state === 'EXECUTE'
    ));

    expect(decision).toBeTruthy();
    expect(getNextState('PLAN', 'supervised', 'approved')).toBe('EXECUTE');
  });

  it(
    'EXECUTE -> VERIFY after successful plan run (see docs/superpowers/plans/2026-04-12-factory-gap-execute-verify-gate.md)',
    () => {
      expect(getNextState('EXECUTE', 'supervised', null)).toBe('VERIFY');
    }
  );

  it('VERIFY gated, LEARN gated, LEARN -> IDLE on approve', () => {
    expect(getNextState('VERIFY', 'supervised', null)).toBe('PAUSED');
    expect(getNextState('VERIFY', 'supervised', 'approved')).toBe('LEARN');
    expect(getNextState('LEARN', 'supervised', 'approved')).toBe('IDLE');
  });

  it('any rejected approval returns to IDLE', () => {
    for (const state of ['SENSE', 'PRIORITIZE', 'PLAN', 'VERIFY', 'LEARN']) {
      expect(getNextState(state, 'supervised', 'rejected')).toBe('IDLE');
    }
  });
});
