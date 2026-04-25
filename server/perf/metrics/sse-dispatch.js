'use strict';

// Path B: dispatch-only measurement. We register 100 in-process fake sessions
// that capture pushed events, then call pushNotification and time the
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
// Session cleanup: the 100 fake sessions are removed from the sessions Map and
// the taskSubscriptions index in a process 'exit' listener so they never leak
// into the production server even if run() is called multiple times.

const { performance } = require('perf_hooks');
const sessionMod = require('../../transports/sse/session');

const { sessions, addSessionToTaskSubscriptions, aggregationBuffers } = sessionMod;
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

const SESSION_ID_PREFIX = `perf-sse-dispatch-${process.pid}`;
const SESSION_COUNT = 100;

let cached = null;

function buildFakeSession(id) {
  const writes = [];
  // Minimal mock res: notifySubscribedSessions guards on .writableEnded and
  // calls _sendSseEvent which calls res.write().
  const res = {
    writableEnded: false,
    write: (chunk) => { writes.push(chunk); },
  };

  const session = {
    _sessionId: id,
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

  // Fix 1: Inject sendSseEvent so res.write actually fires.
  // Without this, _sendSseEvent is null and res.write() is never called.
  sessionMod.injectSendHelpers({
    sendSseEvent: (session, event, data) => session.res.write(data),
    sendJsonRpcNotification: () => {}, // no-op
  });

  // Fix 2: Register 100 fake sessions so dispatch fans out 100x, pushing
  // median well above performance.now() resolution on Windows (~0.4ms+ range).
  const fakeSessions = [];
  for (let i = 0; i < SESSION_COUNT; i++) {
    const id = `${SESSION_ID_PREFIX}-${i}`;
    const session = buildFakeSession(id);
    sessions.set(id, session);
    addSessionToTaskSubscriptions(id, session.taskFilter);
    fakeSessions.push(session);
  }

  // Fix 3: Cleanup on process exit — remove sessions, task subscriptions,
  // and aggregation buffer timers to prevent leaks.
  process.once('exit', () => {
    for (let i = 0; i < SESSION_COUNT; i++) {
      const id = `${SESSION_ID_PREFIX}-${i}`;
      sessions.delete(id);
      sessionMod.purgeSessionFromTaskSubscriptions(id);
      const aggBuf = aggregationBuffers.get(id);
      if (aggBuf?.timer) clearTimeout(aggBuf.timer);
      aggregationBuffers.delete(id);
    }
  });

  cached = { fakeSessions };
  return cached;
}

async function run(ctx) {
  const { fakeSessions } = lazyLoad();

  const first = fakeSessions[0];
  const beforePending = first.pendingEvents.length;
  const beforeWrites = first.writes.length;

  const start = performance.now();
  pushNotification({ type: 'completed', data: { taskId: `perf-task-${ctx.iter}`, status: 'completed', duration: 1 } });
  const elapsed = performance.now() - start;

  // Sanity: the first session must have received either a write (SSE frame) or a
  // pending event. If neither happened the fake session was not reached by
  // the dispatch path (wrong subscription wiring or missing sendSseEvent inject).
  const receivedWrite = first.writes.length > beforeWrites;
  const receivedEvent = first.pendingEvents.length > beforePending;

  if (!receivedWrite && !receivedEvent) {
    throw new Error(
      'sse-dispatch: pushNotification did not deliver to fake session[0] ' +
      `(writes ${first.writes.length}, events ${first.pendingEvents.length})`
    );
  }

  return { value: elapsed };
}

module.exports = {
  id: 'sse-dispatch',
  name: 'SSE notification dispatch (path B: in-process fake session x100)',
  category: 'request-latency',
  units: 'ms',
  warmup: 5,
  runs: 50,
  run,
};
