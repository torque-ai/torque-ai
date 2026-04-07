const taskCore = require('../db/task-core');
const costTracking = require('../db/cost-tracking');
const projectConfigCore = require('../db/project-config-core');
const taskMetadata = require('../db/task-metadata');
const eventTracking = require('../db/event-tracking');
const configCore = require('../db/config-core');
const taskManager = require('../task-manager');
const handlers = require('../handlers/task/project');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('handler:task-project', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('handleRecordUsage returns TASK_NOT_FOUND when task does not exist', () => {
    vi.spyOn(taskCore, 'getTask').mockReturnValue(null);

    const result = handlers.handleRecordUsage({
      task_id: 'missing-task',
      input_tokens: 10,
      output_tokens: 20,
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('TASK_NOT_FOUND');
  });

  it('handleRecordUsage records usage with default model', () => {
    vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1' });
    const recordSpy = vi.spyOn(costTracking, 'recordTokenUsage').mockReturnValue({
      model: 'codex',
      input_tokens: 1200,
      output_tokens: 340,
      total_tokens: 1540,
      estimated_cost_usd: 0.0123,
    });

    const result = handlers.handleRecordUsage({
      task_id: 'task-1',
      input_tokens: 1200,
      output_tokens: 340,
    });

    expect(recordSpy).toHaveBeenCalledWith('task-1', {
      input_tokens: 1200,
      output_tokens: 340,
      model: 'codex',
    });
    const text = getText(result);
    expect(text).toContain('Usage Recorded');
    expect(text).toContain('Total Tokens');
    expect(text).toContain('$0.0123');
  });

  it('handleGetTaskUsage returns empty-state message when no usage exists', () => {
    vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-2', task_description: 'No usage task' });
    vi.spyOn(costTracking, 'getTaskTokenUsage').mockReturnValue([]);

    const result = handlers.handleGetTaskUsage({ task_id: 'task-2' });

    expect(getText(result)).toContain('No usage data recorded for this task');
  });

  it('handleGetTaskUsage aggregates totals across usage rows', () => {
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
      id: 'task-3',
      task_description: 'Aggregate usage task description',
    });
    vi.spyOn(costTracking, 'getTaskTokenUsage').mockReturnValue([
      {
        input_tokens: 100,
        output_tokens: 50,
        estimated_cost_usd: 0.01,
        model: 'codex',
        recorded_at: '2026-03-01T10:00:00.000Z',
      },
      {
        input_tokens: 40,
        output_tokens: 10,
        estimated_cost_usd: 0.005,
        model: 'codex',
        recorded_at: '2026-03-01T11:00:00.000Z',
      },
    ]);

    const result = handlers.handleGetTaskUsage({ task_id: 'task-3' });
    const text = getText(result);

    expect(text).toContain('Totals');
    expect(text).toContain('140');
    expect(text).toContain('60');
    expect(text).toContain('200');
    expect(text).toContain('$0.0150');
  });

  it('handleCostSummary includes model and period breakdown', () => {
    vi.spyOn(projectConfigCore, 'getCurrentProject').mockReturnValue('alpha');
    vi.spyOn(costTracking, 'getTokenUsageSummary').mockReturnValue({
      total_input_tokens: 500,
      total_output_tokens: 200,
      total_tokens: 700,
      total_cost_usd: 1.25,
      task_count: 3,
      by_model: {
        codex: { input_tokens: 500, output_tokens: 200, cost_usd: 1.25 },
      },
    });
    const periodSpy = vi.spyOn(costTracking, 'getCostByPeriod').mockReturnValue([
      { period: '2026-03-01', tokens: 350, cost: 0.6 },
      { period: '2026-03-02', tokens: 350, cost: 0.65 },
    ]);

    const result = handlers.handleCostSummary({ period: 'day', limit: 5 });

    expect(periodSpy).toHaveBeenCalledWith('day', 5);
    const text = getText(result);
    expect(text).toContain('Cost Summary (Project: alpha)');
    expect(text).toContain('By Model');
    expect(text).toContain('By Day');
    expect(text).toContain('$1.2500');
  });

  it('handleEstimateCost renders estimate for provided model', () => {
    const estimateSpy = vi.spyOn(costTracking, 'estimateCost').mockReturnValue({
      model: 'deepinfra',
      estimated_input_tokens: 200,
      estimated_output_tokens: 400,
      estimated_total_tokens: 600,
      estimated_cost_usd: 0.042,
    });

    const result = handlers.handleEstimateCost({
      task_description: 'Design a migration plan',
      model: 'deepinfra',
    });

    expect(estimateSpy).toHaveBeenCalledWith('Design a migration plan', 'deepinfra');
    const text = getText(result);
    expect(text).toContain('Cost Estimate');
    expect(text).toContain('deepinfra');
    expect(text).toContain('~$0.0420');
  });

  it('handleListProjects returns empty-state when no projects exist', () => {
    vi.spyOn(taskCore, 'listKnownProjects').mockReturnValue([]);

    const result = handlers.handleListProjects({});

    expect(getText(result)).toContain('No projects found');
  });

  it('handleListProjects renders known-project registry details', () => {
    const alphaLastActive = '2026-03-02T11:00:00.000Z';
    const betaLastActive = '2026-03-01T09:30:00.000Z';

    vi.spyOn(taskCore, 'listKnownProjects').mockReturnValue([
      {
        name: 'alpha',
        task_count: 2,
        last_active: alphaLastActive,
        has_config: true,
      },
      {
        name: 'beta',
        task_count: 3,
        last_active: betaLastActive,
        has_config: false,
      },
    ]);

    const result = handlers.handleListProjects({});
    const text = getText(result);

    expect(text).toContain(`| alpha | 2 | ${new Date(alphaLastActive).toLocaleString('en-US')} | Yes |`);
    expect(text).toContain(`| beta | 3 | ${new Date(betaLastActive).toLocaleString('en-US')} | No |`);
    expect(text).toContain('Total Projects:** 2');
    expect(text).toContain('Configured Projects:** 1');
  });

  it('handleProjectStats returns error when project cannot be determined', () => {
    vi.spyOn(projectConfigCore, 'getCurrentProject').mockReturnValue(null);

    const result = handlers.handleProjectStats({});

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });

  it('handleCurrentProject shows quotas and task status counts', () => {
    vi.spyOn(projectConfigCore, 'getProjectRoot').mockReturnValue('/repo/alpha');
    vi.spyOn(projectConfigCore, 'getCurrentProject').mockReturnValue('alpha');
    vi.spyOn(projectConfigCore, 'getProjectStats').mockReturnValue({
      total_tasks: 7,
      tasks_by_status: { running: 2, completed: 5 },
      pipelines: 1,
      scheduled_tasks: 0,
      cost: { total_tokens: 9876, total_cost: 3.25 },
      top_templates: [],
      top_tags: [],
      recent_tasks: [],
    });
    vi.spyOn(projectConfigCore, 'getEffectiveProjectConfig').mockReturnValue({
      max_concurrent: 3,
      max_daily_cost: 5,
      max_daily_tokens: 20000,
      default_timeout: 30,
      default_priority: 0,
      auto_approve: false,
      enabled: true,
    });
    vi.spyOn(projectConfigCore, 'canProjectStartTask').mockReturnValue({ allowed: true });
    vi.spyOn(projectConfigCore, 'getProjectRunningCount').mockReturnValue(2);
    vi.spyOn(projectConfigCore, 'getProjectDailyUsage').mockReturnValue({ cost: 1.5, tokens: 1500 });

    const result = handlers.handleCurrentProject({ working_directory: '/repo/alpha/src' });
    const text = getText(result);

    expect(text).toContain('Current Project');
    expect(text).toContain('Can Submit Tasks:** Yes');
    expect(text).toContain('Concurrency:** 2/3');
    expect(text).toContain('Daily Cost:** $1.50/$5.00');
    expect(text).toContain('- running: 2');
  });

  it('handleConfigureProject without settings falls back to current config view', () => {
    vi.spyOn(projectConfigCore, 'getCurrentProject').mockReturnValue('alpha');
    const setSpy = vi.spyOn(projectConfigCore, 'setProjectConfig');
    vi.spyOn(projectConfigCore, 'getEffectiveProjectConfig').mockReturnValue({
      max_concurrent: 2,
      global_max_concurrent: 5,
      max_daily_cost: 10,
      max_daily_tokens: 50000,
      default_timeout: 30,
      default_priority: 0,
      auto_approve: false,
      enabled: true,
    });
    vi.spyOn(projectConfigCore, 'getProjectDailyUsage').mockReturnValue({ cost: 1.2, tokens: 450 });
    vi.spyOn(projectConfigCore, 'canProjectStartTask').mockReturnValue({ allowed: true });
    vi.spyOn(projectConfigCore, 'getProjectRunningCount').mockReturnValue(1);

    const result = handlers.handleConfigureProject({ project: 'alpha' });

    expect(setSpy).not.toHaveBeenCalled();
    expect(getText(result)).toContain('Project Configuration: alpha');
  });

  it('handleGetProjectConfig returns error when no project is resolved', () => {
    vi.spyOn(projectConfigCore, 'getCurrentProject').mockReturnValue(null);

    const result = handlers.handleGetProjectConfig({});

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });

  it('handleListProjectConfigs renders configured projects', () => {
    vi.spyOn(projectConfigCore, 'listProjectConfigs').mockReturnValue([
      {
        project: 'alpha',
        max_concurrent: 2,
        max_daily_cost: 10,
        max_daily_tokens: 20000,
        enabled: true,
      },
    ]);

    const result = handlers.handleListProjectConfigs({});

    expect(getText(result)).toContain('Project Configurations');
    expect(getText(result)).toContain('| alpha | 2 | $10.00 | 20,000 | Yes |');
  });

  it('handleCloneTask clones and starts immediately when requested', () => {
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
      id: 'orig-task',
      task_description: 'Original task description',
      working_directory: '/repo',
      timeout_minutes: 45,
      auto_approve: true,
      priority: 2,
      tags: ['a'],
      max_retries: 1,
      retry_strategy: 'linear',
      retry_delay_seconds: 10,
    });
    const createSpy = vi.spyOn(taskCore, 'createTask').mockImplementation((task) => task);
    vi.spyOn(taskManager, 'startTask').mockReturnValue({ queued: true });

    const result = handlers.handleCloneTask({ task_id: 'orig-task', start_immediately: true });

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending',
      task_description: 'Original task description',
      priority: 2,
    }));
    expect(getText(result)).toContain('Task cloned!');
    expect(getText(result)).toContain('Status:** Queued');
  });

  it('handleBulkImportTasks blocks path traversal in file_path mode', () => {
    const result = handlers.handleBulkImportTasks({ file_path: '../secrets/tasks.json' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('PATH_TRAVERSAL');
  });

  it('handleBulkImportTasks resolves $index dependencies and only auto-starts roots', () => {
    vi.spyOn(eventTracking, 'safeJsonParse').mockReturnValue([
      { task: 'root-task' },
      { task: 'child-task', depends_on: ['$0'] },
    ]);
    const createSpy = vi.spyOn(taskCore, 'createTask').mockImplementation((task) => task);
    const startSpy = vi.spyOn(taskManager, 'startTask').mockReturnValue({ queued: false });

    const result = handlers.handleBulkImportTasks({
      content: '[{"task":"root-task"},{"task":"child-task","depends_on":["$0"]}]',
      working_directory: '/repo',
      start_immediately: true,
    });

    expect(result.isError).toBeFalsy();
    expect(createSpy).toHaveBeenCalledTimes(2);
    const secondTaskPayload = createSpy.mock.calls[1][0];
    expect(secondTaskPayload.depends_on).toHaveLength(1);
    expect(typeof secondTaskPayload.depends_on[0]).toBe('string');
    expect(secondTaskPayload.depends_on[0]).not.toBe('$0');
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('handleValidateImport returns errors for invalid dependency types', () => {
    const result = handlers.handleValidateImport({
      content: JSON.stringify([{ task: 'bad deps', depends_on: [123] }]),
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
    expect(getText(result)).toContain('depends_on element must be a string');
  });

  it('handleCreateGroup applies default priority and timeout', () => {
    const createSpy = vi.spyOn(taskMetadata, 'createTaskGroup').mockImplementation((group) => group);

    const result = handlers.handleCreateGroup({
      name: 'Ops',
      project: 'alpha',
      description: 'Ops runbooks',
    });

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Ops',
      default_priority: 0,
      default_timeout: 30,
    }));
    expect(getText(result)).toContain('Task group created!');
  });

  it('handleListGroups renders group statistics table', () => {
    const listSpy = vi.spyOn(taskMetadata, 'listTaskGroups').mockReturnValue([
      {
        name: 'Ops',
        project: 'alpha',
        stats: { total: 4, running: 1, completed: 2, failed: 1 },
      },
    ]);

    const result = handlers.handleListGroups({ project: 'alpha' });

    expect(listSpy).toHaveBeenCalledWith({ project: 'alpha' });
    expect(getText(result)).toContain('| Ops | alpha | 4 | 1 | 2 | 1 |');
  });

  it('handleGroupAction retries only failed tasks', () => {
    vi.spyOn(taskMetadata, 'getTaskGroup').mockReturnValue({ id: 'g-1', name: 'Ops' });
    vi.spyOn(taskMetadata, 'getGroupTasks').mockReturnValue([
      { id: 't1', status: 'failed', task_description: 'fail 1', working_directory: '/repo', timeout_minutes: 10, auto_approve: false, priority: 0, tags: [] },
      { id: 't2', status: 'completed', task_description: 'done', working_directory: '/repo', timeout_minutes: 10, auto_approve: false, priority: 0, tags: [] },
    ]);
    const createSpy = vi.spyOn(taskCore, 'createTask').mockImplementation((task) => task);
    const startSpy = vi.spyOn(taskManager, 'startTask').mockReturnValue({ queued: false });

    const result = handlers.handleGroupAction({ group_id: 'g-1', action: 'retry_failed' });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(getText(result)).toContain('Affected tasks:** 1');
  });

  it('handleGroupAction rejects unknown actions', () => {
    vi.spyOn(taskMetadata, 'getTaskGroup').mockReturnValue({ id: 'g-2' });
    vi.spyOn(taskMetadata, 'getGroupTasks').mockReturnValue([]);

    const result = handlers.handleGroupAction({ group_id: 'g-2', action: 'archive' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
  });

  it('handleForecastCosts validates days_ahead', () => {
    const result = handlers.handleForecastCosts({ days_ahead: -1 });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
  });

  it('handleDeleteBudget returns success when budget is deleted', () => {
    vi.spyOn(costTracking, 'deleteBudget').mockReturnValue({ deleted: true });

    const result = handlers.handleDeleteBudget({ budget_id: 'budget-1' });

    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain('Budget budget-1 deleted.');
  });

  it('handleDeleteBudget returns RESOURCE_NOT_FOUND when budget is missing', () => {
    vi.spyOn(costTracking, 'deleteBudget').mockReturnValue({ deleted: false });

    const result = handlers.handleDeleteBudget({ budget_id: 'budget-missing' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
    expect(getText(result)).toContain('Budget not found: budget-missing');
  });

  it('handleSetDefaultLimits writes provided defaults and renders current values', () => {
    const setConfigSpy = vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);
    const getConfigSpy = vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
      if (key === 'default_project_max_concurrent') return '4';
      if (key === 'default_project_max_daily_cost') return '2.5';
      if (key === 'auto_create_project_config') return '0';
      return null;
    });

    const result = handlers.handleSetDefaultLimits({
      max_concurrent: 4,
      max_daily_cost: 2.5,
      auto_create_config: false,
    });

    expect(setConfigSpy).toHaveBeenCalledWith('default_project_max_concurrent', '4');
    expect(setConfigSpy).toHaveBeenCalledWith('default_project_max_daily_cost', '2.5');
    expect(setConfigSpy).toHaveBeenCalledWith('auto_create_project_config', '0');
    expect(getConfigSpy).toHaveBeenCalled();

    const text = getText(result);
    expect(text).toContain('Max Concurrent:** 4');
    expect(text).toContain('Max Daily Cost:** $2.5');
    expect(text).toContain('Auto-create Config:** No');
  });
});
