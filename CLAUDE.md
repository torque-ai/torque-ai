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
| **snapscope** | `server/plugins/snapscope/` | `capture_screenshots`, `capture_view`, `capture_views`, `validate_manifest`, `peek_ui`, `peek_diagnose` |
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

TORQUE exposes ~200 MCP tools organized into categories. Key categories:

| Category | Tools |
|----------|-------|
| **Core** | `ping`, `restart_server`, `await_restart`, `unlock_all_tools`, `unlock_tier` |
| **Hashline** | `hashline_read`, `hashline_edit` |
| **Task Submission** | `smart_submit_task`, `submit_task`, `submit_chunked_review`, `test_routing` |
| **Task Management** | `list_tasks`, `task_info`, `cancel_task`, `check_notifications`, `subscribe_task_events`, `await_task` |
| **Workflows** | `create_workflow`, `add_workflow_task`, `run_workflow`, `workflow_status`, `list_workflows`, `await_workflow` |
| **Automation** | `set_project_defaults`, `get_project_defaults`, `configure_stall_detection`, `auto_verify_and_fix`, `generate_test_tasks`, `get_batch_summary`, `generate_feature_tasks`, `run_batch`, `detect_file_conflicts`, `auto_commit_batch`, `configure_quota_auto_scale` |
| **TypeScript Tools** | `add_ts_interface_members`, `inject_class_dependency`, `add_ts_union_members`, `inject_method_calls`, `normalize_interface_formatting`, `add_ts_enum_members`, `add_ts_method_to_class`, `replace_ts_method_body`, `add_import_statement` |
| **Orchestrator/Strategic** | `strategic_decompose`, `strategic_diagnose`, `strategic_review`, `strategic_usage`, `strategic_benchmark` |
| **Strategic Config** | `strategic_config_get`, `strategic_config_set`, `strategic_config_templates`, `strategic_config_apply_template` |
| **Intelligence** | `predict_failure`, `intelligence_dashboard`, `log_intelligence_outcome`, `export_metrics_prometheus`, `cache_stats`, `database_stats` |
| **Experiments** | `submit_ab_test`, `compare_ab_test`, `create_experiment`, `experiment_status`, `conclude_experiment` |
| **Circuit Breaker** | `get_circuit_breaker_status` |
| **Provider Scoring** | `get_provider_scores` |
| **Symbol Indexer** | `search_symbols`, `get_file_outline`, `index_project` |
| **Routing Templates** | `list_routing_templates`, `get_routing_template`, `set_routing_template`, `delete_routing_template`, `activate_routing_template`, `get_active_routing` |
| **Competitive Features** | `get_tool_schema`, `polish_task_description`, `get_symbol_source` |
| **Templates** | `get_project_template`, `list_project_templates`, `detect_project_type` |
| **Diffusion/Scouts** | `submit_scout`, `create_diffusion_plan`, `diffusion_status` |
| **Comparison** | `compare_providers` |
| **Baselines** | `capture_file_baselines`, `compare_file_baseline`, `list_rollbacks`, `list_backups`, `restore_backup`, `capture_test_baseline`, `capture_config_baselines`, `perform_auto_rollback`, `get_auto_rollback_history` |
| **Approval** | `reject_task`, `approve_diff`, `check_approval_gate` |
| **Governance** | `get_governance_rules`, `set_governance_rule_mode`, `toggle_governance_rule` |
| **Policy** | `list_policies`, `get_policy`, `set_policy_mode`, `evaluate_policies`, `list_policy_evaluations`, `override_policy_decision` |
| **Evidence/Risk** | `get_file_risk`, `get_task_risk_summary`, `set_file_risk_override`, `get_high_risk_files`, `get_verification_checks`, `get_verification_summary`, `get_adversarial_reviews`, `request_adversarial_review` |
| **CI** | `await_ci_run`, `watch_ci_repo`, `stop_ci_watch`, `ci_run_status`, `diagnose_ci_failure`, `list_ci_runs`, `configure_ci_provider` |
| **Concurrency** | `get_concurrency_limits`, `set_concurrency_limit` |
| **Discovery** | `discover_models`, `list_models`, `assign_model_role`, `discover_agents` |
| **Model Approval** | `list_pending_models`, `approve_model`, `deny_model`, `bulk_approve_models`, `configure_model_roles`, `list_model_roles` |
| **Workstations** | `list_workstations`, `add_workstation` |
| **Audit** | `audit_codebase`, `list_audit_runs`, `get_audit_findings`, `update_audit_finding`, `get_audit_run_summary`, `get_audit_log`, `export_audit_report`, `configure_audit` |
| **Integration** | `full_project_audit`, `scan_project`, `task_changes`, `rollback_file`, `stash_changes`, `list_rollback_points`, `success_rates`, `compare_performance` |
| **Advanced** | Scheduling (`create_cron_schedule`, `list_schedules`, `toggle_schedule`, `create_one_time_schedule`), Resources (`get_resource_usage`, `set_resource_limits`, `resource_report`), Artifacts (`store_artifact`, `list_artifacts`, `get_artifact`, `delete_artifact`), Debug (`set_breakpoint`, `list_breakpoints`, `clear_breakpoint`, `step_execution`, `inspect_state`), Cache (`cache_task_result`, `lookup_cache`, `invalidate_cache`, `configure_cache`, `warm_cache`), Priority (`compute_priority`, `get_priority_queue`, `configure_priority_weights`, `explain_priority`, `boost_priority`) |
| **Context** | `get_context` |
| **Budget** | `get_budget_status` |

### TORQUE Automation Tools

- **`set_project_defaults`**: Configure default provider, model, verification, privacy, review, and remote-test behavior for a project.
  **Full `set_project_defaults` parameters:**
  | Parameter | Type | Description |
  |-----------|------|-------------|
  | `working_directory` | string | Project directory (required) |
  | `provider` | string | Default provider (codex, claude-cli, ollama, etc.) |
  | `model` | string | Default model for this project |
  | `verify_command` | string | Post-task verify command (e.g., "npx tsc --noEmit && npx vitest run") |
  | `auto_fix` | boolean | Auto-fix type errors after task completion |
  | `test_pattern` | string | Test file suffix pattern (default: ".test.ts") |
  | `verification_ledger` | boolean | Enable structured verification ledger (default: false) |
  | `verification_ledger_retention_days` | number | Retention period for verification ledger in days (default: 90) |
  | `adversarial_review` | string | Adversarial review trigger mode: off, auto, always (default: off) |
  | `adversarial_review_chain` | array | Provider chain for adversarial reviews |
  | `adversarial_review_mode` | string | async or blocking (default: async) |
  | `adversarial_review_timeout_seconds` | number | Timeout for blocking mode reviews (default: 300) |
  | `step_providers` | object | Default per-step provider routing for feature workflows |
  | `pii_guard` | object | PII guard config: enabled, builtin_categories, custom_patterns |
  | `remote_agent_id` | string | Remote agent ID for test execution |
  | `remote_project_path` | string | Project path on the remote agent |
  | `prefer_remote_tests` | boolean | Route verify/test commands to remote agent |
- **`get_project_defaults`**: Return the current default settings for a project, including provider, model, verification, and automation configuration.

Use `get_tool_schema { tool_name: "<name>" }` for full parameter details on any tool.

## Multi-Host Setup

TORQUE distributes tasks across multiple Ollama hosts on the LAN.

### Adding a Remote Host

Use `add_ollama_host` to register a new machine:

```
add_ollama_host { name: "NewHost", url: "http://192.168.1.x:11434" }
```

### Network Prerequisites

On the remote machine:
1. Install and start Ollama
2. Bind to all interfaces: `OLLAMA_HOST=0.0.0.0:11434 ollama serve`
3. Ensure firewall allows inbound TCP on port `11434`

### Verification

- `check_ollama_health` — checks connectivity to all hosts
- `list_ollama_hosts` — shows status, models, and health of each host

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
