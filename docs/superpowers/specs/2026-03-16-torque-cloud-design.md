# TORQUE Cloud — Design Spec

> **ARCHIVED (2026-03-29):** TORQUE is no longer pursuing monetization. The project has switched to the MIT license with a focus on open-source adoption and community growth. This cloud SaaS design with paid tiers is not being implemented. Retained for historical reference.

**Date:** 2026-03-16
**Status:** Archived — not pursuing
**Scope:** Cloud-hosted SaaS product — Cloudflare edge + Fly.io containers, multi-tenant, hub-and-spoke with local agent relay

## Problem

TORQUE is a powerful AI task orchestration platform, but it requires local installation: Node.js, SQLite, Ollama hosts, CLI configuration. This barrier prevents developers from trying TORQUE before committing to a local setup. A cloud-hosted version removes this barrier — users sign up, connect a lightweight local agent, and immediately access TORQUE's full orchestration capabilities through a web dashboard and remote MCP/REST endpoints.

## Goals

1. Fully functional TORQUE accessible through the web — dashboard + MCP/REST API
2. User's code and task outputs never stored in the cloud — stays on their machine
3. Multi-tenant from day one — proper user isolation, auth, billing
4. Support BYOK (bring your own key) for cloud providers + subscription-based local tools (Codex, Claude Code) via agent relay
5. Freemium model — free tier proves value, Pro tier unlocks power-user workflows
6. Minimal infrastructure — Cloudflare edge + Fly.io containers, zero custom server management

## Non-Goals

- Hosting user code in the cloud (code stays local)
- Replacing the self-hosted product (both coexist as open-core)
- Building a custom payment system (Stripe Checkout handles billing)
- Mobile support (developer desktop tool)

---

## Architecture

### Two Products, One Codebase

Open-core model:

1. **TORQUE** (open source, self-hosted) — existing product. Users clone, install, run locally. Free, BSL license.
2. **TORQUE Cloud** (hosted SaaS) — the **same TORQUE server** running in per-user Fly.io containers, fronted by Cloudflare edge for auth/billing/dashboard. Freemium.

**Key insight:** The cloud version runs the actual TORQUE codebase unchanged in containers. There is no reimplementation, no core extraction, no async conversion. One codebase, one test suite, guaranteed feature parity. Cloudflare handles what it's good at (edge auth, rate limiting, static hosting). Fly.io handles what it's good at (running Node.js with full system access).

### Hub and Spoke

```
┌─── Cloudflare Edge ───┐     ┌──── Fly.io ────────────────┐
│                        │     │  Per-user container:        │
│  Workers:              │     │  ┌───────────────────────┐  │
│   - Auth (OAuth/key)   │     │  │ Actual TORQUE server  │  │
│   - Rate limiting      │◄───►│  │ - Same codebase       │  │
│   - Billing/tier check │     │  │ - Same SQLite         │  │
│   - Request routing    │     │  │ - Same 15K tests      │  │
│                        │     │  │ - Full orchestration   │  │
│  Pages:                │     │  └───────────┬───────────┘  │
│   - Dashboard UI       │     │              │              │
│                        │     └──────────────┼──────────────┘
│  KV: sessions, cache   │                    │
│  D1: users, billing    │                    │ WebSocket
└────────────────────────┘                    │
                                              ▼
                               ┌──────────────────────────┐
                               │  User's Machine           │
                               │  TORQUE Agent              │
                               │  ┌─────────┐ ┌─────────┐ │
                               │  │Codex CLI│ │Claude   │ │
                               │  │(sub)    │ │Code(sub)│ │
                               │  └─────────┘ └─────────┘ │
                               │  ┌─────────┐ ┌─────────┐ │
                               │  │npm test │ │Local    │ │
                               │  │(verify) │ │Ollama   │ │
                               │  └─────────┘ └─────────┘ │
                               └──────────────────────────┘
```

**Cloudflare edge handles:** Auth, rate limiting, billing enforcement, dashboard hosting, session management. Stateless request routing to the correct user container.

**Fly.io container handles:** Full TORQUE orchestration — scheduling, workflows, quality gates, guidance, provider routing, cloud API calls (BYOK). Each user gets their own container running the unmodified TORQUE server with its own SQLite database.

**Agent handles:** Subscription-based CLI tools (Codex, Claude Code), test execution (verify_command against user's codebase), local Ollama, git operations.

**Key principle:** User's code and completed task outputs stay LOCAL via the agent. The container's SQLite holds orchestration state. Cloudflare D1 holds only multi-tenant data (user accounts, billing, API keys).

### Three-Layer Data Split

| Data | Cloudflare D1 | Container SQLite | Agent SQLite |
|------|:---:|:---:|:---:|
| User accounts, auth | x | | |
| API keys (hashed) | x | | |
| Billing/tier status | x | | |
| Provider configs (encrypted) | x | injected at start | |
| Task queue, scheduling | | x | |
| Workflow DAG state | | x | |
| Task full output | | | x |
| File baselines | | | x |
| Code content | | | x |
| Test results (full) | | | x |
| Git diffs | | | x |

**Why three layers:**
- **D1:** Multi-tenant data that spans all users (auth, billing). Queried by Cloudflare Workers at the edge.
- **Container SQLite:** Per-user orchestration state. This IS the existing TORQUE database, unchanged. No schema migration needed.
- **Agent SQLite:** Heavy data that never leaves the user's machine. Privacy guarantee.

### Container Lifecycle (Fly.io)

```
User signs up (Cloudflare)
  → D1: create user record
  → No container yet (created on first use)

User connects agent or submits first task
  → Cloudflare Worker routes to Fly.io
  → Fly.io Machine API: create machine for user (if not exists)
  → Container starts TORQUE server (~2s cold start)
  → Container receives BYOK provider keys (decrypted by Worker, passed via secure env)
  → Agent WebSocket proxied through Cloudflare to container

While active:
  → Container runs full TORQUE — all 500+ tools, all providers, all safeguards
  → Container's SQLite holds all orchestration state
  → Dashboard reads from container's REST API (proxied through Cloudflare)

After 10 minutes of no activity:
  → Container suspends (Fly.io Machine stop)
  → SQLite volume persists (Fly.io persistent volumes)
  → Next request wakes it (~1-2s)
```

**Cost model:** Fly.io charges for active CPU time. Suspended machines cost only volume storage (~$0.15/GB/mo). A free-tier user who uses TORQUE for 2 hours/day costs ~$1-3/mo in compute. Pro users with always-on containers: ~$5-7/mo.

---

## Monorepo Structure

```
torque-ai/
  packages/
    server/             # TORQUE server (existing codebase, unchanged)
      index.js          # MCP stdio + SSE + REST
      handlers/         # Tool handlers
      database.js       # SQLite (same as today)
      tool-defs/        # Tool definitions
      guidance/         # Guidance system
      dashboard/        # Bundled dashboard UI

    edge/               # Cloudflare Workers (auth, billing, routing)
      src/
        worker.js       # Main Worker entry
        router.js       # Route to correct user container
        auth/           # GitHub OAuth, magic link, API keys
        billing/        # Stripe webhook, tier enforcement
        container-mgmt/ # Fly.io Machine API integration
      wrangler.toml
      d1-migrations/    # D1 schema (users, billing, keys only)

    agent/              # Local relay (@torque-ai/agent)
      bin/
        torque-agent.js # CLI entry
      src/
        relay.js        # WebSocket connection to container
        executor.js     # Core command whitelist
        plugin-loader.js
        local-db.js     # SQLite for heavy data
        tray.js         # Optional system tray
      plugins/
        codex.js, claude-cli.js, ollama.js, verify.js, git.js

    dashboard/          # Shared dashboard UI
      src/              # Used by both server (bundled) and edge (Pages)

  package.json          # Workspace root (npm workspaces)
```

**What's where:**

| Component | Server (container + self-hosted) | Edge (Cloudflare) | Agent |
|-----------|:---:|:---:|:---:|
| Full orchestration engine | x | | |
| All 500+ tools | x | | |
| SQLite database | x | | |
| MCP stdio + SSE | x | | |
| REST API (580 routes) | x | | |
| All 15K tests | x | | |
| Auth (OAuth, magic link, keys) | | x | |
| Billing (Stripe, tier enforcement) | | x | |
| Rate limiting | | x | |
| Container lifecycle (start/stop) | | x | |
| Dashboard static hosting | | x | |
| User/billing D1 database | | x | |
| Codex/Claude CLI execution | | | x |
| Local Ollama proxy | | | x |
| Verify command execution | | | x |
| Plugin system | | | x |
| Local heavy-data SQLite | | | x |

**No `packages/core` extraction needed.** The server package IS the core. The container runs it unchanged. The edge package is a thin auth/billing/routing layer. The agent is a new standalone package.

---

## Agent Protocol

### Connection Lifecycle

```
Agent starts
  → Reads API key from ~/.torque-agent/config.json
  → Connects: wss://api.<domain>/agent?key=<api-key>
  → Cloud validates key, finds/creates Durable Object for user
  → Durable Object accepts WebSocket, sends HELLO with session config
  → Agent sends CAPABILITIES (installed plugins, local providers, system info)
  → Connection is live

On disconnect:
  → Agent auto-reconnects with exponential backoff (1s, 2s, 4s, 8s... max 60s)
  → Durable Object holds pending task assignments for up to 5 minutes
  → If no reconnect in 5 min, pending tasks marked "agent_disconnected"
  → On reconnect, agent receives queued assignments immediately
```

### Message Format (JSON over WebSocket)

**Cloud → Agent:**

| Type | Purpose | Payload |
|------|---------|---------|
| `task.assign` | Execute a task locally | `{ id, task_id, command, args }` |
| `task.cancel` | Cancel a running task | `{ id, task_id }` |
| `verify.run` | Run verification command | `{ id, task_id, command, cwd }` |
| `ollama.request` | Proxy to local Ollama | `{ id, task_id, endpoint, body }` |
| `output.fetch` | Retrieve full task output | `{ id, task_id }` |
| `ping` | Heartbeat (every 30s) | `{}` |

**Agent → Cloud:**

| Type | Purpose | Payload |
|------|---------|---------|
| `task.status` | Progress update | `{ task_id, status, progress }` |
| `task.complete` | Task finished | `{ task_id, exit_code, summary, duration_ms }` |
| `task.failed` | Task errored | `{ task_id, exit_code, error }` |
| `verify.result` | Verification result | `{ task_id, passed, output }` |
| `ollama.response` | Ollama API response | `{ task_id, body }` |
| `output.data` | Full output for fetch | `{ task_id, content }` |
| `capabilities` | Agent capabilities | `{ providers, plugins, system }` |
| `task.reconcile` | Reconnect state sync | `{ tasks: [{ task_id, status, exit_code }] }` |
| `pong` | Heartbeat response | `{}` |

### Key Protocol Decisions

- **Task outputs stay local.** `task.complete` sends only a summary (~500 chars) and metadata. Full output stored in agent's local SQLite. Dashboard fetches full output on-demand via `output.fetch` through the WebSocket.
- **Heartbeat:** Cloud sends `ping` every 30s. Three missed `pong` responses = connection dead.
- **Message IDs:** Every cloud→agent message has an `id`. Agent acknowledges with the same `id`. Cloud retries unacknowledged messages on reconnect.
- **Immediate rejection:** If agent can't handle a task (missing plugin, unavailable provider), it immediately replies `task.failed`. Cloud re-routes.
- **Reconnection reconciliation:** On reconnect, the agent sends a `task.reconcile` message listing all task IDs it knows about and their current local status (running, completed-while-disconnected, failed-while-disconnected). The DO reconciles against D1 state before sending new assignments. This prevents duplicate execution (agent still running a task the cloud thinks is disconnected) and recovers results completed during the outage.

### Agent Package (@torque-ai/agent)

Installed globally: `npm install -g @torque-ai/agent`

CLI commands:
- `torque-agent start --key <api-key>` — start background service
- `torque-agent stop` — stop service
- `torque-agent status` — show connection status, running tasks
- `torque-agent plugins` — list installed plugins
- `torque-agent plugins install <name>` — install a plugin

### Agent Plugin System

Ships with whitelisted core capabilities:

| Plugin | Capability |
|--------|-----------|
| `codex` | Execute Codex CLI with a prompt |
| `claude-cli` | Execute Claude Code CLI with a prompt |
| `ollama` | Proxy API calls to local Ollama |
| `verify` | Run verify commands in a working directory |
| `git` | Report git status, diff, checkout operations |

Users install additional plugins via npm:
- `@torque-ai/plugin-docker` — spin up containers locally
- Community plugins follow the `torque-plugin-*` naming convention

Plugin interface:

```js
module.exports = {
  name: 'docker',
  commands: ['docker.run', 'docker.build'],
  async execute(command, args) { /* ... */ return result; }
};
```

---

## Authentication

### Three Auth Surfaces

**1. Dashboard login — GitHub OAuth:**

```
User clicks "Sign in with GitHub"
  → Redirect to github.com/login/oauth/authorize
  → GitHub redirects back with code
  → Worker exchanges code for access token
  → Reads user profile (email, username, avatar)
  → Creates/updates user in D1
  → Sets session token in KV (TTL: 7 days)
  → Sets httpOnly secure cookie
  → Redirects to dashboard
```

**2. Dashboard login — Magic Link (email, passwordless):**

```
User enters email
  → Worker generates one-time token (crypto.randomUUID)
  → Stores in KV: { token → email, TTL: 15 minutes }
  → Sends email via Resend/Postmark API
  → User clicks link: app.<domain>/auth/magic?token=...
  → Worker validates + deletes token (one-time use)
  → Creates/updates user in D1
  → Sets session cookie
  → Redirects to dashboard
```

**3. API keys for agent/REST/MCP:**

```
User logged into dashboard → Settings → API Keys
  → Clicks "Generate new key"
  → Worker generates: torque_<32 random hex chars>
  → Stores hash(key) in D1 (never stores plaintext)
  → Returns plaintext ONCE ("copy now, won't be shown again")
  → User pastes into ~/.torque-agent/config.json
  → Agent connects with key → Worker hashes, looks up in D1 → resolves to user_id
```

### Key Decisions

- **No passwords.** GitHub OAuth or magic link only. Zero password infrastructure.
- **API keys hashed at rest.** D1 compromise = keys useless.
- **Session tokens in KV.** Globally replicated, fast, TTL handles expiry.
- **Multiple API keys per user.** Named ("work laptop", "CI server"), independently revocable.
- **API key lookups cached in KV.** Hash-to-user-id mappings stored in KV with 5-minute TTL for edge-speed auth. Invalidated on key revocation.
- **Key revocation terminates active WebSockets.** When a key is revoked, the DO checks key validity on the next heartbeat cycle (every 30s) and closes the WebSocket if the key is revoked. Maximum revocation latency: 30 seconds.
- **Rate limiting per key.** Free: 60 req/min. Pro: 300 req/min. KV counters at the edge.

---

## Cloudflare Edge Architecture

Cloudflare is the front door — auth, billing, rate limiting, and routing. All orchestration happens in the user's Fly.io container.

### Request Routing

```
HTTPS request → Cloudflare Edge (Worker)
  │
  ├─ 1. Parse route
  ├─ 2. Auth check (KV session or API key hash)
  ├─ 3. Rate limit check (KV counter)
  ├─ 4. Tier enforcement (KV cached, source: D1)
  │
  ├─ /api/*            → Proxy to user's Fly.io container
  ├─ /agent            → Proxy WebSocket to user's container
  ├─ /auth/*           → Worker handler (stateless)
  ├─ /billing/*        → Worker handler (Stripe)
  └─ /*                → Pages (dashboard static files)
```

The Worker is a **smart proxy**. It authenticates, enforces tier limits, and forwards to the correct container. It does NOT run orchestration logic.

### Cloudflare Primitives

| Component | Primitive | Why |
|-----------|-----------|-----|
| Auth + routing proxy | Workers | Stateless, global edge |
| User accounts + billing | D1 | Multi-tenant queryable store |
| Session tokens + key cache | KV | Fast global lookups |
| BYOK key encryption | Worker env vars | Server-side secrets |
| Dashboard UI | Pages | Static site hosting |
| Rate limit counters | KV | Edge-speed enforcement |
| History purge trigger | Cron Triggers | Hourly cleanup |

### No Durable Objects Needed

The previous revision used Durable Objects for per-user orchestration state. With the container approach, the container's SQLite IS the orchestration state — no need to replicate it in DO storage. The Worker is fully stateless: authenticate, look up the user's container URL, proxy the request.

### Container URL Resolution

Each user's container has a stable internal URL on Fly.io's private network. The Worker resolves it via:

1. KV lookup: `user:{user_id}:container_url` (cached, 5-min TTL)
2. If miss: D1 lookup for container assignment
3. If no container: call Fly.io Machine API to create one, store URL in D1 + KV
4. Proxy the request to the container

---

## D1 Schema

D1 holds ONLY multi-tenant data: user accounts, auth, billing, and provider keys. All orchestration state lives in the container's SQLite (the existing TORQUE schema, unchanged).

```sql
-- Auth & Identity
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  github_id TEXT UNIQUE,
  github_username TEXT,
  avatar_url TEXT,
  display_name TEXT,
  tier TEXT NOT NULL DEFAULT 'free',
  tier_expires_at TEXT,
  container_id TEXT,                 -- Fly.io Machine ID
  container_region TEXT,             -- e.g., 'iad' (nearest region)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_hash TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- Provider Configuration (BYOK)
CREATE TABLE user_providers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  api_key_encrypted TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, provider)
);

CREATE INDEX idx_user_providers_user ON user_providers(user_id);

-- Billing & Usage
CREATE TABLE usage_daily (
  user_id TEXT NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  tasks_submitted INTEGER DEFAULT 0,
  tasks_completed INTEGER DEFAULT 0,
  workflows_created INTEGER DEFAULT 0,
  agent_connected_minutes INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

-- Audit Trail (edge actions only — login, key create, tier change)
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
```

**What's NOT in D1 (lives in container SQLite instead):**
- Task queue, workflow DAGs, scheduling state (existing TORQUE schema)
- Task summaries, provider health, host inventory (existing TORQUE schema)
- All orchestration audit trail (existing TORQUE schema)

**Audit log retention:** 90 days for all tiers. Cron Trigger purges older entries.

**Stripe webhook idempotency:** Processed event IDs stored in KV with 24-hour TTL. Duplicates acknowledged but not re-processed.

**BYOK key encryption:**

Encryption scheme: AES-256-GCM with HKDF-SHA256 key derivation.
- **Key derivation:** `HKDF-SHA256(secret=WORKER_ENCRYPTION_SECRET, salt=user.id, info="provider-key")` produces a 256-bit per-user encryption key.
- **Encryption:** Each provider API key is encrypted with AES-256-GCM using a unique random 12-byte IV per value. The `api_key_encrypted` column stores `base64(IV || ciphertext || auth_tag)`.
- **Decryption:** DO derives the per-user key, splits IV/ciphertext/tag, decrypts. Plaintext is held only in DO memory during the API call, never written to D1 or DO storage.
- **Threat model:** Protects against D1 compromise (data at rest). Does NOT protect against Worker code compromise (attacker can derive keys). Worker env secrets are Cloudflare's strongest isolation boundary.
- **Rotation:** If `WORKER_ENCRYPTION_SECRET` is rotated, a migration job re-encrypts all provider keys. Users are not affected.

---

## Monetization

### Freemium BYOK

Users bring their own API keys. TORQUE Cloud sells orchestration, not compute.

| Resource | Free | Pro ($9/mo, $79/yr) |
|----------|------|-----|
| Concurrent tasks | 6 | Unlimited |
| Active workflows | 2 | Unlimited |
| Agent connections | 1 | 3 |
| Cloud history | 24 hours | 30 days |
| Providers | 3 | Unlimited |
| Tool tier | Tier 1 (~29 tools) | Tier 3 (all ~500) |
| Batch orchestration | No | Yes |
| Audit pipeline | No | Yes |
| Rate limit | 60 req/min | 300 req/min |

### Tier Enforcement

**Enforced at two layers:**

| Limit | Where | Response on exceed |
|-------|-------|-------------------|
| Rate limit | Worker edge (KV counter) | 429 with Retry-After header |
| Concurrent tasks | Container (TORQUE's existing limits) | Structured error with upgrade_url |
| Active workflows | Container (TORQUE's existing limits) | Structured error with upgrade_url |
| Agent connections | Container (WebSocket handler) | WebSocket reject with reason |
| Provider count | Edge (before key injection) | Error on 4th provider enable |
| Tool tier | Container (existing tier system) | "This tool requires Pro" |
| Batch orchestration | Container (existing tier system) | Pro-required error |
| Cloud history | Container (SQLite cleanup on schedule) | Agent keeps local copy |

**Error response format:**

```json
{
  "error": "tier_limit",
  "limit": "concurrent_tasks",
  "current": 6,
  "max": 6,
  "tier": "free",
  "upgrade_url": "https://app.<domain>/settings/billing"
}
```

### Stripe Integration

- Stripe Checkout (hosted) — no custom payment UI
- Webhook at `/api/billing/webhook` validates signature, updates D1
- Two products: "TORQUE Pro Monthly" ($9), "TORQUE Pro Annual" ($79)
- Worker env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

**Tier transitions:**

| Transition | Trigger | Effect |
|------------|---------|--------|
| Free → Pro | Stripe checkout completes | D1 tier='pro', KV cache invalidated |
| Pro → Free | Subscription expires/cancels | D1 tier='free'. Running tasks finish. New tasks limited. |
| Pro renewal | Stripe webhook | tier_expires_at extended |

---

## Dashboard

### Shared Package

The dashboard is a shared package used by both self-hosted (bundled) and cloud (Pages). Product-specific features are conditionally rendered based on environment.

### What Stays the Same

All 12 existing dashboard views, task list, workflow DAG visualization, provider status cards, real-time updates, Strategic Brain view.

### Cloud-Only Additions

| Page | Purpose |
|------|---------|
| `/login` | GitHub OAuth / magic link entry |
| `/onboarding` | First-run wizard (3 steps) |
| `/settings/keys` | API key management |
| `/settings/providers` | BYOK provider configuration |
| `/settings/billing` | Plan, usage meters, Stripe portal |
| `/settings/agent` | Connection status, capabilities, plugins |

### Cloud-Specific Behavior

| Feature | Self-hosted | Cloud |
|---------|-------------|-------|
| Auth | None | Login page, auth gate |
| Task output | Full from local SQLite | Summary from D1 + full via agent fetch |
| Settings | Config file | Web UI |
| Agent status | N/A | Connection indicator |
| Tier display | N/A | Plan badge, usage meters |
| Onboarding | N/A | First-login wizard |

### Task Output Fetch-Through-Agent

```
User clicks task in dashboard
  → Dashboard: GET /api/tasks/{id}/output
  → Worker routes to user's DO
  → DO checks summary length — if sufficient, returns directly
  → If full output needed:
      → DO sends output.fetch via WebSocket to agent
      → Agent reads local SQLite, sends output.data back
      → DO streams to dashboard
  → If agent offline:
      → Returns summary + "Full output unavailable — agent offline"
```

### Onboarding Wizard

**Step 1: Install the agent**
- Shows: `npm install -g @torque-ai/agent`
- Generates and displays API key (one-time)
- Shows: `torque-agent start --key <api-key>`
- Waits for agent WebSocket connection
- Green checkmark when connected

**Step 2: Add a provider**
- Pick from: Codex, Claude Code, DeepInfra, Anthropic, Groq, Hyperbolic, local Ollama
- Paste API key for cloud providers
- For Codex/Claude: confirm installed locally
- Test connection button

**Step 3: Submit first task**
- Pre-filled example task
- Watch it route, execute, return result
- "You're set up!"

---

## Build Path

No migration needed. The existing TORQUE server runs unchanged in containers. We build three new things around it.

### Phase 1: Monorepo Scaffold

Move current code into `packages/server/`. Create `packages/edge/`, `packages/agent/`, `packages/dashboard/`. Add workspace root.

Self-hosted product works exactly as before from `packages/server/`. Zero risk — file moves only.

### Phase 2: Build Agent Package (independent)

Build `packages/agent/` from scratch:
- WebSocket relay to container
- CLI (`torque-agent start/stop/status`)
- Plugin system (core: codex, claude-cli, ollama, verify, git)
- Local SQLite for heavy data
- Optional system tray

Can be tested against the existing self-hosted TORQUE server acting as a mock cloud endpoint (same REST API + WebSocket support).

### Phase 3: Build Edge Package (independent, parallel with Phase 2)

Build `packages/edge/` — Cloudflare Workers:
- Auth flows (GitHub OAuth, magic link, API key validation)
- Billing (Stripe integration, tier enforcement)
- Request proxy to Fly.io containers
- Container lifecycle management (Fly.io Machine API)
- D1 schema + migrations
- Rate limiting

This is a greenfield Worker — no dependency on the TORQUE server codebase.

### Phase 4: Container Configuration

Configure the TORQUE server to run in Fly.io:
- Dockerfile (already exists from CI work)
- `fly.toml` configuration
- Persistent volume for SQLite
- Environment variable injection (BYOK keys from edge)
- WebSocket endpoint for agent connections
- Auto-suspend after inactivity
- Health check endpoint (already exists: `/healthz`)

Minimal server changes needed:
- Accept BYOK provider keys from environment variables (may already work via existing env var support)
- WebSocket endpoint for agent relay (new, but uses existing MCP SSE patterns)

### Phase 5: Integration + Dashboard

Wire everything together:
- Dashboard cloud-only pages (login, onboarding, settings, billing)
- End-to-end: sign up → create container → connect agent → submit task → see result
- Load testing with multiple concurrent users

### Phase Dependencies

```
Phase 1 (scaffold)        ← zero risk, file moves only
    ↓
┌──────────────────────┐
│ Phase 2 (agent)      │  ← parallel, independent
│ Phase 3 (edge)       │  ← parallel, independent
│ Phase 4 (container)  │  ← parallel, minimal server changes
└──────────────────────┘
    ↓
Phase 5 (integration)     ← wire + dashboard + e2e test
```

**Key difference from previous approach:** Phases 2, 3, and 4 are all independent and can run in parallel. There is no risky core extraction phase. The server codebase is touched minimally (WebSocket endpoint for agent relay, env var support for BYOK keys). All 15,000+ tests continue to pass because the server is unchanged.

### Risk Assessment

| Phase | Risk | Reason |
|-------|------|--------|
| Phase 1 | None | File moves only |
| Phase 2 | Low | Greenfield agent, tested against existing server |
| Phase 3 | Low | Greenfield Worker, standard Cloudflare patterns |
| Phase 4 | Low | Docker + Fly.io, existing Dockerfile from CI |
| Phase 5 | Medium | Integration complexity, but each piece is tested independently |

Total estimated build time: significantly less than the core extraction approach, with near-zero risk to the self-hosted product.

---

## Cloud-to-Cloud Provider Calls

When a task routes to a cloud API provider (DeepInfra, Anthropic, Groq), the TORQUE container makes the API call directly — this is the existing provider execution path, unchanged. BYOK keys are injected as environment variables when the container starts.

**Flow:** Container's existing provider system → HTTP call to provider API → response stored in container's SQLite → summary sent to agent via WebSocket for local archival.

No new code needed — the existing provider execution paths (in `server/providers/`) work as-is. The only change is that API keys come from environment variables (injected by the edge Worker from encrypted D1 storage) rather than from the container's local config.

## CORS Policy

Dashboard is served from Pages (`app.<domain>`), API from Workers (same domain, `/api/*` path prefix). Same-origin — no CORS needed for the primary flow. For external API consumers (third-party tools hitting `api.<domain>` from their own origins), the Worker adds standard CORS headers:

```
Access-Control-Allow-Origin: * (for public API endpoints like /api/guidance)
Access-Control-Allow-Origin: <requesting origin> (for authenticated endpoints, validated against allowlist)
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
```

## WebSocket Rate Limiting

Agent WebSocket messages are rate-limited per message type to prevent misbehaving agents from overwhelming the DO:

| Message Type | Limit |
|-------------|-------|
| `task.status` | 1 per task per second |
| `task.complete` / `task.failed` | 10 per second (burst) |
| `ollama.response` | 50 per second (streaming) |
| Unknown types | Silently dropped, logged |

Exceeding limits triggers a warning message back to the agent. Sustained violation (>60s) closes the WebSocket.

## Multi-Agent Routing

Pro users can connect up to 3 agents. Each agent has a name (set during `torque-agent start --name "work-laptop"`). The CAPABILITIES message includes the agent name, installed plugins, and available local providers.

When the DO assigns a task, it routes to the best available agent:
1. Filter agents that have the required plugin/provider
2. Prefer agents with fewer running tasks (load balance)
3. If user specified agent affinity in the task submission, honor it
4. If no capable agent is connected, queue the task until one connects

## History Purge Behavior

When the Cron Trigger purges expired task/workflow summaries, it leaves tombstone records:

```sql
-- Tombstones replace purged records
UPDATE task_summaries SET
  description = NULL, summary = NULL, provider = NULL,
  status = 'purged', completed_at = NULL
WHERE user_id = ? AND created_at < ?;
```

The dashboard displays: "N older tasks available locally — connect agent to view." This prevents confusion about missing data.

## Agent Protocol Versioning

The HELLO message from cloud includes a `protocol_version` field:

```json
{ "type": "hello", "protocol_version": "1.0", "min_supported": "1.0", "session_config": {...} }
```

The agent validates it supports the requested version. If not, it disconnects with a clear error message prompting the user to upgrade the agent package. Backwards-compatible additions (new message types) don't require a version bump — unknown types are silently ignored by older agents.

## Stripe Webhook Idempotency

Processed Stripe event IDs are stored in KV with 24-hour TTL. On webhook receipt, the Worker checks KV before processing. Duplicate events are acknowledged (200) but not re-processed.

---

## Success Criteria

1. A new user signs up, installs the agent, connects, and submits a task within 5 minutes
2. User's code and task outputs never leave their machine (verified by network inspection)
3. Free tier limits are enforced at every surface (API, dashboard, agent)
4. Self-hosted product is completely unchanged — all 15K+ tests pass, zero modifications to server logic
5. Dashboard works identically for self-hosted and cloud (shared package, conditional features)
6. Agent reconnects automatically after network interruption within 60 seconds
7. Container cold start under 3 seconds; warm requests under 100ms
8. Zero personal data in any shipped file
9. Container cost per free-tier user under $3/mo; per pro user under $7/mo
