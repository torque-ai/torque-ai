'use strict';

const fs = require('fs');
const path = require('path');

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

function hasGap(fixture, code) {
  return Array.isArray(fixture.gaps) && fixture.gaps.includes(code);
}

describe('factory Plan 1 loop state capture fixture', () => {
  it('records SENSE -> PRIORITIZE after approval', () => {
    const fixture = loadFixture();
    const decision = findDecision(fixture.decision_log || [], (entry) => (
      entry.stage === 'sense'
        && entry.outcome
        && entry.outcome.from_state === 'SENSE'
        && entry.outcome.to_state === 'PRIORITIZE'
        && entry.outcome.approval === 'approved'
    ));

    expect(decision).toBeTruthy();
  });

  it('records the PLAN skip for a pre-written plan', () => {
    const fixture = loadFixture();
    const decision = findDecision(fixture.decision_log || [], (entry) => (
      entry.stage === 'plan'
        && entry.action === 'plan_stage_skipped'
        && entry.outcome
        && entry.outcome.reason === 'pre-written plan detected'
    ));

    expect(decision).toBeTruthy();
  });

  it('records EXECUTE entry', () => {
    const fixture = loadFixture();
    const decision = findDecision(fixture.decision_log || [], (entry) => (
      entry.stage === 'execute'
        && entry.action === 'enter_execute'
    ));

    expect(decision).toBeTruthy();
  });

  it('captures the stop condition honestly when live EXECUTE is not attempted', () => {
    const fixture = loadFixture();
    const executeDecision = findDecision(fixture.decision_log || [], (entry) => (
      entry.stage === 'execute'
        && entry.action === 'enter_execute'
        && entry.outcome
    ));

    if (fixture.execution_mode === 'live') {
      const finalDecision = findDecision(fixture.decision_log || [], (entry) => (
        entry.outcome
          && entry.outcome.final_state === 'IDLE'
          && entry.outcome.work_item_status === 'shipped'
      ));

      expect(finalDecision).toBeTruthy();
      expect(fixture.final_state).toBe('IDLE');
      expect(fixture.work_item).toMatchObject({
        status: 'shipped',
      });
      return;
    }

    expect(fixture.execution_mode).toBe('stopped_at_execute');
    expect(fixture.final_state).toBe('EXECUTE');
    expect(fixture.work_item).toMatchObject({
      status: 'pending',
    });
    expect(hasGap(fixture, 'execute_stage_not_attempted_live')).toBe(true);
    expect(hasGap(fixture, 'wi1_not_selected_by_loop')).toBe(true);
    expect(executeDecision).toBeTruthy();
    expect(executeDecision.outcome).toMatchObject({
      requested_work_item_id: fixture.work_item.id,
    });
    expect(fixture.observed_execute_work_item).toMatchObject({
      status: 'executing',
    });
  });
});
