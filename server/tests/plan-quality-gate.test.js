'use strict';

describe('plan-quality-gate module exports', () => {
  it('exports evaluatePlan, runDeterministicRules, runLlmSemanticCheck, buildFeedbackPrompt, RULES', () => {
    const mod = require('../factory/plan-quality-gate');
    expect(typeof mod.evaluatePlan).toBe('function');
    expect(typeof mod.runDeterministicRules).toBe('function');
    expect(typeof mod.runLlmSemanticCheck).toBe('function');
    expect(typeof mod.buildFeedbackPrompt).toBe('function');
    expect(typeof mod.isUnsupportedWorktreeSetupCritique).toBe('function');
    expect(typeof mod.RULES).toBe('object');
    expect(mod.MAX_REPLAN_ATTEMPTS).toBe(1);
    expect(mod.LLM_TIMEOUT_MS).toBe(60_000);
  });
});

const { runDeterministicRules } = require('../factory/plan-quality-gate');

function buildTasks(bodies) {
  return bodies.map((body, i) => `## Task ${i + 1}: Title ${i + 1}\n\n${body}`).join('\n\n');
}

function buildSingleTask(title, body) {
  return `## Task 1: ${title}\n\n${body}`;
}

function validBody() {
  return 'In src/foo.ts, adjust the focused behavior and run npx vitest server/tests/plan-quality-gate.test.js to verify the expected result.';
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

  it('rule 6: task with generated acceptance criteria phrasing passes task_has_acceptance_criterion', () => {
    const plan = `## Task 1: Extend file-context-builder focused coverage\n\nEdit server/tests/file-context-builder.test.js only, using server/execution/file-context-builder.js as the subject under test. Add a buildFileContext fallback test where symbolIndexerMock.searchSymbols throws after init. Acceptance criteria: buildFileContext must return whole-file numbered context for src/fallback.js, loggerMock.info must include Symbol index unavailable, and contextEnrichmentMock.enrichResolvedContextAsync must not be called when enrichment is disabled. Validation: npm --prefix server test -- tests/file-context-builder.test.js must pass.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_has_acceptance_criterion')).toBeUndefined();
  });

  it('rule 6: npm --prefix test command passes task_has_acceptance_criterion', () => {
    const plan = `## Task 1: Cover file context branches\n\nEdit server/tests/file-context-builder.test.js and target server/execution/file-context-builder.js with one focused regression around outside path handling. Validation: npm --prefix server test -- tests/file-context-builder.test.js should report the existing suite plus the new focused case.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_has_acceptance_criterion')).toBeUndefined();
  });

  it('rule 6: task with only a file reference but no acceptance criterion hard-fails task_has_acceptance_criterion', () => {
    const plan = `## Task 1: Touch src/foo.ts\n\nIn src/foo.ts adjust the handleFoo function so that its behavior is more in line with current expectations about the system.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_has_acceptance_criterion' && f.taskNumber === 1)).toBe(true);
  });

  it('rejects heavyweight local dotnet validation in task bodies', () => {
    const plan = `## Task 1: Record evidence\n\nUpdate docs/status/evidence.md with the touched files, then run dotnet build SpudgetBooks.sln and dotnet test SpudgetBooks.sln --no-build before committing.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_avoids_local_heavy_validation' && f.taskNumber === 1)).toBe(true);
  });

  it('allows heavyweight validation when it is routed through torque-remote', () => {
    const plan = `## Task 1: Record evidence\n\nUpdate docs/status/evidence.md with the touched files, then run torque-remote dotnet build SpudgetBooks.sln and torque-remote dotnet test SpudgetBooks.sln --no-build before committing.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_avoids_local_heavy_validation')).toBeUndefined();
  });

  it('rule 7: task with a single "appropriately" near a concrete object does NOT hard-fail', () => {
    const plan = `## Task 1: Wire src/bar.ts\n\nUpdate src/bar.ts to call the new helper appropriately. Run npx vitest tests/bar.test.ts to verify.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_avoids_vague_phrases')).toBeUndefined();
  });

  it('rule 7: task with unqualified forbidden phrases hard-fails task_avoids_vague_phrases', () => {
    const filler = 'This neutral planning context intentionally avoids naming a target object. '.repeat(3);
    const plan = `## Task 1: Rewrite behavior\n\nClean up the code as needed. ${filler} In src/bar.ts, update the call site and run npx vitest to verify.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_avoids_vague_phrases' && f.taskNumber === 1)).toBe(true);
  });

  it('rule 7: title "Update src/foo.ts to add X" passes concrete language', () => {
    const plan = buildSingleTask('Update src/foo.ts to add X', validBody());
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_avoids_vague_phrases')).toBeUndefined();
  });

  it('rule 7: title "Update `scripts/validate.ps1`" passes concrete language', () => {
    const plan = buildSingleTask('Update `scripts/validate.ps1`', validBody());
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_avoids_vague_phrases')).toBeUndefined();
  });

  it('rule 7: title "Modify GetAnnotationsAsync to filter by tenant" passes concrete language', () => {
    const plan = buildSingleTask('Modify GetAnnotationsAsync to filter by tenant', validBody());
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_avoids_vague_phrases')).toBeUndefined();
  });

  it('rule 7: title "Update the code" flags missing concrete language', () => {
    const filler = 'This neutral planning context intentionally avoids naming a target object. '.repeat(3);
    const plan = buildSingleTask('Update the code', `${filler}${validBody()}`);
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_avoids_vague_phrases' && f.taskNumber === 1)).toBe(true);
  });

  it('rule 7: title "Improve the implementation" flags missing concrete language', () => {
    const filler = 'This neutral planning context intentionally avoids naming a target object. '.repeat(3);
    const plan = buildSingleTask('Improve the implementation', `${filler}${validBody()}`);
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_avoids_vague_phrases' && f.taskNumber === 1)).toBe(true);
  });

  it('task-local git worktree setup hard-fails task_avoids_nested_worktree_setup', () => {
    const plan = `## Task 1: Centralize registry construction

Create a dedicated worktree before editing: \`git worktree add ../torque-public-remote-agent-registry-dedupe -b work-item-585-remote-agent-registry-dedupe\`. In that worktree, create \`server/plugins/remote-agents/registry-runtime.js\` and update \`server/api/v2-dispatch.js\` to use the helper. Run npx vitest server/tests/v2-dispatch.test.js to verify.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_avoids_nested_worktree_setup' && f.taskNumber === 1)).toBe(true);
  });

  it('product code that mentions git worktree add as behavior under test still passes nested-worktree guard', () => {
    const plan = `## Task 1: Cover worktree manager creation

In \`server/plugins/version-control/worktree-manager.js\` and \`server/plugins/version-control/tests/worktree-manager.test.js\`, assert that \`createWorktree\` invokes \`git worktree add\` through the injected command runner and records the returned branch. Run npx vitest server/plugins/version-control/tests/worktree-manager.test.js to verify.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_avoids_nested_worktree_setup')).toBeUndefined();
  });

  it('rule 5: WPF and .NET project paths count as concrete file references', () => {
    const plan = `## Task 1: Fix shell contrast

Edit \`src/SpudgetBooks.App/Navigation/Shell/SidebarTreeControl.xaml\`, \`src/SpudgetBooks.App/MainWindow.xaml\`, and \`tests/SpudgetBooks.App.Tests/SpudgetBooks.App.Tests.csproj\` so the shell contrast regression is covered. Run torque-remote dotnet test tests/SpudgetBooks.App.Tests/SpudgetBooks.App.Tests.csproj to verify.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_has_file_reference')).toBeUndefined();
  });
});

describe('runDeterministicRules — shape and budget', () => {
  it('rule 8: duplicate task titles hard-fail no_duplicate_task_titles', () => {
    const plan = `## Task 1: Wire src/foo.ts\n\nBody references src/foo.ts and runs npx vitest to verify. Body is long enough for rule 4.\n\n## Task 2: Wire src/foo.ts\n\nAnother body referencing src/bar.ts and running npx vitest. Body is long enough for rule 4.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'no_duplicate_task_titles')).toBe(true);
  });

  it('rule 8: distinct titles pass no_duplicate_task_titles', () => {
    const plan = `## Task 1: Wire src/foo.ts\n\nBody references src/foo.ts and runs npx vitest to verify. Body is long enough for rule 4.\n\n## Task 2: Wire src/bar.ts\n\nAnother body referencing src/bar.ts and running npx vitest. Body is long enough for rule 4.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'no_duplicate_task_titles')).toBeUndefined();
  });

  it('rule 9: "## Step 1:" grammar hard-fails task_heading_grammar', () => {
    const plan = `## Step 1: Wire src/foo.ts\n\nBody references src/foo.ts and runs npx vitest to verify. Body is long enough for rule 4.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_heading_grammar')).toBe(true);
  });

  it('rule 9: "## Task 0:" hard-fails task_heading_grammar', () => {
    const plan = `## Task 0: Wire src/foo.ts\n\nBody references src/foo.ts and runs npx vitest to verify. Body is long enough for rule 4.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_heading_grammar')).toBe(true);
  });

  it('rule 10: plan > 100 KB hard-fails plan_size_upper_bound', () => {
    const body = `## Task 1: Big plan\n\nBody references src/foo.ts and runs npx vitest. ${'x'.repeat(101 * 1024)}`;
    const { hardFails } = runDeterministicRules(body);
    expect(hardFails.some(f => f.rule === 'plan_size_upper_bound')).toBe(true);
  });

  it('rule 10: plan at 99 KB passes plan_size_upper_bound', () => {
    const body = `## Task 1: Sized plan\n\nBody references src/foo.ts and runs npx vitest. ${'x'.repeat(99 * 1024)}`;
    const { hardFails } = runDeterministicRules(body);
    expect(hardFails.find(f => f.rule === 'plan_size_upper_bound')).toBeUndefined();
  });
});

const { buildFeedbackPrompt } = require('../factory/plan-quality-gate');

describe('buildFeedbackPrompt', () => {
  it('returns null when there are no hard fails and no llm critique', () => {
    expect(buildFeedbackPrompt([], [{ rule: 'plan_task_count_lower_bound', detail: 'one task' }], null)).toBeNull();
    expect(buildFeedbackPrompt([], [], null)).toBeNull();
  });

  it('returns a structured block with hard-fail violations', () => {
    const out = buildFeedbackPrompt(
      [
        { rule: 'task_has_file_reference', taskNumber: 2, detail: 'Task 2 references no file.' },
        { rule: 'task_has_acceptance_criterion', taskNumber: 3, detail: 'Task 3 has no test command.' },
      ],
      [],
      null,
    );
    expect(out).toContain('## Prior plan rejected');
    expect(out).toContain('task_has_file_reference');
    expect(out).toContain('Task 2 references no file.');
    expect(out).toContain('task_has_acceptance_criterion');
  });

  it('appends llm critique under a distinct section', () => {
    const out = buildFeedbackPrompt(
      [{ rule: 'task_has_file_reference', taskNumber: 1, detail: 'no file.' }],
      [],
      'The plan does not address the stated goal of the work item.',
    );
    expect(out).toContain('Semantic concern');
    expect(out).toContain('does not address the stated goal');
  });

  it('includes warnings as a soft section when hard fails also exist', () => {
    const out = buildFeedbackPrompt(
      [{ rule: 'task_has_file_reference', taskNumber: 1, detail: 'no file.' }],
      [{ rule: 'plan_task_count_lower_bound', detail: 'Only one task.' }],
      null,
    );
    expect(out).toContain('plan_task_count_lower_bound');
    expect(out).toContain('Only one task');
  });

  it('renders taskNumber 0 with the Task 0 prefix (does not drop on falsy check)', () => {
    const out = buildFeedbackPrompt(
      [{ rule: 'some_rule', taskNumber: 0, detail: 'detail on zero-indexed task' }],
      [],
      null,
    );
    expect(out).toContain('Task 0:');
    expect(out).toContain('detail on zero-indexed task');
  });
});

describe('runLlmSemanticCheck', () => {
  const submitPath = require.resolve('../factory/internal-task-submit');
  const awaitPath = require.resolve('../handlers/workflow/await');
  const taskCorePath = require.resolve('../db/task-core');
  const gatePath = require.resolve('../factory/plan-quality-gate');
  const savedCache = new Map();

  function installMock(resolvedPath, exportsValue) {
    if (!savedCache.has(resolvedPath)) {
      savedCache.set(resolvedPath, require.cache[resolvedPath]);
    }
    require.cache[resolvedPath] = {
      id: resolvedPath,
      filename: resolvedPath,
      loaded: true,
      exports: exportsValue,
    };
  }

  beforeEach(() => {
    delete require.cache[gatePath];
  });

  afterEach(() => {
    for (const [path, original] of savedCache) {
      if (original) require.cache[path] = original;
      else delete require.cache[path];
    }
    savedCache.clear();
    delete require.cache[gatePath];
  });

  it('returns null when the submission helper throws', async () => {
    installMock(submitPath, {
      submitFactoryInternalTask: vi.fn().mockRejectedValue(new Error('provider down')),
    });
    const { runLlmSemanticCheck } = require('../factory/plan-quality-gate');
    const result = await runLlmSemanticCheck({
      plan: '## Task 1: Example\n\nSome body.',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(result).toBeNull();
  });

  it('returns null when the awaited task does not complete', async () => {
    installMock(submitPath, {
      submitFactoryInternalTask: vi.fn().mockResolvedValue({ task_id: 'tid-1' }),
    });
    installMock(awaitPath, {
      handleAwaitTask: vi.fn().mockResolvedValue({ status: 'timeout' }),
    });
    installMock(taskCorePath, {
      getTask: vi.fn().mockReturnValue({ status: 'running', output: null }),
    });
    const { runLlmSemanticCheck } = require('../factory/plan-quality-gate');
    const result = await runLlmSemanticCheck({
      plan: '## Task 1: Example\n\nSome body.',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(result).toBeNull();
  });

  it('returns the critique when the task completes with a go verdict and one-sentence critique', async () => {
    installMock(submitPath, {
      submitFactoryInternalTask: vi.fn().mockResolvedValue({ task_id: 'tid-2' }),
    });
    installMock(awaitPath, {
      handleAwaitTask: vi.fn().mockResolvedValue({ status: 'completed' }),
    });
    installMock(taskCorePath, {
      getTask: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"Plan covers the stated goal."}',
      }),
    });
    const { runLlmSemanticCheck } = require('../factory/plan-quality-gate');
    const result = await runLlmSemanticCheck({
      plan: '## Task 1: Example\n\nSome body.',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(result).toBe('Plan covers the stated goal.');
  });

  it('returns the raw string when the task output is unparseable (treated as go)', async () => {
    installMock(submitPath, {
      submitFactoryInternalTask: vi.fn().mockResolvedValue({ task_id: 'tid-3' }),
    });
    installMock(awaitPath, {
      handleAwaitTask: vi.fn().mockResolvedValue({ status: 'completed' }),
    });
    installMock(taskCorePath, {
      getTask: vi.fn().mockReturnValue({ status: 'completed', output: 'not json at all' }),
    });
    const { runLlmSemanticCheck } = require('../factory/plan-quality-gate');
    const result = await runLlmSemanticCheck({
      plan: '## Task 1: Example\n\nSome body.',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(result).toBe('not json at all');
  });
});

const planQualityGate = require('../factory/plan-quality-gate');

describe('isUnsupportedWorktreeSetupCritique', () => {
  it('recognizes critiques that incorrectly require factory worktree setup', () => {
    expect(planQualityGate.isUnsupportedWorktreeSetupCritique(
      'The implementation scope is sound, but the plan omits creation of a dedicated git worktree and feature branch before editing production code.',
    )).toBe(true);
  });

  it('does not suppress critiques about plans that add nested worktree setup', () => {
    expect(planQualityGate.isUnsupportedWorktreeSetupCritique(
      'The plan tells the worker to create a feature branch and worktree before editing, which conflicts with factory isolation.',
    )).toBe(false);
  });
});

describe('evaluatePlan orchestration', () => {
  it('deterministic hard fail: does NOT invoke the LLM pass; returns passed=false with feedbackPrompt', async () => {
    const llmSpy = vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue('should-not-be-called');
    const plan = '## Task 1: Too short\n\ntiny.'; // rule 4 hard fail
    const result = await planQualityGate.evaluatePlan({
      plan,
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(result.passed).toBe(false);
    expect(llmSpy).not.toHaveBeenCalled();
    expect(result.hardFails.length).toBeGreaterThan(0);
    expect(result.feedbackPrompt).toContain('## Prior plan rejected');
    llmSpy.mockRestore();
  });

  it('deterministic pass + LLM go: returns passed=true with critique populated', async () => {
    const llmSpy = vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue('Plan covers the goal.');
    const plan = '## Task 1: Edit src/foo.ts\n\nIn src/foo.ts rename handleX to handleY and run npx vitest tests/foo.test.ts. Body is long enough for rule 4.\n\n## Task 2: Edit src/bar.ts\n\nIn src/bar.ts call handleY via the new export and run npx vitest tests/bar.test.ts. Body is long enough for rule 4.';
    const result = await planQualityGate.evaluatePlan({
      plan,
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(result.passed).toBe(true);
    expect(llmSpy).toHaveBeenCalledTimes(1);
    expect(result.llmCritique).toBe('Plan covers the goal.');
    expect(result.feedbackPrompt).toBeNull();
    llmSpy.mockRestore();
  });

  it('deterministic pass + LLM no-go: returns passed=false with critique in feedbackPrompt', async () => {
    const llmSpy = vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue('[no-go] Plan rewrites the wrong subsystem.');
    const plan = '## Task 1: Edit src/foo.ts\n\nIn src/foo.ts rename handleX to handleY and run npx vitest tests/foo.test.ts. Body is long enough for rule 4.\n\n## Task 2: Edit src/bar.ts\n\nIn src/bar.ts call handleY via the new export and run npx vitest tests/bar.test.ts. Body is long enough for rule 4.';
    const result = await planQualityGate.evaluatePlan({
      plan,
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(result.passed).toBe(false);
    expect(result.feedbackPrompt).toContain('wrong subsystem');
    llmSpy.mockRestore();
  });

  it('deterministic pass + LLM worktree-setup no-go: treats the plan as pass', async () => {
    const llmSpy = vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue('[no-go] The implementation scope is sound, but the plan omits creation of a dedicated git worktree and feature branch before editing production code.');
    const plan = '## Task 1: Edit src/foo.ts\n\nIn src/foo.ts rename handleX to handleY and run npx vitest tests/foo.test.ts. Body is long enough for rule 4.\n\n## Task 2: Edit src/bar.ts\n\nIn src/bar.ts call handleY via the new export and run npx vitest tests/bar.test.ts. Body is long enough for rule 4.';
    const result = await planQualityGate.evaluatePlan({
      plan,
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(result.passed).toBe(true);
    expect(result.llmCritique).toBeNull();
    expect(result.feedbackPrompt).toBeNull();
    llmSpy.mockRestore();
  });

  it('deterministic pass + LLM returns null (timeout/error): treats as pass', async () => {
    const llmSpy = vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue(null);
    const plan = '## Task 1: Edit src/foo.ts\n\nIn src/foo.ts rename handleX to handleY and run npx vitest tests/foo.test.ts. Body is long enough for rule 4.\n\n## Task 2: Edit src/bar.ts\n\nIn src/bar.ts call handleY via the new export and run npx vitest tests/bar.test.ts. Body is long enough for rule 4.';
    const result = await planQualityGate.evaluatePlan({
      plan,
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(result.passed).toBe(true);
    expect(result.llmCritique).toBeNull();
    llmSpy.mockRestore();
  });
});
