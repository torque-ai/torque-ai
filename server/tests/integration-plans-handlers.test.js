'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { ErrorCodes } = require('../handlers/error-codes');

const HANDLER_MODULE = '../handlers/integration/plans';
const MODULE_PATHS = [
  HANDLER_MODULE,
  '../database',
  '../task-manager',
  '../logger',
  '../handlers/shared',
];

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearLoadedModules() {
  vi.resetModules();
  for (const modulePath of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that are not loaded yet.
    }
  }
}

function createModules(options = {}) {
  const loggerChild = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...(options.loggerChild || {}),
  };
  const db = {
    createPlanProject: vi.fn((project) => ({
      id: project.id || 'plan-project-1',
      ...project,
    })),
    createTask: vi.fn(),
    addTaskToPlanProject: vi.fn(),
    listPlanProjects: vi.fn(() => []),
    getPlanProject: vi.fn(() => null),
    getPlanProjectTasks: vi.fn(() => []),
    updateTaskStatus: vi.fn(),
    updatePlanProject: vi.fn(),
    areAllPlanDependenciesComplete: vi.fn(() => false),
    hasFailedPlanDependency: vi.fn(() => false),
    ...(options.db || {}),
  };
  const taskManager = {
    processQueue: vi.fn(),
    ...(options.taskManager || {}),
  };
  const loggerModule = {
    child: vi.fn(() => loggerChild),
  };

  return { db, taskManager, loggerChild, loggerModule };
}

function loadHandlers(options = {}) {
  clearLoadedModules();

  const modules = createModules(options);
  installCjsModuleMock('../database', modules.db);
  installCjsModuleMock('../task-manager', modules.taskManager);
  installCjsModuleMock('../logger', modules.loggerModule);

  return {
    handlers: require(HANDLER_MODULE),
    mocks: modules,
  };
}

function interceptModuleLoad(overrides = {}) {
  const originalLoad = Module._load;
  return vi.spyOn(Module, '_load').mockImplementation(function mockedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(overrides, request)) {
      const value = overrides[request];
      if (value instanceof Error) {
        throw value;
      }
      return value;
    }
    return originalLoad.call(this, request, parent, isMain);
  });
}

function createAnthropicMock(payloadOrError) {
  const create = vi.fn();
  if (payloadOrError instanceof Error) {
    create.mockRejectedValue(payloadOrError);
  } else {
    create.mockResolvedValue(payloadOrError);
  }

  const Anthropic = vi.fn(function FakeAnthropic() {
    this.messages = { create };
  });

  return { create, Anthropic };
}

function createTempDir(tempDirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-integration-plans-'));
  tempDirs.push(dir);
  return dir;
}

function writePlanFile(tempDirs, filename, content) {
  const dir = createTempDir(tempDirs);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function expectStructuredError(result, errorCode, textFragment) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(errorCode);
  if (textFragment) {
    expect(getText(result)).toContain(textFragment);
  }
}

describe('integration/plans handlers', () => {
  let handlers;
  let mocks;
  let tempDirs;

  function reload(options = {}) {
    ({ handlers, mocks } = loadHandlers(options));
  }

  beforeEach(() => {
    tempDirs = [];
    reload();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    clearLoadedModules();
  });

  describe('handleImportPlan', () => {
    it('rejects file paths with traversal segments', async () => {
      const result = await handlers.handleImportPlan({
        file_path: '../secret-plan.md',
      });

      expectStructuredError(result, ErrorCodes.INVALID_PARAM.code, 'file_path contains path traversal');
      expect(result.error).toContain('INVALID_PARAM: file_path contains path traversal');
      expect(mocks.db.createPlanProject).not.toHaveBeenCalled();
    });

    it('returns a plain error when the plan file does not exist', async () => {
      const missingPath = path.join(createTempDir(tempDirs), 'missing-plan.md');

      const result = await handlers.handleImportPlan({
        file_path: missingPath,
        project_name: 'MissingPlan',
      });

      expect(result).toEqual({
        error: `Plan file not found: ${missingPath}`,
      });
    });

    it('returns a parse failure when Anthropic parsing throws', async () => {
      const planPath = writePlanFile(tempDirs, 'parse-failure.md', '# Plan\n\n- Step 1\n');
      const anthropic = createAnthropicMock(new Error('anthropic unavailable'));
      interceptModuleLoad({
        '@anthropic-ai/sdk': anthropic.Anthropic,
      });

      const result = await handlers.handleImportPlan({
        file_path: planPath,
        dry_run: true,
      });

      expect(result).toEqual({
        error: 'Failed to parse plan: anthropic unavailable',
      });
      expect(anthropic.create).toHaveBeenCalledOnce();
      expect(mocks.db.createPlanProject).not.toHaveBeenCalled();
    });

    it('returns an error when the parsed payload does not include a tasks array', async () => {
      const planPath = writePlanFile(tempDirs, 'invalid-parse.md', '# Plan\n\n- Step 1\n');
      const anthropic = createAnthropicMock({
        content: [{ text: JSON.stringify({ items: [] }) }],
      });
      interceptModuleLoad({
        '@anthropic-ai/sdk': anthropic.Anthropic,
      });

      const result = await handlers.handleImportPlan({
        file_path: planPath,
        dry_run: true,
      });

      expect(result).toEqual({
        error: 'Invalid parse result: missing tasks array',
      });
    });

    it('returns a dry-run preview using the filename fallback and filtered dependency map', async () => {
      const planPath = writePlanFile(tempDirs, 'feature-rollout.md', '# Rollout\n\n- Step 1\n- Step 2\n');
      const anthropic = createAnthropicMock({
        content: [{
          text: JSON.stringify({
            tasks: [
              { seq: 1, description: 'Bootstrap repo', depends_on: [] },
              { seq: 2, description: 'Document leftovers', depends_on: [99] },
            ],
          }),
        }],
      });
      interceptModuleLoad({
        '@anthropic-ai/sdk': anthropic.Anthropic,
      });

      const result = await handlers.handleImportPlan({
        file_path: planPath,
        dry_run: true,
      });

      expect(result).toMatchObject({
        dry_run: true,
        project_name: 'feature-rollout',
        source_file: planPath,
        task_count: 2,
        message: 'Preview complete. Run with dry_run=false to create the project.',
      });
      expect(result.tasks).toEqual([
        {
          seq: 1,
          description: 'Bootstrap repo',
          depends_on: [],
          can_start_immediately: true,
        },
        {
          seq: 2,
          description: 'Document leftovers',
          depends_on: [99],
          can_start_immediately: true,
        },
      ]);
      expect(mocks.db.createPlanProject).not.toHaveBeenCalled();
    });

    it('creates a project and tasks with queued and waiting statuses', async () => {
      const planPath = writePlanFile(tempDirs, 'import-project.md', '# Build\n\n- Step 1\n- Step 2\n');
      const anthropic = createAnthropicMock({
        content: [{
          text: JSON.stringify({
            tasks: [
              { seq: 1, description: 'Create schema', depends_on: [] },
              { seq: 2, description: 'Backfill data', depends_on: [1] },
            ],
          }),
        }],
      });
      interceptModuleLoad({
        '@anthropic-ai/sdk': anthropic.Anthropic,
      });
      vi.spyOn(crypto, 'randomUUID')
        .mockReturnValueOnce('task-1')
        .mockReturnValueOnce('task-2');
      mocks.db.createPlanProject.mockReturnValue({ id: 'plan-123' });

      const result = await handlers.handleImportPlan({
        file_path: planPath,
        project_name: 'Roadmap',
        dry_run: false,
        working_directory: 'C:\\repo',
      });

      expect(mocks.db.createPlanProject).toHaveBeenCalledWith({
        name: 'Roadmap',
        source_file: planPath,
        total_tasks: 2,
      });
      expect(mocks.db.createTask).toHaveBeenNthCalledWith(1, {
        id: 'task-1',
        task_description: 'Create schema',
        working_directory: 'C:\\repo',
        status: 'queued',
      });
      expect(mocks.db.createTask).toHaveBeenNthCalledWith(2, {
        id: 'task-2',
        task_description: 'Backfill data',
        working_directory: 'C:\\repo',
        status: 'waiting',
      });
      expect(mocks.db.addTaskToPlanProject).toHaveBeenNthCalledWith(1, 'plan-123', 'task-1', 1, []);
      expect(mocks.db.addTaskToPlanProject).toHaveBeenNthCalledWith(2, 'plan-123', 'task-2', 2, ['task-1']);
      expect(result).toEqual({
        success: true,
        project_id: 'plan-123',
        project_name: 'Roadmap',
        total_tasks: 2,
        queued: 1,
        waiting: 1,
        message: 'Project created with 2 tasks',
      });
    });

    it('defaults created tasks to process.cwd() when working_directory is omitted', async () => {
      const planPath = writePlanFile(tempDirs, 'cwd-default.md', '# Plan\n\n- Step 1\n');
      const anthropic = createAnthropicMock({
        content: [{
          text: JSON.stringify({
            tasks: [
              { seq: 1, description: 'Run in cwd', depends_on: [] },
            ],
          }),
        }],
      });
      interceptModuleLoad({
        '@anthropic-ai/sdk': anthropic.Anthropic,
      });
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('task-cwd');
      mocks.db.createPlanProject.mockReturnValue({ id: 'plan-cwd' });

      await handlers.handleImportPlan({
        file_path: planPath,
        dry_run: false,
      });

      expect(mocks.db.createTask).toHaveBeenCalledWith({
        id: 'task-cwd',
        task_description: 'Run in cwd',
        working_directory: process.cwd(),
        status: 'queued',
      });
    });

    it('wraps unexpected project creation failures as INTERNAL_ERROR', async () => {
      const planPath = writePlanFile(tempDirs, 'db-failure.md', '# Plan\n\n- Step 1\n');
      const anthropic = createAnthropicMock({
        content: [{
          text: JSON.stringify({
            tasks: [
              { seq: 1, description: 'Persist project', depends_on: [] },
            ],
          }),
        }],
      });
      interceptModuleLoad({
        '@anthropic-ai/sdk': anthropic.Anthropic,
      });
      mocks.db.createPlanProject.mockImplementation(() => {
        throw new Error('insert failed');
      });

      const result = await handlers.handleImportPlan({
        file_path: planPath,
        dry_run: false,
      });

      expectStructuredError(result, ErrorCodes.INTERNAL_ERROR.code, 'insert failed');
      expect(mocks.db.createTask).not.toHaveBeenCalled();
    });
  });

  describe('handleListPlanProjects', () => {
    it('forwards filters, applies the fallback limit, and computes progress', () => {
      mocks.db.listPlanProjects.mockReturnValue([
        { id: 'plan-1', total_tasks: 4, completed_tasks: 1, status: 'paused' },
        { id: 'plan-2', total_tasks: 0, completed_tasks: 3, status: 'paused' },
      ]);

      const result = handlers.handleListPlanProjects({
        status: 'paused',
        limit: 0,
      });

      expect(mocks.db.listPlanProjects).toHaveBeenCalledWith({
        status: 'paused',
        limit: 20,
      });
      expect(result).toEqual({
        projects: [
          { id: 'plan-1', total_tasks: 4, completed_tasks: 1, status: 'paused', progress: 25 },
          { id: 'plan-2', total_tasks: 0, completed_tasks: 3, status: 'paused', progress: 0 },
        ],
        count: 2,
      });
    });

    it('propagates database errors while listing projects', () => {
      mocks.db.listPlanProjects.mockImplementation(() => {
        throw new Error('list failed');
      });

      expect(() => handlers.handleListPlanProjects({})).toThrow('list failed');
    });
  });

  describe('handleGetPlanProject', () => {
    it('returns a plain error when the project does not exist', () => {
      const result = handlers.handleGetPlanProject({
        project_id: 'missing-plan',
      });

      expect(result).toEqual({ error: 'Project not found' });
      expect(mocks.db.getPlanProjectTasks).not.toHaveBeenCalled();
    });

    it('returns project details with zero progress and grouped known statuses only', () => {
      mocks.db.getPlanProject.mockReturnValue({
        id: 'plan-1',
        name: 'Zero Progress',
        total_tasks: 0,
        completed_tasks: 5,
      });
      mocks.db.getPlanProjectTasks.mockReturnValue([
        { task_id: 'task-running', status: 'running' },
        { task_id: 'task-queued', status: 'queued' },
        { task_id: 'task-unknown', status: 'mystery' },
      ]);

      const result = handlers.handleGetPlanProject({
        project_id: 'plan-1',
      });

      expect(result.progress).toBe(0);
      expect(result.tasks).toEqual([
        { task_id: 'task-running', status: 'running' },
        { task_id: 'task-queued', status: 'queued' },
        { task_id: 'task-unknown', status: 'mystery' },
      ]);
      expect(result.tasks_by_status).toEqual({
        running: [{ task_id: 'task-running', status: 'running' }],
        queued: [{ task_id: 'task-queued', status: 'queued' }],
        waiting: [],
        blocked: [],
        completed: [],
        failed: [],
      });
    });
  });

  describe('handlePausePlanProject', () => {
    it('returns a plain error when the project does not exist', () => {
      const result = handlers.handlePausePlanProject({
        project_id: 'missing-plan',
      });

      expect(result).toEqual({ error: 'Project not found' });
      expect(mocks.db.getPlanProjectTasks).not.toHaveBeenCalled();
    });

    it('pauses only queued and waiting tasks and marks the project paused', () => {
      mocks.db.getPlanProject.mockReturnValue({ id: 'plan-1' });
      mocks.db.getPlanProjectTasks.mockReturnValue([
        { task_id: 'task-queued', status: 'queued' },
        { task_id: 'task-waiting', status: 'waiting' },
        { task_id: 'task-running', status: 'running' },
        { task_id: 'task-completed', status: 'completed' },
      ]);

      const result = handlers.handlePausePlanProject({
        project_id: 'plan-1',
      });

      expect(mocks.db.updateTaskStatus).toHaveBeenNthCalledWith(1, 'task-queued', 'paused');
      expect(mocks.db.updateTaskStatus).toHaveBeenNthCalledWith(2, 'task-waiting', 'paused');
      expect(mocks.db.updatePlanProject).toHaveBeenCalledWith('plan-1', { status: 'paused' });
      expect(mocks.db.updateTaskStatus.mock.calls.map(([taskId]) => taskId)).not.toContain('task-running');
      expect(mocks.db.updateTaskStatus.mock.calls.map(([taskId]) => taskId)).not.toContain('task-completed');
      expect(result).toEqual({
        success: true,
        project_id: 'plan-1',
        tasks_paused: 2,
      });
    });
  });

  describe('handleResumePlanProject', () => {
    it('returns a plain error when the project does not exist', () => {
      const result = handlers.handleResumePlanProject({
        project_id: 'missing-plan',
      });

      expect(result).toEqual({ error: 'Project not found' });
      expect(mocks.db.getPlanProjectTasks).not.toHaveBeenCalled();
    });

    it('resumes paused tasks into queued, blocked, or waiting based on dependencies', () => {
      mocks.db.getPlanProject.mockReturnValue({ id: 'plan-1' });
      mocks.db.getPlanProjectTasks.mockReturnValue([
        { task_id: 'task-ready', status: 'paused' },
        { task_id: 'task-blocked', status: 'paused' },
        { task_id: 'task-waiting', status: 'paused' },
        { task_id: 'task-running', status: 'running' },
      ]);
      mocks.db.areAllPlanDependenciesComplete.mockImplementation((taskId) => taskId === 'task-ready');
      mocks.db.hasFailedPlanDependency.mockImplementation((taskId) => taskId === 'task-blocked');

      const result = handlers.handleResumePlanProject({
        project_id: 'plan-1',
      });

      expect(mocks.db.updateTaskStatus).toHaveBeenNthCalledWith(1, 'task-ready', 'queued');
      expect(mocks.db.updateTaskStatus).toHaveBeenNthCalledWith(2, 'task-blocked', 'blocked');
      expect(mocks.db.updateTaskStatus).toHaveBeenNthCalledWith(3, 'task-waiting', 'waiting');
      expect(mocks.db.updateTaskStatus.mock.calls.map(([taskId]) => taskId)).not.toContain('task-running');
      expect(mocks.db.updatePlanProject).toHaveBeenCalledWith('plan-1', { status: 'active' });
      expect(result).toEqual({
        success: true,
        project_id: 'plan-1',
        tasks_resumed: 3,
      });
    });
  });

  describe('handleRetryPlanProject', () => {
    it('returns a plain error when the project does not exist', () => {
      const result = handlers.handleRetryPlanProject({
        project_id: 'missing-plan',
      });

      expect(result).toEqual({ error: 'Project not found' });
      expect(mocks.db.getPlanProjectTasks).not.toHaveBeenCalled();
    });

    it('retries failed tasks and unblocks blocked tasks that no longer depend on failures', () => {
      mocks.db.getPlanProject.mockReturnValue({ id: 'plan-1' });
      mocks.db.getPlanProjectTasks.mockReturnValue([
        { task_id: 'task-failed-a', status: 'failed' },
        { task_id: 'task-failed-b', status: 'failed' },
        { task_id: 'task-ready', status: 'blocked' },
        { task_id: 'task-waiting', status: 'blocked' },
        { task_id: 'task-still-blocked', status: 'blocked' },
        { task_id: 'task-completed', status: 'completed' },
      ]);
      mocks.db.hasFailedPlanDependency.mockImplementation((taskId) => taskId === 'task-still-blocked');
      mocks.db.areAllPlanDependenciesComplete.mockImplementation((taskId) => taskId === 'task-ready');

      const result = handlers.handleRetryPlanProject({
        project_id: 'plan-1',
      });

      expect(mocks.db.updateTaskStatus).toHaveBeenNthCalledWith(1, 'task-failed-a', 'queued', {
        error_output: null,
        started_at: null,
        completed_at: null,
      });
      expect(mocks.db.updateTaskStatus).toHaveBeenNthCalledWith(2, 'task-failed-b', 'queued', {
        error_output: null,
        started_at: null,
        completed_at: null,
      });
      expect(mocks.db.updateTaskStatus).toHaveBeenNthCalledWith(3, 'task-ready', 'queued');
      expect(mocks.db.updateTaskStatus).toHaveBeenNthCalledWith(4, 'task-waiting', 'waiting');
      expect(mocks.db.updateTaskStatus.mock.calls.map(([taskId]) => taskId)).not.toContain('task-still-blocked');
      expect(mocks.db.updatePlanProject).toHaveBeenCalledWith('plan-1', {
        status: 'active',
        failed_tasks: 0,
      });
      expect(result).toEqual({
        success: true,
        project_id: 'plan-1',
        tasks_retried: 2,
        tasks_unblocked: 2,
      });
    });

    it('returns zero retry and unblock counts when nothing is eligible', () => {
      mocks.db.getPlanProject.mockReturnValue({ id: 'plan-2' });
      mocks.db.getPlanProjectTasks.mockReturnValue([
        { task_id: 'task-queued', status: 'queued' },
        { task_id: 'task-completed', status: 'completed' },
      ]);

      const result = handlers.handleRetryPlanProject({
        project_id: 'plan-2',
      });

      expect(mocks.db.updateTaskStatus).not.toHaveBeenCalled();
      expect(mocks.db.updatePlanProject).toHaveBeenCalledWith('plan-2', {
        status: 'active',
        failed_tasks: 0,
      });
      expect(result).toEqual({
        success: true,
        project_id: 'plan-2',
        tasks_retried: 0,
        tasks_unblocked: 0,
      });
    });
  });
});
