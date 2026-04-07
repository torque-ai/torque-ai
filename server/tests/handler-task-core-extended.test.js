const fs = require('fs');
const path = require('path');
const { createConfigMock } = require('./test-helpers');

const configCore = require('../db/config-core');
const costTracking = require('../db/cost-tracking');
const taskCore = require('../db/task-core');
const hostManagement = require('../db/host-management');
const projectConfigCore = require('../db/project-config-core');
const providerRoutingCore = require('../db/provider-routing-core');
const webhooksStreaming = require('../db/webhooks-streaming');
const taskManager = require('../task-manager');
const handlers = require('../handlers/task/core');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function withProject(overrides = {}) {
  return {
    project: 'test-project',
    ...overrides,
  };
}

function mockSubmissionDefaults() {
  vi.spyOn(configCore, 'getConfig').mockImplementation(createConfigMock({
    default_timeout: '45',
    budget_check_enabled: '1',
  }));
  vi.spyOn(providerRoutingCore, 'getDefaultProvider').mockReturnValue('codex');
  vi.spyOn(providerRoutingCore, 'isCodexExhausted').mockReturnValue(false);
  vi.spyOn(hostManagement, 'hasHealthyOllamaHost').mockReturnValue(true);
  vi.spyOn(costTracking, 'estimateCost').mockReturnValue({ estimated_cost_usd: 0.5 });
  vi.spyOn(costTracking, 'checkBudgetBeforeSubmission').mockReturnValue({ allowed: true });
  vi.spyOn(taskCore, 'createTask').mockImplementation((task) => task);
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
    vi.spyOn(providerRoutingCore, 'getProvider').mockReturnValue({ enabled: false });

    const result = handlers.handleSubmitTask(withProject({ task: 'Run checks', provider: 'ollama' }));

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('PROVIDER_ERROR');
  });

  it('handleSubmitTask requires project', () => {
    mockSubmissionDefaults();

    const result = handlers.handleSubmitTask({ task: 'Run checks', auto_route: false });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    expect(getText(result)).toContain('project is required');
  });

  it('handleSubmitTask blocks when no providers are available', () => {
    mockSubmissionDefaults();
    vi.spyOn(providerRoutingCore, 'isCodexExhausted').mockReturnValue(true);
    vi.spyOn(hostManagement, 'hasHealthyOllamaHost').mockReturnValue(false);

    const result = handlers.handleSubmitTask(withProject({ task: 'Run checks', auto_route: false }));

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('NO_HOSTS_AVAILABLE');
  });

  it('handleSubmitTask returns budget exceeded when projected spend is disallowed', () => {
    mockSubmissionDefaults();
    vi.spyOn(costTracking, 'checkBudgetBeforeSubmission').mockReturnValue({
      allowed: false,
      budget: 'daily',
      current: 9.5,
      limit: 10,
    });

    const result = handlers.handleSubmitTask(withProject({ task: 'Expensive task', auto_route: false }));

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('BUDGET_EXCEEDED');
    expect(getText(result)).toContain('$9.50/$10.00');
  });

  it('handleSubmitTask uses provider default timeout when no explicit timeout is set', () => {
    mockSubmissionDefaults();
    vi.spyOn(providerRoutingCore, 'getDefaultProvider').mockReturnValue('ollama');
    vi.spyOn(configCore, 'getConfig').mockImplementation(createConfigMock({
      default_timeout: '90',
      budget_check_enabled: '0',
    }));
    const createSpy = vi.spyOn(taskCore, 'createTask');

    handlers.handleSubmitTask(withProject({ task: 'Use provider timeout', auto_route: false }));

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      timeout_minutes: taskManager.PROVIDER_DEFAULT_TIMEOUTS.ollama,
      provider: null,
      model: null,
    }));
  });

  it('handleSubmitTask prefers container db for version intent enforcement', () => {
    mockSubmissionDefaults();
    const containerPath = require.resolve('../container');
    const databasePath = require.resolve('../database');
    const originalContainer = require.cache[containerPath];
    const originalDatabase = require.cache[databasePath];
    const containerDb = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => null),
        all: vi.fn(() => []),
      })),
    };
    const containerGet = vi.fn((name) => {
      if (name === 'db') return containerDb;
      throw new Error(`Unknown service: ${name}`);
    });
    const getDbInstance = vi.fn(() => {
      throw new Error('database fallback should not be used');
    });

    require.cache[containerPath] = {
      ...(originalContainer || {}),
      id: containerPath,
      filename: containerPath,
      loaded: true,
      exports: { defaultContainer: { get: containerGet } },
    };
    require.cache[databasePath] = {
      ...(originalDatabase || {}),
      id: databasePath,
      filename: databasePath,
      loaded: true,
      exports: { getDbInstance },
    };

    try {
      const result = handlers.handleSubmitTask({
        project: 'test-project',
        task: 'Use container db',
        auto_route: false,
        working_directory: 'C:/repo',
      });

      expect(result.isError).not.toBe(true);
      expect(containerGet).toHaveBeenCalledWith('db');
      expect(getDbInstance).not.toHaveBeenCalled();
    } finally {
      if (originalContainer) require.cache[containerPath] = originalContainer;
      else delete require.cache[containerPath];
      if (originalDatabase) require.cache[databasePath] = originalDatabase;
      else delete require.cache[databasePath];
    }
  });

  it('handleQueueTask respects budget gate and rejects when over budget', () => {
    mockSubmissionDefaults();
    vi.spyOn(costTracking, 'checkBudgetBeforeSubmission').mockReturnValue({
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
    vi.spyOn(taskCore, 'listTasks').mockImplementation((query = {}) => {
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
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
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
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
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
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
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
    const getTaskSpy = vi.spyOn(taskCore, 'getTask');
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
    vi.spyOn(projectConfigCore, 'getCurrentProject').mockReturnValue('alpha');
    vi.spyOn(taskCore, 'listTasks').mockReturnValue([]);

    const result = handlers.handleListTasks({});

    expect(getText(result)).toContain('No tasks found in project: alpha');
    expect(getText(result)).toContain('all_projects: true');
  });

  it('handleListTasks renders host fallback and truncated model names', () => {
    vi.spyOn(projectConfigCore, 'getCurrentProject').mockReturnValue('alpha');
    vi.spyOn(taskCore, 'listTasks').mockReturnValue([
      {
        id: 'task-l1-12345678',
        status: 'running',
        model: 'abcdefghijklmnop',
        ollama_host_id: 'host-verylongid',
        task_description: 'Long description for table output',
        created_at: '2026-03-02T10:00:00.000Z',
      },
    ]);
    vi.spyOn(hostManagement, 'getOllamaHost').mockReturnValue(null);

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
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
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
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
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
    const setSpy = vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);
    vi.spyOn(configCore, 'getAllConfig').mockReturnValue({
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
    const chunkSpy = vi.spyOn(webhooksStreaming, 'getLatestStreamChunks').mockReturnValue([
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

    const getTaskSpy = vi.spyOn(taskCore, 'getTask');
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
    const updateSpy = vi.spyOn(taskCore, 'updateTaskStatus').mockReturnValue(undefined);

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
    vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-s2', working_directory: '/missing/path' });
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
    vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-sync', working_directory: '/task/workdir' });
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
