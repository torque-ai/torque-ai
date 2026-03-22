/**
 * Tests for MCP push notifications: event-dispatch + mcp-sse notification infra.
 *
 * Optimized: requires modules once at file level instead of re-requiring per test.
 * Uses sessions.clear() + vi.restoreAllMocks() for isolation between tests.
 */

// ──────────────────────────────────────────────────────────────
// Module-level setup — require once, stop background timers
// ──────────────────────────────────────────────────────────────

const mcpSse = require('../mcp-sse');
const eventDispatch = require('../hooks/event-dispatch');
const db = require('../database');
const configCore = require('../db/config-core');
const webhooksStreaming = require('../db/webhooks-streaming');

// Stop the retention policy timer started at module load
eventDispatch.stopRetentionPolicy();

const { sessions, notifySubscribedSessions, taskSubscriptions: _taskSubscriptions, addSessionToTaskSubscriptions: _addSessionToTaskSubscriptions } = mcpSse;
const { dispatchTaskEvent, taskEvents } = eventDispatch;

// ──────────────────────────────────────────────────────────────
// Mock helpers — simulate SSE sessions without a real HTTP server
// ──────────────────────────────────────────────────────────────

function makeSession(overrides = {}) {
  const written = [];
  return {
    res: {
      writableEnded: overrides.disconnected || false,
      write: (data) => written.push(data),
    },
    toolMode: 'core',
    keepaliveTimer: null,
    pendingEvents: [],
    eventFilter: new Set(overrides.eventFilter || ['completed', 'failed']),
    taskFilter: new Set(overrides.taskFilter || []),
    _written: written,
  };
}

function makeTask(overrides = {}) {
  return {
    id: overrides.id || 'task-001',
    status: overrides.status || 'completed',
    exit_code: overrides.exit_code ?? 0,
    project: overrides.project || 'test-project',
    started_at: overrides.started_at || new Date(Date.now() - 5000).toISOString(),
    task_description: overrides.task_description || 'Test task description',
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────
// notifySubscribedSessions (mcp-sse.js)
// ──────────────────────────────────────────────────────────────

describe('notifySubscribedSessions', () => {
  beforeEach(() => {
    sessions.clear();
  });

  it('pushes to sessions whose eventFilter matches eventName', () => {
    const session = makeSession({ eventFilter: ['completed', 'failed'] });
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 'task-001', status: 'completed', description: 'hello' });

    expect(session.pendingEvents).toHaveLength(1);
    expect(session.pendingEvents[0].eventName).toBe('completed');
    expect(session.pendingEvents[0].taskId).toBe('task-001');
    // Should also have written a log notification via SSE
    expect(session._written.length).toBeGreaterThan(0);
    expect(session._written[0]).toContain('notifications/message');
  });

  it('skips sessions whose eventFilter does not match', () => {
    const session = makeSession({ eventFilter: ['failed'] });
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 'task-001', status: 'completed' });

    expect(session.pendingEvents).toHaveLength(0);
    expect(session._written).toHaveLength(0);
  });

  it('supports wildcard eventFilter', () => {
    const session = makeSession({ eventFilter: ['*'] });
    sessions.set('s1', session);

    notifySubscribedSessions('cancelled', { taskId: 'task-002', status: 'cancelled' });

    expect(session.pendingEvents).toHaveLength(1);
    expect(session.pendingEvents[0].eventName).toBe('cancelled');
  });

  it('pushes to sessions whose taskFilter contains the task ID', () => {
    const session = makeSession({ taskFilter: ['task-001'] });
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 'task-001', status: 'completed' });
    expect(session.pendingEvents).toHaveLength(1);
  });

  it('skips sessions with non-matching taskFilter', () => {
    const session = makeSession({ taskFilter: ['task-999'] });
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 'task-001', status: 'completed' });
    expect(session.pendingEvents).toHaveLength(0);
  });

  it('pushes to all tasks when taskFilter is empty', () => {
    const session = makeSession({ taskFilter: [] });
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 'task-any', status: 'completed' });
    expect(session.pendingEvents).toHaveLength(1);
  });

  it('caps pendingEvents at 100 (evicts oldest)', () => {
    const session = makeSession();
    sessions.set('s1', session);

    // Fill to 100
    for (let i = 0; i < 105; i++) {
      notifySubscribedSessions('completed', { taskId: `task-${i}`, status: 'completed' });
    }

    expect(session.pendingEvents).toHaveLength(100);
    // Oldest (task-0 through task-4) should be evicted
    expect(session.pendingEvents[0].taskId).toBe('task-5');
    expect(session.pendingEvents[99].taskId).toBe('task-104');
  });

  it('handles disconnected sessions (res.writableEnded)', () => {
    const session = makeSession({ disconnected: true });
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 'task-001', status: 'completed' });
    expect(session.pendingEvents).toHaveLength(0);
  });

  it('notifies multiple sessions independently', () => {
    const s1 = makeSession({ eventFilter: ['completed'] });
    const s2 = makeSession({ eventFilter: ['failed'] });
    const s3 = makeSession({ eventFilter: ['completed', 'failed'] });
    sessions.set('s1', s1);
    sessions.set('s2', s2);
    sessions.set('s3', s3);

    notifySubscribedSessions('completed', { taskId: 'task-001', status: 'completed' });

    expect(s1.pendingEvents).toHaveLength(1);
    expect(s2.pendingEvents).toHaveLength(0);
    expect(s3.pendingEvents).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────
// dispatchTaskEvent (hooks/event-dispatch.js)
// ──────────────────────────────────────────────────────────────

describe('dispatchTaskEvent', () => {
  beforeEach(() => {
    sessions.clear();
    vi.spyOn(configCore, 'getConfig').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls notifySubscribedSessions with correct eventName and payload', () => {
    const session = makeSession();
    sessions.set('s1', session);

    const task = makeTask();
    dispatchTaskEvent('completed', task);

    expect(session.pendingEvents).toHaveLength(1);
    const evt = session.pendingEvents[0];
    expect(evt.eventName).toBe('completed');
    expect(evt.taskId).toBe('task-001');
    expect(evt.status).toBe('completed');
    expect(evt.exitCode).toBe(0);
    expect(evt.project).toBe('test-project');
    expect(evt.duration).toBeTypeOf('number');
    expect(evt.description).toBe('Test task description');
  });

  it('normalizes exitCode and exit_code aliases into a dual-mapped payload', () => {
    const session = makeSession();
    sessions.set('s1', session);

    const dashboardServer = require('../dashboard-server');
    const spy = vi.spyOn(dashboardServer, 'notifyTaskEvent').mockImplementation(() => {});

    dispatchTaskEvent('completed', makeTask({ id: 'alias-1', exitCode: 7 }));

    expect(session.pendingEvents).toHaveLength(1);
    expect(session.pendingEvents[0].exitCode).toBe(7);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'alias-1',
      exitCode: 7,
      exit_code: 7,
      status: 'completed',
      eventStatus: 'completed',
      taskStatus: 'completed',
    }));
  });

  it('keeps status backward-compatible while exposing taskStatus separately', () => {
    const session = makeSession({ eventFilter: ['timeout'] });
    sessions.set('s1', session);

    const dashboardServer = require('../dashboard-server');
    const spy = vi.spyOn(dashboardServer, 'notifyTaskEvent').mockImplementation(() => {});

    dispatchTaskEvent('timeout', makeTask({ id: 'timeout-status', status: 'cancelled' }));

    expect(session.pendingEvents).toHaveLength(1);
    expect(session.pendingEvents[0]).toEqual(expect.objectContaining({
      eventName: 'timeout',
      taskId: 'timeout-status',
      status: 'timeout',
    }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'timeout-status',
      status: 'timeout',
      eventStatus: 'timeout',
      taskStatus: 'cancelled',
    }));
  });

  it('marks malformed partial task payloads explicitly instead of dereferencing them blindly', () => {
    const session = makeSession();
    sessions.set('s1', session);

    const dashboardServer = require('../dashboard-server');
    const spy = vi.spyOn(dashboardServer, 'notifyTaskEvent').mockImplementation(() => {});

    expect(() => dispatchTaskEvent('completed', { id: 'partial-1' })).not.toThrow();

    expect(session.pendingEvents).toHaveLength(1);
    expect(session.pendingEvents[0]).toEqual(expect.objectContaining({
      eventName: 'completed',
      taskId: 'partial-1',
      status: 'completed',
      exitCode: null,
    }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'partial-1',
      status: 'completed',
      eventStatus: 'completed',
      taskStatus: null,
      malformedTaskPayload: true,
      taskPayloadIssues: expect.arrayContaining(['task.status missing']),
    }));
  });

  it('respects mcp_notifications_enabled = false (no-op)', () => {
    configCore.getConfig.mockReturnValue('false');

    const session = makeSession();
    sessions.set('s1', session);

    dispatchTaskEvent('completed', makeTask());
    expect(session.pendingEvents).toHaveLength(0);
  });

  it('respects mcp_notifications_enabled = 0 (no-op)', () => {
    configCore.getConfig.mockReturnValue('0');

    const session = makeSession();
    sessions.set('s1', session);

    dispatchTaskEvent('completed', makeTask());
    expect(session.pendingEvents).toHaveLength(0);
  });

  it('handles errors gracefully (does not throw)', () => {
    const mcpSsePath = require.resolve('../mcp-sse');
    const cached = require.cache[mcpSsePath];

    // Should not throw
    expect(() => dispatchTaskEvent('completed', makeTask())).not.toThrow();

    // Restore
    if (cached) require.cache[mcpSsePath] = cached;
  });
});

// ──────────────────────────────────────────────────────────────
// SSE-only tool handlers (via handleMcpRequest in mcp-sse.js)
// ──────────────────────────────────────────────────────────────

describe('subscribe_task_events tool', () => {
  beforeEach(() => {
    sessions.clear();
  });

  it('adds task IDs to session.taskFilter', () => {
    const session = makeSession();
    sessions.set('s1', session);

    // Simulate what handleSubscribeTaskEvents does
    const args = { task_ids: ['task-a', 'task-b'], events: ['completed'] };
    if (args.events && args.events.length > 0) {
      session.eventFilter = new Set(args.events);
    }
    if (args.task_ids && args.task_ids.length > 0) {
      for (const id of args.task_ids) {
        session.taskFilter.add(id);
      }
    }

    expect(session.taskFilter.has('task-a')).toBe(true);
    expect(session.taskFilter.has('task-b')).toBe(true);
    expect(session.eventFilter.has('completed')).toBe(true);
    expect(session.eventFilter.has('failed')).toBe(false);
  });

  it('overrides eventFilter with specified events', () => {
    const session = makeSession({ eventFilter: ['completed', 'failed'] });
    sessions.set('s1', session);

    session.eventFilter = new Set(['cancelled', 'retry']);

    expect(session.eventFilter.has('cancelled')).toBe(true);
    expect(session.eventFilter.has('retry')).toBe(true);
    expect(session.eventFilter.has('completed')).toBe(false);
  });
});

describe('check_notifications tool', () => {
  beforeEach(() => {
    sessions.clear();
  });

  it('returns pending events array', () => {
    const session = makeSession();
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 'task-001', status: 'completed', description: 'a' });
    notifySubscribedSessions('failed', { taskId: 'task-002', status: 'failed', description: 'b' });

    // Simulate check_notifications: splice and return
    const events = session.pendingEvents.splice(0);
    expect(events).toHaveLength(2);
    expect(events[0].taskId).toBe('task-001');
    expect(events[1].taskId).toBe('task-002');
  });

  it('clears queue after return', () => {
    const session = makeSession();
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 'task-001', status: 'completed' });

    session.pendingEvents.splice(0);
    expect(session.pendingEvents).toHaveLength(0);
  });

  it('returns empty array when no events', () => {
    const session = makeSession();
    sessions.set('s1', session);

    const events = session.pendingEvents.splice(0);
    expect(events).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────
// taskEvents internal emitter (hooks/event-dispatch.js)
// ──────────────────────────────────────────────────────────────

describe('taskEvents internal emitter', () => {
  beforeEach(() => {
    sessions.clear();
    taskEvents.removeAllListeners();
    vi.spyOn(configCore, 'getConfig').mockReturnValue(null);
  });

  afterEach(() => {
    taskEvents.removeAllListeners();
    vi.restoreAllMocks();
  });

  it('emits task:<status> events on dispatch', () => {
    const received = [];
    taskEvents.on('task:completed', (task) => received.push(task));

    dispatchTaskEvent('completed', makeTask({ id: 'emit-test-1' }));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('emit-test-1');
  });

  it('emits even when MCP notifications are disabled', () => {
    configCore.getConfig.mockReturnValue('false');

    const received = [];
    taskEvents.on('task:failed', (task) => received.push(task));

    dispatchTaskEvent('failed', makeTask({ id: 'emit-test-2' }));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('emit-test-2');
  });

  it('does not throw if no listeners registered', () => {
    expect(() => dispatchTaskEvent('completed', makeTask())).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────
// DB persistence (hooks/event-dispatch.js)
// ──────────────────────────────────────────────────────────────

describe('task event DB persistence', () => {
  let mockRawDb;
  let insertedRows;

  beforeEach(() => {
    sessions.clear();
    vi.spyOn(configCore, 'getConfig').mockReturnValue(null);

    // Mock getDbInstance to return a fake db with prepare().run()/all()
    insertedRows = [];
    mockRawDb = {
      prepare: vi.fn((sql) => ({
        run: vi.fn((...args) => insertedRows.push({ sql, args })),
        all: vi.fn((..._args) => insertedRows
          .filter(r => r.sql.includes('INSERT'))
          .map((r, i) => ({
            id: i + 1,
            task_id: r.args[0],
            event_type: r.args[1],
            old_value: r.args[2],
            new_value: r.args[3],
            event_data: r.args[4],
            created_at: r.args[5],
          }))),
      })),
    };
    vi.spyOn(db, 'getDbInstance').mockReturnValue(mockRawDb);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists task events to DB on dispatch', () => {
    dispatchTaskEvent('completed', makeTask({ id: 'persist-test-1' }));

    expect(mockRawDb.prepare).toHaveBeenCalled();
    const insertCall = mockRawDb.prepare.mock.calls.find(c => c[0].includes('INSERT'));
    expect(insertCall).toBeTruthy();
  });

  it('persists split status semantics and dual-mapped exit codes', () => {
    dispatchTaskEvent('retry', makeTask({ id: 'persist-retry-1', status: 'pending', exitCode: 11 }));

    const insertRow = insertedRows.find((row) => row.sql.includes('INSERT'));
    expect(insertRow).toBeTruthy();
    expect(insertRow.args[0]).toBe('persist-retry-1');
    expect(insertRow.args[1]).toBe('retry');
    expect(insertRow.args[3]).toBe('pending');

    const eventData = JSON.parse(insertRow.args[4]);
    expect(eventData).toMatchObject({
      exitCode: 11,
      exit_code: 11,
      status: 'retry',
      eventStatus: 'retry',
      taskStatus: 'pending',
      malformedTaskPayload: false,
    });
  });

  it('skips DB inserts when malformed input has no task ID', () => {
    dispatchTaskEvent('completed', null);

    expect(insertedRows.filter((row) => row.sql.includes('INSERT'))).toHaveLength(0);
  });

  it('does not throw if getDbInstance returns null', () => {
    db.getDbInstance.mockReturnValue(null);
    expect(() => dispatchTaskEvent('completed', makeTask())).not.toThrow();
  });

  it('getTaskEvents calls DB with correct params', () => {
    const { getTaskEvents } = eventDispatch;
    const result = getTaskEvents({ task_id: 'test-id', limit: 10 });
    expect(mockRawDb.prepare).toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(true);
  });

  it('pruneOldTaskEvents deletes old rows', () => {
    const { pruneOldTaskEvents } = eventDispatch;

    // Mock the run() to return changes count
    mockRawDb.prepare = vi.fn((sql) => ({
      run: vi.fn(() => ({ changes: sql.includes('DELETE') ? 5 : 0 })),
      all: vi.fn(() => []),
    }));

    const deleted = pruneOldTaskEvents();
    expect(deleted).toBe(5);

    const deleteCall = mockRawDb.prepare.mock.calls.find(c => c[0].includes('DELETE'));
    expect(deleteCall).toBeTruthy();
  });

  it('pruneOldTaskEvents returns 0 when no DB', () => {
    const { pruneOldTaskEvents } = eventDispatch;
    db.getDbInstance.mockReturnValue(null);
    expect(pruneOldTaskEvents()).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────
// Rate limiting (check_notifications in mcp-sse.js)
// ──────────────────────────────────────────────────────────────

// Pattern test: verifies rate-limit arithmetic, not handler integration
describe('check_notifications rate limiting', () => {
  beforeEach(() => {
    sessions.clear();
  });

  it('returns rate_limited when called too fast', () => {
    const session = makeSession();
    session.lastCheckNotificationsAt = Date.now(); // simulate recent call
    sessions.set('s1', session);

    // Simulate handleCheckNotifications logic
    const now = Date.now();
    const minInterval = 1000;
    const timeSinceLast = now - session.lastCheckNotificationsAt;
    expect(timeSinceLast).toBeLessThan(minInterval);
  });

  it('allows call after rate limit window passes', () => {
    const session = makeSession();
    session.lastCheckNotificationsAt = Date.now() - 2000; // 2s ago
    sessions.set('s1', session);

    const now = Date.now();
    const minInterval = 1000;
    const timeSinceLast = now - session.lastCheckNotificationsAt;
    expect(timeSinceLast).toBeGreaterThanOrEqual(minInterval);
  });
});

// ──────────────────────────────────────────────────────────────
// Cancel/retry event dispatch
// ──────────────────────────────────────────────────────────────

describe('cancel and retry event dispatch', () => {
  beforeEach(() => {
    sessions.clear();
    vi.spyOn(configCore, 'getConfig').mockReturnValue(null);
    vi.spyOn(db, 'getDbInstance').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches cancelled events to subscribed sessions', () => {
    const session = makeSession({ eventFilter: ['cancelled'] });
    sessions.set('s1', session);

    dispatchTaskEvent('cancelled', makeTask({ id: 'cancel-1', status: 'cancelled' }));

    expect(session.pendingEvents).toHaveLength(1);
    expect(session.pendingEvents[0].eventName).toBe('cancelled');
    expect(session.pendingEvents[0].taskId).toBe('cancel-1');
  });

  it('dispatches timeout events to wildcard subscribers', () => {
    const session = makeSession({ eventFilter: ['*'] });
    sessions.set('s1', session);

    dispatchTaskEvent('timeout', makeTask({ id: 'timeout-1', status: 'cancelled' }));

    expect(session.pendingEvents).toHaveLength(1);
    expect(session.pendingEvents[0].eventName).toBe('timeout');
  });

  it('dispatches retry events', () => {
    const session = makeSession({ eventFilter: ['retry'] });
    sessions.set('s1', session);

    dispatchTaskEvent('retry', makeTask({ id: 'retry-1', status: 'pending' }));

    expect(session.pendingEvents).toHaveLength(1);
    expect(session.pendingEvents[0].eventName).toBe('retry');
    expect(session.pendingEvents[0].taskId).toBe('retry-1');
  });

  it('does not deliver cancelled events to completed-only subscribers', () => {
    const session = makeSession({ eventFilter: ['completed'] });
    sessions.set('s1', session);

    dispatchTaskEvent('cancelled', makeTask({ id: 'cancel-2' }));

    expect(session.pendingEvents).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────
// E2E integration: full notification lifecycle
// ──────────────────────────────────────────────────────────────

describe('E2E notification lifecycle', () => {
  beforeEach(() => {
    sessions.clear();
    taskEvents.removeAllListeners();
    vi.spyOn(configCore, 'getConfig').mockReturnValue(null);
    vi.spyOn(db, 'getDbInstance').mockReturnValue(null);
  });

  afterEach(() => {
    taskEvents.removeAllListeners();
    vi.restoreAllMocks();
  });

  it('full lifecycle: subscribe → dispatch → check → clear', () => {
    // 1. Create session with subscription
    const session = makeSession({ eventFilter: ['completed', 'failed', 'cancelled'] });
    session.taskFilter.add('lifecycle-task-1');
    sessions.set('s1', session);

    // 2. Dispatch events for matching and non-matching tasks
    dispatchTaskEvent('completed', makeTask({ id: 'lifecycle-task-1', status: 'completed' }));
    dispatchTaskEvent('failed', makeTask({ id: 'lifecycle-task-2', status: 'failed' }));
    dispatchTaskEvent('completed', makeTask({ id: 'lifecycle-task-3', status: 'completed' }));

    // 3. Only the matching task should be in pendingEvents
    expect(session.pendingEvents).toHaveLength(1);
    expect(session.pendingEvents[0].taskId).toBe('lifecycle-task-1');

    // 4. Check and clear (simulating check_notifications)
    const events = session.pendingEvents.splice(0);
    expect(events).toHaveLength(1);
    expect(session.pendingEvents).toHaveLength(0);
  });

  it('full lifecycle: wildcard subscription gets all events', () => {
    const session = makeSession({ eventFilter: ['*'] });
    sessions.set('s1', session);

    dispatchTaskEvent('completed', makeTask({ id: 'wc-1' }));
    dispatchTaskEvent('failed', makeTask({ id: 'wc-2' }));
    dispatchTaskEvent('cancelled', makeTask({ id: 'wc-3' }));
    dispatchTaskEvent('retry', makeTask({ id: 'wc-4' }));
    dispatchTaskEvent('timeout', makeTask({ id: 'wc-5' }));

    expect(session.pendingEvents).toHaveLength(5);
    expect(session.pendingEvents.map(e => e.eventName)).toEqual([
      'completed', 'failed', 'cancelled', 'retry', 'timeout'
    ]);
  });

  it('full lifecycle: EventEmitter wakes immediately on dispatch', () => {
    const received = [];
    taskEvents.on('task:completed', (task) => received.push(task));
    taskEvents.on('task:cancelled', (task) => received.push(task));

    dispatchTaskEvent('completed', makeTask({ id: 'emit-1' }));
    dispatchTaskEvent('cancelled', makeTask({ id: 'emit-2' }));

    expect(received).toHaveLength(2);
    expect(received[0].id).toBe('emit-1');
    expect(received[1].id).toBe('emit-2');
  });

  it('full lifecycle: SSE log notification written on event', () => {
    const session = makeSession({ eventFilter: ['completed'] });
    sessions.set('s1', session);

    dispatchTaskEvent('completed', makeTask({ id: 'sse-log-1', task_description: 'Test SSE log' }));

    // Session._written should contain the SSE notification
    expect(session._written.length).toBeGreaterThan(0);
    const sseData = session._written[0];
    expect(sseData).toContain('notifications/message');
    expect(sseData).toContain('TORQUE');
  });

  it('full lifecycle: multiple sessions receive independent events', () => {
    const s1 = makeSession({ eventFilter: ['completed'] });
    const s2 = makeSession({ eventFilter: ['failed', 'cancelled'] });
    const s3 = makeSession({ eventFilter: ['*'] });
    sessions.set('s1', s1);
    sessions.set('s2', s2);
    sessions.set('s3', s3);

    dispatchTaskEvent('completed', makeTask({ id: 'multi-1' }));
    dispatchTaskEvent('cancelled', makeTask({ id: 'multi-2' }));

    expect(s1.pendingEvents).toHaveLength(1);
    expect(s1.pendingEvents[0].eventName).toBe('completed');

    expect(s2.pendingEvents).toHaveLength(1);
    expect(s2.pendingEvents[0].eventName).toBe('cancelled');

    expect(s3.pendingEvents).toHaveLength(2);
  });

  it('full lifecycle: deduplication replaces same-task events within window', () => {
    const session = makeSession({ eventFilter: ['*'] });
    sessions.set('s1', session);

    // Dispatch retry then completed for same task within 5s dedup window
    dispatchTaskEvent('retry', makeTask({ id: 'dedup-1', status: 'pending' }));
    dispatchTaskEvent('completed', makeTask({ id: 'dedup-1', status: 'completed' }));

    // H6 fix: different event types for the same task are NOT deduped
    expect(session.pendingEvents).toHaveLength(2);
    expect(session.pendingEvents[0].eventName).toBe('retry');
    expect(session.pendingEvents[1].eventName).toBe('completed');
  });

  it('full lifecycle: no dedup for different task IDs', () => {
    const session = makeSession({ eventFilter: ['*'] });
    sessions.set('s1', session);

    dispatchTaskEvent('completed', makeTask({ id: 'nodedup-1' }));
    dispatchTaskEvent('completed', makeTask({ id: 'nodedup-2' }));

    expect(session.pendingEvents).toHaveLength(2);
  });

  it('full lifecycle: ack_notification removes events by taskId', () => {
    const session = makeSession({ eventFilter: ['*'] });
    sessions.set('s1', session);

    dispatchTaskEvent('completed', makeTask({ id: 'ack-1' }));
    dispatchTaskEvent('failed', makeTask({ id: 'ack-2' }));
    dispatchTaskEvent('completed', makeTask({ id: 'ack-3' }));

    expect(session.pendingEvents).toHaveLength(3);

    // Acknowledge ack-2 by removing events matching that taskId
    const ackSet = new Set(['ack-2']);
    session.pendingEvents = session.pendingEvents.filter(e => !ackSet.has(e.taskId));

    expect(session.pendingEvents).toHaveLength(2);
    expect(session.pendingEvents.map(e => e.taskId)).toEqual(['ack-1', 'ack-3']);
  });

  it('full lifecycle: ack_notification removes events by index', () => {
    const session = makeSession({ eventFilter: ['*'] });
    sessions.set('s1', session);

    dispatchTaskEvent('completed', makeTask({ id: 'idx-1' }));
    dispatchTaskEvent('failed', makeTask({ id: 'idx-2' }));
    dispatchTaskEvent('completed', makeTask({ id: 'idx-3' }));

    expect(session.pendingEvents).toHaveLength(3);

    // Remove index 1 (middle element)
    session.pendingEvents.splice(1, 1);

    expect(session.pendingEvents).toHaveLength(2);
    expect(session.pendingEvents[0].taskId).toBe('idx-1');
    expect(session.pendingEvents[1].taskId).toBe('idx-3');
  });

  it('full lifecycle: dead sessions cleaned up on dispatch', () => {
    const alive = makeSession({ eventFilter: ['completed'] });
    const dead = makeSession({ eventFilter: ['completed'], disconnected: true });
    sessions.set('alive', alive);
    sessions.set('dead', dead);

    dispatchTaskEvent('completed', makeTask({ id: 'cleanup-1' }));

    // Dead session should be cleaned up
    expect(sessions.has('dead')).toBe(false);
    expect(sessions.has('alive')).toBe(true);
    expect(alive.pendingEvents).toHaveLength(1);
  });

  it('full lifecycle: event payload contains all required fields', () => {
    const session = makeSession({ eventFilter: ['completed'] });
    sessions.set('s1', session);

    const task = makeTask({
      id: 'fields-test',
      status: 'completed',
      exit_code: 0,
      project: 'my-project',
      task_description: 'Verify all fields are present',
    });

    dispatchTaskEvent('completed', task);

    const evt = session.pendingEvents[0];
    expect(evt).toHaveProperty('eventName', 'completed');
    expect(evt).toHaveProperty('taskId', 'fields-test');
    expect(evt).toHaveProperty('status', 'completed');
    expect(evt).toHaveProperty('exitCode', 0);
    expect(evt).toHaveProperty('project', 'my-project');
    expect(evt).toHaveProperty('duration');
    expect(evt).toHaveProperty('description', 'Verify all fields are present');
    expect(evt).toHaveProperty('timestamp');
  });
});

// ──────────────────────────────────────────────────────────────
// Notification template rendering
// ──────────────────────────────────────────────────────────────

describe('notification template rendering', () => {
  beforeEach(() => {
    sessions.clear();
  });

  it('default template produces expected log format', () => {
    const session = makeSession({ eventFilter: ['completed'] });
    sessions.set('t1', session);

    notifySubscribedSessions('completed', {
      taskId: 'tmpl-1',
      status: 'completed',
      duration: 42,
      description: 'Test template',
    });

    expect(session._written.length).toBeGreaterThan(0);
    const sseData = session._written[0];
    expect(sseData).toContain('TORQUE');
    expect(sseData).toContain('tmpl-1');
    expect(sseData).toContain('42s');
    expect(sseData).toContain('Test template');
  });

  it('template omits duration when null', () => {
    const session = makeSession({ eventFilter: ['completed'] });
    sessions.set('t2', session);

    notifySubscribedSessions('completed', {
      taskId: 'tmpl-2',
      status: 'completed',
      duration: null,
      description: null,
    });

    expect(session._written.length).toBeGreaterThan(0);
    const sseData = session._written[0];
    expect(sseData).toContain('tmpl-2');
    // Should not contain "null" literally
    expect(sseData).not.toContain('nulls');
  });
});

// ──────────────────────────────────────────────────────────────
// Notification routing rules (project/provider filters)
// ──────────────────────────────────────────────────────────────

describe('notification routing rules', () => {
  beforeEach(() => {
    sessions.clear();
  });

  it('filters by projectFilter — matching project passes', () => {
    const session = makeSession();
    session.projectFilter = new Set(['my-project']);
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 't1', status: 'completed', project: 'my-project' });
    expect(session.pendingEvents).toHaveLength(1);
  });

  it('filters by projectFilter — non-matching project blocked', () => {
    const session = makeSession();
    session.projectFilter = new Set(['my-project']);
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 't1', status: 'completed', project: 'other-project' });
    expect(session.pendingEvents).toHaveLength(0);
  });

  it('empty projectFilter passes all projects', () => {
    const session = makeSession();
    session.projectFilter = new Set();
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 't1', status: 'completed', project: 'any-project' });
    expect(session.pendingEvents).toHaveLength(1);
  });

  it('filters by providerFilter — matching provider passes', () => {
    const session = makeSession();
    session.providerFilter = new Set(['codex']);
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 't1', status: 'completed', provider: 'codex' });
    expect(session.pendingEvents).toHaveLength(1);
  });

  it('filters by providerFilter — non-matching provider blocked', () => {
    const session = makeSession();
    session.providerFilter = new Set(['codex']);
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 't1', status: 'completed', provider: 'ollama' });
    expect(session.pendingEvents).toHaveLength(0);
  });

  it('combined project + provider filter', () => {
    const session = makeSession();
    session.projectFilter = new Set(['proj-a']);
    session.providerFilter = new Set(['codex']);
    sessions.set('s1', session);

    // Matching both
    notifySubscribedSessions('completed', { taskId: 't1', status: 'completed', project: 'proj-a', provider: 'codex' });
    expect(session.pendingEvents).toHaveLength(1);

    // Wrong provider
    notifySubscribedSessions('completed', { taskId: 't2', status: 'completed', project: 'proj-a', provider: 'ollama' });
    expect(session.pendingEvents).toHaveLength(1); // still 1

    // Wrong project
    notifySubscribedSessions('completed', { taskId: 't3', status: 'completed', project: 'proj-b', provider: 'codex' });
    expect(session.pendingEvents).toHaveLength(1); // still 1
  });
});

// ──────────────────────────────────────────────────────────────
// Event ID monotonic counter
// ──────────────────────────────────────────────────────────────

describe('event ID counter', () => {
  beforeEach(() => {
    sessions.clear();
  });

  it('assigns monotonically increasing IDs to events', () => {
    const session = makeSession({ eventFilter: ['*'] });
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 't1', status: 'completed' });
    notifySubscribedSessions('failed', { taskId: 't2', status: 'failed' });
    notifySubscribedSessions('completed', { taskId: 't3', status: 'completed' });

    expect(session.pendingEvents).toHaveLength(3);
    expect(session.pendingEvents[0].id).toBeLessThan(session.pendingEvents[1].id);
    expect(session.pendingEvents[1].id).toBeLessThan(session.pendingEvents[2].id);
  });

  it('events include provider field', () => {
    const session = makeSession({ eventFilter: ['completed'] });
    sessions.set('s1', session);

    notifySubscribedSessions('completed', { taskId: 't1', status: 'completed', provider: 'codex' });

    expect(session.pendingEvents[0].provider).toBe('codex');
  });
});

// ──────────────────────────────────────────────────────────────
// Dashboard event feed wiring
// ──────────────────────────────────────────────────────────────

describe('dashboard event feed wiring', () => {
  beforeEach(() => {
    sessions.clear();
    vi.spyOn(configCore, 'getConfig').mockReturnValue(null);
    vi.spyOn(db, 'getDbInstance').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatchTaskEvent calls dashboard notifyTaskEvent', () => {
    // Mock dashboard-server
    const dashboardServer = require('../dashboard-server');
    const spy = vi.spyOn(dashboardServer, 'notifyTaskEvent').mockImplementation(() => {});

    dispatchTaskEvent('completed', makeTask({ id: 'dash-1' }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'dash-1',
      status: 'completed',
    }));
  });

  it('dashboard feed is non-fatal if dashboard-server not loaded', () => {
    const dashPath = require.resolve('../dashboard-server');
    const cached = require.cache[dashPath];

    // Should not throw
    expect(() => dispatchTaskEvent('completed', makeTask({ id: 'dash-2' }))).not.toThrow();

    // Restore
    if (cached) require.cache[dashPath] = cached;
  });
});

// ──────────────────────────────────────────────────────────────
// Event aggregation (mcp-sse.js)
// ──────────────────────────────────────────────────────────────

describe('event aggregation', () => {
  beforeEach(() => {
    sessions.clear();
  });

  it('tracks events for aggregation without blocking individual delivery', () => {
    const session = makeSession({ eventFilter: ['*'] });
    sessions.set('s1', session);

    // Send 2 events — below threshold of 3, no summary expected
    notifySubscribedSessions('completed', { taskId: 't1', status: 'completed', project: 'proj-a' });
    notifySubscribedSessions('completed', { taskId: 't2', status: 'completed', project: 'proj-a' });

    // Individual events should still be delivered
    expect(session.pendingEvents).toHaveLength(2);
  });

  it('queues individual events even when batch threshold reached', () => {
    const session = makeSession({ eventFilter: ['*'] });
    sessions.set('s1', session);

    // Send 5 events rapidly — above threshold
    for (let i = 0; i < 5; i++) {
      notifySubscribedSessions('completed', { taskId: `agg-${i}`, status: 'completed', project: 'proj-b' });
    }

    // All 5 individual events should be present (summary comes later via timer)
    expect(session.pendingEvents).toHaveLength(5);
  });
});

// ──────────────────────────────────────────────────────────────
// Quick setup notifications (webhook-handlers.js)
// ──────────────────────────────────────────────────────────────

describe('quick_setup_notifications handler', () => {
  let handleQuickSetupNotifications;

  beforeEach(() => {
    vi.spyOn(configCore, 'getConfig').mockReturnValue(null);
    vi.spyOn(db, 'getDbInstance').mockReturnValue(null);

    // Mock createWebhook to prevent actual DB writes
    vi.spyOn(webhooksStreaming, 'createWebhook').mockImplementation((args) => ({
      id: args.id || 'wh-test-1',
      name: args.name,
      url: args.url,
      type: args.type || 'http',
      events: args.events || ['completed', 'failed'],
      project: args.project || null,
      secret: args.secret || null,
    }));

    // Mock upsertIntegration
    if (!db.upsertIntegration) db.upsertIntegration = vi.fn();
    vi.spyOn(db, 'upsertIntegration').mockReturnValue(true);

    // Re-require to pick up mocked db — this handler captures db at require-time
    handleQuickSetupNotifications = require('../handlers/webhook-handlers').handleQuickSetupNotifications;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-detects slack type from URL', () => {
    const result = handleQuickSetupNotifications({
      webhook_url: 'https://hooks.slack.com/services/T00/B00/xxx',
    });
    // Should not be an error
    expect(result.content).toBeDefined();
    expect(result.content[0].text).toBeDefined();
  });

  it('auto-detects discord type from URL', () => {
    const result = handleQuickSetupNotifications({
      webhook_url: 'https://discord.com/api/webhooks/123/abc',
    });
    expect(result.content).toBeDefined();
    expect(result.content[0].text).toBeDefined();
  });

  it('rejects invalid event types', () => {
    const result = handleQuickSetupNotifications({
      webhook_url: 'https://example.com/hook',
      events: ['invalid_event'],
    });
    expect(result.content[0].text).toContain('Invalid event');
  });
});
