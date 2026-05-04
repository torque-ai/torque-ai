# Server Module Sprawl Audit — 2026-05-04

Read-only audit of `server/` organization. Identifies what's misplaced, what
overlaps, what's orphaned, and what's been left behind by partial refactors.
Findings are grouped by risk/effort so we can pick clusters to fix one at a time.

Scope: `server/` only. Dashboard, scripts, agents, root-level files, and docs
layout are out of scope for this pass.

---

## TL;DR

- **3 cleanups are nearly free** (delete orphaned files, eliminate the 1-line
  `api-server.js` shim, delete the empty `server/server/` dir).
- **5 "naming collision" cleanups** (root file vs. directory of the same
  concept) are mechanical moves with import rewrites — low risk, medium
  payoff in legibility.
- **3 god-modules** (`database.js`, `task-manager.js`, `discovery.js` ≥ 1100
  lines each) need real refactors and should each be their own session.
- **1 documentation finding**: the auto-memory note "DI migration complete"
  is overstated. `database.js` still has 84 importers (~50 source, ~34 test)
  — the legacy facade is load-bearing.

Recommended starting cluster (this session): **Cluster 1 — Trivial cleanups
& shim removal.** Lowest risk, highest "obviously-better" payoff, exercises
the worktree workflow before tackling anything sensitive.

---

## Cluster 1 — Trivial cleanups (no behavior change)

### 1.1 Delete orphaned files

| File | Lines | Source consumers | Verdict |
|------|------|------|---------|
| `check_retry.js` | 23 | 0 (no `require`, no script entry) | Manual debug script that escaped into source root. Delete. |
| `chunked-review.js` | 577 | 0 source, 1 test | Either feature was abandoned mid-build or never wired. Verify dead-on-trunk and delete; if still wanted, move under `review/`. |

### 1.2 Delete `server/server/`

Empty nested artifact (`server/server/tests/` exists but contains nothing).
Almost certainly leftover from a botched move.

### 1.3 Eliminate `api-server.js` shim

`api-server.js` is one line: `module.exports = require('./api-server.core');`
`api-server.core.js` is 765 lines and contains the actual server. Test files
and `index.js` import via both names inconsistently.

Fix: rename `api-server.core.js` → `api-server.js`, delete the shim, rewrite
the ~16 importers to use `./api-server`.

---

## Cluster 2 — Root-vs-directory naming collisions

Multiple concepts have *both* a root-level `.js` file and a sibling directory
with the same or similar name. The files and directories are usually
**different concerns** sharing a name — confusing on sight.

| Root file | Lines | Sibling dir | Real relationship | Recommendation |
|-----------|------:|-------------|-------------------|----------------|
| `dashboard-server.js` | 1092 | `dashboard/` (route handlers, router, utils) | This file IS the dashboard's entry; routes already live in `dashboard/` | Move file → `dashboard/server.js` (or `dashboard/index.js`); update imports |
| `mcp-protocol.js` | 170 | `mcp/` (catalog, envelope, platform, registry, schemas, telemetry) | The two root mcp-* files are MCP infra that didn't make it into `mcp/` | Move both → `mcp/protocol.js`, `mcp/sse.js` |
| `mcp-sse.js` | 867 | `mcp/` (same) | (same) | (same) |
| `discovery.js` | 1129 | `discovery/` (capability/role/family classifiers) | Root file is mDNS/Bonjour LAN discovery for Ollama hosts. Different concern. | Rename → `providers/ollama-mdns-discovery.js` (or split — see §4.3). 6 importers. |
| `coordination/` | 1 file | `coord/` (8 files: cross-machine daemon) | `coordination/instance-manager.js` is unrelated to `coord/`'s daemon — but it's the only file in its dir. | Move file into `coord/` if related, or rename dir to a more descriptive name. 3 importers. |
| `tool-registry.js` | 164 | `mcp/tool-registry.js` (317 lines) | Root = cold-import metadata (deliberate split for boot speed). MCP version = MCP-namespaced registry with validation. Different concerns, identical names. | Rename root → `tool-metadata.js` (matches the cold-import header comment). Update 6 importers. |
| `tools/` (1 file: `behavioral-tags.js`) | — | `tool-defs/` (53 *-defs.js files) | Single-file dir with no obvious reason to exist | Move `tools/behavioral-tags.js` → `tool-behavioral-tags.js` at root or under `tool-defs/`; delete `tools/`. 4 importers. |

### Risk note
None of these change behavior; they are file moves + import rewrites. Each
should be one PR through the worktree workflow. Tests + perf gate validate.

---

## Cluster 3 — Phase-D refactor leftovers

### 3.1 `task-manager-delegations.js` (188 lines)

Header explicitly says "Phase D3 extraction. Pure pass-through stubs." Every
function is `function name(...args) { return module.method(...args); }`. The
finish-the-refactor move is to inline those calls at the call sites and
delete the file.

### 3.2 `database.js` (1224 lines, "LEGACY FACADE")

Header says ~87 importers and points at the DI container. Reality (today):
**84 require-sites** (~50 source, ~34 test). The migration is mid-flight,
not complete. Source-side examples that still import `database.js`:

- `factory/loop-controller.js`, `factory/factory-tick.js`,
  `factory/internal-task-submit.js`, `factory/architect-runner.js`,
  `factory/startup-reconciler.js`, `factory/worktree-auto-commit.js`,
  `factory/provider-lane-audit.js`
- `handlers/factory-handlers.js`, `handlers/automation-handlers.js`,
  `handlers/concurrency-handlers.js`, `handlers/discovery-handlers.js`,
  `handlers/managed-oauth-handlers.js`, `handlers/mcp-tools.js`,
  `handlers/provider-crud-handlers.js`, `handlers/workflow-resume-handlers.js`,
  `handlers/experiment-handlers.js`
- `db/factory-worktrees.js`, `db/factory-health.js`, `db/cron-scheduling.js`,
  `db/provider-model-scores.js`, `db/schema.js`
- `index.js`, `tools.js`, `dashboard-server.js`, `api-server.core.js`,
  `api/v2-dispatch.js`, `api/v2-core-handlers.js`, `mcp/index.js`,
  `events/event-emitter.js`, `hooks/event-dispatch.js`, `runs/replay.js`,
  `runs/build-bundle.js`, `patterns/cli.js`, `ci/watcher.js`

(The "DI migration complete" auto-memory note should be revised — see §6.)

### 3.3 `task-manager.js` (1446 lines)

Mid-decomposition. The file already pulls in 25+ sub-modules at the top.
Realistically this needs to be broken into a `tasks/` directory with
sub-files (lifecycle, dashboard-bridge, watchdog, etc.) — its own session.

---

## Cluster 4 — Conceptual layering questions (deferred)

These aren't bugs, but they're disorienting on first read. Worth a design
conversation before any rework.

### 4.1 Five execution-flavored directories

| Dir | Files | What it actually contains |
|------|------:|---------------------------|
| `actions/` | 3 | Generic state-machine action framework (`reads`/`writes`/`patch` contract) |
| `dispatch/` | 4 | Type validation + translator + executor for `actions/` |
| `execution/` | 40+ | Real task lifecycle: queue scheduler, slot pull, completion pipeline, finalizer, stall detection, restart barriers |
| `handlers/` | 60+ | RPC-style entry points for MCP tools |
| `orchestrator/` | 8 | LLM-powered "strategic brain" — prompt templates, response parser, deterministic fallbacks |

Reading the code: `actions/` + `dispatch/` + `orchestrator/` form a strategic-
brain toolkit, distinct from the `execution/` task lifecycle and the
`handlers/` RPC layer. A second-level grouping (e.g., `strategic/{actions,
dispatch,orchestrator}`) would make that obvious. But this is opinion-heavy
work — discuss before moving anything.

### 4.2 `db/` is flat with 84 files

All sibling files, no sub-grouping. Natural clusters visible:
`factory-*` (8 files), `provider-*` (8 files), `host-*` (5 files),
`schema-*` + `migrations*` (4 files), `peek-*` (3), `file-*` (5).
A single sub-directory pass would help discoverability without reshaping
APIs (the DI container exposes flat `get('taskCore')`-style names anyway).

### 4.3 `discovery.js` (mDNS Ollama) is on a wrong axis

This is provider-discovery infra — should live under `providers/` next to
the other Ollama code (`providers/ollama*.js`). The `discovery/` directory
covers a different topic (capability/role/family classifiers) and would not
collide.

---

## Cluster 5 — Runtime pollution in source tree

These are all gitignored, but they clutter the visible tree:

- 9 `.vitest-*` dirs (`.vitest-temp`, `.vitest-temp-api`, `.vitest-temp-codex`,
  `.vitest-temp-loop-async`, `.vitest-temp-os`, `.vitest-temp-plan-file`,
  `.vitest-temp-proposal-only`, `.vitest-temp-runner`, `.vitest-tmp`,
  `.vitest-logs`)
- `.tmp/`, `.cache/`, `.codex-context/`, `.codex-temp/`,
  `.torque-checkpoints/`, `tmp-peek-capture-*` (2 stale)
- `transcripts/`, `runs/`, `backups/`, `checkpoints/`,
  `task-file-write-snapshots/` — runtime data co-located with source

Fix: route runtime artifacts to a single `server/.runtime/` (or
`%LOCALAPPDATA%/torque/`) so they don't fan out at the source root. Test
caches similarly — one `server/.test-cache/` parent.

This is purely cosmetic but it's the single biggest contributor to the
"stuff everywhere" feeling.

---

## Cluster 6 — Documentation drift

Auto-memory file `project_di_migration_complete.md` claims "100% source files
on `defaultContainer.get('db')`". Counted reality: 84 `require('database')`
sites (~50 source). The legacy facade is still load-bearing — that memory
should be revised so future sessions don't make wrong assumptions about
what's safe to delete.

---

## Recommended sequence

| # | Cluster | Risk | Time | Why first |
|---|---------|------|------|-----------|
| 1 | §1 Trivial cleanups + shim removal | Low | ~30 min | Mechanical, exercises worktree flow, immediately visible win |
| 2 | §2 Naming-collision moves | Low-medium | ~1–2 hr | Each move is independent, can split into N PRs |
| 3 | §5 Runtime pollution consolidation | Low | ~1 hr | Cosmetic but kills the "junk drawer" appearance |
| 4 | §3.1 Drop `task-manager-delegations.js` | Medium | ~1 hr | Finishes a stalled refactor; well-bounded |
| 5 | §3.2 Continue DB-facade migration | Medium-high | Multi-session | Audit + revise memory note + migrate 50 source importers |
| 6 | §4 Layering discussion | Discussion | — | Opinion-heavy; needs design alignment before any move |
| 7 | §3.3 Decompose `task-manager.js` | High | Multi-session | Largest file, most coupling; defer until §3.2 lands |

---

## Files referenced

Counts and line numbers as of 2026-05-04 on `main`. Re-run before acting on
any cluster — concurrent sessions move fast in this repo.
