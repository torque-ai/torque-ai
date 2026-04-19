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

**Testing uncommitted branches:** Use `--branch <ref>` to sync and run against a non-main branch on the remote. Example:

    torque-remote --branch wip/experiment npx vitest run server/tests/foo.test.js

Without `--branch`, `torque-remote` syncs the current local branch (or falls back to `origin/main` for detached HEAD).

If the remote is unreachable or overloaded, `torque-remote` falls back to local execution automatically.

**Configuration:**
- `~/.torque-remote.json` — global config (transport, timeout, intercept list). Not in any repo.
- `~/.torque-remote.local.json` — personal SSH details (host, user, project path). Not in any repo.
- `.torque-remote.json` in project root — per-project override (optional, safe to commit).
- Configure via: `set_project_defaults { remote_agent_id: "...", remote_project_path: "...", prefer_remote_tests: true, verify_command: "..." }`

**If no remote is configured** (transport: "local" or no config), commands run locally as before.

## Testing workflow

Pre-push checks are two-tier:
- Pushes to `main` run the full dashboard + remote server test suite and roll back on failure.
- Pushes to non-main branches skip tests for fast iteration. Merges to `main` still run the full gate.
- Escape hatch: `git push --no-verify` bypasses the hook.

Examples:

    git push origin main                    # gated: full dashboard + remote server suite
    git push origin wip/experiment          # ungated: skip tests for iteration

When iterating on an uncommitted feature branch before it lands on `main`, use `torque-remote --branch <ref>` to sync that branch state and run targeted remote tests.

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

## TORQUE Workflow Discipline

In addition to the judgment policies above:

- **Claude's role is architect + orchestrator** — plan, submit, verify, integrate, and resolve conflicts instead of manually producing TORQUE-owned batch work.
- **On TORQUE failure: diagnose, fix the root cause, and resubmit** — do not bypass the workflow by writing the requested feature work by hand.
- **Direct manual edits are reserved for TORQUE config fixes, integration glue outside the batch scope, or debugging TORQUE itself.**

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

When submitting work to Ollama, the task description is the instruction set. The wording determines whether the task converges or burns iterations.

**For files under ~300 lines:** simple instructions usually work, for example: "In file X, change Y to Z."

**For files over ~300 lines:**

- Tell the model to use `search_files` first to find the relevant line numbers.
- Tell it to use `read_file` with `start_line` and `end_line` to read only the relevant section.
- Tell it to use `replace_lines` instead of `edit_file` for the actual change.
- Include approximate line numbers when you know them. "Around line 450" is more reliable than a bare symbol search in very large files.
- For multiple edits in a large file, list each edit with function or class names and line numbers.
- Split multi-function refactors into separate tasks. Ollama is more reliable when each task owns one function or one file-sized unit of change.

**General rules:**

- Include exact file paths.
- Be specific: "add X after Y" is better than "improve the code."
- For files over ~500 lines, prefer one file per task.
- End with "After making the edits, stop." to prevent unnecessary verification loops.

## TORQUE Best Practices

- **Run `scan_project` before planning a batch** — it exposes file sizes, missing tests, TODOs, and dependency context at zero LLM cost.
- **Use Codex or Codex-Spark for most code generation and precision edits.** Use DeepInfra or Hyperbolic when you need large-model reasoning or high-concurrency open-weight execution.
- **Use `create_feature_workflow` for standard feature pipelines** and `create_workflow` plus `add_workflow_task` when the dependency graph is non-standard.
- **Use `run_batch` when you want one-shot orchestration** from feature-task generation through workflow creation and execution.
- **Verify on the real filesystem after Codex completes.** Prefer `await_task` or `await_workflow` with `verify_command` over manual spot checks.
- **Parallelize independent tasks** — tests, fixture generation, and unrelated edits should run as separate nodes whenever their write sets do not conflict.
- **Use `step_providers` deliberately** — keep simple steps local and route complex reasoning or test-generation steps to cloud providers when they are enabled.

## Additional TORQUE Automation Tools

- **`configure_stall_detection`** — sets provider-specific stall thresholds and optional auto-resubmit behavior.
- **`auto_verify_and_fix`** — runs the project's verification command, detects failures, and can auto-submit fix tasks instead of requiring a manual verify-fix loop.
- **`generate_test_tasks`** — scans for untested files and generates targeted test-writing tasks that can be submitted directly or added to workflows.
- **`get_batch_summary`** — produces a workflow completion summary including changed files, durations, and test counts.

## TORQUE Advanced Orchestration Tools

- **`generate_feature_tasks`** — generates the standard feature task set from a feature name and spec using existing project files as context.
- **`run_batch`** — generates feature tasks and test tasks, creates the workflow, and starts execution in one call.
- **`detect_file_conflicts`** — checks whether multiple completed tasks touched the same files before you verify or commit.
- **`auto_commit_batch`** — performs verification, commit generation, and optional push using the project's configured defaults.

## Additional TORQUE Universal TypeScript Tools

- **`inject_class_dependency`** — injects imports, fields, initialization, and access patterns into an existing class with anchored placement.
- **`add_ts_union_members`** — adds string members to a TypeScript union without introducing duplicates.
- **`inject_method_calls`** — inserts code before a marker string in any file.
- **`normalize_interface_formatting`** — re-indents a TypeScript interface body after repeated edits.
- **`add_ts_enum_members`** — appends enum members without duplicate drift.

## Cloud Inference Notes

For open-weight cloud inference, the two specialist providers are:

| Provider | Env Var | Default Model | Concurrency | Pricing (per 1M tokens) |
|----------|---------|---------------|-------------|-------------------------|
| **deepinfra** | `DEEPINFRA_API_KEY` | `Qwen/Qwen2.5-72B-Instruct` | 200 per model | $0.13-$1.00 input |
| **hyperbolic** | `HYPERBOLIC_API_KEY` | `Qwen/Qwen2.5-72B-Instruct` | 120 req/min on Pro | $0.40-$4.00 input |

Both providers use OpenAI-compatible APIs and start disabled until their API keys are configured. A common pattern is to keep simple steps on local providers and route system or test-heavy steps with `step_providers`, for example:

    step_providers: { types: "ollama", events: "ollama", data: "ollama", system: "deepinfra", tests: "deepinfra", wire: "ollama" }

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

### Streaming Protocol

- Planner sends task IDs to QC as tasks are submitted.
- QC awaits each task individually, reviews it immediately on completion, and routes verdicts without batching.

### Metadata Contract

- Tasks that modify frontend, dashboard, or XAML surfaces should carry `ui_review: true`.
- Code-only tasks should carry `ui_review: false`.

### QC Dual-Pass Testing

1. **Per-task pass** — targeted verification as each task completes.
2. **Integration pass** — full-suite or integration verification after all tasks pass individually.

Integration failures go back to Remediation with the combined context.

### Discovery Phase

When the work is not yet well-defined:

1. Use `/torque-scout <variant>` to run targeted scouts such as `security`, `quality`, `visual`, `performance`, `dependency`, `test-coverage`, `documentation`, or `accessibility`.
2. Read the findings file in `docs/findings/`.
3. Triage findings with the user and mark them actionable or deferred.
4. Feed actionable items into `/torque-team`.

Use `/torque-sweep` when you want the full scout set, automatic triage, and immediate team handoff for actionable findings.

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

The software factory runs autonomously when configured. One API call starts a self-driving cycle.

### Starting the Factory

```bash
# Start with auto-advance (zero operator calls needed)
start_factory_loop { project: "torque-public", auto_advance: true }

# Or via REST
curl -X POST http://127.0.0.1:3457/api/v2/factory/projects/<id>/loop/start \
  -H "Content-Type: application/json" -d '{"auto_advance":true}'
```

### Configuration

Enable continuous cycling and dark trust (no gates) via `set_factory_trust_level`:
```
set_factory_trust_level {
  project: "torque-public",
  trust_level: "dark",
  config: { loop: { auto_continue: true } }
}
```

- **auto_advance** — server chains stage transitions automatically via setTimeout. Fires instantly on stage completion. Retries after 30s on transient failures.
- **auto_continue** — LEARN wraps back to SENSE instead of terminating, picking the next backlog item.
- **factory tick** — 5-min setInterval safety net (`server/factory/factory-tick.js`). Catches anything auto_advance missed. Starts/stops with `pause_project`/`resume_project`. Auto-starts new loops for auto_continue projects with no active instances.
- **startup resume** — on server restart, scans for active auto_continue instances and re-kicks auto_advance.

### Operator Tools

| Tool | Purpose |
|------|---------|
| `reset_factory_loop` | Clear stuck loop state, terminate instances, free stage occupancy |
| `terminate_factory_loop_instance` | Force-terminate any instance (frees stage claims + worktree cleanup) |
| `retry_factory_verify` | Resume from VERIFY_FAIL after operator fixes the issue |
| `approve_factory_gate` / `reject_factory_gate` | Gate approval for supervised/guided trust levels |

### Auto-Ship Detection

At PRIORITIZE, the shipped-detector checks if git commit subjects already match the work item's title. Items that were fixed manually in a prior session are auto-marked shipped and skipped — no wasted execution cycles.

At VERIFY_FAIL (after exhausting retries), the same check runs as a recovery path: if the work is already on main, ship it instead of stalling.

### Worktree Lifecycle

- **Creation:** auto-detects default branch (master vs main) per project
- **Stale branch:** force-deletes orphan git branches on collision (`git branch -D` + retry)
- **Stale DB rows:** reclaims active `factory_worktrees` rows from prior failed runs
- **Merge:** cleans both source worktree AND target repo before merge (handles CRLF drift)
- **Internal commits:** use `--no-verify` (PII already sanitized inline, hook would deadlock)
- **Termination:** only abandons worktrees on failure/operator-kill, not on clean LEARN completion

### Plan File Intake Dedup

Plan intake skips re-ingest when the prior work item for the same plan_path is still active (pending, in_progress, verifying). This prevents duplicate work items from factory's own checkbox ticking changing the content hash.

### Auto-Recovery Decision Actions

The factory emits named decisions for each auto-recovery path so stuck loops are diagnosable from the decision log alone. When debugging a stalled project, query the decisions endpoint first:

| Action | Stage | Triggered by | What it means |
|---|---|---|---|
| `auto_shipped_at_prioritize` | prioritize | Shipped-detector finds matching commits on main before EXECUTE starts | Item was shipped manually; loop skipped it |
| `auto_shipped_at_verify_fail` | verify | Verify fails after N retries AND shipped-detector matches on main | Loop treats it as already shipped instead of stalling |
| `auto_shipped_empty_branch` | learn | Merge fails with "no commits ahead" AND shipped-detector matches | LEARN ships instead of looping on an empty branch |
| `auto_rejected_empty_branch` | learn | Merge fails with "no commits ahead" AND shipped-detector does NOT match | LEARN rejects to prevent infinite re-entry |
| `auto_rejected_unparseable_plan` | execute | Plan parses to zero tasks (deterministic failure) | EXECUTE auto-rejects; retrying would fail the same way |
| `auto_rejected_verify_fail` | verify | Worktree remote verify FAILED after all auto-retries | Operator-visible rejection path |
| `auto_rejected_spin_loop` | execute | `>= 5` `starting` decisions for the same batch in 5 min | Safety-net detector caught an EXECUTE re-entry loop |
| `auto_rejected_plan_quality_exhausted` | plan | Plan-quality gate rejected the auto-generated plan `>= 5` times in a row | Caps the Shape-3 re-plan starvation pattern |
| `execute_exception` | execute | `executor.execute(...)` threw (submit failure, await timeout, fs ENOENT, etc.) | Pauses at EXECUTE instead of silent-retrying every 30s |
| `execution_failed_no_tasks` | execute | Live executor produced no completed and no failed tasks (and the no-tasks reason is not deterministic) | Pauses for operator; distinct from the unparseable-plan auto-reject |

When a project's loop is stuck, start with: `GET /api/v2/factory/projects/<id>/decisions?limit=50`. The action name tells you which safety net fired (or didn't).

---
*Full safeguard documentation: see `docs/safeguards.md`*
