# Guidance System — Design Spec

**Date:** 2026-03-16
**Status:** Draft (post-review revision 1)
**Scope:** Universal LLM behavioral guidance delivery for TORQUE

## Problem

TORQUE's operational knowledge — the behavioral discipline that makes an LLM effective as a task orchestrator — currently lives in a single user's personal `~/.claude/CLAUDE.md`. Public users get a 309-line project CLAUDE.md that covers reference material (providers, routing, pricing) but not the behavioral discipline (don't poll, use await, read before edit, don't kill processes). Without this discipline, LLM orchestrators make costly mistakes: polling in loops, killing the server, cancelling other sessions' tasks, and bypassing TORQUE to write code manually.

## Goals

1. Any user — Claude Code, Cursor, custom agent, REST client — operates at the same level of TORQUE competency
2. Guidance scales with the user's tier (progressive disclosure, not information overload)
3. No personal data ships in the repo
4. Works offline (CLAUDE.md) and online (API)
5. Single source of truth per content type — no duplication, no drift

## Non-Goals

- User-facing documentation or tutorials (separate concern)
- Dashboard UI for guidance (future)
- Guidance authoring tools (edit markdown files directly)

## Architecture

### Three-Layer Composition

```
┌──────────────────────────────────────────────────┐
│              /api/guidance response               │
│       (composed at request time per session)       │
├─────────────┬─────────────────┬──────────────────┤
│   Layer 1   │     Layer 2     │     Layer 3      │
│   STATIC    │  TOOL-DERIVED   │    DYNAMIC       │
├─────────────┼─────────────────┼──────────────────┤
│ Behavioral  │ Per-tool usage  │ Enabled providers│
│ discipline  │ patterns from   │ Unlocked tier    │
│ rules       │ tool-def desc   │ Project defaults │
│             │ fields          │ Host inventory   │
│             │                 │ User profile     │
├─────────────┼─────────────────┼──────────────────┤
│ server/     │ server/         │ SQLite DB +      │
│ guidance/   │ tool-defs/*.js  │ ~/.torque/       │
│ *.md        │                 │ profile.md       │
└─────────────┴─────────────────┴──────────────────┘
```

### Layer 1 — Static Behavioral Rules

Files in `server/guidance/`, shipped in repo, version-controlled:

| File | Content |
|------|---------|
| `core-discipline.md` | Don't poll (use await_task/await_workflow/await_ci_run), don't kill processes (use cancel_task), don't cancel without inspecting, prescriptive await pattern table |
| `edit-discipline.md` | Harness problem rules, prefer hashline_read + hashline_edit, read before edit, unique anchors, Write for small files / Edit for large |
| `orchestration-patterns.md` | Always scan_project first, use await_workflow for chaining, verify after Codex (git diff --stat), commit artifacts immediately, parallelize independent tasks |
| `safety.md` | File safety (never git clean, never delete untracked), Codex sandbox contamination (100% repro), orchestrator role (plan/submit/verify, don't manually implement) |
| `onboarding.md` | First-run guidance, progressive discovery, remote host setup prompt, peek_ui introduction |

Core discipline, edit discipline, orchestration patterns, and safety files are always included regardless of tier. Safety rules don't tier-gate. Onboarding is included only when `~/.torque/profile.md` does not exist (first-run indicator) — established users don't need it on every request.

Read once at server startup, cached in memory. **Missing files:** If any guidance file is absent, log a warning and serve partial guidance. The server does not fail to start over a missing guidance file — graceful degradation.

### Layer 2 — Tool-Derived Guidance

Already exists: each tool definition in `server/tool-defs/*.js` has a `description` field. The guidance endpoint:

1. Reads the session's unlocked tier
2. Filters tool-defs to tools available at that tier
3. Groups by domain using a static filename-to-domain mapping (see below)
4. Formats descriptions as usage guidance

**Domain grouping mechanism:** A static map in `guidance-handlers.js` maps tool-def filenames to display domain labels:

```js
const TOOL_DOMAIN_MAP = {
  'task-defs.js':        'Task Management',
  'workflow-defs.js':    'Workflows',
  'automation-defs.js':  'Automation & Batch',
  'ci-defs.js':          'CI Integration',
  'host-defs.js':        'Host Management',
  'provider-defs.js':    'Provider Configuration',
  'governance-defs.js':  'Governance & Policy',
  'hashline-defs.js':    'File Editing (Hashline)',
  'peek-defs.js':        'Visual Verification (Peek)',
  // ... remaining tool-def files
};
```

New tool-def files without a mapping entry fall into an "Other" domain. Meta-tools from `core-defs.js` (ping, restart, unlock) are excluded from the tool guidance section — they are infrastructure, not user workflow tools.

The complete map must cover all 24 tool-def files at implementation time. This keeps grouping explicit without requiring changes to every tool definition.

No separate guidance files needed — the tool definition IS the guidance source. To improve guidance for a tool, improve its description field. Zero duplication.

### Layer 3 — Dynamic Context

Assembled fresh per request from:

- **Provider state** (DB) — which providers are enabled, healthy, their models
- **Host inventory** (DB) — registered Ollama hosts, GPU info, model lists, health status
- **Project defaults** (DB) — verify_command, default provider, auto-fix settings
- **Tier state** (DB) — current unlock level, tool count

### Layer 3b — User Profile

`~/.torque/profile.md` — user-authored, never committed, optional.

Contains user-specific context: preferred test host, peek_server location, custom behavioral rules, notes for the LLM about their environment.

Auto-scaffolded by the server on first startup if `~/.torque/` does not exist. Template includes:
- Remote host configuration guidance
- Peek server setup section
- Custom rules section
- Example entries

If the file doesn't exist at request time, Layer 3b is omitted (no error).

**Size limit:** Maximum 64KB. If the file exceeds this, it is truncated with a warning appended to the guidance output. Content is returned verbatim (no rendering or interpretation).

## Delivery Mechanisms

### Path 1: REST Endpoint

```
GET /api/guidance
  ?tier=1|2|3          (optional, defaults to session's unlocked tier)
  ?format=markdown|json (optional, defaults to markdown)
  ?sections=rules,tools,environment  (optional, filter specific sections)
```

**Authentication:** None required — same as all other TORQUE REST routes (local-only server). If TORQUE gains network exposure in the future, guidance should be gated behind the same auth as other endpoints.

**Markdown response structure:**

```markdown
## Core Discipline
[from server/guidance/core-discipline.md]

## Edit Discipline
[from server/guidance/edit-discipline.md]

## Orchestration Patterns
[from server/guidance/orchestration-patterns.md]

## Safety
[from server/guidance/safety.md]

## Your Tools (Tier N)
### Task Management
- submit_task — [description]
- cancel_task — [description]
### Workflows
- create_workflow — ...
### CI
- await_ci_run — ...

## Your Environment
- Providers: ollama (enabled), codex (enabled), deepinfra (disabled)
- Hosts: local-gpu (RTX 3090, healthy, 2 models)
- Project: verify_command="npm test", provider="codex"

## Your Profile
[from ~/.torque/profile.md if exists]
```

**JSON response structure:**

```json
{
  "tier": 1,
  "version": "1.0.0",
  "content_hash": "sha256:abc123...",
  "sections": {
    "rules": {
      "core_discipline": "...",
      "edit_discipline": "...",
      "orchestration_patterns": "...",
      "safety": "...",
      "onboarding": "..."
    },
    "tools": [
      {
        "domain": "Task Management",
        "tools": [
          { "name": "submit_task", "guidance": "..." }
        ]
      }
    ],
    "environment": {
      "providers": [...],
      "hosts": [...],
      "project_defaults": {...}
    },
    "profile": "..."
  }
}
```

The `version` field tracks the TORQUE server version. The `content_hash` is a SHA-256 of the composed content, allowing clients to cache and skip re-processing when guidance hasn't changed. The `onboarding` key in `rules` is present only when `~/.torque/profile.md` does not exist (first-run indicator); omitted otherwise.

### Path 2: CLAUDE.md (Static, In-Repo)

Rewritten to ~120-150 lines. Contains:

- Setup instructions (MCP config, first run)
- Core discipline rules (embedded — works without server running)
- Orchestrator role definition
- File safety rules
- Command table
- Pointer to `ping` / `/api/guidance` for dynamic context

Does NOT contain: provider tables, pricing, model tiers, smart routing details, stall thresholds, multi-host setup, capability matrix, tool catalogs. All of that moves to Layer 2/3 (served dynamically).

### Path 3: MCP `ping` Enhancement

The existing `ping` response adds a `guidance` field:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "guidance": "## Core Discipline\n..."
}
```

Same content as `/api/guidance` markdown format, scoped to the session's tier. Zero extra round-trips — Claude gets behavioral context on first MCP contact.

**Opt-in to avoid bloat:** The `ping` tool accepts an optional `include_guidance: true` parameter (default: `false`). Without it, ping remains a lightweight keepalive (~60 bytes). Claude Code's CLAUDE.md instructs it to pass `include_guidance: true` on the first ping of a session. Subsequent pings omit it.

**Ping handler location:** Currently in `server/tools.js` (ping case in the switch statement).

## Progressive Disclosure via Tiers

| Tier | Tools | Guidance Includes |
|------|-------|-------------------|
| **1 (Free)** | ~29 core | Core discipline + basic tool patterns (submit, status, review, cancel) |
| **2 (Extended)** | 80 | + workflow tools, automation tools, batch lifecycle, provider config |
| **3 (Full)** | 505 | + structural TypeScript tools, advanced orchestration, audit pipeline, validation |

Tier numbers match the codebase (`server/core-tools.js` tiers 1/2/3, `unlock_tier` validates `[1, 2, 3]`).

Layer 1 (behavioral rules) and Layer 3 (environment) are always included at every tier. Only Layer 2 (tool guidance) is tier-filtered.

## Prescriptive Await Patterns

Core discipline includes a pattern table — prescriptive replacements, not just prohibitions:

| Scenario | Don't | Do |
|----------|-------|----|
| Waiting for a task | Poll `check_status` in a loop | `await_task` — wakes instantly on completion |
| Waiting for a workflow | Poll `workflow_status` in a loop | `await_workflow` — yields each completed task |
| Waiting for CI | Poll `ci_run_status` in a loop | `await_ci_run` — blocks until run finishes |
| Verifying after task | Manually run tests then check | `await_task` with `verify_command` — runs tests automatically |
| Verify + commit | Manual test then manual commit | `await_task` with `verify_command` + `auto_commit: true` |

## Onboarding: Remote Host Discovery

On first server startup (when `~/.torque/` does not exist), the server auto-scaffolds `~/.torque/profile.md` from a template and logs a message prompting the user to configure remote hosts:

```
Do you have other machines with GPUs on your network?
TORQUE can distribute tasks across multiple machines automatically.
  - Run tests on a remote machine while you keep working locally
  - Offload quality-tier tasks to a high-VRAM GPU host

→ Add a remote host now (enter hostname or IP)
→ Skip for now (add later with add_ollama_host)
```

The `~/.torque/profile.md` template includes a Remote Hosts section with examples.

When remote hosts are configured, Layer 3 guidance includes a tip:

```
Tip: You have remote-gpu-host available. Route tests and quality-tier tasks there for faster iteration.
```

## Personal Data Policy

**Never ships in repo:**
- IP addresses, hostnames, usernames referencing specific users
- Filesystem paths containing usernames
- Subscription/billing information
- SSH commands with real credentials
- API keys (even as examples — use `YOUR_API_KEY` placeholder)

**Ships as generic examples:**
- `remote-gpu-host (192.168.1.x)` not real IPs
- `ssh user@host` not real usernames
- Model names are fine (they're public Ollama models)

**Verification:** Pre-commit grep for known personal identifiers (configurable pattern list).

## File Layout

### New Files

```
server/
  guidance/
    core-discipline.md
    edit-discipline.md
    orchestration-patterns.md
    safety.md
    onboarding.md
  handlers/
    guidance-handlers.js      # Assembly logic + GET /api/guidance
```

### Modified Files

```
server/index.js              # Register guidance handlers, cache static files at startup, auto-scaffold ~/.torque/
server/api/routes.js         # Add /api/guidance route
server/tools.js              # Add include_guidance param to ping handler
server/tool-defs/core-defs.js # Add include_guidance boolean to ping schema
CLAUDE.md                    # Rewrite to lean ~120-150 line version
```

### User Disk (not in repo)

```
~/.torque/
  profile.md                 # Auto-scaffolded on first startup, user-editable
```

## Content Extraction Map

Source: personal global `~/.claude/CLAUDE.md` TORQUE sections.

| Source Block | Destination | Treatment |
|-------------|-------------|-----------|
| TORQUE Workflow Discipline | `guidance/core-discipline.md` | Direct extraction, genericized |
| Harness Problem — Edit Discipline | `guidance/edit-discipline.md` | Direct extraction |
| Process Safety — NEVER Kill | `guidance/core-discipline.md` | Direct extraction |
| Task Safety — NEVER Cancel | `guidance/core-discipline.md` | Direct extraction |
| TORQUE Best Practices | `guidance/orchestration-patterns.md` | Direct extraction, genericized |
| Automation/Batch/Orchestration tool catalogs | Layer 2 (tool-def descriptions) | Verify descriptions are rich enough; enrich if not |
| TypeScript structural tools | Layer 2 (tool-def descriptions) | Same |
| peek_ui usage | Tool-def description + `guidance/onboarding.md` | Genericize server location |
| TORQUE MCP Server start/stop | `guidance/onboarding.md` | Generic paths |
| Cloud Inference Providers table | Layer 3 dynamic (from DB) | Auto-generated |
| Personal host inventory | User's `~/.torque/profile.md` template | Example only |
| Headwaters convenience wrappers | Layer 2 (tool-def descriptions) | Already generic tools with configurable defaults |

## Caching Strategy

| Content | Cached | Invalidated |
|---------|--------|-------------|
| Layer 1 (static files) | At startup, in memory | Server restart |
| Layer 2 (tool descriptions) | Server-wide, 3 slots (one per tier), built on first request | Server restart (tools don't change at runtime) |
| Layer 3 (DB state) | Not cached | Fresh per request |
| Layer 3b (profile.md) | Not cached | Fresh per request (file may change) |

Layer 2 cache is server-wide (keyed by tier number), not per-session. The REST endpoint receives tier via query parameter; MCP sessions carry tier in session state. Both resolve to the same 3 cache slots.

Total expected response time: <10ms (Layer 1+2 from cache, Layer 3 is fast DB reads).

## Success Criteria

1. A new user clones the repo, starts the server (which auto-scaffolds `~/.torque/profile.md`), connects any LLM client, and immediately operates with full behavioral discipline
2. Tier-1 users see guidance for ~29 tools, not 505
3. Zero personal data in any shipped file (verified by grep)
4. CLAUDE.md is under 150 lines
5. `/api/guidance` responds in <50ms
6. Adding a new tool to a tool-def file automatically includes its guidance in the endpoint — no separate file to maintain
