# TORQUE - Threaded Orchestration Router for Queued Unit Execution

> **HARD-STOP RULE — NEVER edit `torque-public` main directly.** All work — features, fixes, docs, config, one-line typos — goes through a feature worktree. A `PreToolUse` hook (`.claude/hooks/block-main-edit.js`) blocks `Edit`/`Write`/`NotebookEdit` when CWD's git common-dir equals its git-dir on the `torque-public` repo. To start work: `scripts/worktree-create.sh <feature-name>` and open `.worktrees/feat-<name>/` in Claude Code. Emergency hotfix override: `TORQUE_ALLOW_MAIN_EDIT=1` in env. See "Version Control — Worktree Workflow" for the full lifecycle.

## Setup

TORQUE requires two things to work in Claude Code:

1. **MCP server** — auto-configured on first startup (~48 core tools unlocked by default; ~750 total via progressive unlock)
2. **Slash commands** — located in `.claude/commands/` (provides the `/torque-*` commands)

Slash commands are auto-discovered from `.claude/commands/`. In local mode, the TORQUE server auto-injects the keyless streamable-HTTP MCP endpoint `http://127.0.0.1:3458/mcp` into your global `~/.claude/.mcp.json` when it starts — no manual configuration needed. The legacy SSE endpoint at `http://127.0.0.1:3458/sse` is still served as a fallback for older MCP clients.

**Manual setup (optional):** If auto-injection doesn't work, copy `.mcp.json.example` to `.mcp.json` — it ships both the primary (`/mcp`, type `streamable-http`) and legacy (`/sse`, type `sse`) entries.

### Local Mode (default)

TORQUE runs in **local mode** by default. No authentication layer — the server binds to `127.0.0.1` only.

**First-time setup:**
1. Start TORQUE — MCP config is auto-injected into `~/.claude/.mcp.json`
2. Open any Claude Code session — TORQUE tools are available immediately

### Enterprise Mode (optional plugin)

For multi-user or network-accessible deployments, set `TORQUE_AUTH_MODE=enterprise` and restart TORQUE. The loader installs the `auth` plugin from `server/plugins/auth/`.

### Plugins

TORQUE supports optional plugins in `server/plugins/`. `server/plugins/plugin-contract.js` validates the plugin contract, and `server/plugins/loader.js` resolves plugins from `server/plugins/<name>/index.js` at startup.

The current plugin contract includes `name`, `version`, `install`, `uninstall`, `middleware`, `mcpTools`, `eventHandlers`, and `configSchema`.

## Version Control — Worktree Workflow

All feature work MUST use a git worktree. TORQUE runs from main — never develop directly on main.

This is a durable operating rule for Claude, Codex, and any future agent session in this repository. If the work fixes or changes TORQUE itself, start in a feature worktree, merge back intentionally, and use the restart-barrier path for any runtime/server restart. Do not make TORQUE code changes directly in the main worktree just because they are small.

### Creating a Feature Worktree

    scripts/worktree-create.sh <feature-name> [--install|--no-install]

This creates a worktree at `.worktrees/feat-<name>/` on branch `feat/<name>`. Open that directory in Claude Code to develop the feature. **Dependencies are installed by default** (npm install in `server/` and `dashboard/` when each has `package.json`) so the worktree is immediately usable for tests and builds. Pass `--no-install` only for docs-only worktrees where creation cost matters more than test-readiness.

### During Development

- All commits go to the feature branch in the worktree
- TORQUE continues running from main undisturbed
- Run tests via `torque-remote` from the worktree directory
- The pre-commit hook blocks direct commits to main while worktrees exist

### Cutting Over to New Code

    scripts/worktree-cutover.sh <feature-name>

This merges the feature branch to main, triggers TORQUE queue drain (waits for running tasks to complete), restarts TORQUE on the new code, and cleans up the worktree.

For docs-only changes that do not affect the running server, merge the worktree deliberately and state that no restart barrier is required. For server code, dashboard runtime, configuration, provider, scheduler, queue, MCP, REST, plugin, or process-lifecycle changes, use `scripts/worktree-cutover.sh <feature-name>` or an equivalent explicit merge followed by `restart_server` / `await_restart`; external process termination is reserved for an unresponsive MCP layer with explicit user approval.

Restart barriers are allowed to take a while. Some Codex/factory tasks normally run 30-60 minutes, so `await_restart` may need to hold the barrier until those tasks finish. Keep watching heartbeat/status output and do not cancel, bypass, or treat the barrier as stuck unless task status shows a real stall or the user approves an emergency override.

Operations that mutate shared main/worktree state must also hold the repo coordination lease from `scripts/repo-coordination-lock.sh`. The standard paths already do this for main pre-push gates, worktree cutovers, and apply-mode merged-worktree pruning. Use that helper, or a script that wraps it, before adding new automation that changes main refs, staging refs, or git worktree metadata.

### Emergency Hotfixes

For critical fixes that can't wait for the worktree workflow:

    git commit --no-verify  # bypasses the worktree guard

Document the bypass in the commit message.

## Quick Start

Use the `/torque-*` commands to interact with TORQUE. Commands compose multiple tools automatically — you rarely need to call raw MCP tools directly.

## Commands

| Command | Purpose |
|---------|---------|
| `/torque-submit [task]` | Submit work — auto-routes provider, captures baselines, configures retry |
| `/torque-status [filter]` | Queue overview — running, queued, failed, hosts, or specific task |
| `/torque-review [task-id]` | Review output — validate, quality score, build check, approve/reject |
| `/torque-workflow [name]` | DAG pipelines — create, add tasks, monitor |
| `/torque-budget` | Cost tracking, budget status, provider performance |
| `/torque-config [setting]` | Configuration — tuning, hardware, safeguards |
| `/torque-cancel [task-id]` | Cancel running or queued tasks |
| `/torque-ci` | CI monitoring — watch repos, diagnose failures, view history |
| `/torque-hosts` | Manage Ollama hosts — add, remove, enable, disable, health checks |
| `/torque-restart` | Restart the MCP server to apply code changes |
| `/torque-recovery-inbox` | Triage rejected work items that exhausted auto-recovery |
| `/torque-schedule` | List, pause, resume, create, and delete scheduled tasks |
| `/torque-scout [variant]` | Spawn discovery scouts — security, quality, visual, performance |
| `/torque-sweep` | Full automated sweep — deploy all scouts, auto-triage, spawn team to fix |
| `/torque-team [brief]` | Spawn development team — Planner, QC, Remediation pipeline |
| `/torque-templates` | View, activate, and manage routing templates |
| `/torque-validate` | Run code quality validation — syntax, build checks, regression detection |
| `/torque-visual-sweep` | Deep visual audit — discovery, capture, analysis fleet for one app |

For advanced/direct MCP tool access, use the raw tool names (e.g., `smart_submit_task`).

## Providers

TORQUE routes between **14 execution providers**. Smart routing picks the best one automatically - you rarely need to choose manually.

### Local (Ollama)

Run on your local Ollama instance or registered LAN hosts. Free, private, no API keys needed.

| Provider | Edit Format | Best For |
|----------|------------|----------|
| **ollama** | Raw prompt -> text response | General prompts, documentation, lightweight local edits |

### Cloud (Subscription CLI Tools)

| Provider | Requirement | Best For |
|----------|------------|----------|
| **codex** | Codex CLI installed + authenticated | Greenfield code, complex multi-file tasks |
| **codex-spark** | Codex CLI installed + authenticated | Fast single-file edits (gpt-5.3-codex-spark model) |
| **claude-cli** | Claude Code CLI installed + authenticated | Architectural decisions, complex debugging (raw CLI subprocess) |
| **claude-code-sdk** | Claude Code installed + authenticated | SDK-based agentic loop with structured streaming, session store, permission modes (`auto` / `acceptEdits` / `plan` / `bypassPermissions`), and skills loading. Default model `claude-sonnet-4-20250514` |

### Local (CLI-harness)

| Provider | Requirement | Best For |
|----------|------------|----------|
| **claude-ollama** | `ollama` + `claude` CLIs, local Ollama host | Local models with Claude Code tool loop |

### Cloud (API — Bring Your Own Key)

Call cloud LLM APIs directly using your API keys. Start disabled — set your key and enable with `configure_provider`.

| Provider | API Key Env Var | Best For |
|----------|----------------|----------|
| **anthropic** | `ANTHROPIC_API_KEY` | Direct Claude API tasks |
| **deepinfra** | `DEEPINFRA_API_KEY` | High-concurrency batch work (200 concurrent/model) |
| **hyperbolic** | `HYPERBOLIC_API_KEY` | Large models (70B-405B), fast output |
| **groq** | `GROQ_API_KEY` | Low-latency general tasks |
| **cerebras** | `CEREBRAS_API_KEY` | Fast inference |
| **google-ai** | `GOOGLE_AI_API_KEY` | Large context (800K+ tokens) |
| **openrouter** | `OPENROUTER_API_KEY` | Multi-model gateway |
| **ollama-cloud** | `OLLAMA_CLOUD_API_KEY` | Remote Ollama-compatible endpoint |

To enable a cloud API provider:
1. Set the env var: `export DEEPINFRA_API_KEY=your-key`
2. Enable: `configure_provider { provider: "deepinfra", enabled: true }`

### Smart Routing

`smart_submit_task` analyzes task complexity and routes automatically:
- **Simple** (docs, comments, config) -> ollama on local host
- **Normal** (tests, single-file code) -> ollama or codex-spark
- **Normal greenfield** (new file creation) → codex
- **Complex reasoning/large code** → deepinfra or hyperbolic (large models)
- **Complex multi-file** → codex or claude-cli
- **Security/XAML/architecture** → anthropic
- **Documentation/boilerplate** → groq

### Routing Templates

Smart routing's defaults work well, but **routing templates** give you explicit control over which providers handle which task categories. Templates map 10 auto-detected task categories to provider fallback chains.

**11 presets ship in `server/routing/templates/*.json`.** Common ones:

| Template | Strategy | Best For |
|----------|----------|----------|
| **System Default** | Codex for hard problems, free cloud for rest | General development |
| **Quality First** | Codex primary for all code work | Critical features, production code |
| **Cost Saver** | Free models first, Codex as last resort | Budget-conscious development |
| **Cloud Sprint** | Cerebras primary, maximum speed | Tight deadlines, batch throughput |
| **Free Agentic** | Zero-cost providers only (no Codex) | Free-tier-only environments |
| **Free Speed** | Cerebras for lowest latency, Codex safety net | Fast iteration, quick fixes |
| **All Local** | Ollama for everything, Codex escape hatch for complex | Privacy-first, air-gapped |

See `docs/routing-templates.md` for the full 11-preset catalog, schema, and resolver precedence.

**Task categories** (auto-detected from task description):
`security`, `xaml_wpf`, `architectural`, `reasoning`, `large_code_gen`, `documentation`, `simple_generation`, `targeted_file_edit`, `plan_generation`, `default`

**Template precedence:** User override (`provider: "X"`) > per-task template > global active template > smart routing defaults.

Use `/torque-templates` to manage templates interactively.

### Context-Stuffed Free Providers

Free API providers (groq, cerebras, google-ai, openrouter) automatically receive project file contents in their prompts when the task mentions files or has a `working_directory`. At submission time, smart scan discovers imports and convention matches (test files, types). At execution time, file contents are read and prepended to the prompt with token budget enforcement.

- **Configure depth:** `context_depth` (1 or 2) in project defaults or per-task
- **Disable per-task:** `context_stuff: false`
- **Budget:** groq/cerebras/openrouter: 96K tokens; google-ai: 800K tokens. Override with `context_budget` per-task.
- **Over budget:** Task fails with actionable error suggesting google-ai or narrower scope

## Task Distribution Philosophy

TORQUE is control-tower dispatch, not freight shuffling. Provider placement must be deliberate, legible, and accountable — the runtime should always be able to explain user intent, when capacity opened, which provider executed, and why. New routing, fallback, queue, or scheduler code should be reviewable against those invariants. Full design rationale: `docs/architecture.md` "Task Distribution Philosophy".

## Fallback Behavior

If local LLM unavailable:
1. Auto-start attempts to launch Ollama (if enabled)
2. Falls back to tier-specific fallback model on alternate host
3. Falls back to `deepinfra` if enabled (high-concurrency cloud inference)
4. Falls back to `codex` or `claude-cli` if all other options exhausted
5. Auto-recovers when Ollama returns

Chains are user-configurable via `configure_fallback_chain`. Anthropic is not in any default fallback chain.

## Stall Recovery

Stall detection is user-configurable per provider via `configure_stall_detection`. No hardcoded defaults — thresholds are set in the database. Recommended values:
- **Ollama / DeepInfra / Hyperbolic**: 120-180 seconds
- **Codex**: 120-180 seconds

Stalled tasks are automatically cancelled and resubmitted with provider fallback.

## Visual Sweep

Deep visual audit for a single application via `/torque-visual-sweep <app>`. Three phases (discovery, capture, analysis) run against the project's `peek-manifest.json`; findings land in `docs/findings/<date>-visual-sweep-<app>-summary.md`. See `docs/visual-sweep.md` for the manifest schema, hook enforcement, and per-phase agent contracts.

## Quality Safeguards

Built into `/torque-submit` and `/torque-review`:
- **Baselines** — file snapshots captured before changes, compared after
- **Validation** — stub detection, empty methods, truncation, tiny files
- **Approval gates** — triggered by >50% file size decrease, validation failures
- **Build checks** — compile verification after code tasks
- **Auto-verify-retry** — runs `verify_command` after Codex/Codex-Spark task completion; auto-submits error-feedback fix task on failure (Phase 6.5 in close-handler pipeline). Enabled by default for Codex providers; opt-in for others via `auto_verify_on_completion` in `set_project_defaults`. Requires `verify_command` to be set.
- **Rollback** — undo task changes on failure
- **Adaptive retry** — auto-retry with provider fallback

### Default Plugins

TORQUE loads several plugins by default (configured in `DEFAULT_PLUGIN_NAMES` in `server/index.js`). To disable any, remove it from that list and restart.

| Plugin | Location | Provides |
|--------|----------|----------|
| **snapscope** | `server/plugins/snapscope/` | ~35 `peek_*` and `capture_*` tools for visual verification, window capture, manifest validation, semantic diff, OCR, baselines |
| **version-control** | `server/plugins/version-control/` | ~13 `vc_*` tools for worktree lifecycle, commit/PR generation, changelog, release cutting |
| **remote-agents** | `server/plugins/remote-agents/` | `register_remote_agent`, `run_remote_command`, `run_tests`, plus health checks. Registers a `TestRunnerRegistry` route so `verify_command` / tests run on the configured remote with automatic local fallback; without it the validation pipeline is local-only |
| **model-freshness** | `server/plugins/model-freshness/` | Tracks model freshness across registered Ollama hosts via a watchlist + events store, polls remote registry digests, and surfaces drift in the dashboard |
| **auto-recovery-core** | `server/plugins/auto-recovery-core/` | Classifier rules + 9 recovery strategies (retry, clean-and-retry, retry-with-fresh-session, fallback-provider, retry-plan-generation, fresh-worktree, reject-and-advance, escalate, discard-regenerable-merge-block) consumed by the auto-recovery engine |
| **codegraph** | `server/plugins/codegraph/` | Eight `cg_*` tools for symbol/reference queries (find-references, call-graph, impact-set, dead-symbols, resolve-tool, class-hierarchy) plus `cg_index_status` and `cg_reindex`. On by default — set `TORQUE_CODEGRAPH_ENABLED=0` to disable. JS/TS/TSX/Python/Go/C#/PowerShell supported. See `docs/codegraph.md`. |

## Remote Workstation

Heavy commands (builds, tests, compilation) route to the configured remote workstation automatically. Enforceable remote-execution rules are managed by the governance engine; see `Operational Governance` for the rule source of truth.

**TORQUE's own post-task verification also routes to remote.** The close-handler pipeline (Phases 6 and 6.5) automatically runs build verification, test verification, and verify_command on the remote workstation when one is configured with `test_runners` capability. No manual intervention needed — tasks completed by any provider get their verification routed to remote.

Use `torque-remote` for heavy commands when a remote workstation is configured:

    torque-remote npx vitest run path/to/test             # test remotely
    torque-remote dotnet build example-project.sln            # build remotely
    torque-remote cargo build --release                    # any heavy command

**Testing local worktree state:** Run `torque-remote` from the feature worktree directory. The remote side resets to the branch's origin ref when available, or falls back to `origin/main` / `origin/master`, overlays the local commits and dirty worktree state for that single command, then cleans back to the base ref.

`--branch <ref>` remains an explicit pushed-ref override when you want to test a ref that already exists on origin. Example:

    torque-remote --branch wip/experiment npx vitest run server/tests/foo.test.js

Without `--branch`, `torque-remote` uses the current worktree as the source of truth for the remote run.

**Path discipline for chained commands:** wrap multi-step commands in `bash -c` and use relative paths or `$TORQUE_REMOTE_PROJECT_PATH` rather than local absolute paths — full examples and env-var contract in `docs/torque-remote.md` "Path discipline for chained commands."

If the remote is unreachable or overloaded, `torque-remote` falls back to local execution automatically.

**Configuration:**
- `~/.torque-remote.json` — global config (transport, timeout, intercept list). Not in any repo.
- `~/.torque-remote.local.json` — personal SSH details (host, user, project path). Not in any repo.
- `.torque-remote.json` in project root — per-project override (optional, safe to commit).
- Configure via: `set_project_defaults { remote_agent_id: "...", remote_project_path: "...", prefer_remote_tests: true, verify_command: "..." }`

**If no remote is configured** (transport: "local" or no config), commands run locally as before.

**Lanes:** `torque-remote` supports parallel invocations on the same remote workstation via numbered lane workspaces. Default `TORQUE_REMOTE_LANE_COUNT=1` is identical to today's single-workspace behavior. Bump to `8` (or whatever) so N concurrent invocations each claim their own lane workspace and run in parallel without contention. Use `torque-remote --status` to see lane states. See `docs/torque-remote.md` for the full lane semantics (configuration, lifecycle, stale reap, migration, disk footprint).

## Testing workflow

Pre-push checks are two-tier:
- Pushes to `main` run a conservative changed-file gate. Docs-only changes skip heavy remote phases; dashboard-only changes run dashboard tests; server test-only changes run the touched server tests; server implementation, dependency, gate, remote-runner, coordinator, or unclassified changes fail closed to broader coverage. Server implementation changes still run server tests plus the perf gate and DB query audit.
- Remote phases stage HEAD on a disposable `pre-push-gate/<sha>` ref on origin so the remote workstation can sync and test the pending commits without touching `origin/main`. Dashboard and server phases run in parallel inside one `torque-remote` session, then perf runs sequentially in that same synced checkout to avoid a second remote sync while keeping perf measurements isolated from Vitest load.
- The coordinator suite name includes the gate-plan hash and `torque-remote` keys cache entries by the resolved commit SHA, not the disposable branch name. Passing reruns of the same SHA and same plan can replay; failed runs are not stored as reusable cache hits.
- Pushes to non-main branches skip tests for fast iteration. Merges to `main` still run the conservative main gate.
- Force full gate: `PRE_PUSH_FORCE_FULL=1 git push origin main` or `PRE_PUSH_GATE_MODE=full git push origin main`.
- Escape hatch: `git push --no-verify` bypasses the hook.

**Gate parallelism env vars (`scripts/pre-push-hook`, `scripts/pre-push-gate-plan.js`):**
- `TORQUE_GATE_SHARDS=N` — opt-in vitest fan-out for the server phase. Default `1` (no sharding). Set to `4` or `8` to parallelize the server suite across N shards in the same remote lane; `VITEST_MAX_WORKERS` scales per shard.
- `TORQUE_GATE_USE_CODEGRAPH` — opt-out codegraph impact-set augmenter that widens (never narrows) the affected-tests set on `affected`-mode runs. Default on. Set to `0` to disable.

Examples:

    git push origin main                    # gated: conservative changed-file main gate
    git push origin wip/experiment          # ungated: skip tests for iteration
    PRE_PUSH_FORCE_FULL=1 git push origin main  # gated: force the full main gate

When iterating on an unpushed feature branch before it lands on `main`, run `torque-remote` from that feature worktree so the remote workstation sees the exact local state you are validating.

## Task Completion Notifications

TORQUE pushes notifications through the MCP SSE transport when tasks complete or fail. **You do not need to poll `check_status` in a loop.**

- **Auto-subscribe:** `submit_task` or `smart_submit_task` auto-subscribes the session.
- **Push notifications:** Completion/failure events are pushed instantly via SSE.
- **`check_notifications`:** Retrieve and clear pending events.
- **`await_task`:** Blocks until task completes. Supports `verify_command`, `auto_commit`, `auto_push`.
- **`await_workflow`:** Same, for workflows. Wakes instantly per-task via event bus.

### Recommended patterns

- **Single task:** Submit → `await_task` with heartbeats → review
- **Workflow:** Submit → `await_workflow` with heartbeats → review each
- **Restart recovery:** `await_task({ ..., auto_resubmit_on_restart: true })`

### Restart — Barrier Task Primitive

Restart is a first-class queue primitive, not an external process kill. `restart_server` creates a `provider: 'system'` barrier task; while that task is `queued` or `running`, the queue scheduler (`server/execution/queue-scheduler.js` and `slot-pull-scheduler.js`, via `server/execution/restart-barrier.js`) refuses to promote any other queued task. A drain watcher subscribes to terminal task events and triggers `eventBus.emitShutdown` once the non-barrier running count hits zero.

- `await_restart` is `restart_server` + `await_task` on the returned `task_id`, with heartbeats.
- The barrier is cancellable — `cancel_task` on its id lifts the gate; the queue resumes immediately.
- `cleanupStaleRestartBarriers()` runs on startup and cancels any barrier left over from a prior instance.
- **Prefer this over `stop-torque.sh` / `taskkill` / PID-file kills.** The barrier path is race-free (the queue can't admit new work between "drain cleared" and "shutdown"), auditable (restart is a row in the tasks table), and cancellable. External kills are reserved for the `worktree-cutover.sh` path and for diagnosing TORQUE itself when the MCP layer is unresponsive.

### Heartbeat check-ins

`await_task` and `await_workflow` return periodic **heartbeat** responses (default: every 5 minutes) with progress snapshots. Notable events (task started, stall warning, retry, provider fallback) trigger an immediate heartbeat.

On receiving a heartbeat: update user on progress, check alerts, re-invoke await.

## Operational Governance

Enforceable operational rules are managed by the governance engine.
View and configure rules in the dashboard under Operations > Governance,
or via MCP tools: `get_governance_rules`, `set_governance_rule_mode`, `toggle_governance_rule`.

Built-in rules: `block-visible-providers`, `inspect-before-cancel`,
`require-push-before-remote`, `no-local-tests`, `verify-diff-after-codex`.

### Judgment Policies (not machine-enforced)

These policies require Claude's judgment and cannot be reduced to rules:

- **Claude is architect + orchestrator, not batch worker** — never manually implement what TORQUE should produce (types, data, events, systems, tests, wiring). Plan, submit, verify, integrate.
- **On TORQUE failure: diagnose → fix root cause → resubmit.** Do not bypass by writing the feature work by hand. Direct manual edits are reserved for TORQUE config fixes, integration glue outside the batch, or debugging TORQUE itself.
- **Investigate before deleting unknown files** — untracked files may be work products from other sessions. Never run `git clean`.
- **Prefer hashline tools over Read/Edit** — use `hashline_read` + `hashline_edit` when available for higher edit precision.

## Project Versioning

TORQUE supports automated semver release management per project — set `versioning_enabled = true` in `project_metadata` to opt in. When enabled, **every task, workflow, and schedule submission must include `version_intent`** (`feature` / `fix` / `breaking` / `internal`), and releases are cut automatically on completion. For direct edits outside TORQUE, use conventional commit prefixes (`feat:`, `fix:`, `chore:`) so the pipeline can infer intent. Full setup, bump rules, and conventional-commit integration: `docs/versioning.md`.

## MCP Tool Reference

TORQUE tools are progressively unlocked. Start with the core set, use `get_tool_schema` for signatures, and call `unlock_all_tools` to see all ~750 tools. (Canonical count: `scripts/rest-parity-audit.js` → `docs/rest-parity-gap-report.md`.)

| Category | Tools |
|----------|-------|
| **Core** | `ping`, `restart_server`, `await_restart`, `unlock_tier`, `unlock_all_tools` |
| **Task** | `submit_task`, `smart_submit_task`, `task_info`, `await_task`, `cancel_task` |
| **Workflow** | `create_workflow`, `add_workflow_task`, `run_workflow`, `workflow_status`, `await_workflow`, `get_workflow_state`, `set_workflow_state` |
| **Automation** | `set_project_defaults`, `get_project_defaults`, `scan_project`, `submit_scout`, `create_diffusion_plan` |
| **TypeScript Tools** | `add_ts_interface_members`, `add_ts_method_to_class`, `replace_ts_method_body`, `add_import_statement` |

Use `get_tool_schema { tool_name: "<name>" }` for full parameter details on any tool. Use `/torque-hosts` to register, list, or health-check Ollama hosts — TORQUE load-balances across healthy hosts automatically.

## Architecture — DI Container

`server/container.js` is the composition root. New code should resolve services via `defaultContainer.get('<name>')`, not `require('./database')` — the `npm run lint:di` rule (in `server/`) flags direct database.js imports. Modules export `createXxx` factories and register themselves in the container. Full design + migration history: `server/ARCHITECTURE.md`.

## File Safety

Unknown untracked files in `server/docs/`, `server/docs/investigations/`, or other `docs/` directories may be generated reports, audit results, or work products from other sessions. Investigate provenance before deleting them; enforceable cleanup rules are managed by the governance engine and summarized in `Operational Governance`.

## Subagent Dispatch Discipline

When dispatching subagents (via the `Agent` tool or the superpowers `subagent-driven-development` skill) for tasks in this repo, **always include a Monitor-stall bail-out clause** in the prompt. Stock superpowers/Claude prompt templates encourage agents to use `Monitor` to wait for long-running test commands; combined with the `torque-remote-guard` hook and intermittent remote-workstation availability, this routinely produces 20-minute Monitor-loop stalls where the agent burns context budget on a hung pipeline. Symptom: subagent output ends with internal-thinking leak ("Wait — `<<autonomous-loop-dynamic>>` is for /loop sessions...") and no structured report.

Append this clause verbatim to every implementer-style subagent prompt:

> **Bail-out on Monitor stall:** If you start a `Monitor` or `Bash run_in_background` watching for test/build output and the output file remains empty for >2 minutes (or the Monitor times out twice in a row), STOP. Do NOT re-arm. Report `BLOCKED` with `monitor_stall` as the reason and what command was hanging. Do not silently keep waiting; the operator needs to know immediately so they can clean up stuck SSH/processes. This rule applies even when you have `TodoWrite` tasks pending — a stalled test run is a higher-priority signal than completion percentage.

This is operator-mandated for this repo until the underlying torque-remote ↔ remote-workstation reliability issues are resolved (see `feedback_test_infra_degraded_defer_verification.md` in user memory).

## Harness Problem — Edit Discipline

The editing harness is often the bottleneck. Apply these rules consistently:

- **Always Read before Edit** — never guess at indentation, whitespace, or surrounding context.
- **Use unique anchors in `old_string`** — include 3-5 lines of surrounding context to avoid ambiguous matches.
- **Prefer Write for files under ~400 lines** — full-file rewrites are often more reliable than many small string replacements.
- **Prefer Edit for large files** — targeted replacements beat rewriting thousands of lines.
- **On edit failure, widen context** — do not retry the same `old_string`; add more surrounding lines or switch tools.
- **Separate harness failures from code failures** — "did the edit apply?" is a different question from "is the code correct?"
- **Prefer structural or semantic tools over raw content matching** when TORQUE offers them. `add_ts_method_to_class`, `inject_class_dependency`, `add_ts_interface_members`, `add_ts_union_members`, `inject_method_calls`, `normalize_interface_formatting`, and `add_ts_enum_members` are safer than raw search/replace when they fit the task.
- **Avoid retry loops** — if the same approach fails twice, change strategy.

## Process Safety — Never Kill Without Permission

- **Never kill processes (`node`, TORQUE, or otherwise) without explicit user approval.** This includes `kill`, `taskkill`, `Stop-Process`, SIGTERM, and SIGKILL.
- **TORQUE is shared infrastructure** — do not stop, restart, or shut it down to solve a task-level problem.
- **To stop a runaway task, use `cancel_task`.** To cancel a whole workflow, use `cancel_workflow`. To bulk-cancel, use `batch_cancel`.
- **If TORQUE cancellation fails, ask the user.** Do not escalate to process termination on your own.
- **Never kill `node.exe` blindly** — verify what each process is running before even asking.

## Task Safety — Inspect Before Cancel

- **Never cancel TORQUE tasks without reading their full description and checking their status first.**
- **Before cancelling any task, inspect it with `task_info`, `check_status`, or `get_result`** so you understand its description, timing, working directory, and progress.
- **"0% progress" does not mean stale** — Codex and other providers may be actively working while progress remains unchanged.
- **"No output yet" does not mean stale** — some tasks buffer output until completion.
- **Tasks from other sessions are not yours to cancel** unless the user explicitly asked for that action.
- **When in doubt, ask the user.** Cancellation is irreversible.

## Ollama Task Authoring

Ollama task descriptions are the instruction set — wording determines convergence vs. burned iterations. For files >300 lines, tell the model to use `search_files` → `read_file` (line-range) → `replace_lines` instead of full-file edits, and split multi-function refactors into separate tasks (15-iteration cap). Full prompting playbook with examples in `docs/ollama-prompting.md`.

## TORQUE Best Practices

- **Run `scan_project` before planning a batch** — it exposes file sizes, missing tests, TODOs, and dependency context at zero LLM cost.
- **Use Codex or Codex-Spark for most code generation and precision edits.** Use DeepInfra or Hyperbolic when you need large-model reasoning or high-concurrency open-weight execution.
- **Use `create_feature_workflow` for standard feature pipelines** and `create_workflow` plus `add_workflow_task` when the dependency graph is non-standard.
- **Use `run_batch` when you want one-shot orchestration** from feature-task generation through workflow creation and execution.
- **Verify on the real filesystem after Codex completes.** Prefer `await_task` or `await_workflow` with `verify_command` over manual spot checks.
- **Parallelize independent tasks** — tests, fixture generation, and unrelated edits should run as separate nodes whenever their write sets do not conflict.
- **Use `step_providers` deliberately** — keep simple steps local and route complex reasoning or test-generation steps to cloud providers when they are enabled.

## More Tools

Beyond the core surface above, useful additions discoverable via `get_tool_schema { tool_name }`:

- **Automation / batch:** `configure_stall_detection`, `auto_verify_and_fix`, `generate_test_tasks`, `get_batch_summary`, `generate_feature_tasks`, `run_batch`, `detect_file_conflicts`, `auto_commit_batch`.
- **Universal TypeScript:** `inject_class_dependency`, `add_ts_union_members`, `inject_method_calls`, `normalize_interface_formatting`, `add_ts_enum_members` (in addition to the four TS tools in the table above). Prefer these over raw search/replace when they fit — they use AST anchors, not content matching.

Call `unlock_all_tools` to see all ~750.

## Cloud Inference Notes

For open-weight cloud inference at scale, see `docs/cloud-inference.md` — covers DeepInfra and Hyperbolic concurrency limits, default models, pricing, and the `step_providers` pattern for routing simple stages to local Ollama and reasoning/test stages to a cloud specialist.

## TORQUE Team Pipeline

When work should go through the team pipeline, use `/torque-team <work brief>`. The pipeline handles planning, execution, monitoring, QC, remediation, and conditional UI review.

### Pipeline Topology

    Planner -> QC (await + review + test) -> Orchestrator (you)
                     |
                     v
                Remediation -> QC (re-review)
                     |
                     v
                UI Reviewer -> Orchestrator (conditional)

### Orchestrator Responsibilities

You are the Orchestrator. Your responsibilities:

- **Triage** — read scout findings, separate actionable work from ambiguity, and take unclear items back to the user before spawning execution.
- **Spawn** — use `/torque-team` for execution; use `/torque-scout` or separate scout work when discovery is still needed.
- **Monitor** — watch QC heartbeats and completion reports instead of manually polling worker state.
- **Commit** — after QC approval and passing integration verification, commit with conventional commit messages and `version_intent` where required.
- **Document** — update `CLAUDE.md` or `README` when project conventions change. Do not hand-edit `CHANGELOG.md`; TORQUE release automation owns it.
- **Shutdown carefully** — when winding down the team, nudge potentially idle agents with a plain-text message before sending structured shutdown requests so they reliably process the shutdown.

### Pipeline Internals

Streaming protocol (Planner → QC per-task, no batching), `ui_review` metadata contract for the conditional UI Reviewer, QC's dual-pass testing model (per-task + integration), and the scout-driven Discovery Phase all live in `docs/team-pipeline.md`. Use `/torque-sweep` when you want the full scout set + auto-triage + team handoff in one command.

### When Not to Use the Team Pipeline

- Use direct task submission for a single quick fix.
- Edit TORQUE config directly when the task is about TORQUE itself.
- Debug TORQUE directly when the system cannot safely fix itself from inside the pipeline.

## Visual Verification — `peek_ui`

- **Use `peek_ui` or `peek_diagnose` to visually verify UI work** after layout changes, styling changes, bug fixes, new flows, or TORQUE task output that touches UI.
- **Do not trust code changes blindly** — look at the rendered result.
- **Capture by `process` or `title`** so the verification target is explicit. Use `list_windows` when you need to discover what is running.
- **Prefer window-targeted capture over blind desktop capture** so the result stays stable and actionable.

## Factory Auto-Pilot

The software factory runs autonomously when configured. Start with `start_factory_loop { project: "<name>", auto_advance: true }`. Enable continuous cycling with `set_factory_trust_level { trust_level: "dark", config: { loop: { auto_continue: true } } }`.

Operator tools: `reset_factory_loop`, `terminate_factory_loop_instance`, `retry_factory_verify`, `approve_factory_gate` / `reject_factory_gate`.

When a loop is stuck, query decisions first: `GET /api/v2/factory/projects/<id>/decisions?limit=50`. The action name identifies which safety net fired.

Full factory runbook — auto-advance/tick/startup-resume, auto-ship detection, worktree lifecycle, plan intake dedup, and the complete auto-recovery decision action table — lives in `docs/factory.md`.

When adding a recovery rule, classification, or strategy, consult `docs/recovery-decisions.md` first — it is the canonical reference for the three recovery subsystems (auto-recovery engine, replan/rejected sweeps, execution-layer retry/fallback) and tells you which subsystem your change belongs in.

When changing the factory loop's state machine — adding a state, a transition, a new pause variant, or a new `factory_decisions` action — consult `docs/factory-loop-states.md` first. It is the canonical reference for the 10 declared states + the pseudo-states the implementation uses (`READY_FOR_<stage>`, `VERIFY_FAIL`), the pause-variant table, the transition catalog, and the decision-action emission map. Pair every new emission with a classifier rule (or add it to `isBenignFlowDecision`) — silent UNKNOWN routing is the most common bug class in the recovery-decisions audit.

When changing a factory loop **stage executor** — the SENSE / PRIORITIZE / PLAN / EXECUTE / VERIFY / LEARN bodies — consult `server/factory/stages/README.md` first. The loop-controller refactor arc (Phases 0-4, 2026-05-14/16) took `server/factory/loop-controller.js` from a 16,748-line god-object to ~7,350 lines: the stage executors now live in their own files — SENSE/PRIORITIZE/VERIFY/LEARN in `server/factory/stages/`, PLAN/EXECUTE in `server/factory/plan-execute.js` — alongside three helper-cluster modules (`server/factory/{execute-deferral,worktree-owner,plan-generation-cluster}.js`). Each is a `createXxx(deps)` factory: leaf modules are `require`d directly, but the ~24 not-yet-extracted loop-controller-internal helpers are *injected* to avoid a require cycle back into `loop-controller.js`. The README catalogs the file layout, the two stage-wiring shapes (deps-injected Step B runners for LEARN/VERIFY vs. post-hoc `derive*Outcome` mappers for PRIORITIZE/PLAN/EXECUTE), and the `StageContext` / `StageOutcome` contract (spec: `docs/factory-stage-interface.md`). `loop-controller.js` still owns `runAdvanceLoop` (the dispatcher), the lifecycle getters, and the stage-injected helpers — touching dispatch logic still means editing the controller.

When changing cancellation or cleanup paths — adding to `cancelTask`, `batch_cancel`, orphan-cleanup sweeps, worktree GC, or any setTimeout callback that resumes a task — consult `docs/cancellation-cleanup.md` first. It catalogs the 9 distinct cleanup concerns, the state-map currency they share, and the well-known retry-vs-fail race shape. Key rule for status-gated callbacks: gate on `status === 'expected_state'` (allow-list), not `status !== 'unwanted_state'` (deny-list) — the latter is how the retry-framework callback resurrected terminal-status tasks.

When changing routing templates — adding a preset, editing chains, adding/renaming categories — consult `docs/routing-templates.md` first. It catalogs the 11 presets, the 10 canonical categories, the schema, and the validator-vs-resolver coordination. Two regression tests in `tests/routing-templates.test.js` pin presets to the canonical category set and to validator-passes; both must stay green. Validator silently accepts extra category keys outside `CATEGORIES` — the coverage test is the only line of defense.

When changing `bin/torque-remote`, `bin/torque-remote-guard`, or `server/plugins/remote-agents/` — consult `docs/torque-remote.md` first. It catalogs the 5-layer config stack, full lifecycle of an SSH transport invocation, lock semantics + the chronic friction shape, fallback chain, concurrent-session protection layers, exit-code map, and 12 open questions/risks. Lock semantics in particular have a documented "preserve local-host-scoped reap rule" and "preserve trailing-whitespace strip" rule that two prior bugs hit; don't regress them.

When changing the subprocess-detachment path — `server/utils/subprocess-detachment.js`, `server/utils/process-exit-wrapper.js`, `server/utils/pid-liveness.js`, `spawnAndTrackProcessDetached` in `server/providers/execute-cli.js`, `tryReAdoptDetachedSubprocess` in `server/execution/startup-task-reconciler.js`, or any of the persisted columns (`subprocess_pid`, `output_log_path`, `error_log_path`, `output_log_offset`, `error_log_offset`, `last_activity_at`) — consult `docs/subprocess-detachment.md` first. It catalogs the 8 phases (A-H), all follow-on fixes, the schema additions, the end-to-end lifecycle (spawn → tail → exit-detect → re-adopt), the cancellation modes (graceful/force/abandon), the provider compatibility matrix, restart/shutdown/crash interactions, and 12 open questions/risks. Provider expansion in particular must route through `shouldUseDetachedPath()` and add a regression test for the new prompt-via-stdin shape — don't sprinkle conditionals at call sites.

When changing stall detection, the retry framework, fallback retry, or the auto-verify retry pipeline — `server/maintenance/orphan-cleanup.js` (`checkStalledTasks`, `getStallThreshold`, `PROVIDER_STALL_CONFIG_KEYS`), `server/execution/retry-framework.js` (`handleRetryLogic`), `server/execution/fallback-retry.js` (`tryStallRecovery`, `tryLocalFirstFallback`, `tryOllamaCloudFallback`, `tryHashlineTieredFallback`, `classifyError`, `getRetryDelayMs`), `server/validation/auto-verify-retry.js` (`handleAutoVerifyRetry`), or any of the stall/retry config keys (`stall_threshold_*`, `stall_recovery_max_attempts`, `auto_cancel_stalled`, `stall_recovery_enabled`, `unknown_error_retryable`, `max_task_lifetime_seconds`, `auto_verify_on_completion`, `verify_command`, `BASE_RETRY_DELAY_MS`/`MAX_RETRY_DELAY_MS`, `STALL_REQUEUE_DEBOUNCE_MS`) — consult `docs/stall-and-retry.md` first. It catalogs the four interlocking subsystems (stall detection / retry framework / fallback retry / auto-verify retry), the four execution paths (stall / non-zero exit / verify fail / host failover), the classifier matrix (always-retryable / retryable / non-retryable / heuristics / subprocess sentinels), the default per-provider fallback chains, the cross-subsystem invariants (resume-context strip-first contract, retry_scheduled status allow-list, re-queue grace refresh, independent attempt counters), the test coverage map, 12 open questions/risks, and the timeline of recently shipped fixes. Independent attempt counters in particular have a documented "stall recovery and retry framework do NOT coordinate budgets" rule that operators frequently conflate; don't add a strategy that assumes one is the canonical counter.

When changing the plugin contract, the loader, or any individual plugin (`server/plugins/plugin-contract.js`, `server/plugins/loader.js`, `server/plugins/{auth,auto-recovery-core,codegraph,model-freshness,remote-agents,snapscope,version-control}/index.js`), or `DEFAULT_PLUGIN_NAMES` in `server/index.js` — consult `docs/plugin-contract.md` first. It catalogs the 8 required + 3 optional contract methods, the loader's resolution sequence with its 3-way factory dispatch (`createPlugin` / `createSnapScopePlugin` / `createAuthPlugin`), the 4 boot-integration passes (install / middleware / mcpTools / tierTools), per-plugin lifecycle for all 7 plugins (versions, env gates, role, tier classification), the test coverage map, and 12 open questions. Two contract methods (`eventHandlers`, `configSchema`) are required by the validator but **NOT consumed by any boot pass today** — every plugin ships empty stubs to pass validation. Don't ship a new plugin that depends on those methods firing at boot; subscribe to events directly inside `install()` via the container's eventBus, same pattern as the existing 7 plugins.

---
*Full safeguard documentation: see `docs/safeguards.md`*
