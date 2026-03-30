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
      markScheduledTaskRun: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();

    taskManagerMock = {
      startTask: vi.fn(),
    };
    webhookHandlersMock = {
      sendWebhook: vi.fn(),
      triggerWebhooks: vi.fn(),
    };
    uuidMock = {
      v4: vi.fn(),
    };

    installCjsModuleMock('../task-manager', taskManagerMock);
    installCjsModuleMock('../handlers/webhook-handlers', webhookHandlersMock);
    installCjsModuleMock('uuid', uuidMock);

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
      provider: null,
      model: null,
      tags: null,
      timeout_minutes: 45,
      auto_approve: false,
      priority: 0,
      metadata: {
        scheduled_task_id: 'schedule-1',
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
});
