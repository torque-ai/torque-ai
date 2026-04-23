# MCP Restart Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a reconnect hint on every SSE session at graceful shutdown, and persist every session's filters to `task_event_subscriptions` so reconnects within 24h resume with their old filter state.

**Architecture:** Two call sites change, both inside `server/mcp-sse.js:stop()`. A loop over the live `sessions` map adds three things before the existing `session.res.end()`: a `notifications/message` MCP frame, a raw `retry: 2000\n\n` SSE directive, and an unconditional call to the existing `sessionMod.persistSubscription(id, session)`. No schema change; `persistSubscription` and `restoreSubscription` are already wired.

**Tech Stack:** Node.js, vitest, better-sqlite3 (indirect via existing `getDbInstance`), SSE (raw HTTP).

**Spec reference:** `docs/superpowers/specs/2026-04-23-mcp-restart-resilience-design.md`.

---

## File Structure

| File | Change | Responsibility |
|------|--------|---------------|
| `server/mcp-sse.js` | Modify `stop()` function (lines ~759-788) | Add shutdown hints + persistence call before `res.end()` |
| `server/tests/mcp-sse.test.js` | Add two new tests in a new `describe` block | Cover shutdown hint emission + persistence of all sessions |

No new files. No new exports. No schema migration.

---

### Task 1: Failing test — shutdown emits MCP notification and SSE retry directive

**Files:**
- Modify: `server/tests/mcp-sse.test.js` — add a new `describe('graceful shutdown', ...)` block near the end of the file, after the last existing describe block (check `describe('...')` lines near EOF and place after the last one).

- [ ] **Step 1: Read the existing test harness to confirm fixture shape**

Run: `grep -n "describe\|beforeAll\|afterAll\|createMockResponse" server/tests/mcp-sse.test.js | head -30`
Expected: confirms `createMockResponse()` is in scope, `mcpSse` is required in `beforeAll`, and tests access `mcpSse.sessions`, `mcpSse.stop()`, etc.

- [ ] **Step 2: Add the failing test**

Append this describe block to `server/tests/mcp-sse.test.js` after the last existing `describe(...)` block and before the outer closing `});` of `describe('MCP SSE Transport', () => {`:

```js
describe('graceful shutdown', () => {
  it('writes MCP server_restarting notification and SSE retry directive to every session before closing', async () => {
    // Start the server so the handler is captured (no-op if already started by earlier tests).
    await mcpSse.start({ port: 0 });

    // Seed two fake sessions directly in the map, each with a mock res.
    const seeded = [];
    for (let i = 0; i < 2; i++) {
      const { response } = createMockResponse();
      const sessionId = `shutdown-test-${i}-${Date.now()}`;
      const session = {
        keepaliveTimer: null,
        res: response,
        toolMode: 'core',
        authenticated: true,
        pendingEvents: [],
        eventFilter: new Set(['completed', 'failed']),
        taskFilter: new Set(),
        projectFilter: new Set(),
        providerFilter: new Set(),
        _sessionId: sessionId,
        _remoteAddress: null,
        _origin: null,
        _eventCounter: 0,
        _ip: null,
      };
      mcpSse.sessions.set(sessionId, session);
      seeded.push({ sessionId, response });
    }

    mcpSse.stop();

    for (const { response } of seeded) {
      const body = response.getBody();
      // Raw SSE retry directive — EventSource reconnect hint.
      expect(body).toContain('retry: 2000');
      // MCP JSON-RPC notification.
      const jsonMatches = [...body.matchAll(/event: message\ndata: (.*)\n/g)];
      const notifications = jsonMatches
        .map((m) => JSON.parse(m[1]))
        .filter((n) => n.method === 'notifications/message');
      const shutdownNotif = notifications.find(
        (n) => n?.params?.data?.type === 'server_restarting',
      );
      expect(shutdownNotif).toBeDefined();
      expect(shutdownNotif.params.data.retry_after_ms).toBe(2000);
      // res.end() must have been called.
      expect(response.writableEnded).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run the new test and verify it FAILS**

Run: `torque-remote npx vitest run server/tests/mcp-sse.test.js -t "writes MCP server_restarting"`
Expected: FAIL — the body will not contain `retry: 2000` and the `server_restarting` notification will be missing, because `stop()` doesn't send either today.

- [ ] **Step 4: Commit the failing test**

```bash
git add server/tests/mcp-sse.test.js
git commit -m "test(mcp-sse): assert shutdown emits server_restarting notification and retry directive"
```

---

### Task 2: Green — emit shutdown hints in `stop()`

**Files:**
- Modify: `server/mcp-sse.js` — edit the `stop()` function (currently around lines 759-788).

- [ ] **Step 1: Read the current `stop()` function**

Run: `sed -n '755,790p' server/mcp-sse.js`
Expected output (abbreviated):
```
function stop() {
  shutdownAbort.abort();

  if (sseServer) {
    clearAllTrackedIntervals();
    streamableHttpMod.stop();

    for (const [_id, session] of sessions) {
      clearTrackedInterval(session.keepaliveTimer);
      if (session.res && !session.res.writableEnded) {
        session.res.end();
      }
    }
    sessionMod.clearAllSessionState();
    ...
```

- [ ] **Step 2: Edit `stop()` to send the two hints before `res.end()`**

Using the Edit tool (or equivalent), replace:

```js
    for (const [_id, session] of sessions) {
      clearTrackedInterval(session.keepaliveTimer);
      if (session.res && !session.res.writableEnded) {
        session.res.end();
      }
    }
```

With:

```js
    for (const [_id, session] of sessions) {
      clearTrackedInterval(session.keepaliveTimer);
      if (session.res && !session.res.writableEnded) {
        // Reconnect hint 1: MCP protocol-level notification.
        try {
          sendJsonRpcNotification(session, 'notifications/message', {
            level: 'info',
            logger: 'torque',
            data: { type: 'server_restarting', retry_after_ms: 2000 },
          });
        } catch { /* best-effort */ }
        // Reconnect hint 2: native EventSource `retry:` directive.
        try { session.res.write('retry: 2000\n\n'); } catch { /* best-effort */ }
        session.res.end();
      }
    }
```

- [ ] **Step 3: Run the test from Task 1 and verify it PASSES**

Run: `torque-remote npx vitest run server/tests/mcp-sse.test.js -t "writes MCP server_restarting"`
Expected: PASS.

- [ ] **Step 4: Run the full `mcp-sse.test.js` suite to confirm no regressions**

Run: `torque-remote npx vitest run server/tests/mcp-sse.test.js`
Expected: all tests pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add server/mcp-sse.js
git commit -m "feat(mcp-sse): emit server_restarting notification and retry directive on graceful shutdown"
```

---

### Task 3: Failing test — shutdown persists every active session

**Files:**
- Modify: `server/tests/mcp-sse.test.js` — add a second test inside the existing `describe('graceful shutdown', ...)` block.

- [ ] **Step 1: Confirm `task_event_subscriptions` schema and `getDbInstance` availability in the test harness**

Run: `grep -n "task_event_subscriptions\|getDbInstance" server/tests/mcp-sse.test.js server/transports/sse/session.js | head -10`
Expected: `session.js` uses `getDbInstance()` for both persist and restore. The test file does not currently query the DB; it will need to import the database module for assertions.

Run: `grep -n "require.*database" server/tests/*.js | head -5`
Expected: multiple tests use `require('../database')` or `require('../db/...')` — pick the same pattern as neighbors.

- [ ] **Step 2: Add the second test**

Inside the existing `describe('graceful shutdown', () => { ... });` block added in Task 1, append this test:

```js
it('persists every active session to task_event_subscriptions before closing', async () => {
  const { getDbInstance } = require('../database');
  const db = getDbInstance();
  // Require a real DB. If tests don't normally have one, skip with a clear message —
  // but the existing session.js code already assumes getDbInstance() is callable.
  expect(db, 'database must be available for this test').toBeTruthy();

  await mcpSse.start({ port: 0 });

  const ids = [];
  // Session A — default filters, no task subscriptions.
  // Session B — custom event filter, no task subscriptions.
  // Session C — task subscription set.
  const configs = [
    { events: ['completed', 'failed'], tasks: [] },
    { events: ['completed', 'failed', 'cancelled'], tasks: [] },
    { events: ['completed', 'failed'], tasks: ['task-id-aaa', 'task-id-bbb'] },
  ];
  for (let i = 0; i < configs.length; i++) {
    const { response } = createMockResponse();
    const sessionId = `persist-shutdown-${i}-${Date.now()}`;
    ids.push(sessionId);
    mcpSse.sessions.set(sessionId, {
      keepaliveTimer: null,
      res: response,
      toolMode: 'core',
      authenticated: true,
      pendingEvents: [],
      eventFilter: new Set(configs[i].events),
      taskFilter: new Set(configs[i].tasks),
      projectFilter: new Set(),
      providerFilter: new Set(),
      _sessionId: sessionId,
      _remoteAddress: null,
      _origin: null,
      _eventCounter: 0,
      _ip: null,
    });
  }

  // Clear any prior rows for these ids so the test is hermetic.
  const clearStmt = db.prepare('DELETE FROM task_event_subscriptions WHERE id = ?');
  for (const id of ids) clearStmt.run(id);

  mcpSse.stop();

  // Every session must have a row written.
  const readStmt = db.prepare('SELECT id, task_id, event_types FROM task_event_subscriptions WHERE id = ?');
  for (let i = 0; i < ids.length; i++) {
    const row = readStmt.get(ids[i]);
    expect(row, `session ${ids[i]} should be persisted`).toBeTruthy();
    const events = JSON.parse(row.event_types);
    expect(events.sort()).toEqual([...configs[i].events].sort());
    if (configs[i].tasks.length > 0) {
      const tasks = JSON.parse(row.task_id);
      expect(tasks.sort()).toEqual([...configs[i].tasks].sort());
    } else {
      expect(row.task_id).toBeNull();
    }
  }

  // Cleanup.
  for (const id of ids) clearStmt.run(id);
});
```

- [ ] **Step 3: Run the new test and verify it FAILS**

Run: `torque-remote npx vitest run server/tests/mcp-sse.test.js -t "persists every active session"`
Expected: FAIL — `stop()` doesn't call `persistSubscription` today, so no rows are written.

- [ ] **Step 4: Commit the failing test**

```bash
git add server/tests/mcp-sse.test.js
git commit -m "test(mcp-sse): assert shutdown persists all active sessions to task_event_subscriptions"
```

---

### Task 4: Green — persist every session on shutdown

**Files:**
- Modify: `server/mcp-sse.js:stop()` — add `persistSubscription` call inside the shutdown loop.

- [ ] **Step 1: Edit `stop()` to persist each session before emitting hints**

Replace:

```js
    for (const [_id, session] of sessions) {
      clearTrackedInterval(session.keepaliveTimer);
      if (session.res && !session.res.writableEnded) {
        // Reconnect hint 1: MCP protocol-level notification.
        try {
          sendJsonRpcNotification(session, 'notifications/message', {
            level: 'info',
            logger: 'torque',
            data: { type: 'server_restarting', retry_after_ms: 2000 },
          });
        } catch { /* best-effort */ }
        // Reconnect hint 2: native EventSource `retry:` directive.
        try { session.res.write('retry: 2000\n\n'); } catch { /* best-effort */ }
        session.res.end();
      }
    }
```

With:

```js
    for (const [id, session] of sessions) {
      clearTrackedInterval(session.keepaliveTimer);
      // Persist filter state so a client reconnecting with this sessionId
      // within the TTL gets its subscription restored.
      try { sessionMod.persistSubscription(id, session); } catch { /* non-fatal */ }
      if (session.res && !session.res.writableEnded) {
        // Reconnect hint 1: MCP protocol-level notification.
        try {
          sendJsonRpcNotification(session, 'notifications/message', {
            level: 'info',
            logger: 'torque',
            data: { type: 'server_restarting', retry_after_ms: 2000 },
          });
        } catch { /* best-effort */ }
        // Reconnect hint 2: native EventSource `retry:` directive.
        try { session.res.write('retry: 2000\n\n'); } catch { /* best-effort */ }
        session.res.end();
      }
    }
```

Note: the loop variable was renamed from `_id` to `id` because we now use it.

- [ ] **Step 2: Run the Task 3 test and verify it PASSES**

Run: `torque-remote npx vitest run server/tests/mcp-sse.test.js -t "persists every active session"`
Expected: PASS.

- [ ] **Step 3: Run the full `mcp-sse.test.js` suite to confirm no regressions**

Run: `torque-remote npx vitest run server/tests/mcp-sse.test.js`
Expected: all tests pass.

- [ ] **Step 4: Run the broader SSE + session test surface to catch cross-file regressions**

Run: `torque-remote npx vitest run server/tests/mcp-sse.test.js server/tests/sse-session.test.js 2>&1 | tail -40`
(If `sse-session.test.js` does not exist, run just `mcp-sse.test.js`. The command fails gracefully either way — check for "No test files found" and drop the missing path if so.)
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/mcp-sse.js
git commit -m "feat(mcp-sse): persist every active session to task_event_subscriptions on graceful shutdown"
```

---

### Task 5: Integration verification via the full remote suite

**Files:** none modified.

- [ ] **Step 1: Push the branch so torque-remote can stage it (only needed if the remote falls back to origin ref)**

Run: `git push origin feat/mcp-restart-resilience`
Expected: push succeeds (pre-push gate does not run for feature branches).

- [ ] **Step 2: Run the remote full server test suite**

Run: `torque-remote npx vitest run server/tests/ 2>&1 | tail -60`
Expected: all green. If any unrelated tests fail, capture output and investigate — do not merge until resolved.

- [ ] **Step 3: If green, the branch is ready for cutover**

Cutover is the user's call, not this plan's. Stop here and report:
- Commits on `feat/mcp-restart-resilience`
- All tests green on remote
- Ready for `scripts/worktree-cutover.sh mcp-restart-resilience`
- Cutover will use the restart-barrier path and WILL disconnect the active MCP session mid-cutover; that's the first real-world test of the shutdown hints.

---

## Self-Review

**Spec coverage:**
- Goal 1 (reconnect hint on shutdown) → Tasks 1–2 (test + implementation).
- Goal 2 (persist filters on shutdown) → Tasks 3–4 (test + implementation).
- Non-goals (no schema change, no lastEventId, no client change) → respected; no task touches schema, `eventIdCounter`, or any client.

**Placeholder scan:** no TBDs, no "handle edge cases," every code block is concrete.

**Type consistency:**
- `sessionMod.persistSubscription(id, session)` — signature matches `persistSubscription(sessionId, session)` defined at `server/transports/sse/session.js:580`.
- `sendJsonRpcNotification(session, method, params)` — signature matches definition at `server/mcp-sse.js:211`.
- `notifications/message` params shape `{ level, logger, data }` matches the existing usage at `server/mcp-sse.js:~800` (model-discovered notifications).
- Test-side session object fields match the session creation shape at `server/mcp-sse.js:463-478`.
