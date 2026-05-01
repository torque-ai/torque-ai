# TORQUE Unified Workstations — Design Spec

**Date:** 2026-03-16
**Status:** Approved (pending implementation)
**Sub-project:** 1 of 4 (Unified Model → Setup Flow → Claude Awareness → Workload Distribution)

## Overview

Unify TORQUE's three separate remote machine systems (peek hosts, remote agents, Ollama hosts) into a single "workstation" concept. A workstation is any machine — local or remote — that TORQUE can route work to. Each workstation runs a unified agent that auto-detects capabilities (GPU, Ollama, UI capture, build tools, test runners) and reports health. Claude is notified of available workstations at session start so it actually uses them.

## Motivation

TORQUE currently has three independent systems for remote machines:
- **Peek hosts** — UI capture and interaction (`peek_hosts` table)
- **Remote agents** — command execution and test running (`remote_agents` table)
- **Ollama hosts** — LLM inference (`ollama_hosts` table)

Each has its own registration, health checks, credentials, dashboard UI, and MCP tools. This fragmentation means:
- Users register the same physical machine three times for different capabilities
- Claude doesn't know a "peek host" and a "remote agent" are the same machine
- Claude frequently forgets remote machines exist entirely
- Three separate health check loops, three credential stores, three dashboard views

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Data model | Single `workstations` table replaces all three | Clean, no indirection. One machine = one record |
| Migration strategy | Strangler fig (adapters during transition) | Ship incrementally, zero risk to existing functionality |
| Capability detection | Auto-detect with manual override | Probes machine on registration, user corrects if needed |
| Agent model | Single Node.js agent per workstation | One process handles health, exec, git sync, peek proxy |
| Peek server | Optional external dependency — not bundled with TORQUE | Keeps repo focused, no Python dependency. Agent detects and proxies to peek_server if already running. |
| Registration paths | SSH bootstrap OR manual agent install | Maximum flexibility — both lead to same agent-based communication |
| Security | Mutual TLS | Both sides verify. Strongest model for a public project |
| Failover | Transparent re-route to another workstation or local | Consistent with existing TORQUE provider failover behavior |
| Claude awareness | Session notification + auto-routing by capability | Claude knows what's available and tasks route automatically |

## Workstation Data Model

Single `workstations` table replaces `peek_hosts`, `remote_agents`, and `ollama_hosts`:

```sql
CREATE TABLE workstations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  agent_port INTEGER DEFAULT 3460,
  platform TEXT,
  arch TEXT,

  -- Security (mTLS)
  tls_cert TEXT,
  tls_fingerprint TEXT,
  secret TEXT,                      -- see note below on validation

  -- Capabilities (auto-detected, user-overridable)
  capabilities TEXT,               -- JSON

  -- Ollama-specific
  ollama_port INTEGER DEFAULT 11434,
  models_cache TEXT,
  memory_limit_mb INTEGER,
  settings TEXT,                    -- JSON: per-host Ollama tuning (num_gpu, num_thread, keep_alive, num_ctx)
  last_model_used TEXT,             -- warm-model affinity tracking
  model_loaded_at TEXT,             -- timestamp of last model load
  gpu_metrics_port INTEGER,         -- companion gpu-metrics-server port
  models_updated_at TEXT,           -- model cache freshness (separate from last_health_check)

  -- GPU info
  gpu_name TEXT,
  gpu_vram_mb INTEGER,

  -- Status & health
  status TEXT DEFAULT 'unknown',
  consecutive_failures INTEGER DEFAULT 0,
  last_health_check TEXT,
  last_healthy TEXT,

  -- Capacity
  max_concurrent INTEGER DEFAULT 3,
  running_tasks INTEGER DEFAULT 0,
  priority INTEGER DEFAULT 10,

  -- Metadata
  enabled INTEGER DEFAULT 1,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

**Security validation:** Registration flow validates that at least one of `tls_cert` or `secret` is present. A workstation with neither is rejected. Both fields are nullable in the schema, but the application layer enforces this invariant.

**Capabilities JSON:**
```json
{
  "command_exec": true,
  "git_sync": true,
  "ollama": { "detected": true, "port": 11434, "models": ["qwen3:8b"] },
  "gpu": { "detected": true, "name": "RTX 3090", "vram_mb": 24576 },
  "ui_capture": { "detected": true, "has_display": true, "peek_server": "running" },
  "build_tools": ["npm", "dotnet", "cargo"],
  "test_runners": ["vitest", "pytest"],
  "platform": { "os": "windows", "arch": "x64", "ram_mb": 65536, "disk_free_gb": 450 }
}
```

## Unified TORQUE Agent

A single Node.js process runs on every workstation. Replaces the current `agent-server.js` and coordinates peek_server.

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Full capability report + system metrics |
| `/probe` | GET | One-time capability detection (runs on registration) |
| `/run` | POST | Execute command with streaming NDJSON response |
| `/sync` | POST | Git clone/pull a project |
| `/peek/*` | * | Proxy to peek_server if running, or return 404 |
| `/certs` | GET | Return agent's TLS certificate for pinning |

### `/health` response
```json
{
  "status": "ok",
  "capabilities": { "ollama": true, "gpu": true, "ui_capture": true },
  "load": { "running_tasks": 1, "max_concurrent": 3 },
  "system": { "cpu_percent": 23, "ram_available_mb": 48000, "ram_total_mb": 65536, "disk_free_gb": 450 },
  "gpu": { "name": "RTX 3090", "utilization_percent": 45, "vram_used_mb": 8200, "vram_total_mb": 24576 },
  "ollama": { "running": true, "models": ["qwen3:8b", "codestral:22b"] },
  "peek": { "running": true, "version": "1.2.0" }
}
```

### `/probe` response (one-time, heavier checks)
```json
{
  "platform": "windows",
  "arch": "x64",
  "capabilities": {
    "command_exec": true,
    "git_sync": true,
    "ollama": { "detected": true, "port": 11434, "models": ["qwen3:8b"] },
    "gpu": { "detected": true, "name": "RTX 3090", "vram_mb": 24576 },
    "ui_capture": { "detected": true, "has_display": true, "peek_server": "running" },
    "build_tools": ["npm", "dotnet"],
    "test_runners": ["vitest", "jest"]
  }
}
```

### Peek server management

Peek_server is a separate support package (not bundled with TORQUE). The agent checks if peek_server is already running on the machine. If detected, `/peek/*` routes proxy to it transparently. If not running, the `ui_capture` capability is reported as unavailable. Users install peek_server independently if they want UI capture features.

### mTLS bootstrap

On first start, the agent generates a self-signed cert/key pair and stores them locally (`~/.torque-agent/certs/`). The `/certs` endpoint returns the public cert. During registration, TORQUE fetches this cert and pins it. Subsequent communication uses mutual TLS — TORQUE presents its server cert, agent presents its cert, both verify.

### mTLS certificate lifecycle

- **Cert lifetime:** Default 365 days, configurable via `--cert-lifetime-days` on agent init. Expiration is tracked in the workstation record; TORQUE warns 30 days before expiry via dashboard and session notification.
- **Rotation:** `torque workstation probe <name>` re-fetches the agent's current cert and re-pins it. Agents that detect their cert is nearing expiry auto-regenerate on next restart; the new cert is picked up on the next probe.
- **Initial trust model:** Trust-on-first-use (TOFU) — the cert returned by `/certs` during registration is trusted without a pre-existing CA. This is acceptable for LAN deployments where network-level trust is reasonable. For WAN deployments, users should verify the agent's TLS fingerprint out-of-band (displayed by `npx torque-agent init` and shown in the dashboard wizard) before confirming registration.
- **Server cert distribution:** The TORQUE server's cert is passed to the agent during SSH bootstrap (copied alongside the agent bundle). For manual agent installs, the agent fetches it from TORQUE's `/certs` endpoint during the registration handshake.
- **Validation invariant:** A workstation record with neither `secret` nor `tls_cert` populated is rejected during registration. This ensures every workstation has at least one authentication mechanism.

## Registration Flow

Two paths to the same result.

### Path 1: SSH Bootstrap

```
User provides: hostname/IP + SSH credentials
    │
    ├─ TORQUE SSHes in
    ├─ Copies agent bundle (agent-server.js + deps)
    ├─ Installs as system service (systemd on Linux, scheduled task on Windows)
    ├─ Agent starts, generates mTLS certs
    ├─ TORQUE calls /probe to detect capabilities
    ├─ Creates workstation record with detected capabilities
    ├─ User reviews capabilities in dashboard, adjusts if needed
    └─ Workstation is live
```

### Path 2: Manual Agent Install

```
User runs on target machine: npx torque-agent init
    │
    ├─ Downloads agent bundle
    ├─ Generates mTLS certs
    ├─ Starts agent on port 3460
    ├─ Prints registration instructions
    │
    └─ User runs CLI command or uses dashboard "Add Workstation" form
        │
        ├─ TORQUE calls /certs to pin the certificate
        ├─ TORQUE calls /probe to detect capabilities
        ├─ Creates workstation record
        └─ Workstation is live
```

### Partial registration and idempotency

If registration fails at any step, re-running registration with the same name is safe and resumes from the last successful step. Partial registrations are tracked via the workstation record's status field (`registering` → `probing` → `healthy`). The SSH bootstrap path is idempotent — re-running it skips already-installed components (checks for existing agent service, existing cert directory, etc.). The manual path is similarly idempotent: re-calling `/certs` and `/probe` on an already-registered agent simply refreshes the pinned cert and capabilities.

### Dashboard "Add Workstation" wizard

1. Choose method: SSH bootstrap or "Agent already running"
2. SSH path: enter host, username, key/password → progress bar during bootstrap → capability review
3. Agent path: enter host:port → capability detection → review
4. Final step: name the workstation, set priority, set as default (yes/no)

### CLI commands

- `torque workstation add <name> --host <ip> [--ssh-user <user>] [--ssh-key <path>]`
- `torque workstation list`
- `torque workstation remove <name>`
- `torque workstation probe <name>` (re-detect capabilities)

## Adapter Layer & Migration Strategy

Strangler fig pattern. Existing code keeps working while consumers are migrated.

### Adapter functions

Thin wrappers that translate old API calls → new `workstations` table queries:

- `listOllamaHosts(filters)` → queries workstations with `ollama` capability, returns old shape
- `resolvePeekHost(args)` → finds workstation with `ui_capture` capability
- `getAvailableAgents()` → finds workstations with `command_exec` capability and capacity
- `addOllamaHost(...)` → creates workstation with ollama capability
- `registerPeekHost(...)` → creates workstation with ui_capture capability
- `registerRemoteAgent(...)` → creates workstation with command_exec capability

### Ollama routing preservation

`host-selection.js` contains complex Ollama-specific routing logic: memory safeguards, warm-model affinity, capacity-weighted selection. This logic is migrated in Phase 3 to query the `workstations` table directly. Until then, the adapter's `listOllamaHosts()` must return objects with ALL fields that `host-selection.js` relies on. The following field mapping ensures nothing is lost:

| `ollama_hosts` field | Workstation source |
|----------------------|--------------------|
| `ollama_hosts.url` | `http://${ws.host}:${ws.ollama_port}` |
| `ollama_hosts.memory_limit_mb` | `ws.memory_limit_mb` |
| `ollama_hosts.max_concurrent` | `ws.max_concurrent` |
| `ollama_hosts.running_tasks` | `ws.running_tasks` |
| `ollama_hosts.priority` | `ws.priority` |
| `ollama_hosts.models_cache` | `ws.models_cache` |
| `ollama_hosts.last_model_used` | `ws.last_model_used` |
| `ollama_hosts.model_loaded_at` | `ws.model_loaded_at` |
| `ollama_hosts.settings` | `ws.settings` |
| `ollama_hosts.gpu_metrics_port` | `ws.gpu_metrics_port` |
| `ollama_hosts.status` | `ws.status` |
| `ollama_hosts.enabled` | `ws.enabled` |

Any new columns added to `workstations` for Ollama functionality must also be surfaced through this adapter until Phase 3 migration of `host-selection.js` is complete.

### Migration phases

| Phase | What happens | Risk |
|-------|-------------|------|
| **Phase 1** | Create `workstations` table. New registrations go through workstation flow. Adapters make old code read from new table. | Low |
| **Phase 2** | Migrate existing `peek_hosts`, `remote_agents`, `ollama_hosts` data into `workstations` via schema migration. Old tables become read-only shadows. The `host_credentials` table's `host_type CHECK(host_type IN ('ollama', 'peek'))` constraint must be relaxed to include `'workstation'`, or credentials should be migrated into the workstation's own security fields (`tls_cert`, `tls_fingerprint`, `secret`). Additionally, update `complexity_routing.target_host` values to reference corresponding workstation IDs, and update `routeTask()` in `host-management.js` to query `workstations` instead of `ollama_hosts`. | Low |
| **Phase 3** | Migrate consumers one by one to query `workstations` directly. Remove each adapter as its consumers are migrated. | Medium per consumer, low overall |
| **Phase 4** | Drop old tables. Remove adapter layer. Remove old MCP tools. | Low — all consumers already migrated |

### Backward compatibility during transition

Old MCP tools (`add_ollama_host`, `register_peek_host`, `register_remote_agent`) continue to work — they create workstation records behind the scenes via adapters. Users don't notice the change.

## Claude Awareness

Three mechanisms ensure Claude knows about and uses remote workstations.

### 1. Session-start notification

When an MCP session connects, TORQUE pushes available workstations:

```json
{
  "type": "workstation_status",
  "workstations": [
    {
      "name": "gpu-box",
      "host": "192.168.1.100",
      "status": "healthy",
      "capabilities": ["command_exec", "git_sync", "gpu", "ui_capture", "ollama"],
      "gpu": "RTX 3090 (24GB)",
      "is_default": true
    }
  ],
  "hint": "Remote workstations available. Use them for testing, builds, and UI verification instead of running locally."
}
```

### 2. Tool descriptions embed workstation awareness

Existing tools (`submit_task`, `smart_submit_task`, `run_workflow`) get updated descriptions mentioning remote workstations and how to target them.

### 3. Auto-routing by capability

When a task is submitted without an explicit workstation, TORQUE matches task characteristics to workstation capabilities:

| Task signal | Routes to workstation with |
|-------------|---------------------------|
| `verify_command` contains test runner names | `test_runners` capability |
| `verify_command` contains build tool names | `build_tools` capability |
| Task provider is `ollama` / `hashline-ollama` | `ollama` capability + requested model |
| `peek_ui` tool call | `ui_capture` capability |
| No specific signal | Default workstation (if set), else local |

Fallback: if matched workstation is down or at capacity, transparent failover to local execution.

## Health Monitoring & Failover

### Unified health check loop

Single loop in `host-monitoring.js` replaces three separate check loops:

- **Interval:** configurable, default 30s
- **Check:** `GET /health` on each enabled workstation's agent port
- **Failure handling:** 3 consecutive failures → status = `down`. Auto-recovery when next check succeeds.
- **Distributed lock:** Only one MCP instance runs checks per cycle

### Failover flow

Re-route only applies to tasks in `queued` status assigned to a downed workstation. Tasks in `running` status are marked `failed` with a clear error (`workstation_down: <name>`) and resubmitted via the existing retry mechanism (which handles provider fallback, retry counts, etc.). This is simpler and consistent with current TORQUE behavior — running tasks may have partial state that cannot be safely transferred.

```
Health check detects workstation "build-server" is down
    │
    ├─ Find tasks assigned to "build-server"
    │
    ├─ For tasks with status='queued':
    │   ├─ Find another workstation with matching capabilities + capacity
    │   ├─ If found: re-route task, git sync project, start execution
    │   ├─ If no remote match: fall back to local execution
    │   └─ If local can't handle it: mark task failed with clear error
    │
    ├─ For tasks with status='running':
    │   └─ Mark failed with error "workstation_down: build-server"
    │       → existing retry mechanism handles resubmission with provider fallback
    │
    └─ Emit 'workstation:down' event → dashboard + SSE notification
```

### Dashboard indicators

Workstation card shows: status dot (green/amber/red), latency, load bar, capability icons, GPU metrics. When a workstation goes down: card turns red, toast notification, affected task count shown.

## Testing Strategy

### Unit tests (~25)

- Workstation CRUD — create, read, update, delete, list with filters
- Capability detection parsing — probe response → capabilities JSON
- Adapter layer — `listOllamaHosts()`, `resolvePeekHost()`, `getAvailableAgents()` return correct shapes
- Auto-routing — task signals matched to workstation capabilities
- Failover logic — down workstation → re-route → fall back to local
- mTLS cert generation and pinning

### Integration tests (~15)

- Registration flow — probe → create workstation → verify capabilities stored
- Health check cycle — healthy → 3 failures → down → recovery → healthy
- Task submission with workstation routing — verify task lands on correct workstation
- Failover — submit to workstation, simulate failure, verify re-route
- Adapter compatibility — old `add_ollama_host` tool creates workstation record
- Session notification — connect, verify workstation_status pushed
- Schema migration — existing data migrated correctly

### E2E tests (~3)

- Dashboard "Add Workstation" wizard — both SSH and manual paths
- Workstation card — status, capabilities, health indicators
- Workstation list — enable/disable/remove

## Files to Create/Modify

### New files
- `server/workstation/model.js` — workstation CRUD, capability parsing
- `server/workstation/agent.js` — unified agent (expanded from agent-server.js)
- `server/workstation/probe.js` — capability detection logic
- `server/workstation/adapters.js` — backward-compatible wrappers for old APIs
- `server/workstation/certs.js` — mTLS certificate generation, pinning, verification
- `server/workstation/routing.js` — capability-based task routing to workstations
- `server/workstation/failover.js` — transparent failover on workstation failure
- `server/handlers/workstation-handlers.js` — MCP tool handlers
- `server/tool-defs/workstation-defs.js` — tool definitions
- `server/tests/workstation-model.test.js` — unit tests
- `server/tests/workstation-integration.test.js` — integration tests
- `dashboard/src/views/Workstations.jsx` — unified workstation management view
- `dashboard/src/components/WorkstationWizard.jsx` — add workstation wizard
- `dashboard/e2e/workstations.spec.js` — E2E tests
- `agent/index.js` — standalone agent entry point (for `npx torque-agent init`)
- `agent/package.json` — agent package

### Modified files
- `server/db/schema-migrations.js` — create `workstations` table, migrate existing data
- `server/db/schema-seeds.js` — seed default workstation config keys
- `server/utils/host-monitoring.js` — unified health check loop for workstations
- `server/db/host-management.js` — add adapter functions
- `server/db/host-selection.js` — route to workstations instead of ollama_hosts
- `server/handlers/peek/shared.js` — use workstation adapter for host resolution
- `server/remote/agent-client.js` — connect to workstations instead of remote_agents
- `server/remote/remote-test-routing.js` — use workstation for remote test execution
- `server/mcp-sse.js` — push workstation_status on session connect
- `server/tools.js` — register workstation handlers and tool defs
- `server/handlers/task/core.js` — pass workstation routing through submission
- `dashboard/src/components/Layout.jsx` — add Workstations nav item
