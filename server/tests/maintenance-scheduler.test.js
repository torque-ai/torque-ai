'use strict';

const path = require('path');

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

describe('maintenance/scheduler cron task execution', () => {
  let scheduler;
  let db;
  let debugLog;
  let logger;
  let timerRegistry;
  let taskManagerMock;
  let toolsMock;
  let workflowHandlerMock;
  let webhookHandlersMock;
  let uuidMock;

  function buildDb(overrides = {}) {
    return {
      getDueMaintenanceTasks: vi.fn(() => []),
      markMaintenanceRun: vi.fn(),
      getDbPath: vi.fn(() => path.join(process.cwd(), 'torque.db')),
      archiveOldTasks: vi.fn(() => 0),
      checkBudgetAlerts: vi.fn(() => []),
      getDueScheduledTasks: vi.fn(() => []),
      createTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      acquireLock: vi.fn(() => ({ acquired: true })),
      releaseLock: vi.fn(() => ({ released: true })),
      markScheduledTaskRun: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();

    taskManagerMock = {
      startTask: vi.fn(),
    };
    toolsMock = {
      handleToolCall: vi.fn(),
    };
    workflowHandlerMock = {
      handleCloneWorkflow: vi.fn(),
      handleRunWorkflow: vi.fn(),
    };
    webhookHandlersMock = {
      sendWebhook: vi.fn(),
      triggerWebhooks: vi.fn(),
    };
    uuidMock = {
      v4: vi.fn(),
    };

    installCjsModuleMock('../task-manager', taskManagerMock);
    installCjsModuleMock('../tools', toolsMock);
    installCjsModuleMock('../handlers/workflow/index', workflowHandlerMock);
    installCjsModuleMock('../handlers/webhook-handlers', webhookHandlersMock);
    installCjsModuleMock('uuid', uuidMock);
    delete require.cache[require.resolve('../execution/schedule-runner')];

    scheduler = loadFresh('../maintenance/scheduler');

    debugLog = vi.fn();
    logger = {
      error: vi.fn(),
    };
    timerRegistry = {
      trackInterval: vi.fn((handle) => handle),
      remove: vi.fn(),
    };
    db = buildDb();
  });

  afterEach(() => {
    scheduler.stopAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function initScheduler(customDb = db) {
    scheduler.init({
      db: customDb,
      serverConfig: {
        get: vi.fn(),
        getInt: vi.fn((_, fallback) => fallback),
      },
      debugLog,
      timerRegistry,
      logger,
      getAgentRegistry: () => null,
    });
  }

  it('creates and starts due scheduled cron tasks using top-level schedule fallbacks', async () => {
    uuidMock.v4.mockReturnValue('scheduled-task-1');

    db = buildDb({
      getDueScheduledTasks: vi.fn(() => [{
        id: 'schedule-1',
        name: 'Nightly sync',
        task_description: 'Sync the repo',
        working_directory: 'C:\\repo',
        timeout_minutes: 45,
        auto_approve: 1,
        task_config: {},
      }]),
    });

    initScheduler(db);
    scheduler.startMaintenanceScheduler();

    await vi.advanceTimersByTimeAsync(60000);

    expect(db.createTask).toHaveBeenCalledTimes(1);
    expect(db.createTask).toHaveBeenCalledWith({
      id: 'scheduled-task-1',
      task_description: 'Sync the repo',
      working_directory: 'C:\\repo',
      project: null,
      provider: null,
      model: null,
      tags: null,
      timeout_minutes: 45,
      auto_approve: false,
      priority: 0,
      metadata: {
        scheduled_by: 'schedule-1',
        schedule_name: 'Nightly sync',
        schedule_type: 'cron',
        scheduled: true,
      },
    });
    expect(db.markScheduledTaskRun).toHaveBeenCalledWith('schedule-1');
    expect(taskManagerMock.startTask).toHaveBeenCalledWith('scheduled-task-1');
    expect(db.markScheduledTaskRun.mock.invocationCallOrder[0])
      .toBeLessThan(taskManagerMock.startTask.mock.invocationCallOrder[0]);
    expect(debugLog).toHaveBeenCalledWith('Executed scheduled task "Nightly sync" -> task scheduled-task-1');
  });

  it('logs and continues when one scheduled cron task fails to start', async () => {
    uuidMock.v4
      .mockReturnValueOnce('scheduled-task-1')
      .mockReturnValueOnce('scheduled-task-2');

    taskManagerMock.startTask
      .mockImplementationOnce(() => {
        throw new Error('spawn failed');
      })
      .mockImplementationOnce(() => {});

    db = buildDb({
      getDueScheduledTasks: vi.fn(() => [
        {
          id: 'schedule-1',
          name: 'Broken schedule',
          task_description: 'Fails first',
          timeout_minutes: 15,
          auto_approve: 0,
          task_config: {},
        },
        {
          id: 'schedule-2',
          name: 'Healthy schedule',
          task_description: 'Runs second',
          timeout_minutes: 30,
          auto_approve: 0,
          task_config: {},
        },
      ]),
    });

    initScheduler(db);
    scheduler.startMaintenanceScheduler();

    await vi.advanceTimersByTimeAsync(60000);

    expect(db.createTask).toHaveBeenCalledTimes(2);
    expect(db.markScheduledTaskRun).toHaveBeenNthCalledWith(1, 'schedule-1');
    expect(db.markScheduledTaskRun).toHaveBeenNthCalledWith(2, 'schedule-2');
    expect(taskManagerMock.startTask).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('Scheduled task execution failed: spawn failed');
    expect(debugLog).toHaveBeenCalledWith('Failed to execute scheduled task "Broken schedule": spawn failed');
    expect(debugLog).toHaveBeenCalledWith('Executed scheduled task "Healthy schedule" -> task scheduled-task-2');
  });

  it('creates a tracked task for scheduled tools and completes it when the tool succeeds', async () => {
    uuidMock.v4.mockReturnValue('scheduled-tool-task-1');
    db = buildDb({
      markScheduledTaskRun: vi.fn(() => ({ last_run_record_id: 'scheduled-run-1' })),
      getDueScheduledTasks: vi.fn(() => [{
        id: 'schedule-tool-1',
        name: 'Study refresh',
        task_description: 'Refresh architecture study',
        working_directory: 'C:\\repo',
        timeout_minutes: 30,
        task_config: {
          task: 'Run the codebase study loop for C:\\repo',
          tool_name: 'run_codebase_study',
          tool_args: {
            working_directory: 'C:\\repo',
          },
        },
      }]),
    });
    toolsMock.handleToolCall.mockResolvedValue({
      content: [{ type: 'text', text: 'Study run completed' }],
      structuredData: {
        files_modified: [
          'docs/architecture/module-index.json',
          'docs/architecture/knowledge-pack.json',
          'docs/architecture/study-delta.json',
          'docs/architecture/study-evaluation.json',
          'docs/architecture/SUMMARY.md',
          'docs/architecture/study-state.json',
        ],
      },
    });

    initScheduler(db);
    scheduler.startMaintenanceScheduler();

    await vi.advanceTimersByTimeAsync(60000);
    await Promise.resolve();

    expect(db.createTask).toHaveBeenCalledWith({
      id: 'scheduled-tool-task-1',
      status: 'pending',
      task_description: 'Run the codebase study loop for C:\\repo',
      working_directory: 'C:\\repo',
      provider: 'tool',
      model: null,
      tags: ['scheduled-tool'],
      timeout_minutes: 30,
      auto_approve: true,
      priority: 0,
      metadata: {
        scheduled_by: 'schedule-tool-1',
        schedule_name: 'Study refresh',
        schedule_type: 'cron',
        scheduled: true,
        execution_type: 'tool',
        scheduled_tool_name: 'run_codebase_study',
      },
    });
    expect(db.updateTaskStatus).toHaveBeenNthCalledWith(1, 'scheduled-tool-task-1', 'running', {
      progress_percent: 0,
    });
    expect(toolsMock.handleToolCall).toHaveBeenCalledWith('run_codebase_study', {
      working_directory: 'C:\\repo',
      __scheduledScheduleId: 'schedule-tool-1',
      __scheduledScheduleName: 'Study refresh',
      __scheduledRunId: 'scheduled-run-1',
      __scheduledTaskId: 'scheduled-tool-task-1',
    });
    expect(db.updateTaskStatus).toHaveBeenNthCalledWith(2, 'scheduled-tool-task-1', 'completed', {
      output: 'Study run completed',
      exit_code: 0,
      progress_percent: 100,
      files_modified: [
        'docs/architecture/module-index.json',
        'docs/architecture/knowledge-pack.json',
        'docs/architecture/study-delta.json',
        'docs/architecture/study-evaluation.json',
        'docs/architecture/SUMMARY.md',
        'docs/architecture/study-state.json',
      ],
    });
    expect(debugLog).toHaveBeenCalledWith('Executed scheduled tool "Study refresh" -> task scheduled-tool-task-1 (tool run_codebase_study)');
  });

  it('marks tracked scheduled tool tasks failed when the tool throws', async () => {
    uuidMock.v4.mockReturnValue('scheduled-tool-task-2');
    toolsMock.handleToolCall.mockRejectedValue(new Error('tool exploded'));

    db = buildDb({
      getDueScheduledTasks: vi.fn(() => [{
        id: 'schedule-tool-2',
        name: 'Broken tool',
        task_description: 'Run a broken tool',
        working_directory: 'C:\\repo',
        timeout_minutes: 30,
        task_config: {
          tool_name: 'run_codebase_study',
          tool_args: {
            working_directory: 'C:\\repo',
          },
        },
      }]),
    });

    initScheduler(db);
    scheduler.startMaintenanceScheduler();

    await vi.advanceTimersByTimeAsync(60000);
    await Promise.resolve();

    expect(db.updateTaskStatus).toHaveBeenNthCalledWith(1, 'scheduled-tool-task-2', 'running', {
      progress_percent: 0,
    });
    expect(db.updateTaskStatus).toHaveBeenNthCalledWith(2, 'scheduled-tool-task-2', 'failed', {
      error_output: 'tool exploded',
      exit_code: 1,
      progress_percent: 100,
    });
    expect(debugLog).toHaveBeenCalledWith('Failed scheduled tool "Broken tool": tool exploded');
  });

  it('passes the manual-run flag to scheduled tools for Run Now executions', async () => {
    uuidMock.v4.mockReturnValue('scheduled-tool-task-3');
    db = buildDb({
      markScheduledTaskRun: vi.fn(() => ({ last_run_record_id: 'scheduled-run-3' })),
    });
    toolsMock.handleToolCall.mockResolvedValue({
      content: [{ type: 'text', text: 'Manual study run completed' }],
      structuredData: {
        files_modified: [
          'docs/architecture/module-index.json',
          'docs/architecture/knowledge-pack.json',
          'docs/architecture/study-delta.json',
          'docs/architecture/study-evaluation.json',
          'docs/architecture/SUMMARY.md',
          'docs/architecture/study-state.json',
        ],
      },
    });

    const { executeScheduledTask } = loadFresh('../execution/schedule-runner');
    const schedule = {
      id: 'schedule-tool-3',
      name: 'Manual study refresh',
      task_description: 'Refresh architecture study now',
      working_directory: 'C:\\repo',
      timeout_minutes: 30,
      task_config: {
        tool_name: 'run_codebase_study',
        tool_args: {
          working_directory: 'C:\\repo',
        },
      },
    };

    executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
      manualRunNow: true,
    });
    await Promise.resolve();

    expect(toolsMock.handleToolCall).toHaveBeenCalledWith('run_codebase_study', {
      working_directory: 'C:\\repo',
      __scheduledScheduleId: 'schedule-tool-3',
      __scheduledScheduleName: 'Manual study refresh',
      __scheduledRunId: 'scheduled-run-3',
      __scheduledTaskId: 'scheduled-tool-task-3',
      __manualRunNow: true,
    });
  });

  it('skips a scheduled workflow when the target workflow is already running', () => {
    const { executeScheduledTask } = loadFresh('../execution/schedule-runner');
    const schedule = {
      id: 'schedule-workflow-1',
      name: 'example-project autodev',
      task_description: 'Launch example-project autodev workflow',
      working_directory: 'C:\\repo',
      schedule_type: 'cron',
      task_config: {
        workflow_id: 'wf-running',
      },
    };

    const result = executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
      getWorkflowStatus: vi.fn(() => ({ id: 'wf-running', status: 'running' })),
    });

    expect(result).toEqual({
      started: false,
      skipped: true,
      execution_type: 'workflow',
      workflow_id: 'wf-running',
      workflow_source_id: null,
      schedule_id: 'schedule-workflow-1',
      schedule_name: 'example-project autodev',
      schedule_consumed: false,
      skip_reason: 'workflow_running',
    });
    expect(db.markScheduledTaskRun).toHaveBeenCalledWith('schedule-workflow-1', expect.objectContaining({
      execution_type: 'workflow',
      status: 'skipped',
      skip_reason: 'workflow_running',
      summary: 'Workflow wf-running already running',
    }));
    expect(workflowHandlerMock.handleRunWorkflow).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith('Skipped scheduled workflow "example-project autodev" because workflow wf-running is still active (running)');
  });

  it('skips a scheduled workflow when another launcher already holds the workflow lock', () => {
    const { executeScheduledTask } = loadFresh('../execution/schedule-runner');
    db.acquireLock.mockReturnValue({
      acquired: false,
      holder: 'schedule:other',
      expiresAt: '2026-04-09T10:30:00.000Z',
    });

    const schedule = {
      id: 'schedule-workflow-1a',
      name: 'example-project autodev',
      task_description: 'Launch example-project autodev workflow',
      working_directory: 'C:\\repo',
      schedule_type: 'cron',
      task_config: {
        workflow_id: 'wf-locked',
      },
    };

    const result = executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
    });

    expect(result).toEqual({
      started: false,
      skipped: true,
      execution_type: 'workflow',
      workflow_id: 'wf-locked',
      workflow_source_id: null,
      schedule_id: 'schedule-workflow-1a',
      schedule_name: 'example-project autodev',
      schedule_consumed: false,
      skip_reason: 'workflow_launch_locked',
    });
    expect(db.markScheduledTaskRun).toHaveBeenCalledWith('schedule-workflow-1a', expect.objectContaining({
      execution_type: 'workflow',
      status: 'skipped',
      skip_reason: 'workflow_launch_locked',
      summary: 'Workflow wf-locked launch already in progress',
    }));
    expect(workflowHandlerMock.handleRunWorkflow).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith('Skipped scheduled workflow "example-project autodev" because workflow wf-locked launch lock is already held');
  });

  it('skips a scheduled workflow when the target workflow still has open work', () => {
    const { executeScheduledTask } = loadFresh('../execution/schedule-runner');
    const schedule = {
      id: 'schedule-workflow-1b',
      name: 'example-project autodev',
      task_description: 'Launch example-project autodev workflow',
      working_directory: 'C:\\repo',
      schedule_type: 'cron',
      task_config: {
        workflow_id: 'wf-pending',
      },
    };

    const result = executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
      getWorkflowStatus: vi.fn(() => ({
        id: 'wf-pending',
        status: 'pending',
        started_at: '2026-04-09T10:00:00.000Z',
        summary: {
          total: 2,
          completed: 0,
          failed: 0,
          running: 0,
          blocked: 0,
          pending: 1,
          queued: 1,
          skipped: 0,
        },
      })),
    });

    expect(result).toEqual({
      started: false,
      skipped: true,
      execution_type: 'workflow',
      workflow_id: 'wf-pending',
      workflow_source_id: null,
      schedule_id: 'schedule-workflow-1b',
      schedule_name: 'example-project autodev',
      schedule_consumed: false,
      skip_reason: 'workflow_active',
    });
    expect(db.markScheduledTaskRun).toHaveBeenCalledWith('schedule-workflow-1b', expect.objectContaining({
      execution_type: 'workflow',
      status: 'skipped',
      skip_reason: 'workflow_active',
      summary: 'Workflow wf-pending still active (pending)',
    }));
    expect(workflowHandlerMock.handleRunWorkflow).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith('Skipped scheduled workflow "example-project autodev" because workflow wf-pending is still active (pending)');
  });

  it('records a completed schedule run when a scheduled workflow starts successfully', () => {
    workflowHandlerMock.handleRunWorkflow.mockReturnValue({
      content: [{ type: 'text', text: '## Workflow Started' }],
    });

    const { executeScheduledTask } = loadFresh('../execution/schedule-runner');
    const schedule = {
      id: 'schedule-workflow-2',
      name: 'example-project autodev',
      task_description: 'Launch example-project autodev workflow',
      working_directory: 'C:\\repo',
      schedule_type: 'cron',
      task_config: {
        workflow_id: 'wf-idle',
      },
    };

    const result = executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
      getWorkflowStatus: vi.fn(() => ({ id: 'wf-idle', status: 'completed' })),
    });

    expect(result).toEqual({
      started: true,
      execution_type: 'workflow',
      workflow_id: 'wf-idle',
      workflow_source_id: null,
      schedule_id: 'schedule-workflow-2',
      schedule_name: 'example-project autodev',
      schedule_consumed: false,
    });
    expect(workflowHandlerMock.handleRunWorkflow).toHaveBeenCalledWith({ workflow_id: 'wf-idle' });
    expect(db.markScheduledTaskRun).toHaveBeenCalledWith('schedule-workflow-2', expect.objectContaining({
      execution_type: 'workflow',
      status: 'completed',
      summary: 'Workflow wf-idle started',
    }));
    expect(debugLog).toHaveBeenCalledWith('Executed scheduled workflow "example-project autodev" -> workflow wf-idle');
  });

  it('skips a cloned scheduled workflow when the latest generated workflow is still active', () => {
    const { executeScheduledTask } = loadFresh('../execution/schedule-runner');
    const schedule = {
      id: 'schedule-workflow-3',
      name: 'example-project autodev',
      task_description: 'Launch example-project autodev workflow',
      working_directory: 'C:\\repo',
      schedule_type: 'cron',
      task_config: {
        workflow_source_id: 'wf-source',
      },
    };

    db.getScheduledTask = vi.fn(() => ({
      id: 'schedule-workflow-3',
      recent_runs: [
        {
          execution_type: 'workflow',
          details_json: {
            workflow_id: 'wf-generated-1',
          },
        },
      ],
    }));

    const result = executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
      getWorkflowStatus: vi.fn((workflowId) => (
        workflowId === 'wf-generated-1'
          ? { id: 'wf-generated-1', status: 'running' }
          : null
      )),
    });

    expect(result).toEqual({
      started: false,
      skipped: true,
      execution_type: 'workflow',
      workflow_id: 'wf-generated-1',
      workflow_source_id: 'wf-source',
      schedule_id: 'schedule-workflow-3',
      schedule_name: 'example-project autodev',
      schedule_consumed: false,
      skip_reason: 'workflow_running',
    });
    expect(workflowHandlerMock.handleCloneWorkflow).not.toHaveBeenCalled();
    expect(workflowHandlerMock.handleRunWorkflow).not.toHaveBeenCalled();
    expect(db.markScheduledTaskRun).toHaveBeenCalledWith('schedule-workflow-3', expect.objectContaining({
      execution_type: 'workflow',
      status: 'skipped',
      skip_reason: 'workflow_running',
      summary: 'Workflow wf-generated-1 already running',
    }));
  });

  it('clones and starts a fresh workflow for source-clone schedules', () => {
    workflowHandlerMock.handleCloneWorkflow.mockReturnValue({
      workflow_id: 'wf-generated-2',
      content: [{ type: 'text', text: '## Workflow Cloned' }],
    });
    workflowHandlerMock.handleRunWorkflow.mockReturnValue({
      content: [{ type: 'text', text: '## Workflow Started' }],
    });

    const { executeScheduledTask } = loadFresh('../execution/schedule-runner');
    const schedule = {
      id: 'schedule-workflow-4',
      name: 'example-project autodev',
      task_description: 'Launch example-project autodev workflow',
      working_directory: 'C:\\repo',
      schedule_type: 'cron',
      task_config: {
        workflow_source_id: 'wf-source',
        project: 'example-project-autodev',
      },
    };

    db.getScheduledTask = vi.fn(() => ({
      id: 'schedule-workflow-4',
      recent_runs: [],
    }));

    const result = executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
      getWorkflowStatus: vi.fn(() => null),
    });

    expect(result).toEqual({
      started: true,
      execution_type: 'workflow',
      workflow_id: 'wf-generated-2',
      workflow_source_id: 'wf-source',
      schedule_id: 'schedule-workflow-4',
      schedule_name: 'example-project autodev',
      schedule_consumed: false,
    });
    expect(workflowHandlerMock.handleCloneWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      source_workflow_id: 'wf-source',
      auto_run: false,
      working_directory: 'C:\\repo',
      project: 'example-project-autodev',
      context: expect.objectContaining({
        _scheduled_origin: expect.objectContaining({
          schedule_id: 'schedule-workflow-4',
          schedule_name: 'example-project autodev',
          source_workflow_id: 'wf-source',
        }),
      }),
    }));
    expect(workflowHandlerMock.handleRunWorkflow).toHaveBeenCalledWith({ workflow_id: 'wf-generated-2' });
    expect(db.markScheduledTaskRun).toHaveBeenCalledWith('schedule-workflow-4', expect.objectContaining({
      execution_type: 'workflow',
      status: 'completed',
      summary: 'Workflow wf-generated-2 started',
      details: expect.objectContaining({
        workflow_id: 'wf-generated-2',
        workflow_source_id: 'wf-source',
      }),
    }));
    expect(debugLog).toHaveBeenCalledWith('Executed scheduled workflow "example-project autodev" -> workflow wf-generated-2 (cloned from wf-source)');
  });
});