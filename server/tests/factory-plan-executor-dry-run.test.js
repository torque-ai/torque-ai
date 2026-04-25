'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPlanExecutor } = require('../factory/plan-executor');

const PLAN = `# Dry Run Plan

**Tech Stack:** Node.js, vitest.

## Task 1: wire executor

- [ ] **Step 1: edit executor**

\`\`\`text
Update server/factory/plan-executor.js and server/factory/loop-controller.js.
\`\`\`

## Task 2: add test

- [ ] **Step 1: cover dry run**

\`\`\`text
Create server/tests/factory-plan-executor-dry-run.test.js.
\`\`\`
`;

describe('factory plan-executor dry run', () => {
  let dir;
  let planPath;
  let submitMock;
  let awaitMock;
  let findReusableTask;
  let onDryRunTask;
  let executor;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-exec-dry-run-'));
    planPath = path.join(dir, 'plan.md');
    fs.writeFileSync(planPath, PLAN);
    submitMock = vi.fn(async () => ({ task_id: 'unexpected-submit' }));
    awaitMock = vi.fn(async () => ({ status: 'completed', verify_status: 'passed' }));
    findReusableTask = vi.fn(async () => null);
    onDryRunTask = vi.fn(async () => {});
    executor = createPlanExecutor({
      submit: submitMock,
      awaitTask: awaitMock,
      findReusableTask,
      onDryRunTask,
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('suppresses EXECUTE without task submission, await, or plan mutation', async () => {
    const before = fs.readFileSync(planPath, 'utf8');

    const result = await executor.execute({
      plan_path: planPath,
      project: 'factory-project',
      working_directory: dir,
      execution_mode: 'suppress',
    });

    expect(result).toMatchObject({
      plan_path: planPath,
      failed_task: null,
      dry_run: true,
      execution_mode: 'suppress',
      task_count: 2,
      simulated: true,
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(submitMock).not.toHaveBeenCalled();
    expect(awaitMock).not.toHaveBeenCalled();
    expect(onDryRunTask).toHaveBeenCalledTimes(2);
    expect(onDryRunTask.mock.calls[0][0]).toMatchObject({
      task: expect.objectContaining({
        task_number: 1,
        task_title: 'wire executor',
      }),
      execution_mode: 'suppress',
      simulated: true,
      prompt: expect.stringContaining('Task 1: wire executor'),
      file_paths: expect.arrayContaining([
        'server/factory/plan-executor.js',
        'server/factory/loop-controller.js',
      ]),
    });
    expect(onDryRunTask.mock.calls[1][0]).toMatchObject({
      task: expect.objectContaining({
        task_number: 2,
        task_title: 'add test',
      }),
      execution_mode: 'suppress',
      simulated: true,
      file_paths: expect.arrayContaining([
        'server/tests/factory-plan-executor-dry-run.test.js',
      ]),
    });
    expect(fs.readFileSync(planPath, 'utf8')).toBe(before);
  });

  it('reuses an already-running task for the same plan step instead of resubmitting', async () => {
    const singleTaskPlan = `# Reuse Plan

## Task 1: ship it

- [ ] **Step 1: edit**

\`\`\`text
Update src/app.js.
\`\`\`
`;
    fs.writeFileSync(planPath, singleTaskPlan);
    findReusableTask.mockResolvedValue({ task_id: 'existing-task-1', status: 'running' });

    const result = await executor.execute({
      plan_path: planPath,
      project: 'factory-project',
      working_directory: dir,
      execution_mode: 'live',
    });

    expect(result.completed_tasks).toEqual([1]);
    expect(submitMock).not.toHaveBeenCalled();
    expect(awaitMock).toHaveBeenCalledWith(expect.objectContaining({
      task_id: 'existing-task-1',
    }));
    expect(fs.readFileSync(planPath, 'utf8')).toContain('[x]');
  });

  it('skips resubmission when the step already landed in the worktree', async () => {
    const singleTaskPlan = `# Reuse Completed Plan

## Task 1: add checker

- [ ] **Step 1: add file**

\`\`\`text
Create tools/checker.js.
\`\`\`
`;
    fs.writeFileSync(planPath, singleTaskPlan);
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tools', 'checker.js'), 'module.exports = true;\n');
    findReusableTask.mockResolvedValue({ task_id: 'existing-task-2', status: 'completed' });

    const result = await executor.execute({
      plan_path: planPath,
      project: 'factory-project',
      working_directory: dir,
      execution_mode: 'live',
    });

    expect(result.completed_tasks).toEqual([1]);
    expect(submitMock).not.toHaveBeenCalled();
    expect(awaitMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(planPath, 'utf8')).toContain('[x]');
  });
});
