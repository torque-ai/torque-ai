'use strict';

describe('plan-quality-gate module exports', () => {
  it('exports evaluatePlan, runDeterministicRules, runLlmSemanticCheck, buildFeedbackPrompt, RULES', () => {
    const mod = require('../factory/plan-quality-gate');
    expect(typeof mod.evaluatePlan).toBe('function');
    expect(typeof mod.runDeterministicRules).toBe('function');
    expect(typeof mod.runLlmSemanticCheck).toBe('function');
    expect(typeof mod.buildFeedbackPrompt).toBe('function');
    expect(typeof mod.RULES).toBe('object');
    expect(mod.MAX_REPLAN_ATTEMPTS).toBe(1);
    expect(mod.LLM_TIMEOUT_MS).toBe(60_000);
  });
});

const { runDeterministicRules } = require('../factory/plan-quality-gate');

function buildTasks(bodies) {
  return bodies.map((body, i) => `## Task ${i + 1}: Title ${i + 1}\n\n${body}`).join('\n\n');
}

describe('runDeterministicRules — structural', () => {
  it('rule 1: empty plan hard-fails on plan_has_task_heading', () => {
    const { hardFails } = runDeterministicRules('');
    expect(hardFails.some(f => f.rule === 'plan_has_task_heading')).toBe(true);
  });

  it('rule 1: prose-only plan hard-fails on plan_has_task_heading', () => {
    const { hardFails } = runDeterministicRules('# Plan\n\nSome intro without task headings.');
    expect(hardFails.some(f => f.rule === 'plan_has_task_heading')).toBe(true);
  });

  it('rule 1: plan with at least one task heading passes', () => {
    const plan = buildTasks(['body '.repeat(30), 'body '.repeat(30)]);
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'plan_has_task_heading')).toBeUndefined();
  });

  it('rule 2: 16 tasks hard-fails on plan_task_count_upper_bound', () => {
    const bodies = Array(16).fill('body '.repeat(30));
    const { hardFails } = runDeterministicRules(buildTasks(bodies));
    expect(hardFails.some(f => f.rule === 'plan_task_count_upper_bound')).toBe(true);
  });

  it('rule 2: 15 tasks passes plan_task_count_upper_bound', () => {
    const bodies = Array(15).fill('body '.repeat(30));
    const { hardFails } = runDeterministicRules(buildTasks(bodies));
    expect(hardFails.find(f => f.rule === 'plan_task_count_upper_bound')).toBeUndefined();
  });

  it('rule 3: single-task plan emits warning plan_task_count_lower_bound', () => {
    const { warnings } = runDeterministicRules(buildTasks(['body '.repeat(30)]));
    expect(warnings.some(w => w.rule === 'plan_task_count_lower_bound')).toBe(true);
  });

  it('rule 3: two-task plan emits no warning for plan_task_count_lower_bound', () => {
    const { warnings } = runDeterministicRules(buildTasks(['body '.repeat(30), 'body '.repeat(30)]));
    expect(warnings.find(w => w.rule === 'plan_task_count_lower_bound')).toBeUndefined();
  });

  it('rule 4: task body under 100 chars hard-fails on task_body_min_length', () => {
    const plan = `## Task 1: Short\n\ntiny.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_body_min_length' && f.taskNumber === 1)).toBe(true);
  });

  it('rule 4: task body ≥ 100 chars passes task_body_min_length', () => {
    const plan = buildTasks(['This body is long enough and easily exceeds one hundred characters in length so the rule should pass.']);
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_body_min_length')).toBeUndefined();
  });
});
