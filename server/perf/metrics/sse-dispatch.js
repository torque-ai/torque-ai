'use strict';

// Path B: dispatch-only measurement. We register an in-process fake session
// that captures pushed events, then call pushNotification and time the
// dispatch. This excludes HTTP framing and SSE wire-format encoding over a
// real socket, but captures the session-iteration, event-filter evaluation,
// JSON serialisation, res.write(), pending-event queuing, dedup, and
// aggregation-tracking work — the hot path that fires on every task completion.
//
// The metric is named 'sse-dispatch' (not 'sse-fan-out') to reflect the
// narrower scope (path B chosen over path A because the full loopback setup
// requires wiring the SSE HTTP server + DB + config dependencies that are
// already satisfied by the running TORQUE instance, making the perf test
// non-isolated and fragile across process restarts).
//
// Session cleanup: the fake session is removed from the sessions Map and the
// taskSubscriptions index in a process 'exit' listener so it never leaks into
// the production server even if run() is called multiple times.

const { performance } = require('perf_hooks');
const sessionMod = require('../../transports/sse/session');

const { sessions, addSessionToTaskSubscriptions } = sessionMod;
const pushNotification = sessionMod.pushNotification;

// Build a fake in-process session that satisfies the checks in
// notifySubscribedSessions:
//   1. session.res.writableEnded must be false
//   2. session.eventFilter must have the event name (or '*')
//   3. session.taskFilter.size === 0 → all tasks pass the task-filter check
//   4. _sendSseEvent(session, 'message', data) calls session.res.write(data)
//
// We also need session._sessionId so addSessionToTaskSubscriptions wires it
// into taskSubscriptions under ALL_TASKS_SUBSCRIPTION_KEY.

const FAKE_SESSION_ID = `perf-sse-dispatch-${process.pid}`;

let cached = null;

function buildFakeSession() {
  const writes = [];
  // Minimal mock res: notifySubscribedSessions guards on .writableEnded and
  // calls _sendSseEvent which calls res.write().
  const res = {
    writableEnded: false,
    write: (chunk) => { writes.push(chunk); },
  };

  const session = {
    _sessionId: FAKE_SESSION_ID,
    res,
    // Accept all event types
    eventFilter: new Set(['*']),
    // Empty taskFilter → match all tasks
    taskFilter: new Set(),
    projectFilter: new Set(),
    providerFilter: new Set(),
    pendingEvents: [],
    _eventCounter: 0,
    keepaliveTimer: null,
    _ip: null,
    writes,
  };

  return session;
}

function lazyLoad() {
  if (cached) return cached;

  const session = buildFakeSession();
  sessions.set(FAKE_SESSION_ID, session);
  // Subscribe to all tasks (ALL_TASKS_SUBSCRIPTION_KEY) so that the
  // subscriberSessionIds set is populated even when taskId is null.
  addSessionToTaskSubscriptions(FAKE_SESSION_ID, session.taskFilter);

  // Cleanup on process exit so the fake session never leaks into a running
  // TORQUE server if this module is accidentally loaded in that context.
  process.once('exit', () => {
    sessions.delete(FAKE_SESSION_ID);
    sessionMod.purgeSessionFromTaskSubscriptions(FAKE_SESSION_ID);
  });

  cached = { session };
  return cached;
}

async function run(ctx) {
  const { session } = lazyLoad();

  const beforePending = session.pendingEvents.length;
  const beforeWrites = session.writes.length;

  const start = performance.now();
  pushNotification({ type: 'completed', data: { taskId: `perf-task-${ctx.iter}`, status: 'completed', duration: 1 } });
  const elapsed = performance.now() - start;

  // Sanity: the session must have received either a write (SSE frame) or a
  // pending event. If neither happened the fake session was not reached by
  // the dispatch path (wrong subscription wiring).
  const receivedWrite = session.writes.length > beforeWrites;
  const receivedEvent = session.pendingEvents.length > beforePending;

  if (!receivedWrite && !receivedEvent) {
    throw new Error(
      'sse-dispatch: pushNotification did not deliver to fake session ' +
      `(writes ${session.writes.length}, events ${session.pendingEvents.length})`
    );
  }

  return { value: elapsed };
}

module.exports = {
  id: 'sse-dispatch',
  name: 'SSE notification dispatch (path B: in-process fake session)',
  category: 'request-latency',
  units: 'ms',
  warmup: 5,
  runs: 50,
  run,
};
