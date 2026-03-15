'use strict';

const { setupTestDb, teardownTestDb, getText, rawDb } = require('./vitest-setup');
const taskManager = require('../task-manager');
const taskHooks = require('../policy-engine/task-hooks');
const { handleSmartSubmitTask } = require('../handlers/integration/routing');

describe('policy task lifecycle', () => {
  let db;
  let testDir;

  beforeEach(() => {
    ({ db, testDir } = setupTestDb('policy-task-lifecycle'));
    taskManager._testing.resetForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    taskManager._testing.resetForTest();
    teardownTestDb();
  });

  function getTaskCount() {
    return rawDb().prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
  }

  async function submitTask(overrides = {}) {
    vi.spyOn(taskManager, 'processQueue').mockImplementation(() => {});
    return handleSmartSubmitTask({
      task: 'Implement lifecycle policy enforcement',
      provider: 'codex',
      working_directory: testDir,
      ...overrides,
    });
  }

  it('onTaskSubmit is called when a task is submitted', async () => {
    const submitSpy = vi.spyOn(taskHooks, 'onTaskSubmit').mockReturnValue({ blocked: false });

    const result = await submitTask();

    expect(result?.isError).not.toBe(true);
    expect(submitSpy).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      working_directory: testDir,
    }));
    expect(getTaskCount()).toBe(1);
  });

  it('blocked task is rejected when enforcement is active', async () => {
    vi.spyOn(taskHooks, 'onTaskSubmit').mockReturnValue({
      blocked: true,
      reason: 'submit denied by policy',
      results: [{ policy_id: 'policy-submit-block', outcome: 'fail', mode: 'block' }],
    });

    const result = await submitTask();

    expect(result?.isError).toBe(true);
    expect(getText(result)).toContain('submit denied by policy');
    expect(getTaskCount()).toBe(0);
    expect(taskManager.processQueue).not.toHaveBeenCalled();
  });

  it('shadow mode allows all tasks through', async () => {
    vi.spyOn(taskHooks, 'onTaskSubmit').mockReturnValue({
      blocked: false,
      shadow: true,
      summary: { failed: 1, blocked: 0 },
    });

    const result = await submitTask();

    expect(result?.isError).not.toBe(true);
    expect(getTaskCount()).toBe(1);
    expect(taskManager.processQueue).toHaveBeenCalledTimes(1);
  });

  it('policy engine errors do not crash task submission', async () => {
    vi.spyOn(taskHooks, 'onTaskSubmit').mockImplementation(() => {
      throw new Error('policy hook exploded');
    });

    const result = await submitTask();

    expect(result?.isError).not.toBe(true);
    expect(getTaskCount()).toBe(1);
  });

  it('onTaskComplete is called on completion', () => {
    const completeSpy = vi.spyOn(taskHooks, 'onTaskComplete').mockReturnValue({ blocked: false });
    const task = db.createTask({
      id: 'policy-complete-task',
      task_description: 'Complete this task',
      working_directory: testDir,
      provider: 'codex',
      status: 'running',
    });

    db.updateTaskStatus(task.id, 'completed', {
      exit_code: 0,
      output: 'done',
    });

    expect(completeSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id,
      status: 'completed',
      working_directory: testDir,
    }));
  });

  it('hooks are skipped when the engine is disabled', async () => {
    const submitSpy = vi.spyOn(taskHooks, 'onTaskSubmit').mockReturnValue({
      skipped: true,
      reason: 'policy_engine_disabled',
      blocked: false,
    });

    const result = await submitTask();

    expect(result?.isError).not.toBe(true);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(getTaskCount()).toBe(1);
  });
});
