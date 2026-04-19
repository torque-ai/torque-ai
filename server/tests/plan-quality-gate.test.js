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

describe('runDeterministicRules — per-task content', () => {
  it('rule 5: task mentioning src/foo.ts passes task_has_file_reference', () => {
    const plan = `## Task 1: Edit foo\n\nChange handleFoo in src/foo.ts to add error handling per the acceptance test in tests/foo.test.ts. Expect: tests pass.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_has_file_reference')).toBeUndefined();
  });

  it('rule 5: task with search_files target passes task_has_file_reference', () => {
    const plan = `## Task 1: Find the thing\n\nUse search_files to locate handleFoo across the codebase and rewrite it to return null on missing input. Verify via npx vitest.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_has_file_reference')).toBeUndefined();
  });

  it('rule 5: task with no file or grep reference hard-fails task_has_file_reference', () => {
    const plan = `## Task 1: Improve things\n\nMake the code cleaner by addressing pending concerns around the module structure and ensuring all relevant behavior is preserved.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_has_file_reference' && f.taskNumber === 1)).toBe(true);
  });

  it('rule 6: task with npx vitest mention passes task_has_acceptance_criterion', () => {
    const plan = `## Task 1: Add a helper\n\nCreate src/helpers/format.ts and expose formatDuration. Run npx vitest tests/helpers/format.test.ts and confirm all tests pass before stopping.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_has_acceptance_criterion')).toBeUndefined();
  });

  it('rule 6: task with only a file reference but no acceptance criterion hard-fails task_has_acceptance_criterion', () => {
    const plan = `## Task 1: Touch src/foo.ts\n\nIn src/foo.ts adjust the handleFoo function so that its behavior is more in line with current expectations about the system.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_has_acceptance_criterion' && f.taskNumber === 1)).toBe(true);
  });

  it('rule 7: task with a single "appropriately" does NOT hard-fail (below 2-hit threshold)', () => {
    const plan = `## Task 1: Wire src/bar.ts\n\nUpdate src/bar.ts to call the new helper appropriately. Run npx vitest tests/bar.test.ts to verify.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_avoids_vague_phrases')).toBeUndefined();
  });

  it('rule 7: task with two forbidden phrases hard-fails task_avoids_vague_phrases', () => {
    const plan = `## Task 1: Wire src/bar.ts\n\nUpdate src/bar.ts appropriately and clean up any call sites as needed. Run npx vitest to verify.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_avoids_vague_phrases' && f.taskNumber === 1)).toBe(true);
  });
});
