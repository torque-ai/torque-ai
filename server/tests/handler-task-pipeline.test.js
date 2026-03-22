const childProcess = require('child_process');
const schedulingAutomation = require('../db/scheduling-automation');
const eventTracking = require('../db/event-tracking');
const taskCore = require('../db/task-core');
const pipelineCrud = require('../db/pipeline-crud');
const taskMetadata = require('../db/task-metadata');
const fileTracking = require('../db/file-tracking');
const taskManager = require('../task-manager');
const handlers = require('../handlers/task/pipeline');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('handler:task-pipeline', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('handleSaveTemplate rejects missing name', () => {
    const result = handlers.handleSaveTemplate({ task_template: 'Do work' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });

  it('handleSaveTemplate persists valid template and records event', () => {
    const saveSpy = vi.spyOn(schedulingAutomation, 'saveTemplate').mockReturnValue({
      name: 'ci-template',
      description: 'CI checks',
      default_timeout: 20,
      default_priority: 2,
    });
    const eventSpy = vi.spyOn(eventTracking, 'recordEvent').mockReturnValue(undefined);

    const result = handlers.handleSaveTemplate({
      name: '  ci-template  ',
      description: 'CI checks',
      task_template: 'Run tests for {module}',
      default_timeout: 20,
      default_priority: 2,
      auto_approve: true,
    });

    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ci-template',
      task_template: 'Run tests for {module}',
      default_timeout: 20,
      default_priority: 2,
      auto_approve: true,
    }));
    expect(eventSpy).toHaveBeenCalledWith('template_saved', null, { name: '  ci-template  ' });
    expect(getText(result)).toContain('Template Saved: ci-template');
  });

  it('handleListTemplates returns empty-state when no templates exist', () => {
    vi.spyOn(schedulingAutomation, 'listTemplates').mockReturnValue([]);

    const result = handlers.handleListTemplates({});

    expect(getText(result)).toContain('No templates saved yet');
  });

  it('handleListTemplates renders a table for saved templates', () => {
    vi.spyOn(schedulingAutomation, 'listTemplates').mockReturnValue([
      {
        name: 'lint-template',
        description: 'Run lint and checks',
        usage_count: 4,
        default_timeout: 15,
      },
    ]);

    const result = handlers.handleListTemplates({});

    expect(getText(result)).toContain('| lint-template | Run lint and checks | 4 | 15m |');
  });

  it('handleUseTemplate returns TEMPLATE_NOT_FOUND for unknown template', () => {
    vi.spyOn(schedulingAutomation, 'getTemplate').mockReturnValue(null);

    const result = handlers.handleUseTemplate({ template_name: 'missing' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('handleUseTemplate rejects object variable values', () => {
    vi.spyOn(schedulingAutomation, 'getTemplate').mockReturnValue({
      name: 'x',
      task_template: 'Run {thing}',
      default_timeout: 10,
      default_priority: 0,
      auto_approve: false,
    });

    const result = handlers.handleUseTemplate({
      template_name: 'x',
      variables: { thing: { nested: true } },
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
  });

  it('handleUseTemplate reports unsubstituted placeholders', () => {
    vi.spyOn(schedulingAutomation, 'getTemplate').mockReturnValue({
      name: 'x',
      task_template: 'Run {thing} then {next}',
      default_timeout: 10,
      default_priority: 0,
      auto_approve: false,
    });

    const result = handlers.handleUseTemplate({
      template_name: 'x',
      variables: { thing: 'lint' },
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    expect(getText(result)).toContain('{next}');
  });

  it('handleUseTemplate creates and starts a task from template variables', () => {
    vi.spyOn(schedulingAutomation, 'getTemplate').mockReturnValue({
      name: 'runtime-template',
      task_template: 'Run {job} with {parallel}',
      default_timeout: 12,
      default_priority: 1,
      auto_approve: true,
    });
    const createSpy = vi.spyOn(taskCore, 'createTask').mockImplementation((task) => task);
    const usageSpy = vi.spyOn(schedulingAutomation, 'incrementTemplateUsage').mockReturnValue(undefined);
    vi.spyOn(taskManager, 'startTask').mockReturnValue({ queued: true });

    const result = handlers.handleUseTemplate({
      template_name: 'runtime-template',
      variables: { job: 'tests', parallel: 4 },
      priority: 5,
      working_directory: '/repo',
    });

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      task_description: 'Run tests with 4',
      timeout_minutes: 12,
      priority: 5,
      template_name: 'runtime-template',
    }));
    expect(usageSpy).toHaveBeenCalledWith('runtime-template');
    expect(getText(result)).toContain('queued');
  });

  it('handleGetAnalytics renders top templates and recent events', () => {
    vi.spyOn(eventTracking, 'getAnalytics').mockReturnValue({
      tasksByStatus: { running: 2, completed: 5 },
      successRate: 80,
      avgDurationMinutes: 7,
      tasksLast24h: 3,
      topTemplates: [{ name: 'ci-template', usage_count: 4 }],
      recentEvents: [{ timestamp: '2026-03-01T00:00:00.000Z', event_type: 'task_created', task_id: 'abc12345-1234-1234-1234-123456789012' }],
    });

    const result = handlers.handleGetAnalytics({ include_events: true });
    const text = getText(result);

    expect(text).toContain('TORQUE Analytics');
    expect(text).toContain('Top Templates');
    expect(text).toContain('task_created');
  });

  it('handleRetryTask rejects retry for non-failed status', () => {
    vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1', status: 'running' });

    const result = handlers.handleRetryTask({ task_id: 'task-1' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('handleRetryTask creates retry task with increased priority', () => {
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
      id: 'task-2',
      status: 'failed',
      task_description: 'Original failure',
      working_directory: '/repo',
      timeout_minutes: 20,
      auto_approve: false,
      priority: 3,
      template_name: 'template-a',
    });
    const createSpy = vi.spyOn(taskCore, 'createTask').mockImplementation((task) => task);
    vi.spyOn(eventTracking, 'recordEvent').mockReturnValue(undefined);
    vi.spyOn(taskManager, 'startTask').mockReturnValue({ queued: false });

    const result = handlers.handleRetryTask({ task_id: 'task-2', modified_task: 'Retry with fixes' });

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending',
      task_description: 'Retry with fixes',
      priority: 4,
      context: { retry_of: 'task-2' },
    }));
    expect(getText(result)).toContain('Retry task started');
  });

  it('handleCreatePipeline validates required steps', () => {
    const result = handlers.handleCreatePipeline({ name: 'build-pipeline' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });

  it('handleCreatePipeline stores ordered steps and returns run hint', () => {
    vi.spyOn(pipelineCrud, 'createPipeline').mockReturnValue({
      id: 'pipeline-1',
      name: 'build-and-test',
      description: 'CI flow',
    });
    const addStepSpy = vi.spyOn(pipelineCrud, 'addPipelineStep').mockReturnValue(undefined);
    vi.spyOn(pipelineCrud, 'getPipeline').mockReturnValue({
      id: 'pipeline-1',
      steps: [
        { step_order: 1, name: 'Build', condition: 'on_success' },
        { step_order: 2, name: 'Test', condition: 'on_success' },
      ],
    });

    const result = handlers.handleCreatePipeline({
      name: 'build-and-test',
      description: 'CI flow',
      working_directory: '/repo',
      steps: [
        { name: 'Build', task_template: 'npm run build' },
        { name: 'Test', task_template: 'npm test' },
      ],
    });

    expect(addStepSpy).toHaveBeenCalledTimes(2);
    expect(getText(result)).toContain('Pipeline Created: build-and-test');
    expect(getText(result)).toContain('Run with:');
  });

  it('handleRunPipeline returns PIPELINE_NOT_FOUND when missing', () => {
    vi.spyOn(pipelineCrud, 'getPipeline').mockReturnValue(null);

    const result = handlers.handleRunPipeline({ pipeline_id: 'missing' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('PIPELINE_NOT_FOUND');
  });

  it('handleRunPipeline marks pipeline failed if first task cannot start', () => {
    vi.spyOn(pipelineCrud, 'getPipeline').mockReturnValue({
      id: 'pipe-1',
      name: 'pipe-1',
      status: 'pending',
      working_directory: '/repo',
      steps: [{ id: 'step-1', step_order: 1, task_template: 'Run ${target}', timeout_minutes: 8 }],
    });
    vi.spyOn(eventTracking, 'recordEvent').mockReturnValue(undefined);
    vi.spyOn(taskCore, 'createTask').mockImplementation((task) => task);
    vi.spyOn(taskCore, 'getTask').mockReturnValue({ context: { pipeline_id: 'pipe-1', step_id: 'step-1' } });
    const updateStatusSpy = vi.spyOn(pipelineCrud, 'updatePipelineStatus').mockReturnValue(undefined);
    const updateStepSpy = vi.spyOn(pipelineCrud, 'updatePipelineStep').mockReturnValue(undefined);
    vi.spyOn(taskManager, 'startTask').mockImplementation(() => {
      throw new Error('scheduler offline');
    });

    const result = handlers.handleRunPipeline({ pipeline_id: 'pipe-1', variables: { target: 'src' } });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('OPERATION_FAILED');
    expect(updateStepSpy).toHaveBeenCalledWith('step-1', { status: 'failed' });
    expect(updateStatusSpy).toHaveBeenLastCalledWith('pipe-1', 'failed', expect.objectContaining({
      error: expect.stringContaining('scheduler offline'),
    }));
  });

  it('handleGetPipelineStatus renders current step and rows', () => {
    vi.spyOn(pipelineCrud, 'getPipeline').mockReturnValue({
      id: 'pipe-2',
      name: 'pipe-2',
      status: 'running',
      current_step: 1,
      started_at: '2026-03-02T10:00:00.000Z',
      completed_at: null,
      error: null,
      steps: [{ step_order: 1, name: 'Build', status: 'running', task_id: 'abcd1234-abcd-1234-abcd-123456789012' }],
    });

    const result = handlers.handleGetPipelineStatus({ pipeline_id: 'pipe-2' });

    expect(getText(result)).toContain('Pipeline: pipe-2');
    expect(getText(result)).toContain('Current Step:** 1 / 1');
    expect(getText(result)).toContain('| 1 | Build | running | abcd1234... |');
  });

  it('handleListPipelines passes status and safe-limited limit', () => {
    const listSpy = vi.spyOn(pipelineCrud, 'listPipelines').mockReturnValue([
      {
        id: 'abcd1234-abcd-1234-abcd-123456789012',
        name: 'pipe-a',
        status: 'pending',
        steps: [{}, {}],
        created_at: '2026-03-02T10:00:00.000Z',
      },
    ]);

    const result = handlers.handleListPipelines({ status: 'pending', limit: 'invalid' });

    expect(listSpy).toHaveBeenCalledWith({ status: 'pending', limit: 20 });
    expect(getText(result)).toContain('pipe-a');
  });

  it('handlePreviewDiff returns operation error when git status fails', () => {
    vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-3', working_directory: '/repo' });
    vi.spyOn(childProcess, 'spawnSync').mockReturnValueOnce({ status: 1, stderr: 'not a git repo', stdout: '' });

    const result = handlers.handlePreviewDiff({ task_id: 'task-3' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('OPERATION_FAILED');
    expect(getText(result)).toContain('Not a git repository');
  });

  it('handleCommitTask returns no-op message when no staged changes exist', () => {
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
      id: 'task-4',
      task_description: 'No-op commit',
      working_directory: '/repo',
    });

    vi.spyOn(childProcess, 'spawnSync')
      .mockReturnValueOnce({ status: 0, stdout: 'before-sha\n', stderr: '' }) // rev-parse
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // add -A
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }); // diff --staged --quiet

    const result = handlers.handleCommitTask({ task_id: 'task-4' });

    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain('No staged changes to commit');
  });

  it('handleCommitTask creates commit and updates task git state', () => {
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
      id: 'task-5',
      task_description: 'Add feature',
      working_directory: '/repo',
    });
    const updateGitSpy = vi.spyOn(taskMetadata, 'updateTaskGitState').mockReturnValue(undefined);
    const eventSpy = vi.spyOn(eventTracking, 'recordEvent').mockReturnValue(undefined);

    vi.spyOn(childProcess, 'spawnSync')
      .mockReturnValueOnce({ status: 0, stdout: 'old-sha\n', stderr: '' }) // rev-parse before
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // add -A
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' }) // diff --staged --quiet (has staged changes)
      .mockReturnValueOnce({ status: 0, stdout: '[main] commit ok\n', stderr: '' }) // commit
      .mockReturnValueOnce({ status: 0, stdout: 'new-sha\n', stderr: '' }); // rev-parse after

    const result = handlers.handleCommitTask({ task_id: 'task-5', message: 'feat: commit changes' });

    expect(updateGitSpy).toHaveBeenCalledWith('task-5', {
      before_sha: 'old-sha',
      after_sha: 'new-sha',
    });
    expect(eventSpy).toHaveBeenCalledWith('task_committed', 'task-5', { sha: 'new-sha' });
    expect(getText(result)).toContain('Commit Created');
    expect(getText(result)).toContain('feat: commit changes');
  });

  it('handleRollbackTask validates required task_id', () => {
    const result = handlers.handleRollbackTask({});

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });

  it('handleRollbackTask creates rollback record for valid task', () => {
    vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-6' });
    const rollbackSpy = vi.spyOn(fileTracking, 'createRollback').mockReturnValue('rb-123');

    const result = handlers.handleRollbackTask({ task_id: 'task-6', reason: 'bad output' });

    expect(rollbackSpy).toHaveBeenCalledWith('task-6', 'git', null, null, 'bad output', 'user');
    expect(getText(result)).toContain('Rollback ID:** rb-123');
  });

  it('handleListCommits returns empty-state when no commits exist', () => {
    vi.spyOn(taskMetadata, 'getTasksWithCommits').mockReturnValue([]);

    const result = handlers.handleListCommits({});

    expect(getText(result)).toContain('No tasks have been committed yet');
  });

  it('handleAnalyzeTask requires task_description', () => {
    const result = handlers.handleAnalyzeTask({});

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });

  it('handleAnalyzeTask recommends CODEX for unit-test focused work', () => {
    const result = handlers.handleAnalyzeTask({
      task_description: 'Write unit tests for this file and add docs comments',
    });

    const text = getText(result);
    expect(text).toContain('Recommendation: CODEX');
    expect(text).toContain('Factors Considered');
  });
});
