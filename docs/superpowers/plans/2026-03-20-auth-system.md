# Auth System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TORQUE's inline auth checks with a pluggable auth system supporting API keys (HMAC-SHA-256), ticket exchange for SSE, dashboard login with cookies + CSRF, and rate limiting — while maintaining open mode for fresh installs.

**Architecture:** New `server/auth/` module with 6 focused files. Auth middleware extracts credentials per-transport, dispatches to typed resolvers. SSE uses ticket exchange or `?apiKey=` bootstrap. Dashboard gets a login page with cookie sessions. REST API uses `Authorization: Bearer` header. All transports converge on the same identity model.

**Tech Stack:** Node.js (CJS), crypto (HMAC-SHA-256), SQLite (better-sqlite3), Vitest

**Spec:** `docs/superpowers/specs/2026-03-20-auth-system-design.md`

**Prerequisites / Conflicts with Remediation Plans:**

This plan modifies 6 files that are also targets of `2026-03-20-round2-remediation.md`. **Execute Round 2 remediation BEFORE this plan.**

| File | Remediation Impact | Auth Plan Must... |
|------|-------------------|-------------------|
| `server/api/middleware.js` | Round 1 added `settled` flag to body parsers (commit `3df4694`) | Preserve the `settled` flag pattern when replacing `checkAuth` with `authenticateRequest` in Task 5 |
| `server/api/routes.js` | Round 1 added `skipAuth: true` to bootstrap (commit `d184a33`) | Add `/api/bootstrap/workstation` to `OPEN_PATHS` list in Task 5 |
| `server/mcp-sse.js` | Round 2 fixes HSTS removal, subscription limits, IP bucket, timer tracking, listener cleanup | Run AFTER Round 2 Phase 1.3 + 3.1. Auth changes (~line 1349) are separate from those fix areas. |
| `server/index.js` | Round 2 fixes orphan mode dead code, overload guard, configCore cleanup | Place keyManager init AFTER db init, BEFORE MCP transport start. Don't conflict with orphan-mode deletion. |
| `server/db/schema-tables.js` | Round 2 adds 23 columns to `tasks`, adds indexes, FKs | No conflict — `api_keys` table is in a separate section |
| `server/db/schema-migrations.js` | Round 2 fixes `policy_overrides.reason_code` | No conflict — different migration entries |

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/auth/key-manager.js` | Create | Key CRUD, HMAC hashing, server secret, migration |
| `server/auth/resolvers.js` | Create | API key, session, ticket resolvers |
| `server/auth/middleware.js` | Create | Credential extraction, resolver dispatch, role enforcement |
| `server/auth/ticket-manager.js` | Create | SSE ticket exchange (in-memory, single-use, TTL) |
| `server/auth/session-manager.js` | Create | Dashboard cookie sessions + CSRF tokens |
| `server/auth/rate-limiter.js` | Create | Per-IP rate limiting for auth endpoints |
| `server/db/schema-tables.js` | Modify | Add `api_keys` table |
| `server/db/schema-migrations.js` | Modify | Migrate `config.api_key`, generate server secret |
| `server/mcp-sse.js` | Modify | Use auth middleware for SSE connect |
| `server/mcp-protocol.js` | Modify | Use auth middleware instead of inline check |
| `server/api/routes.js` | Modify | Add `/api/auth/*` routes |
| `server/api/middleware.js` | Modify | Add REST API auth middleware |
| `server/tool-defs/auth-defs.js` | Create | MCP tool definitions for key management |
| `server/handlers/auth-handlers.js` | Create | MCP tool handlers |
| `dashboard/src/components/Login.jsx` | Create | Login page component |
| `dashboard/src/App.jsx` | Modify | Add login route + auth guard |
| `server/tests/auth-system.test.js` | Create | All auth tests |

---

## Task 1: Key Manager — HMAC Hashing and CRUD

**Files:**
- Create: `server/auth/key-manager.js`
- Modify: `server/db/schema-tables.js`
- Modify: `server/db/schema-migrations.js`
- Create: `server/tests/auth-system.test.js`

The foundation — key storage, hashing, and the `api_keys` table.

- [ ] **Step 1: Write failing tests**

Create `server/tests/auth-system.test.js`:

```javascript
const { describe, it, expect, beforeEach, afterEach } = require('vitest');

describe('key-manager', () => {
  // Setup: use setupTestDb pattern from existing tests

  it('generateServerSecret creates a 256-bit hex secret', () => {
    // Call generateServerSecret, verify length is 64 hex chars
  });

  it('createKey returns plaintext key with torque_sk_ prefix', () => {
    // Create key, verify prefix, verify it's a UUID after prefix
  });

  it('createKey stores HMAC-SHA-256 hash, not plaintext', () => {
    // Create key, read from DB, verify key_hash !== plaintext
    // Verify key_hash matches HMAC-SHA-256(plaintext, serverSecret)
  });

  it('validateKey returns identity for valid key', () => {
    // Create key, then validate the plaintext → should return { id, name, role }
  });

  it('validateKey returns null for invalid key', () => {
    // Validate a random string → null
  });

  it('validateKey returns null for revoked key', () => {
    // Create key, revoke it, validate → null
  });

  it('revokeKey prevents last admin key from being revoked', () => {
    // Create one admin key, attempt revoke → should throw/return error
  });

  it('listKeys never exposes key_hash', () => {
    // Create key, list keys, verify no hash or plaintext in response
  });

  it('migrateConfigApiKey moves existing key to api_keys table', () => {
    // Set config.api_key to a plaintext value
    // Call migrateConfigApiKey
    // Verify api_keys has one row, config.api_key is cleared
    // Verify the original plaintext still validates
  });
});
```

- [ ] **Step 2: Add `api_keys` table to schema**

In `server/db/schema-tables.js`, add:

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
)
```

In `server/db/schema-migrations.js`, add migration to generate `auth_server_secret` if not exists and migrate `config.api_key` if present.

- [ ] **Step 3: Implement key-manager.js**

Create `server/auth/key-manager.js` with:

```javascript
const crypto = require('crypto');

let _db = null;
let _serverSecret = null;

function init(db) { _db = db; }

function getServerSecret() {
  if (_serverSecret) return _serverSecret;
  let secret = _db.getConfig('auth_server_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    _db.setConfig('auth_server_secret', secret);
  }
  _serverSecret = secret;
  return secret;
}

function hashKey(plaintext) {
  return crypto.createHmac('sha256', getServerSecret()).update(plaintext).digest('hex');
}

function createKey({ name, role = 'admin' }) {
  const id = crypto.randomUUID();
  const plaintext = `torque_sk_${crypto.randomUUID()}`;
  const keyHash = hashKey(plaintext);
  _db.prepare(`INSERT INTO api_keys (id, key_hash, name, role) VALUES (?, ?, ?, ?)`)
    .run(id, keyHash, name, role);
  return { id, key: plaintext, name, role }; // plaintext returned ONCE
}

function validateKey(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return null;
  const keyHash = hashKey(plaintext);
  const row = _db.prepare(`SELECT id, name, role FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`).get(keyHash);
  if (!row) return null;
  // Batched last_used_at update (at most once per minute)
  // ... (check row.last_used_at, update if >60s ago)
  return { id: row.id, name: row.name, role: row.role };
}

function revokeKey(id) {
  // Check if this is the last admin key
  const adminCount = _db.prepare(`SELECT COUNT(*) as c FROM api_keys WHERE role = 'admin' AND revoked_at IS NULL`).get().c;
  const target = _db.prepare(`SELECT role FROM api_keys WHERE id = ? AND revoked_at IS NULL`).get(id);
  if (target?.role === 'admin' && adminCount <= 1) {
    throw new Error('Cannot revoke the last admin key. Create another admin key first.');
  }
  _db.prepare(`UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?`).run(id);
}

function listKeys() {
  return _db.prepare(`SELECT id, name, role, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC`).all();
}

function hasAnyKeys() {
  const row = _db.prepare(`SELECT COUNT(*) as c FROM api_keys WHERE revoked_at IS NULL`).get();
  return row.c > 0;
}

function migrateConfigApiKey() {
  const existing = _db.getConfig('api_key');
  if (!existing || hasAnyKeys()) return null;
  const id = crypto.randomUUID();
  const keyHash = hashKey(existing);
  _db.prepare(`INSERT INTO api_keys (id, key_hash, name, role) VALUES (?, ?, ?, ?)`)
    .run(id, keyHash, 'Migrated key', 'admin');
  _db.setConfig('api_key', null);
  return id;
}

module.exports = { init, createKey, validateKey, revokeKey, listKeys, hasAnyKeys, hashKey, getServerSecret, migrateConfigApiKey };
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
torque-remote npx vitest run server/tests/auth-system.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server/auth/key-manager.js server/db/schema-tables.js server/db/schema-migrations.js server/tests/auth-system.test.js
git commit -m "feat(auth): key manager with HMAC-SHA-256 hashing, CRUD, and migration"
```

---

## Task 2: Ticket Manager and Session Manager

**Files:**
- Create: `server/auth/ticket-manager.js`
- Create: `server/auth/session-manager.js`
- Append to: `server/tests/auth-system.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/tests/auth-system.test.js`:

```javascript
describe('ticket-manager', () => {
  it('createTicket returns a UUID', () => {});
  it('consumeTicket returns identity and invalidates ticket', () => {});
  it('consumeTicket fails on second use (single-use)', () => {});
  it('consumeTicket fails after TTL expires', () => {});
  it('createTicket rejects when cap (100) is reached', () => {});
});

describe('session-manager', () => {
  it('createSession returns session_id and csrf_token', () => {});
  it('getSession returns identity for valid session', () => {});
  it('getSession returns null for expired session', () => {});
  it('destroySession removes the session', () => {});
  it('createSession evicts LRU when cap (50) is reached', () => {});
  it('createSession on re-login regenerates session ID', () => {});
  it('validateCsrf rejects mismatched token', () => {});
});
```

- [ ] **Step 2: Implement ticket-manager.js**

In-memory Map of ticket → { identity, createdAt }. UUID tickets, 30s TTL, single-use, 100 cap.

```javascript
const tickets = new Map();
const MAX_TICKETS = 100;
const TICKET_TTL_MS = 30000;

function createTicket(identity) {
  if (tickets.size >= MAX_TICKETS) throw new Error('Ticket cap reached');
  const ticket = crypto.randomUUID();
  tickets.set(ticket, { identity, createdAt: Date.now() });
  return ticket;
}

function consumeTicket(ticket) {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket); // single-use
  if (Date.now() - entry.createdAt > TICKET_TTL_MS) return null; // expired
  return entry.identity;
}
```

- [ ] **Step 3: Implement session-manager.js**

In-memory Map. Cookie sessions, 24h sliding expiry, 50 cap with LRU eviction, CSRF tokens.

```javascript
const sessions = new Map();
const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function createSession(identity) {
  // Evict LRU if at cap
  if (sessions.size >= MAX_SESSIONS) { /* find + delete oldest */ }
  const sessionId = crypto.randomUUID();
  const csrfToken = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionId, { identity, csrfToken, lastAccess: Date.now() });
  return { sessionId, csrfToken };
}

function getSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.lastAccess > SESSION_TTL_MS) { sessions.delete(sessionId); return null; }
  entry.lastAccess = Date.now(); // sliding window
  return entry;
}

function validateCsrf(sessionId, csrfToken) {
  const entry = sessions.get(sessionId);
  return entry && entry.csrfToken === csrfToken;
}
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```bash
git add server/auth/ticket-manager.js server/auth/session-manager.js server/tests/auth-system.test.js
git commit -m "feat(auth): ticket exchange and session manager with CSRF"
```

---

## Task 3: Auth Middleware and Resolvers

**Files:**
- Create: `server/auth/resolvers.js`
- Create: `server/auth/middleware.js`
- Create: `server/auth/rate-limiter.js`
- Append to: `server/tests/auth-system.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
describe('auth middleware', () => {
  it('open mode allows all requests when no keys exist', () => {});
  it('rejects request with invalid bearer token', () => {});
  it('accepts request with valid bearer token and returns identity', () => {});
  it('rejects revoked key', () => {});
  it('operator role blocked from admin endpoints', () => {});
  it('operator role allowed for task submission', () => {});
  it('rate limits after 5 failed login attempts', () => {});
  it('rate limits after 10 failed REST auth attempts', () => {});
  it('accepts legacy X-Torque-Key header with deprecation', () => {});
});
```

- [ ] **Step 2: Implement resolvers.js**

Typed dispatch — not a sequential chain:

```javascript
const keyManager = require('./key-manager');
const ticketManager = require('./ticket-manager');
const sessionManager = require('./session-manager');

function resolve(credential) {
  switch (credential.type) {
    case 'api_key': return keyManager.validateKey(credential.value);
    case 'ticket': return ticketManager.consumeTicket(credential.value);
    case 'session': {
      const session = sessionManager.getSession(credential.value);
      return session ? session.identity : null;
    }
    default: return null;
  }
}
```

- [ ] **Step 3: Implement middleware.js**

Extracts credentials from request, calls resolver, enforces roles:

```javascript
function extractCredential(req) {
  // Bearer token
  const auth = req.headers?.authorization;
  if (auth?.startsWith('Bearer ')) return { type: 'api_key', value: auth.slice(7) };
  // Legacy X-Torque-Key
  const legacy = req.headers?.['x-torque-key'];
  if (legacy) { /* log deprecation */ return { type: 'api_key', value: legacy }; }
  // Cookie session
  const cookie = parseCookie(req.headers?.cookie, 'torque_session');
  if (cookie) return { type: 'session', value: cookie };
  return null;
}

function authenticate(req) {
  if (!keyManager.hasAnyKeys()) return { id: 'open', name: 'Open Mode', role: 'admin' };
  const credential = extractCredential(req);
  if (!credential) return null;
  return resolve(credential);
}

function requireRole(identity, requiredRole) {
  if (!identity) return false;
  if (identity.role === 'admin') return true;
  return identity.role === requiredRole;
}
```

- [ ] **Step 4: Implement rate-limiter.js**

Per-IP sliding window. Configurable attempts/window.

- [ ] **Step 5: Run tests, verify they pass**

- [ ] **Step 6: Commit**

```bash
git add server/auth/resolvers.js server/auth/middleware.js server/auth/rate-limiter.js server/tests/auth-system.test.js
git commit -m "feat(auth): pluggable resolver chain, middleware, and rate limiting"
```

---

## Task 4: Wire Auth into MCP SSE and Protocol

**Files:**
- Modify: `server/mcp-sse.js` (~line 1349-1353, ~line 1604)
- Modify: `server/mcp-protocol.js` (~line 49-53)
- Append to: `server/tests/auth-system.test.js`

- [ ] **Step 1: Write tests**

```javascript
describe('SSE auth integration', () => {
  it('?apiKey=<valid> creates authenticated session', () => {});
  it('?apiKey=<invalid> creates unauthenticated session', () => {});
  it('?ticket=<valid> creates authenticated session and consumes ticket', () => {});
  it('?ticket= takes precedence over ?apiKey= when both present', () => {});
  it('open mode allows connection without any auth params', () => {});
  it('SSE response includes Referrer-Policy: no-referrer', () => {});
});
```

- [ ] **Step 2: Replace inline SSE auth with middleware**

In `server/mcp-sse.js` (~line 1349-1353), replace the inline `configuredKey` check with:

```javascript
const authMiddleware = require('./auth/middleware');
const ticketManager = require('./auth/ticket-manager');

// Extract auth from SSE URL params
const ticket = url.searchParams.get('ticket');
const apiKey = url.searchParams.get('apiKey') || req.headers['x-torque-key'];

let identity = null;
if (ticket) {
  identity = ticketManager.consumeTicket(ticket);
} else if (apiKey) {
  identity = authMiddleware.resolveCredential({ type: 'api_key', value: apiKey });
}

// Open mode: no keys configured = authenticated
if (!identity && !require('./auth/key-manager').hasAnyKeys()) {
  identity = { id: 'open', name: 'Open Mode', role: 'admin' };
}

const isAuthenticated = !!identity;
```

Add `Referrer-Policy: no-referrer` to the SSE response headers.

- [ ] **Step 3: Replace inline protocol auth with middleware**

In `server/mcp-protocol.js` (~line 49-53), replace the inline `_isAuthConfigured` check with:

```javascript
if (method !== 'initialize' && !method.startsWith('notifications/') && !session.authenticated) {
  if (require('./auth/key-manager').hasAnyKeys()) {
    throw { code: -32600, message: 'Authentication required. Set TORQUE_API_KEY environment variable.' };
  }
}
```

- [ ] **Step 4: Add `/api/auth/ticket` endpoint**

In `server/api/routes.js`, add the ticket exchange endpoint:

```javascript
{ method: 'POST', path: '/api/auth/ticket', handlerName: 'handleCreateTicket' }
```

Handler: validate bearer key → create ticket → return `{ ticket }`.

- [ ] **Step 5: Run tests**

```bash
torque-remote npx vitest run server/tests/auth-system.test.js
```

- [ ] **Step 6: Run regression**

```bash
torque-remote npx vitest run server/tests/workflow-await.test.js server/tests/coordination-wiring.test.js
```

- [ ] **Step 7: Commit**

```bash
git add server/mcp-sse.js server/mcp-protocol.js server/api/routes.js server/tests/auth-system.test.js
git commit -m "feat(auth): wire auth middleware into SSE, protocol, and ticket exchange"
```

---

## Task 5: Wire Auth into REST API

**Files:**
- Modify: `server/api/middleware.js`
- Modify: `server/api/routes.js`
- Append to: `server/tests/auth-system.test.js`

- [ ] **Step 1: Write tests**

```javascript
describe('REST API auth', () => {
  it('Bearer token authenticates REST requests', () => {});
  it('missing Bearer token returns 401 when keys exist', () => {});
  it('open mode allows REST requests without auth', () => {});
  it('operator role rejected from admin endpoints', () => {});
  it('rate limiting returns 429 after threshold', () => {});
});
```

- [ ] **Step 2: Add auth middleware to REST API request pipeline**

In `server/api/middleware.js`, add an auth check function that the main request handler calls before routing:

```javascript
function authenticateRequest(req, res, url) {
  const authMiddleware = require('../auth/middleware');
  // Skip auth for health, bootstrap, and /api/auth/login endpoints
  const OPEN_PATHS = ['/api/auth/login', '/api/auth/ticket'];
  if (OPEN_PATHS.includes(url)) return { id: 'anonymous', role: 'anonymous' };

  const identity = authMiddleware.authenticate(req);
  if (!identity) {
    sendJson(res, { error: { code: 'unauthorized', message: 'Invalid or missing API key' } }, 401, req);
    return null;
  }
  return identity;
}
```

- [ ] **Step 3: Add key management REST endpoints**

In `server/api/routes.js`:

```javascript
{ method: 'POST', path: '/api/auth/keys', handlerName: 'handleCreateApiKey' },
{ method: 'GET', path: '/api/auth/keys', handlerName: 'handleListApiKeys' },
{ method: 'DELETE', path: /^\/api\/auth\/keys\/([^/]+)$/, handlerName: 'handleRevokeApiKey', mapParams: ['key_id'] },
```

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add server/api/middleware.js server/api/routes.js server/tests/auth-system.test.js
git commit -m "feat(auth): REST API authentication with rate limiting"
```

---

## Task 6: MCP Tools for Key Management

**Files:**
- Create: `server/tool-defs/auth-defs.js`
- Create: `server/handlers/auth-handlers.js`
- Modify: `server/tools.js`

- [ ] **Step 1: Create tool definitions**

`server/tool-defs/auth-defs.js`:
- `create_api_key` — params: name (required), role (default: admin)
- `list_api_keys` — no params
- `revoke_api_key` — params: id (required)

- [ ] **Step 2: Create handlers**

`server/handlers/auth-handlers.js`:
- `handleCreateApiKey` — calls keyManager.createKey, returns formatted result with plaintext key
- `handleListApiKeys` — calls keyManager.listKeys, returns table format
- `handleRevokeApiKey` — calls keyManager.revokeKey, handles last-admin-key error

- [ ] **Step 3: Register in tools.js**

Add the defs and handlers imports to `server/tools.js`, same pattern as other tool modules.

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add server/tool-defs/auth-defs.js server/handlers/auth-handlers.js server/tools.js
git commit -m "feat(auth): MCP tools for API key management"
```

---

## Task 7: Dashboard Login Page

**Files:**
- Create: `dashboard/src/components/Login.jsx`
- Modify: `dashboard/src/App.jsx`
- Modify: `server/api/routes.js` (add login/logout endpoints)
- Modify: `server/dashboard-server.js` (add cookie parsing + CSRF)

- [ ] **Step 1: Add login/logout REST endpoints**

In `server/api/routes.js`:

```javascript
{ method: 'POST', path: '/api/auth/login', handlerName: 'handleDashboardLogin' },
{ method: 'POST', path: '/api/auth/logout', handlerName: 'handleDashboardLogout' },
```

Handlers:
- `handleDashboardLogin` — validate key, create session, set cookies (`torque_session` HttpOnly + `torque_csrf` readable)
- `handleDashboardLogout` — destroy session, clear cookies

- [ ] **Step 2: Add auth check to dashboard server**

In `server/dashboard-server.js`, add middleware that checks the `torque_session` cookie on every request. If no valid session and keys exist, return 401 (the React app catches this and shows login).

For state-mutating requests (POST/PUT/DELETE), validate `X-CSRF-Token` header matches the session's CSRF token.

- [ ] **Step 3: Create Login.jsx**

A simple login component:
- Single input field for API key
- Submit button
- Error message on invalid key
- On success, redirect to dashboard home
- On first install (open mode), skip login entirely

- [ ] **Step 4: Add auth guard to App.jsx**

In `dashboard/src/App.jsx`, wrap routes with an auth check:
- If server returns 401 → show Login component
- If authenticated → show normal dashboard
- If open mode (no keys) → show dashboard without login

- [ ] **Step 5: Build dashboard**

```bash
cd dashboard && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/Login.jsx dashboard/src/App.jsx server/api/routes.js server/dashboard-server.js
git commit -m "feat(auth): dashboard login page with cookie sessions and CSRF"
```

---

## Task 8: First-Run Bootstrap and Integration Test

**Files:**
- Modify: `server/index.js` (bootstrap on first run)
- Modify: `.mcp.json.example`
- Append to: `server/tests/auth-system.test.js`

- [ ] **Step 1: Add bootstrap to server startup**

In `server/index.js`, during init:

```javascript
const keyManager = require('./auth/key-manager');
keyManager.init(db);
keyManager.migrateConfigApiKey(); // migrate existing key if present

if (!keyManager.hasAnyKeys()) {
  const { key } = keyManager.createKey({ name: 'Bootstrap admin key', role: 'admin' });
  console.log('═'.repeat(59));
  console.log('  TORQUE Admin API Key (save this — it won\'t be shown again):');
  console.log('');
  console.log(`  ${key}`);
  console.log('');
  console.log('  Set as environment variable:');
  console.log(`  export TORQUE_API_KEY="${key}"`);
  console.log('═'.repeat(59));
}
```

- [ ] **Step 2: Update .mcp.json.example**

```json
{
  "mcpServers": {
    "torque": {
      "type": "sse",
      "url": "http://127.0.0.1:3458/sse?apiKey=${TORQUE_API_KEY}",
      "description": "TORQUE - Task Orchestration System"
    }
  }
}
```

- [ ] **Step 3: Write integration tests**

```javascript
describe('auth integration', () => {
  it('full flow: create key → validate → ticket → consume → revoke', () => {
    // Create admin key
    // Validate plaintext → identity
    // Exchange for ticket → get ticket UUID
    // Consume ticket → identity
    // Consume again → null (single-use)
    // Revoke key → validate returns null
  });

  it('full flow: create key → login → session → CSRF → logout', () => {
    // Create admin key
    // Login with key → session_id + csrf_token
    // Get session → identity
    // Validate CSRF → true
    // Wrong CSRF → false
    // Logout → session gone
  });

  it('open mode → create first key → auth enforced', () => {
    // No keys: authenticate returns open-mode identity
    // Create key
    // Now authenticate without key → null
    // Authenticate with key → identity
  });

  it('migration: config.api_key → api_keys table', () => {
    // Set config.api_key
    // Run migration
    // config.api_key is cleared
    // Original key validates via api_keys table
  });
});
```

- [ ] **Step 4: Run all auth tests**

```bash
torque-remote npx vitest run server/tests/auth-system.test.js
```

- [ ] **Step 5: Run full regression**

```bash
torque-remote npx vitest run server/tests/workflow-await.test.js server/tests/await-heartbeat.test.js server/tests/coordination-wiring.test.js
```

- [ ] **Step 6: Commit**

```bash
git add server/index.js .mcp.json.example server/tests/auth-system.test.js
git commit -m "feat(auth): first-run bootstrap, migration, and integration tests"
```

---

## Dependency Graph

```
Task 1 (key manager) → Task 2 (ticket + session) → Task 3 (middleware + resolvers) → Task 4 (SSE + protocol) ──┐
                                                                                        Task 5 (REST API) ──────┼→ Task 8 (bootstrap + integration)
                                                                                        Task 6 (MCP tools) ─────┤
                                                                                        Task 7 (dashboard login) ┘
```

- Task 1 is the foundation (everything depends on key manager)
- Tasks 2-3 are sequential (resolvers need ticket + session managers)
- Tasks 4-7 can be done in parallel after Task 3
- Task 8 is last (end-to-end integration)
