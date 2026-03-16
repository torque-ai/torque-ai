# TORQUE Cloud — Design Spec

**Date:** 2026-03-16
**Status:** Draft (post-review revision 1)
**Scope:** Cloud-hosted SaaS product — Cloudflare Workers, multi-tenant, hub-and-spoke architecture with local agent relay

## Problem

TORQUE is a powerful AI task orchestration platform, but it requires local installation: Node.js, SQLite, Ollama hosts, CLI configuration. This barrier prevents developers from trying TORQUE before committing to a local setup. A cloud-hosted version removes this barrier — users sign up, connect a lightweight local agent, and immediately access TORQUE's full orchestration capabilities through a web dashboard and remote MCP/REST endpoints.

## Goals

1. Fully functional TORQUE accessible through the web — dashboard + MCP/REST API
2. User's code and task outputs never stored in the cloud — stays on their machine
3. Multi-tenant from day one — proper user isolation, auth, billing
4. Support BYOK (bring your own key) for cloud providers + subscription-based local tools (Codex, Claude Code) via agent relay
5. Freemium model — free tier proves value, Pro tier unlocks power-user workflows
6. Zero infrastructure for the operator to maintain — Cloudflare handles scaling

## Non-Goals

- Hosting user code in the cloud (code stays local)
- Replacing the self-hosted product (both coexist as open-core)
- Building a custom payment system (Stripe Checkout handles billing)
- Mobile support (developer desktop tool)

---

## Architecture

### Two Products, One Monorepo

Open-core model:

1. **TORQUE** (open source, self-hosted) — existing product. Users clone, install, run locally. Free, BSL license.
2. **TORQUE Cloud** (hosted SaaS) — same orchestration brain, multi-tenant, Cloudflare-hosted. Freemium.

Both products share a `packages/core` library containing the orchestration logic. Product-specific code (transports, DB adapters, auth, billing) lives in separate packages.

### Hub and Spoke

```
┌─────────────────────── Cloud ───────────────────────┐
│  TORQUE Hub                                          │
│  ┌─────────┐ ┌──────────┐ ┌───────────┐            │
│  │Dashboard│ │Scheduler │ │Workflows  │            │
│  │  (web)  │ │+ Queue   │ │+ Guidance │            │
│  └─────────┘ └────┬─────┘ └───────────┘            │
│                    │                                 │
│         ┌─────────┼──────────┐                      │
│         ▼         ▼          ▼                      │
│    ┌─────────┐ ┌──────┐ ┌──────┐  ← BYOK API keys │
│    │DeepInfra│ │Groq  │ │Anthro│                    │
│    └─────────┘ └──────┘ └──────┘                    │
│                    │                                 │
└────────────────────┼─────────────────────────────────┘
                     │ WebSocket (persistent)
                     ▼
┌──────────── User's Machine ─────────────┐
│  TORQUE Agent (lightweight relay)        │
│  ┌─────────┐ ┌───────────┐ ┌─────────┐ │
│  │Codex CLI│ │Claude Code│ │npm test  │ │
│  │(sub)    │ │(sub)      │ │(verify)  │ │
│  └─────────┘ └───────────┘ └─────────┘ │
│  ┌──────────┐                           │
│  │Local     │  ← optional               │
│  │Ollama    │                           │
│  └──────────┘                           │
└─────────────────────────────────────────┘
```

**Cloud handles:** Orchestration brain — scheduling, workflows, dashboard, guidance, quality gates, auth, billing.

**Agent handles:** Subscription-based CLI tools (Codex, Claude Code), test execution (verify_command against user's codebase), local Ollama, git operations.

**Key principle:** User's code and completed task outputs stay LOCAL. Cloud stores only orchestration state (task queue, workflow DAGs, summaries, audit trail). The local agent maintains a SQLite database with the heavy data.

### Split Database

| Data | Cloud (D1) | Local (Agent SQLite) |
|------|:---:|:---:|
| Task queue, scheduling state | x | |
| Workflow DAG definitions | x | |
| User accounts, auth | x | |
| Provider configs (encrypted) | x | |
| Task summaries (~500 chars) | x | |
| Audit trail | x | |
| Task full output | | x |
| File baselines | | x |
| Code content | | x |
| Test results (full) | | x |
| Git diffs | | x |

**Sync protocol:**
- Cloud → Local: task assignments, workflow state changes, routing decisions
- Local → Cloud: status updates (started/completed/failed), metadata (duration, exit code), result summaries (not full output)

---

## Monorepo Structure

```
torque-ai/
  packages/
    core/               # Shared orchestration logic
      scheduler/        # Task scheduling, slot-pull, provider routing
      workflow/         # DAG engine, workflow runtime
      quality/          # Safeguards, validation, baselines
      guidance/         # Guidance system (Layer 1-3)
      tool-defs/        # Tool definitions (JSON schemas)
      db/               # DatabaseAdapter interface
      constants.js
      providers/        # Registry, config, routing logic

    server/             # Self-hosted product (existing codebase)
      index.js          # MCP stdio + SSE + REST
      handlers/         # Tool handlers
      db/               # SQLiteAdapter (implements DatabaseAdapter)
      dashboard/        # Bundled dashboard

    cloud/              # TORQUE Cloud (Cloudflare Workers)
      src/
        worker.js       # Main Worker entry
        router.js       # Route parsing + dispatch
        auth/           # GitHub OAuth, magic link, API keys
        durable/        # Durable Objects (per-user orchestration)
        billing/        # Stripe webhook, tier enforcement
        db/             # D1Adapter (implements DatabaseAdapter)
          migrations/   # D1 schema migrations

    agent/              # Local relay (@torque-ai/agent)
      bin/
        torque-agent.js # CLI entry
      src/
        relay.js        # WebSocket connection to cloud
        executor.js     # Core command whitelist
        plugin-loader.js
        local-db.js     # SQLite for heavy data
        tray.js         # Optional system tray
      plugins/          # Built-in plugins
        codex.js, claude-cli.js, ollama.js, verify.js, git.js

    dashboard/          # Shared dashboard UI
      src/              # Used by both server and cloud

  package.json          # Workspace root (npm workspaces)
  wrangler.toml         # Cloudflare config
```

### Shared vs Product-Specific

| Component | Core | Server | Cloud | Agent |
|-----------|:---:|:---:|:---:|:---:|
| Scheduler logic | x | | | |
| Workflow engine | x | | | |
| Quality gates | x | | | |
| Tool definitions | x | | | |
| Guidance system | x | | | |
| Provider registry | x | | | |
| SQLite direct access | | x | | x |
| D1 adapter | | | x | |
| MCP stdio transport | | x | | |
| MCP SSE transport | | x | x | |
| Agent WebSocket relay | | | x | x |
| Auth + billing | | | x | |
| Plugin system | | | | x |
| Dashboard UI | | x | x | |

### Database Adapter Pattern

Core defines interfaces, products implement:

```js
// packages/core/db/adapter.js
class DatabaseAdapter {
  listTasks(filters) { throw new Error('Not implemented'); }
  createTask(task) { throw new Error('Not implemented'); }
  updateTaskStatus(id, status) { throw new Error('Not implemented'); }
  // ... all operations core needs
}

// packages/server/db/sqlite-adapter.js — direct SQLite (better-sqlite3)
// packages/cloud/db/d1-adapter.js — Cloudflare D1 (SQLite-compatible SQL)
```

D1 uses the same SQL syntax as SQLite — most adapter methods will be nearly identical. The adapter exists for structural differences (connection management, transaction semantics, available tables).

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

## Cloudflare Architecture

### Request Routing

```
HTTPS request → Cloudflare Edge (Worker)
  │
  ├─ 1. Parse route
  ├─ 2. Auth check (KV session or API key hash)
  ├─ 3. Rate limit check (KV counter)
  ├─ 4. Tier lookup (KV cached, source: D1)
  │
  ├─ /api/guidance     → Worker handler (stateless)
  ├─ /api/tasks/*      → Durable Object (user's DO)
  ├─ /api/workflows/*  → Durable Object
  ├─ /agent            → Durable Object (WebSocket upgrade)
  ├─ /auth/*           → Worker handler (stateless)
  └─ /*                → Pages (dashboard static files)
```

### Stateless vs Stateful

| Stateless (Worker) | Stateful (Durable Object per user) |
|----|----|
| Auth flows (OAuth, magic link) | Task queue + scheduler |
| API key validation | Workflow runtime |
| Guidance endpoint | Agent WebSocket connection |
| User profile CRUD | Provider routing decisions |
| Billing/tier checks | Real-time task status |
| Dashboard static serving | Event bus (notifications) |

### Durable Object Lifecycle

One Durable Object per user — perfect isolation, no row-level filtering needed.

**Throughput consideration:** A single DO serializes all requests for a user. For Pro users with 3 agents, multiple dashboard tabs, and high task throughput, this creates a bottleneck. For the initial launch, this is acceptable — the DO processes messages in microseconds, and the actual work (LLM calls, task execution) happens outside the DO. If profiling reveals contention at scale, shard into multiple DOs per user (agent-relay DO, scheduler DO, workflow DO). The D1-as-source-of-truth model makes this sharding straightforward since DOs don't depend on each other's local state.

```
First request after auth
  → Worker calls env.USER_ORCHESTRATOR.get(userId)
  → Cloudflare creates or wakes the DO
  → DO loads state from its transactional storage
  → DO reads shared data from D1 (provider configs, tool defs)

While active:
  → Holds WebSocket to agent
  → Processes task submissions, scheduling, workflow steps
  → Writes state to DO storage + syncs summaries to D1
  → Sends assignments to agent, receives status updates

After 30s of no activity:
  → Cloudflare hibernates DO (WebSocket stays alive via hibernation API)
  → Next message (WebSocket or HTTP) wakes DO and resumes
```

### Cloudflare Primitives Mapping

| Component | Primitive | Why |
|-----------|-----------|-----|
| REST API | Workers | Stateless request handling, global edge |
| Agent relay | Durable Objects | Per-user WebSocket state |
| Cloud DB | D1 | SQLite-compatible, minimal migration |
| Auth sessions | KV | Fast global session lookups |
| API key encryption | Worker env vars | Server-side secrets |
| Dashboard UI | Pages | Static site hosting |
| File storage | R2 | Exported reports, profile templates |
| History purge | Cron Triggers | 24h free / 30d pro cleanup |

### D1 vs DO Storage — Consistency Model

**D1 is the single source of truth for all durable state.** DO storage is a hot cache that can be fully rebuilt from D1 on wake. This eliminates split-brain scenarios — if a DO crashes after writing to its local storage but before syncing to D1, the D1 state is authoritative and the DO rebuilds from it on next wake.

| Data | D1 (authoritative) | DO Memory (hot cache) |
|------|:---:|:---:|
| User accounts | x | |
| API keys (hashed) | x | |
| Billing/tier status | x | cached |
| Provider configs | x | cached |
| Tool definitions | x | cached |
| Active task queue | x | cached in-memory |
| Workflow DAG state | x | cached in-memory |
| Scheduling decisions | x | cached in-memory |
| Task summaries | x | recent in-memory |
| Audit trail | x | |

**DO wake path:** On hibernation wake, the DO:
1. Reads active tasks and workflows from D1 for this user
2. Rebuilds in-memory indexes (task-by-status, workflow-by-id)
3. Resumes WebSocket connections (Cloudflare preserves these during hibernation)
4. Reconciles any stale state (tasks marked "running" in D1 but agent reports them complete)

**Write path:** DO writes to D1 first, then updates in-memory cache. If the D1 write fails, the operation fails — no optimistic local writes. D1 read latency is acceptable because the DO caches aggressively and most operations hit the in-memory cache.

This means the DO is a **stateless coordinator with a cache**, not a stateful database. Cloudflare can evict it at any time and the only cost is a cold-start rebuild from D1.

---

## D1 Schema

Cloud-only tables for multi-tenancy, auth, billing, and orchestration summaries.

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

-- Orchestration Summaries
CREATE TABLE task_summaries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  description TEXT,
  provider TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  summary TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  workflow_id TEXT
);

CREATE INDEX idx_task_summaries_user ON task_summaries(user_id, created_at DESC);
CREATE INDEX idx_task_summaries_workflow ON task_summaries(workflow_id)
  WHERE workflow_id IS NOT NULL;

CREATE TABLE workflow_summaries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT,
  status TEXT NOT NULL,
  total_tasks INTEGER DEFAULT 0,
  completed_tasks INTEGER DEFAULT 0,
  failed_tasks INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_workflow_summaries_user ON workflow_summaries(user_id, created_at DESC);

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

-- Audit Trail
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
```

**History purge (Cron Trigger, hourly):**
- Free tier: task/workflow summaries older than 24 hours
- Pro tier: task/workflow summaries older than 30 days
- Audit log: retained 90 days for all tiers

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
| Concurrent tasks | Durable Object | Structured error with upgrade_url |
| Active workflows | Durable Object | Structured error with upgrade_url |
| Agent connections | Durable Object | WebSocket reject with reason |
| Provider count | Durable Object | Error on 4th provider enable |
| Tool tier | Durable Object | "This tool requires Pro" |
| Batch orchestration | Durable Object | Pro-required error |
| Cloud history | Cron Trigger | Silent purge (agent keeps local) |

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

## Migration Path

### Phase 1: Monorepo Scaffold (no behavior change)

Move current code into `packages/server/`. Create empty shells for `core/`, `cloud/`, `agent/`, `dashboard/`. Add workspace root `package.json`. Self-hosted product works unchanged.

### Phase 2: Extract Core from Server

This is the highest-risk phase. The current codebase has deep coupling: `database.js` is imported by 177+ files, `task-manager.js` depends on `database.js`, `providers/`, and 12+ execution modules, and the execution modules use `fs`, `child_process`, and `process.cwd()` which cannot exist in Cloudflare Workers.

**The async conversion problem:** The current codebase uses `better-sqlite3` (synchronous). D1 is async. Core must use async interfaces so both adapters work. This is a cascading change — every function that touches the DB must become async, and every caller of those functions must await. This will be the largest single change in the extraction.

**Extraction strategy — two sub-phases:**

**Phase 2a: Extract pure-data modules (no async conversion needed):**

| Module | From | Risk | Coupling |
|--------|------|------|----------|
| Tool definitions (24 files) | `server/tool-defs/` | Low | Pure JSON, zero imports |
| Constants | `server/constants.js` | Low | Imported widely but no DB dependency |
| Guidance static files | `server/guidance/*.md` | Low | Pure content |

**Phase 2b: Extract logic modules (async conversion required):**

Before starting, produce a dependency graph: catalog every `require('fs')`, `require('child_process')`, `process.cwd()`, and synchronous DB call in the modules targeted for extraction. Size the async conversion scope.

| Module | From | Risk | Key Challenge |
|--------|------|------|---------------|
| Provider registry + config | `server/providers/` | High | DB calls for provider state, serverConfig dependency |
| Scheduler logic | `server/execution/` | High | Deep DB coupling, provider registry dependency |
| Workflow engine | `server/execution/workflow-runtime.js` | High | fs, child_process (indirect), conflict-resolver uses execFileSync |
| Quality gates | `server/handlers/validation/` | High | DB queries for baselines, file system access |
| Guidance handler | `server/handlers/guidance-handlers.js` | Medium | DB queries for dynamic context, fs for static files |

**The adapter pattern:** Core defines an async `DatabaseAdapter` interface with methods for all operations core needs (~50-100 methods across 15 sub-module domains). `packages/server` provides `SQLiteAdapter` that wraps synchronous `better-sqlite3` calls in thin async wrappers. `packages/cloud` provides `D1Adapter` that uses D1's native async API. Because D1 is SQLite-compatible, most SQL queries are identical — the adapter difference is primarily sync vs async wrapping and connection management.

**The Node.js API boundary:** Modules that use `fs`, `child_process`, or `process.cwd()` cannot move to core as-is. These capabilities must be injected via a platform adapter (similar to DatabaseAdapter but for runtime capabilities). In the cloud, these operations are delegated to the user's agent via WebSocket. In the server, they execute locally.

Each extraction: move module → replace direct DB/fs calls with adapter → update imports in server → run full test suite → commit. Server must pass all tests after every step. Budget 2-3 weeks for Phase 2b.

### Phase 3: Build Agent Package (parallel with Phase 4)

Build `packages/agent/` — WebSocket relay, CLI, plugin system, local SQLite. Can be developed independently once the agent protocol is defined.

### Phase 4: Build Cloud Package (depends on Phase 2)

Build `packages/cloud/` — Worker, Durable Objects, auth, billing, D1 adapter. Depends on core extraction being complete.

### Phase 5: Integration

Wire everything together. End-to-end testing: dashboard → cloud → agent → local execution → result back to dashboard.

### Phase Dependencies

```
Phase 1 (scaffold)        ← zero risk, file moves only
    ↓
Phase 2 (extract core)    ← biggest refactor, incremental, tests after each step
    ↓
┌──────────────────────┐
│ Phase 3 (agent)      │  ← parallel
│ Phase 4 (cloud)      │  ← parallel
└──────────────────────┘
    ↓
Phase 5 (integration)     ← end-to-end
```

### Risk Mitigation

- Phase 2 is highest risk. 15,000+ tests must keep passing. Move one module at a time.
- Self-hosted product must never break. Upgrading to monorepo = `npm install` and done.
- D1 is SQLite-compatible, minimizing cloud adapter differences.
- Agent can be tested against a mock cloud server before integration.

---

## Cloud-to-Cloud Provider Calls

When a task routes to a cloud API provider (DeepInfra, Anthropic, Groq), the DO makes the API call directly via `fetch()`. Wall-clock I/O time does not count against Cloudflare's CPU limit.

**Flow:** DO decrypts user's BYOK key → constructs provider API request → `fetch()` to provider → receives response → sends summary to D1 + full result via WebSocket to agent for local storage.

**Timeouts:** 120-second timeout per provider call (configurable per provider in user_providers config). On timeout, task is marked failed with a retryable error.

**Streaming:** For streaming LLM responses, the DO buffers chunks and forwards progress updates to the agent via `task.status` messages. Full output is assembled and sent as `task.complete` when the stream finishes.

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
4. Self-hosted product passes all existing tests after monorepo migration
5. Dashboard works identically for self-hosted and cloud (shared package, conditional features)
6. Agent reconnects automatically after network interruption within 60 seconds
7. Cloud responds to API requests in <100ms (p95) via Cloudflare edge
8. Zero personal data in any shipped file
