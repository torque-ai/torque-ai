# Auth Plugin Extraction — Local-First, Enterprise-Optional

**Date:** 2026-03-25
**Status:** Approved
**Supersedes:** Layer 2-4 of the user auth roadmap (multi-user, roles, LAN auth deferred to enterprise plugin)

## Problem

TORQUE currently requires API key authentication for all connections, even single-user local installs. This adds friction (key generation, `.torque-api-key` files, MCP config with baked-in keys) to a use case that doesn't need it. Local users should get zero-config access. Auth should exist only when explicitly opted into for enterprise/multi-user scenarios.

## Decision

Strip all authentication from TORQUE's default boot path. Rebuild auth as an optional plugin at `server/plugins/auth/` with a standard plugin contract. Establish a plugin system pattern for future optional modules.

## Design

### Local Mode (default)

**Binding:** Server listens on `127.0.0.1` only (dashboard 3456, REST 3457, MCP SSE 3458). Physically unreachable from the network.

**Request handling:** No auth middleware. Every REST and SSE request is accepted unconditionally.

**MCP config injection:** Simplified — injects `http://127.0.0.1:3458/sse` into `~/.claude/.mcp.json` with no `apiKey` query param.

**Task submission:** No user identity stamped. `created_by` is `null` or `"local"`.

**MCP tools:** Auth-related tools (`create_api_key`, `list_api_keys`, `create_user`, etc.) are not registered.

**What does NOT run at startup:**
- Bootstrap key generation
- `.torque-api-key` file creation
- Auth middleware registration
- Key migration logic
- SSE ticket exchange
- Rate limiting
- Role checks

### Plugin Contract

Every TORQUE plugin implements this interface:

```js
// server/plugins/plugin-contract.js
{
  name: 'string',           // unique plugin identifier
  version: 'string',        // semver

  // Lifecycle
  install(container),       // called at boot — receives DI container, registers services
  uninstall(),              // cleanup on shutdown

  // Integration points
  middleware(),             // returns Express middleware array (or [])
  mcpTools(),              // returns array of MCP tool definitions to register (or [])
  eventHandlers(),         // returns { eventName: handler } map for the event bus (or {})

  // Metadata
  configSchema(),          // returns JSON schema for this plugin's config keys
}
```

**Plugin loader** (`server/plugins/loader.js`):
- Reads `auth_mode` from config (`"local"` default, `"enterprise"` to activate)
- Validates plugin implements the contract
- Error in plugin loading logs a warning, falls back to local mode — never crashes the server
- Extensible to a `plugins: []` array pattern for future plugins

**Boot sequence:**
1. Init DB, event bus, container (unchanged)
2. Init serverConfig (unchanged)
3. Check `auth_mode` config
4. If `"local"`: bind `127.0.0.1`, run simplified MCP config injector, done
5. If `"enterprise"`: load `server/plugins/auth/index.js`, call lifecycle methods, bind `0.0.0.0`

### Auth Plugin Architecture

```
server/plugins/auth/
  index.js            — plugin entry, implements the contract
  key-manager.js      — API key CRUD, HMAC-SHA-256 hashing
  user-manager.js     — username/password auth, bcrypt, roles
  session-manager.js  — in-memory session store, CSRF tokens
  middleware.js        — credential extraction, authenticate()
  resolvers.js         — pluggable resolver chain (key → ticket → session)
  role-guard.js        — role hierarchy enforcement (viewer < operator < manager < admin)
  rate-limiter.js      — IP-based rate limiting
  sse-auth.js          — SSE ticket exchange (merges current ticket-manager.js + sse-tickets.js)
  config-injector.js   — MCP config injection WITH api key (enterprise version)
  tests/               — all auth tests, self-contained
```

**`install(container)` does:**
1. Init key-manager, user-manager, session-manager with DB from container
2. Run bootstrap key flow (create first admin key if none exist, write `.torque-api-key`)
3. Inject MCP config with API key baked into URL
4. Override server binding to `0.0.0.0`

**`middleware()` returns:**
- The `authenticate()` function — checks Bearer/header/cookie/ticket on every request

**`mcpTools()` returns:**
- `create_api_key`, `list_api_keys`, `revoke_api_key`
- `create_user`, `list_users`, `delete_user`

**`eventHandlers()` returns:**
- Task submission events → stamp `created_by` with authenticated user identity

### Enterprise Activation

1. Set `auth_mode: "enterprise"` via env var `TORQUE_AUTH_MODE` (checked first) or DB config table (fallback)
2. Restart TORQUE
3. Plugin loads: bootstrap key generated, MCP config updated with key, auth enforced on all endpoints
4. Server binds to `0.0.0.0` (LAN-accessible)

### Dead Code Removal (Phase 2)

After the plugin is built and verified, strip all auth code from the main codebase:

**Delete:**
- `server/auth/` directory (all 10 files)

**Strip from `server/index.js`:**
- Bootstrap key generation block
- `keyManager.init()`, `userManager.init()`, `keyManager.migrateConfigApiKey()`
- Legacy config cleanup logic

**Strip from route handlers / MCP tools:**
- `authenticate()` calls guarding endpoints
- `req.user` / `req.apiKey` references
- Role checks on tool execution

**Strip from `server/mcp-sse.js`:**
- Ticket exchange flow
- `apiKey` query param extraction
- Auth priority chain

**Strip from `server/container.js`:**
- Auth service registrations

**Strip from `server/tool-annotations.js`:**
- Auth-related tool annotations

**Relocate:**
- Auth tests → `server/plugins/auth/tests/`

**Update:**
- `.mcp.json.example` — keyless URL
- `CLAUDE.md` — document local-first default, enterprise plugin option

## Execution Strategy

### Phase 1 — Build the Plugin (sequential, high-quality)

| Step | Task | Provider |
|------|------|----------|
| 1 | Plugin contract + loader | Claude |
| 2 | Auth plugin `index.js` with lifecycle | Claude |
| 3 | Port key-manager, user-manager, session-manager | Codex |
| 4 | Port middleware, resolvers, role-guard, rate-limiter | Codex |
| 5 | Merge ticket-manager + sse-tickets → sse-auth.js | Codex |
| 6 | Enterprise config-injector | Codex |
| 7 | Plugin tests | Codex |
| 8 | Wire plugin loader into index.js | Claude |
| 9 | Simplify MCP config injector for local mode | Codex |
| 10 | Default 127.0.0.1 binding | Codex |
| 11 | Integration test: local mode + enterprise mode | Claude |

### Phase 2 — Remove Dead Code (parallel, mechanical)

One TORQUE task per file/module that needs stripping. All parallelizable. Codex handles removal, verify command catches broken references.

**Verify command:** `npx tsc --noEmit && npx vitest run`

## Security Considerations

- **Local mode is safe because:** server binds to `127.0.0.1` only — no network exposure without the plugin
- **Enterprise mode inherits all current auth:** HMAC keys, bcrypt passwords, rate limiting, role hierarchy, SSE ticket exchange
- **Plugin loading failure defaults to local mode:** a broken plugin never opens the server to the network
- **No auth hot-loading:** auth boundary changes require a restart — clean, predictable transition

## Out of Scope

- Multi-user OS-level detection (Layer 2 from original roadmap) — deferred to future enterprise plugin enhancement
- LAN auth (Layer 4) — deferred, requires enterprise plugin to be active first
- Plugin marketplace / dynamic plugin discovery — YAGNI
- Hot-reload of plugins at runtime — security risk, not worth it
