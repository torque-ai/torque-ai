# TORQUE - Threaded Orchestration Router for Queued Unit Execution

## Setup

TORQUE requires two things to work in Claude Code:

1. **MCP server** � auto-configured on first startup (provides ~560 tools, 22 core + progressive unlock)
2. **Slash commands** � located in `.claude/commands/` (provides the `/torque-*` commands)

Slash commands are auto-discovered from `.claude/commands/`. In local mode, the TORQUE server auto-injects the keyless MCP SSE connection `http://127.0.0.1:3458/sse` into your global `~/.claude/.mcp.json` when it starts � no manual configuration needed.

**Manual setup (optional):** If auto-injection doesn't work, copy `.mcp.json.example` to `.mcp.json` and set the URL to `http://127.0.0.1:3458/sse`.

### Local Mode (default)

TORQUE runs in **local mode** by default. There is no authentication layer: no API keys, no login, and no user setup. The server binds to `127.0.0.1` only, so REST and SSE connections are accepted from the local machine only.

**First-time setup:**
1. Start TORQUE � MCP config is auto-injected into `~/.claude/.mcp.json`
2. Open any Claude Code session � TORQUE tools are available immediately

No API keys, no login, and no local auth configuration needed.

### Enterprise Mode (optional plugin)

For multi-user or network-accessible deployments, set `TORQUE_AUTH_MODE=enterprise` and restart TORQUE. On startup, `server/plugins/loader.js` loads the auth plugin from `server/plugins/auth/`.

**To enable:**
1. Set `TORQUE_AUTH_MODE=enterprise`
2. Restart TORQUE
3. The loader installs the `auth` plugin from `server/plugins/auth/`
4. On first enterprise startup, a bootstrap admin API key is created if no keys exist

The auth plugin provides API key management (HMAC-SHA-256), user/password auth (bcrypt), role-based access control, session management, SSE ticket exchange, and rate limiting.

### Plugins

TORQUE supports optional plugins in `server/plugins/`. `server/plugins/plugin-contract.js` validates the plugin contract, and `server/plugins/loader.js` resolves plugins from `server/plugins/<name>/index.js` at startup.

The current plugin contract includes `name`, `version`, `install`, `uninstall`, `middleware`, `mcpTools`, `eventHandlers`, and `configSchema`.

To enable enterprise auth, set `TORQUE_AUTH_MODE=enterprise` and restart. The loader will add the `auth` plugin from `server/plugins/auth/`.

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

Use the `/torque-*` commands to interact with TORQUE. Commands compose multiple tools automatically � you rarely need to call raw MCP tools directly.

## Commands

| Command | Purpose |
|---------|---------|
| `/torque-submit [task]` | Submit work � auto-routes provider, captures baselines, configures retry |
| `/torque-status [filter]` | Queue overview � running, queued, failed, hosts, or specific task |
| `/torque-review [task-id]` | Review output � validate, quality score, build check, approve/reject |
| `/torque-workflow [name]` | DAG pipelines � create, add tasks, monitor |
| `/torque-budget` | Cost tracking, budget status, provider performance |
| `/torque-config [setting]` | Configuration � tuning, hardware, safeguards |
| `/torque-cancel [task-id]` | Cancel running or queued tasks |

For advanced/direct MCP tool access, use the raw tool names (e.g., `smart_submit_task`).

## Providers

TORQUE routes between **13 execution providers**. Smart routing picks the best one automatically � you rarely need to choose manually.

### Local (Ollama)

Run on your local Ollama instance or registered LAN hosts. Free, private, no API keys needed. Smart routing picks the edit format based on task type.

| Provider | Edit Format | Best For |
|----------|------------|----------|
| **ollama** | Raw prompt ? text response | General prompts, documentation, brainstorming |
| **hashline-ollama** | Line-hash annotated file content | Targeted single-file edits (highest precision) |

Both share the same Ollama host and GPU. Configure hosts with `add_ollama_host` or let TORQUE auto-discover.

### Cloud (Subscription CLI Tools)

Run locally but require the CLI tool installed and authenticated.

| Provider | Requirement | Best For |
|----------|------------|----------|
| **codex** | Codex CLI installed + authenticated | Greenfield code, complex multi-file tasks |
| **codex-spark** | Codex CLI installed + authenticated | Fast single-file edits (gpt-5.3-codex-spark model) |
| **claude-cli** | Claude Code CLI installed + authenticated | Architectural decisions, complex debugging |

### Cloud (API � Bring Your Own Key)

Call cloud LLM APIs directly using your API keys. Start disabled � set your key and enable with `configure_provider`.

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
- **Simple** (docs, comments, config) ? hashline-ollama on local host
- **Normal** (tests, single-file code) ? hashline-ollama
- **Normal greenfield** (new file creation) ? codex
- **Complex reasoning/large code** ? deepinfra or hyperbolic (large models)
- **Complex multi-file** ? codex or claude-cli
- **Security/XAML/architecture** ? anthropic
- **Documentation/boilerplate** ? groq

**Route XAML/WPF tasks to cloud** � local LLMs struggle with WPF semantics.

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

**How to use:**
- **Activate globally:** `activate_routing_template({ name: "Cost Saver" })` � all tasks use this template
- **Per-task override:** `smart_submit_task({ ..., routing_template: "Quality First" })` � one task only
- **Check active:** `get_active_routing()` � see current template + category mappings
- **List all:** `list_routing_templates()` � see all presets + custom templates
- **Create custom:** `set_routing_template({ name: "My Template", rules: { ... } })`

**When to activate a template:**
- Starting a new project ? activate the template matching the project's cost/quality needs
- Switching between exploration (Cost Saver) and production work (Quality First)
- Running batch workflows ? Cloud Sprint for maximum parallelism
- Budget running low ? Cost Saver or Free Agentic

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

All tiers are configured via `set_project_defaults` and the tier config in the database. Example setup with a remote Ollama host:

| Tier | Model | Temp | Context | Use Case |
|------|-------|------|---------|----------|
| **Fast** | qwen3-coder:30b | 0.2 | 16384 | Quick edits, docs, config |
| **Balanced** | qwen3-coder:30b | 0.2 | 16384 | Standard code tasks, tests |
| **Quality** | qwen3-coder:30b | 0.2 | 16384 | Complex code generation |

### Available Models

Models are auto-discovered from registered Ollama hosts via health checks. Use `list_ollama_hosts` to see what's available.

Override per task: `/torque-submit Write docs for... model=qwen3-coder:30b`

## Fallback Behavior

If local LLM unavailable:
1. Auto-start attempts to launch Ollama (if enabled)
2. Falls back to tier-specific fallback model on alternate host
3. Falls back to `deepinfra` if enabled (high-concurrency cloud inference)
4. Falls back to `codex` or `claude-cli` if all other options exhausted
5. Auto-recovers when Ollama returns

Cloud API provider fallback chains (from `server/db/provider-routing-core.js`):
- `codex` ? `claude-cli` ? `deepinfra` ? `ollama-cloud` ? `hashline-ollama` ? `ollama`
- `deepinfra` ? `ollama-cloud` ? `hyperbolic` ? `claude-cli` ? `codex` ? `hashline-ollama`
- `hyperbolic` ? `deepinfra` ? `ollama-cloud` ? `claude-cli` ? `codex` ? `hashline-ollama`

Chains are user-configurable via `configure_fallback_chain`. Anthropic is not in any default fallback chain.

## Stall Recovery

Stall detection is user-configurable per provider via `configure_stall_detection`. No hardcoded defaults � thresholds are set in the database. Recommended values:
- **Ollama / DeepInfra / Hyperbolic**: 120-180 seconds
- **Codex**: 120-180 seconds (previously 600s, but Codex tasks are fast enough for shorter thresholds)

Stalled tasks are automatically cancelled and resubmitted with provider fallback.

## Quality Safeguards

Built into `/torque-submit` and `/torque-review`:
- **Baselines** � file snapshots captured before changes, compared after
- **Validation** � stub detection, empty methods, truncation, tiny files
- **Approval gates** � triggered by >50% file size decrease, validation failures
- **Build checks** � compile verification after code tasks
- **Auto-verify-retry** � runs `verify_command` after Codex/Codex-Spark task completion; auto-submits error-feedback fix task on failure (Phase 6.5 in close-handler pipeline). Enabled by default for Codex providers; opt-in for others via `auto_verify_on_completion` in `set_project_defaults`. Requires `verify_command` to be set.
- **Rollback** � undo task changes on failure
- **Adaptive retry** � auto-retry with provider fallback

## Remote Workstation

Heavy commands (builds, tests, compilation) route to the configured remote workstation automatically. **NEVER run test or build commands directly** (`npx vitest`, `dotnet build`, `npm test`, etc.) � the guard hook will block them when a remote workstation is configured.

**TORQUE's own post-task verification also routes to remote.** The close-handler pipeline (Phases 6 and 6.5) automatically runs build verification, test verification, and verify_command on the remote workstation when one is configured with `test_runners` capability. No manual intervention needed � tasks completed by any provider get their verification routed to remote.

**Always use `torque-remote` for heavy commands:**
```
torque-remote npx vitest run path/to/test             # test remotely
torque-remote dotnet build example-project.sln            # build remotely
torque-remote cargo build --release                    # any heavy command
```

If the remote is unreachable or overloaded, `torque-remote` falls back to local execution automatically.

**Configuration:**
- `~/.torque-remote.json` � global config (transport, timeout, intercept list). Not in any repo.
- `~/.torque-remote.local.json` � personal SSH details (host, user, project path). Not in any repo.
- `.torque-remote.json` in project root � per-project override (optional, safe to commit).
- Configure via: `set_project_defaults { test_station_host: "...", test_station_user: "...", test_station_project_path: "...", verify_command: "..." }`

**If no remote is configured** (transport: "local" or no config), commands run locally as before.

## Task Completion Notifications

TORQUE pushes notifications through the MCP SSE transport when tasks complete or fail. **You do not need to poll `check_status` in a loop.**

### How it works

- **Auto-subscribe:** When you call `submit_task` or `smart_submit_task`, the session is automatically subscribed to that task's events. No extra step needed.
- **Push notifications:** When a task completes/fails, TORQUE sends a `notifications/message` log notification (visible in your output) and queues a structured event.
- **`check_notifications`:** Call this to retrieve and clear all pending task events for your session. Returns structured data (taskId, status, exitCode, duration, description).
- **`subscribe_task_events`:** Call this to subscribe to additional task IDs or change event filters (default: completed + failed). Pass `task_ids` to watch specific tasks, or omit for all tasks.
- **`await_workflow`:** Wakes instantly when tasks complete (no polling delay). Use this for workflow-based task batches.
- **`await_task`:** Blocks until a standalone task completes or fails, then returns its result. Wakes instantly via event-bus. Supports `verify_command`, `auto_commit`, `commit_message`, `auto_push`. Use this for single tasks instead of polling `check_status`.

### Recommended patterns

- **Single task:** Submit ? `await_task` (heartbeats every 5 min, wakes instantly on completion) ? review result or heartbeat ? re-invoke if heartbeat
- **Workflow:** Submit workflow ? `await_workflow` (heartbeats every 5 min, wakes instantly per task) ? review each yield/heartbeat ? re-invoke
- **Batch monitoring:** `subscribe_task_events` with no task_ids ? `check_notifications` periodically

### Do NOT

- Poll `check_status` in a loop � this wastes context tokens and adds latency
- Set short `poll_interval_ms` on `await_workflow` � the event bus wakes it instantly; the interval is only a fallback

### Heartbeat check-ins

`await_task` and `await_workflow` return periodic **heartbeat** responses (default: every 5 minutes) with progress snapshots including running tasks, elapsed time, partial output, and alerts. Notable events (task started, stall warning, retry, provider fallback) trigger an immediate heartbeat.

On receiving a heartbeat:
- Update the user on progress
- Check alerts � if stall warning, consider cancelling/resubmitting
- Re-invoke the await tool to continue waiting

Set `heartbeat_minutes: 0` to disable heartbeats (legacy behavior).

## Workflow Discipline

When TORQUE is the execution engine for a project:
- **NEVER manually implement what TORQUE should produce** � types, data, events, systems, tests, and wiring are TORQUE's job
- **Claude's role: architect + orchestrator** � plan, submit, verify, integrate, resolve conflicts
- **On TORQUE failure: diagnose ? fix root cause ? resubmit** � do NOT bypass by writing the code manually
- Only write code directly for: TORQUE config fixes, integration glue outside batch scope, or debugging TORQUE itself

## Best Practices

1. Use `/torque-submit` � it handles routing, baselines, and retry automatically
2. Use `/torque-review` after tasks complete � it runs the full validation pipeline
3. Use `/torque-budget` to monitor provider performance and costs
4. Use `/torque-config safeguards` to tune quality gates
5. Route XAML/WPF tasks to cloud providers
6. Let push notifications tell you when tasks finish � don't poll

## Multi-Host Setup

TORQUE distributes tasks across multiple Ollama hosts on the LAN.

### Example Deployment

| Host | Machine | GPU | VRAM | Priority | Max Concurrent |
|------|---------|-----|------|----------|----------------|
| **local-host** | localhost | RTX 4060 | 8 GB | 10 (primary) | 3 |
| **remote-gpu-host** | 192.0.2.100 | RTX 3090 | 24 GB | 8 | 2 |

The primary host handles fast/balanced tier tasks. The remote host handles quality tier and serves as fallback.

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

### Load Balancing

Tasks are routed to the least-loaded host that has the requested model:
1. Filter enabled hosts with status != 'down'
2. Filter to hosts that have the requested model
3. Sort by running_tasks (ascending)
4. Pick the least loaded

### Health Monitoring

TORQUE checks all enabled hosts every 60 seconds (configurable via `health_check_interval_seconds`):
- Hosts that come back online are **auto-recovered** � no manual intervention needed
- Model lists are **refreshed automatically** on each successful health check
- First check runs 15 seconds after server startup
- 3 consecutive failures ? host marked as `down`

### Verification

- `check_ollama_health` � checks connectivity to all hosts
- `list_ollama_hosts` � shows status, models, and health of each host

### Troubleshooting

- Host stuck as "down"? It will auto-recover on the next successful health check
- Models not appearing? They refresh automatically; or call `refresh_host_models` manually
- Connection refused? Verify Ollama is bound to `0.0.0.0` (not `127.0.0.1`) on the remote machine

## Distributed Development � Provider Capability Matrix

Empirically validated (2026-03-26):

| Capability | Best Provider | Notes |
|-----------|--------------|-------|
| **New file creation** | Codex | Ollama agentic can create files via write_file |
| **Small file edits** (<300 lines) | Ollama | Free, fast, reliable with edit_file or replace_lines |
| **Medium file edits** (300-500 lines) | Ollama | Use replace_lines + line-range reads (not edit_file) |
| **Large file edits** (500-1500 lines) | Ollama or Codex | Ollama works with search?read range?replace_lines workflow |
| **Huge file edits** (>1500 lines) | Codex | Ollama context may stall on full-file reads |
| **Complex multi-file tasks** | Codex | 97%+ success rate on Codex |
| **Test generation** | Codex | Ollama can write tests but Codex is more reliable |
| **Architecture/review** | Claude Code | Strategic thinking, conflict resolution |
| **Task decomposition** | Claude Code | Provider-optimal splitting |

### Ollama Task Authoring � CRITICAL

When submitting tasks to Ollama, the task description IS the instruction set. Ollama has 7 tools available: `read_file` (with start_line/end_line), `write_file`, `edit_file`, `replace_lines`, `search_files`, `list_directory`, `run_command`. How you write the task determines which tools the model uses.

**For files under ~300 lines:**
- Simple instructions work fine: "In file X, change Y to Z"
- The model will read the file and use edit_file or replace_lines

**For files over ~300 lines � you MUST instruct the workflow:**
- Tell the model to use `search_files` first to find the target line numbers
- Tell it to use `read_file` with `start_line`/`end_line` to read only the relevant section
- Tell it to use `replace_lines` (not `edit_file`) to make changes by line number
- Example: "Search for 'def handle_foo' in path/to/large_file.py, read 30 lines around it, then use replace_lines to make the change"
- **NEVER** say "read the file and edit it" for large files � the full read fills the context window and stalls inference

**General rules:**
- Include exact file paths in the task description
- Be specific about what to change � "add X after Y" not "improve the code"
- One file per task for files over 500 lines
- **Include approximate line numbers when you know them** � `search_files` can miss functions in large files. "Around line 450" is more reliable than "search for def handle_foo"
- If a task needs multiple edits in a large file, list them explicitly with function/class names AND line numbers
- **Split multi-function refactors into separate tasks** � Ollama has 15 iterations max (20 for complex). A task that modifies 3+ functions AND needs to verify/recover will run out of iterations. One function per task is more reliable.
- End task descriptions with "After making the edits, stop." to prevent unnecessary verification loops

### Codex Sandbox Safety

**Codex sandbox contamination is a systemic issue.** Codex tasks start from a potentially stale repo state. When they write files back, they can silently revert changes committed after the sandbox was created. **TORQUE now has file-level locking** � concurrent Codex tasks targeting the same file are automatically requeued to prevent overwrites.

- **ALWAYS run `git diff --stat` after Codex task completion** � check for unexpected deletions or reverts
- **If reverts detected:** `git checkout HEAD -- <reverted files>` to restore from HEAD before committing
- **Never trust Codex file writes blindly** � compare against HEAD, especially for files modified by earlier tasks in the same session

### Review Gate

Tasks flagged `needs_review: true` in metadata (complex/system tasks) require manual diff review before committing:
1. Read full diff via `get_result`
2. Check for: stub implementations, missing error handling, unused imports, hallucinated APIs
3. Issues found ? submit targeted Ollama fix task
4. Clean ? commit

Simple tasks (types, docs, config) skip review � auto-verify via `tsc`/`vitest` is sufficient.

### Split Advisory

When `split_advisory: true` appears in task metadata (complexity='complex' + 3 files), consider decomposing into subtasks rather than sending as one large task.

## Slot-Pull Scheduler

An alternative scheduling mode where execution slots actively pull tasks from the queue, instead of the default push model (where task submission triggers queue processing).

**Enable with:**
```
scheduling_mode = 'slot-pull'   (set via DB config or set_project_defaults)
```

**Location:** `server/execution/slot-pull-scheduler.js`

When `scheduling_mode` is `slot-pull`, the scheduler starts a heartbeat on server init (`slotPullScheduler.startHeartbeat()`). Each heartbeat cycle scans for open provider slots and pulls queued tasks into them. This model reduces queue contention in high-concurrency scenarios where many tasks complete near-simultaneously.

The default scheduling mode (`push`) has event-driven queue processing triggered by task completion events, with a 5-second safety-net poll as fallback.

## Policy Engine

A rule-based evaluation engine that applies governance policies to tasks before and during execution. Lives in `server/policy-engine/`.

### Components

| File | Purpose |
|------|---------|
| `engine.js` | Core evaluation loop � evaluates profiles against tasks |
| `matchers.js` | Predicate functions � match tasks by provider, project, tags, etc. |
| `profile-store.js` | Persistent storage for named policy profiles |
| `profile-loader.js` | Loads profiles from DB and the default built-in set |
| `evaluation-store.js` | Caches evaluation results for audit/reporting |
| `promotion.js` | Promotes tasks to higher-priority providers based on policy |
| `shadow-enforcer.js` | Shadow enforcement � logs policy violations without blocking |
| `task-hooks.js` | Pre-submission hooks that apply policy before a task starts |
| `task-execution-hooks.js` | Mid-execution hooks for running tasks |
| `adapters/` | Provider-specific policy adapters |

### Shadow enforcement

Shadow enforcement mode (`shadow-enforcer.js`) evaluates policies but does not block � it logs what *would* have been blocked. Use to audit policy impact before enforcement goes live. Enable per-profile via the `shadow` flag.

### How policies are applied

1. At submission time, `task-hooks.js` evaluates the task against all active profiles.
2. Matching profiles may block the task, reroute it, or annotate it with metadata.
3. At execution time, `task-execution-hooks.js` applies mid-run governance (e.g., output filtering, rate limiting).
4. Results are stored in `evaluation-store.js` for audit.

## Architecture � DI Container

TORQUE uses a dependency injection container (`server/container.js`) as its composition root. Every module exports a `createXxx` factory function and is registered in the container.

### For new code

Use the container to access services instead of `require('./database')`:

```js
// OLD (legacy � do not use in new code):
const db = require('./database');
db.getTask(id);

// NEW (preferred):
const { defaultContainer } = require('./container');
const taskCore = defaultContainer.get('taskCore');
taskCore.getTask(id);
```

### Container API

- `createContainer()` � create a new container instance
- `container.register(name, deps, factory)` � register a factory with dependencies
- `container.registerValue(name, value)` � register a pre-built value
- `container.boot()` � resolve dependency graph via topological sort, instantiate all services
- `container.get(name)` � retrieve an instantiated service
- `container.resetForTest()` � reset to pre-boot state for test isolation

### Module factory pattern

Every module exports a `createXxx` factory alongside its existing API:

```js
// At the bottom of any module:
function createMyModule(deps) {
  return { fn1, fn2, fn3 };
}
module.exports = { ..., createMyModule };
```

### Migration status

- **~48 modules** export `create*` factory functions for the DI container
- **~36 modules** use the `init(deps)` dependency injection pattern
- **database.js** is a legacy facade that merges ~44 sub-modules � new code should use the container or init() DI
- **DI lint rule:** `npm run lint:di` (in server/) reports files still importing database.js directly
- **Test helper:** `server/tests/test-container.js` provides DI-based test isolation

### Key files

| File | Role |
|------|------|
| `server/container.js` | DI container � composition root |
| `server/database.js` | Legacy facade � merges 47 db modules (being replaced) |
| `server/event-bus.js` | Event bus with `createEventBus` factory |
| `server/scripts/check-no-direct-db-import.js` | DI migration lint rule |
| `server/tests/test-container.js` | Test helper for DI-based test isolation |

## File Safety

**NEVER delete or clean untracked files you didn't create.** Untracked files in `server/docs/`, `server/docs/investigations/`, or any `docs/` directory are likely generated reports, audit results, or investigation outputs from other sessions. Treat them as valuable work products.

- **NEVER run `git clean`** � it destroys untracked work products that may have taken hours to generate
- **NEVER delete directories you don't understand** � investigate before removing
- **Commit generated artifacts immediately** � reports, investigations, audit outputs, and any files generated by TORQUE workflows should be committed as soon as they're complete. Untracked = unprotected.
- **If you need a clean slate**, use `git stash` for tracked changes and leave untracked files alone

---
*Full safeguard documentation: see `docs/safeguards.md`*