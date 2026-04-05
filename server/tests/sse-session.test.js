import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const SESSION_MODULE = '../transports/sse/session.js';
const DATABASE_MODULE = '../database';
const WORKFLOW_ENGINE_MODULE = '../db/workflow-engine';
const CONFIG_MODULE = '../config';
const LOGGER_MODULE = '../logger';
const MODULE_PATHS = [
  SESSION_MODULE,
  DATABASE_MODULE,
  WORKFLOW_ENGINE_MODULE,
  CONFIG_MODULE,
  LOGGER_MODULE,
];

let sessionModule;
let databaseMock;
let workflowEngineMock;
let configMock;
let loggerMock;
let loggerModuleMock;

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Ignore modules that were never loaded in this test process.
  }
}

function clearModules() {
  for (const modulePath of MODULE_PATHS) {
    clearModule(modulePath);
  }
}

function createMockDb() {
  const statement = {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  };

  return {
    prepare: vi.fn(() => statement),
  };
}

function loadSessionModule() {
  clearModules();
  installCjsModuleMock(DATABASE_MODULE, databaseMock);
  installCjsModuleMock(WORKFLOW_ENGINE_MODULE, workflowEngineMock);
  installCjsModuleMock(CONFIG_MODULE, configMock);
  installCjsModuleMock(LOGGER_MODULE, loggerModuleMock);
  sessionModule = require(SESSION_MODULE);
  return sessionModule;
}

function cleanupSessionState() {
  if (!sessionModule) return;

  try {
    sessionModule.clearAllSessionState();
  } catch {
    // Best-effort cleanup for tests that intentionally probe cleanup gaps.
  }

  sessionModule.sessions.clear();
  sessionModule.taskSubscriptions.clear();
  for (const [, buffer] of sessionModule.aggregationBuffers) {
    if (buffer.timer) clearTimeout(buffer.timer);
  }
  sessionModule.aggregationBuffers.clear();
  sessionModule._perIpSessionCount.clear();
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

describe('server/transports/sse/session', () => {
  beforeEach(() => {
    vi.useRealTimers();

    databaseMock = {
      getDbInstance: vi.fn(() => createMockDb()),
    };
    workflowEngineMock = {
      getWorkflowTasks: vi.fn(() => []),
    };
    configMock = {
      get: vi.fn(() => null),
    };
    loggerMock = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    loggerModuleMock = {
      child: vi.fn(() => loggerMock),
    };

    loadSessionModule();
  });

  afterEach(() => {
    cleanupSessionState();
    sessionModule = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearModules();
  });

  it('normalizeTaskId returns null for nullish and blank values and trims valid task ids', () => {
    expect(sessionModule.normalizeTaskId(null)).toBeNull();
    expect(sessionModule.normalizeTaskId(undefined)).toBeNull();
    expect(sessionModule.normalizeTaskId('')).toBeNull();
    expect(sessionModule.normalizeTaskId('   ')).toBeNull();
    expect(sessionModule.normalizeTaskId('  task-123  ')).toBe('task-123');
  });

  it('addSessionToTaskSubscriptions and removeSessionFromTaskSubscriptions update taskSubscriptions', () => {
    sessionModule.addSessionToTaskSubscriptions('session-1', new Set([' task-1 ', 'task-2', '']));

    expect(sessionModule.taskSubscriptions.get('task-1')).toEqual(new Set(['session-1']));
    expect(sessionModule.taskSubscriptions.get('task-2')).toEqual(new Set(['session-1']));

    sessionModule.removeSessionFromTaskSubscriptions('session-1', new Set(['task-1', 'task-2']));

    expect(sessionModule.taskSubscriptions.size).toBe(0);
  });

  it('isTaskMonitored returns true for subscribed tasks and false when no subscriptions exist', () => {
    sessionModule.addSessionToTaskSubscriptions('session-1', new Set(['task-42']));

    expect(sessionModule.isTaskMonitored('task-42')).toBe(true);
    expect(sessionModule.isTaskMonitored('task-99')).toBe(false);
    expect(sessionModule.isTaskMonitored(null)).toBe(false);
  });

  it('purgeSessionFromTaskSubscriptions removes a session from all subscriptions and prunes empty sets', () => {
    sessionModule.taskSubscriptions.set('task-1', new Set(['session-1', 'session-2']));
    sessionModule.taskSubscriptions.set('task-2', new Set(['session-1']));
    sessionModule.taskSubscriptions.set(sessionModule.ALL_TASKS_SUBSCRIPTION_KEY, new Set(['session-1']));

    sessionModule.purgeSessionFromTaskSubscriptions('session-1');

    expect(sessionModule.taskSubscriptions.get('task-1')).toEqual(new Set(['session-2']));
    expect(sessionModule.taskSubscriptions.has('task-2')).toBe(false);
    expect(sessionModule.taskSubscriptions.has(sessionModule.ALL_TASKS_SUBSCRIPTION_KEY)).toBe(false);
  });

  it('buildSubscriptionTargetFromResult extracts workflow and task ids from result objects', () => {
    workflowEngineMock.getWorkflowTasks.mockReturnValue([
      { id: ' task-1 ' },
      { id: 'task-2' },
      { id: null },
      null,
    ]);

    const target = sessionModule.buildSubscriptionTargetFromResult({
      workflow_id: ' workflow-1 ',
    });

    expect(workflowEngineMock.getWorkflowTasks).toHaveBeenCalledWith('workflow-1');
    expect(target).toEqual({
      kind: 'workflow',
      workflow_id: 'workflow-1',
      task_id: null,
      task_ids: ['task-1', 'task-2'],
      subscribe_tool: 'subscribe_task_events',
      subscribe_args: { task_ids: ['task-1', 'task-2'] },
    });
  });

  it('buildSubscriptionTargetFromResult returns null for nullish or empty result objects', () => {
    expect(sessionModule.buildSubscriptionTargetFromResult(null)).toBeNull();
    expect(sessionModule.buildSubscriptionTargetFromResult({})).toBeNull();
  });

  it('renderNotificationTemplate fills placeholders and omits optional blocks when values are missing', () => {
    const template = '[TORQUE] Task {taskId} {status}{ (}{duration}s{)}{ : }{description}';

    expect(
      sessionModule.renderNotificationTemplate(template, {
        taskId: 'task-1',
        status: 'completed',
        duration: 12,
        description: 'deploy ready',
      }),
    ).toBe('[TORQUE] Task task-1 completed (12s): deploy ready');

    expect(
      sessionModule.renderNotificationTemplate(template, {
        taskId: 'task-1',
        status: 'failed',
        duration: null,
        description: null,
      }),
    ).toBe('[TORQUE] Task task-1 failed');
  });

  it('handleCheckNotifications returns pending events and rate limits repeated checks inside the cooldown window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T18:00:00.000Z'));

    const session = {
      pendingEvents: [
        { id: 1, eventName: 'completed', taskId: 'task-1' },
        { id: 2, eventName: 'failed', taskId: 'task-2' },
      ],
      lastCheckNotificationsAt: null,
    };

    const first = parseToolResult(sessionModule.handleCheckNotifications(session));

    expect(first).toEqual({
      events: [
        { id: 1, eventName: 'completed', taskId: 'task-1' },
        { id: 2, eventName: 'failed', taskId: 'task-2' },
      ],
      count: 2,
    });
    expect(session.pendingEvents).toEqual([]);

    session.pendingEvents.push({ id: 3, eventName: 'retry', taskId: 'task-3' });

    const second = parseToolResult(sessionModule.handleCheckNotifications(session));

    expect(second).toEqual({
      events: [],
      count: 0,
      rate_limited: true,
      retry_after_ms: 1000,
    });
    expect(session.pendingEvents).toEqual([{ id: 3, eventName: 'retry', taskId: 'task-3' }]);
  });

  it('clearAllSessionState clears shared session state including per-IP counts', () => {
    vi.useFakeTimers();

    const baselineTimerCount = vi.getTimerCount();
    const timer = setTimeout(() => {}, 60_000);

    sessionModule.sessions.set('session-1', {
      _sessionId: 'session-1',
      pendingEvents: [],
      res: { writableEnded: false },
      taskFilter: new Set(['task-1']),
    });
    sessionModule.taskSubscriptions.set('task-1', new Set(['session-1']));
    sessionModule._perIpSessionCount.set('127.0.0.1', 2);
    sessionModule.aggregationBuffers.set('session-1', {
      timer,
      events: new Map(),
    });

    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);

    sessionModule.clearAllSessionState();

    expect(sessionModule.sessions.size).toBe(0);
    expect(sessionModule.taskSubscriptions.size).toBe(0);
    expect(sessionModule.aggregationBuffers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
    expect(sessionModule._perIpSessionCount.size).toBe(0);
  });
});
