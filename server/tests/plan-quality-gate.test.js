'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    expect(mod.LLM_TIMEOUT_MS).toBe(5 * 60_000);
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

function withTempRepo(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-quality-gate-'));
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = callback(dir);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function writeFixtureFiles(repoPath, files) {
  for (const file of files) {
    const absolute = path.join(repoPath, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'module.exports = {};\n');
  }
}

function withEvaluatePlanRepo(callback) {
  return withTempRepo((repoPath) => {
    writeFixtureFiles(repoPath, [
      'src/foo.ts',
      'src/bar.ts',
      'tests/foo.test.ts',
      'tests/bar.test.ts',
      'server/handlers/workflow/index.js',
      'server/tests/handler-workflow-handlers.test.js',
    ]);
    return callback(repoPath);
  });
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

  it('rule 1: h3 task headings match executor-supported plan syntax', () => {
    const plan = [
      '# Historical Plan',
      '',
      '### Task 1: Edit provider quotas',
      '',
      'Change server/db/provider-quotas.js and validate with npx vitest server/tests/provider-quotas.test.js so the existing provider quota behavior remains covered.',
      '',
      '### Task 2: Update provider dashboard',
      '',
      'Change dashboard/src/views/Providers.jsx and validate with npx vitest dashboard/src/views/Providers.test.jsx so the dashboard renders the new quota state.',
    ].join('\n');

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

  it('rule 5: validation command target with a path segment passes task_has_file_reference', () => {
    const plan = `## Task 1: Restart and smoke\n\nRun \`npx vitest run tests/workflow-budget --no-coverage\` and assert the budget regression suite passes. Then submit a smoke workflow with cost_budget_usd set to 0.01 and expect the workflow to fail with budget_exhausted.`;
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

  it('rejects standalone read-only tasks before a real edit task', () => {
    const plan = `## Task 1: Read ollama-tools coverage to identify covered groups

Read \`server/tests/ollama-tools-coverage.test.js\` and identify which TODO coverage entries are already covered. Run npx vitest run server/tests/ollama-tools-coverage.test.js and confirm the suite passes before moving on.

## Task 2: Prune completed Ollama tools coverage TODOs

Edit \`server/tests/TODO-test-coverage.md\` to remove only completed Ollama tools coverage entries backed by the coverage suite. Acceptance criteria: npx vitest run server/tests/ollama-tools-coverage.test.js should pass and the TODO file should still list uncovered work.`;
    const { hardFails } = runDeterministicRules(plan);

    expect(hardFails.some(f => f.rule === 'task_requires_repository_change' && f.taskNumber === 1)).toBe(true);
    expect(hardFails.find(f => f.rule === 'task_requires_repository_change' && f.taskNumber === 2)).toBeUndefined();
  });

  it('allows reading and validation inside the task that edits the repository', () => {
    const plan = `## Task 1: Prune completed Ollama tools coverage TODOs

Read \`server/tests/ollama-tools-coverage.test.js\`, then edit \`server/tests/TODO-test-coverage.md\` to remove only completed Ollama tools coverage entries backed by the coverage suite. Acceptance criteria: npx vitest run server/tests/ollama-tools-coverage.test.js should pass and the TODO file should still list uncovered work.`;
    const { hardFails } = runDeterministicRules(plan);

    expect(hardFails.find(f => f.rule === 'task_requires_repository_change')).toBeUndefined();
  });

  it('rejects heavyweight local dotnet validation in task bodies', () => {
    const plan = `## Task 1: Record evidence\n\nUpdate docs/status/evidence.md with the touched files, then run dotnet build example-project.sln and dotnet test example-project.sln --no-build before committing.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_avoids_local_heavy_validation' && f.taskNumber === 1)).toBe(true);
  });

  it('allows heavyweight validation when it is routed through torque-remote', () => {
    const plan = `## Task 1: Record evidence\n\nUpdate docs/status/evidence.md with the touched files, then run torque-remote dotnet build example-project.sln and torque-remote dotnet test example-project.sln --no-build before committing.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_avoids_local_heavy_validation')).toBeUndefined();
  });

  it('rejects test-runner validation that targets remote config metadata', () => {
    const plan = `## Task 1: Cover remote config behavior

Edit server/tests/remote-config.test.js to assert that remote config parsing keeps the expected defaults for torque-public. Run npx vitest run .torque-remote.json and expect the remote config validation to pass.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.some(f => f.rule === 'task_avoids_config_file_test_targets' && f.taskNumber === 1)).toBe(true);
  });

  it('allows config validation through a parser command instead of a test-runner target', () => {
    const plan = `## Task 1: Validate remote config parsing

Edit .torque-remote.json only to correct the remote host metadata. Acceptance criteria: JSON.parse must pass for .torque-remote.json and no source files should change. Validation: run node -e "JSON.parse(require('fs').readFileSync('.torque-remote.json','utf8'))" and expect exit code 0.`;
    const { hardFails } = runDeterministicRules(plan);
    expect(hardFails.find(f => f.rule === 'task_avoids_config_file_test_targets')).toBeUndefined();
  });

  it('rejects edit-style tasks that target missing repository files', () => withTempRepo((repoPath) => {
    fs.mkdirSync(path.join(repoPath, 'server', 'db'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'server', 'db', 'workflow-engine.js'), 'module.exports = {};\n');

    const plan = `## Task 1: Integrate cost ceiling enforcement

Edit \`server/execution/workflow-advance.js\` to call the budget ceiling helper before promoting ready workflow tasks. Acceptance criteria: requiring \`server/execution/workflow-advance.js\` should expose handleWorkflowTaskCompletion, and npx vitest run server/tests/workflow-runtime.test.js should pass.`;
    const { hardFails } = runDeterministicRules(plan, { repoPath });
    const fail = hardFails.find(f => f.rule === 'task_edit_targets_exist');

    expect(fail).toBeTruthy();
    expect(fail.taskNumber).toBe(1);
    expect(fail.detail).toContain('server/execution/workflow-advance.js');
  }));

  it('suggests nearby existing files for missing edit targets', () => withTempRepo((repoPath) => {
    writeFixtureFiles(repoPath, [
      'server/mcp/schemas/v1/torque.task.submit.request.schema.json',
      'server/handlers/mcp-tools.js',
      'server/api/v2-task-handlers.js',
    ]);

    const plan = `## Task 1: Wire task submission validators

Edit \`server/mcp/schemas/v1/torque.task.submit.request.schema.js\` and \`server/mcp/tool-handlers.js\` to persist output validators. Acceptance criteria: npx vitest run server/tests/task-handlers.test.js should pass.`;
    const { hardFails } = runDeterministicRules(plan, { repoPath });
    const fail = hardFails.find(f => f.rule === 'task_edit_targets_exist');

    expect(fail).toBeTruthy();
    expect(fail.detail).toContain('Existing nearby candidate(s)');
    expect(fail.detail).toContain('server/mcp/schemas/v1/torque.task.submit.request.schema.json');
    expect(fail.detail).toMatch(/server\/(?:handlers\/mcp-tools|api\/v2-task-handlers)\.js/);
  }));

  it('does not reject create-file tasks for missing new files', () => withTempRepo((repoPath) => {
    const plan = `## Task 1: Add focused cost ceiling tests

Create \`server/tests/cost-ceiling.test.js\` with Vitest coverage for budget ceiling behavior. Acceptance criteria: npx vitest run server/tests/cost-ceiling.test.js should pass and the test file should contain six focused cases.`;
    const { hardFails } = runDeterministicRules(plan, { repoPath });

    expect(hardFails.find(f => f.rule === 'task_edit_targets_exist')).toBeUndefined();
  }));

  it('allows later tasks to edit files created earlier in the same plan', () => withTempRepo((repoPath) => {
    const plan = `## Task 1: Create tool registry module

Create \`server/tool-registry.js\` as a pure metadata module exporting CORE_TOOLS. Acceptance criteria: requiring \`server/tool-registry.js\` should return the registry object and npx vitest run server/tests/tool-registry.test.js should pass.

## Task 2: Wire registry helpers

Update \`server/tool-registry.js\` to add getToolNames and expose the tier map after Task 1 creates the file. Acceptance criteria: npx vitest run server/tests/tool-registry.test.js should pass with the helper assertions.`;
    const { hardFails } = runDeterministicRules(plan, { repoPath });

    expect(hardFails.find(f => f.rule === 'task_edit_targets_exist')).toBeUndefined();
  }));

  it('allows a task to edit a file it explicitly creates in the same task body', () => withTempRepo((repoPath) => {
    const plan = `## Task 1: Create performance runner

Create \`server/perf/run.js\` and update \`server/perf/run.js\` in the same task to print a baseline comparison table. Acceptance criteria: node server/perf/run.js should exit 0 and npx vitest run server/tests/perf-runner.test.js should pass.`;
    const { hardFails } = runDeterministicRules(plan, { repoPath });

    expect(hardFails.find(f => f.rule === 'task_edit_targets_exist')).toBeUndefined();
  }));

  it('normalizes leaked internal worktree prefixes before checking edit targets', () => withTempRepo((repoPath) => {
    writeFixtureFiles(repoPath, [
      'server/tests/provider-investigation-fixes.test.js',
      'server/tests/workflow-runtime.test.js',
    ]);

    const plan = `## Task 1: Move pending_provider_switch cancellation test

Update \`server/.tmp/worktrees/task-factory-internal-architect_cycle-project-abc/server/tests/workflow-runtime.test.js\` to add the pending_provider_switch cancellation case using the existing harness. Acceptance criteria: run npx vitest run server/tests/workflow-runtime.test.js and expect it to pass.

## Task 2: Remove skipped provider investigation block

Edit \`server/.tmp/worktrees/task-factory-internal-architect_cycle-project-abc/server/tests/provider-investigation-fixes.test.js\` to delete the obsolete skipped describe block. Acceptance criteria: run npx vitest run server/tests/provider-investigation-fixes.test.js and expect it to pass.`;
    const { hardFails } = runDeterministicRules(plan, { repoPath });

    expect(hardFails.find(f => f.rule === 'task_edit_targets_exist')).toBeUndefined();
  }));

  it('does not truncate .json references to missing .js edit targets', () => withTempRepo((repoPath) => {
    writeFixtureFiles(repoPath, [
      'server/perf/baseline.json',
      'scripts/perf-baseline-trailer.js',
      'server/tests/perf-update-baseline.test.js',
    ]);

    const plan = `## Task 1: Create performance gate documentation

Create \`docs/performance-gate.md\` as a single new documentation file. The baseline-update protocol section must mention \`scripts/perf-baseline-trailer.js\` and state that commits modifying \`server/perf/baseline.json\` require a trailer. Acceptance criteria: run \`node -e "const fs=require('fs'); const c=fs.readFileSync('docs/performance-gate.md','utf8'); if(!c.includes('server/perf/baseline.json')) process.exit(1)"\` and expect exit code 0.`;

    const { hardFails } = runDeterministicRules(plan, { repoPath });
    const fail = hardFails.find(f => f.rule === 'task_edit_targets_exist');

    expect(fail).toBeUndefined();
  }));

  it('rejects duplicate create-file targets across tasks', () => {
    const plan = `## Task 1: Extract DAG resolver tests

Create \`server/tests/workflow-runtime.test.js\` with focused DAG resolver coverage. Acceptance criteria: npx vitest run server/tests/workflow-runtime.test.js should pass and the file should contain six resolver cases.

## Task 2: Extract task handler tests

Create \`server/tests/workflow-runtime.test.js\` with focused task handler coverage. Acceptance criteria: npx vitest run server/tests/workflow-runtime.test.js should pass and the file should contain five handler cases.`;
    const { hardFails } = runDeterministicRules(plan);
    const fail = hardFails.find(f => f.rule === 'task_create_targets_unique');

    expect(fail).toBeTruthy();
    expect(fail.detail).toContain('server/tests/workflow-runtime.test.js');
    expect(fail.detail).toContain('Task 1');
    expect(fail.detail).toContain('Task 2');
  });

  it('allows distinct create-file targets across tasks', () => {
    const plan = `## Task 1: Extract DAG resolver tests

Create \`server/tests/workflow-dag-resolver.test.js\` with focused DAG resolver coverage. Acceptance criteria: npx vitest run server/tests/workflow-dag-resolver.test.js should pass and the file should contain six resolver cases.

## Task 2: Extract task handler tests

Create \`server/tests/workflow-task-handlers.test.js\` with focused task handler coverage. Acceptance criteria: npx vitest run server/tests/workflow-task-handlers.test.js should pass and the file should contain five handler cases.`;
    const { hardFails } = runDeterministicRules(plan);

    expect(hardFails.find(f => f.rule === 'task_create_targets_unique')).toBeUndefined();
  });

  it('rejects repeated validation command targets inside one command', () => {
    const plan = `## Task 1: Validate workflow runtime split

Edit \`server/execution/workflow-runtime.js\` to delegate DAG resolution and run \`npx vitest run server/tests/workflow-runtime.test.js server/tests/workflow-runtime.test.js\`. Acceptance criteria: the workflow runtime tests should pass without duplicate command targets.`;
    const { hardFails } = runDeterministicRules(plan);
    const fail = hardFails.find(f => f.rule === 'validation_command_targets_unique');

    expect(fail).toBeTruthy();
    expect(fail.taskNumber).toBe(1);
    expect(fail.detail).toContain('server/tests/workflow-runtime.test.js');
  });

  it('allows the same validation target in separate task commands', () => {
    const plan = `## Task 1: Update runtime dependency wiring

Edit \`server/execution/workflow-runtime.js\` to accept an injected helper and run \`npx vitest run server/tests/workflow-runtime.test.js\`. Acceptance criteria: the runtime suite should pass for the injected helper.

## Task 2: Update runtime container registration

Edit \`server/container.js\` to register the helper and run \`npx vitest run server/tests/workflow-runtime.test.js\`. Acceptance criteria: the same runtime suite should pass after container wiring.`;
    const { hardFails } = runDeterministicRules(plan);

    expect(hardFails.find(f => f.rule === 'validation_command_targets_unique')).toBeUndefined();
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

  it('rule 7: adjective "modified files" does not hard-fail concrete tasks', () => {
    const plan = `## Task 1: Add workflow event coverage

Edit \`server/events/event-types.js\` and run \`npx vitest run server/tests/workflow-runtime.test.js\`. Acceptance criteria: the modified files must keep workflow event constants importable and the workflow runtime tests should pass.`;
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

Edit \`src/example-project.App/Navigation/Shell/SidebarTreeControl.xaml\`, \`src/example-project.App/MainWindow.xaml\`, and \`tests/example-project.App.Tests/example-project.App.Tests.csproj\` so the shell contrast regression is covered. Run torque-remote dotnet test tests/example-project.App.Tests/example-project.App.Tests.csproj to verify.`;
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

  it('reuses an active queued semantic review task instead of submitting a duplicate', async () => {
    const plan = '## Task 1: Example\n\nSome body.';
    const hash = require('crypto').createHash('sha256').update(plan).digest('hex').slice(0, 16);
    const submitMock = vi.fn();
    const awaitMock = vi.fn().mockResolvedValue({ status: 'timeout' });
    installMock(submitPath, {
      submitFactoryInternalTask: submitMock,
    });
    installMock(awaitPath, {
      handleAwaitTask: awaitMock,
    });
    installMock(taskCorePath, {
      listTasks: vi.fn().mockReturnValue([{
        id: 'existing-review',
        status: 'queued',
        tags: [
          'factory:plan_quality_review',
          'factory:project_id=p',
          'factory:work_item_id=1',
          `factory:plan_review_hash=${hash}`,
        ],
      }]),
      getTask: vi.fn().mockReturnValue({ status: 'queued', output: null }),
    });
    const { runLlmSemanticCheck } = require('../factory/plan-quality-gate');
    const result = await runLlmSemanticCheck({
      plan,
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });

    expect(result).toBeNull();
    expect(submitMock).not.toHaveBeenCalled();
    expect(awaitMock).toHaveBeenCalledWith({
      task_id: 'existing-review',
      timeout_minutes: 5,
      heartbeat_minutes: 0,
    });
  });

  it('reuses a completed semantic review task without awaiting or resubmitting', async () => {
    const plan = '## Task 1: Example\n\nSome body.';
    const hash = require('crypto').createHash('sha256').update(plan).digest('hex').slice(0, 16);
    const submitMock = vi.fn();
    const awaitMock = vi.fn();
    installMock(submitPath, {
      submitFactoryInternalTask: submitMock,
    });
    installMock(awaitPath, {
      handleAwaitTask: awaitMock,
    });
    installMock(taskCorePath, {
      listTasks: vi.fn().mockReturnValue([{
        id: 'completed-review',
        status: 'completed',
        tags: [
          'factory:plan_quality_review',
          'factory:project_id=p',
          'factory:work_item_id=1',
          `factory:plan_review_hash=${hash}`,
        ],
      }]),
      getTask: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"Existing review approved this plan."}',
      }),
    });
    const { runLlmSemanticCheck } = require('../factory/plan-quality-gate');
    const result = await runLlmSemanticCheck({
      plan,
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });

    expect(result).toBe('Existing review approved this plan.');
    expect(submitMock).not.toHaveBeenCalled();
    expect(awaitMock).not.toHaveBeenCalled();
  });

  it('returns the critique when the task completes with a go verdict and one-sentence critique', async () => {
    const submitMock = vi.fn().mockResolvedValue({ task_id: 'tid-2' });
    installMock(submitPath, {
      submitFactoryInternalTask: submitMock,
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
    expect(submitMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'plan_quality_review',
      working_directory: '/tmp/p',
      timeout_minutes: 5,
      extra_tags: expect.arrayContaining([expect.stringMatching(/^factory:plan_review_hash=/)]),
      extra_metadata: expect.objectContaining({
        plan_review_hash: expect.any(String),
      }),
    }));
  });

  it('includes verified repository path evidence in the submitted semantic review prompt', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-quality-scope-'));
    try {
      for (const repoFile of [
        'server/db/file/baselines.js',
        'server/tests/file-baselines-boundary.test.js',
      ]) {
        const absolute = path.join(repoPath, repoFile);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, '// fixture\n');
      }
      const submitMock = vi.fn().mockResolvedValue({ task_id: 'tid-scope' });
      installMock(submitPath, {
        submitFactoryInternalTask: submitMock,
      });
      installMock(awaitPath, {
        handleAwaitTask: vi.fn().mockResolvedValue({ status: 'completed' }),
      });
      installMock(taskCorePath, {
        getTask: vi.fn().mockReturnValue({
          status: 'completed',
          output: '{"verdict":"go","critique":"Plan uses verified paths."}',
        }),
      });
      const { runLlmSemanticCheck } = require('../factory/plan-quality-gate');
      const plan = [
        '## Task 1: Fix boundary check',
        '',
        'Edit `server/db/file/baselines.js` and run `npx vitest run server/tests/file-baselines-boundary.test.js`.',
      ].join('\n');
      const result = await runLlmSemanticCheck({
        plan,
        workItem: {
          id: 2301,
          title: 'SEC-NEW-04: Expected-output enforcement can be bypassed with sibling-prefix paths',
          description: 'File: `server/db/file-baselines.js:737`. Replace the prefix check in checkFileLocationAnomalies.',
        },
        project: { id: 'p', path: repoPath },
      });

      expect(result).toBe('Plan uses verified paths.');
      const prompt = submitMock.mock.calls[0][0].task;
      expect(prompt).toContain('Repository path evidence:');
      expect(prompt).toContain('Verified repository paths referenced by this plan:');
      expect(prompt).toContain('`server/db/file/baselines.js`');
      expect(prompt).toContain('`server/tests/file-baselines-boundary.test.js`');
      expect(prompt).toContain('Candidate paths from work-item prose that are not present at their stated path:');
      expect(prompt).toContain('`server/db/file-baselines.js`');
      expect(prompt).toContain('do not reject a plan for using a verified repository path');
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
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

  it('treats explicit plain-text no-go reviewer output as a rejection', async () => {
    installMock(submitPath, {
      submitFactoryInternalTask: vi.fn().mockResolvedValue({ task_id: 'tid-plain-no-go' }),
    });
    installMock(awaitPath, {
      handleAwaitTask: vi.fn().mockResolvedValue({ status: 'completed' }),
    });
    installMock(taskCorePath, {
      getTask: vi.fn().mockReturnValue({
        status: 'completed',
        output: 'The plan receives a no-go verdict. Key issues: broken server/server/tests path.',
      }),
    });
    const { runLlmSemanticCheck } = require('../factory/plan-quality-gate');
    const result = await runLlmSemanticCheck({
      plan: '## Task 1: Example\n\nSome body.',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(result).toBe('[no-go] The plan receives a no-go verdict. Key issues: broken server/server/tests path.');
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

  it('deterministic pass + LLM go: returns passed=true with critique populated', () => withEvaluatePlanRepo(async (repoPath) => {
    const llmSpy = vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue('Plan covers the goal.');
    const plan = '## Task 1: Edit src/foo.ts\n\nIn src/foo.ts rename handleX to handleY and run npx vitest tests/foo.test.ts. Body is long enough for rule 4.\n\n## Task 2: Edit src/bar.ts\n\nIn src/bar.ts call handleY via the new export and run npx vitest tests/bar.test.ts. Body is long enough for rule 4.';
    const result = await planQualityGate.evaluatePlan({
      plan,
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: repoPath },
    });
    expect(result.passed).toBe(true);
    expect(llmSpy).toHaveBeenCalledTimes(1);
    expect(result.llmCritique).toBe('Plan covers the goal.');
    expect(result.feedbackPrompt).toBeNull();
    llmSpy.mockRestore();
  }));

  it('deterministic pass + LLM no-go: returns passed=false with critique in feedbackPrompt', () => withEvaluatePlanRepo(async (repoPath) => {
    const llmSpy = vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue('[no-go] Plan rewrites the wrong subsystem.');
    const plan = '## Task 1: Edit src/foo.ts\n\nIn src/foo.ts rename handleX to handleY and run npx vitest tests/foo.test.ts. Body is long enough for rule 4.\n\n## Task 2: Edit src/bar.ts\n\nIn src/bar.ts call handleY via the new export and run npx vitest tests/bar.test.ts. Body is long enough for rule 4.';
    const result = await planQualityGate.evaluatePlan({
      plan,
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: repoPath },
    });
    expect(result.passed).toBe(false);
    expect(result.feedbackPrompt).toContain('wrong subsystem');
    llmSpy.mockRestore();
  }));

  it('deterministic pass + LLM no-go in dark trust: blocks with critique feedback', () => withEvaluatePlanRepo(async (repoPath) => {
    const llmSpy = vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue('[no-go] Plan rewrites the wrong subsystem.');
    const plan = '## Task 1: Edit src/foo.ts\n\nIn src/foo.ts rename handleX to handleY and run npx vitest tests/foo.test.ts. Body is long enough for rule 4.\n\n## Task 2: Edit src/bar.ts\n\nIn src/bar.ts call handleY via the new export and run npx vitest tests/bar.test.ts. Body is long enough for rule 4.';
    const result = await planQualityGate.evaluatePlan({
      plan,
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: repoPath, trust_level: 'dark' },
    });
    expect(result.passed).toBe(false);
    expect(result.feedbackPrompt).toContain('wrong subsystem');
    expect(result.llmCritique).toContain('wrong subsystem');
    llmSpy.mockRestore();
  }));

  it('deterministic pass + concrete acceptance mismatch no-go in dark trust: blocks execution', () => withEvaluatePlanRepo(async (repoPath) => {
    const critique = 'The plan misses the required test file and verification command by adding coverage to server/tests/handler-workflow-handlers.test.js instead of server/tests/workflow-dag-validation.test.js.';
    const llmSpy = vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue(`[no-go] ${critique}`);
    const plan = '## Task 1: Edit server/handlers/workflow/index.js\n\nIn server/handlers/workflow/index.js add the workflow DAG guard and run npx vitest server/tests/handler-workflow-handlers.test.js. Body is long enough for rule 4.\n\n## Task 2: Edit server/tests/handler-workflow-handlers.test.js\n\nIn server/tests/handler-workflow-handlers.test.js add dispatch rejection coverage and run npx vitest server/tests/handler-workflow-handlers.test.js. Body is long enough for rule 4.';
    const result = await planQualityGate.evaluatePlan({
      plan,
      workItem: {
        id: 194,
        title: 'Fabro #64: Add build-time workflow DAG validation before dispatch',
        description: 'Add focused tests in server/tests/workflow-dag-validation.test.js and verify with npm test -- server/tests/workflow-dag-validation.test.js.',
      },
      project: { id: 'p', path: repoPath, trust_level: 'dark' },
    });

    expect(result.passed).toBe(false);
    expect(result.llmCritique).toContain('required test file');
    expect(result.feedbackPrompt).toContain('server/tests/workflow-dag-validation.test.js');
    llmSpy.mockRestore();
  }));

  it('deterministic pass + LLM worktree-setup no-go: treats the plan as pass', () => withEvaluatePlanRepo(async (repoPath) => {
    const llmSpy = vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue('[no-go] The implementation scope is sound, but the plan omits creation of a dedicated git worktree and feature branch before editing production code.');
    const plan = '## Task 1: Edit src/foo.ts\n\nIn src/foo.ts rename handleX to handleY and run npx vitest tests/foo.test.ts. Body is long enough for rule 4.\n\n## Task 2: Edit src/bar.ts\n\nIn src/bar.ts call handleY via the new export and run npx vitest tests/bar.test.ts. Body is long enough for rule 4.';
    const result = await planQualityGate.evaluatePlan({
      plan,
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: repoPath },
    });
    expect(result.passed).toBe(true);
    expect(result.llmCritique).toBeNull();
    expect(result.feedbackPrompt).toBeNull();
    llmSpy.mockRestore();
  }));

  it('deterministic pass + LLM returns null (timeout/error): treats as pass', () => withEvaluatePlanRepo(async (repoPath) => {
    const llmSpy = vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue(null);
    const plan = '## Task 1: Edit src/foo.ts\n\nIn src/foo.ts rename handleX to handleY and run npx vitest tests/foo.test.ts. Body is long enough for rule 4.\n\n## Task 2: Edit src/bar.ts\n\nIn src/bar.ts call handleY via the new export and run npx vitest tests/bar.test.ts. Body is long enough for rule 4.';
    const result = await planQualityGate.evaluatePlan({
      plan,
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: repoPath },
    });
    expect(result.passed).toBe(true);
    expect(result.llmCritique).toBeNull();
    llmSpy.mockRestore();
  }));
});
