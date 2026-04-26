'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createPlanExecutor } = require('../factory/plan-executor');

const PLAN = `# X

**Tech Stack:** Node.js, vitest.

## Task 1: first

- [ ] **Step 1: test**

\`\`\`js
expect(1).toBe(1);
\`\`\`

- [ ] **Step 2: commit**

\`\`\`bash
git commit -m "feat: first"
\`\`\`

## Task 2: second

- [ ] **Step 1: more**

\`\`\`js
// impl
\`\`\`

- [ ] **Step 2: commit**

\`\`\`bash
git commit -m "feat: second"
\`\`\`
`;

describe('plan-executor', () => {
  let dir, planPath, submitMock, awaitMock, exec;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-exec-'));
    planPath = path.join(dir, 'plan.md');
    fs.writeFileSync(planPath, PLAN);
    submitMock = vi.fn(async ({ task: _task }) => ({ task_id: `t_${submitMock.mock.calls.length}` }));
    awaitMock = vi.fn(async () => ({ status: 'completed', verify_status: 'passed' }));
    exec = createPlanExecutor({ submit: submitMock, awaitTask: awaitMock });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('submits one torque task per plan-task, in order', async () => {
    await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(submitMock).toHaveBeenCalledTimes(2);
    expect(submitMock.mock.calls[0][0].task).toContain('Task 1');
    expect(submitMock.mock.calls[1][0].task).toContain('Task 2');
  });

  it('passes verify_command + commit_message to await', async () => {
    await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(awaitMock.mock.calls[0][0].verify_command).toContain('vitest');
    expect(awaitMock.mock.calls[0][0].commit_message).toBe('feat: first');
  });

  it('ticks checkboxes in the plan file after a task succeeds', async () => {
    await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    const updated = fs.readFileSync(planPath, 'utf8');
    expect(updated).not.toContain('- [ ] **Step 1: test**');
    expect(updated).toContain('- [x] **Step 1: test**');
    expect(updated).toContain('- [x] **Step 2: commit**');
  });

  it('stops at first failed task and leaves later checkboxes untouched', async () => {
    awaitMock = vi.fn()
      .mockResolvedValueOnce({ status: 'completed', verify_status: 'passed' })
      .mockResolvedValueOnce({ status: 'failed', error: 'verify red' });
    exec = createPlanExecutor({ submit: submitMock, awaitTask: awaitMock });
    const result = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(result.failed_task).toBe(2);
    const updated = fs.readFileSync(planPath, 'utf8');
    expect(updated).toContain('## Task 1: first\n\n- [x]');
    expect(updated).toContain('## Task 2: second\n\n- [ ]');
  });

  it('skips already-ticked tasks on resume', async () => {
    const pre = PLAN.replace(/- \[ \] \*\*Step (1|2): (test|commit)\*\*/g, '- [x] **Step $1: $2**');
    fs.writeFileSync(planPath, pre);
    await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0][0].task).toContain('Task 2');
  });

  it('returns a summary with completed_tasks + failed_task + duration_ms', async () => {
    const r = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(r.completed_tasks).toEqual([1, 2]);
    expect(r.failed_task).toBeNull();
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('does not trust [x] markers when the task references files that do not exist', async () => {
    // This is the live-observed 2026-04-15 failure: the plan's [x]
    // checkboxes were carried over from a corrupted prior run, but the
    // referenced source files were never actually created. plan-executor
    // used to skip every task and ship an empty batch. Now it sees the
    // missing artifacts, distrusts the [x], and submits the task.
    const PLAN_WITH_PHANTOM_TICKS = `# Fabro X

**Tech Stack:** Node.js, vitest.

## Task 1: create handoff module

- [x] **Step 1: Implement**

Create \`server/crew/handoff.js\`:

\`\`\`js
'use strict';
module.exports = { createHandoff: () => ({ __handoff: true }) };
\`\`\`

- [x] **Step 2: Tests**

Create \`server/tests/handoff.test.js\`:

\`\`\`js
expect(1).toBe(1);
\`\`\`
`;
    fs.writeFileSync(planPath, PLAN_WITH_PHANTOM_TICKS);
    // working_directory (dir) contains the plan but NOT server/crew/handoff.js
    // or server/tests/handoff.test.js — those files were never created.

    const r = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });

    // The task must have been submitted — not silently skipped.
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0][0].task).toContain('Task 1');
    expect(r.completed_tasks).toEqual([1]);
    expect(r.failed_task).toBeNull();
  });

  it('flags no_tasks_executed when live mode parses zero tasks from the plan', async () => {
    // Live regression: factory cycle 2026-04-19 had EXECUTE return
    // completed_tasks: [] with no failed_task because the worktree's plan
    // copy parsed to zero actionable tasks. LEARN then refused to merge the
    // empty branch, looping forever. Fix 1 surfaces this as an execute-fail
    // signal so the loop can pause / quarantine.
    const EMPTY_PLAN = `# Plan with no actionable tasks

Some narrative text but no \`## Task N:\` headers, so parsePlanFile
returns zero entries.
`;
    fs.writeFileSync(planPath, EMPTY_PLAN);
    const r = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(submitMock).not.toHaveBeenCalled();
    expect(r.completed_tasks).toEqual([]);
    expect(r.failed_task).toBeNull();
    expect(r.no_tasks_executed).toBe(true);
    expect(r.no_tasks_reason).toBe('plan_parsed_zero_tasks');
  });

  it('does not flag no_tasks_executed when at least one task ran', async () => {
    const r = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(r.no_tasks_executed).toBeFalsy();
  });

  it('does not flag no_tasks_executed in non-live (suppress / pending_approval) modes', async () => {
    const EMPTY_PLAN = `# Empty

Narrative only.
`;
    fs.writeFileSync(planPath, EMPTY_PLAN);
    const r = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir, execution_mode: 'suppress' });
    expect(r.no_tasks_executed).toBeFalsy();
  });

  it('still skips [x] tasks when their referenced files exist (genuine resume)', async () => {
    const PLAN_GENUINE_RESUME = `# Fabro Y

**Tech Stack:** Node.js, vitest.

## Task 1: edit existing file

- [x] **Step 1: Implement**

Modify \`src/already-there.js\`:

\`\`\`js
// edits
\`\`\`
`;
    fs.writeFileSync(planPath, PLAN_GENUINE_RESUME);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'already-there.js'), '// existing\n');

    const r = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });

    // File exists → [x] is trusted, task skipped.
    expect(submitMock).not.toHaveBeenCalled();
    expect(r.completed_tasks).toEqual([1]);
  });

  it('executes checklist-style plans and ticks numbered checklist items', async () => {
    const CHECKLIST_PLAN = `# Marketplace Submission Plan

## Submission Steps

1. [ ] Push README
   - Verify \`README.md\` mentions plugin install
2. [ ] Submit the plugin
`;
    fs.writeFileSync(planPath, CHECKLIST_PLAN);

    const r = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0][0].task).toContain('Task 1: Submission Steps');
    expect(submitMock.mock.calls[0][0].task).toContain('Verify `README.md` mentions plugin install');
    const updated = fs.readFileSync(planPath, 'utf8');
    expect(updated).toContain('1. [x] Push README');
    expect(updated).toContain('2. [x] Submit the plugin');
    expect(r.completed_tasks).toEqual([1]);
  });

  it('refuses to submit a task whose body contains a bare dotnet test (no torque-remote)', async () => {
    // Live regression 2026-04-26: the plan-quality gate ran at PLAN time, but the
    // saved plan file was materialized at EXECUTE time without re-validation. Plans
    // that carried bare `dotnet test` (because they were generated before the gate
    // landed, or through a path that bypassed it) sailed straight into the queue
    // and got blocked by the runtime governance guard, which charged the failure
    // to whichever provider happened to be selected. The executor must catch the
    // violation BEFORE submission so the loop can pause/replan instead of burning
    // a slot on a doomed task.
    const BAD_PLAN = `# Heavy validation in body

## Task 1: validate the contract

- [ ] **Step 1: run the failing test**

Read \`tests/SpudgetBooks.Infrastructure.Tests.csproj\`. Run \`dotnet test tests/SpudgetBooks.Infrastructure.Tests/SpudgetBooks.Infrastructure.Tests.csproj --verbosity normal\` to confirm.
`;
    fs.writeFileSync(planPath, BAD_PLAN);
    const r = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });

    expect(submitMock).not.toHaveBeenCalled();
    expect(awaitMock).not.toHaveBeenCalled();
    expect(r.failed_task).toBe(1);
    expect(r.violation).toMatchObject({
      rule: 'task_avoids_local_heavy_validation',
      task_number: 1,
    });
    expect(r.violation.detected_command).toMatch(/dotnet\s+test/i);
  });

  it('submits when the same heavy command is wrapped in torque-remote', async () => {
    const GOOD_PLAN = `# Heavy validation routed remotely

## Task 1: validate the contract

- [ ] **Step 1: run the failing test**

Read \`tests/Foo.csproj\`. Run \`torque-remote dotnet test tests/Foo.csproj --verbosity normal\` to confirm.
`;
    fs.writeFileSync(planPath, GOOD_PLAN);
    await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });

    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('refuses on bare dotnet build and pwsh scripts/build.ps1 too', async () => {
    const PLAN_BUILD = `# Bare dotnet build

## Task 1: build it

- [ ] **Step 1: compile**

Run \`dotnet build src/Foo.csproj\` and verify it succeeds. Edit \`src/Foo.cs\` if needed.
`;
    fs.writeFileSync(planPath, PLAN_BUILD);
    const r1 = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(submitMock).not.toHaveBeenCalled();
    expect(r1.violation?.rule).toBe('task_avoids_local_heavy_validation');

    submitMock.mockClear();
    const PLAN_PS = `# Bare pwsh build

## Task 1: build it

- [ ] **Step 1: compile**

Run \`pwsh scripts/build.ps1\` to compile and verify. Edit \`src/Foo.ps1\` first.
`;
    fs.writeFileSync(planPath, PLAN_PS);
    const r2 = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(submitMock).not.toHaveBeenCalled();
    expect(r2.violation?.rule).toBe('task_avoids_local_heavy_validation');
  });

  it('does not block in non-live (suppress) mode — dry runs may surface bad plans for inspection', async () => {
    const BAD_PLAN = `# Heavy validation in body

## Task 1: validate

- [ ] **Step 1: run**

Run \`dotnet test foo.csproj\` to confirm. Edit \`foo.cs\`.
`;
    fs.writeFileSync(planPath, BAD_PLAN);
    const r = await exec.execute({
      plan_path: planPath,
      project: 'p',
      working_directory: dir,
      execution_mode: 'suppress',
    });
    // dry-run / suppress paths report the plan structure for inspection; the
    // runtime guard belongs to live submission, not dry-run accounting.
    expect(r.violation).toBeUndefined();
    expect(r.dry_run).toBe(true);
  });
});
