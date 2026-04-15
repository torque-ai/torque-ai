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
    submitMock = vi.fn(async ({ task }) => ({ task_id: `t_${submitMock.mock.calls.length}` }));
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
});
