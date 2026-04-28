'use strict';

// Pipeline.js captures `promisify(childProcess.execFile)` at require-time, and
// vi.mock does not work for Node built-ins in CJS mode (see worker-setup.js
// header). The reliable pattern — also used by worker-setup itself — is to
// mutate childProcess.execFile directly before pipeline.js requires the
// module. vi.hoisted runs before any require() in this file, so by the time
// pipeline.js does `const cp = require('child_process')` it sees our mock.
const { loggerMock, uuidMock, execFileMock } = vi.hoisted(() => {
   
  const childProcess = require('child_process');
  const execFileMock = vi.fn();
  childProcess.execFile = execFileMock;
  return {
    loggerMock: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    uuidMock: vi.fn(),
    execFileMock,
  };
});

vi.mock('../db/task-core', () => ({
  createTask() {},
  getTask() { return null; },
}));

vi.mock('../db/event-tracking', () => ({
  recordEvent() {},
  getAnalytics() {
    return {
      tasksByStatus: {},
      successRate: 0,
      avgDurationMinutes: 0,
      tasksLast24h: 0,
      topTemplates: [],
      recentEvents: [],
    };
  },
}));

vi.mock('../db/scheduling-automation', () => ({
  saveTemplate() { return null; },
  getTemplate() { return null; },
  listTemplates() { return []; },
  incrementTemplateUsage() {},
}));

vi.mock('../db/project-config-core', () => ({
  createPipeline() { return null; },
  addPipelineStep() {},
  getPipeline() { return null; },
  updatePipelineStatus() {},
  updatePipelineStep() {},
  listPipelines() { return []; },
}));

vi.mock('../db/task-metadata', () => ({
  updateTaskGitState() {},
  getTasksWithCommits() { return []; },
}));

vi.mock('../db/file-tracking', () => ({
  createRollback() { return 'rollback-123'; },
}));
vi.mock('../task-manager', () => ({
  startTask() { return {}; },
}));
vi.mock('../logger', () => ({
  child: vi.fn(() => loggerMock),
}));
vi.mock('uuid', () => ({
  v4: uuidMock,
}));

const taskCore = require('../db/task-core');
const eventTracking = require('../db/event-tracking');
const schedulingAutomation = require('../db/scheduling-automation');
const projectConfigCore = require('../db/project-config-core');
const taskMetadata = require('../db/task-metadata');
const fileTracking = require('../db/file-tracking');
const taskManager = require('../task-manager');
const handlers = require('../handlers/task/pipeline');
const shared = require('../handlers/shared');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function expectError(result, code, snippet) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(code);
  if (snippet) {
    expect(getText(result)).toContain(snippet);
  }
}

// Callback-style mock builders for the promisified execFile path.
// Success: cb(null, stdout, stderr); failure: cb(error) where error
// carries .stderr/.stdout/.code in the standard child_process shape.
function execFileOk({ stdout = '', stderr = '' } = {}) {
  return (_file, _args, _opts, cb) => cb(null, stdout, stderr);
}

function execFileFail({ stderr = '', stdout = '', code = 1 } = {}) {
  return (_file, _args, _opts, cb) => {
    const err = new Error(stderr || `Command failed with code ${code}`);
    err.stderr = stderr;
    err.stdout = stdout;
    err.code = code;
    cb(err);
  };
}

function queueUuids(...values) {
  const remaining = [...values];
  uuidMock.mockImplementation(() => remaining.shift() || 'ffffffff-ffff-4fff-8fff-ffffffffffff');
}

function makeTemplate(overrides = {}) {
  return {
    name: 'test-template',
    description: 'Template description',
    task_template: 'Write tests for {file}',
    default_timeout: 30,
    default_priority: 5,
    auto_approve: false,
    usage_count: 0,
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: 'task-12345678',
    status: 'failed',
    task_description: 'Investigate flaky task output and update tests',
    working_directory: 'C:/repo',
    timeout_minutes: 45,
    auto_approve: true,
    priority: 4,
    template_name: 'lint-template',
    git_after_sha: null,
    ...overrides,
  };
}

function makePipeline(overrides = {}) {
  return {
    id: 'pipeline-12345678',
    name: 'Release Pipeline',
    status: 'pending',
    current_step: 0,
    created_at: '2026-03-12T12:00:00.000Z',
    started_at: null,
    completed_at: null,
    error: null,
    working_directory: 'C:/repo',
    steps: [
      {
        id: 'step-1',
        step_order: 1,
        name: 'Build',
        task_template: 'Build {target}',
        condition: 'on_success',
        timeout_minutes: 25,
        status: 'pending',
        task_id: null,
      },
    ],
    ...overrides,
  };
}

function resetDefaults() {
  vi.spyOn(schedulingAutomation, 'saveTemplate').mockImplementation((template) => ({
    name: template.name,
    description: template.description || null,
    task_template: template.task_template,
    default_timeout: template.default_timeout ?? 30,
    default_priority: template.default_priority ?? 5,
    auto_approve: template.auto_approve ?? false,
  }));
  vi.spyOn(eventTracking, 'recordEvent').mockImplementation(() => {});
  vi.spyOn(schedulingAutomation, 'listTemplates').mockReturnValue([]);
  vi.spyOn(schedulingAutomation, 'getTemplate').mockReturnValue(null);
  vi.spyOn(taskCore, 'createTask').mockImplementation(() => {});
  vi.spyOn(schedulingAutomation, 'incrementTemplateUsage').mockImplementation(() => {});
  vi.spyOn(eventTracking, 'getAnalytics').mockReturnValue({
    tasksByStatus: {},
    successRate: 0,
    avgDurationMinutes: 0,
    tasksLast24h: 0,
    topTemplates: [],
    recentEvents: [],
  });
  vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
  vi.spyOn(projectConfigCore, 'createPipeline').mockImplementation((pipeline) => ({
    ...pipeline,
    description: pipeline.description || null,
  }));
  vi.spyOn(projectConfigCore, 'addPipelineStep').mockImplementation(() => {});
  vi.spyOn(projectConfigCore, 'getPipeline').mockReturnValue(null);
  vi.spyOn(projectConfigCore, 'updatePipelineStatus').mockImplementation(() => {});
  vi.spyOn(projectConfigCore, 'updatePipelineStep').mockImplementation(() => {});
  vi.spyOn(projectConfigCore, 'listPipelines').mockReturnValue([]);
  vi.spyOn(taskMetadata, 'updateTaskGitState').mockImplementation(() => {});
  vi.spyOn(fileTracking, 'createRollback').mockReturnValue('rollback-123');
  vi.spyOn(taskMetadata, 'getTasksWithCommits').mockReturnValue([]);
  vi.spyOn(taskManager, 'startTask').mockReturnValue({});
  // Default execFile mock: any unmocked git call fails loudly so a missing
  // mockImplementationOnce queue entry surfaces as a test failure rather
  // than a hung promise. mockReset() clears queued mockImplementationOnce
  // entries left over from prior tests (vi.clearAllMocks only clears history).
  execFileMock.mockReset();
  execFileMock.mockImplementation((_file, args, _opts, cb) => {
    cb(new Error(`Unexpected execFile call: git ${JSON.stringify(args)}`));
  });
  queueUuids('11111111-1111-4111-8111-111111111111');
}

describe('task-pipeline handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('handleSaveTemplate', () => {
    it('returns MISSING_REQUIRED_PARAM when name is missing', () => {
      const result = handlers.handleSaveTemplate({ task_template: 'Write unit tests' });

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'name must be a non-empty string');
    });

    it('returns INVALID_PARAM when default_timeout is not positive', () => {
      const result = handlers.handleSaveTemplate({
        name: 'lint-template',
        task_template: 'Lint {file}',
        default_timeout: 0,
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'default_timeout must be a positive number');
    });

    it('saves a template, trims the name, and records an event', () => {
      const saveTemplate = schedulingAutomation.saveTemplate.mockReturnValue(makeTemplate({
        name: 'lint-template',
        description: 'Checks lint output',
        default_timeout: 60,
        default_priority: 7,
      }));

      const result = handlers.handleSaveTemplate({
        name: '  lint-template  ',
        description: 'Checks lint output',
        task_template: 'Lint {file}',
        default_timeout: 60,
        default_priority: 7,
        auto_approve: true,
      });

      expect(saveTemplate).toHaveBeenCalledWith({
        name: 'lint-template',
        description: 'Checks lint output',
        task_template: 'Lint {file}',
        default_timeout: 60,
        default_priority: 7,
        auto_approve: true,
      });
      expect(eventTracking.recordEvent).toHaveBeenCalledWith('template_saved', null, { name: '  lint-template  ' });
      expect(getText(result)).toContain('## Template Saved: lint-template');
      expect(getText(result)).toContain('**Default Timeout:** 60 minutes');
      expect(getText(result)).toContain('`use_template({template_name: "lint-template"');
    });
  });

  describe('handleListTemplates', () => {
    it('returns an empty-state message when there are no templates', () => {
      const result = handlers.handleListTemplates({});

      expect(getText(result)).toContain('No templates saved yet');
    });

    it('formats saved templates into a markdown table', () => {
      schedulingAutomation.listTemplates.mockReturnValue([
        makeTemplate({ name: 'lint-template', description: 'Checks lint output', usage_count: 3, default_timeout: 45 }),
        makeTemplate({ name: 'test-template', description: null, usage_count: 1, default_timeout: 30 }),
      ]);

      const result = handlers.handleListTemplates({});

      expect(getText(result)).toContain('| Name | Description | Usage Count | Timeout |');
      expect(getText(result)).toContain('| lint-template | Checks lint output | 3 | 45m |');
      expect(getText(result)).toContain('| test-template | - | 1 | 30m |');
    });
  });

  describe('handleUseTemplate', () => {
    it('returns TEMPLATE_NOT_FOUND when the template does not exist', () => {
      const result = handlers.handleUseTemplate({ template_name: 'missing-template' });

      expectError(result, shared.ErrorCodes.TEMPLATE_NOT_FOUND.code, 'Template not found: missing-template');
    });

    it('rejects complex variable values', () => {
      schedulingAutomation.getTemplate.mockReturnValue(makeTemplate({
        name: 'lint-template',
        task_template: 'Lint {file}',
      }));

      const result = handlers.handleUseTemplate({
        template_name: 'lint-template',
        variables: { file: { nested: true } },
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'arrays and objects are not allowed');
    });

    it('reports unsubstituted placeholders', () => {
      schedulingAutomation.getTemplate.mockReturnValue(makeTemplate({
        name: 'lint-template',
        task_template: 'Lint {file} for {scope}',
      }));

      const result = handlers.handleUseTemplate({
        template_name: 'lint-template',
        variables: { file: 'app.js' },
      });

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'Template has unsubstituted variables: {scope}');
    });

    it('creates a task from the template, increments usage, and reports queued starts', () => {
      schedulingAutomation.getTemplate.mockReturnValue(makeTemplate({
        name: 'lint-template',
        task_template: 'Lint {file} for build={build} dry_run={dry_run}',
        default_timeout: 20,
        default_priority: 9,
        auto_approve: true,
      }));
      taskManager.startTask.mockReturnValue({ queued: true });

      const result = handlers.handleUseTemplate({
        template_name: 'lint-template',
        variables: {
          file: 'src/app.js',
          build: 42,
          dry_run: false,
        },
        working_directory: 'C:/workspace',
      });

      const createdTask = taskCore.createTask.mock.calls[0][0];

      expect(createdTask).toMatchObject({
        status: 'pending',
        task_description: 'Lint src/app.js for build=42 dry_run=false',
        working_directory: 'C:/workspace',
        timeout_minutes: 20,
        auto_approve: true,
        priority: 9,
        template_name: 'lint-template',
      });
      expect(createdTask.id).toEqual(expect.any(String));
      expect(schedulingAutomation.incrementTemplateUsage).toHaveBeenCalledWith('lint-template');
      expect(taskManager.startTask).toHaveBeenCalledWith(createdTask.id);
      expect(getText(result)).toContain(`Task created from template "lint-template" and queued (ID: ${createdTask.id})`);
    });
  });

  describe('handleGetAnalytics', () => {
    it('formats task statistics and top templates', () => {
      eventTracking.getAnalytics.mockReturnValue({
        tasksByStatus: { completed: 4, failed: 1 },
        successRate: 80,
        avgDurationMinutes: 17,
        tasksLast24h: 5,
        topTemplates: [
          { name: 'lint-template', usage_count: 4 },
        ],
        recentEvents: [],
      });

      const result = handlers.handleGetAnalytics({});

      expect(eventTracking.getAnalytics).toHaveBeenCalledWith({ includeEvents: undefined });
      expect(getText(result)).toContain('## TORQUE Analytics');
      expect(getText(result)).toContain('| completed | 4 |');
      expect(getText(result)).toContain('**Success Rate:** 80%');
      expect(getText(result)).toContain('- lint-template: 4 uses');
    });

    it('includes recent events when requested', () => {
      eventTracking.getAnalytics.mockReturnValue({
        tasksByStatus: { running: 2 },
        successRate: 50,
        avgDurationMinutes: 11,
        tasksLast24h: 2,
        topTemplates: [],
        recentEvents: [
          { timestamp: '2026-03-12T12:00:00.000Z', event_type: 'task_started', task_id: 'abcd1234-ffff-4fff-8fff-123456789abc' },
        ],
      });

      const result = handlers.handleGetAnalytics({ include_events: true });

      expect(eventTracking.getAnalytics).toHaveBeenCalledWith({ includeEvents: true });
      expect(getText(result)).toContain('### Recent Events');
      expect(getText(result)).toContain('task_started');
      expect(getText(result)).toContain('(abcd1234...)');
    });
  });

  describe('handleRetryTask', () => {
    it('returns INVALID_PARAM when modified_task is not a string', () => {
      const result = handlers.handleRetryTask({
        task_id: 'task-123',
        modified_task: 42,
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'modified_task must be a string');
    });

    it('returns TASK_NOT_FOUND when the source task does not exist', () => {
      const result = handlers.handleRetryTask({ task_id: 'missing-task' });

      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: missing-task');
    });

    it('rejects retries for tasks that are not failed or cancelled', () => {
      taskCore.getTask.mockReturnValue(makeTask({ status: 'running' }));

      const result = handlers.handleRetryTask({ task_id: 'task-12345678' });

      expectError(result, shared.ErrorCodes.INVALID_STATUS_TRANSITION.code, 'Current status: running');
    });

    it('creates a retry task with higher priority and queued status text', () => {
      taskCore.getTask.mockReturnValue(makeTask({
        id: 'task-abcdef01',
        status: 'failed',
        task_description: 'Original task body',
        working_directory: 'C:/repo',
        timeout_minutes: 20,
        auto_approve: false,
        priority: 6,
        template_name: 'lint-template',
      }));
      taskManager.startTask.mockReturnValue({ queued: true });

      const result = handlers.handleRetryTask({
        task_id: 'task-abcdef01',
        modified_task: 'Retry with new instructions',
      });

      const retryTask = taskCore.createTask.mock.calls[0][0];

      expect(retryTask).toMatchObject({
        status: 'pending',
        task_description: 'Retry with new instructions',
        working_directory: 'C:/repo',
        timeout_minutes: 20,
        auto_approve: false,
        priority: 7,
        template_name: 'lint-template',
        context: { retry_of: 'task-abcdef01' },
      });
      expect(retryTask.id).toEqual(expect.any(String));
      expect(eventTracking.recordEvent).toHaveBeenCalledWith('task_retried', retryTask.id, {
        original_task: 'task-abcdef01',
      });
      expect(getText(result)).toContain(`Retry task queued (ID: ${retryTask.id}). Original: task-abc...`);
    });
  });

  describe('handleCreatePipeline', () => {
    it('returns MISSING_REQUIRED_PARAM when name is missing', () => {
      const result = handlers.handleCreatePipeline({
        steps: [{ name: 'Build', task_template: 'Build app' }],
      });

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'name must be a non-empty string');
    });

    it('validates step fields', () => {
      const result = handlers.handleCreatePipeline({
        name: 'Release',
        steps: [{ task_template: 'Build app' }],
      });

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'Step 1: name is required');
    });

    it('creates a pipeline, adds steps, and reports the saved plan', () => {
      projectConfigCore.createPipeline.mockReturnValue({
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Release',
        description: 'Ship the release',
      });
      projectConfigCore.getPipeline.mockReturnValue({
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Release',
        description: 'Ship the release',
        steps: [
          { step_order: 1, name: 'Build', condition: 'on_success' },
          { step_order: 2, name: 'Verify', condition: 'always' },
        ],
      });

      const result = handlers.handleCreatePipeline({
        name: '  Release  ',
        description: 'Ship the release',
        working_directory: 'C:/repo',
        steps: [
          { name: 'Build', task_template: 'Build app' },
          { name: 'Verify', task_template: 'Run tests', condition: 'always', timeout_minutes: 90 },
        ],
      });

      const createdPipeline = projectConfigCore.createPipeline.mock.calls[0][0];

      expect(createdPipeline).toMatchObject({
        name: 'Release',
        description: 'Ship the release',
        working_directory: 'C:/repo',
      });
      expect(createdPipeline.id).toEqual(expect.any(String));
      expect(projectConfigCore.addPipelineStep).toHaveBeenNthCalledWith(1, {
        pipeline_id: createdPipeline.id,
        step_order: 1,
        name: 'Build',
        task_template: 'Build app',
        condition: 'on_success',
        timeout_minutes: 30,
      });
      expect(projectConfigCore.addPipelineStep).toHaveBeenNthCalledWith(2, {
        pipeline_id: createdPipeline.id,
        step_order: 2,
        name: 'Verify',
        task_template: 'Run tests',
        condition: 'always',
        timeout_minutes: 90,
      });
      expect(getText(result)).toContain('## Pipeline Created: Release');
      expect(getText(result)).toContain('1. **Build** (on_success)');
      expect(getText(result)).toContain('2. **Verify** (always)');
    });
  });

  describe('handleRunPipeline', () => {
    it('returns PIPELINE_NOT_FOUND when the pipeline does not exist', () => {
      const result = handlers.handleRunPipeline({ pipeline_id: 'missing-pipeline' });

      expectError(result, shared.ErrorCodes.PIPELINE_NOT_FOUND.code, 'Pipeline not found: missing-pipeline');
    });

    it('rejects pipelines that are not pending', () => {
      projectConfigCore.getPipeline.mockReturnValue(makePipeline({ status: 'completed' }));

      const result = handlers.handleRunPipeline({ pipeline_id: 'pipeline-12345678' });

      expectError(result, shared.ErrorCodes.INVALID_STATUS_TRANSITION.code, "Only 'pending' pipelines can be started");
    });

    it('starts the first step, substitutes variables, and marks queued tasks', () => {
      const pipeline = makePipeline({
        id: 'pipeline-12345678',
        name: 'Release',
        working_directory: 'C:/repo',
        steps: [
          {
            id: 'step-1',
            step_order: 1,
            name: 'Build',
            task_template: 'Build {target}',
            condition: 'on_success',
            timeout_minutes: 25,
            status: 'pending',
            task_id: null,
          },
        ],
      });
      let storedTask = null;
      projectConfigCore.getPipeline.mockReturnValue(pipeline);
      taskCore.createTask.mockImplementation((task) => {
        storedTask = task;
      });
      taskCore.getTask.mockImplementation((taskId) => (
        storedTask && storedTask.id === taskId
          ? { ...storedTask }
          : null
      ));
      taskManager.startTask.mockReturnValue({ queued: true });

      const result = handlers.handleRunPipeline({
        pipeline_id: 'pipeline-12345678',
        variables: { target: 'prod' },
      });

      expect(projectConfigCore.updatePipelineStatus).toHaveBeenNthCalledWith(1, 'pipeline-12345678', 'running');
      expect(eventTracking.recordEvent).toHaveBeenCalledWith('pipeline_started', 'pipeline-12345678', { name: 'Release' });
      const createdTask = taskCore.createTask.mock.calls[0][0];

      expect(createdTask).toMatchObject({
        status: 'pending',
        task_description: 'Build prod',
        working_directory: 'C:/repo',
        timeout_minutes: 25,
        context: { pipeline_id: 'pipeline-12345678', step_id: 'step-1' },
      });
      expect(createdTask.id).toEqual(expect.any(String));
      expect(projectConfigCore.updatePipelineStatus).toHaveBeenNthCalledWith(2, 'pipeline-12345678', 'running', { current_step: 1 });
      expect(projectConfigCore.updatePipelineStep).toHaveBeenCalledWith('step-1', {
        task_id: createdTask.id,
        status: 'queued',
      });
      expect(getText(result)).toContain('Pipeline "Release" started.');
    });

    it('marks the pipeline failed when starting the first task throws', () => {
      queueUuids('66666666-6666-4666-8666-666666666666');
      projectConfigCore.getPipeline.mockReturnValue(makePipeline({
        id: 'pipeline-12345678',
        steps: [
          {
            id: 'step-1',
            step_order: 1,
            name: 'Build',
            task_template: 'Build app',
            timeout_minutes: 25,
            status: 'pending',
            task_id: null,
          },
        ],
      }));
      taskCore.getTask.mockReturnValue({
        context: { pipeline_id: 'pipeline-12345678', step_id: 'step-1' },
      });
      taskManager.startTask.mockImplementation(() => {
        throw new Error('queue offline');
      });

      const result = handlers.handleRunPipeline({ pipeline_id: 'pipeline-12345678' });

      expect(projectConfigCore.updatePipelineStatus).toHaveBeenCalledWith('pipeline-12345678', 'failed', {
        error: 'Failed to start first step: queue offline',
      });
      expect(projectConfigCore.updatePipelineStep).toHaveBeenCalledWith('step-1', { status: 'failed' });
      expectError(result, shared.ErrorCodes.OPERATION_FAILED.code, 'Pipeline start failed: queue offline');
    });
  });

  describe('handleGetPipelineStatus', () => {
    it('returns PIPELINE_NOT_FOUND when the pipeline is missing', () => {
      const result = handlers.handleGetPipelineStatus({ pipeline_id: 'missing-pipeline' });

      expectError(result, shared.ErrorCodes.PIPELINE_NOT_FOUND.code, 'Pipeline not found: missing-pipeline');
    });

    it('formats the pipeline summary and step table', () => {
      projectConfigCore.getPipeline.mockReturnValue(makePipeline({
        id: 'pipeline-12345678',
        name: 'Release',
        status: 'failed',
        current_step: 1,
        started_at: '2026-03-12T12:00:00.000Z',
        completed_at: '2026-03-12T12:30:00.000Z',
        error: 'Tests failed',
        steps: [
          { step_order: 1, name: 'Build', status: 'completed', task_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
          { step_order: 2, name: 'Verify', status: 'failed', task_id: null },
        ],
      }));

      const result = handlers.handleGetPipelineStatus({ pipeline_id: 'pipeline-12345678' });

      expect(getText(result)).toContain('## Pipeline: Release');
      expect(getText(result)).toContain('**Status:** failed');
      expect(getText(result)).toContain('**Current Step:** 1 / 2');
      expect(getText(result)).toContain('**Started:**');
      expect(getText(result)).toContain('**Completed:**');
      expect(getText(result)).toContain('**Error:** Tests failed');
      expect(getText(result)).toContain('| 1 | Build | completed | aaaaaaaa... |');
      expect(getText(result)).toContain('| 2 | Verify | failed | - |');
    });
  });

  describe('handleListPipelines', () => {
    it('returns an empty-state message when no pipelines exist', () => {
      const result = handlers.handleListPipelines({});

      expect(projectConfigCore.listPipelines).toHaveBeenCalledWith({ status: undefined, limit: 20 });
      expect(getText(result)).toContain('No pipelines found');
    });

    it('formats pipelines and sanitizes the requested limit', () => {
      projectConfigCore.listPipelines.mockReturnValue([
        makePipeline({
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          name: 'Release',
          status: 'running',
          created_at: '2026-03-12T12:00:00.000Z',
          steps: [{}, {}],
        }),
      ]);

      const result = handlers.handleListPipelines({ status: 'running', limit: 0 });

      expect(projectConfigCore.listPipelines).toHaveBeenCalledWith({ status: 'running', limit: 20 });
      expect(getText(result)).toContain('## Pipelines');
      expect(getText(result)).toContain('| aaaaaaaa... | Release | running | 2 |');
    });
  });

  describe('handlePreviewDiff', () => {
    it('returns TASK_NOT_FOUND when the task does not exist', async () => {
      const result = await handlers.handlePreviewDiff({ task_id: 'missing-task' });

      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: missing-task');
    });

    it('returns OPERATION_FAILED when git status fails', async () => {
      taskCore.getTask.mockReturnValue(makeTask({ id: 'task-12345678', working_directory: 'C:/repo' }));
      execFileMock.mockImplementationOnce(execFileFail({ stderr: 'not a git repository' }));

      const result = await handlers.handlePreviewDiff({ task_id: 'task-12345678' });

      expectError(result, shared.ErrorCodes.OPERATION_FAILED.code, 'Not a git repository or git error: not a git repository');
    });

    it('shows committed changes when there are no working tree diffs', async () => {
      taskCore.getTask.mockReturnValue(makeTask({
        id: 'task-12345678',
        working_directory: 'C:/repo',
        git_after_sha: 'deadbeef1234567890',
      }));
      execFileMock
        .mockImplementationOnce(execFileOk({ stdout: '' }))
        .mockImplementationOnce(execFileOk({ stdout: '' }))
        .mockImplementationOnce(execFileOk({ stdout: '' }))
        .mockImplementationOnce(execFileOk({ stdout: 'commit summary' }));

      const result = await handlers.handlePreviewDiff({ task_id: 'task-12345678' });

      expect(execFileMock).toHaveBeenNthCalledWith(4, 'git', ['show', '--stat', 'deadbeef1234567890'], expect.objectContaining({
        cwd: 'C:/repo',
        encoding: 'utf8',
      }), expect.any(Function));
      expect(getText(result)).toContain('No uncommitted changes found.');
      expect(getText(result)).toContain('### Committed Changes');
      expect(getText(result)).toContain('commit summary');
    });

    it('shows staged and unstaged diffs when present', async () => {
      taskCore.getTask.mockReturnValue(makeTask({
        id: 'task-12345678',
        working_directory: 'C:/repo',
      }));
      execFileMock
        .mockImplementationOnce(execFileOk({ stdout: 'M src/app.js\n' }))
        .mockImplementationOnce(execFileOk({ stdout: 'diff --git a/src/app.js b/src/app.js\n-foo\n+bar\n' }))
        .mockImplementationOnce(execFileOk({ stdout: 'diff --git a/package.json b/package.json\n-old\n+new\n' }));

      const result = await handlers.handlePreviewDiff({ task_id: 'task-12345678' });

      expect(getText(result)).toContain('### Staged Changes');
      expect(getText(result)).toContain('package.json');
      expect(getText(result)).toContain('### Unstaged Changes');
      expect(getText(result)).toContain('src/app.js');
    });
  });

  describe('handleCommitTask', () => {
    it('returns TASK_NOT_FOUND when the task does not exist', async () => {
      const result = await handlers.handleCommitTask({ task_id: 'missing-task' });

      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: missing-task');
    });

    it('returns OPERATION_FAILED when staging changes fails', async () => {
      taskCore.getTask.mockReturnValue(makeTask({
        id: 'task-12345678',
        working_directory: 'C:/repo',
      }));
      execFileMock
        .mockImplementationOnce(execFileOk({ stdout: 'before-sha\n' }))
        .mockImplementationOnce(execFileFail({ stderr: 'permission denied' }));

      const result = await handlers.handleCommitTask({ task_id: 'task-12345678' });

      expectError(result, shared.ErrorCodes.OPERATION_FAILED.code, 'Failed to stage changes: permission denied');
    });

    it('returns a no-op response when there is nothing staged to commit', async () => {
      taskCore.getTask.mockReturnValue(makeTask({
        id: 'task-12345678',
        working_directory: 'C:/repo',
      }));
      execFileMock
        .mockImplementationOnce(execFileOk({ stdout: 'before-sha\n' }))
        .mockImplementationOnce(execFileOk({ stdout: '' }))
        .mockImplementationOnce(execFileOk({ stdout: '' }));

      const result = await handlers.handleCommitTask({ task_id: 'task-12345678' });

      expect(getText(result)).toContain('No staged changes to commit.');
      expect(taskMetadata.updateTaskGitState).not.toHaveBeenCalled();
    });

    it('commits staged changes, updates git state, and records an event', async () => {
      taskCore.getTask.mockReturnValue(makeTask({
        id: 'task-12345678',
        task_description: 'Generate pipeline coverage for task handlers',
        working_directory: 'C:/repo',
      }));
      execFileMock
        .mockImplementationOnce(execFileOk({ stdout: 'before-sha\n' }))
        .mockImplementationOnce(execFileOk({ stdout: '' }))
        .mockImplementationOnce(execFileFail({ code: 1 }))
        .mockImplementationOnce(execFileOk({ stdout: '[main abc1234] Add tests\n' }))
        .mockImplementationOnce(execFileOk({ stdout: 'after-sha\n' }));

      const result = await handlers.handleCommitTask({
        task_id: 'task-12345678',
        message: 'Add pipeline handler coverage',
      });

      expect(execFileMock).toHaveBeenNthCalledWith(4, 'git', ['commit', '-m', 'Add pipeline handler coverage'], expect.objectContaining({
        cwd: 'C:/repo',
        encoding: 'utf8',
      }), expect.any(Function));
      expect(taskMetadata.updateTaskGitState).toHaveBeenCalledWith('task-12345678', {
        before_sha: 'before-sha',
        after_sha: 'after-sha',
      });
      expect(eventTracking.recordEvent).toHaveBeenCalledWith('task_committed', 'task-12345678', { sha: 'after-sha' });
      expect(getText(result)).toContain('## Commit Created');
      expect(getText(result)).toContain('**SHA:** after-sha');
      expect(getText(result)).toContain('**Message:** Add pipeline handler coverage');
    });
  });

  describe('handleRollbackTask', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleRollbackTask({});

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'task_id is required');
    });

    it('creates a rollback record and reports the default reason', () => {
      taskCore.getTask.mockReturnValue(makeTask({ id: 'task-12345678' }));
      fileTracking.createRollback.mockReturnValue('rollback-456');

      const result = handlers.handleRollbackTask({ task_id: 'task-12345678' });

      expect(fileTracking.createRollback).toHaveBeenCalledWith(
        'task-12345678',
        'git',
        null,
        null,
        'User requested rollback',
        'user'
      );
      expect(getText(result)).toContain('## Rollback Initiated');
      expect(getText(result)).toContain('**Rollback ID:** rollback-456');
      expect(getText(result)).toContain('**Reason:** User requested');
    });
  });

  describe('handleListCommits', () => {
    it('returns an empty-state message when no committed tasks exist', () => {
      const result = handlers.handleListCommits({});

      expect(taskMetadata.getTasksWithCommits).toHaveBeenCalledWith({
        working_directory: undefined,
        limit: 10,
      });
      expect(getText(result)).toContain('No tasks have been committed yet');
    });

    it('formats committed task rows and forwards filters', () => {
      taskMetadata.getTasksWithCommits.mockReturnValue([
        {
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          git_after_sha: '1234567890abcdef',
          task_description: 'Prepare release notes and validate routing telemetry',
          completed_at: '2026-03-12T12:30:00.000Z',
        },
      ]);

      const result = handlers.handleListCommits({
        working_directory: 'C:/repo',
        limit: 3,
      });

      expect(taskMetadata.getTasksWithCommits).toHaveBeenCalledWith({
        working_directory: 'C:/repo',
        limit: 3,
      });
      expect(getText(result)).toContain('## Committed Tasks');
      expect(getText(result)).toContain('| aaaaaaaa... | 1234567 | Prepare release notes and vali... |');
      expect(getText(result)).toContain('Rollback with: `rollback_task({project_root: "...", task_id: "..."})`');
    });
  });

  describe('handleAnalyzeTask', () => {
    it('returns MISSING_REQUIRED_PARAM when task_description is missing', () => {
      const result = handlers.handleAnalyzeTask({});

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'task_description is required');
    });

    it('recommends Codex for focused unit test work', () => {
      const result = handlers.handleAnalyzeTask({
        task_description: 'Write unit tests for this file and rename a helper in a single file.',
      });

      expect(getText(result)).toContain('### Recommendation: CODEX');
      expect(getText(result)).toContain('**Confidence:** high');
      expect(getText(result)).toContain('| Unit test writing | codex | +3 |');
      expect(getText(result)).toContain('**To delegate:** `submit_task({task: "..."})`');
    });

    it('recommends Claude for architecture and security work, and falls back on ties', () => {
      const claudeResult = handlers.handleAnalyzeTask({
        task_description: 'Design an authentication architecture across multiple files and compare security approaches.',
      });
      const tieResult = handlers.handleAnalyzeTask({
        task_description: 'Update the wording in a status message.',
      });

      expect(getText(claudeResult)).toContain('### Recommendation: CLAUDE');
      expect(getText(claudeResult)).toContain('| Architectural decision | claude | +3 |');
      expect(getText(claudeResult)).toContain('| Security-sensitive | claude | +3 |');
      expect(getText(tieResult)).toContain('| No strong indicators found | - | 0 |');
      expect(getText(tieResult)).toContain('### Recommendation: CLAUDE');
    });
  });
});
