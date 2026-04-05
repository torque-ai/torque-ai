# TORQUE - Threaded Orchestration Router for Queued Unit Execution

## Setup

TORQUE requires two things to work in Claude Code:

1. **MCP server** — auto-configured on first startup (provides ~600 tools, ~30 core + progressive unlock)
2. **Slash commands** — located in `.claude/commands/` (provides the `/torque-*` commands)

Slash commands are auto-discovered from `.claude/commands/`. In local mode, the TORQUE server auto-injects the keyless MCP SSE connection `http://127.0.0.1:3458/sse` into your global `~/.claude/.mcp.json` when it starts — no manual configuration needed.

**Manual setup (optional):** If auto-injection doesn't work, copy `.mcp.json.example` to `.mcp.json` and set the URL to `http://127.0.0.1:3458/sse`.

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

### Creating a Feature Worktree

```bash
scripts/worktree-create.sh <feature-name>
```

This creates a worktree at `.worktrees/feat-<name>/` on branch `feat/<name>`. Open that directory in Claude Code to develop the feature.

### During Development

- All commits go to the feature branch in the worktree
- TORQUE continues running from main undisturbed
- Run tests via `torque-remote` from the worktree directory
- The pre-commit hook blocks direct commits to main while worktrees exist

### Cutting Over to New Code

```bash
scripts/worktree-cutover.sh <feature-name>
```

This merges the feature branch to main, triggers TORQUE queue drain (waits for running tasks to complete), restarts TORQUE on the new code, and cleans up the worktree.

### Emergency Hotfixes

For critical fixes that can't wait for the worktree workflow:
```bash
git commit --no-verify  # bypasses the worktree guard
```
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
| `/torque-scout [variant]` | Spawn discovery scouts — security, quality, visual, performance |
| `/torque-team [brief]` | Spawn development team — Planner, QC, Remediation pipeline |
| `/torque-templates` | View, activate, and manage routing templates |
| `/torque-validate` | Run code quality validation — syntax, build checks, regression detection |
| `/torque-visual-sweep` | Deep visual audit — discovery, capture, analysis fleet for one app |

For advanced/direct MCP tool access, use the raw tool names (e.g., `smart_submit_task`).

## Providers

TORQUE routes between **12 execution providers**. Smart routing picks the best one automatically - you rarely need to choose manually.

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
| **claude-cli** | Claude Code CLI installed + authenticated | Architectural decisions, complex debugging |

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

Smart routing's defaults work well, but **routing templates** give you explicit control over which providers handle which task categories. Templates map 9 auto-detected task categories to provider fallback chains.

**Available presets:**

| Template | Strategy | Best For |
|----------|----------|----------|
| **System Default** | Codex for hard problems, free cloud for rest | General development |
| **Quality First** | Codex primary for all code work | Critical features, production code |
| **Cost Saver** | Free models first, Codex as last resort | Budget-conscious development |
| **Cloud Sprint** | Cerebras primary, maximum speed | Tight deadlines, batch throughput |
| **Free Agentic** | Zero-cost providers only (no Codex) | Free-tier-only environments |
| **Free Speed** | Cerebras for lowest latency, Codex safety net | Fast iteration, quick fixes |
| **All Local** | Ollama for everything, Codex escape hatch for complex | Privacy-first, air-gapped |

**Task categories** (auto-detected from task description):
`security`, `xaml_wpf`, `architectural`, `reasoning`, `large_code_gen`, `documentation`, `simple_generation`, `targeted_file_edit`, `default`

**Template precedence:** User override (`provider: "X"`) > per-task template > global active template > smart routing defaults.

Use `/torque-templates` to manage templates interactively.

### Context-Stuffed Free Providers

Free API providers (groq, cerebras, google-ai, openrouter) automatically receive project file contents in their prompts when the task mentions files or has a `working_directory`. At submission time, smart scan discovers imports and convention matches (test files, types). At execution time, file contents are read and prepended to the prompt with token budget enforcement.

- **Configure depth:** `context_depth` (1 or 2) in project defaults or per-task
- **Disable per-task:** `context_stuff: false`
- **Budget:** groq/cerebras/openrouter: 96K tokens; google-ai: 800K tokens. Override with `context_budget` per-task.
- **Over budget:** Task fails with actionable error suggesting google-ai or narrower scope

## Spirit of Task Distribution

Torque should be understood as control-tower dispatch, not simple queue draining.

A task is a claim on the right kind of intelligence under user intent, policy, provider capability, and real capacity constraints. If a user chose a provider, that choice matters. If no provider was chosen, the system should wait until a real slot opens and then make a deliberate placement. Providers are specialists with different costs, strengths, and failure modes, not anonymous worker threads.

The system should always be able to explain:

1. what the user asked for
2. what intent is authoritative
3. when a real slot opened
4. which provider actually executed
5. whether the task moved
6. why it moved
7. who or what moved it

When the runtime cannot answer those questions cleanly, it has drifted from orchestration into freight shuffling. Future routing, fallback, queue, dashboard, and workflow changes should preserve deliberate placement, legible movement, and accountable control.

## Model Tiers

All tiers are configured via `set_project_defaults` and the tier config in the database.

Models are auto-discovered from registered Ollama hosts via health checks. Use `list_ollama_hosts` to see what's available.

Override per task: `/torque-submit Write docs for... model=qwen3-coder:30b`

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

Deep visual audit for a single application. Runs on-demand or via one-time schedule.

### Usage

    /torque-visual-sweep <app>                                        # sweep all pages
    /torque-visual-sweep <app> --depth component --section dashboard  # deep dive one section
    /torque-visual-sweep <app> --schedule "11pm"                      # schedule for later

### Peek Manifest

Each project with UI declares its visual surfaces in `peek-manifest.json` at the project root. New visual surfaces are enforced by:
- **Pre-commit hook** — blocks commits with unregistered surfaces
- **TORQUE post-task hook** — flags unregistered surfaces after task completion

### Three Phases

1. **Discovery** — reads manifest, validates against live UI, detects unmanifested surfaces
2. **Capture** — navigates to each section sequentially, captures via `peek_diagnose`
3. **Analysis** — fleet of parallel Claude agents, one per section, writing findings

Findings output to `docs/findings/<date>-visual-sweep-<app>-summary.md`.

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

TORQUE loads three plugins by default (configured in `DEFAULT_PLUGIN_NAMES` in `server/index.js`):

| Plugin | Location | Tools |
|--------|----------|-------|
| **snapscope** | `server/plugins/snapscope/` | `capture_screenshots`, `capture_view`, `capture_views`, `validate_manifest`, `peek_ui`, `peek_interact`, `peek_elements`, `peek_hit_test`, `peek_regression`, `peek_launch`, `peek_discover`, `peek_open_url`, `peek_cdp`, `peek_refresh`, `peek_health_all`, `peek_build_and_open`, `register_peek_host`, `unregister_peek_host`, `list_peek_hosts`, `peek_diagnose`, `peek_semantic_diff`, `peek_wait`, `peek_action_sequence`, `peek_ocr`, `peek_color`, `peek_snapshot`, `peek_table`, `peek_summary`, `peek_assert`, `peek_recovery`, `peek_recovery_status`, `peek_onboard`, `peek_onboard_detect`, `peek_verify`, `peek_verify_run`, `peek_verify_specs`, `peek_baselines`, `peek_history` |
| **version-control** | `server/plugins/version-control/` | `vc_create_worktree`, `vc_list_worktrees`, `vc_switch_worktree`, `vc_merge_worktree`, `vc_cleanup_stale`, `vc_generate_commit`, `vc_commit_status`, `vc_get_policy`, `vc_prepare_pr`, `vc_create_pr`, `vc_generate_changelog`, `vc_update_changelog_file`, `vc_create_release` |
| **remote-agents** | `server/plugins/remote-agents/` | `register_remote_agent`, `list_remote_agents`, `get_remote_agent`, `remove_remote_agent`, `check_remote_agent_health`, `run_remote_command`, `run_tests` |

To disable a plugin, remove it from `DEFAULT_PLUGIN_NAMES` in `server/index.js` and restart.

### Remote Agent Federation (Plugin)

Remote agent registration, health checks, and distributed test routing are provided
by the `remote-agents` plugin (`server/plugins/remote-agents/`). The plugin is loaded
by default via `DEFAULT_PLUGIN_NAMES` in `server/index.js`.

**Architecture:** The core defines a `TestRunnerRegistry` (`server/test-runner-registry.js`)
that validation modules call for running verify commands and tests. By default, commands
run locally. When the remote-agents plugin loads, it registers remote-or-local routing
that checks for configured remote agents and falls back to local execution.

**To disable:** Remove `'remote-agents'` from `DEFAULT_PLUGIN_NAMES` in `server/index.js`.
The validation pipeline will fall back to local-only command execution.

## Remote Workstation

Heavy commands (builds, tests, compilation) route to the configured remote workstation automatically. Enforceable remote-execution rules are managed by the governance engine; see `Operational Governance` for the rule source of truth.

**TORQUE's own post-task verification also routes to remote.** The close-handler pipeline (Phases 6 and 6.5) automatically runs build verification, test verification, and verify_command on the remote workstation when one is configured with `test_runners` capability. No manual intervention needed — tasks completed by any provider get their verification routed to remote.

Use `torque-remote` for heavy commands when a remote workstation is configured:

    torque-remote npx vitest run path/to/test             # test remotely
    torque-remote dotnet build example-project.sln            # build remotely
    torque-remote cargo build --release                    # any heavy command

If the remote is unreachable or overloaded, `torque-remote` falls back to local execution automatically.

**Configuration:**
- `~/.torque-remote.json` — global config (transport, timeout, intercept list). Not in any repo.
- `~/.torque-remote.local.json` — personal SSH details (host, user, project path). Not in any repo.
- `.torque-remote.json` in project root — per-project override (optional, safe to commit).
- Configure via: `set_project_defaults { remote_agent_id: "...", remote_project_path: "...", prefer_remote_tests: true, verify_command: "..." }`

**If no remote is configured** (transport: "local" or no config), commands run locally as before.

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

- **Never manually implement what TORQUE should produce** -- types, data, events,
  systems, tests, and wiring are TORQUE's job. Claude should plan, submit, verify.
- **Investigate before deleting unknown files** -- untracked files may be work
  products from other sessions. Never run `git clean`.
- **Prefer hashline tools over Read/Edit** -- use `hashline_read` + `hashline_edit`
  when TORQUE is available for higher edit precision.

## Project Versioning

TORQUE supports automated semver release management per project. When versioning is enabled, releases are cut automatically on task/workflow completion.

### Enabling Versioning

Enable via `project_metadata`: `versioning_enabled = true`, `versioning_start = "1.0.0"` (default 0.1.0), `versioning_auto_push = false`.

### version_intent (Required for Versioned Projects)

Every task, workflow, and schedule submission to a versioned project **must** include `version_intent`:

| Intent | Bump | Use |
|--------|------|-----|
| `feature` | minor | New functionality |
| `fix` | patch | Bug fixes |
| `breaking` | major | Breaking changes |
| `internal` | none | Docs, refactoring, tests |

### Auto-Release

- **Workflow completion** calculates bump from accumulated intents, creates git tag + changelog
- **Standalone task completion** bumps immediately
- **Direct commits** auto-tracked via conventional commit prefix (`feat:`, `fix:`, etc.)

### For Direct Claude Changes

When editing versioned projects outside TORQUE, **always use conventional commit messages**. The completion pipeline auto-scans for untracked commits and records them with inferred intent.

## MCP Tool Reference

TORQUE tools are progressively unlocked. Start with the core set, use `get_tool_schema` for signatures, and call `unlock_all_tools` to see all ~488 tools.

| Category | Tools |
|----------|-------|
| **Core** | `ping`, `restart_server`, `await_restart`, `unlock_tier`, `unlock_all_tools` |
| **Task** | `submit_task`, `smart_submit_task`, `task_info`, `await_task`, `cancel_task` |
| **Workflow** | `create_workflow`, `add_workflow_task`, `run_workflow`, `workflow_status`, `await_workflow` |
| **Automation** | `set_project_defaults`, `get_project_defaults`, `scan_project`, `submit_scout`, `create_diffusion_plan` |
| **TypeScript Tools** | `add_ts_interface_members`, `add_ts_method_to_class`, `replace_ts_method_body`, `add_import_statement` |

### TORQUE Automation Tools

- `set_project_defaults` configures default provider, model, verification, privacy, review, and remote-test behavior for a project.
- `get_project_defaults` returns the current defaults for a project.

Use `get_tool_schema { tool_name: "<name>" }` for full parameter details on any tool.

## Multi-Host Setup

TORQUE distributes Ollama work across registered LAN hosts.

### Adding a Remote Host

Use `add_ollama_host` to register a new machine:

    add_ollama_host { name: "NewHost", url: "http://192.168.1.x:11434" }

### Load Balancing

TORQUE assigns work across healthy hosts automatically. Use `list_ollama_hosts` to inspect host status and `check_ollama_health` to verify connectivity before relying on a remote host.

## Architecture — DI Container

TORQUE uses a dependency injection container (`server/container.js`) as its composition root. Every module exports a `createXxx` factory function and is registered in the container.

### For new code

Use the container to access services instead of `require('./database')`:

```js
// OLD (legacy — do not use in new code):
const db = require('./database');
db.getTask(id);

// NEW (preferred):
const { defaultContainer } = require('./container');
const taskCore = defaultContainer.get('taskCore');
taskCore.getTask(id);
```

**DI lint rule:** `npm run lint:di` (in server/) reports files still importing database.js directly.

## File Safety

Unknown untracked files in `server/docs/`, `server/docs/investigations/`, or other `docs/` directories may be generated reports, audit results, or work products from other sessions. Investigate provenance before deleting them; enforceable cleanup rules are managed by the governance engine and summarized in `Operational Governance`.

---
*Full safeguard documentation: see `docs/safeguards.md`*
