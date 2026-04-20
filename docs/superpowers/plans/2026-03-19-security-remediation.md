# Security Remediation (Track A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TORQUE secure-by-default — auto-generated API key, protocol-layer auth, agent hardening, data protection, session security.

**Architecture:** Auth enforced at `mcp-protocol.js` (single point). Auto-generated API key on first run. Remote agents hardened with TLS, env whitelist, command whitelist. Backups integrity-verified. Enterprise roadmap documented.

**Tech Stack:** Node.js (CJS), Vitest, crypto, better-sqlite3

**Spec:** `docs/superpowers/specs/2026-03-19-security-remediation-design.md`

**Verification:** All tests on remote-gpu-host:
```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\server && npx vitest run tests/mcp-protocol.test.js tests/agent-server-security.test.js 2>&1\""
```

---

## Phase 1: Auth Foundation

### Task 1: Auto-generate API key on first startup

**Files:**
- Modify: `server/database.js` (init function)
- Modify: `server/db/config-core.js` (add key generation helper)
- Create: `server/tests/auth-key-generation.test.js`

- [x] **Step 1: Write test**

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');

describe('API key auto-generation', () => {
  it('generates a key when none exists', () => {
    const db = require('../database');
    // After init, api_key should exist
    const key = db.getConfig('api_key');
    expect(key).toBeTruthy();
    expect(key.length).toBeGreaterThanOrEqual(32);
  });

  it('does not overwrite existing key on restart', () => {
    const db = require('../database');
    const key1 = db.getConfig('api_key');
    // Simulate restart by calling the generation logic again
    const configCore = require('../db/config-core');
    configCore.ensureApiKey();
    const key2 = db.getConfig('api_key');
    expect(key2).toBe(key1);
  });
});
```

- [x] **Step 2: Add `ensureApiKey()` to config-core.js**

```js
function ensureApiKey() {
  const existing = getConfig('api_key');
  if (existing) return existing;
  const crypto = require('crypto');
  const key = crypto.randomUUID();
  setConfig('api_key', key);
  const logger = require('../logger');
  logger.info(`Generated API key: ${key}`);
  logger.info('Add to .mcp.json headers or set TORQUE_API_KEY env var');
  return key;
}
```

Export from config-core.js and wire through database.js exports.

- [x] **Step 3: Call `ensureApiKey()` during database init**

In `database.js:init()`, after schema setup and `_injectDbAll()`, add:
```js
configCore.ensureApiKey();
```

- [x] **Step 4: Verify syntax** — `node --check server/database.js && node --check server/db/config-core.js`

- [x] **Step 5: Commit**

```bash
git commit -m "security: auto-generate API key on first startup"
```

---

### Task 2: Enforce auth in mcp-protocol.js

**Files:**
- Modify: `server/mcp-protocol.js`
- Modify: `server/tests/mcp-protocol.test.js`

- [x] **Step 1: Add auth tests**

```js
describe('authentication', () => {
  it('rejects unauthenticated sessions', async () => {
    const session = { toolMode: 'core', authenticated: false };
    await expect(protocol.handleRequest({ method: 'tools/list' }, session))
      .rejects.toMatchObject({ code: -32600 });
  });

  it('allows authenticated sessions', async () => {
    const session = { toolMode: 'core', authenticated: true };
    const result = await protocol.handleRequest({ method: 'tools/list' }, session);
    expect(result.tools).toBeDefined();
  });

  it('allows initialize without auth (needed to establish connection)', async () => {
    const session = { toolMode: 'core', authenticated: false };
    const result = await protocol.handleRequest({ method: 'initialize' }, session);
    expect(result.protocolVersion).toBe('2024-11-05');
  });
});
```

- [x] **Step 2: Add auth check to handleRequest**

In `mcp-protocol.js`, at the top of `handleRequest()`, after the request validation:
```js
// Allow initialize without auth (client needs to connect first)
if (method !== 'initialize' && method !== 'notifications/initialized' && !session.authenticated) {
  throw { code: -32600, message: 'Authentication required. Provide API key via X-Torque-Key header.' };
}
```

- [x] **Step 3: Update existing tests** — add `authenticated: true` to all existing test sessions

- [x] **Step 4: Verify syntax** — `node --check server/mcp-protocol.js`

- [x] **Step 5: Commit**

```bash
git commit -m "security: enforce auth in mcp-protocol.js — reject unauthenticated sessions"
```

---

### Task 3: Wire auth into SSE and stdio transports

**Files:**
- Modify: `server/mcp-sse.js` (SSE session creation)
- Modify: `server/index.js` (stdio session)

- [x] **Step 1: SSE — authenticate on connection**

In `mcp-sse.js`, find the SSE connection handler (where sessions are created on `GET /sse`). Add auth check:
```js
// Check API key on SSE connection
const apiKey = req.headers['x-torque-key']
  || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
const expectedKey = serverConfig.get('api_key');

const isAuthenticated = !expectedKey || (apiKey && verifyApiKey(apiKey, expectedKey));

// Set on the session object — mcp-protocol.js checks this
session.authenticated = isAuthenticated;
```

Add a `verifyApiKey` helper using `crypto.timingSafeEqual`:
```js
function verifyApiKey(provided, expected) {
  const crypto = require('crypto');
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
```

- [x] **Step 2: SSE — require auth on reconnect**

When a client reconnects with `?sessionId=...`, also check the API key. Don't allow session hijacking via known session ID.

- [x] **Step 3: Stdio — auto-authenticate**

In `index.js`, the `stdioSession` object:
```js
const stdioSession = { toolMode: 'core', authenticated: true };
```

Stdio is a trusted pipe — always authenticated.

- [x] **Step 4: Verify syntax** — `node --check server/mcp-sse.js && node --check server/index.js`

- [x] **Step 5: Commit**

```bash
git commit -m "security: wire auth into SSE (key required) and stdio (auto-authenticated)"
```

---

### Task 4: Security banner for unconfigured installs

**Files:**
- Modify: `server/mcp-protocol.js` (initialize response)
- Modify: `dashboard/src/components/Layout.jsx` (banner)
- Modify: `server/api-server.core.js` (startup warning)

- [x] **Step 1: Add security_warning to initialize response**

In `mcp-protocol.js`, in the `initialize` case, check if auth is configured:
```js
case 'initialize': {
  const response = {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  };
  // Warn if no API key is configured
  if (!_isAuthConfigured || !_isAuthConfigured()) {
    response._meta = { security_warning: 'TORQUE is running without authentication. Run configure to set an API key.' };
  }
  // ...
}
```

Add `isAuthConfigured` to the init options.

- [x] **Step 2: Add dashboard security banner**

In `Layout.jsx`, fetch auth status from `/api/v2/health` and show a yellow banner if `security_warning` is present.

- [x] **Step 3: Add startup log warning**

In `index.js` init, after database init:
```js
if (!db.getConfig('api_key')) {
  logger.warn('⚠ TORQUE is running without authentication. Set an API key via configure tool.');
}
```

- [x] **Step 4: Verify syntax**

- [x] **Step 5: Commit**

```bash
git commit -m "security: add security banner for unconfigured auth installations"
```

---

## Phase 2: Remote Agent Hardening

### Task 5: Env var whitelist + command whitelist on server-side agent

**Files:**
- Modify: `server/remote/agent-server.js`
- Modify: `server/tests/agent-server-security.test.js`

- [ ] **Step 1: Add env whitelist tests**

```js
describe('normalizeEnv — env var whitelist', () => {
  it('blocks LD_PRELOAD', () => {
    const { normalizeEnv } = require('../remote/agent-server');
    const env = normalizeEnv({ LD_PRELOAD: '/tmp/evil.so', NODE_ENV: 'test' });
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.NODE_ENV).toBe('test');
  });

  it('blocks NODE_OPTIONS', () => {
    const { normalizeEnv } = require('../remote/agent-server');
    const env = normalizeEnv({ NODE_OPTIONS: '--require=/tmp/evil.js' });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('allows TORQUE_ prefixed vars', () => {
    const { normalizeEnv } = require('../remote/agent-server');
    const env = normalizeEnv({ TORQUE_DATA_DIR: '/tmp/data' });
    expect(env.TORQUE_DATA_DIR).toBe('/tmp/data');
  });
});

describe('command whitelist', () => {
  it('rejects commands not on allowlist', () => {
    // Test through validateRunRequest or a new validateCommand function
  });
});
```

- [ ] **Step 2: Add env whitelist to normalizeEnv**

```js
const BLOCKED_ENV_VARS = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE',
]);
const ALLOWED_ENV_VARS = new Set([
  'NODE_ENV', 'DEBUG', 'HOME', 'USERPROFILE', 'TEMP', 'TMP',
]);
const ALLOWED_PREFIXES = ['TORQUE_', 'OLLAMA_'];

function normalizeEnv(extraEnv = {}) {
  const merged = { ...process.env };
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (BLOCKED_ENV_VARS.has(key)) continue;
    if (!ALLOWED_ENV_VARS.has(key) && !ALLOWED_PREFIXES.some(p => key.startsWith(p))) continue;
    if (value === undefined || value === null) { delete merged[key]; continue; }
    merged[key] = String(value);
  }
  return merged;
}
```

- [ ] **Step 3: Add command whitelist**

```js
const DEFAULT_ALLOWED_COMMANDS = new Set([
  'node', 'npm', 'npx', 'git', 'dotnet', 'cargo', 'python', 'pip', 'python3',
]);

// In validateRunRequest, add:
const command = body.command || (Array.isArray(body.args) ? body.args[0] : '');
const executable = path.basename(command).replace(/\.(cmd|exe|bat)$/i, '');
if (!state.allowedCommands.has(executable) && !DEFAULT_ALLOWED_COMMANDS.has(executable)) {
  throw createHttpError(`Command not allowed: ${executable}`, 403);
}
```

- [ ] **Step 4: Add output cap to spawnAndCapture**

```js
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
// In stdout/stderr handlers:
if (stdout.length > MAX_CAPTURE_BYTES) {
  stdout = '[...truncated...]\n' + stdout.slice(-MAX_CAPTURE_BYTES);
}
```

- [ ] **Step 5: Verify on Omen**

```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\server && npx vitest run tests/agent-server-security.test.js 2>&1\""
```

- [ ] **Step 6: Commit**

```bash
git commit -m "security: add env whitelist, command whitelist, and output cap to server-side agent"
```

---

### Task 6: TLS default for agent connections

**Files:**
- Modify: `server/remote/agent-registry.js`
- Modify: `server/remote/agent-client.js`

- [ ] **Step 1: Change TLS default**

In `agent-registry.js:register()`:
```js
// BEFORE:
register({ ..., tls = false, rejectUnauthorized = true }) {
// AFTER:
register({ ..., tls = true, rejectUnauthorized = true }) {
```

- [ ] **Step 2: Add deprecation warning for plaintext agents**

In `agent-client.js`, when `tls` is false:
```js
if (!this.tls) {
  logger.warn(`Agent ${this.host}:${this.port} connected without TLS — credentials transmitted in plaintext`);
}
```

- [ ] **Step 3: Verify syntax** — `node --check server/remote/agent-registry.js`

- [ ] **Step 4: Commit**

```bash
git commit -m "security: make TLS default for agent connections, warn on plaintext"
```

---

## Phase 3: Data Protection

### Task 7: Backup integrity verification

**Files:**
- Modify: `server/db/backup-core.js`
- Create: `server/tests/backup-integrity.test.js`

- [ ] **Step 1: Write tests**

```js
describe('backup integrity', () => {
  it('creates SHA-256 hash file alongside backup', () => {
    // Create backup, verify .sha256 file exists
  });

  it('rejects restore of tampered backup', () => {
    // Create backup, modify backup file, attempt restore
    // Expect: throws with integrity error
  });

  it('allows restore with valid hash', () => {
    // Create backup, restore, verify success
  });

  it('allows force restore without hash', () => {
    // Delete hash file, restore with force=true
  });
});
```

- [ ] **Step 2: Add hash generation to backupDatabase**

After `fs.writeFileSync(backupPath, buffer)`:
```js
const hash = crypto.createHash('sha256').update(buffer).digest('hex');
fs.writeFileSync(backupPath + '.sha256', hash, 'utf-8');
```

- [ ] **Step 3: Add hash verification to restoreDatabase**

Before restoring:
```js
const hashPath = backupPath + '.sha256';
if (!force) {
  if (!fs.existsSync(hashPath)) {
    throw new Error('Backup integrity file missing. Use --force to restore without verification.');
  }
  const expectedHash = fs.readFileSync(hashPath, 'utf-8').trim();
  const backupBuffer = fs.readFileSync(backupPath);
  const actualHash = crypto.createHash('sha256').update(backupBuffer).digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error('Backup integrity check failed — file may be corrupted or tampered.');
  }
}
```

- [ ] **Step 4: Verify on Omen**

- [ ] **Step 5: Commit**

```bash
git commit -m "security: add SHA-256 integrity verification to backup/restore"
```

---

### Task 8: DB permissions + secret redaction + protected config

**Files:**
- Modify: `server/database.js` (Windows permissions)
- Modify: `server/utils/sanitize.js` (extend redaction)
- Modify: `server/db/config-core.js` (protected keys)

- [ ] **Step 1: Fix Windows DB permissions**

In `database.js:init()`, after opening the DB:
```js
if (process.platform === 'win32') {
  try {
    const { execFileSync } = require('child_process');
    execFileSync('icacls', [DB_PATH, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(F)`], { stdio: 'pipe' });
  } catch (err) {
    logger.warn('Could not set DB file permissions: ' + err.message);
  }
}
```

- [ ] **Step 2: Extend secret redaction**

In `server/utils/sanitize.js`, add patterns:
```js
// Agent secrets
/scrypt:[0-9a-f]{32}:[0-9a-f]{64}/g,
// Auth headers in logged objects
/X-Torque-Key:\s*\S+/gi,
/X-Torque-Secret:\s*\S+/gi,
/Authorization:\s*Bearer\s+\S+/gi,
```

- [ ] **Step 3: Add protected config keys**

In `config-core.js`:
```js
const PROTECTED_CONFIG_KEYS = new Set([
  'api_key', 'v2_auth_mode', 'scheduling_mode', 'max_concurrent',
]);

// In setConfig, add audit logging for protected keys:
if (PROTECTED_CONFIG_KEYS.has(key)) {
  logger.info(`Protected config changed: ${key} (value redacted)`);
}
```

- [ ] **Step 4: Verify syntax**

- [ ] **Step 5: Commit**

```bash
git commit -m "security: Windows DB permissions, extended secret redaction, protected config keys"
```

---

## Phase 4: Session & Network Hardening

### Task 9: SSE session auth + per-IP limits

**Files:**
- Modify: `server/mcp-sse.js`
- Modify: `server/dashboard-server.js` (WebSocket per-IP)

- [ ] **Step 1: Add per-IP tracking to SSE**

```js
const perIpSessionCount = new Map();
const MAX_SESSIONS_PER_IP = 10;

// In session creation:
const ip = req.socket.remoteAddress;
const current = perIpSessionCount.get(ip) || 0;
if (current >= MAX_SESSIONS_PER_IP) {
  res.writeHead(429, { 'Content-Type': 'text/plain' });
  res.end('Too many sessions from this IP');
  return;
}
perIpSessionCount.set(ip, current + 1);

// In session cleanup:
const count = perIpSessionCount.get(session.ip) || 1;
perIpSessionCount.set(session.ip, count - 1);
```

- [ ] **Step 2: Add per-IP tracking to WebSocket**

Same pattern in `dashboard-server.js` with `MAX_WS_PER_IP = 20`.

- [ ] **Step 3: Require auth on SSE reconnect**

In the reconnection handler (where `?sessionId=` is checked), also verify the API key matches.

- [ ] **Step 4: Verify syntax**

- [ ] **Step 5: Commit**

```bash
git commit -m "security: per-IP connection limits for SSE and WebSocket, auth on SSE reconnect"
```

---

### Task 10: CORS strict-by-default + rate limiting

**Files:**
- Modify: `server/mcp-sse.js` (CORS)
- Modify: `server/api-server.core.js` (CORS)

- [ ] **Step 1: Tighten SSE CORS**

In `mcp-sse.js`, update `DEFAULT_MCP_ALLOWED_ORIGINS` to only include the dashboard:
```js
const dashboardPort = serverConfig.getInt('dashboard_port', 3456);
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${dashboardPort}`,
  `http://localhost:${dashboardPort}`,
]);
```

- [ ] **Step 2: Cap total subscriptions per session**

```js
const MAX_SUBSCRIPTIONS_PER_SESSION = 200;
// In handleSubscribeTaskEvents:
if (session.taskFilter && session.taskFilter.size >= MAX_SUBSCRIPTIONS_PER_SESSION) {
  return { content: [{ type: 'text', text: 'Subscription limit reached (200)' }], isError: true };
}
```

- [ ] **Step 3: Add body parser timeout**

In SSE `parseBody`, add a 30-second timeout:
```js
const bodyTimeout = setTimeout(() => {
  req.destroy(new Error('Body parse timeout'));
}, 30000);
// Clear on completion:
clearTimeout(bodyTimeout);
```

- [ ] **Step 4: Verify syntax**

- [ ] **Step 5: Commit**

```bash
git commit -m "security: strict CORS, subscription cap, body parser timeout"
```

---

## Phase 5: Enterprise Documentation

### Task 11: Write enterprise security roadmap

**Files:**
- Create: `docs/enterprise-security-roadmap.md`

- [ ] **Step 1: Write the document**

Cover: mTLS, HMAC signing, OAuth2/OIDC, JWT sessions, granular key scoping, RBAC, project isolation, multi-tenancy, audit logging, immutable trails, data retention, secret rotation, TLS everywhere, interface binding, API gateway integration.

Structure as a feature matrix with effort estimates and dependency ordering.

- [ ] **Step 2: Commit**

```bash
git commit -m "docs: add enterprise security roadmap for future multi-user deployment"
```

---

## Final Verification

- [ ] **Push all changes**

```bash
git push origin main
```

- [ ] **Run full test suite on Omen**

```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public && git pull origin main && cd server && npx vitest run tests/mcp-protocol.test.js tests/agent-server-security.test.js tests/backup-integrity.test.js tests/auth-key-generation.test.js 2>&1\""
```

- [ ] **Manual verification: test MCP auth flow**

1. Start TORQUE fresh (new DB)
2. Verify API key is printed to stdout
3. Connect via SSE without key → expect rejection
4. Connect via SSE with key → expect success
5. Stdio should work without key (auto-authenticated)

**Gate passed → Track A Security complete. Tracks C, D, E can proceed.**
