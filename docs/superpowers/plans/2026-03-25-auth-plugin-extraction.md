# Auth Plugin Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all authentication code from TORQUE's default boot path into an optional plugin at `server/plugins/auth/`, making TORQUE local-first with zero auth by default.

**Architecture:** Build a plugin contract and loader system in `server/plugins/`. Rebuild the auth plugin from scratch using the existing auth modules as reference (not copy-paste). Strip the old `server/auth/` code and all auth consumers from the main codebase. The MCP config injector is simplified to inject keyless URLs.

**Tech Stack:** Node.js, Express-style HTTP handlers, better-sqlite3, vitest, bcryptjs

---

## File Structure

### New files (Phase 1 — Plugin system + Auth plugin)

| File | Responsibility |
|------|---------------|
| `server/plugins/plugin-contract.js` | Plugin interface definition + validation helper |
| `server/plugins/loader.js` | Plugin discovery, validation, lifecycle management |
| `server/plugins/loader.test.js` | Tests for plugin loader |
| `server/plugins/auth/index.js` | Auth plugin entry — implements plugin contract |
| `server/plugins/auth/key-manager.js` | API key CRUD, HMAC-SHA-256 hashing |
| `server/plugins/auth/user-manager.js` | Username/password auth, bcrypt, roles |
| `server/plugins/auth/session-manager.js` | In-memory session store, CSRF tokens |
| `server/plugins/auth/middleware.js` | Credential extraction, authenticate() |
| `server/plugins/auth/resolvers.js` | Pluggable resolver chain |
| `server/plugins/auth/role-guard.js` | Role hierarchy enforcement |
| `server/plugins/auth/rate-limiter.js` | IP-based rate limiting |
| `server/plugins/auth/sse-auth.js` | SSE ticket exchange (merges ticket-manager + sse-tickets) |
| `server/plugins/auth/config-injector.js` | MCP config injection with API key (enterprise) |
| `server/plugins/auth/tests/auth-plugin.test.js` | Full plugin integration test |

### Modified files (Phase 1)

| File | Change |
|------|--------|
| `server/auth/mcp-config-injector.js` | Simplify: remove API key from URL, inject keyless `http://127.0.0.1:PORT/sse` |
| `server/index.js` | Replace auth init block with plugin loader; simplify MCP config injection |

### Deleted files (Phase 2 — Dead code removal)

| File | Reason |
|------|--------|
| `server/auth/key-manager.js` | Moved to plugin |
| `server/auth/user-manager.js` | Moved to plugin |
| `server/auth/session-manager.js` | Moved to plugin |
| `server/auth/middleware.js` | Moved to plugin |
| `server/auth/resolvers.js` | Moved to plugin |
| `server/auth/role-guard.js` | Moved to plugin |
| `server/auth/rate-limiter.js` | Moved to plugin |
| `server/auth/ticket-manager.js` | Merged into plugin's sse-auth.js |
| `server/auth/sse-tickets.js` | Merged into plugin's sse-auth.js |
| `server/handlers/auth-handlers.js` | Moved to plugin's mcpTools() |
| `server/tool-defs/auth-defs.js` | Moved to plugin's mcpTools() |

### Modified files (Phase 2 — Strip auth consumers)

| File | Change |
|------|--------|
| `server/api-server.core.js` | Remove auth imports, auth route handlers, auth checks |
| `server/api/middleware.js` | Remove `authenticateRequest()`, auth requires |
| `server/mcp-sse.js` | Remove auth dance from SSE connection handler |
| `server/mcp-protocol.js` | Remove `isOpenMode` checks |
| `server/dashboard-server.js` | Remove auth login/logout/session routes, auth middleware |
| `server/tools.js` | Remove auth-defs and auth-handlers imports |
| `server/index.js` | Remove remaining auth references |
| `server/tests/auth-system.test.js` | Move to `server/plugins/auth/tests/` |
| `server/tests/mcp-config-injector.test.js` | Update for keyless injection |
| `server/tests/role-guard.test.js` | Move to plugin |
| `server/tests/sse-tickets.test.js` | Move to plugin |
| `server/tests/user-manager.test.js` | Move to plugin |

---

## Phase 1: Build the Plugin System + Auth Plugin

### Task 1: Plugin Contract

**Provider:** Claude (architectural — needs to be right)

**Files:**
- Create: `server/plugins/plugin-contract.js`

- [ ] **Step 1: Write the failing test**

Create `server/plugins/loader.test.js` with a test that validates the contract checker:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { validatePlugin } = require('../plugin-contract');

describe('plugin-contract', () => {
  it('accepts a valid plugin', () => {
    const plugin = {
      name: 'test-plugin',
      version: '1.0.0',
      install: () => {},
      uninstall: () => {},
      middleware: () => [],
      mcpTools: () => [],
      eventHandlers: () => ({}),
      configSchema: () => ({ type: 'object', properties: {} }),
    };
    const result = validatePlugin(plugin);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects plugin missing required fields', () => {
    const result = validatePlugin({ name: 'bad' });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects plugin with non-function lifecycle methods', () => {
    const plugin = {
      name: 'bad',
      version: '1.0.0',
      install: 'not-a-function',
      uninstall: () => {},
      middleware: () => [],
      mcpTools: () => [],
      eventHandlers: () => ({}),
      configSchema: () => ({}),
    };
    const result = validatePlugin(plugin);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('install must be a function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/plugins/loader.test.js`
Expected: FAIL — `Cannot find module '../plugin-contract'`

- [ ] **Step 3: Write the plugin contract module**

```js
'use strict';

const REQUIRED_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'install', type: 'function' },
  { name: 'uninstall', type: 'function' },
  { name: 'middleware', type: 'function' },
  { name: 'mcpTools', type: 'function' },
  { name: 'eventHandlers', type: 'function' },
  { name: 'configSchema', type: 'function' },
];

function validatePlugin(plugin) {
  const errors = [];

  if (!plugin || typeof plugin !== 'object') {
    return { valid: false, errors: ['plugin must be an object'] };
  }

  for (const { name, type } of REQUIRED_FIELDS) {
    if (!(name in plugin)) {
      errors.push(`missing required field: ${name}`);
    } else if (typeof plugin[name] !== type) {
      errors.push(`${name} must be a ${type}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validatePlugin, REQUIRED_FIELDS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/plugins/loader.test.js`
Expected: PASS — all 3 tests

- [ ] **Step 5: Commit**

```bash
git add server/plugins/plugin-contract.js server/plugins/loader.test.js
git commit -m "feat(plugins): add plugin contract with validation"
```

---

### Task 2: Plugin Loader

**Provider:** Claude (integration surface — needs care)

**Files:**
- Create: `server/plugins/loader.js`
- Modify: `server/plugins/loader.test.js`

- [ ] **Step 1: Add loader tests to the existing test file**

Append to `server/plugins/loader.test.js`:

```js
const { loadPlugins } = require('../loader');
const path = require('path');

describe('plugin-loader', () => {
  it('returns empty array when auth_mode is local', () => {
    const plugins = loadPlugins({ authMode: 'local' });
    expect(plugins).toEqual([]);
  });

  it('loads auth plugin when auth_mode is enterprise', () => {
    // This test will work once the auth plugin exists (Task 7).
    // For now, test error handling: plugin dir doesn't exist yet.
    const plugins = loadPlugins({
      authMode: 'enterprise',
      pluginDir: path.join(__dirname, 'nonexistent-plugins'),
    });
    expect(plugins).toEqual([]);
  });

  it('logs warning on invalid plugin and falls back', () => {
    const warnings = [];
    const plugins = loadPlugins({
      authMode: 'enterprise',
      pluginDir: path.join(__dirname, 'nonexistent-plugins'),
      logger: { warn: (msg) => warnings.push(msg), info: () => {} },
    });
    expect(plugins).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/plugins/loader.test.js`
Expected: FAIL — `Cannot find module '../loader'`

- [ ] **Step 3: Write the plugin loader**

```js
'use strict';

const path = require('path');
const { validatePlugin } = require('./plugin-contract');

const DEFAULT_PLUGIN_DIR = path.join(__dirname);

const AUTH_MODE_PLUGIN_MAP = {
  enterprise: 'auth',
};

function loadPlugins(options = {}) {
  const {
    authMode = 'local',
    pluginDir = DEFAULT_PLUGIN_DIR,
    logger = { warn: console.warn, info: console.log },
  } = options;

  const pluginName = AUTH_MODE_PLUGIN_MAP[authMode];
  if (!pluginName) return [];

  const pluginPath = path.join(pluginDir, pluginName, 'index.js');

  let plugin;
  try {
    plugin = require(pluginPath);
  } catch (err) {
    logger.warn(`[plugin-loader] Failed to load plugin "${pluginName}" from ${pluginPath}: ${err.message}`);
    return [];
  }

  const validation = validatePlugin(plugin);
  if (!validation.valid) {
    logger.warn(`[plugin-loader] Plugin "${pluginName}" failed validation: ${validation.errors.join(', ')}`);
    return [];
  }

  logger.info(`[plugin-loader] Loaded plugin: ${plugin.name} v${plugin.version}`);
  return [plugin];
}

module.exports = { loadPlugins };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/plugins/loader.test.js`
Expected: PASS — all 6 tests

- [ ] **Step 5: Commit**

```bash
git add server/plugins/loader.js server/plugins/loader.test.js
git commit -m "feat(plugins): add plugin loader with auth_mode routing"
```

---

### Task 3: Auth Plugin — Core Modules (key-manager, role-guard, rate-limiter)

**Provider:** Codex (mechanical restructuring)

**Files:**
- Create: `server/plugins/auth/key-manager.js`
- Create: `server/plugins/auth/role-guard.js`
- Create: `server/plugins/auth/rate-limiter.js`

**Context for worker:**
- Reference `server/auth/key-manager.js` (237 lines), `server/auth/role-guard.js` (13 lines), `server/auth/rate-limiter.js` (47 lines)
- Rebuild these three modules from scratch in `server/plugins/auth/`
- Key difference: these modules must accept dependencies via constructor/factory function, NOT via module-level `init(db)` pattern
- Each module should export a `create` factory function that accepts `{ db }` and returns the API object
- Preserve ALL functionality: HMAC-SHA-256 key hashing, key CRUD, role hierarchy, rate limiting
- Do NOT copy the files — write them fresh following DI factory pattern

**key-manager.js factory pattern:**
```js
function createKeyManager({ db }) {
  let serverSecret = null;
  // ... all functions close over db and serverSecret
  return { createKey, validateKey, revokeKey, listKeys, listKeysByUser, hasAnyKeys, migrateConfigApiKey, hashKey, getServerSecret };
}
module.exports = { createKeyManager };
```

**role-guard.js factory pattern:**
```js
const ROLE_HIERARCHY = ['viewer', 'operator', 'manager', 'admin'];
function createRoleGuard() {
  function requireRole(identity, minRole) { /* same logic */ }
  return { requireRole, ROLE_HIERARCHY };
}
module.exports = { createRoleGuard, ROLE_HIERARCHY };
```

**rate-limiter.js — keep as class (already stateless constructor):**
```js
// Same AuthRateLimiter class, no changes needed — it's already self-contained
module.exports = { AuthRateLimiter };
```

- [ ] **Step 1: Write tests for plugin key-manager**

Create `server/plugins/auth/tests/key-manager.test.js`:
- Test `createKeyManager({ db })` factory returns expected API
- Test key creation returns `torque_sk_*` format
- Test key validation succeeds for valid key
- Test key validation returns null for invalid key
- Test key revocation
- Test last-admin-key protection
- Test `hasAnyKeys()` returns false when empty, true after creation
- Use `vitest-setup.js` pattern for test DB

- [ ] **Step 2: Run tests — should fail (module not found)**

- [ ] **Step 3: Implement `server/plugins/auth/key-manager.js`**

- [ ] **Step 4: Implement `server/plugins/auth/role-guard.js`**

- [ ] **Step 5: Implement `server/plugins/auth/rate-limiter.js`**

- [ ] **Step 6: Run all tests — should pass**

Run: `npx vitest run server/plugins/auth/tests/key-manager.test.js`

- [ ] **Step 7: Commit**

```bash
git add server/plugins/auth/key-manager.js server/plugins/auth/role-guard.js server/plugins/auth/rate-limiter.js server/plugins/auth/tests/key-manager.test.js
git commit -m "feat(auth-plugin): add key-manager, role-guard, rate-limiter"
```

---

### Task 4: Auth Plugin — User & Session Modules

**Provider:** Codex (mechanical restructuring)

**Files:**
- Create: `server/plugins/auth/user-manager.js`
- Create: `server/plugins/auth/session-manager.js`
- Create: `server/plugins/auth/tests/user-session.test.js`

**Context for worker:**
- Reference `server/auth/user-manager.js` (290 lines) and `server/auth/session-manager.js` (56 lines)
- Rebuild with DI factory pattern: `createUserManager({ db })`, `createSessionManager()`
- session-manager is already in-memory (no DB), but should still use factory pattern for consistency
- Preserve ALL functionality: bcrypt, username normalization, role validation, CRUD, session TTL, CSRF, LRU eviction

**user-manager.js factory pattern:**
```js
function createUserManager({ db }) {
  // ... all functions close over db
  return { createUser, validatePassword, hasAnyUsers, getUserById, listUsers, updateUser, deleteUser, normalizeUsername, validateRole, VALID_ROLES };
}
module.exports = { createUserManager };
```

**session-manager.js factory pattern:**
```js
function createSessionManager({ maxSessions = 50, sessionTtlMs = 86400000 } = {}) {
  const sessions = new Map();
  // ... all functions close over sessions
  return { createSession, getSession, destroySession, destroySessionsByIdentityId, validateCsrf, getSessionCount };
}
module.exports = { createSessionManager };
```

- [ ] **Step 1: Write tests**

Tests for user-manager: creation, validation, duplicate detection, role validation, password requirements, last-admin protection.
Tests for session-manager: creation, retrieval, TTL expiry, CSRF validation, LRU eviction, destroy.

- [ ] **Step 2: Run tests — should fail**
- [ ] **Step 3: Implement both modules**
- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run server/plugins/auth/tests/user-session.test.js`

- [ ] **Step 5: Commit**

```bash
git add server/plugins/auth/user-manager.js server/plugins/auth/session-manager.js server/plugins/auth/tests/user-session.test.js
git commit -m "feat(auth-plugin): add user-manager and session-manager"
```

---

### Task 5: Auth Plugin — SSE Auth & Middleware

**Provider:** Codex (restructuring + merge)

**Files:**
- Create: `server/plugins/auth/sse-auth.js`
- Create: `server/plugins/auth/middleware.js`
- Create: `server/plugins/auth/resolvers.js`
- Create: `server/plugins/auth/tests/middleware.test.js`

**Context for worker:**
- `sse-auth.js` merges `server/auth/ticket-manager.js` (37 lines) and `server/auth/sse-tickets.js` (72 lines) into one module
- Factory pattern: `createSseAuth()` returns `{ createLegacyTicket, consumeLegacyTicket, generateSseTicket, validateSseTicket, cleanup, getTicketCount }`
- Legacy ticket format (UUID) and new format (`sse_tk_` prefix) both supported from one module
- `middleware.js`: `createAuthMiddleware({ keyManager, userManager, resolvers })` returns `{ authenticate, extractCredential, isOpenMode }`
- `resolvers.js`: `createResolvers({ keyManager, sseAuth, sessionManager })` returns `{ resolve }`

**sse-auth.js factory pattern:**
```js
function createSseAuth({ maxLegacyTickets = 100, legacyTtlMs = 30000, sseTtlMs = 60000 } = {}) {
  const legacyTickets = new Map();
  const sseTickets = new Map();
  // Unified ticket interface
  return { createLegacyTicket, consumeLegacyTicket, generateSseTicket, validateSseTicket, cleanup, getTicketCount };
}
module.exports = { createSseAuth, SSE_TICKET_PREFIX: 'sse_tk_' };
```

- [ ] **Step 1: Write tests**

Tests for sse-auth: legacy ticket create/consume/expire, SSE ticket generate/validate/expire, single-use enforcement, cap limits.
Tests for middleware: `extractCredential` from Bearer/header/cookie, `authenticate` with valid/invalid keys, `isOpenMode`.
Tests for resolvers: resolve api_key, resolve ticket, resolve session, unknown type returns null.

- [ ] **Step 2: Run tests — should fail**
- [ ] **Step 3: Implement all three modules**
- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run server/plugins/auth/tests/middleware.test.js`

- [ ] **Step 5: Commit**

```bash
git add server/plugins/auth/sse-auth.js server/plugins/auth/middleware.js server/plugins/auth/resolvers.js server/plugins/auth/tests/middleware.test.js
git commit -m "feat(auth-plugin): add sse-auth, middleware, resolvers"
```

---

### Task 6: Auth Plugin — Enterprise Config Injector

**Provider:** Codex (targeted edit)

**Files:**
- Create: `server/plugins/auth/config-injector.js`
- Create: `server/plugins/auth/tests/config-injector.test.js`

**Context for worker:**
- This is the ENTERPRISE version of MCP config injection — it injects `http://127.0.0.1:PORT/sse?apiKey=KEY` into `~/.claude/.mcp.json`
- Reference `server/auth/mcp-config-injector.js` (97 lines) for the injection logic
- Factory pattern: `createConfigInjector({ logger })` returns `{ readKeyFromFile, ensureGlobalMcpConfig }`
- Preserve: atomic write (temp + rename), JSON merge, Windows icacls, parse error safety
- `readKeyFromFile(dataDir)` reads from `<dataDir>/.torque-api-key`
- `ensureGlobalMcpConfig(apiKey, options)` builds URL with `?apiKey=KEY`

- [ ] **Step 1: Write tests**

Same tests as `server/tests/mcp-config-injector.test.js` but targeting the plugin version: creation from scratch, merge, idempotent skip, key rotation, parse failure safety, directory creation, non-default port.

- [ ] **Step 2: Run tests — should fail**
- [ ] **Step 3: Implement the module**
- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run server/plugins/auth/tests/config-injector.test.js`

- [ ] **Step 5: Commit**

```bash
git add server/plugins/auth/config-injector.js server/plugins/auth/tests/config-injector.test.js
git commit -m "feat(auth-plugin): add enterprise MCP config injector"
```

---

### Task 7: Auth Plugin — Plugin Entry (index.js)

**Provider:** Claude (integration surface — needs architectural care)

**Files:**
- Create: `server/plugins/auth/index.js`
- Create: `server/plugins/auth/tests/auth-plugin.test.js`

- [ ] **Step 1: Write the integration test**

```js
'use strict';
const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { setupTestDb, teardownTestDb, rawDb } = require('../../../tests/vitest-setup');
const { validatePlugin } = require('../../plugin-contract');
const authPlugin = require('../index');

describe('auth-plugin', () => {
  let db;

  beforeAll(() => {
    ({ db } = setupTestDb('auth-plugin'));
    const handle = rawDb();
    handle.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT, revoked_at TEXT, user_id TEXT
      )
    `);
    handle.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)');
    handle.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        display_name TEXT, role TEXT NOT NULL DEFAULT 'viewer',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, last_login_at TEXT
      )
    `);
  });

  afterAll(() => teardownTestDb());

  it('passes plugin contract validation', () => {
    const result = validatePlugin(authPlugin);
    expect(result.valid).toBe(true);
  });

  it('has correct name and version', () => {
    expect(authPlugin.name).toBe('auth');
    expect(typeof authPlugin.version).toBe('string');
  });

  it('install() initializes without error', () => {
    const container = {
      get: (name) => {
        if (name === 'db') return { getDbInstance: () => rawDb(), getDataDir: () => '/tmp/test-auth' };
        if (name === 'serverConfig') return { getInt: () => 3458 };
        if (name === 'eventBus') return { on: () => {} };
        return null;
      },
    };
    expect(() => authPlugin.install(container)).not.toThrow();
  });

  it('middleware() returns a function', () => {
    const mw = authPlugin.middleware();
    expect(Array.isArray(mw) || typeof mw === 'function').toBe(true);
  });

  it('mcpTools() returns tool definitions', () => {
    const tools = authPlugin.mcpTools();
    expect(Array.isArray(tools)).toBe(true);
    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('create_api_key');
    expect(toolNames).toContain('list_api_keys');
    expect(toolNames).toContain('revoke_api_key');
  });

  it('eventHandlers() returns an object', () => {
    const handlers = authPlugin.eventHandlers();
    expect(typeof handlers).toBe('object');
  });

  it('configSchema() returns a valid schema', () => {
    const schema = authPlugin.configSchema();
    expect(schema.type).toBe('object');
  });

  it('uninstall() cleans up without error', () => {
    expect(() => authPlugin.uninstall()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/plugins/auth/tests/auth-plugin.test.js`
Expected: FAIL — `Cannot find module '../index'`

- [ ] **Step 3: Implement the plugin entry**

Create `server/plugins/auth/index.js` that:
1. Imports all plugin auth modules (key-manager, user-manager, session-manager, middleware, resolvers, role-guard, sse-auth, config-injector, rate-limiter)
2. Implements the plugin contract (name, version, install, uninstall, middleware, mcpTools, eventHandlers, configSchema)
3. `install(container)` wires up all DI dependencies from the container, runs bootstrap key flow, runs enterprise MCP config injection
4. `mcpTools()` returns tool definitions with inline handlers for create_api_key, list_api_keys, revoke_api_key
5. `uninstall()` nulls all internal references

See the design spec at `docs/superpowers/specs/2026-03-25-auth-plugin-extraction-design.md` for full details on the `install()` flow.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/plugins/auth/tests/auth-plugin.test.js`
Expected: PASS — all 8 tests

- [ ] **Step 5: Commit**

```bash
git add server/plugins/auth/index.js server/plugins/auth/tests/auth-plugin.test.js
git commit -m "feat(auth-plugin): add plugin entry implementing full contract"
```

---

### Task 8: Simplify MCP Config Injector for Local Mode

**Provider:** Codex (targeted edit)

**Files:**
- Modify: `server/auth/mcp-config-injector.js`
- Modify: `server/tests/mcp-config-injector.test.js`

**Context for worker:**
- The local-mode injector no longer needs an API key
- `ensureGlobalMcpConfig` should accept `options` WITHOUT requiring `apiKey` as first arg
- New signature: `ensureGlobalMcpConfig(options)` where options has `{ ssePort, host, homeDir }`
- URL becomes `http://127.0.0.1:PORT/sse` (no `?apiKey=` query param)
- Remove `readKeyFromFile` from this module (enterprise version lives in plugin)
- Update all 11 tests to match the new keyless behavior
- The current file is at `server/auth/mcp-config-injector.js` (97 lines)
- The current test file is at `server/tests/mcp-config-injector.test.js`

**New module contents:**

```js
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('../logger').child({ component: 'mcp-config-injector' });

const MCP_CONFIG_FILENAME = '.mcp.json';
const CLAUDE_DIR_NAME = '.claude';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_SSE_PORT = 3458;
const DESCRIPTION = 'TORQUE - Task Orchestration System with local LLM routing';

function ensureGlobalMcpConfig(options = {}) {
  const {
    ssePort = DEFAULT_SSE_PORT,
    host = DEFAULT_HOST,
    homeDir,
  } = options;

  const home = homeDir || os.homedir();
  const claudeDir = path.join(home, CLAUDE_DIR_NAME);
  const configPath = path.join(claudeDir, MCP_CONFIG_FILENAME);
  const expectedUrl = `http://${host}:${ssePort}/sse`;

  try {
    fs.mkdirSync(claudeDir, { recursive: true });

    let data = { mcpServers: {} };
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      data = JSON.parse(raw);
      if (!data || typeof data !== 'object') data = { mcpServers: {} };
      if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.info(`[MCP Config] Cannot parse ${configPath}: ${err.message} — skipping`);
        return { injected: false, path: configPath, reason: 'parse_error' };
      }
    }

    const existing = data.mcpServers.torque;
    if (existing && existing.url === expectedUrl) {
      return { injected: false, path: configPath, reason: 'already_current' };
    }

    data.mcpServers.torque = {
      ...(existing || {}),
      type: 'sse',
      url: expectedUrl,
      description: DESCRIPTION,
    };

    const tmpPath = configPath + '.tmp.' + process.pid;
    const content = JSON.stringify(data, null, 2) + '\n';
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.renameSync(tmpPath, configPath);

    if (process.platform === 'win32') {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('icacls', [configPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(F)`], { stdio: 'pipe', windowsHide: true });
      } catch { /* best-effort */ }
    }

    const reason = existing ? 'updated' : 'created';
    logger.info(`[MCP Config] Injected TORQUE entry into ${configPath} (${reason})`);
    return { injected: true, path: configPath, reason };
  } catch (err) {
    logger.info(`[MCP Config] Injection failed: ${err.message}`);
    return { injected: false, path: configPath, reason: `error: ${err.message}` };
  }
}

module.exports = { ensureGlobalMcpConfig };
```

- [ ] **Step 1: Update tests to expect keyless behavior**

Change test expectations:
- URL should be `http://127.0.0.1:3458/sse` not `http://127.0.0.1:3458/sse?apiKey=...`
- Remove tests for `readKeyFromFile`
- Remove tests for `no_key` reason (no key concept in local mode)
- Keep tests for: creation from scratch, merge with existing, idempotent skip, port override, parse failure, directory creation, user-field preservation

- [ ] **Step 2: Run tests — should fail (old API)**
- [ ] **Step 3: Update the module to the new keyless version above**
- [ ] **Step 4: Run tests — should pass**

Run: `npx vitest run server/tests/mcp-config-injector.test.js`

- [ ] **Step 5: Commit**

```bash
git add server/auth/mcp-config-injector.js server/tests/mcp-config-injector.test.js
git commit -m "refactor: simplify MCP config injector for keyless local mode"
```

---

### Task 9: Wire Plugin Loader into Server Startup

**Provider:** Claude (integration surface — needs judgment)

**Files:**
- Modify: `server/index.js`

**Context for worker:**
- Replace `server/index.js` lines 525-567 (the auth init block) and lines 585-600 (MCP config injection block)
- New flow at line 525:

```js
  // Auth mode: local (default) or enterprise (plugin-based)
  const authMode = process.env.TORQUE_AUTH_MODE || db.getConfig('auth_mode') || 'local';

  if (authMode === 'local') {
    debugLog('Auth mode: local (no authentication, 127.0.0.1 only)');
  }
```

- New MCP config injection at line 585 (replacing the old block):

```js
  // Auto-inject TORQUE MCP config into user's global ~/.claude/.mcp.json
  // Local mode: keyless URL. Enterprise mode: plugin handles key injection.
  if (authMode === 'local') {
    try {
      const mcpConfigInjector = require('./auth/mcp-config-injector');
      const ssePort = serverConfig.getInt('mcp_sse_port', 3458);
      const result = mcpConfigInjector.ensureGlobalMcpConfig({ ssePort });
      if (result.injected) {
        debugLog(`MCP config ${result.reason}: ${result.path}`);
      }
    } catch (err) {
      debugLog(`MCP config injection skipped: ${err.message}`);
    }
  }
```

- After `defaultContainer.boot()` (after line 622), add plugin loading:

```js
  // Plugin loading (enterprise auth, future plugins)
  let loadedPlugins = [];
  if (authMode === 'enterprise') {
    try {
      const { loadPlugins } = require('./plugins/loader');
      loadedPlugins = loadPlugins({ authMode, logger });
      for (const plugin of loadedPlugins) {
        plugin.install(defaultContainer);
        debugLog(`Plugin installed: ${plugin.name} v${plugin.version}`);
      }
    } catch (err) {
      debugLog(`Plugin loading failed, falling back to local mode: ${err.message}`);
    }
  }
```

- Also remove the user-manager require at line 1290 if it's only used for auth

- [ ] **Step 1: Apply the changes to index.js**
- [ ] **Step 2: Run tests**

Run: `npx vitest run server/tests/`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: wire plugin loader into server startup, local mode by default"
```

---

### Task 10: Integration Test — Local Mode + Enterprise Mode

**Provider:** Claude (needs judgment about edge cases)

**Files:**
- Create: `server/tests/plugin-integration.test.js`

- [ ] **Step 1: Write integration tests**

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { validatePlugin } = require('../plugins/plugin-contract');
const { loadPlugins } = require('../plugins/loader');

describe('plugin-integration', () => {
  describe('local mode', () => {
    it('loads zero plugins in local mode', () => {
      const plugins = loadPlugins({ authMode: 'local' });
      expect(plugins).toEqual([]);
    });

    it('loads zero plugins with no auth_mode set', () => {
      const plugins = loadPlugins({});
      expect(plugins).toEqual([]);
    });
  });

  describe('enterprise mode', () => {
    it('loads auth plugin in enterprise mode', () => {
      const plugins = loadPlugins({ authMode: 'enterprise' });
      expect(plugins.length).toBe(1);
      expect(plugins[0].name).toBe('auth');
    });

    it('auth plugin passes contract validation', () => {
      const plugins = loadPlugins({ authMode: 'enterprise' });
      const result = validatePlugin(plugins[0]);
      expect(result.valid).toBe(true);
    });

    it('auth plugin exposes MCP tools', () => {
      const plugins = loadPlugins({ authMode: 'enterprise' });
      const tools = plugins[0].mcpTools();
      expect(tools.length).toBe(3);
      expect(tools.map(t => t.name)).toEqual(['create_api_key', 'list_api_keys', 'revoke_api_key']);
    });
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run server/tests/plugin-integration.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/tests/plugin-integration.test.js
git commit -m "test: add plugin integration tests for local and enterprise modes"
```

---

## Phase 2: Remove Dead Auth Code

All Phase 2 tasks are independent and can run in parallel via TORQUE workflow.

**Provider for all Phase 2 tasks:** Codex (mechanical removal)

**Verify command for all tasks:** `npx vitest run`

---

### Task 11: Strip auth from api-server.core.js

**Files:**
- Modify: `server/api-server.core.js`

- [ ] **Step 1: Remove auth imports (lines 47-48)**

Remove:
```js
const authMiddleware = require('./auth/middleware');
const { requireRole } = require('./auth/role-guard');
```

- [ ] **Step 2: Remove auth route handlers**

Remove the following functions entirely:
- `handleCreateTicket` (lines ~145-172) — ticket exchange
- `handleCreateSseTicket` (lines ~175-200) — SSE ticket exchange
- All `/api/auth/*` route registrations
- All `/api/keys/*` route registrations
- Login/logout/session handlers that reference auth modules

- [ ] **Step 3: Remove auth checks from remaining handlers**

In any remaining route handler that calls `authMiddleware.authenticate(req)` or checks `requireRole()`:
- Remove the auth check
- Remove the 401/403 response paths
- Let the request proceed directly

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS (some auth-specific tests may need removal — see Task 16)

- [ ] **Step 5: Commit**

```bash
git add server/api-server.core.js
git commit -m "refactor: strip auth from api-server.core.js"
```

---

### Task 12: Strip auth from mcp-sse.js

**Files:**
- Modify: `server/mcp-sse.js`

- [ ] **Step 1: Simplify handleSseConnection (lines ~305-370)**

Replace the auth dance (lines 310-352) with:

```js
  // Local mode: accept all connections unconditionally
  const identity = { id: 'local', name: 'Local User', role: 'admin', type: 'local' };
```

Remove:
- `require('./auth/key-manager')` (line 311)
- `require('./auth/ticket-manager')` (line 312)
- `require('./auth/sse-tickets')` (line 313)
- `require('./auth/middleware')` (line 314)
- Ticket validation logic (lines 327-348)
- `apiKey` query param extraction (line 324)
- `isOpenMode()` check (line 350)

- [ ] **Step 2: Remove auth from WebSocket upgrade handler**

Remove `isOpenMode` import and check at line ~653.

- [ ] **Step 3: Run tests**

Run: `npx vitest run server/tests/mcp-sse.test.js`

- [ ] **Step 4: Commit**

```bash
git add server/mcp-sse.js
git commit -m "refactor: strip auth from mcp-sse.js, accept all local connections"
```

---

### Task 13: Strip auth from mcp-protocol.js

**Files:**
- Modify: `server/mcp-protocol.js`

- [ ] **Step 1: Remove auth check from request handler**

Remove the `isOpenMode` block at lines 46-56. All sessions are authenticated in local mode. Replace with nothing — the `if` block and its `throw` are no longer needed.

- [ ] **Step 2: Remove initialize security warning**

Remove the `isOpenMode` check at lines 71-78 that adds `_meta.security_warning`. In local mode there's nothing to warn about.

- [ ] **Step 3: Run tests**

Run: `npx vitest run`

- [ ] **Step 4: Commit**

```bash
git add server/mcp-protocol.js
git commit -m "refactor: strip auth checks from mcp-protocol.js"
```

---

### Task 14: Strip auth from dashboard-server.js

**Files:**
- Modify: `server/dashboard-server.js`

- [ ] **Step 1: Remove all auth imports**

Remove all `require('./auth/...')` lines (approximately 15 imports scattered through the file at lines 48-50, 66, 81, 137-138, 158-159, 169-170, 203-205, 259-261, 1003, 1006-1007).

- [ ] **Step 2: Remove auth route handlers**

Remove login/logout/session handlers:
- Login POST handler
- Logout handler
- Session validation
- Auth status endpoint
- User management endpoints (create/update/delete user)
- Profile endpoints
- Dashboard WebSocket auth check

- [ ] **Step 3: Replace auth checks with pass-through**

Any remaining auth-gated logic: remove the gate, keep the business logic.

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/tests/dashboard-server.test.js`

- [ ] **Step 5: Commit**

```bash
git add server/dashboard-server.js
git commit -m "refactor: strip auth from dashboard-server.js"
```

---

### Task 15: Strip auth from api/middleware.js and tools.js

**Files:**
- Modify: `server/api/middleware.js`
- Modify: `server/tools.js`

- [ ] **Step 1: Remove authenticateRequest from api/middleware.js**

Remove `authenticateRequest` function (lines 349-361) and its export. Remove the `require('../auth/middleware')` import at line 350. Remove `AUTH_OPEN_PATHS` if it exists only for auth.

- [ ] **Step 2: Remove auth-defs and auth-handlers from tools.js**

Remove from TOOLS array (line 47):
```js
  ...require('./tool-defs/auth-defs'),
```

Remove from HANDLER_MODULES array (line 119):
```js
  require('./handlers/auth-handlers'),
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run`

- [ ] **Step 4: Commit**

```bash
git add server/api/middleware.js server/tools.js
git commit -m "refactor: strip auth from api middleware and tool registry"
```

---

### Task 16: Delete old auth directory + relocate tests

**Files:**
- Delete: `server/auth/key-manager.js`
- Delete: `server/auth/user-manager.js`
- Delete: `server/auth/session-manager.js`
- Delete: `server/auth/middleware.js`
- Delete: `server/auth/resolvers.js`
- Delete: `server/auth/role-guard.js`
- Delete: `server/auth/rate-limiter.js`
- Delete: `server/auth/ticket-manager.js`
- Delete: `server/auth/sse-tickets.js`
- Delete: `server/handlers/auth-handlers.js`
- Delete: `server/tool-defs/auth-defs.js`
- Delete: `server/tests/auth-system.test.js`
- Delete: `server/tests/role-guard.test.js`
- Delete: `server/tests/sse-tickets.test.js`
- Delete: `server/tests/user-manager.test.js`
- Keep: `server/auth/mcp-config-injector.js` (simplified local version)
- Keep: `server/tests/mcp-config-injector.test.js` (updated for keyless)

**Important:** This task MUST run AFTER Tasks 11-15 are complete, since those tasks strip the imports first.

- [ ] **Step 1: Delete the old auth files**

```bash
git rm server/auth/key-manager.js server/auth/user-manager.js server/auth/session-manager.js
git rm server/auth/middleware.js server/auth/resolvers.js server/auth/role-guard.js
git rm server/auth/rate-limiter.js server/auth/ticket-manager.js server/auth/sse-tickets.js
git rm server/handlers/auth-handlers.js server/tool-defs/auth-defs.js
git rm server/tests/auth-system.test.js server/tests/role-guard.test.js
git rm server/tests/sse-tickets.test.js server/tests/user-manager.test.js
```

- [ ] **Step 2: Verify no remaining imports of deleted files**

Search for any `require` statements referencing the deleted modules across all `.js` files in `server/` (excluding `node_modules` and `plugins/`). There should be zero matches.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: PASS — all tests pass with old auth code gone

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: delete old server/auth/ modules and auth tests (moved to plugin)"
```

---

### Task 17: Strip auth from remaining index.js references

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Remove any leftover auth references**

Check for remaining `require('./auth/...')` in index.js outside the already-modified sections. Specifically check line 1290 (`require('./auth/user-manager')`). Remove any remaining auth imports and their usage.

- [ ] **Step 2: Run tests**

Run: `npx vitest run`

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "refactor: strip remaining auth references from index.js"
```

---

### Task 18: Update docs and config

**Provider:** Codex (mechanical)

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.mcp.json.example` (if it exists)

- [ ] **Step 1: Update CLAUDE.md**

- Update the Authentication section to explain local-first default (no keys, no login, localhost-only)
- Document `TORQUE_AUTH_MODE=enterprise` for enabling auth via plugin
- Remove references to `TORQUE_API_KEY` env var for local use
- Update MCP config injection docs to show keyless URL (`http://127.0.0.1:3458/sse`)
- Document the plugin system briefly under a new "Plugins" section
- Remove "Open mode" references (the concept doesn't exist in local mode)

- [ ] **Step 2: Update .mcp.json.example**

If it exists, update the example URL to `http://127.0.0.1:3458/sse` (no apiKey param).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md .mcp.json.example
git commit -m "docs: update for local-first auth-free default"
```

---

## Execution Summary

| Phase | Tasks | Parallelizable | Provider |
|-------|-------|----------------|----------|
| **Phase 1** | Tasks 1-10 | Tasks 3-6 can run in parallel (independent modules) | Claude: 1,2,7,9,10; Codex: 3,4,5,6,8 |
| **Phase 2** | Tasks 11-18 | Tasks 11-15 can all run in parallel; 16 depends on 11-15; 17-18 depend on 16 | Codex: all |

**Total tasks:** 18
**Critical path:** Tasks 1→2→(3,4,5,6 parallel)→7→8→9→10→(11-15 parallel)→16→(17,18 parallel)
