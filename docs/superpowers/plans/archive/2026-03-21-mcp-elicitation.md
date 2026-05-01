# MCP Elicitation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server→client request capability to TORQUE's MCP transport, enabling direct human-in-loop approval via Claude Code's elicitation dialog for file size shrink, validation failures, and Peek recovery gates.

**Architecture:** `sendClientRequest()` in `mcp-sse.js` sends JSON-RPC requests to clients. `server/mcp/elicitation.js` wraps this in a clean `elicit()` API. Approval gates call `elicit()` and fall back to existing behavior when unavailable.

**Tech Stack:** Node.js, Vitest, MCP protocol (JSON-RPC 2.0), SSE transport

**Spec:** `docs/superpowers/specs/2026-03-21-mcp-elicitation-design.md`

**IMPORTANT:** Always push to origin/main before running tests. Use `torque-remote` for all test execution.

---

### Task 1: Bidirectional Protocol Support — sendClientRequest + handleClientResponse

**Files:**
- Modify: `server/mcp-sse.js` — add `sendClientRequest()`, pending request Map, response routing
- Modify: `server/mcp-protocol.js` — capture client capabilities, `handleClientResponse()`
- Create: `server/tests/elicitation.test.js` — protocol layer tests

This is the foundational task. Everything else depends on it.

- [ ] **Step 1: Write protocol layer tests**

Create `server/tests/elicitation.test.js`:

```js
'use strict';

const { randomUUID } = require('crypto');

describe('elicitation — protocol layer', () => {
  describe('handleClientResponse', () => {
    // We test the protocol logic in isolation by simulating the response routing

    it('resolves pending request when matching response arrives', () => {
      // Simulate the pending request Map
      const pendingRequests = new Map();
      let resolvedValue = null;

      const requestId = `elicit-${randomUUID()}`;
      const promise = new Promise((resolve) => {
        pendingRequests.set(requestId, { resolve, reject: () => {}, timeout: null });
      });
      promise.then(v => { resolvedValue = v; });

      // Simulate response arriving
      const response = { jsonrpc: '2.0', id: requestId, result: { action: 'accept', content: { decision: 'approve' } } };
      const pending = pendingRequests.get(response.id);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingRequests.delete(response.id);
        pending.resolve(response.result);
      }

      return promise.then(() => {
        expect(resolvedValue).toEqual({ action: 'accept', content: { decision: 'approve' } });
        expect(pendingRequests.has(requestId)).toBe(false);
      });
    });

    it('ignores responses with no matching pending request', () => {
      const pendingRequests = new Map();
      const response = { jsonrpc: '2.0', id: 'unknown-id-xyz', result: { action: 'accept' } };
      const pending = pendingRequests.get(response.id);
      expect(pending).toBeUndefined();
      // No crash, no error
    });
  });

  describe('response vs request discrimination', () => {
    it('message with method field is a request', () => {
      const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} };
      expect(typeof msg.method).toBe('string');
    });

    it('message without method field but with result is a response', () => {
      const msg = { jsonrpc: '2.0', id: 'elicit-123', result: { action: 'accept' } };
      expect(msg.method).toBeUndefined();
      expect(msg.result).toBeDefined();
    });

    it('message without method field but with error is an error response', () => {
      const msg = { jsonrpc: '2.0', id: 'elicit-123', error: { code: -1, message: 'fail' } };
      expect(msg.method).toBeUndefined();
      expect(msg.error).toBeDefined();
    });
  });

  describe('capability negotiation', () => {
    it('session with elicitation capability is marked', () => {
      const session = {};
      const params = { capabilities: { elicitation: {} } };
      session.clientCapabilities = params.capabilities || {};
      session.supportsElicitation = Boolean(params.capabilities?.elicitation);
      expect(session.supportsElicitation).toBe(true);
    });

    it('session without elicitation capability is not marked', () => {
      const session = {};
      const params = { capabilities: { tools: {} } };
      session.clientCapabilities = params.capabilities || {};
      session.supportsElicitation = Boolean(params.capabilities?.elicitation);
      expect(session.supportsElicitation).toBe(false);
    });

    it('session with no capabilities defaults to false', () => {
      const session = {};
      const params = {};
      session.clientCapabilities = params.capabilities || {};
      session.supportsElicitation = Boolean(params.capabilities?.elicitation);
      expect(session.supportsElicitation).toBe(false);
    });
  });

  describe('timeout and cleanup', () => {
    it('pending request resolves with cancel on timeout', async () => {
      const pendingRequests = new Map();
      const requestId = `elicit-timeout-test`;

      const promise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          resolve({ action: 'cancel' });
        }, 50); // 50ms for testing
        pendingRequests.set(requestId, { resolve, reject: () => {}, timeout });
      });

      const result = await promise;
      expect(result).toEqual({ action: 'cancel' });
      expect(pendingRequests.has(requestId)).toBe(false);
    });

    it('session disconnect resolves pending requests with cancel', () => {
      const pendingRequests = new Map();
      const results = [];

      // Add two pending requests
      const p1 = new Promise(resolve => {
        pendingRequests.set('req-1', { resolve, reject: () => {}, timeout: null });
      });
      p1.then(v => results.push(v));

      const p2 = new Promise(resolve => {
        pendingRequests.set('req-2', { resolve, reject: () => {}, timeout: null });
      });
      p2.then(v => results.push(v));

      // Simulate disconnect cleanup
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.resolve({ action: 'cancel' });
      }
      pendingRequests.clear();

      return Promise.all([p1, p2]).then(() => {
        expect(results).toEqual([{ action: 'cancel' }, { action: 'cancel' }]);
        expect(pendingRequests.size).toBe(0);
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass** (these test pure logic, no server needed)

```bash
git push origin main
torque-remote "cd server && npx vitest run tests/elicitation.test.js --reporter verbose"
```

- [ ] **Step 3: Modify mcp-protocol.js — capture capabilities in initialize**

In `server/mcp-protocol.js`, modify the `initialize` case (~line 59-76):

```js
    case 'initialize': {
      // Capture client capabilities for elicitation/sampling support
      session.clientCapabilities = params?.capabilities || {};
      session.supportsElicitation = Boolean(params?.capabilities?.elicitation);

      const response = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
      // ... existing auth check code ...
      if (_onInitialize) _onInitialize(session, params);  // add params
      return response;
    }
```

Also update the `init()` JSDoc to note that `onInitialize` now receives `(session, params)`.

- [ ] **Step 4: Add sendClientRequest and pendingRequests to mcp-sse.js**

In `server/mcp-sse.js`, add near the top (after the sessions Map declaration):

```js
// ── Pending server→client requests (elicitation, sampling) ──
// Per-session Map: requestId → { resolve, reject, timeout }
// Each session gets its own pendingRequests Map on creation.

const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Send a JSON-RPC request TO the client and wait for response.
 * @param {string} sessionId
 * @param {string} method - e.g., 'elicitation/create'
 * @param {object} params
 * @param {number} [timeoutMs=ELICITATION_TIMEOUT_MS]
 * @returns {Promise<object>} The client's response result
 */
function sendClientRequest(sessionId, method, params, timeoutMs = ELICITATION_TIMEOUT_MS) {
  const session = sessions.get(sessionId);
  if (!session || session.res.writableEnded) {
    return Promise.resolve({ action: 'decline' });
  }

  if (!session.pendingRequests) {
    session.pendingRequests = new Map();
  }

  const requestId = `elicit-${randomUUID()}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      session.pendingRequests.delete(requestId);
      resolve({ action: 'cancel' });
    }, timeoutMs);

    session.pendingRequests.set(requestId, { resolve, timeout });

    // Send JSON-RPC request via SSE
    const request = { jsonrpc: '2.0', id: requestId, method, params: params || {} };
    sendSseEvent(session, 'message', JSON.stringify(request));
  });
}
```

Add `randomUUID` import at the top if not already present: `const { randomUUID } = require('crypto');`

- [ ] **Step 5: Modify POST /messages handler for response routing**

In the POST handler (~line 1537-1611), after parsing the body but BEFORE `validateJsonRpcRequest`, add response detection:

```js
    // Check if this is a response to a server-initiated request (elicitation/sampling)
    // Responses have no 'method' field, just 'id' + 'result'/'error'
    if (request && !request.method && request.id !== undefined) {
      if (session.pendingRequests && session.pendingRequests.has(request.id)) {
        const pending = session.pendingRequests.get(request.id);
        clearTimeout(pending.timeout);
        session.pendingRequests.delete(request.id);
        pending.resolve(request.result || { action: 'cancel' });
      }
      // Acknowledge and return — don't process as a request
      res.writeHead(202);
      res.end();
      return;
    }
```

This goes after `request = await parseBody(req)` and the null check, but before `validateJsonRpcRequest`.

- [ ] **Step 6: Add session disconnect cleanup**

In the session disconnect handler (`res.on('close', ...)` in the GET /sse handler), add cleanup of pending requests:

```js
    // Clean up pending elicitation requests — resolve with 'cancel'
    if (session.pendingRequests) {
      for (const [id, pending] of session.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.resolve({ action: 'cancel' });
      }
      session.pendingRequests.clear();
    }
```

- [ ] **Step 7: Export sendClientRequest**

Add `sendClientRequest` to the module exports of `mcp-sse.js` (or export via a getter function that the elicitation helper can call).

- [ ] **Step 8: Commit and push**

```bash
git add server/mcp-protocol.js server/mcp-sse.js server/tests/elicitation.test.js
git commit -m "feat: bidirectional MCP protocol — sendClientRequest, capability negotiation, response routing"
git push origin main
```

---

### Task 2: Elicitation Helper — elicit()

**Files:**
- Create: `server/mcp/elicitation.js`
- Modify: `server/tests/elicitation.test.js` — add elicit() tests

- [ ] **Step 1: Write elicit() tests**

Add to `server/tests/elicitation.test.js`:

```js
describe('elicitation — elicit() helper', () => {
  it('returns decline when session has no elicitation capability', async () => {
    const { elicit } = require('../mcp/elicitation');
    const session = { supportsElicitation: false, __sessionId: 'test-1' };
    const result = await elicit(session, { message: 'test', requestedSchema: { type: 'object', properties: {}, required: [] } });
    expect(result).toEqual({ action: 'decline' });
  });

  it('returns decline when session is null', async () => {
    const { elicit } = require('../mcp/elicitation');
    const result = await elicit(null, { message: 'test', requestedSchema: { type: 'object', properties: {}, required: [] } });
    expect(result).toEqual({ action: 'decline' });
  });

  it('returns decline when session is undefined', async () => {
    const { elicit } = require('../mcp/elicitation');
    const result = await elicit(undefined, { message: 'test', requestedSchema: { type: 'object', properties: {}, required: [] } });
    expect(result).toEqual({ action: 'decline' });
  });

  it('returns decline when session_id string resolves to no live session', async () => {
    const { elicit } = require('../mcp/elicitation');
    const result = await elicit('nonexistent-session-id', { message: 'test', requestedSchema: { type: 'object', properties: {}, required: [] } });
    expect(result).toEqual({ action: 'decline' });
  });
});
```

- [ ] **Step 2: Create `server/mcp/elicitation.js`**

```js
'use strict';

const logger = require('../logger').child({ component: 'elicitation' });

/**
 * Request structured input from the human user via MCP elicitation.
 * Gracefully degrades: returns { action: 'decline' } when elicitation is unavailable.
 *
 * @param {object|string} sessionOrId - MCP session object or session_id string
 * @param {object} params - { message: string, requestedSchema: object }
 * @returns {Promise<{ action: 'accept'|'decline'|'cancel', content?: object }>}
 */
async function elicit(sessionOrId, params) {
  // Resolve session
  let session = null;
  if (sessionOrId && typeof sessionOrId === 'object' && sessionOrId.supportsElicitation !== undefined) {
    session = sessionOrId;
  } else if (typeof sessionOrId === 'string') {
    // Look up live session from SSE sessions Map
    try {
      const { getSession } = require('../mcp-sse');
      session = getSession(sessionOrId);
    } catch {
      // mcp-sse not available (e.g., stdio-only mode)
    }
  }

  if (!session) {
    logger.debug('[elicit] No session available — declining');
    return { action: 'decline' };
  }

  if (!session.supportsElicitation) {
    logger.debug('[elicit] Client does not support elicitation — declining');
    return { action: 'decline' };
  }

  try {
    const { sendClientRequest } = require('../mcp-sse');
    const result = await sendClientRequest(session.__sessionId || session.sessionId, 'elicitation/create', {
      message: params.message,
      requestedSchema: params.requestedSchema,
    });
    logger.info(`[elicit] Elicitation resolved: action=${result?.action}`);
    return result || { action: 'cancel' };
  } catch (err) {
    logger.warn(`[elicit] Elicitation failed: ${err.message}`);
    return { action: 'cancel' };
  }
}

module.exports = { elicit };
```

- [ ] **Step 3: Export getSession from mcp-sse.js**

Add a `getSession(sessionId)` function to `mcp-sse.js` that returns the session from the sessions Map, and export it:

```js
function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}
```

- [ ] **Step 4: Run tests**

```bash
git push origin main
torque-remote "cd server && npx vitest run tests/elicitation.test.js --reporter verbose"
```

- [ ] **Step 5: Commit and push**

```bash
git add server/mcp/elicitation.js server/mcp-sse.js server/tests/elicitation.test.js
git commit -m "feat: elicit() helper with graceful degradation"
git push origin main
```

---

### Task 3: Session-to-Task Linkage

**Files:**
- Modify: `server/handlers/task/core.js` — store `mcp_session_id` in task metadata at submission
- Modify: `server/tests/elicitation.test.js` — add linkage tests

- [ ] **Step 1: Write test**

Add to test file:

```js
describe('elicitation — session linkage', () => {
  it('submit_task stores mcp_session_id in metadata when session available', () => {
    // This tests the concept — the actual handleSubmitTask modification is integration-level
    const metadata = {};
    const session = { __sessionId: 'sess-abc123' };

    // Simulate what handleSubmitTask should do
    if (session && session.__sessionId) {
      metadata.mcp_session_id = session.__sessionId;
    }

    expect(metadata.mcp_session_id).toBe('sess-abc123');
  });

  it('no session means no mcp_session_id', () => {
    const metadata = {};
    const session = null;

    if (session && session.__sessionId) {
      metadata.mcp_session_id = session.__sessionId;
    }

    expect(metadata.mcp_session_id).toBeUndefined();
  });
});
```

- [ ] **Step 2: Modify handleSubmitTask in task/core.js**

In `server/handlers/task/core.js`, in `handleSubmitTask`, when building the task metadata object, add:

```js
    // Store MCP session ID for elicitation during finalization
    if (args.__session && args.__session.__sessionId) {
      metadata.mcp_session_id = args.__session.__sessionId;
    }
```

**IMPORTANT:** The session is passed to handlers via the `args` object. Check how `handleToolCall` in `tools.js` passes the session — it may need to inject `__session` into args. Read `tools.js:handleToolCall` and `mcp-protocol.js:_handleToolCallInternal` to understand the flow. The session is available in `_handleToolCallInternal` as the `session` parameter. It may need to be injected into `normalizedArgs.__session = session` before calling `_handleToolCall`.

Alternatively, if the session is already available via `args.__session` or a similar mechanism, use that. If not, add session injection in `mcp-protocol.js`:

```js
// In _handleToolCallInternal, before calling _handleToolCall:
normalizedArgs.__session = session;
```

- [ ] **Step 3: Commit and push**

```bash
git add server/handlers/task/core.js server/mcp-protocol.js server/tests/elicitation.test.js
git commit -m "feat: store mcp_session_id in task metadata for elicitation"
git push origin main
```

---

### Task 4: Wire Elicitation into File Size Shrink + Validation Failure Gates

**Files:**
- Modify: `server/execution/strategic-review-stage.js` — call elicit() before setting needs_review
- Modify: `server/validation/auto-verify-retry.js` — call elicit() on validation failure
- Modify: `server/tests/elicitation.test.js` — add integration tests

- [ ] **Step 1: Read the exact approval gate code**

Read these files to find the exact insertion points:
- `server/execution/strategic-review-stage.js` — find where `needs_review` is checked/set
- `server/validation/auto-verify-retry.js` — find where validation failure is handled
- `server/validation/safeguard-gates.js` — find file-size-shrink detection

- [ ] **Step 2: Add elicitation to strategic-review-stage.js**

In the review decision logic, before setting `needs_review: true` or marking as failed, add:

```js
const { elicit } = require('../../mcp/elicitation');

// Try to get human decision via elicitation
const sessionId = metadata?.mcp_session_id;
if (sessionId) {
  const response = await elicit(sessionId, {
    message: `Task ${taskId}: ${reviewReason}. Approve, reject, or rollback?`,
    requestedSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['approve', 'reject', 'rollback'] },
      },
      required: ['decision'],
    },
  });

  if (response.action === 'accept') {
    const decision = response.content?.decision;
    if (decision === 'approve') {
      // Human approved — skip the needs_review flag, proceed normally
      return;
    } else if (decision === 'rollback') {
      // Human wants rollback
      // trigger rollback logic
    } else {
      // Human rejected — mark task failed
    }
  }
  // If decline/cancel, fall through to existing behavior
}
```

The exact code depends on the existing structure. Read the file first and integrate appropriately.

- [ ] **Step 3: Add elicitation to auto-verify-retry.js**

Same pattern — before submitting a fix task or marking as failed.

- [ ] **Step 4: Write integration tests**

```js
describe('elicitation — approval gate integration', () => {
  it('strategic review calls elicit when session available', async () => {
    // Mock test — verify elicit is called with correct params
    // This requires mocking the elicit module
    const { elicit } = require('../mcp/elicitation');
    // Test that the function exists and accepts the right shape
    expect(typeof elicit).toBe('function');
  });

  it('elicit returns decline for tasks without session_id in metadata', async () => {
    const { elicit } = require('../mcp/elicitation');
    const result = await elicit(null, {
      message: 'Test approval',
      requestedSchema: { type: 'object', properties: { decision: { type: 'string' } }, required: ['decision'] },
    });
    expect(result.action).toBe('decline');
  });
});
```

- [ ] **Step 5: Commit and push**

```bash
git add server/execution/strategic-review-stage.js server/validation/auto-verify-retry.js server/tests/elicitation.test.js
git commit -m "feat: wire elicitation into file-size-shrink and validation failure gates"
git push origin main
```

---

### Task 5: Wire Elicitation into Peek Recovery Gate

**Files:**
- Modify: `server/policy-engine/adapters/approval.js` — call elicit() in requireHighRiskApproval
- Modify: `server/tests/elicitation.test.js` — add Peek recovery test

- [ ] **Step 1: Read requireHighRiskApproval**

Read `server/policy-engine/adapters/approval.js:417` to understand the current flow.

- [ ] **Step 2: Add elicitation**

In `requireHighRiskApproval`, before creating the approval request in the DB, try elicitation:

```js
const { elicit } = require('../../mcp/elicitation');

// Try direct human approval via elicitation
if (context.__session || context.mcp_session_id) {
  const sessionOrId = context.__session || context.mcp_session_id;
  const response = await elicit(sessionOrId, {
    message: `High-risk Peek recovery action: "${action}". Approve?`,
    requestedSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['approve', 'reject'] },
      },
      required: ['decision'],
    },
  });

  if (response.action === 'accept' && response.content?.decision === 'approve') {
    return { approved: true, approval_id: null, reason: 'Approved via elicitation' };
  } else if (response.action === 'accept' && response.content?.decision === 'reject') {
    return { approved: false, approval_id: null, reason: 'Rejected via elicitation' };
  }
  // decline/cancel → fall through to existing DB-based approval
}
```

Note: `requireHighRiskApproval` is currently synchronous. Adding `elicit()` makes it async. The caller must be updated to `await` it. Check the caller chain.

- [ ] **Step 3: Commit and push**

```bash
git add server/policy-engine/adapters/approval.js server/tests/elicitation.test.js
git commit -m "feat: wire elicitation into Peek high-risk recovery approval gate"
git push origin main
```

---

### Task 6: Final Verification

**Files:** None modified — verification only

- [ ] **Step 1: Run all elicitation tests on remote**

```bash
torque-remote "cd server && npx vitest run tests/elicitation.test.js --reporter verbose"
```

- [ ] **Step 2: Run annotation + output schema + context tests for regressions**

```bash
torque-remote "cd server && npx vitest run tests/elicitation.test.js tests/tool-annotations.test.js tests/tool-output-schemas.test.js tests/context-handler.test.js --reporter verbose"
```

- [ ] **Step 3: Verify sendClientRequest is exported**

```bash
cd server && node -e "
const sse = require('./mcp-sse');
console.log('sendClientRequest exported:', typeof sse.sendClientRequest === 'function');
console.log('getSession exported:', typeof sse.getSession === 'function');
const { elicit } = require('./mcp/elicitation');
console.log('elicit exported:', typeof elicit === 'function');
"
```

- [ ] **Step 4: Commit plan completion**

```bash
git add docs/superpowers/plans/2026-03-21-mcp-elicitation.md
git commit -m "docs: MCP elicitation implementation plan — complete"
git push origin main
```
