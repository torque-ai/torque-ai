# TORQUE Auth System — Enterprise-Ready Authentication

**Date:** 2026-03-20
**Status:** Draft

## Problem

TORQUE needs authenticated access across all transports (MCP SSE, REST API, dashboard, CLI) for localhost dev, LAN deployment, and eventually enterprise/web. The current API key implementation (added by another session) blocks MCP SSE connections because the `EventSource` API cannot send custom headers. The dashboard has no auth at all. There's no path to OAuth/SSO for enterprise.

## Solution

A pluggable auth middleware with transport-specific mechanisms:

- **REST API** — `Authorization: Bearer <api_key>` header (standard)
- **MCP SSE** — ticket exchange (one-time nonce) for enterprise, `?apiKey=` for local dev
- **Dashboard** — login page with cookie sessions + CSRF protection
- **CLI** — bearer header from env var or flag

All transports resolve through a single auth middleware that today checks API keys and tomorrow plugs in OAuth.

## Design Decisions

- **Pluggable resolvers.** Auth middleware is a chain of resolvers (API key, session, ticket, future OAuth). Adding OAuth is a new resolver, not a rewrite.
- **API keys for self-hosted, OAuth-ready for cloud.** Start simple, design for extension.
- **Ticket exchange for SSE.** Industry standard (Slack, Discord pattern). One-time nonce, 30-second TTL, solves the EventSource header limitation.
- **Open mode.** Zero API keys = no auth enforcement. First key creation enables auth. Fresh installs just work.
- **HMAC-SHA-256 key hashing.** Keys hashed with a server-level secret (generated on first install, stored in DB). Leaked database alone is insufficient to recover keys — attacker also needs the server secret. Keys must be UUID v4 (122-bit entropy), making brute-force infeasible.
- **Dashboard login with CSRF protection.** Cookie sessions with `SameSite=Strict` and CSRF tokens on state-mutating requests.
- **TLS required for non-localhost.** Ticket exchange and `?apiKey=` are safe on localhost. Enterprise/LAN deployment must use TLS (reverse proxy). The spec does not implement TLS directly.

## Architecture

### Layer 1: Credential Store

New `api_keys` table:

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | UUID |
| `key_hash` | TEXT NOT NULL | HMAC-SHA-256 of plaintext key (using server secret) |
| `name` | TEXT NOT NULL | Human label ("My laptop") |
| `role` | TEXT NOT NULL | `admin` or `operator` |
| `created_at` | TEXT NOT NULL | ISO timestamp |
| `last_used_at` | TEXT | Updated at most once per minute (batched) |
| `revoked_at` | TEXT | Soft revocation (key stops working) |

**Server secret:** A random 256-bit value generated on first install, stored in `config` table as `auth_server_secret`. Used as the HMAC key for all key hashing. Never exposed via API.

**Key format:** `torque_sk_<uuid-v4>`. The `torque_sk_` prefix makes keys visually distinguishable and grep-able in logs for accidental exposure detection. Keys are always UUID v4 (122-bit entropy).

**Roles:**

| Role | Can Do | Cannot Do |
|------|--------|-----------|
| `admin` | Everything: create/revoke keys, configure providers, manage approvals, cancel any task, server config | — |
| `operator` | Submit tasks, check status, run workflows, view dashboard, cancel own tasks | Create/revoke keys, change server config, manage providers |

**Role-to-endpoint mapping:**

| Endpoint / Tool Category | admin | operator |
|--------------------------|-------|----------|
| Key management (`/api/auth/keys`, `create_api_key`, `revoke_api_key`) | Yes | No |
| Provider config (`configure_provider`, `update_provider`, `add_ollama_host`) | Yes | No |
| Server config (`set_config`, strategic config tools) | Yes | No |
| Task submission (`submit_task`, `smart_submit_task`) | Yes | Yes |
| Task status/result (`check_status`, `get_result`, `list_tasks`) | Yes | Yes |
| Task cancellation (`cancel_task`) | Yes | Own tasks only |
| Workflows (`create_workflow`, `await_workflow`) | Yes | Yes |
| Approvals (`approve_task`, `reject_approval`) | Yes | No |
| Dashboard view (all pages) | Yes | Yes |

Viewer role deferred until enterprise dashboard sharing is needed.

### Layer 2: Auth Middleware — Pluggable Resolver

**Credential extraction:** Each transport extracts the credential before calling the resolver. The resolver receives a typed credential object, not a raw request:

```javascript
// Credential types
{ type: 'api_key', value: '<plaintext key>' }
{ type: 'session', value: '<session_id from cookie>' }
{ type: 'ticket', value: '<one-time ticket>' }

// Resolver chain
function resolveIdentity(credential) {
  const resolver = resolverMap[credential.type];
  if (!resolver) throw new AuthError('Unknown credential type');
  return resolver(credential.value);
}
```

Each transport is responsible for extracting the right credential type. The resolver map dispatches to the correct resolver — no sequential chain, no wasted lookups.

**Resolvers:**
- `apiKeyResolver` — HMAC-SHA-256 hash the provided key with server secret, look up in `api_keys` table
- `sessionResolver` — look up session_id in memory map
- `ticketResolver` — look up one-time ticket in memory, consume it
- (future) `oauthResolver` — validate JWT from OAuth provider

**Open mode bypass:** If `api_keys` table has zero non-revoked rows, middleware returns a default admin identity without credential check.

**Identity object:**
```javascript
{ id: 'key-uuid', name: 'My laptop', role: 'admin' }
```

**Audit:** Successful auth updates `last_used_at` (batched — at most once per minute per key to avoid DB write storms). Failed auth attempts logged with IP address.

### Layer 3: Transport-Specific Auth

#### REST API (port 3457)

Standard bearer token:
```
Authorization: Bearer torque_sk_a1b2c3d4-...
```

Also accepts legacy `X-Torque-Key` header during transition period (logs deprecation warning). Remove after one release cycle.

**Rate limiting:** 10 failed auth attempts per IP per minute. After exceeding, return `429 Too Many Requests` with `Retry-After` header.

#### MCP SSE (port 3458) — Ticket Exchange

**For enterprise/web/browser clients:**
```
1. POST /api/auth/ticket
   Authorization: Bearer <api_key>
   → { "ticket": "one-time-uuid" }

2. GET /sse?ticket=one-time-uuid
   → SSE connection established, session authenticated
   → Ticket immediately invalidated (single-use)
```

**Ticket properties:**
- UUID v4
- 30-second TTL
- Single-use (invalidated on first SSE connection)
- In-memory storage only (no DB — tickets don't survive restart)
- Max 100 outstanding tickets. On cap: reject new ticket requests with `503 Service Unavailable`.
- **Requires TLS for non-localhost deployments.** An intercepted ticket can be used before the legitimate client. On localhost this is negligible risk.
- Response includes `Referrer-Policy: no-referrer` header to prevent URL leakage.

**For local dev / CLI plugin configs:**
```
GET /sse?apiKey=<api_key>
→ SSE connection established, session authenticated
```

The `?apiKey=` bootstrap mechanism is accepted on the SSE endpoint for simplicity in `.mcp.json` configs. **Security tradeoff:** the key appears in the URL, which may be logged by HTTP access logs or reverse proxies. For enterprise deployment, use ticket exchange instead and configure the reverse proxy to strip `apiKey` query params from logs.

**If both `?apiKey=` and `?ticket=` are present:** `ticket` takes precedence. The API key is ignored.

**SSE with invalid auth:** Connection succeeds (SSE is established) but the session is marked unauthenticated. On `tools/list`, the server returns an empty tool list. On `tools/call`, the server returns an error: `"Authentication required. Provide API key via TORQUE_API_KEY environment variable."` This gives the client a clear signal without breaking the SSE protocol.

**`.mcp.json` configuration:**
```json
{
  "mcpServers": {
    "torque": {
      "type": "sse",
      "url": "http://127.0.0.1:3458/sse?apiKey=${TORQUE_API_KEY}",
      "description": "TORQUE"
    }
  }
}
```

#### Dashboard (port 3456) — Cookie Session

**Login flow:**
```
1. User opens dashboard → no session cookie → redirect to /login
2. User pastes API key, clicks Login
3. POST /api/auth/login { key: "<api_key>" }
4. Server validates, creates session (UUID), stores in memory
5. Sets cookie: torque_session=<session_id>; Path=/; HttpOnly; SameSite=Strict
6. Also sets CSRF token cookie: torque_csrf=<token>; Path=/; SameSite=Strict
   (readable by JavaScript, NOT HttpOnly — client sends it as header on mutations)
7. Redirect to dashboard home
```

**CSRF protection:** State-mutating requests (POST, PUT, DELETE) must include `X-CSRF-Token` header matching the `torque_csrf` cookie value. The server validates the match. GET requests are exempt (read-only). This is the double-submit cookie pattern — no server-side token storage needed.

**Session properties:**
- In-memory Map (session_id → identity + csrf_token)
- 24-hour sliding expiration (resets on each request)
- Invalidated on server restart (user logs in again)
- Max 50 concurrent sessions. On cap: evict the least-recently-used session.
- `POST /api/auth/logout` clears cookie and removes session
- Re-login regenerates session ID (prevents session fixation)

**WebSocket/SSE from dashboard:** Dashboard real-time connections (WebSocket for task updates) authenticate via the cookie, same as HTTP requests. The `upgrade` request carries the cookie automatically.

**HTTPS:** Cookies work over HTTP on localhost. For enterprise deployment behind TLS, set `Secure` flag via config option `auth_cookie_secure: true`.

## API Key Management

### MCP Tools

- `create_api_key { name, role }` — returns plaintext key (shown once, never stored). Admin only.
- `list_api_keys` — shows id, name, role, created_at, last_used_at (never shows key). Admin only.
- `revoke_api_key { id }` — sets revoked_at, key immediately stops working. Admin only. **Cannot revoke the last admin key** — returns error "Cannot revoke the last admin key. Create another admin key first."

### REST Endpoints

- `POST /api/auth/keys` — create key (admin only)
- `GET /api/auth/keys` — list keys (admin only)
- `DELETE /api/auth/keys/:id` — revoke key (admin only)
- `POST /api/auth/ticket` — exchange bearer key for one-time SSE ticket (any role)
- `POST /api/auth/login` — exchange key for dashboard session cookie (any role)
- `POST /api/auth/logout` — clear dashboard session

**Rate limiting on login:** 5 failed attempts per IP per minute. After exceeding, return `429 Too Many Requests`.

### First-Run Bootstrap

On fresh install with no keys, the server generates one admin key and prints it to stdout on startup:

```
═══════════════════════════════════════════════════════════
  TORQUE Admin API Key (save this — it won't be shown again):

  torque_sk_a1b2c3d4-e5f6-7890-abcd-ef1234567890

  Set as environment variable:
  export TORQUE_API_KEY="torque_sk_a1b2c3d4-..."
═══════════════════════════════════════════════════════════
```

### Open Mode → Auth Mode Transition

When the first API key is created (open mode → auth mode), **existing connections are not terminated**. They continue working until they disconnect naturally. New connections must authenticate. This avoids breaking the user's own session when they run `create_api_key` from an MCP tool call.

## Migration

### From Current State

1. On startup, create `api_keys` table if it doesn't exist.
2. Generate `auth_server_secret` if it doesn't exist (random 256-bit, store in `config`).
3. If `config.api_key` has a non-empty value and `api_keys` table is empty:
   a. Hash the plaintext value: `HMAC-SHA-256(plaintext_key, server_secret)`
   b. Insert into `api_keys` with role=admin, name="Migrated key"
   c. The user's existing key continues to work (they have the plaintext, server has the hash)
4. Delete `config.api_key` after successful migration.
5. Empty or null `config.api_key` skips migration.

### Transition Period

Support both `X-Torque-Key` and `Authorization: Bearer` headers. Log deprecation warning for `X-Torque-Key`. Remove after one release cycle.

### `.mcp.json` Update

Users add `?apiKey=${TORQUE_API_KEY}` to their SSE URL. The `.mcp.json.example` template is updated to include this.

## Known Limitations

- **In-memory ticket and session stores** do not survive server restarts. Acceptable for single-process architecture. If TORQUE ever runs multi-process (PM2 cluster, horizontal scaling), these stores need to move to DB or shared cache (Redis).
- **No key rotation primitive.** Users rotate manually: create new key → update clients → revoke old key. A `rotate_api_key` convenience tool is deferred.
- **TLS not implemented by TORQUE.** Enterprise deployments put TORQUE behind a reverse proxy (nginx, Caddy) for TLS termination.

## Files Created/Modified

| File | Action | Responsibility |
|------|--------|---------------|
| `server/auth/middleware.js` | Create | Credential extraction + resolver dispatch |
| `server/auth/resolvers.js` | Create | API key, session, ticket resolvers |
| `server/auth/key-manager.js` | Create | Key CRUD, HMAC hashing, validation |
| `server/auth/session-manager.js` | Create | Dashboard cookie sessions + CSRF |
| `server/auth/ticket-manager.js` | Create | SSE ticket exchange |
| `server/auth/rate-limiter.js` | Create | Per-IP rate limiting for auth endpoints |
| `server/db/schema-tables.js` | Modify | Add `api_keys` table |
| `server/db/schema-migrations.js` | Modify | Migrate `config.api_key`, generate server secret |
| `server/api/routes.js` | Modify | Add `/api/auth/*` endpoints |
| `server/mcp-sse.js` | Modify | Use ticket/apiKey auth on SSE connect |
| `server/mcp-protocol.js` | Modify | Use auth middleware instead of inline check |
| `server/tool-defs/auth-defs.js` | Create | MCP tool definitions for key management |
| `server/handlers/auth-handlers.js` | Create | MCP tool handlers |
| `dashboard/src/components/Login.jsx` | Create | Login page component |
| `dashboard/src/App.jsx` | Modify | Add login route + auth guard |
| `.mcp.json.example` | Modify | Add apiKey query param |

## Testing Strategy

### Auth middleware
- Open mode (no keys) allows all requests
- First key creation enables enforcement
- Invalid key rejected with 401
- Revoked key rejected with 401
- Role enforcement: operator blocked from admin endpoints
- Role enforcement: operator can submit/cancel own tasks
- `last_used_at` batched update (not on every request)
- Legacy `X-Torque-Key` header accepted with deprecation warning

### Rate limiting
- 6th failed login in 1 minute returns 429
- 11th failed REST auth in 1 minute returns 429
- Rate limit resets after the window expires
- Successful auth is not counted against rate limit

### CSRF protection
- Dashboard POST without X-CSRF-Token header rejected with 403
- Dashboard POST with valid X-CSRF-Token succeeds
- Dashboard GET requests work without CSRF token

### Ticket exchange
- Valid bearer key generates ticket
- Ticket expires after 30 seconds
- Ticket is single-use (second connection rejected)
- 101st ticket request returns 503 (cap exceeded)
- Invalid ticket rejected
- `?ticket=` takes precedence over `?apiKey=` when both present

### Dashboard sessions
- Login with valid key creates cookie session
- Login with invalid key rejected
- Cookie session grants access to dashboard API
- Session expires after 24h inactivity
- Logout clears session
- 51st session evicts LRU session
- Re-login regenerates session ID

### SSE auth
- `?apiKey=<valid>` creates authenticated session
- `?apiKey=<invalid>` → SSE connects, tools/list returns empty, tools/call returns auth error
- `?ticket=<valid>` creates authenticated session
- No auth params in open mode still works
- Response includes `Referrer-Policy: no-referrer`

### Key management
- Create key returns plaintext (once)
- List keys never shows plaintext or hash
- Revoke key stops it from working immediately
- Cannot revoke last admin key
- Concurrent key creation is safe (atomic check)

### Migration
- Existing `config.api_key` hashed and migrated to `api_keys` table
- Migrated key works for all transports
- Empty `config.api_key` skips migration
- Server secret generated on first install
- First-run bootstrap prints admin key to stdout

### Edge cases
- Open-to-auth transition: existing connections continue, new ones require auth
- Server restart: dashboard sessions invalidated, users re-login
- WebSocket upgrade requests authenticated via cookie
