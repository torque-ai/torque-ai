# User Authentication System Design

**Goal:** Replace API-key-only dashboard login with username/password authentication, supporting multiple users with role-based access control, while preserving API key auth for machine clients.

## Data Model

### New `users` table

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,                          -- UUID
  username TEXT UNIQUE NOT NULL,                -- case-insensitive (stored lowercase, trimmed)
  password_hash TEXT NOT NULL,                  -- bcrypt hash ($2b$ prefix)
  display_name TEXT,                            -- optional friendly name (max 200 chars)
  role TEXT NOT NULL DEFAULT 'viewer',          -- 'admin', 'manager', 'operator', 'viewer'
  created_at TEXT NOT NULL,                     -- ISO 8601
  updated_at TEXT,                              -- ISO 8601
  last_login_at TEXT                            -- ISO 8601
);
```

The `UNIQUE` constraint on `username` creates an implicit index in SQLite, so no separate index is needed.

**Username rules:** 3-64 characters, lowercase alphanumeric plus `-` and `_`. Trimmed and lowercased before storage. Empty string after normalization is rejected.

**Password rules:** 8-72 characters (bcrypt truncates at 72 bytes). Blank passwords rejected.

### `api_keys` table modification

```sql
ALTER TABLE api_keys ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
```

- Existing keys (no `user_id`) continue working as standalone admin keys.
- New keys created by a user get `user_id` set.
- User-owned keys inherit the user's **current** role at validation time (not creation time), so role changes take effect immediately. The `api_keys.role` column is **ignored** for user-owned keys — the user's current role is always used.
- When a user is deleted, their keys are cascade-deleted.

## Roles

Four roles with a strict hierarchy: `admin > manager > operator > viewer`.

| Action | admin | manager | operator | viewer |
|--------|-------|---------|----------|--------|
| View tasks/dashboard | Yes | Yes | Yes | Yes |
| Submit tasks | Yes | Yes | Yes | No |
| Cancel own tasks | Yes | Yes | Yes | No |
| Cancel any task | Yes | Yes | No | No |
| Manage workflows | Yes | Yes | Yes (own) | No |
| Reorder queue / priority | Yes | Yes | No | No |
| Configure providers/hosts | Yes | No | No | No |
| Manage API keys (own) | Yes | Yes | Yes | Yes |
| Manage API keys (all) | Yes | No | No | No |
| Manage users | Yes | No | No | No |
| Server config/shutdown | Yes | No | No | No |

**Future:** Per-project role overrides (backlogged). The `role` column is the user's default/global role. Permission-check functions should accept an optional `projectId` parameter so the interface doesn't change when project roles are added.

## Auth Flows

### Dashboard login (username + password)

1. User enters username + password in the login form.
2. `POST /api/auth/login` with `{ username, password }`.
3. Server looks up user by lowercase username, verifies bcrypt hash via `bcryptjs.compare()`.
4. On success: creates session cookie (existing `session-manager.js`), returns `{ success, role, csrfToken, user: { id, username, displayName } }`.
5. Identity object carries `{ id, name, role, type: 'user' }`.

### API key login (backward compatible)

`POST /api/auth/login` with `{ key }` — existing flow, unchanged. Returns the same response shape. Identity carries `{ id, name, role, type: 'api_key' }`.

### API key auth (machine clients)

`Authorization: Bearer torque_sk_...` or `X-Torque-Key: torque_sk_...` — unchanged. If the key has a `user_id`, `validateKey()` fetches the user's current role instead of using the key's stored role.

### First-launch setup

**Dashboard wizard:** If no users exist, the dashboard shows a "Create Admin Account" form instead of the login page.

- `POST /api/auth/setup` — `{ username, password, displayName? }`
- Only works when the `users` table is empty. Returns 403 if users exist.
- Rate-limited by `loginLimiter` (same as login endpoint).
- Creates the user with `role: 'admin'`.
- Automatically logs them in (creates session, returns CSRF token).

**CLI alternative:** `node server/index.js --create-admin`
- Prompts for username and password interactively on the terminal.
- Only works when no users exist (same guard as setup endpoint). Prints error and exits if users already exist.
- Creates admin user and exits.
- For headless/automated deployments.

### Open mode

Open mode activates when no users exist AND no API keys exist. A centralized `isOpenMode()` function checks both conditions:

```javascript
function isOpenMode() {
  return !keyManager.hasAnyKeys() && !userManager.hasAnyUsers();
}
```

This replaces all existing `!keyManager.hasAnyKeys()` open-mode checks across the codebase. Call sites that need updating:
- `server/auth/middleware.js` — `authenticate()` function
- `server/mcp-sse.js` — SSE connection auth and tool-call auth check
- `server/api-server.core.js` — `handleDashboardLogin()` open-mode bypass

Once either a user or an API key is created, auth is enforced everywhere.

### Auth status endpoint

`GET /api/auth/status` must be updated to support the setup wizard. Response shape:

```javascript
// No users exist, no keys exist → open mode
{ authenticated: true, mode: 'open', needsSetup: false }

// Users exist but client is not authenticated → show login
{ authenticated: false, needsSetup: false }

// No users exist but keys exist → show setup wizard
{ authenticated: false, needsSetup: true }

// Authenticated via user session
{ authenticated: true, mode: 'authenticated', user: { id, username, displayName, role } }
```

The dashboard uses `needsSetup` to decide whether to show the setup wizard or the login form.

## API Endpoints

### Setup (unauthenticated — only when no users exist)

- `POST /api/auth/setup` — `{ username, password, displayName? }` → creates first admin, returns session. Rate-limited.

### Login (unauthenticated)

- `POST /api/auth/login` — `{ username, password }` or `{ key }` (backward compat)

### User management (admin only)

- `GET /api/auth/users` — list all users (no password hashes returned)
- `POST /api/auth/users` — `{ username, password, role, displayName? }` → create user
- `PATCH /api/auth/users/:id` — update role, displayName, or password
- `DELETE /api/auth/users/:id` — delete user (cascade-deletes their API keys). Cannot delete last admin (see Last Admin Protection below).

### Self-service (any authenticated user)

- `GET /api/auth/me` — get own profile (id, username, displayName, role)
- `PATCH /api/auth/me` — change own password (requires `{ currentPassword, newPassword }`) or displayName (not role)

### Existing endpoints (modified behavior)

- `POST /api/auth/keys` — optionally accepts `user_id` (admin) or auto-sets to current user
- `GET /api/auth/keys` — admin sees all keys; others see only their own
- `DELETE /api/auth/keys/:id` — admin can revoke any; others can only revoke their own

### Unchanged endpoints

- `POST /api/auth/logout`
- `POST /api/auth/ticket`

## Last Admin Protection

The system must prevent lockout by ensuring at least one admin access source exists at all times. "Admin access source" means either an admin user OR an orphan admin API key (no `user_id`).

Before deleting a user or revoking a key, count total admin sources:
```
admin_sources = (admin users) + (orphan admin keys where user_id IS NULL)
```

If the operation would reduce `admin_sources` to zero, block it with an error.

## Role Guard

A new `server/auth/role-guard.js` provides hierarchical role checking:

```javascript
const ROLE_HIERARCHY = ['viewer', 'operator', 'manager', 'admin'];

function requireRole(identity, minRole, projectId = null) {
  if (!identity) return false;
  const identityLevel = ROLE_HIERARCHY.indexOf(identity.role);
  const requiredLevel = ROLE_HIERARCHY.indexOf(minRole);
  if (identityLevel === -1 || requiredLevel === -1) return false;
  return identityLevel >= requiredLevel;
}
```

This **replaces** the existing `requireRole()` in `server/auth/middleware.js` (which does exact-match, not hierarchy). The old function should be removed and all call sites migrated:
- `server/auth/middleware.js` — delete `requireRole`, update export
- `server/api-server.core.js` — replace inline `identity.role !== 'admin'` checks at `handleCreateApiKey`, `handleListApiKeys`, `handleRevokeApiKey` with `requireRole(identity, 'admin')`

## Session Invalidation

**Known limitation:** Role changes take effect on next login. Existing sessions carry a snapshot of the identity at login time. If an admin changes a user's role, the user's active sessions retain the old role until they log out or the session expires (24h TTL).

**User deletion:** When a user is deleted, all their sessions must be immediately invalidated. Add `destroySessionsByIdentityId(userId)` to `session-manager.js`.

## New Files

| File | Responsibility |
|------|---------------|
| `server/auth/user-manager.js` | User CRUD: create, validate password, list, update, delete. Bcrypt hashing via `bcryptjs`. Username normalization (lowercase, trim, validation). `hasAnyUsers()` for open-mode check. |
| `server/auth/role-guard.js` | `requireRole(identity, minRole, projectId?)` — hierarchical role check. Replaces `middleware.requireRole()`. |

## Modified Files

| File | Changes |
|------|---------|
| `server/db/schema-tables.js` | Add `users` table creation. Add `user_id` column migration for `api_keys`. |
| `server/auth/middleware.js` | Replace `hasAnyKeys()` open-mode check with centralized `isOpenMode()`. Remove old `requireRole()` — replaced by `role-guard.js`. |
| `server/auth/key-manager.js` | Add `user_id` parameter to `createKey()`. In `validateKey()`, if key has `user_id`, fetch user's current role instead of using stored key role (ignore `api_keys.role` column for user-owned keys). |
| `server/auth/session-manager.js` | Add `destroySessionsByIdentityId(userId)` for user deletion cleanup. No schema changes — identity object now includes `type` field. |
| `server/api-server.core.js` | Add handlers: `handleSetup`, `handleCreateUser`, `handleListUsers`, `handleUpdateUser`, `handleDeleteUser`, `handleGetMe`, `handleUpdateMe`. Modify `handleDashboardLogin` to accept `{ username, password }`. Modify `handleAuthStatus` to return `needsSetup`. Replace inline role checks with `requireRole()` from role-guard. |
| `server/api/routes.js` | Register new routes with appropriate `skipAuth` flags. |
| `server/mcp-sse.js` | Replace `hasAnyKeys()` open-mode check with `isOpenMode()`. |
| `server/index.js` | Handle `--create-admin` CLI flag. |
| `dashboard/src/components/Login.jsx` | Replace API key input with username + password form. Show setup form if `needsSetup` is true from auth status. |

## Password Storage

- **Library:** `bcryptjs` (pure JS, no native deps)
- **Cost factor:** 12 rounds (default, ~250ms on modern hardware)
- **Hash format:** `$2b$12$...` (bcrypt identifier built into hash string)
- **Validation:** `bcryptjs.compare(plaintext, hash)` — timing-safe by design
- **Constraints:** 8-72 characters, blank rejected

## Security Considerations

- Passwords are never stored in plaintext or logs.
- `bcryptjs.compare()` is constant-time.
- Existing login rate limiter (`auth/rate-limiter.js`) applies to both password login and setup endpoint.
- Cannot delete the last admin (counts admin users + orphan admin keys).
- Setup endpoint is disabled once any user exists (prevents privilege escalation).
- Self-service password change requires current password (`{ currentPassword, newPassword }`).
- CSRF protection (existing) applies to all state-changing endpoints.
- User deletion invalidates all sessions for that user immediately.

## Migration Path

- Existing API keys continue working unchanged (standalone admin auth).
- No forced migration — orphan keys (no `user_id`) work indefinitely.
- Open mode preserved — if no users AND no keys exist, everything is accessible.
- Dashboard login form changes from API key to username/password, but `{ key }` login remains as a backward-compatible path.

## Out of Scope

- OAuth/SSO (future — identity layer designed for it via `type` field)
- Per-project roles (future — `requireRole()` accepts optional `projectId`)
- Password reset (future — needs email/notification system)
- Argon2 migration (future — re-hash lazily on next login)
- User management dashboard page (future — API-only for now)

## Testing

- **user-manager.js:** Create user, validate correct/incorrect password, duplicate username rejection, role validation, username normalization (case, trim, invalid chars), password length limits, `hasAnyUsers()`.
- **role-guard.js:** Hierarchy checks (admin > manager > operator > viewer), edge cases (unknown role, null identity).
- **Login flow:** Password login success/failure, API key backward compat, rate limiting on both.
- **Setup flow:** Works when empty, rejects when users exist, rate-limited, creates admin.
- **User CRUD:** Admin can create/list/update/delete users. Non-admin rejected. Cannot delete last admin (cross-domain check with orphan keys).
- **Self-service:** User can change own password (requires current password) and displayName. Cannot change own role.
- **Key ownership:** User-owned keys inherit user's current role. Cascade delete on user removal.
- **Session invalidation:** Deleted user's sessions are destroyed immediately.
- **Open mode:** Activates only when no users AND no keys exist. Creating a user alone disables open mode.
