'use strict';
/* global describe, it, expect, vi, beforeEach */

const { evaluatePlan, runDeterministicRules, augmentPlanMarkdown } = require('../factory/plan-quality-gate');

// Minimal valid plan markdown that passes all OTHER rules except acceptance criterion.
// Task body is >100 chars, has a file reference, no vague phrases, no worktree setup.
function makePlanWithoutAcceptance() {
  return [
    '## Task 1: Add logging to server/factory/plan-augmenter.js',
    '',
    'In `server/factory/plan-augmenter.js`, add a logger.info call at the start of the augment function.',
    'This ensures visibility into how many tasks are augmented on each plan evaluation.',
    'Edit the file and add the info log statement around line 35.',
    '',
  ].join('\n');
}

function makePlanWithAcceptance() {
  return [
    '## Task 1: Add logging to server/factory/plan-augmenter.js',
    '',
    'In `server/factory/plan-augmenter.js`, add a logger.info call at the start of the augment function.',
    'This ensures visibility into how many tasks are augmented on each plan evaluation.',
    'Edit the file and add the info log statement around line 35.',
    'Run `npm test` and assert no new failures.',
    '',
  ].join('\n');
}

// Mock runLlmSemanticCheck so tests don't need a live DB or internal task infrastructure.
const planQualityGate = require('../factory/plan-quality-gate');

describe('plan-quality-gate auto-augmentation', () => {
  beforeEach(() => {
    vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue(null);
  });

  it('augments missing acceptance criterion in markdown before validation when verify_command is set', async () => {
    const plan = makePlanWithoutAcceptance();
    const projectConfig = { verify_command: 'npm test' };

    // Without augmentation, this plan would fail rule task_has_acceptance_criterion.
    const deterministicResult = runDeterministicRules(plan);
    expect(deterministicResult.hardFails.some((f) => f.rule === 'task_has_acceptance_criterion')).toBe(true);

    // evaluatePlan with projectConfig should augment before validating.
    const result = await evaluatePlan({ plan, workItem: null, project: null, projectConfig });
    // After augmentation, no acceptance-criterion hard failure.
    expect(result.hardFails.filter((f) => f.rule === 'task_has_acceptance_criterion')).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it('does not augment when verify_command is absent', async () => {
    const plan = makePlanWithoutAcceptance();
    const projectConfig = {};

    // Without verify_command, augmentation is skipped; plan still fails acceptance criterion.
    const result = await evaluatePlan({ plan, workItem: null, project: null, projectConfig });
    expect(result.passed).toBe(false);
    expect(result.hardFails.some((f) => f.rule === 'task_has_acceptance_criterion')).toBe(true);
  });

  it('does not double-augment tasks that already have acceptance criterion', () => {
    const plan = makePlanWithAcceptance();
    const projectConfig = { verify_command: 'npm test' };

    // Plan already contains "npm test" — augmentation should be a no-op.
    const { plan: augmented, augmented: count } = augmentPlanMarkdown(plan, projectConfig, null);
    expect(count).toBe(0);
    // Verify line not duplicated.
    const npmTestCount = augmented.split('npm test').length - 1;
    expect(npmTestCount).toBe(1);
  });

  it('falls through to existing validation without augmentation if projectConfig is undefined', async () => {
    const plan = makePlanWithoutAcceptance();
    // No projectConfig — gate behaves exactly as before.
    const result = await evaluatePlan({ plan, workItem: null, project: null });
    expect(result.passed).toBe(false);
    expect(result.hardFails.some((f) => f.rule === 'task_has_acceptance_criterion')).toBe(true);
  });
});
