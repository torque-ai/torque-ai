# Architecture Phase 1: MCP Transport Unification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract shared MCP protocol logic into a single handler, making SSE the primary transport and stdio a thin proxy.

**Architecture:** Create `server/mcp-protocol.js` with the shared `initialize`, `tools/list`, `tools/call` dispatch. SSE delegates to it. Stdio becomes a ~50-line shim. Gateway deprecated.

**Tech Stack:** Node.js (CJS), Vitest, better-sqlite3

**Spec:** `docs/superpowers/specs/2026-03-19-architecture-remediation-design.md` (Phase 1)

**Verification:** Run on remote-gpu-host via `torque-remote`:
```bash
torque-remote npx vitest run
```

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `server/mcp-protocol.js` | **Create** | Shared MCP protocol handler — initialize, tools/list, tools/call, tool mode, unlock |
| `server/mcp-sse.js` | **Modify** | Thin SSE adapter — delegates protocol to mcp-protocol.js |
| `server/index.js` | **Modify** | Thin stdio adapter — delegates protocol to mcp-protocol.js |
| `server/mcp/index.js` | **Modify** | Add deprecation notice, optionally delegate to mcp-protocol.js |
| `server/tests/mcp-protocol.test.js` | **Create** | Unit tests for the shared protocol handler |

---

### Task 1: Create `mcp-protocol.js` with initialize + tools/list

Extract the shared protocol logic that is currently duplicated between `mcp-sse.js:1086-1141` and `index.js:1217-1261`.

**Files:**
- Create: `server/mcp-protocol.js`
- Create: `server/tests/mcp-protocol.test.js`

- [ ] **Step 1: Write tests for initialize and tools/list**

```js
// server/tests/mcp-protocol.test.js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');

describe('mcp-protocol', () => {
  let protocol;

  beforeEach(() => {
    protocol = require('../mcp-protocol');
    protocol.init({
      tools: [
        { name: 'submit_task', inputSchema: {} },
        { name: 'check_status', inputSchema: {} },
        { name: 'unlock_all_tools', inputSchema: {} },
      ],
      coreToolNames: ['submit_task', 'check_status', 'unlock_all_tools'],
      extendedToolNames: ['submit_task', 'check_status', 'unlock_all_tools'],
      handleToolCall: async (name, args) => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
  });

  describe('initialize', () => {
    it('returns protocol version and capabilities', async () => {
      const session = { toolMode: 'core' };
      const result = await protocol.handleRequest({ method: 'initialize', params: {} }, session);
      expect(result.protocolVersion).toBe('2024-11-05');
      expect(result.capabilities).toHaveProperty('tools');
      expect(result.serverInfo).toBeDefined();
    });
  });

  describe('tools/list', () => {
    it('returns all tools in full mode', async () => {
      const session = { toolMode: 'full' };
      const result = await protocol.handleRequest({ method: 'tools/list', params: {} }, session);
      expect(result.tools).toHaveLength(3);
    });

    it('filters to core tools in core mode', async () => {
      const session = { toolMode: 'core' };
      const result = await protocol.handleRequest({ method: 'tools/list', params: {} }, session);
      expect(result.tools.length).toBeLessThanOrEqual(3);
      result.tools.forEach(t => {
        expect(['submit_task', 'check_status', 'unlock_all_tools']).toContain(t.name);
      });
    });

    it('throws for unknown methods', async () => {
      const session = { toolMode: 'core' };
      await expect(protocol.handleRequest({ method: 'unknown/method' }, session))
        .rejects.toMatchObject({ code: -32601 });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /path/to/torque/server && npx vitest run tests/mcp-protocol.test.js --reporter=verbose
```

- [ ] **Step 3: Implement mcp-protocol.js with initialize + tools/list**

```js
// server/mcp-protocol.js
'use strict';

const SERVER_INFO = { name: 'torque', version: '1.0.0' };

let _tools = [];
let _coreToolNames = [];
let _extendedToolNames = [];
let _handleToolCall = null;
let _onInitialize = null;

function init({ tools, coreToolNames, extendedToolNames, handleToolCall, onInitialize }) {
  _tools = tools || [];
  _coreToolNames = coreToolNames || [];
  _extendedToolNames = extendedToolNames || [];
  _handleToolCall = handleToolCall;
  _onInitialize = onInitialize || null;
}

async function handleRequest(request, session) {
  if (!request || typeof request !== 'object') {
    throw { code: -32600, message: 'Invalid request: expected JSON object' };
  }
  const { method, params } = request;

  switch (method) {
    case 'initialize': {
      const response = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
      if (_onInitialize) _onInitialize(session);
      return response;
    }

    case 'tools/list': {
      if (session.toolMode === 'core' || session.toolMode === 'extended') {
        const allowedNames = session.toolMode === 'core' ? _coreToolNames : _extendedToolNames;
        const filtered = [];
        for (const name of allowedNames) {
          const tool = _tools.find(t => t.name === name);
          if (tool) filtered.push(tool);
        }
        return { tools: filtered };
      }
      return { tools: [..._tools] };
    }

    case 'tools/call':
      return await handleToolCall(params, session);

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

async function handleToolCall(params, session) {
  if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
    throw { code: -32602, message: 'Invalid params: "name" (string) is required' };
  }
  const { name, arguments: args } = params;
  const normalizedArgs = args || {};

  // Enforce tool mode at execution boundary
  if (session.toolMode !== 'full') {
    const allowedNames = session.toolMode === 'core' ? _coreToolNames : _extendedToolNames;
    if (!allowedNames.includes(name)) {
      return {
        content: [{ type: 'text', text: `Tool '${name}' is not available in ${session.toolMode} mode. Call 'unlock_all_tools' to access all tools.` }],
        isError: true,
      };
    }
  }

  if (!_handleToolCall) {
    throw { code: -32603, message: 'Protocol handler not initialized — call init() first' };
  }

  try {
    const result = await _handleToolCall(name, normalizedArgs, session);

    // Handle unlock responses
    if (result && (result.__unlock_all_tools || result.__unlock_tier)) {
      const newMode = result.__unlock_all_tools ? 'full'
        : (result.__unlock_tier <= 1 ? 'core' : result.__unlock_tier <= 2 ? 'extended' : 'full');
      if (newMode !== session.toolMode) {
        session.toolMode = newMode;
        session._toolsChanged = true; // Transport sends list_changed notification
      }
      return { content: result.content };
    }

    return result;
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message || err}` }],
      isError: true,
    };
  }
}

module.exports = { init, handleRequest, SERVER_INFO };
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add server/mcp-protocol.js server/tests/mcp-protocol.test.js
git commit -m "feat: extract shared MCP protocol handler (initialize + tools/list + tools/call)"
```

---

### Task 2: Add tools/call tests including unlock and mode enforcement

**Files:**
- Modify: `server/tests/mcp-protocol.test.js`

- [ ] **Step 1: Add tools/call test cases**

```js
describe('tools/call', () => {
  it('calls the tool handler with name and args', async () => {
    const session = { toolMode: 'full' };
    const result = await protocol.handleRequest({
      method: 'tools/call',
      params: { name: 'submit_task', arguments: { description: 'test' } },
    }, session);
    expect(result.content[0].text).toBe('ok');
  });

  it('blocks tools not in core mode', async () => {
    protocol.init({
      tools: [{ name: 'admin_tool', inputSchema: {} }],
      coreToolNames: ['submit_task'],
      extendedToolNames: ['submit_task', 'admin_tool'],
      handleToolCall: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const session = { toolMode: 'core' };
    const result = await protocol.handleRequest({
      method: 'tools/call',
      params: { name: 'admin_tool', arguments: {} },
    }, session);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not available in core mode');
  });

  it('updates session toolMode on unlock', async () => {
    protocol.init({
      tools: [],
      coreToolNames: ['unlock_all_tools'],
      extendedToolNames: [],
      handleToolCall: async () => ({ __unlock_all_tools: true, content: [{ type: 'text', text: 'unlocked' }] }),
    });
    const session = { toolMode: 'core' };
    await protocol.handleRequest({
      method: 'tools/call',
      params: { name: 'unlock_all_tools', arguments: {} },
    }, session);
    expect(session.toolMode).toBe('full');
    expect(session._toolsChanged).toBe(true);
  });

  it('returns error content on handler throw', async () => {
    protocol.init({
      tools: [],
      coreToolNames: [],
      extendedToolNames: [],
      handleToolCall: async () => { throw new Error('boom'); },
    });
    const session = { toolMode: 'full' };
    const result = await protocol.handleRequest({
      method: 'tools/call',
      params: { name: 'anything', arguments: {} },
    }, session);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom');
  });
});
```

- [ ] **Step 2: Run tests**

- [ ] **Step 3: Commit**

```bash
git add server/tests/mcp-protocol.test.js
git commit -m "test: add tools/call tests for mode enforcement, unlock, and error handling"
```

---

### Task 3: Wire SSE transport to use mcp-protocol.js

**Files:**
- Modify: `server/mcp-sse.js:1086-1200`

- [ ] **Step 1: Import mcp-protocol in mcp-sse.js**

At the top of `mcp-sse.js`, add:
```js
const mcpProtocol = require('./mcp-protocol');
```

- [ ] **Step 2: Initialize mcp-protocol during SSE server startup**

In the SSE `initialize()` function (or wherever the SSE server starts), add:
```js
mcpProtocol.init({
  tools: TOOLS,
  coreToolNames: CORE_TOOL_NAMES,
  extendedToolNames: EXTENDED_TOOL_NAMES,
  handleToolCall: async (name, args, session) => {
    // SSE-specific tool handling (subscribe_task_events, etc.) stays here
    if (SSE_TOOL_NAMES.has(name)) {
      if (name === 'subscribe_task_events') return handleSubscribeTaskEvents(session, args);
      if (name === 'check_notifications') return handleCheckNotifications(session);
      if (name === 'ack_notification') return handleAckNotification(session, args);
    }
    // Inject shutdown signal, then delegate to shared handleToolCall
    const argsWithSignal = { ...args, __shutdownSignal: shutdownAbort.signal };
    return handleToolCall(name, argsWithSignal);
  },
  onInitialize: (session) => {
    // Economy notification timer (moved from inline in handleMcpRequest)
    // ... existing economy timer logic
  },
});
```

- [ ] **Step 3: Replace handleMcpRequest's initialize/tools-list/tools-call with delegation**

In `handleMcpRequest` (line 1086), replace the `switch` cases for `initialize`, `tools/list`, and `tools/call` with:
```js
async function handleMcpRequest(request, session) {
  const { method } = request;

  // SSE-specific methods that need session context beyond what mcp-protocol provides
  if (method === 'tools/call') {
    const params = request.params || {};
    // SSE-only tools handled locally with full session context
    if (params.name && SSE_TOOL_NAMES.has(params.name)) {
      // ... existing SSE tool dispatch (subscribe, notifications, ack)
    }
  }

  // Delegate to shared protocol handler
  const result = await mcpProtocol.handleRequest(request, session);

  // SSE transport-specific: send tools/list_changed notification on unlock
  if (session._toolsChanged) {
    session._toolsChanged = false;
    sendJsonRpcNotification(session, 'notifications/tools/list_changed');
  }

  // SSE transport-specific: append SSE-only tools to tools/list response
  if (method === 'tools/list' && result && result.tools) {
    result.tools = [...result.tools, ...SSE_TOOLS];
  }

  return result;
}
```

- [ ] **Step 4: Run full SSE-related tests**

```bash
cd /path/to/torque/server && npx vitest run tests/mcp-protocol.test.js tests/mcp-sse*.test.js tests/mcp-index.test.js --reporter=verbose
```

- [ ] **Step 5: Commit**

```bash
git add server/mcp-sse.js server/mcp-protocol.js
git commit -m "refactor: wire SSE transport to shared mcp-protocol handler"
```

---

### Task 4: Wire stdio transport to use mcp-protocol.js

**Files:**
- Modify: `server/index.js:1217-1315`

- [ ] **Step 1: Import mcp-protocol in index.js**

Add near the top of `index.js`:
```js
const mcpProtocol = require('./mcp-protocol');
```

- [ ] **Step 2: Initialize mcp-protocol during server startup**

In `init()`, after tools are loaded, add:
```js
mcpProtocol.init({
  tools: getTools(),
  coreToolNames: CORE_TOOL_NAMES,
  extendedToolNames: EXTENDED_TOOL_NAMES,
  handleToolCall: async (name, args, _session) => callTool(name, args),
});
```

- [ ] **Step 3: Replace handleRequest with delegation to mcp-protocol**

Replace the entire `handleRequest` function (lines 1217-1261) and `handleToolCallRequest` (lines 1268-1315) with:
```js
// Virtual session for stdio (single-client)
const stdioSession = { toolMode: 'core' };

async function handleRequest(request) {
  const result = await mcpProtocol.handleRequest(request, stdioSession);

  // Stdio transport-specific: send tools/list_changed notification on unlock
  if (stdioSession._toolsChanged) {
    stdioSession._toolsChanged = false;
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    }) + '\n';
    process.stdout.write(notification);
  }

  return result;
}
```

This eliminates `handleToolCallRequest` entirely and removes the duplicate `toolMode` variable (replaced by `stdioSession.toolMode`).

- [ ] **Step 4: Remove the old module-level `toolMode` variable**

Find `let toolMode = 'core';` near the top of index.js and remove it — the mode now lives on `stdioSession.toolMode`.

- [ ] **Step 5: Run tests**

```bash
cd /path/to/torque/server && npx vitest run --reporter=verbose 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add server/index.js
git commit -m "refactor: wire stdio transport to shared mcp-protocol handler

Eliminates duplicate handleRequest/handleToolCallRequest. Tool mode
now lives on stdioSession object, managed by mcp-protocol."
```

---

### Task 5: Add deprecation notice to gateway transport

**Files:**
- Modify: `server/mcp/index.js`

- [ ] **Step 1: Add deprecation warning at module top**

```js
const logger = require('../logger').child({ component: 'mcp-gateway' });
logger.warn('MCP Gateway transport is deprecated. Use SSE transport (port 3458) instead. Gateway will be removed in a future release.');
```

- [ ] **Step 2: Add deprecation header to HTTP responses**

In the gateway's HTTP response handler, add:
```js
res.setHeader('Deprecation', 'true');
res.setHeader('Sunset', '2026-06-01');
res.setHeader('Link', '</sse>; rel="successor-version"');
```

- [ ] **Step 3: Commit**

```bash
git add server/mcp/index.js
git commit -m "deprecate: add deprecation notice to MCP gateway transport

SSE transport (port 3458) is the recommended replacement.
Gateway will be removed in a future release."
```

---

### Task 6: Final verification on Omen

- [ ] **Step 1: Push all changes**

```bash
git push origin main
```

- [ ] **Step 2: Run full server suite on Omen**

```bash
torque-remote npx vitest run
```

- [ ] **Step 3: Run dashboard suite on Omen**

```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\dashboard && npx vitest run 2>&1\"" | tail -5
```

- [ ] **Step 4: Manual verification — test MCP tools via both transports**

Verify that a Claude Code session can:
1. Connect via stdio (existing .mcp.json config)
2. Call `ping` tool → get response
3. Call `unlock_all_tools` → tool list expands
4. Submit a task → task appears in dashboard

**Gate passed → Phase 2 (DI Standardization) can begin.**
