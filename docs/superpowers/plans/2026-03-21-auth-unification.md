# Auth Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy `checkAuth()` (boolean, single plaintext `config.api_key`) with the new `authenticate()` pipeline (identity object, HMAC-hashed `api_keys` table) across all REST API call sites, then remove the legacy path entirely.

**Architecture:** The new auth system (`auth/middleware.js` → `auth/resolvers.js` → `auth/key-manager.js`) already handles API keys, session cookies, and one-time tickets. It returns identity objects `{ id, name, role }` instead of booleans, enabling role-based access control. We migrate the 3 REST API call sites that still use the legacy `checkAuth()`, remove `ensureApiKey()` (which creates legacy keys), clean up V2 auth mode dead code, and clean up the legacy `config.api_key` from the database.

**Tech Stack:** Node.js, better-sqlite3, Vitest

**Note on fresh installs:** Removing `ensureApiKey()` from `database.js` does NOT break fresh installs. The `keyManager` bootstrap in `index.js:527-537` already handles the "no keys exist" path by creating a new `api_keys` entry directly via `keyManager.createKey()`.

**Note on `authenticateRequest()`:** `api/middleware.js` has an existing `authenticateRequest()` function (line 379) that wraps `authMiddleware.authenticate()` with open-path bypass. The generic route handler already handles open-path bypass via `route.skipAuth`, so we use `authMiddleware.authenticate()` directly. `authenticateRequest()` remains available for any future callers that don't have route metadata.

---

### Task 1: Replace `checkAuth()` with `authenticate()` in REST API generic handler

**Files:**
- Modify: `server/api-server.core.js:2700-2710` (generic route handler)
- Modify: `server/api-server.core.js:44-53` (imports)

- [ ] **Step 1: Add `authMiddleware` import at top of api-server.core.js**

At line 44, `auth/middleware` is already required in individual handler functions but not at module scope. Add the import alongside the existing middleware destructure:

```javascript
const authMiddleware = require('./auth/middleware');
```

Add this near the other top-level requires (around line 40-55).

- [ ] **Step 2: Replace `checkAuth()` in generic route handler (line ~2707)**

Replace:
```javascript
    const isV2Route = url.startsWith('/api/v2/');
    const requiresV2Auth = isV2Route && getV2AuthMode() === 'strict';
    if (!shouldSkipAuth && !checkAuth(req, { requireApiKey: requiresV2Auth })) {
      sendAuthError(res, requestId, req);
      return;
    }
```

With:
```javascript
    if (!shouldSkipAuth) {
      const identity = authMiddleware.authenticate(req);
      if (!identity) {
        sendAuthError(res, requestId, req);
        return;
      }
      req._identity = identity;
    }
```

`authenticate()` already handles open mode (no keys = admin) and checks API keys, sessions, and tickets. The `requireApiKey` / V2 strict mode distinction is superseded — `authenticate()` always returns an identity when keys exist OR when open mode is active.

- [ ] **Step 3: Remove V2 auth mode dead code**

Remove `V2_AUTH_MODES` constant (line ~61) and `getV2AuthMode()` function (lines ~67-75) from `api-server.core.js`. These are now dead code since the `requiresV2Auth` variable was the only consumer.

```javascript
// Delete these:
const V2_AUTH_MODES = new Set(['permissive', 'strict']);
// ...
function getV2AuthMode() {
  try {
    const configuredMode = (serverConfig.get('v2_auth_mode', 'strict')).toLowerCase().trim();
    return V2_AUTH_MODES.has(configuredMode) ? configuredMode : 'strict';
  } catch {
    return 'strict';
  }
}
```

Also remove `getV2AuthMode` from module.exports if exported.

- [ ] **Step 4: Verify the server starts and basic REST API calls work**

Run: `curl -s http://127.0.0.1:3457/api/status`
Expected: 200 response (health route skips auth)

Run: `curl -s -H "Authorization: Bearer torque_sk_50bcf102-7caf-49a9-858f-b0ff0d0eed2a" http://127.0.0.1:3457/api/tasks`
Expected: 200 response with task list (authenticated via new system)

Run: `curl -s http://127.0.0.1:3457/api/tasks`
Expected: 401 unauthorized (no key provided, keys exist in DB)

- [ ] **Step 5: Commit**

```bash
git add server/api-server.core.js
git commit -m "fix(auth): replace checkAuth with authenticate in generic route handler"
```

---

### Task 2: Replace `checkAuth()` in shutdown handler and tool passthrough

**Files:**
- Modify: `server/api-server.core.js:2521-2526` (shutdown handler)
- Modify: `server/api-server.core.js:2800-2805` (tool passthrough)

- [ ] **Step 1: Replace `checkAuth()` in shutdown handler (line ~2523)**

Replace:
```javascript
if (!isLocalhost && !checkAuth(req)) {
  sendJson(res, { error: 'Forbidden' }, 403, req);
  return;
}
```

With:
```javascript
if (!isLocalhost && !authMiddleware.authenticate(req)) {
  sendJson(res, { error: 'Forbidden' }, 403, req);
  return;
}
```

- [ ] **Step 2: Replace `checkAuth()` in tool passthrough (line ~2802)**

**SECURITY: The tool passthrough (`/api/tools/*`) must always require a real API key, even in open mode.** The original code used `{ requireApiKey: true }` to enforce this. We preserve this by rejecting the open-mode identity.

Replace:
```javascript
if (!checkAuth(req, { requireApiKey: true })) {
  sendAuthError(res, requestId, req);
  return;
}
```

With:
```javascript
{
  const identity = authMiddleware.authenticate(req);
  if (!identity || identity.id === 'open-mode') {
    sendAuthError(res, requestId, req);
    return;
  }
}
```

The block scope `{ ... }` avoids shadowing the `identity` from `req._identity` set by the generic handler.

- [ ] **Step 3: Remove `checkAuth` from imports and exports**

At line ~48, remove `checkAuth` from the middleware destructure:
```javascript
// Remove this line:
  checkAuth,
```

At line ~2918, remove `checkAuth` from module.exports.

- [ ] **Step 4: Verify shutdown and tool passthrough work**

Run: `curl -s -X POST http://127.0.0.1:3457/api/shutdown` (from localhost)
Expected: Server shuts down (localhost bypass still works)

- [ ] **Step 5: Commit**

```bash
git add server/api-server.core.js
git commit -m "fix(auth): replace remaining checkAuth calls with authenticate"
```

---

### Task 3: Remove legacy `checkAuth()` and `ensureApiKey()`

**Files:**
- Modify: `server/api/middleware.js:266-292` (remove `checkAuth` function)
- Modify: `server/api/middleware.js:4` (remove `crypto` require — only used by `checkAuth`)
- Modify: `server/db/config-core.js:168-175` (remove `ensureApiKey` function)
- Modify: `server/database.js:559-562,606,779` (remove `ensureApiKey` calls/exports)

- [ ] **Step 1: Remove `checkAuth()` and `crypto` from `api/middleware.js`**

Delete lines 266-292 (the `checkAuth` function and its JSDoc). Remove `checkAuth` from `module.exports`. Also remove the `crypto` require at line 4 — it is only used by `checkAuth` (confirmed: no other function in this file uses `crypto`).

- [ ] **Step 2: Remove `ensureApiKey()` from `config-core.js`**

Delete the `ensureApiKey` function (lines 168-175) and remove it from `module.exports` (line 185).

- [ ] **Step 3: Remove `ensureApiKey` from `database.js`**

Remove the call at line ~559:
```javascript
// Delete these lines:
const generatedKey = configCore.ensureApiKey();
if (generatedKey) {
  logger.info('API key configured (set TORQUE_API_KEY or X-Torque-Key header to authenticate)');
}
```

Remove the facade function at line ~606:
```javascript
// Delete:
function ensureApiKey() { return configCore.ensureApiKey(); }
```

Remove `ensureApiKey` from `module.exports` at line ~779.

- [ ] **Step 4: Clean up legacy `config.api_key` from database**

In `server/index.js` after `keyManager.migrateConfigApiKey()` (line ~525), add defense-in-depth cleanup. The migration function already deletes `config.api_key` on first run, but this handles the edge case where someone manually re-added a legacy key after migration:

```javascript
// Defense-in-depth: remove stale config.api_key if new auth system has keys
try {
  const dbInst = db.getDbInstance();
  const legacyKey = dbInst.prepare("SELECT value FROM config WHERE key = 'api_key'").get();
  if (legacyKey && keyManager.hasAnyKeys()) {
    dbInst.prepare("DELETE FROM config WHERE key = 'api_key'").run();
  }
} catch {}
```

- [ ] **Step 5: Commit**

```bash
git add server/api/middleware.js server/db/config-core.js server/database.js server/index.js
git commit -m "fix(auth): remove legacy checkAuth and ensureApiKey"
```

---

### Task 4: Update tests

**Files:**
- Modify: `server/tests/api-middleware.test.js:103-151` (remove `checkAuth` tests)

- [ ] **Step 1: Remove the `checkAuth` test block**

Delete the entire `describe('checkAuth', ...)` block (lines 103-152). These tests validated the legacy single-key comparison which no longer exists. The new auth system is tested in `server/tests/auth-system.test.js`.

- [ ] **Step 2: Verify no other tests reference `checkAuth`**

Run: `grep -r "checkAuth" server/tests/`
Expected: No matches

- [ ] **Step 3: Run the full test suite**

Run: `torque-remote npx vitest run server/tests/api-middleware.test.js`
Expected: All remaining tests pass

Run: `torque-remote npx vitest run server/tests/auth-system.test.js`
Expected: All auth system tests pass (these test the new system)

- [ ] **Step 4: Commit**

```bash
git add server/tests/api-middleware.test.js
git commit -m "test(auth): remove legacy checkAuth tests"
```

---

### Task 5: Integration verification

- [ ] **Step 1: Restart TORQUE server**

```bash
bash /path/to/torque/stop-torque.sh
TORQUE_DATA_DIR="/path/to/torque-data" nohup node /path/to/torque/server/index.js > /dev/null 2>&1 &
sleep 5
```

- [ ] **Step 2: Verify legacy key is cleaned up**

```bash
sqlite3 "/path/to/torque-data/tasks.db" "SELECT value FROM config WHERE key = 'api_key';"
```
Expected: No output (legacy key deleted)

- [ ] **Step 3: Verify REST API accepts `torque_sk_` keys**

```bash
curl -s -H "Authorization: Bearer torque_sk_50bcf102-7caf-49a9-858f-b0ff0d0eed2a" http://127.0.0.1:3457/api/tasks | head -c 200
```
Expected: 200 with task data

- [ ] **Step 4: Verify REST API rejects invalid keys**

```bash
curl -s -H "Authorization: Bearer bad-key" http://127.0.0.1:3457/api/tasks
```
Expected: 401 unauthorized

- [ ] **Step 5: Verify MCP still works**

Run `/mcp` in Claude Code.
Expected: "Reconnected to torque."

- [ ] **Step 6: Verify dashboard login still works**

```bash
curl -s -X POST http://127.0.0.1:3457/api/auth/login -H "Content-Type: application/json" -d '{"key":"torque_sk_50bcf102-7caf-49a9-858f-b0ff0d0eed2a"}'
```
Expected: 200 with `{ "success": true, "role": "admin", "csrfToken": "..." }`

- [ ] **Step 7: Verify tool passthrough rejects in open mode**

This verifies the security-critical behavior: even with no keys configured, the tool REST passthrough must require authentication.

```bash
# This test requires temporarily removing all keys — skip in production.
# The code path is: identity.id === 'open-mode' → reject
```

- [ ] **Step 8: Final push**

```bash
git push
```
