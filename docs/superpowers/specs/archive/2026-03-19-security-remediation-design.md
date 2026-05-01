# TORQUE Security Remediation Plan (Track A)

**Date:** 2026-03-19
**Scope:** 71 security issues from Bug Hunt Round 2
**Deployment model:** Single-user with remote agents (localhost TORQUE + remote-gpu-host)
**Approach:** Secure-by-default with zero friction — auto-generated API key, protocol-layer enforcement

---

## Context

Bug Hunt Round 2 found 71 security issues including 6 critical (unauthenticated REST API, unauthenticated SSE sessions, unverified backup restore, env var injection, no server-side command whitelist, config modification via unauthenticated endpoints).

The architecture track (Track B) created `mcp-protocol.js` — a single protocol handler that both SSE and stdio transports delegate to. Auth can now be added once at this layer instead of in 3 transports.

## Deployment Model

TORQUE runs on the developer's local machine. Remote agents (remote-gpu-host) execute heavy commands via SSH/HTTP. The security model assumes:
- **Trusted:** stdio pipe (same process), localhost dashboard (same machine)
- **Semi-trusted:** LAN agent connections (same network, but need auth)
- **Untrusted:** any non-localhost network access, browser-based attacks from other tabs

---

## Phase 1 — Auth Foundation

**Goal:** Secure-by-default with zero friction. Auto-generated API key, enforced at the protocol layer.

### 1.1 — Auto-generate API key on first startup

In database init, after schema setup:
- Check `db.getConfig('api_key')`
- If no key exists, generate one with `crypto.randomUUID()`
- Store encrypted in the config table (encryption already exists via `credential-crypto.js`)
- Print to stdout once: `Generated API key: <key>`
- Log guidance: `Add to .mcp.json headers or set TORQUE_API_KEY env var`

### 1.2 — Enforce auth in mcp-protocol.js

Add auth check at the top of `handleRequest()`:
```
if (!session.authenticated) {
  throw { code: -32600, message: 'Authentication required' };
}
```

Each transport authenticates the session before passing to the protocol handler:
- **SSE:** Check `X-Torque-Key` header on `/sse` connection
- **Stdio:** Auto-authenticated (trusted pipe, `session.authenticated = true` by default)
- **REST API:** Existing `checkAuth` middleware (already implemented)

### 1.3 — Exempt localhost dashboard

The dashboard is browser-based on the same machine. Requiring API key in browser requests breaks UX.

| Port | Service | Auth policy |
|------|---------|-------------|
| 3456 | Dashboard + WebSocket | Localhost-only, no auth required |
| 3457 | REST API | Auth required for non-localhost; localhost exempt |
| 3458 | MCP SSE | Auth required always (programmatic clients) |
| Stdio | MCP stdio | Auto-authenticated (trusted pipe) |

### 1.4 — Auto-configure .mcp.json

When the API key is auto-generated, update `.mcp.json` if it exists:
- Add the key to the MCP server config's `env` section as `TORQUE_API_KEY`
- SSE transport: add to headers configuration

### 1.5 — Security banner

When no API key is configured (legacy installs):
- Startup logs: prominent warning
- Dashboard header: yellow banner "TORQUE is running without authentication"
- MCP `initialize` response: include `security_warning` in metadata

**Gate:** All MCP/REST calls require auth. Stdio auto-authenticated. Dashboard localhost-exempt.

---

## Phase 2 — Remote Agent Hardening

**Goal:** Agent connections secure by default. No env var injection, no arbitrary commands.

### 2.1 — TLS default for agent connections

Change `agent-registry.js` `register()` default: `tls = false` → `tls = true`.

Auto-generate self-signed cert if none exists (for LAN development). The agent already has `/certs` endpoint and TLS support in `agent-server.js`.

Existing `tls: false` agents get deprecation warning in logs.

### 2.2 — Env var whitelist on server-side agent

Add to `server/remote/agent-server.js:normalizeEnv`:

```js
const ALLOWED_ENV_VARS = new Set([
  'NODE_ENV', 'DEBUG', 'HOME', 'USERPROFILE', 'TEMP', 'TMP',
]);
const ALLOWED_PREFIXES = ['TORQUE_', 'OLLAMA_'];
const BLOCKED_ENV_VARS = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE',
]);
```

Filter `extraEnv` through this whitelist before merging with `process.env`. Matches `agent/index.js` existing pattern.

### 2.3 — Command whitelist on server-side agent

Default allowlist: `['node', 'npm', 'npx', 'git', 'dotnet', 'cargo', 'python', 'pip']`

Configurable via agent config. Reject commands not on the list with 403.

### 2.4 — Cap spawnAndCapture output accumulation

Add `MAX_CAPTURE_BYTES = 10 * 1024 * 1024` (10MB). Truncate stdout/stderr to last 10MB during accumulation.

**Gate:** Agent rejects unauthorized env vars and commands. TLS by default.

---

## Phase 3 — Data Protection

**Goal:** Backups can't be tampered with. Secrets don't leak. DB permissions correct.

### 3.1 — Backup integrity verification

On backup creation:
- Compute SHA-256 hash of serialized database
- Write `<backup-name>.sha256` alongside the backup file

On restore:
- Verify hash file exists and matches
- Reject unverified backups with clear error
- Allow `--force` override for disaster recovery

### 3.2 — Fix DB file permissions on Windows

Add Windows-specific ACL handling after DB file creation:
```js
if (process.platform === 'win32') {
  execFileSync('icacls', [dbPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'pipe' });
}
```

### 3.3 — Prevent secrets in logs

Extend `server/utils/sanitize.js:redactSecrets()`:
- API key patterns (`sk-`, `key-`, `gsk_`, base64 blocks)
- Agent secrets (`scrypt:...`)
- Auth headers (`X-Torque-Key`, `X-Torque-Secret`, `Authorization`)

Ensure redaction in:
- `uncaughtException` handler (`index.js`)
- Error response bodies
- Task output before WebSocket broadcast (already done for WS, verify REST)

### 3.4 — Protect setConfig from unauthenticated access

Add `PROTECTED_CONFIG_KEYS` set:
```js
const PROTECTED_CONFIG_KEYS = new Set([
  'api_key', 'v2_auth_mode', 'scheduling_mode', 'max_concurrent',
]);
```

`setConfig` for protected keys requires the caller to be authenticated. MCP tools go through protocol auth. REST goes through `checkAuth`. Dashboard is localhost-only (acceptable).

**Gate:** Backups verified on restore. Secrets never in logs. Config changes audited.

---

## Phase 4 — Session & Network Hardening

**Goal:** SSE sessions can't be hijacked. DoS vectors capped. CORS strict.

### 4.1 — SSE session authentication

- Require `X-Torque-Key` header on `GET /sse` connection
- Store auth status on session: `session.authenticated = true`
- Reconnection with `?sessionId=...` must also provide key
- Session IDs remain UUIDs (already cryptographically random)

### 4.2 — Per-IP connection limits

| Transport | Per-IP limit | Total limit |
|-----------|-------------|-------------|
| SSE | 10 | 50 |
| WebSocket | 20 | 100 |

Track via `Map<ip, count>` in each transport. Decrement on disconnect.

### 4.3 — CORS strict-by-default

- SSE (3458): only allow dashboard origin `http://127.0.0.1:${dashboardPort}`
- REST (3457): same
- Document that non-browser clients (curl, scripts) bypass CORS by not sending Origin header — this is by design for programmatic access

### 4.4 — Rate limiting improvements

- SSE `subscribe_task_events`: cap total subscriptions per session at 200
- Body parser: add 30-second timeout to prevent slow-loris
- Shutdown endpoint: require `X-Requested-With` (already done in bug hunt Phase 3)

**Gate:** Sessions authenticated. DoS vectors capped. CORS strict.

---

## Phase 5 — Enterprise Readiness Documentation

**Goal:** Document the upgrade path for multi-user/enterprise. No implementation.

Saved as `docs/enterprise-security-roadmap.md` covering:

### Authentication upgrades
- **mTLS for agents** — mutual TLS with cert pinning, eliminating shared secrets
- **HMAC request signing** — sign body + timestamp, never transmit secret on wire
- **OAuth2/OIDC integration** — for orgs with existing identity providers
- **JWT session tokens** — signed tokens with user identity and expiry

### Authorization & multi-tenancy
- **Granular API key scoping** — read-only, submit-only, admin keys
- **RBAC** — roles: viewer, submitter, operator, admin
- **Project-level isolation** — users see only their projects
- **Namespace multi-tenancy** — teams sharing one instance

### Audit & compliance
- **Mandatory audit logging** — every state transition, config change, auth event
- **Immutable audit trail** — append-only, tamper-evident
- **Data retention policies** — configurable per-tenant with auto-purge
- **Secret rotation** — automated rotation with grace period

### Network security
- **TLS everywhere** — all ports HTTPS/WSS
- **Interface binding** — bind to specific interfaces, not 0.0.0.0
- **API gateway integration** — nginx/Caddy/Traefik documentation

---

## Execution Dependencies

```
Phase 1 (auth foundation)
    → Gate: all MCP/REST require auth, stdio exempt
Phase 2 (agent hardening)
    → Gate: env/command whitelist enforced, TLS default
Phase 3 (data protection)
    → Gate: backups verified, secrets redacted
Phase 4 (session/network)
    → Gate: SSE authenticated, DoS capped
Phase 5 (enterprise docs)
    → Gate: document written and committed
```

## Estimated Effort

| Phase | Sessions | Risk |
|-------|----------|------|
| 1 — Auth foundation | 2-3 | Medium (touches all entry points) |
| 2 — Agent hardening | 1-2 | Low (isolated to agent files) |
| 3 — Data protection | 1-2 | Low (mechanical changes) |
| 4 — Session/network | 2-3 | Medium (transport changes) |
| 5 — Enterprise docs | 1 | None (documentation only) |
| **Total** | **~7-11** | |
