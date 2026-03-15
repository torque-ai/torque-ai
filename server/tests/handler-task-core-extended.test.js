const fs = require('fs');
const path = require('path');

const db = require('../database');
const taskManager = require('../task-manager');
const handlers = require('../handlers/task/core');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function mockSubmissionDefaults() {
  vi.spyOn(db, 'getConfig').mockImplementation((key) => {
    if (key === 'default_timeout') return '45';
    if (key === 'budget_check_enabled') return '1';
    return null;
  });
  vi.spyOn(db, 'getDefaultProvider').mockReturnValue('codex');
  vi.spyOn(db, 'isCodexExhausted').mockReturnValue(false);
  vi.spyOn(db, 'hasHealthyOllamaHost').mockReturnValue(true);
  vi.spyOn(db, 'estimateCost').mockReturnValue({ estimated_cost_usd: 0.5 });
  vi.spyOn(db, 'checkBudgetBeforeSubmission').mockReturnValue({ allowed: true });
  vi.spyOn(db, 'createTask').mockImplementation((task) => task);
  vi.spyOn(taskManager, 'startTask').mockReturnValue({ queued: false });
}

describe('handler:task-core (extended)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('handleSubmitTask rejects explicitly disabled providers', () => {
    mockSubmissionDefaults();
    vi.spyOn(db, 'getProvider').mockReturnValue({ enabled: false });

    const result = handlers.handleSubmitTask({ task: 'Run checks', provider: 'ollama' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('PROVIDER_ERROR');
  });

  it('handleSubmitTask blocks when no providers are available', () => {
    mockSubmissionDefaults();
    vi.spyOn(db, 'isCodexExhausted').mockReturnValue(true);
    vi.spyOn(db, 'hasHealthyOllamaHost').mockReturnValue(false);

    const result = handlers.handleSubmitTask({ task: 'Run checks', auto_route: false });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('NO_HOSTS_AVAILABLE');
  });

  it('handleSubmitTask returns budget exceeded when projected spend is disallowed', () => {
    mockSubmissionDefaults();
    vi.spyOn(db, 'checkBudgetBeforeSubmission').mockReturnValue({
      allowed: false,
      budget: 'daily',
      current: 9.5,
      limit: 10,
    });

    const result = handlers.handleSubmitTask({ task: 'Expensive task', auto_route: false });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('BUDGET_EXCEEDED');
    expect(getText(result)).toContain('$9.50/$10.00');
  });

  it('handleSubmitTask uses provider default timeout when no explicit timeout is set', () => {
    mockSubmissionDefaults();
    vi.spyOn(db, 'getDefaultProvider').mockReturnValue('ollama');
    vi.spyOn(db, 'getConfig').mockImplementation((key) => {
      if (key === 'default_timeout') return '90';
      if (key === 'budget_check_enabled') return '0';
      return null;
    });
    const createSpy = vi.spyOn(db, 'createTask');

    handlers.handleSubmitTask({ task: 'Use provider timeout', auto_route: false });

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      timeout_minutes: taskManager.PROVIDER_DEFAULT_TIMEOUTS.ollama,
      provider: 'ollama',
    }));
  });

  it('handleQueueTask respects budget gate and rejects when over budget', () => {
    mockSubmissionDefaults();
    vi.spyOn(db, 'checkBudgetBeforeSubmission').mockReturnValue({
      allowed: false,
      budget: 'weekly',
      current: 101,
      limit: 100,
    });

    const result = handlers.handleQueueTask({ task: 'Queue expensive task' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('BUDGET_EXCEEDED');
  });

  it('handleCheckStatus summary includes stalled activity markers', () => {
    vi.spyOn(db, 'listTasks').mockImplementation((query = {}) => {
      if (query.status === 'running') {
        return [{ id: 'run-1-00000000', model: 'codex', task_description: 'Running task' }];
      }
      if (query.status === 'queued') {
        return [{ id: 'queue-1-0000000', model: 'gemma3', priority: 2, task_description: 'Queued task' }];
      }
      return [{ id: 'recent-1-000000', status: 'completed', model: 'deepinfra', task_description: 'Recent task' }];
    });
    vi.spyOn(taskManager, 'getTaskProgress').mockReturnValue({ progress: 42 });
    vi.spyOn(taskManager, 'getTaskActivity').mockReturnValue({ isStalled: true, lastActivitySeconds: 75 });

    const result = handlers.handleCheckStatus({});
    const text = getText(result);

    expect(text).toContain('TORQUE Task Status');
    expect(text).toContain('STALLED');
    expect(text).toContain('[codex]');
    expect(text).toContain('[gemma3]');
  });

  it('handleGetResult shows requested model override when metadata differs', () => {
    vi.spyOn(db, 'getTask').mockReturnValue({
      id: 'task-r1',
      status: 'completed',
      model: 'codex',
      metadata: JSON.stringify({ requested_model: 'gpt-4o' }),
      exit_code: 0,
      started_at: '2026-03-02T00:00:00.000Z',
      completed_at: '2026-03-02T00:01:00.000Z',
      output: 'done',
      error_output: '',
      files_modified: [],
    });

    const result = handlers.handleGetResult({ task_id: 'task-r1' });

    expect(getText(result)).toContain('Requested Model:** gpt-4o');
    expect(getText(result)).toContain('overridden to codex');
  });

  it('handleGetResult tolerates malformed metadata JSON', () => {
    vi.spyOn(db, 'getTask').mockReturnValue({
      id: 'task-r2',
      status: 'completed',
      model: 'codex',
      metadata: '{bad-json',
      exit_code: 0,
      started_at: '2026-03-02T00:00:00.000Z',
      completed_at: '2026-03-02T00:02:00.000Z',
      output: 'ok',
      error_output: '',
      files_modified: [],
    });

    const result = handlers.handleGetResult({ task_id: 'task-r2' });

    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain('Task Result: task-r2');
  });

  it('handleWaitForTask returns timeout payload when task stays non-terminal', async () => {
    vi.useFakeTimers();
    vi.spyOn(db, 'getTask').mockReturnValue({
      id: 'task-w1',
      status: 'running',
      progress_percent: 33,
    });

    const pending = handlers.handleWaitForTask({ task_id: 'task-w1', timeout_seconds: 1 });
    await vi.advanceTimersByTimeAsync(2000);

    const result = await pending;
    expect(getText(result)).toContain('Timeout waiting for task task-w1');
    expect(getText(result)).toContain('Progress:** 33%');
  });

  it('handleWaitForTask returns TASK_NOT_FOUND when task disappears while polling', async () => {
    vi.useFakeTimers();
    const getTaskSpy = vi.spyOn(db, 'getTask');
    getTaskSpy
      .mockReturnValueOnce({ id: 'task-w2', status: 'running', progress_percent: 10 })
      .mockReturnValueOnce(null);

    const pending = handlers.handleWaitForTask({ task_id: 'task-w2', timeout_seconds: 5 });
    await vi.advanceTimersByTimeAsync(1200);

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('TASK_NOT_FOUND');
  });

  it('handleListTasks includes project tip when no results and all_projects is false', () => {
    vi.spyOn(db, 'getCurrentProject').mockReturnValue('alpha');
    vi.spyOn(db, 'listTasks').mockReturnValue([]);

    const result = handlers.handleListTasks({});

    expect(getText(result)).toContain('No tasks found in project: alpha');
    expect(getText(result)).toContain('all_projects: true');
  });

  it('handleListTasks renders host fallback and truncated model names', () => {
    vi.spyOn(db, 'getCurrentProject').mockReturnValue('alpha');
    vi.spyOn(db, 'listTasks').mockReturnValue([
      {
        id: 'task-l1-12345678',
        status: 'running',
        model: 'abcdefghijklmnop',
        ollama_host_id: 'host-verylongid',
        task_description: 'Long description for table output',
        created_at: '2026-03-02T10:00:00.000Z',
      },
    ]);
    vi.spyOn(db, 'getOllamaHost').mockReturnValue(null);

    const result = handlers.handleListTasks({});
    const text = getText(result);

    expect(text).toContain('Tasks (project: alpha)');
    expect(text).toContain('abcdefghijklmno');
    expect(text).toContain('host-veryl');
  });

  it('handleCancelTask requires task_id', () => {
    const result = handlers.handleCancelTask({});

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });

  it('handleCancelTask returns safety check for running tasks without confirm', () => {
    vi.spyOn(db, 'getTask').mockReturnValue({
      id: 'task-c1',
      status: 'running',
      created_at: '2026-03-02T10:00:00.000Z',
      project: 'alpha',
      provider: 'codex',
      description: 'Critical deployment task',
    });

    const result = handlers.handleCancelTask({ task_id: 'task-c1' });

    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain('Cancel Safety Check');
    expect(getText(result)).toContain('confirm: true');
  });

  it('handleCancelTask maps thrown cancel errors to INVALID_STATUS_TRANSITION for known tasks', () => {
    vi.spyOn(db, 'getTask').mockReturnValue({
      id: 'task-c2',
      status: 'completed',
      description: 'Already done',
    });
    vi.spyOn(taskManager, 'cancelTask').mockImplementation(() => {
      throw new Error('cannot cancel');
    });

    const result = handlers.handleCancelTask({ task_id: 'task-c2', confirm: true });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('handleConfigure rejects non-finite max_concurrent values', () => {
    const result = handlers.handleConfigure({ max_concurrent: 'NaN' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
  });

  it('handleConfigure updates values and triggers queue processing', () => {
    const setSpy = vi.spyOn(db, 'setConfig').mockReturnValue(undefined);
    vi.spyOn(db, 'getAllConfig').mockReturnValue({
      max_concurrent: 5,
      default_timeout: 60,
    });
    vi.spyOn(taskManager, 'getRunningTaskCount').mockReturnValue(2);
    const processSpy = vi.spyOn(taskManager, 'processQueue').mockReturnValue(undefined);

    const result = handlers.handleConfigure({ max_concurrent: 5, default_timeout: 60 });

    expect(setSpy).toHaveBeenCalledWith('max_concurrent', 5);
    expect(setSpy).toHaveBeenCalledWith('default_timeout', 60);
    expect(processSpy).toHaveBeenCalled();
    expect(getText(result)).toContain('Configuration updated');
  });

  it('handleGetProgress uses stream chunk fallback and clamps tail_lines upper bound', () => {
    vi.spyOn(taskManager, 'getTaskProgress').mockReturnValue({
      running: true,
      progress: 48,
      elapsedSeconds: 12,
      output: '[Streaming: waiting]',
    });
    const chunkSpy = vi.spyOn(db, 'getLatestStreamChunks').mockReturnValue([
      { chunk_data: 'line-1\n' },
      { chunk_data: 'line-2\n' },
    ]);

    const result = handlers.handleGetProgress({ task_id: 'task-p1', tail_lines: 50000 });
    const text = getText(result);

    expect(chunkSpy).toHaveBeenCalledWith('task-p1', 0, 200);
    expect(text).toContain('last 10000 lines');
    expect(text).toContain('line-1');
    expect(text).toContain('line-2');
  });

  it('handleShareContext sanitizes context_type and merges existing context map', () => {
    const workDir = '/repo';
    const sanitizedFile = path.join(workDir, '.codex-context', 'build_report.md');

    const getTaskSpy = vi.spyOn(db, 'getTask');
    getTaskSpy
      .mockReturnValueOnce({ id: 'task-s1', status: 'running', working_directory: workDir })
      .mockReturnValueOnce({
        id: 'task-s1',
        status: 'running',
        context: { existing: path.join(workDir, '.codex-context', 'existing.md') },
      });

    vi.spyOn(fs, 'lstatSync').mockReturnValue({
      isDirectory: () => true,
      isSymbolicLink: () => false,
    });
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    const updateSpy = vi.spyOn(db, 'updateTaskStatus').mockReturnValue(undefined);

    const result = handlers.handleShareContext({
      task_id: 'task-s1',
      content: 'build metadata',
      context_type: 'build/report',
    });

    expect(writeSpy).toHaveBeenCalledWith(sanitizedFile, 'build metadata');
    expect(updateSpy).toHaveBeenCalledWith('task-s1', 'running', {
      context: {
        existing: path.join(workDir, '.codex-context', 'existing.md'),
        build_report: sanitizedFile,
      },
    });
    expect(getText(result)).toContain('Context shared');
  });

  it('handleShareContext returns INVALID_PARAM when working directory does not exist', () => {
    vi.spyOn(db, 'getTask').mockReturnValue({ id: 'task-s2', working_directory: '/missing/path' });
    vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      const err = new Error('missing');
      err.code = 'ENOENT';
      throw err;
    });

    const result = handlers.handleShareContext({
      task_id: 'task-s2',
      content: 'ctx',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
    expect(getText(result)).toContain('does not exist');
  });

  it('handleSyncFiles rejects file batches larger than MAX_BATCH_SIZE', () => {
    const result = handlers.handleSyncFiles({
      task_id: 'task-sync-large',
      files: Array.from({ length: 101 }, (_, i) => `file-${i}.txt`),
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
  });

  it('handleSyncFiles push mode copies basename and reports blocked/missing paths', () => {
    vi.spyOn(db, 'getTask').mockReturnValue({ id: 'task-sync', working_directory: '/task/workdir' });
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => filePath === '/source/a.txt');
    const copySpy = vi.spyOn(fs, 'copyFileSync').mockReturnValue(undefined);

    const result = handlers.handleSyncFiles({
      task_id: 'task-sync',
      direction: 'push',
      files: ['/source/a.txt', '../secret.txt', '/source/missing.txt'],
    });

    const expectedDest = path.join(path.resolve('/task/workdir'), 'a.txt');
    expect(copySpy).toHaveBeenCalledWith('/source/a.txt', expectedDest);

    const text = getText(result);
    expect(text).toContain('Pushed: /source/a.txt');
    expect(text).toContain('Path traversal blocked: ../secret.txt');
    expect(text).toContain('Source not found: /source/missing.txt');
  });
});
