# TORQUE Development Roadmap

## Project Overview

**TORQUE** (Threaded Orchestration Router for Queued Unit Execution) is a Claude Code plugin for distributed AI task execution. It acts as a control-tower dispatcher that routes coding tasks across 13 execution providers (local Ollama, cloud CLI tools like Codex and Claude Code, and cloud API providers like DeepInfra, Hyperbolic, Groq, Cerebras, Google AI, and OpenRouter).

### Current State (2026-03-30)

- **License:** MIT (switched from BSL-1.1 on 2026-03-29)
- **MCP Tools:** 537+ across tiered progressive unlock
- **Tests:** 17,000+ (17,037 at last count, 99.96% pass rate)
- **Providers:** 13 execution providers with smart routing
- **Commits:** 1,224 across 16 days of development
- **Architecture:** DI container with 130+ services, plugin system, policy engine
- **Platforms:** Windows, macOS, Linux (CI on GitHub Actions)

---

## Timeline

### 2026-03-30 -- Safety, Stability, Provider Cleanup

**Features:**
- Pre-shutdown and pre-startup safety backups (`dfa426f`)
- Exclusive startup lock to prevent dual-instance DB corruption (`2c118f2`)
- Legacy migration expanded to cover config, workstations, and hosts (`75a8c88`)
- Provider removal spec and plan -- hashline-ollama, hashline-openai, aider-ollama cleanup across 180 files (`5a539b7`, `b45bc28`)

**Bug Fixes:**
- Bootstrap script replaces loopback with LAN IP for remote machines (`d507253`)
- Pre-commit hook uses node for JSON payload instead of jq args (`f446088`)
- Remove duplicate tool definitions across defs files (`7a911c9`)
- Stall detection deferred to Claude for monitored tasks (`2edf0ab`)
- Codex stall threshold increased from 10 to 20 minutes (`14cf280`)
- 12 test failures resolved across 5 test files (`271770b`)
- E2E hashline and fallback-retry test stabilization (`3ca4386`, `5a8867e`, `0df4ae5`, `b04590b`)

---

### 2026-03-29 -- Auth Plugin Extraction, PII Guard, MIT License

**Features:**
- **Auth Plugin Extraction Phase 1** -- Plugin system with contract validation, plugin loader with auth_mode routing (`2f12fda`)
- **Auth Plugin Extraction Phase 2** -- Strip auth from main codebase; auth is now enterprise-only via plugin (`30b7b07`)
- **Enterprise Auth Plugin** -- Key manager, role guard, rate limiter, user manager, session manager, SSE auth, middleware, MCP config injector (`2822233`, `f28431f`, `64dffb1`, `c4b8de3`, `9eed983`, `3496147`)
- **Three-layer PII Guard** -- Auto-sanitizes personal data before it reaches the repo (pre-commit hook + Claude Code hook + CI scan) (`ad296ec`)
- **MIT License** -- Switched from BSL-1.1 to MIT (`75f8ea0`)
- **Evidence & Risk Engine Phase 5** -- Workflow DAG integration for adversarial review (`905e83d`)
- Auto-migrate provider configs when data directory moves (`521687a`)

**Bug Fixes:**
- Provider stats now loaded and displayed on dashboard (`6c0a1db`)
- Avg success rate only counts providers with actual tasks (`66f3684`)
- Isolate provider stats recording from extended safeguard failures (`974e755`)
- PII guard improvements -- node.js hook, placeholder lookahead, self-corruption prevention (`a2dc84c`, `b7820f2`, `d9e7f59`, `8797bf1`)
- Security vulnerability updates for brace-expansion and picomatch (`9b4049a`)

**Infrastructure:**
- Plugin contract with validation (`62392e5`)
- Plugin loader with auth_mode routing (`40aa230`)
- Plugin integration tests for local and enterprise modes (`3025580`)
- Wire plugin loader into server startup, local mode by default (`73afc24`)
- MCP config injector for global MCP config auto-setup (`c13981a`, `cafb7dc`)
- README rewritten as Claude Code plugin documentation (`58456d2`)

---

### 2026-03-28 -- Evidence & Risk Engine, Competitive Tier 3-4

**Features:**
- **Evidence & Risk Engine** -- File risk tagging, verification ledger, adversarial review (`82bf124`, `cd637d0`)
  - Provider scoring with 4-axis composite (`ebaba03`)
  - Resume context for structured retry information (`ebaba03`)
  - Verification mutex for serialized git commits (`cd637d0`)
  - Budget-aware routing with auto "Cost Saver" activation (`cd637d0`)
  - Circuit breaker with OPEN/HALF_OPEN/CLOSED states (`cd637d0`)
- **Tier 2 Features** -- Project templates (10 built-in), lazy tool schemas, AST symbol indexing (7 languages), active policy effects (`afd5ad1`)
- **Tier 3-4 Features** -- CPU activity detection, provider comparison, agent discovery, code review service, batched output persistence, branch names, task polish (`ec04b12`)
- Plugin modernization (`cd637d0`)

**Bug Fixes:**
- Regex fallback for symbol indexing when tree-sitter unavailable (`fd93c04`)
- Budget-watcher test expectations aligned with actual API shape (`66cb089`)
- File lock release returns change count (`e790fd6`)

---

### 2026-03-27 -- Evidence & Risk Engine Phases 1-5

**Features:**
- **Evidence & Risk Engine** -- Complete implementation across 5 phases (`82bf124`)
  - Phase 5: Workflow DAG integration for adversarial review (`f01839f`)
  - File risk patterns with directory-matching glob variants (`7398fb0`)

**Bug Fixes:**
- Feature-workflow test mock fixes -- vi.mock paths, vi.doMock + resetModules, monkey-patch pattern (`ff46d5f`, `8315f9c`, `4439fed`, `6cf4d70`, `3be95f5`, `ea53a39`)

---

### 2026-03-26 -- Ollama Provider Quality Overhaul

**Session outcome:** Ollama provider went from 57% success / 293s avg to 100% success / 33s avg across 6 test types.

**Features:**
- `replace_lines` tool for reliable large-file editing in agentic loop (`c86180a`)
- Line range support for `read_file` for large file handling (`128c6c7`)
- Sandbox-aware file mutex -- requeue codex/claude-cli on file conflicts (`319b89e`)
- Phase 6 build/test verification routed to remote workstation (`e2a4639`)

**Bug Fixes (8 Ollama quality fixes):**
- Read-only spin detection -- stops model after 5 read-only iterations on modification tasks (`a93ae6c`)
- `<function=name>` XML tool call format parser for qwen3-coder (`96c47bf`)
- `num_keep: 1024` preserves system prompt during context sliding (`9e3dc4f`)
- Dynamic tool reduction -- read-only tasks get 3 tools, write tasks get all 6 (`9e3dc4f`)
- Per-host async mutex to prevent GPU contention (`f8b0adc`)
- Dynamic agentic context minimum scales with ollama_max_ctx (`6ee976d`)
- Edit_file recovery guidance in agentic system prompt (`b9e5708`)
- Reduce false-positive malformed tool call detection (`d52bf17`)
- Detect Codex success from markdown summary format (`a10ae34`)
- Deprecated model removal (qwen2.5-coder:32b, codestral:22b) (`eaf9c1f`)
- Fail fast when no Ollama host has the requested model (`b15df61`)
- Aggressive orphan cleanup + workflow sweep on server restart (`f4d08d5`)

---

### 2026-03-25 -- Auth Plugin Architecture, Local-First Default

**Features:**
- **Auth Plugin Extraction spec and plan** (`2a5166d`, `90fd31f`)
- **MCP Config Auto-Injection** -- Server auto-injects keyless MCP SSE connection on startup (`c13981a`, `cafb7dc`)
- **User-Scoped MCP Config Injection** -- Auth roadmap Layer 1 (`6192fbf`, `100676e`)

**Refactoring:**
- Strip auth from api-server, mcp-sse, dashboard-server, mcp-protocol, api middleware (`d649b7e`, `a60ec3d`, `cda0146`, `60a7713`, `5808073`)
- Data directory default moved to ~/.torque (prevents Codex sandbox data loss) (`7e99a39`)
- Clean stale auth imports from tests and scripts (`5921680`)

**Bug Fixes:**
- Dashboard skips auth check in local mode (`1a9df50`)
- Surface upstream error details in OpenAI and Google AI adapters (`d3407bb`, `714409a`)

---

### 2026-03-24 -- Task Diffusion v3, CI Failure Detection, windowsHide Sweep

**Features:**
- **Task Diffusion v3** -- Compute-to-apply pipeline with provider specialization (`510f667`, `e907d28`, `4a6eeac`)
  - Auto-select apply providers + round-robin across Ollama/Codex/Claude (`acf4066`)
  - Auto-discover compute provider (`eaf5231`)
  - Dynamic workflow count updates for apply tasks (`1067790`)
- **CI Failure Detection Phases 1-3** (`f51f790`, `d5ad075`)
  - awaitRun, watchRun, enhanced diagnostics with sub-categories (`19fa9f4`, `1e06424`, `d74c8c2`)
  - Auto-activate CI watch on task submission (`f51f790`)
  - `/torque-ci` slash command (`d5ad075`)
- **Centralized data directory resolution** into data-dir.js (`d0e3305`)

**Bug Fixes:**
- windowsHide sweep (3 rounds) -- all child_process calls now use `windowsHide: true` on Windows (`db23d7f`, `d5d7c4d`, `4bb177d`, `b66f1ba`, `1c11ef9`)
- Diffusion bypass agentic loop for compute tasks (`e25b8ce`)
- JSON repair for corrupted diffusion signals (`4bb38e9`)
- Greenfield guard extended to hashline-ollama (`c5bb60b`)
- Unified GPU slot counting for ollama + hashline-ollama (`87deb5b`)
- All 12 providers added to dashboard reassign dropdown (`cfa93f5`)

---

### 2026-03-23 -- Model-Agnostic Architecture, Task Diffusion Engine, OSS Prep

**Major milestone: TORQUE became fully model-agnostic -- zero hardcoded model names in source.**

**Features:**
- **Model-Agnostic Phase 1** -- Model registry, family classifier (9 families), family templates, config-to-registry migrator, dynamic fallback model lookup (`3cfda22`, `ae261b8`, `4462502`, `c923106`, `dd56c79`, `8e069f3`)
- **Model-Agnostic Phase 2** -- Discovery engine, BaseProvider.discoverModels(), 8 cloud providers upgraded, heuristic capabilities, auto-role assignment, `discover_models` MCP tool (`57acc54`, `1118db9`, `485726f`, `d4e1ece`, `64205cc`, `07f73c7`)
- **Model-Agnostic Phase 3** -- Centralized capability lookup, hashline capability rewired to registry, family template tuning/prompt wiring, `list_models` + `assign_model_role` MCP tools (`a7c1253`, `7880e22`, `111077d`, `50e479c`)
- **Model-Agnostic Phase 4** -- MODEL_TIER_HINTS removed, 15 source files cleaned, 114 test files migrated to TEST_MODELS constants (`7dad916`, `2d58d42`, `c2bff05`, `2ad7326`, `83502fd`)
- **Task Diffusion Engine v1** -- Signal parser, plan schema, planner with convergence strategy, scout prompt, MCP tools (`af5aff0`, `6764230`, `9e3a546`, `352c6ac`, `fb9dabd`)
- **Task Diffusion Engine v2** -- Streaming scout, exemplar embedding, mandatory verify, promote to TIER_1 (`200f8c9`, `6318c5e`, `cccec5a`, `4ef98e6`, `867fcda`)
- **Intelligent heartbeat-driven decisions** replacing hard timeouts (`566f2f3`)
- **Torque doctor** diagnostic CLI command (`a04abb2`)
- Remove all Headwaters/Deluge-specific code (`83502fd`)
- Rename free_tier to quota across codebase (`cb4a046`)
- Codex fix: disable worktree isolation, add --json, auto-commit (`9f8ca85`)
- Docker health endpoint fix, deprecated compose version removed (`b356a4a`)
- Security update: flatted 3.4.1 to 3.4.2 (prototype pollution) (`0b2851c`)
- Getting-started, provider, and troubleshooting guides (`253c9fa`)
- README rewritten for beta (`90d9be9`)

**Test count:** 17,037 total, 16,981 passing (99.96%)

---

### 2026-03-22 -- DI Container Migration, Facade Removal, Model Upgrade

**Major milestone: Complete DI container migration -- 100% source migrated, 0 lint violations, 130+ container services.**

**Features:**
- **DI Container** -- Topological sort, factory pattern, 176 modules with factory exports, 130+ container-registered services (`be4bb30`, `0dd359c`, `db8fc14`)
- **Database Facade Removal** -- Removed merge loop from database.js; all source files use direct module imports (`1041e0b`)
  - 14 migration waves across source and test files
  - God file decomposition -- all files under 1500 lines (down from 14 over-limit)
  - Extracted: smart-routing, ollama-health, SSE session/protocol, task-startup, scheduler, host-capacity, resource-health, pipeline-crud, approval-workflows, cron-scheduling, task-intelligence, task-debugger (`caba846`, `4ad79d5`, `2d3db85`, `e829b06`, `ff8e176`, `be42304`, `de90163`, `27d0e51`, `64da1dc`, `f46f62a`, `d46a32d`)
- **Aider-Ollama Deprecation** -- Complete removal of aider-ollama provider from codebase (`6c1e710`, `68ae4c3`, `0a5a694`, `89fbd22`, `deb84b4`, `4a0e161`, `36e397a`)
- **Per-Host Default Model** -- default_model column, PATCH endpoint, MCP tools, dashboard dropdown (`76f63f7`, `e169ea9`, `0495536`, `e51405c`)
- **Model Roles** -- getModelForRole with fallback chains, configure/list MCP tools (`bd8b3a9`, `fb4f682`)
- **resolveOllamaModel()** shared helper replacing all hardcoded model fallbacks (`110d540`, `cdf9899`, `d8cab69`)
- **Local Ollama upgraded to qwen3-coder:30b** (MoE, 30B total, 3.3B active, ~112 tok/s) (`834b3f9`)
- Dynamic model registry plan (`ab360d9`)
- DI lint rule + test container helper + migration progress metrics (`624a5e2`, `ce1f4ea`, `d954d62`)
- Security: flatted 3.4.1 to 3.4.2 upgrade (`7e8ce84`)
- windowsHide added to Codex/Claude CLI spawn and CI scripts (`60dbf7b`, `2d185d3`)

---

### 2026-03-21 -- Competitive Features (18), Structured Outputs, DI Foundation

**Major milestone: 18 competitive features implemented from analysis of 5 competitor projects. Safety tag: `pre-competitive-features` on `8239a26`.**

**Features -- Tier 1 (High Impact):**
1. **Provider Scoring** -- 4-axis scoring (cost, speed, reliability, quality), wired into task-finalizer + fallback chain sorting (`f91d851`, `5c5b6c3`)
2. **Circuit Breaker** -- OPEN/HALF_OPEN/CLOSED states, wired into routing (`065284d`)
3. **Budget-Aware Routing** -- Auto-activates "Cost Saver" template at 90% budget (`5c5b6c3`)
4. **Resume Context** -- Structured context for retries, wired into all 3 retry paths (`5c5b6c3`)
5. **Verification Mutex** -- Serializes git commits via commit-mutex (`065284d`)

**Features -- Tier 2 (High Impact):**
6. **AST Symbol Indexer** -- tree-sitter WASM parser, 7 languages, incremental indexing, 4 MCP tools (`0a78c82`)
7. **Project Templates** -- 10 built-in templates, auto-detection via file markers (`a2c1ce9`)
8. **Lazy Tool Schemas** -- `get_tool_schema` MCP tool (`70b46dd`)
9. **Active Policy Effects** -- rewrite_description, compress_output, trigger_tool (`e5956ec`)

**Features -- Tier 3 (Medium Impact):**
10. **CPU Activity Detection** wired into stall detection (`a2c1ce9`)
11. **Provider Comparison** MCP tool (`a2c1ce9`)
12. **Agent Discovery** MCP tool (`a2c1ce9`)
13. **TUI Dashboard** (`torque-top`) -- standalone terminal UI (`a40190a`)
14. **Code Review Service** MCP tool (`a2c1ce9`)
15. **Batched Log Persistence** wired into process-streams (`a2c1ce9`)
16. **Branch Names** for git worktrees (`a2c1ce9`)
17. **Task Polish** MCP tool (`a2c1ce9`)

**Features -- Infrastructure:**
18. **SSE Session Token Auth** -- POST /api/auth/sse-ticket, 60s one-time tokens (`6fbc6e8`)

**Other Features:**
- **MCP Tool Annotations** -- Centralized in tool-annotations.js with convention prefix rules (`2a6e666`, `fcd1ac8`, `c38152a`)
- **Structured Tool Outputs** Phase 1-3 -- 28 tools with output schemas (`4de8304`, `d781b3c`, `dd23b09`, `4aa9e58`)
- **Compact Context Tool** (`get_context`) with queue and workflow scopes (`c2ed6df`, `412bfa5`, `6e8cd12`)
- **MCP Elicitation** -- Bidirectional protocol, elicit() helper, wired into approval gates (`0aff358`, `f176425`, `94fd3ab`)
- **MCP Sampling** -- Free task decomposition via host LLM (`91c89c9`, `0aab86e`)
- **DI Container Foundation** -- Container with topological sort, createEventBus factory, DI lint rule (`be4bb30`, `1083834`, `624a5e2`)
- **DI Phase 2** -- 39 db module factories registered in container (`1400574`)
- **Coordination Wiring** -- Auto-register MCP sessions as agents, claims/events in task lifecycle, approval checks, startup sweep (`26dbb81`, `88c8f21`, `6633f7d`, `816f6cb`)
- **Dashboard ProjectSettings** route + sidebar link (`6fbc6e8`)
- OSS architecture remediation spec (`9a15198`)
- Personal data scrubbed from codebase (`e2cb022`, `f92b963`, `1b68d50`)

**13 new MCP tools:** compare_providers, review_task_output, discover_agents, detect_project_type, list_project_templates, get_provider_scores, get_circuit_breaker_status, polish_task_description, index_project, search_symbols, get_symbol_source, get_file_outline, get_tool_schema

---

### 2026-03-20 -- Auth System, Bug Hunt Remediation (Round 2), Test Repair

**Features:**
- **Enterprise Auth System** -- HMAC-SHA-256 key manager, ticket exchange, session manager with CSRF, pluggable resolver chain, rate limiting, MCP tools, dashboard login, first-run bootstrap (`b59be13`, `0f17f18`, `8855646`, `141ba3d`, `20605c9`, `0722ed3`, `b7592c4`, `8100d5a`)
- **Economy Mode removed** -- routing templates supersede it (`ee28b12`)
- **Routing templates made discoverable** to new sessions (`253da56`)
- `/torque-hosts` and `/torque-validate` commands (`ea494a4`)
- Workstation bootstrap one-liner agent setup (`a4e70ac`)
- Server survives stdin close -- enters headless SSE mode (`ac0fe77`)

**Bug Fixes:**
- 589+ test failures resolved across multiple waves (`5eee718`, `dd55405`, `a55aac5`, `06da0e2`, `b82b431`)
- 8 critical data corruption bugs in DB layer (`1ee349f`)
- SQL injection guards, HSTS removal, subscription limit (`c77a915`)
- FK constraints, NULL uniqueness, duplicate indexes (`3f50361`)
- Lifecycle guards, handler correctness, DB safety (`f339f66`)
- Abort wiring, null guards, resource cleanup (`7c2a551`)
- Query limits, prepared statement hoisting, datetime consistency (`82607f7`)
- Test quality -- assertions verify what names claim, proper cleanup (`192e567`, `ee5a38b`, `6db8773`)

---

### 2026-03-19 -- Architecture Remediation, Provider Quality, Dashboard UX

**Features:**
- **MCP Transport Unification** -- Shared protocol handler for SSE and stdio (`9e48f29`, `6bc0710`)
- **Container.js Composition Root** created (`e26a5e9`)
- **Provider Quota Monitoring** -- Store, headers, routing integration, dashboard (`ab40146`)
- **Coordination Wiring** into task lifecycle (`26dbb81` - `3bb572c`)
- **Dashboard UX Consolidation** -- 13 pages reduced to 6 (`e4d033d`)
  - LoadingSkeleton in 12 views, confirmation dialogs on destructive actions
  - Pagination for Workflows/Coordination/Approvals
  - Sortable column headers, keyboard accessibility, colorblind-friendly icons
- **Claude Code Hooks** -- 6 hooks with server-side HTTP bridge (`d903f33`)
- **Plugin Modernization** -- SessionStart hook, task-reviewer/workflow-architect/batch-monitor agents, cross-platform skills (`1fcbf50`, `fe3465e`, `05e02c6`, `01ebc76`)
- **Remote Workstation routing** -- torque-remote replaces per-project torque-test (`5e295de`, `8ced462`)
- **Free Tier page retired** -- features migrated to Providers page (`28c8e7f`)

**Bug Fixes:**
- 14 unprotected JSON.parse calls wrapped with safeJsonParse (`f5f1cb6`)
- 22 `|| 0` replaced with `?? 0` where zero is valid (`ff243c2`)
- Batch DB calls, reduced polling frequency, memoized Date.now (`50c46dd`)
- Timer cleanup exports, bounded unbounded caches (`637a2f3`)
- Dead code removal, naming fixes (`cc92562`, `996868e`)

**Security:**
- Environment whitelist, command whitelist, output cap for agent (`fb5a4c1`)
- Backup integrity, Windows DB permissions, extended secret redaction (`9eca40f`)
- Per-IP connection limits, subscription cap, body timeout, strict CORS (`4026d75`)

---

### 2026-03-18 -- Bug Hunt (475 issues), Agentic Infrastructure, Heartbeat System

**Features:**
- **Agentic Worker Threads** -- Worker script with message protocol and abort support (`b379e46`, `37409d3`)
- **Heartbeat System** -- partial_output column, task:started/stall_warning/fallback events, formatHeartbeat response builder, heartbeat timer in await handlers (`6bd8386`, `7462818`, `b4343f4`, `f0daf61`, `24074ab`, `1ac4d8b`, `1e64b50`)
- **Partial Output Streaming** -- Ring buffer accumulator with throttled flush (`016b88c`, `7528fdf`)
- **Fallback Retry Loop** with worker cleanup and git revert between attempts (`abff9a5`)
- **Per-Task Routing Template** selection (`cd14e9e`, `aa9a37e`, `1948171`)
- **Dashboard Chain Editor** -- Auto-detecting chain editor in routing templates (`bddbbe9`, `079fca5`)
- **Edit File Fuzzy Matching** -- Whitespace-normalized fallback (Tier 1), lineSimilarity with ambiguity gap (Tier 2) (`fd49a23`, `e5c1082`)
- **Routing template rebalancing** with codex + free LLM fallback chains (`65eb9be`, `ca9b294`)
- **Free Speed** routing template added (`65eb9be`)

**Bug Hunt Remediation (4 sprints):**
- Sprint 1: Falsy value bugs (|| to ??), null guards, resource leaks, utility extraction (`d98cd2a`, `3ab5fe0`, `33d53fc`, `f9af27f`)
- Sprint 2: Math/unit bugs, timeout conversion, state machine fixes, dashboard fixes (`e5fe782`, `845bd3e`, `6799d80`, `cb147f0`, `d204d59`)
- Sprint 4: Test quality, dashboard polling, accessibility, API consistency (`8026cbb`)

**Security:**
- File and path handling -- validation, symlink cycles, exec safety (`14d7fce`)
- Credential handling -- key exposure, redaction, validation (`976f393`)
- Input validation -- SHA anchoring, metachar blocklist (`a30eebf`)
- Timing attack fix in agent auth + prototype pollution in deepMerge (`b47972b`)
- Command injection bypass fix in ollama-tools (`fdc4ae1`)

**Reliability:**
- Transaction safety -- atomic updates, FK guards, concurrency control (`fc61b3e`)
- Status and queue concurrency guards, ghost task cleanup (`a82e8d5`)
- Shutdown state machine, session race, timer cleanup (`6b93b76`)
- Provider timeouts -- cancel checks, abort race, kill signals (`2719caf`)
- Agentic pipeline -- abort controllers, context budget, conversation integrity (`5517981`)

---

### 2026-03-17 -- Routing Templates, API Key Management, Universal Agentic Tool Calling

**Features:**
- **Routing Templates** -- Category classifier, template store with CRUD, 5 presets (System Default, Cost Saver, Quality First, All Local, Cloud Sprint), 7 MCP tools, 8 REST endpoints, dashboard tab (`30f7231`, `52094ae`, `b37c95e`, `da3be2a`, `e49733b`, `5e1dbdc`)
- **API Key Management** -- AES-256-GCM encryption, inline dashboard management, async validation, MCP tools (`0cc73c4`, `6471080`, `15cf557`, `5073cba`)
- **Universal Agentic Tool Calling** -- Complete agentic infrastructure:
  - Tool executor with path jail, pure-JS search, command sandbox (`18b9b2c`)
  - Ollama chat adapter with NDJSON streaming (`23fa59a`)
  - OpenAI-compatible chat adapter with SSE streaming (`a23d6ca`)
  - Google AI Gemini adapter with function calling (`d3c5152`)
  - 3-layer capability detection (config > probe > whitelist) (`2a4584f`)
  - Git safety net with snapshot/revert/authorize (`6ba51d9`)
  - Adapter-agnostic loop with context management and stuck detection (`c44eccc`)
  - Production pipeline wiring (`804a179`)
  - Comprehensive 22-model baseline across 7 providers (`19d8497`)
- **Dynamic Model Discovery** -- Approval workflow, provider CRUD, model registry integration (`1457fa7`, `62312d2`, `8b39bb0`)
- **Strategic Brain Customization** -- Config loader with three-layer merge, domain templates, dashboard Configuration tab (`49384b9`, `b0c0c82`, `d748317`, `901806a`)
- **Workstations Phase 3-4** -- Consumer migration, dashboard view, bootstrap endpoints (`6eed767`, `4f9b887`, `eb54282`)
- **Hashline-OpenAI provider removed** (`33afab3`)
- **Anthropic demoted** from default to opt-in provider (`e4e8aaa`)
- Default Ollama model changed from deepseek-r1:14b to qwen2.5-coder:32b (`54843eb`)
- Bug hunt/remediation features: error pattern analysis, workflow events, cron timezone support, provider percentile metrics (`689818d`, `ce164d6`, `561603f`, `84c7d22`)
- 92 tests across 4 routing template test files

---

### 2026-03-16 -- Initial Stabilization, Workstations, Economy Mode, Plugin Packaging

**Features:**
- **Unified Workstations** Phase 1+2 -- VRAM-aware dynamic capacity gating (`dbb7026`, `b463a08`, `82dad94`)
- **Concurrency Limits UI** -- MCP tools + dashboard, per-host VRAM budget slider (`4e5810a`, `5c5b8dc`)
- **Economy Mode** -- Routing policy, auto-trigger/lift, MCP tools, dashboard (`5c9a5f1`) *(later removed 2026-03-20 in favor of routing templates)*
- **Claude Code Plugin Packaging** -- Manifest, 8 skills, marketplace submission (`32e8fca`)
- **CI Watcher** -- Complete implementation (db, tools, CLI, init) (`7a361ae`)
- **Guidance System** spec -- Three-layer LLM behavioral knowledge delivery (`b5b18ed`)
- Per-API-key rate limiting (`a60639c`)
- Centralized JSON Schema validation for tool args (`b233000`)
- HTTPS_PROXY/HTTP_PROXY support for cloud API providers (`b96bd38`)
- Validation-output-safeguards unit tests (36 tests) (`07099e3`)
- TORQUE Cloud design spec (`eb1167c`)

**Bug Fixes:**
- React 18 StrictMode bug in useAbortableRequest causing permanent loading state (`bea6fda`)
- 121 pre-existing test failures resolved -- 15,788 tests passing (`ed8c31b`)
- 200+ ESLint errors resolved to zero (`2713250`, `c61ea63`)
- 57 dashboard ESLint errors resolved (`b326197`)
- CI stability: teardown timeout, snapscope test timeout, threads pool, force-exit timer, unref timers (`bf6e8f2`, `87c2108`, `d5c7a64`, `c1ff56a`, `a865bdc`, `d9e7a48`)
- E2E tests updated and stabilized (`fef7822`, `c6a64ed`, `fc4bb4a`)
- Node 22 vitest hang resolved (`fa5847f`)

**Test count:** 15,788 passing

---

### 2026-03-15 -- CI Pipeline Establishment

**Bug Fixes:**
- CI failures resolved -- sync lock file + bump Node minimum to 20 (`b2829f4`)
- 200 ESLint errors resolved (`2713250`)
- 40 test files updated -- 80 stale assertions + createConfigMock refactor (`80c6586`)
- 27 tests made CI-resilient (timezone, paths, env vars, timing) (`1f17ad6`)
- CI Watcher feature -- complete implementation (`7a361ae`)
- Dashboard ESLint errors resolved (`b326197`)
- Vitest process hang prevented via unref'd timers and force-exit (`d5c7a64`, `c1ff56a`, `a865bdc`)

---

### 2026-03-14 -- Initial Public Release

**Milestone:** TORQUE v1.0.0-beta.1 -- Initial public release (`679774f`)

This was the first commit to the public repository, containing the full TORQUE system: MCP server, dashboard, 13 providers, task scheduling, workflow DAG engine, policy engine, and all core infrastructure.

---

## Architecture Milestones

### Initial Public Release (2026-03-14)
- **Commit:** `679774f`
- Full MCP server with SSE transport
- 13 execution providers with smart routing
- Task scheduling with priority queue
- Workflow DAG engine with dependency resolution
- Policy engine with shadow enforcement
- Slot-pull scheduler alternative
- Dashboard (React + Tailwind)
- CLI tools

### CI Pipeline (2026-03-15 -- 2026-03-16)
- GitHub Actions CI with Node 20/22 matrix
- ESLint zero-error enforcement
- Vitest with coverage
- E2E tests with Playwright
- Test count grew from initial baseline to 15,788 passing

### Universal Agentic Tool Calling (2026-03-17)
- **Commits:** `18b9b2c` through `19d8497`
- 4 chat adapters (Ollama NDJSON, OpenAI SSE, Google AI, prompt-injected)
- 22-model baseline across 7 providers
- Worker thread isolation
- Path-jailed tool executor with command sandbox
- Git safety net with snapshot/revert

### Routing Templates (2026-03-17)
- **Commits:** `30f7231` through `51db962`
- 7 preset templates (System Default, Cost Saver, Quality First, All Local, Cloud Sprint, Free Agentic, Free Speed)
- Category classifier with 9 auto-detected task categories
- Per-task template override
- Dashboard chain editor

### Bug Hunt Remediation (2026-03-18 -- 2026-03-20)
- 475+ issues identified, 4-sprint remediation
- Security hardening: path validation, credential handling, input validation, command injection fixes
- Reliability: transaction safety, shutdown state machine, provider timeouts
- Dashboard: accessibility, error handling, performance

### DI Container Migration (2026-03-21 -- 2026-03-22)
- **Key commits:** `be4bb30` (container), `1041e0b` (facade removal)
- DI container with topological sort dependency resolution
- 176 modules with `createXxx` factory exports
- 130+ container-registered services
- database.js facade merge loop removed
- 14 god files split to under 1500 lines each
- DI lint rule enforcing migration
- Zero source file lint violations

### Competitive Feature Wave (2026-03-21)
- **Safety tag:** `pre-competitive-features` on `8239a26`
- 18 features implemented from analysis of 5 competitor projects
- 13 new MCP tools
- 154 new unit tests + 40 live assertions
- Provider scoring, circuit breaker, budget routing, resume context, verification mutex
- AST symbol indexer, project templates, active policy effects

### Model-Agnostic Architecture (2026-03-23)
- **Key commits:** `3cfda22` through `83502fd`
- Zero hardcoded model names in source code
- Family classifier with 9 model families
- Auto-discovery from all providers
- Heuristic capability classification
- 4 new MCP tools (discover_models, list_models, assign_model_role)
- TEST_MODELS constants for all test files

### Task Diffusion Engine (2026-03-23 -- 2026-03-24)
- v1: Signal parser, plan schema, planner, scout prompt, MCP tools
- v2: Streaming scout, exemplar embedding, mandatory verify
- v3: Compute-to-apply pipeline with provider specialization

### Evidence & Risk Engine (2026-03-27 -- 2026-03-29)
- File risk tagging with glob-based pattern matching
- Verification ledger for audit trail
- Adversarial review via workflow DAG integration
- Provider scoring with 4-axis composite

### Auth Plugin Extraction (2026-03-25 -- 2026-03-29)
- **Phase 1:** Plugin system with contract validation, plugin loader
- **Phase 2:** Auth stripped from main codebase, moved to enterprise-only plugin
- Local mode: zero auth, zero configuration
- Enterprise mode: API key management, user/password auth, RBAC, sessions, rate limiting

### PII Guard (2026-03-29)
- Three-layer defense: pre-commit hook, Claude Code hook, CI scan
- Auto-sanitizes personal data before it reaches the repo

### MIT License (2026-03-29)
- **Commit:** `75f8ea0`
- Switched from BSL-1.1 to MIT for full open-source release

---

## Current Capabilities

### Task Execution
- 13 execution providers with intelligent routing
- Smart routing analyzes task complexity and routes automatically
- 7 routing template presets with custom template support
- Fallback chains with automatic retry on failure
- Stall detection with configurable thresholds and auto-resubmit
- File-level locking prevents concurrent Codex sandbox conflicts

### Workflow Engine
- DAG-based workflows with dependency resolution
- Feature workflow templates (types, data, events, system, tests, wire)
- Parallel task execution with provider-per-step routing
- Workflow-level verification and auto-commit

### Provider Infrastructure
- Model-agnostic architecture with auto-discovery
- Family classifier for 9 model families
- Heuristic capability classification
- Provider scoring (cost, speed, reliability, quality)
- Circuit breaker for failing providers
- Budget-aware routing with automatic cost optimization
- Per-host GPU capacity gating with VRAM awareness

### Quality & Safety
- Evidence & Risk Engine with file risk tagging and adversarial review
- PII guard with three-layer auto-sanitization
- Verification mutex for serialized git commits
- Edit file fuzzy matching for LLM output normalization
- Resume context for structured retry information
- Policy engine with shadow enforcement mode
- Baseline snapshots and rollback on failure

### Developer Experience
- 537+ MCP tools across tiered progressive unlock
- Structured tool outputs with JSON schemas
- MCP tool annotations for all tools
- Compact context tool (get_context) for queue/workflow state
- MCP elicitation for approval gates
- MCP sampling for free task decomposition
- Heartbeat check-ins during long-running tasks
- Push notifications via SSE (no polling needed)

### Dashboard
- React + Tailwind with 6 consolidated pages
- Real-time WebSocket updates
- Provider health monitoring
- Workflow DAG visualization
- Routing template management with chain editor
- Host management with VRAM budget controls
- Project settings configuration
- CI failure monitoring

### Infrastructure
- DI container with 130+ services and topological sort
- Plugin system with contract validation
- Local-first (zero auth) with enterprise auth plugin
- Auto-inject MCP config into Claude Code
- Remote workstation routing for heavy commands
- CI failure detection and auto-reporting
- Pre-shutdown and pre-startup safety backups

---

## What's Next

### In Progress (2026-03-30)
- **Provider Removal** -- Removing hashline-ollama, hashline-openai, aider-ollama providers and the hashline format system. Spec and plan written (`5a539b7`, `b45bc28`). 11 tasks across ~180 files.

### Planned
- **Voice Control** -- Local Whisper STT for hands-free task submission (experimental/future)
- **Per-Project Role Assignments** -- Assigning user roles at the project level
- **OAuth + Password Reset** -- Future auth enhancements (argon2, user management UI)
- **Streamable HTTP Migration** -- SSE to HTTP transport migration investigated and deferred. Revisit only if Claude Code sunsets SSE.

### Backlog (reference)
- Context routing improvements for free API providers
- Codex sandbox staleness mitigation
- Symbol indexer grammar tuning for Python/Rust/Go/C#
- Policy trigger_tool blocking mode (currently fire-and-forget)
- Output buffer load testing under high concurrency

---

*Generated from git log analysis of 1,224 commits across 2026-03-14 to 2026-03-30. Commit hashes provided for traceability.*
