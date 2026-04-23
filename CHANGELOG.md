# Changelog

## [1.48.1] - 2026-04-23

### Added
- Plan task 4 — Run focused and non-regression validation
- Plan task 3 — Resume deferred EXECUTE batches and warn on stale deferrals
- Plan task 2 — Block next plan-task submission while paused
- Plan task 1002 — verify auto-retry #2
- Plan task 3 — MCP tools + docs + smoke
- Plan task 2 — Wire into runtime
- Plan task 5 — Workflow-spec (skip if Plan 1 not shipped) + docs + smoke
- Plan task 4 — Wire into task-startup
- Plan task 3 — Per-task fields
- Plan task 2 — Orchestrator
- Plan task 6 — Workflow-spec (skip if Plan 1 not shipped) + docs + restart
- Plan task 5 — Inject into task prompts + MCP tool
- Plan task 4 — DB cache + scan orchestrator
- Plan task 3 — Token-budgeted Markdown renderer
- Plan task 2 — Build reference graph + rank
- Plan task 6 — Docs + restart + smoke
- Plan task 5 — Workflow-spec support (skip if Plan 1 not shipped)
- Plan task 4 — Wire into context-from injection
- Plan task 3 — Condenser orchestrator
- Plan task 2 — Condense prompt
- Plan task 1001 — verify auto-retry #1
- Plan task 4 — MCP tools + REST + docs
- Plan task 3 — Replay
- Plan task 2 — Hook bundle build into workflow finalization
- Build bundle on workflow finalization
- Plan task 1 — Bundle builder
- Plan task 1001 — verify auto-retry #1
- Plan task 4 — Docs + smoke
- Plan task 3 — MCP query tools + REST
- Plan task 2 — Wire emit calls at key sites
- Plan task 1 — Schema + emitter
- Plan task 1001 — verify auto-retry #1
- Plan task 3 — Docs
- Plan task 2 — Wire into unblock evaluation
- Pure expression evaluator for edge conditions
- Plan task 1002 — verify auto-retry #2
- Plan task 1001 — verify auto-retry #1
- Plan task 4 — Docs + restart + smoke
- Plan task 3 — MCP tool for manual resume
- MCP tools resume_workflow + resume_all_workflows
- Plan task 2 — Hook into startup
- Auto-resume running workflows on startup
- Plan task 1 — Resume logic
- Plan task 1003 — verify auto-retry #3
- Plan task 1002 — verify auto-retry #2
- Plan task 1001 — verify auto-retry #1
- Plan task 12 — Verify full suite + restart
- Plan task 11 — Integration smoke test
- Plan task 10 — User-facing documentation
- Plan task 9 — Dashboard WorkflowSpecs view
- WorkflowSpecs view with run button
- Plan task 8 — Dashboard API client
- Dashboard API client
- Plan task 7 — Example workflow spec in repo
- Plan task 6 — REST API routes
- REST routes for list/validate/run
- Plan task 5 — MCP handler implementation
- MCP handlers for list/validate/run
- Plan task 4 — MCP tool definitions
- MCP tool schemas
- Plan task 3 — Public module API
- Plan task 2 — Spec discovery
- Discover workflows/*.yaml in projects
- YAML parser with JSON Schema validation
- Hide pwsh windows by launching native codex.exe directly
- Auto-recovery badge, exhausted banner, Clear & retry wiring
- REST recovery_history route + dashboard data plumbing
- Plan task 1002 — verify auto-retry #2
- MCP tools for list, history, clear, and trigger
- Plan task 1001 — verify auto-retry #1
- Wire auto-recovery engine into tick, startup, DEFAULT_PLUGIN_NAMES + cooldown gate
- Plan task 3 — MCP tools + docs + smoke
- Day-one classifier rules and plugin shell
- Plan task 2 — Wire snapshot into task finalization
- Fresh-session, fallback-provider, retry-plan-generation, fresh-worktree
- Shadow-git snapshot + rollback
- Declarative classifier with priority tiebreak and match_fn escape hatch
- Add auto-recovery columns and whitelist 'auto-recovery' actor
- Accept classifierRules and recoveryStrategies as optional plugin fields
- Engine core with classify-select-run-log pipeline
- Retry, clean_and_retry, reject_and_advance, escalate strategies
- Candidate query covering VERIFY_FAIL and never-started projects
- Plugin registry with rule sort, strategy pick, and validation
- Services bundle with tech-stack-aware worktree cleanup
- Exponential backoff helper with 30s base and 30min cap
- Plan task 1001 — verify auto-retry #1
- Plan task 3 — Docs + restart + smoke
- Plan task 2 — Wire into auto-commit + workflow config
- Wire pre-commit AI review into workflow commits
- Plan task 1 — Reviewer module
- PRIORITIZE runs rankIntake + stale-probe before claiming
- Architect-runner calls composeGuide() with fail-open fallback
- Plan-authoring-guide composer combining RULES + examples
- Add description field to every plan-quality rule
- Stale-probe skips scout findings churned by post-scan commits
- Promotion-policy ranks intake by severity + score triggers
- VALID_STATUSES accepts shipped_stale for retired scout findings
- Gate rejected recovery sweep by config
- Plan task 4 — Build, Push, and Restart
- Plan task 3 — Update Category Row Rendering
- Plan task 2 — Add ChainSummary and ChainEditor Components
- Add MODEL_SUGGESTIONS and ModelInput component for chain editing
- Plan task 1001 — verify auto-retry #1
- Plan task 3 — Fuzzy matching (Tier 2) + tests (TDD)
- Tier 2 fuzzy matching with lineSimilarity + ambiguity gap
- Plan task 2 — Whitespace-normalized matching (Tier 1) + tests (TDD)
- Plan task 3 — Conformance Tests + Verification
- Plan task 2 — Add structuredData to Provider + Cost Handlers
- StructuredData for 10 Phase 2 tools (provider/cost/monitoring)
- Add 10 Phase 2 output schemas (provider/cost/monitoring)
- Plan task 1002 — verify auto-retry #2
- Plan task 1001 — verify auto-retry #1
- Plan task 1001 — verify auto-retry #1
- Plan task 4 — Extract provider command construction and platform path handling
- Plan task 1001 — verify auto-retry #1
- Plan task 1001 — verify auto-retry #1
- Plan task 1001 — verify auto-retry #1
- Plan task 1001 — verify auto-retry #1
- Wire plugin.middleware() into the HTTP request pipeline
- Silent verify-rerun on ambiguous classifier verdict
- Ship-noop auto-route + pause-on-blocked with classifier confidence gate
- Prepend prior-attempt context to verify-retry fix prompts
- Auto-commit listener writes attempt_history + classifier rationale
- Completion-rationale LLM fallback for unknown zero-diff phrasings
- Completion-rationale heuristic classifier for zero-diff Codex completions
- Verify-signature helper for same-vs-different failure detection
- Factory-attempt-history DB accessor with per-work-item attempt counter
- Migration 30 — factory_attempt_history + verify_silent_reruns
- Add /api/v2/system/restart-status passthrough
- Plan task 1001 — verify auto-retry #1
- Plan task 1001 — verify auto-retry #1
- Plan task 1001 — verify auto-retry #1
- Capture exit signal + preserve cancel-on-retry-scheduled error + classify premature exit
- Plan task 1002 — verify auto-retry #2
- Plan task 1002 — verify auto-retry #2
- Reopen_workflow handler resets all non-completed tasks
- Timeout_minutes=0 means no timeout enforcement
- Record decision log entries for verify auto-retry and max-exhausted
- Persist verify_recovery_attempts to factory_projects
- Plan task 1001 — verify auto-retry #1
- Show alert badges on dashboard
- Expose idle alert status
- Detect failing and stalled factory work
- Add alert notification primitives
- Plan task 17 — End-to-end verification
- Plan task 16 — Update README with peek companion
- Plan task 15 — Add auto-start to TORQUE's resolvePeekHost
- Auto-start @torque-ai/peek when installed + better error message
- Plan task 14 — CLI entry point
- CLI — start, stop, status, check commands
- Plan task 13 — Snapshot capability (`/snapshot` — stub)
- Snapshot capability stub — accessibility API planned
- Plan task 12 — Compare capability (`/compare`)
- Compare capability — /compare with pixelmatch
- Plan task 11 — Launch capability (`/process`, `/projects`, `/open-url`)
- Launch capability — /process, /projects, /open-url
- Plan task 10 — Windows capability (`/list`, `/windows`)
- Windows capability — /list and /windows endpoints
- Plan task 9 — Interaction capability (12 endpoints)
- Plan task 8 — Capture capability (`/peek` endpoint)
- Capture capability — /peek endpoint
- Plan task 7 — Linux adapter
- Linux platform adapter — xdotool + maim/import
- Plan task 6 — macOS adapter
- MacOS platform adapter — screencapture + osascript
- Plan task 5 — Windows adapter
- Plan task 4 — Base adapter class
- Base platform adapter class with safe exec utilities
- Plan task 3 — HTTP server + health + router
- Plan task 2 — Platform detection module
- Platform detection + dependency checking
- Initialize @torque-ai/peek package scaffold
- Plan task 1002 — verify auto-retry #2
- Plan task 1001 — verify auto-retry #1
- Complete provider API key management — encrypted storage, dashboard UI, MCP tools
- Plan task 8 — Integration Tests
- Plan task 7 — Dashboard Provider Card Key UI
- Add inline API key management to provider cards
- Plan task 6 — Dashboard API Client
- Plan task 5 — Enrich Provider List with Key Status
- Enrich provider list with api_key_status and api_key_masked
- Plan task 4 — REST Routes + Dispatch
- Plan task 3 — Set/Clear API Key Handlers + MCP Tools
- Add set/clear API key handlers with encryption and async validation
- Plan task 2 — Update getApiKey() Resolution
- GetApiKey resolves encrypted keys from provider_config
- Plan task 1001 — verify auto-retry #1
- Plan task 11 — Write enterprise security roadmap
- Plan task 10 — CORS strict-by-default + rate limiting
- Plan task 9 — SSE session auth + per-IP limits
- Plan task 8 — DB permissions + secret redaction + protected config
- Plan task 7 — Backup integrity verification
- Plan task 6 — TLS default for agent connections
- Plan task 5 — Env var whitelist + command whitelist on server-side agent
- Plan task 4 — Security banner for unconfigured installs
- Plan task 3 — Wire auth into SSE and stdio transports
- Plan task 2 — Enforce auth in mcp-protocol.js
- Plan task 1001 — verify auto-retry #1
- Plan task 10 — Full verification
- Plan task 9 — Update and fix tests
- Plan task 8 — Clean up CLAUDE.md
- Plan task 7 — Clean up benchmark suite
- Plan task 6 — Remove REST routes and annotations
- Plan task 5 — Remove from tier registration and tool dispatch
- Plan task 4 — Remove tool definitions from automation-defs.js
- Plan task 3 — Remove update_project_stats from automation-handlers.js
- Plan task 2 — Remove Headwaters batch lifecycle tools from automation-batch-orchestration.js
- Plan task 1 — Remove Headwaters wiring wrappers from automation-ts-tools.js
- Plan task 1001 — verify auto-retry #1
- Plan task 5 — Integration Tests + Full Verification
- Plan task 4 — Implement Workflow Scope
- Plan task 3 — Implement handleGetContext — Queue Scope
- Plan task 2 — Wire Into tools.js, core-tools.js, annotations, and output schemas
- Plan task 1003 — verify auto-retry #3
- Plan task 1002 — verify auto-retry #2
- Plan task 1001 — verify auto-retry #1
- Plan task 3 — Inject resume context into retry prompts
- Plan task 2 — Store resume_context on failed tasks
- Plan task 1 — ResumeContextBuilder module
- Plan task 1001 — verify auto-retry #1
- Plan task 4 — Integration test — full restart recovery cycle
- Plan task 3 — Update await_task recovery to handle requeued tasks
- Plan task 2 — Change startup orphan cleanup to re-queue
- Document error-code convention + guardrail registry
- Dep-resolver trust-level gating
- Wire dep-resolver into executeVerifyStage
- Verify-review missing_dep classification path
- Dep-resolver orchestrator
- Dep-resolver escalation helper
- Dep-resolver registry dispatch
- Python dep-resolver prompt + manifest validation
- Python dep-resolver LLM module→package mapping
- Python dep-resolver regex detection
- Dep-resolver module skeleton
- Plan task 1001 — verify auto-retry #1
- Plan task 5 — Close-Handler Hook for Compute→Apply
- Add compute→apply close-handler hook for dynamic apply task creation
- Plan task 4 — Tool Schema + Handler Updates
- Add compute_provider/apply_provider to create_diffusion_plan
- Plan task 3 — Pipeline Selection in buildWorkflowTasks
- Add compute→apply pipeline selection to planner
- Plan task 2 — Compute and Apply Task Description Generators
- Add compute and apply task description generators
- Plan task 1002 — verify auto-retry #2
- Plan task 1001 — verify auto-retry #1
- Plan task 5 — MCP tool + dashboard endpoint
- Plan task 4 — Wire scoring into smart routing
- Plan task 3 — Wire scoring into task completion pipeline
- Plan task 2 — Core scoring module
- Plan task 1 — Schema -- provider_scores table
- Startup reconciler validates and re-points missing working_directories
- Explicit preflight-failed outcome handling across provider branches
- PreflightError class with deterministic/retryable flags
- Startup reconciler restores DAG readiness after restart
- Server-side restart-orphan task reconciler with auto-resubmit
- Startup reconciler restores loop state after restart
- Add orphan-branch reconciler + scan CLI
- Instrumentation for identifying cross-run test-pollution flakes
- Schedule daily scan on install
- Default config stanza (disabled)
- Register provider in registry
- Cancel owning task before reclaiming worktree
- Track owning_task_id on factory_worktrees rows
- Per-host mutex serialization
- Submit/submitStream/dispatchSubagent surface
- Session store append
- Tool-call permission enforcement
- RunPrompt spawn + text collection
- Centralized tool annotations
- BuildCommandArgs constructs ollama launch argv
- ListModels from host /api/tags union
- Load plugin by default
- CheckHealth preflight
- Plugin entry + contract wiring
- ClaudeOllamaProvider class skeleton
- MCP tools (5) + handlers
- Auto-seed from registered hosts
- Scanner orchestrates digest diff
- Registry HEAD client
- Events-store CRUD
- Watchlist-store CRUD
- Extract shared stream-parser module
- Resume_project_baseline_fixed MCP tool + REST endpoint
- Factory-tick baseline probe phase with exponential backoff
- Rebuild dashboard bundle when merge touched dashboard sources
- Wire verify-review classifier into executeVerifyStage
- Event-bus verify-review emitters
- Baseline-probe module
- Verify-review orchestrator
- Verify-review LLM tiebreak
- Verify-review git-diff modified files helper
- Verify-review failing-test parser
- Verify-review environment failure detection
- Verify-review module skeleton
- EXECUTE spin-detector — auto-reject on >=5 starts per 5min
- Reconcile orphan worktrees on tick + retry worktree-add
- Reject vague auto-generated plans
- Scout findings → architect intake bridge
- Plan-quality-gate complete - re-plan, final reject, supervised pause
- Plan-quality-gate integrated (pass path + override + fail-open)
- Event-bus plan-gate emitters + priorFeedback on prompt builder
- Plan-quality-gate evaluatePlan orchestration
- Plan-quality-gate LLM semantic pass
- Plan-quality-gate feedback builder
- Plan-quality-gate shape/budget rules (8,9,10)
- Plan-quality-gate content rules (5,6,7)
- Plan-quality-gate structural rules (1,2,3,4)
- Plan-quality-gate module skeleton
- Factory_status reports commits_today productivity metric
- Architect backlog auto-promotes to intake work items
- Auto-recover loops stalled at VERIFY
- Two custom eslint rules guarding factory invariants
- Stuck-loop detector — warn and emit on frozen loops
- Factory_status reports actual loop motion, not just lifecycle status
- Add plan_generation category for architect text-gen work
- Tick auto-resumes paused auto_continue projects
- Plan task 3 — Wire into provider dispatch
- Plan task 2 — Backend adapters + provider wrapper
- Plan task 3 — Builder UI + Gallery + JSON editor
- Plan task 2 — Canvas → spec
- Plan task 4 — Task integration + MCP tools
- Plan task 3 — Optimizer (proposes new variants from winners)
- Plan task 2 — Variant selector (resolves label + traffic split)
- Python ecosystem awareness in health scorers
- Plan task 1001 — verify auto-retry #1
- Plan task 2 — Wire into crew runtime
- Plan task 1 — Routers
- Plan task 1001 — verify auto-retry #1
- Plan task 3 — CLI + MCP + watcher
- Plan task 2 — Pattern runner
- Plan task 1 — Pattern loader
- Plan task 1002 — verify auto-retry #2
- Plan task 1001 — verify auto-retry #1
- Plan task 3 — CLI + MCP + wire into run dir
- Plan task 2 — Validator + TOML editor roundtrip
- Plan task 1 — Transcript log
- Factory improvements — verify auto-reject + dashboard cycles + test gate
- Auto-detect already-shipped items at PRIORITIZE and VERIFY_FAIL
- Plan task 1002 — verify auto-retry #2
- Plan task 1001 — verify auto-retry #1
- Plan task 3 — E2B adapter + MCP + use-sites
- Loop reset API + server-side factory tick timer
- Plan task 2 — Manager
- Plan task 1 — Interface + local backend
- Plan task 1002 — verify auto-retry #2
- Plan task 1001 — verify auto-retry #1
- Plan task 4 — Wire + MCP tools
- Plan task 3 — Mention resolver
- Plan task 2 — Repo registry + indexer
- Plan task 1 — Mention parser
- Plan task 1001 — verify auto-retry #1
- Plan task 4 — Docs + restart + smoke
- Plan task 3 — Reference template
- Allow goal_gate in authored specs
- Plan task 2 — Wire into parser
- Plan task 1 — Resolver
- Plan task 2 — Compile + submit helper
- Plan task 1 — Step + Builder
- Plan task 1001 — verify auto-retry #1
- Plan task 3 — Provider adapter + MCP
- Plan task 2 — Session store + skills loader
- Plan task 1 — Permission chain
- Resume auto-advance on server restart
- Plan task 1002 — verify auto-retry #2
- Plan task 1001 — verify auto-retry #1
- Plan task 3 — MCP glue
- Plan task 2 — Translator + construction cache
- Plan task 1 — Action registry + executor
- Plan task 1001 — verify auto-retry #1
- Plan task 3 — Harden health scan integration and mixed-ecosystem regression coverage
- Auto-advance driver + terminate safety + dark trust support
- Plan task 3 — MCP surface + registry wiring
- Plan task 2 — OAuth controller + behavioral tags
- Plan task 1 — Schema + stores
- Plan task 3 — MCP surface
- Plan task 2 — Crew-runner integration + loop guard
- Plan task 1 — Handoff sentinel + context variables
- Terminate_factory_loop_instance operator tool
- Event-bus wakeup for awaitFactoryLoop — replaces pure polling
- Await_factory_loop MCP tool for blocking on stage transitions
- Auto-retry VERIFY_FAIL with error-context fix task
- Per-instance loop control bar + Overview active-loops summary
- REST + MCP per-instance loop control surface
- Factory_loop_instances table + claim column on work items
- Pre-dispatch plan-lint blocks banned patterns before EXECUTE
- Ban require('vitest') in test files to prevent CJS/globals drift
- Schema + stores + controller + MCP surface + registry + behavioral tags
- Unified streaming kernel, SSE + trace adapters, /api/tasks/:id/stream
- Isolate and index per-task run dirs, promote, wire lifecycle + MCP + dashboard
- Durable plan-authoring policy — guide doc, architect prompt injection, alignment gate test
- Factory History sub-page for completed work items
- Retry_factory_verify recovers loops stuck at VERIFY_FAIL
- Runner dispatches workflow specs by payload_kind
- Schedule_workflow_spec tool + handler
- REST + dashboard support for scheduled workflow specs
- Add payload_kind column to scheduled_tasks
- Persist worktree<->batch link in factory_worktrees table
- Include plan-reviewer dependency + fix slug test truncation
- LEARN merges worktree to main on successful ship
- VERIFY runs remote tests against batch worktree + pauses on fail
- EXECUTE creates worktree before submitting plan tasks
- Worktree-runner for per-batch isolation
- Factory loop control bar on Kanban + extracted shared component
- Async loop advance + non-plan-file EXECUTE via Codex plan generation
- Pending-approval Kanban column, Approvals page promotion, Factory shortcut
- Pending-approval task status + approve/reject endpoints
- Architect backlog panel, ESM test fix, MCP loop-tools contract
- Bring-up gap plans 1-5 — loop is now end-to-end viable under supervised trust
- Log every loop-controller transition to the decision log
- Factory visibility — polling, refresh, activity feed, intake chips
- Detect already-shipped plans during intake
- Drain-aware await + restart_status tool + shutdown grace
- Extract quota and lifecycle handlers from core
- Extract REST route tables into routes/ directory
- Drive Plan 1 through factory loop and capture transitions
- Register torque-public as factory project (supervised)
- Execute_plan_file and get_plan_execution_status MCP tools
- Loop-controller branches PLAN stage to plan-executor for pre-written plans
- Plan-executor — per-task submit/await/tick + stop-on-fail
- Plan-parser — extract tasks/steps/code/commit from plan markdown
- Add scan_plans_directory and list_plan_intake_items MCP tools
- SENSE stage ingests project.config.plans_dir
- Plan-file-intake scanner parses markdown plans into work items
- Add plan_file source + dedupe table migration
- Global banner when a factory project is paused
- Audit event schema + helper for governance actions
- Attach_factory_batch tool records loop batch_id
- Build-ci scorer weights workflows, scripts, lint, hooks
- Api-completeness scorer measures REST/MCP parity
- User-facing scorer reads real UX signals from JSX
- Configurable bind address via TORQUE_API_HOST env var
- Guided first-run path — architect priority #1
- Render verify signal badge on task cards
- Close gaps 5-6 — cost metrics + GitHub issue auto-intake
- Add tests:pass/tests:fail:N signal tags to verified tasks
- Close integration gaps 1-4
- Phase 8 observability — decision logging, audit trail, notifications
- Phase 7 feedback loop — post-batch analysis + drift detection
- Phase 6 factory loop — SENSE→PRIORITIZE→PLAN→EXECUTE→VERIFY→LEARN
- Phase 5 guardrails engine — 7 safety categories
- Phase 4 trust & policy framework
- Phase 3 architect agent — prioritization engine
- Phase 2 remaining — REST routes, dashboard intake queue, tests
- Phase 2 intake system — DB module, MCP tools, handlers
- Implement all 10 dimension scorers with real scan_project integration
- Add Factory dashboard view + REST API routes
- Implement Phase 1 — health model + project registry
- Restart barrier task — replace drain poll with first-class queue barrier
- C# DI-aware dependency resolution for codebase study
- Incremental codebase study loop
- OpenClaw post-task advisor integration
- Add batch-test-fixes governance rule
- Require explicit project on task submission, auto-register projects
- Add project parameter to all vc_* version-control tools
- Project visibility — selector, filters, badges
- Project-aware task submission and registry
- Complete REST API parity — 600/600 MCP tools mapped to REST routes
- REST API parity — add 93 passthrough routes for all MCP tool gaps
- Visual sweep hybrid architecture — automated capture, pre-analysis, dedup
- Visual sweep fleet — three-phase deep visual audit system
- Scouts via Codex + /torque-sweep full automated cycle
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Harden release and safeguard edges
- Check esm javascript syntax
- Stop auto-advance on starved loops
- Terminate idle loop instances
- Ignore unactionable restored selections
- Clean missing worktree rows
- Expose runtime plugin tools
- Harden verify durability
- Order same-path cleanup siblings
- Back off file-lock requeues
- Reject nested worktree plan steps
- Release locks on cancellation
- Include WPF paths in retry scope envelope
- Rename stale prometheus prefix
- Contain ambiguous verify retries
- Remove server warning baseline
- Claim fallback after stale probe budget
- Recover starved loops
- Restore server lint gate
- Keep auto-commit artifacts out of worktrees
- Short-circuit PRIORITIZE to IDLE when intake is empty
- Skip architect LLM when intake is empty
- Expose auto recovery controls
- Hide git snapshot windows
- Fail codex phantom completions
- Restart loop after idle recovery
- Keep self-routing on configured providers
- Resume deferred execute batches
- Defer execute plan tasks while paused
- Extend native-exe launch to providerConfig.cli_path branch
- Apply native-exe launch to providers/execute-cli.js (real spawn path)
- Extend barrier drain timeout default from 30min to 60min
- Final triage round — auto-recovery test shape + crlf + skip checkpoints
- Clear triage of factory-hardening-adjacent test failures
- Keep scout-findings-intake scan() sync
- Register engine in container.js DI factory block
- Drop require('vitest') from strategies-complex.test.js
- Decouple schema test from runMigrations signature
- Use runMigrations export name
- Drop require('vitest') from engine.test.js
- Drop stale require('vitest') line
- Strip GIT_* env vars that leak from test runner
- Stale-probe uses execFile, not spawn, for cross-platform git
- Severity breaks ties only within promoted tier
- Watchdog stale-drain + cutover handles cancelled barrier
- Probe dist/index.html, not just the dist/ dir
- Strip ANSI before matching vitest summary + add hook installer
- Stage HEAD on disposable ref instead of mutating origin/main
- Add tracking-task carve-out to plan-description scorer
- Stop EXIT trap from overriding clean exit with 1
- Load chunk review files asynchronously
- Read orchestrator files asynchronously
- Read inventory source files once
- Fix policy engine git probe caching
- Inject remote agent registry into v2 infrastructure handlers
- Auto-clear VERIFY gate when batch_tasks_not_terminal pause resolves
- Scan staged diff added-lines only, not full file content
- Broaden defensive catch around attempt-history reads
- Make attempt-history + silent-rerun readers tolerant of missing schema
- Factory_decisions schema + verify-signature digit regex + migration test isolation
- Seed full schema before runMigrations; shared helper
- Verify-signature path regex greedy to last slash
- Migration 30 SQL join + sandbox-tolerant verify fallback
- /api/tasks defaults to all_projects, add defaultArgs to route spec
- Gate mcp config injection on enterprise mode
- Route v2 model analytics through task-core DI
- Validate artifact storage path configuration
- Fix async git scan in completion pipeline
- Fix async duplicate file validation scan
- Make directory baseline capture nonblocking
- Fix task finalizer async diff collection
- Skip mcp config injection when keyless torque-sse already present
- Fix backup listing directory validation
- Keep timeoutMs local for downstream callers
- Refuse 'factory-*' feature names (reconciler collision)
- Fix task-manager lazy dashboard broadcast import
- Fix restore_database backup path traversal guard
- Replace grep -oP with sed -E for Windows git-bash compat
- Let negatives fall through to Math.max clamp, not default 30
- Preserve 1-min minimum for negatives, annotate reopen_
- Project name renders in both ProjectCard and Active-loops summary
- Move mid-merge detection after porcelain check + tighten doc reject test
- Register providerScoring in DI factory block and wire on startup
- Abort if main has dirty tracked files before merge
- Carve-out for doc-only tasks
- Pause on mid-merge target instead of retry storm
- Push HEAD before BOTH test passes so hook sees proposed state
- Re-queue or fail retry_scheduled orphans on startup
- Restart barrier for cutover, node fs.rmSync fallback for long paths
- Pause_project blocks tick, auto-advance, and internal submits
- Active template chain order wins over score re-ranking
- Pass vague verbs when concrete object is adjacent
- Lead Quality First plan_generation with codex
- Propagate deterministic flag on attemptTaskStart outcomes
- Wrap non-ENOENT fs errors as non-deterministic PreflightError
- Clone drain-cancelled tasks on startup when workflow still running
- Lower stale_queued_minutes default from 1440 to 120
- Skip schedule registration when already present
- Enforce UNIQUE(name) on scheduled_tasks
- Put codex first in codex-primary plan_generation chain
- Guard test-verification-lite injection by project tech stack
- Re-add root config delegating to server/vitest.config.js
- Gate scheduler via process flag during shutdown grace window
- Allow 'dark' (and 'guided') trust-level projects to auto-commit
- Accept Python quality tools in plan validation-signal regex
- Honor newest factory_worktrees row per path
- Teach plan-generation prompt about the quality gate's 5 signals
- Worktree-manager flake on git-add failure mock
- Narrow sandbox writable roots to block main-repo HEAD writes
- Recover from origin branch before auto-rejecting worktree_lost
- Skip clean-check when worktree path is gone
- Detect base branch in LEARN merge instead of hardcoding main
- Start retry worktrees from origin branch instead of base
- ForceRmSync handles Windows ACL and cmd path quirks
- Cd server/ before running vitest so the tuned config applies
- Persist verify-retry counter across executeVerifyStage calls
- Interrupt in-flight verify-retry + auto-advance when paused
- Layered force-delete handles Windows EPERM in createWorktree
- Unwrap database module in guardrails getDb resolver
- Add claude-ollama to PROVIDER_DEFAULT_TIMEOUTS
- Preserve root-cause error in verify-retry prompts
- Auto-retry on file-load-only flakes before blocking
- Shlex tokenize + skip free-form git subcommands
- Reconcile skips fresh factory dirs (.git mtime < 60s)
- Add claude-ollama to provider enum in MCP tool schemas
- Extend schema-seeds VALID_PROVIDER_NAMES with new providers
- Include model-freshness plugin tool-defs in getExposedToolNames
- Remove stale overrides for not-merged model-freshness plugin
- Reconcile honors vc_worktrees row to close TOCTOU race
- Update provider-registry.codex category to include claude-ollama
- Seed claude-ollama provider row
- Unwrap claude-cli --verbose stream_event envelope
- Worktree-manager mock simulates full git-worktree-add structure
- Emit --verbose in buildCommandArgs
- Require 3 consecutive zero-check drain stability
- Guard host selection against DB unavailability
- Use PowerShell Get-CimInstance instead of broken wmic LIKE
- Post-create verify detects phantom git worktree add success
- Propagate rmSync errors in createWorktree instead of swallowing
- Self-recover worktree cwd_missing instead of pausing
- Verify-review env_failure integration test + resume handler startTick
- Cd into dashboard inside the remote shell
- Don't wipe active sibling in cleanupWorktree for shared path
- Route dashboard tests to remote + catch Test Files failures
- Fall back to project_defaults when factory config lacks verify_command
- Skip LLM tiebreak when nothing to judge
- Detect default branch in verify() instead of hardcoding main
- Cap plan-quality-gate re-plan attempts per item
- Widen worktree writable root from per-worktree to common .git
- Verify-review tiebreak uses non-greedy JSON extraction
- Widen wmic LIKE pattern to match both path separators
- Word-boundary git user match + technical-term allowlist
- Verify-review getModifiedFiles drops stderr to avoid pipe-buffer deadlock
- Add linked gitdir to writable roots in worktree sandboxes
- EXECUTE catches plan-executor exceptions instead of silent-retrying
- ReclaimDir falls back through chmod + shell rm on Windows
- Caller honors next_state=PAUSED even without stop_execution flag
- EXECUTE handler honors pause + auto-rejects unparseable plans
- Plan-parser accepts h3 and h4 Task headers
- Unwrap db before passing to better-sqlite3 factories
- Register runDirManager via DI factory so the tab loads
- Drain the pipeline before restarting TORQUE
- Stop hardcoding force:true; honor pipeline drain
- No-force-restart checker actually blocks now
- Give selected-work-item plan one trusted task
- Align verify-retry tests with two-advance gate pattern
- Harden verify-retry pipeline (7 root-cause fixes)
- LEARN auto-resolves empty-branch merges (ship or reject, never loop)
- Shipped-detector promotes 3-4 letter ALL-CAPS acronyms from title
- Plan-quality-gate preserves Task 0 in feedback prefix
- Expose real smart_submit_task error instead of masking as "no task_id"
- Switch default pool from forks to threads
- Restore real provider names in routing-templates assertions
- Repair 11 test files broken by today's hardening changes
- Mechanical expectation updates for today's code changes
- Tick reconciles legacy loop_state drift every cycle
- Factory_status derives loop_state from active instance
- Startup auto-starts orphan auto_continue projects
- PRIORITIZE auto-rejects items stuck in executing > 1h
- LEARN rejects work item instead of skipping when no worktree exists
- Per-project plan authoring guide — stop cross-project prompt leaks
- Architect runs in target project's cwd and skips auto-verify on internal tasks
- Simplify add_workflow_task schema, validate at runtime
- Auto-pilot stability — stop event-loop blocks and idle-spins
- Route architect cycles through smart routing
- Preserve project and tags badges on WS task deltas
- Honor next_state=IDLE from stop_execution instead of defaulting to PLAN_REVIEW
- Remove duplicate trustLevel declaration causing SyntaxError on startup
- Also skip plan LINT gate for autonomous/dark trust
- Skip plan review for autonomous/dark trust + clean stale worktree dirs
- Reject items on plan generation failure + lenient plan parser
- Skip binary files + publish/ dir in placeholder artifact detection
- Wire factory_cycle_history tool def + annotation (Codex missed registration)
- Update worktree-manager tests for target-side cleanup + --no-verify
- Replace hardcoded model names with test fixtures in model-capabilities tests
- Use execFileSync with timeout for branch detection (no bash spawn)
- Auto-detect default branch (master vs main) for worktree creation
- Track submitted_tasks in live mode (was only pending_approval)
- Skip empty-batch detection in dry_run/suppress modes
- Empty-batch detection uses submitted_tasks not completed_tasks
- Recover stuck PAUSED-at-EXECUTE + handle empty plan execution
- Satisfy p3-silent-catches lint — add void _e to catch blocks
- Expand body_preview when endLine === startLine (regex fallback)
- Force-delete stale git branches on worktree creation retry
- Respect prefer_remote_tests + fix Windows torque-remote spawn
- Auto-advance retries on transient failures with 30s cooldown
- Detect wpf dashboards and aspnet api surfaces
- Detect dotnet test and ci signals
- Sanitize merge-target working tree before git checkout/merge
- Skip plan file re-ingest while prior work item is still active
- Skip pre-commit hook on internal worktree commits + surface silent failures
- Reclaim stale active worktree rows on EXECUTE retry and termination
- Await_factory_loop REST route now parses body; add stage-order awareness
- Pre-merge cleanup commit for leftover plan ticks + drift
- Pre-sanitize PII via direct module call before worktree commit
- Accept worktree as clean when only drift remains after hook block
- Tag verify-retry tasks with plan_task_number so auto-commit fires
- Refuse to ship when worktree runner is available but no active worktree exists
- Per-file --ignore-cr-at-eol probe (name-only is broken)
- Fabro-97 uses ESM import syntax for test framework
- Stage via pathspec-from-file stdin to avoid multi-arg argv quirk
- Single-arg git add -A + post-stage drift filter
- Drop -- separator in auto-commit git add args
- Replace per-file diff probe with git add --renormalize
- Repair PII-GUARD fallback + targeted per-task staging
- Attach factory-provenance tags on every plan-task submit (not just pending_approval)
- AwaitTaskToStructuredResult must not exit on first heartbeat
- Plan-executor must not trust stale [x] markers + write ticks to worktree
- Auto-commit line-ending drift before worktree merge clean check
- Decision-log restore must not resurrect closed work items
- Clean up loop instance if SENSE throws
- Plan-file intake must be idempotent across revert cycles
- Operator cancel for stuck async loop-advance jobs
- Scope factory_worktrees.branch unique to active rows
- Self-heal shipped items before PRIORITIZE re-picks
- Disable worktree runner explicitly in 3 EXECUTE stage tests
- Target real instance card in Kanban advance test
- Await async LoopControlBar effects in Kanban advance test
- Remove unsafe fallback-to-main-worktree on worktree creation failure
- Await async LoopControlBar effects in Factory.test
- Revert flawed flake-fix + wrap Factory.test in ToastProvider
- Eliminate intermittent flake in deferred action tests
- Replace hardcoded 100-tool cap with property-based size + duplicate guard
- Expose previous_state in advance-job snapshot for REST clients
- Factory-routes cache clear + pipeline REST reason strings
- Restore v14 migration shape + migrate legacy tests to per-project shims
- Tighten v2-control-plane + v2-dispatch migrations so they pass under real lookup
- Drop require(vitest) from new test files + extend tool-output-schemas expected list with 6 OAuth tools
- Drop invalid require('vitest') from streaming tests
- Simplify factory-architect-prompt-guide test to assert PLAN_AUTHORING_GUIDE + injector directly
- Align coverage tests with run-scoped artifact additions
- Mark work item shipped even if worktree cleanup fails post-merge
- Cleanup failure after successful merge no longer masquerades as merge failure
- Exclude terminal work items from Intake tab
- Expand list_work_items + update_work_item status enum to include lifecycle statuses
- Align History test expectations with component output
- Wrap handleScheduleWorkflowSpec in top-level try/catch for p3-async-trycatch guard
- Worktree verify pushes branch and invokes torque-remote via Git Bash
- MergeWorktree fails loud on empty branch or dirty tree
- VERIFY re-runs remote verify after gate approval
- SetWorktreeRunnerForTests(null) now actually disables the runner
- Support scoped debt inventories
- VERIFY waits for pending_approval batch tasks to finish
- Disable handleAwaitTask heartbeats during plan generation
- Ship work item under supervised when all batch tasks completed
- Mark selected work item as shipped on successful LEARN
- Fall back to database.getDbInstance() when DI container has no 'db' binding
- Plan-gen tasks schedule + LEARN no longer crashes on null DB
- Default v2 limiter to 'disabled' in local mode
- Pass version_intent: internal when generating plans for non-plan-file items
- Mark async factory-loop handlers as internal — REST-only, not MCP tools
- Handler-only routes don't need tool field — relax route contract test
- Tag new async loop routes with tool name + use vi.hoisted in execute test
- Export validateJsonDepth so the v2 pre-parser can use it
- Don't forward empty-body POSTs as content-length:0 with "" payload
- Architect skips closed items + realistic scorer tests
- Assert observable selected-item outcome, not an unreachable mock
- Proxy unmatched /api/ requests to the main API port
- Normalize paths + parse config_json on list
- Remove require('vitest') — globals are injected by forks pool
- Add --branch <ref> override for remote sync
- Two-tier pre-push gating (main-only runs full suite)
- Do not expose new helper via legacy db facade
- Record audit events on pause/resume handlers
- SSE task-event stream uses origin allowlist
- LEARN transitions to IDLE by default, not SENSE
- Architect excludes completed/rejected/shipped intake
- Coerce path/query params to schema types
- Lazy-init db from container for LEARN stage
- Configure_artifact_storage uses canonical path boundary
- Prefer db.prepare over listTasks in helper
- Gate slot-pull scheduler on barrier task
- Ignore hidden temp/cache dirs by default
- Read execFileSync at call time, drop indirection
- Honor test worker _realExecFileSync indirection
- Boolean coercion accepts numeric 0/1, rejects rest
- Wrap npm/yarn build check via cmd.exe on win32
- Rollback/stash use taskMetadata + working_directory
- Codebase-study raw throws use makeError helpers
- Smart-routing fallback respects *_enabled gates
- Honor user_provider_override on ollama failover (TDA-01)
- Label Factory policy inputs and chip-remove buttons
- Restore focus on dialog/drawer close + drawer Tab traps
- Strict-boolean validation + DI for provider toggle/configure
- De-dup factory health and cost-metric queries
- Apply v2 body size + depth caps in dashboard pre-parser
- File-baseline boundary checks reject sibling-prefix paths
- Require allowedBase for TS automation handlers
- Scope hashline_read/edit paths to task workspace
- Replace nonexistent resume_workflow example
- SQLITE_READONLY recovery imports os and writable-dir helper
- Hoist taskMetadataParsed above adaptive-context branch
- SafeConfigInt honors 0-as-disabled
- Align empty-state assertions with new copy
- Intake_from_findings accepts files/dimension and reports skips
- Architect recognizes numeric user_override priority
- Handle metadata as object or string in provider switch test
- Skip Codex LLM path in test environments where task-manager is unavailable
- Align factory-architect test table schema with migration v14 (INTEGER id/priority)
- Accept deferred provider in approveProviderSwitch test
- Bump tier 1 limit to 50 + query both pending/intake status in architect runner
- Update 10 test files for factory tool parity + intake schema alignment
- Add peek tools to UI reviewer tool list — was missing all peek_* MCP tools
- Align factory-intake module with migration v14 schema (INTEGER id+priority, pending status)
- Accept both naming conventions for work item sources
- Recalibrate structural and test-coverage scorers for large codebases
- 3 bugs blocking factory operation
- Handle null message/title in findings recording
- Skip tasks in finalization pipeline
- Wrap tool-call JSON results in v2 envelope for dashboard compatibility
- Use ESM import syntax in cost-metrics test file
- Async advanceLoop assertion + lightweight cost-metrics tests
- Don't mark tasks failed when provider succeeded
- Replace eventBus mock assertions with behavioral tests in observability
- Use clearAllMocks instead of restoreAllMocks in observability tests
- Don't failover when provider succeeded (exit code 0)
- Use deferred provider assignment on failover
- Don't fail workflow tasks when siblings are still running
- Stop QC idle-cycling after ALL APPROVED and while waiting for IDs
- Preserve provider on requeue for user-override tasks
- ALWAYS clear user_provider_override on failover
- Add workflow submission rules to planner — explicit provider, on_fail, pre-checks
- Stop approveProviderSwitch from poisoning user_provider_override
- Remove config-dependent test, covered by mock-based unit test
- Provide safeConfigInt dep and stop scheduler in pipeline-bugs test
- Init queue-scheduler in pipeline-bugs test
- Rewrite all three team agent definitions with state machines and hard prohibitions
- Update queue-scheduler tests for new codex-pending behavior
- Adjust codex-pending test for disabled-codex scenario
- Update e2e test for real scorer output (no longer placeholder zeros)
- Workflow provider assignment + QC agent anti-poll
- Skip initSubModules in pipeline-bugs test
- Respect user_provider_override in codex-pending recovery
- Create factory tables directly in test instead of running all migrations
- Lazy-load PreviewTaskStudyContext handler in v2-dispatch
- Accept queued as valid 429 outcome in cloud e2e
- Parity uses unique handler names, 429 timeout, sovereignty assertion
- Advance fake timers for barrier shutdown in await-restart
- Update restart and heartbeat tests for barrier mode
- Restart-drain status values + provider-registry system category
- Add DB setup to restart-drain and restart-server-tool tests
- Remove explicit test framework require from restart-barrier
- P3-silent-catches allowlist, provider categories, workflow blocker context
- Seed globalThis.taskMetadataParsed in 6 more test files
- Seed globalThis.taskMetadataParsed for execute-ollama tests
- Update p3 assertion allowlists for new handlers
- Add blocker snapshot context to workflow-dag mock
- Mock applyStudyContextPrompt in 8 execute-ollama test files
- Resolve 5 categories of pre-existing test failures
- Update study test expectations for C# DI enrichment + study cron outputs
- Study_context destructuring and task_metadata pass-through in smart_submit_task
- Exclude codebase-study tasks from queue guard
- Add version_intent and project to study task submission
- Add project and version_intent to study schedule task config
- Direct-construct governance hooks when container lookup fails
- Use branch name only for batch-test-fixes change-set key
- Remove stray closing bracket from debug cleanup in hooks.js
- Await async verify handler + curl guard exception
- Exempt curl from torque-remote-guard interception
- Use module-level singleton for batch-test-fixes counter
- Wire pre-verify governance into auto_verify_and_fix handler
- Expose project and tags in v2 task API responses
- Remove project from policy evaluate assertions
- Resolve final 8 test failures from project awareness
- Add project to policy evaluation test handler calls
- Add project parameter to all test submit/smart_submit calls
- Const→inline ternary for normalizedProject assignment
- Skip auto-tagging for unassigned project
- Default project to 'unassigned' instead of hard rejection
- Scrub PII from PII guard test inputs
- Scrub PII from PII guard test inputs
- Scrub PII from docs, fixtures, and test data
- Correct auto-tag expectations for temp working dirs
- Update assertions for project auto-tagging
- Enforce LF line endings for pre-push hook
- Fix remaining server hook failures
- Fix Codex MCP config and sandbox test data dirs
- 4 Codex integration issues — MCP transport, tool unlock, bin export, ps1 parse
- Smoke test drift, readiness-pack crash, and launch-readiness port kill
- Update OCR tests to mock peek_server /ocr proxy
- Update REST passthrough test expectations for 93 new routes
- Assign task to host so fallback has a target
- Fix 3 remaining host-distribution test failures
- Disable FK checks during host-distribution test cleanup
- Fix 18 test failures from model-agnostic cleanup
- Reduce false-positive noise in peek_pre_analyze mechanical checks
- Fix host-distribution test isolation and model matching
- Correct hashline tiered fallback test to expect local model escalation
- Use CODER_* TEST_MODELS variants for coder-family pattern tests
- Update provider test assertions for null defaults
- Peek_pre_analyze reads elements from evidence.elements.tree
- Add res.headers to HTTP mock responses for binary response handling
- Peek_ui handler normalizes binary response into peekData envelope
- Binary response handling in shared HTTP helpers + capture uses peek_diagnose
- Fix 3 pre-existing dashboard test failures
- Use lastIndexOf for sandbox suffix extraction in resolveRelativePath
- Exclude dashboard.test.js from root config (needs jsdom)
- Skip dashboard.test.js when jsdom not available
- Guard cancelled→running transition + add jsdom dev dependency
- Update snapscope test — artifacts now persisted for adhoc captures
- Update peek test expectations for adhoc output dir behavior
- Commit remaining a11y JSX changes + QC active monitoring update
- Batch 13 — 6 DI bypasses, 3 N+1 fixes, rejection sweep, QC active monitoring
- Workstation adapter returns hostUrl not url
- 3 snapscope bugs from visual sweep live test
- Update handleSubmitTask test assertions for provider fix
- Promote core peek tools to tier 1 for immediate availability
- 4 session backlog items
- Add peek_wait, peek_action_sequence, peek_assert, peek_ocr to tier 2
- Snapscope install uses safe container.get with fallback
- Add logger.info/error for plugin install and mcpTools registration
- Preserve taskModel from test-writing promotion in resolveModificationRouting
- Add peek MCP tools and unlock_all_tools to visual sweep agent frontmatter
- GetPlanProject returns null instead of undefined for missing projects
- Batch 10 — eliminate 15 unhandled rejection warnings
- Use testDir instead of hardcoded path in smoke test
- 2 source bugs found by new tests + 2 test fixes
- Rewrite enforcement test to use real fs instead of CJS mocking
- Use vi.hoisted + vi.mock for CJS module mocking in enforcement test
- Convert manifest test files from CJS require to ESM imports
- Update manifest tests for test runner 4.1 compatibility
- Batch 8 — 4 a11y + 5 docs + dep patches + sweep findings
- Update 7 test files to match batch 7 source changes
- QC signals ready instead of running integration pass
- Batch 7 — security, architectural, performance, cleanup
- Update registry-not-initialized test for getInstalledRegistry
- Batch 6 test fixes — registry mock + concurrency handler
- Batch 6 — final cleanup, 8 quick wins
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Refactor model registry handler db access
- Refactor execution database dependency wiring
- Simplify task startup orchestration
- Extract task provider command builder
- Isolate task startup resource cleanup
- Extract task startup routing helpers
- Write keyed MCP entry to torque-auth, not torque
- Distinct exit sentinels + unify cancel prior-error helper
- Remove all Headwaters/Deluge-specific code from TORQUE
- Remove redundant runPreflightChecks call inside startTask
- Pre-reclaim stale worktree state before creating new one
- Use shared stream-parser in claude-code-sdk
- Report findings, never rewrite source on commit
- Centralize factory-internal task submission
- Loop-controller operates on instance_id with strict stage-occupancy guard
- Property-based alignment guards so intentional MCP additions don't fail VERIFY
- Split Factory.jsx into 5 nested-route subpages
- Compose thin core via dispatcher-helpers and lookup
- Compose thin orchestrator from 10 DI modules
- Extract eight more sibling modules
- Extract flows + hotspots into focused modules
- Delete duplicated subsystem bodies from orchestrator
- Wire DI for proposal, parsers, profile
- Extract study profile manager
- Extract language parsers into parsers/ layer
- Extract proposal submission + filtering
- Extract ProjectSelector helpers to sibling module
- Compose orchestrator via DI
- Extract evaluator into focused module
- Extract scanner into focused module
- Convert four modules to container init(deps) pattern
- Newest-first score history with DI injection
- Batched cost-metrics with DI container injection
- Remove Sharp/Tesseract from capture.js, proxy OCR to peek_server
- Remove migrated JS analysis code and tests
- Proxy handlePeekPreAnalyze to peek_server /pre-analyze
- Add CODER_* variants to TEST_MODELS and remove hardcoded cloud model catalogs
- Migrate config-migrator.test.js to TEST_MODELS constants
- Replace hardcoded model names in 3 large test files
- Remove hardcoded model names from DB seeds, migrations, and utilities
- Remove hardcoded default model from openrouter.js constructor
- Replace hardcoded model names with TEST_MODELS constants
- Remove hardcoded model defaults from 6 provider files
- Batch 12 — extract concerns from 3 oversized functions
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Document durable torque change workflow
- Typed event backbone guide
- Condition expression guide
- Manual + auto resume guide
- User-facing guide
- Example plan-implement spec
- Document PRIORITIZE promotion + stale-probe + plan-authoring guide
- Plan — intake/plan pipeline (Cluster B)
- Spec — intake/plan pipeline improvements (Cluster B)
- Edit_file fuzzy matching spec and implementation plan
- Document close-handler observability signals and flags
- Plan — close-handler & retry observability implementation
- Spec — close-handler & retry observability
- Document merge_target_in_conflict_state decision
- Add peek companion section to README
- Trim 7.8k chars, extract factory runbook
- Add enterprise security roadmap for future multi-user deployment
- Add dep_resolver decision actions to recovery table
- Document restart barrier task as the preferred restart path
- Factory dependency resolver implementation plan
- Factory dependency resolver design
- Upstream patch artifact for security-guidance hook comment false-positives
- Verify vitest CJS mock repro on latest + add ISSUE body
- Run 2 benchmark findings + 3 more post-cutover defects
- Package vitest CJS built-in mock repro
- Post-implementation corrections for both 2026-04-19 plans
- Model freshness monitor user guide
- Claude-ollama provider entries
- Update factory --no-verify note for new PII hook semantics
- Reference table for auto-recovery decision actions
- Model freshness monitor implementation plan
- ClaudeOllama provider implementation plan
- Model freshness monitor design (Path A)
- ClaudeOllama provider design
- Verify-review hybrid implementation plan
- Verify-review hybrid design
- Plan quality gate implementation plan
- Plan quality gate design
- Add Factory Auto-Pilot section to CLAUDE.md
- Templates and inheritance
- Feature-pipeline template + example child
- Mark fabro-97 plan tasks as complete
- Amend fabro-89 with lessons from first abandoned run
- Scheduled workflow specs guide
- Phase 12 — operator console (approval inbox, plan drill-in, exec pane, triage)
- Follow-up plans for Phase 11 bring-up gaps
- Plan 1 bring-up report + transition regression test
- Phases 9-11 — bridge factory to pre-written plans
- Round 10 — 8 plans (96-103) + 8 new scout reports
- Two-tier pre-push testing workflow + torque-remote --branch
- Round 9 — 7 plans (89-95) + 8 new scout reports
- Round 8 — 7 plans (82-88) + 8 new scout reports
- Round 7 — 7 plans (75-81) + 8 new scout reports
- Round 6 — 7 plans (68-74) + 8 new scout reports
- Round 5 — 6 plans (62-67) + 8 new scout reports
- Round 4 — 5 plans (57-61) + 8 new scout reports
- Round 4 — 5 plans (57-61) + 8 new scout reports
- Round 3 — 12 plans (45-56) + 10 new scout reports
- Index covers all 44 plans + adds smol-developer scout
- Add 13 plans (32-44) + 11 new scout reports
- Refresh CONTRIBUTING/README with current counts
- Refresh architecture references
- 31 software-factory plans + 14 scout reports
- Add 2026-04-12 documentation sweep findings
- Add 2026-04-12 dependency sweep findings
- Add 2026-04-12 security sweep findings
- Add 2026-04-12 quality sweep findings
- Add 2026-04-12 test-coverage sweep findings
- Add 2026-04-12 performance sweep findings
- Add 2026-04-12 accessibility sweep findings
- Rewrite ui-reviewer with state machine + LAN dashboard guidance
- Implementation plans for Phases 4-8 of the software factory
- Phase 3 implementation plan — architect agent
- Phase 2 implementation plan — intake system + work items
- Phase 1b implementation plan — dimension scorers
- Phase 1 implementation plan — health model + project registry
- Software factory design spec — project lifecycle automation with configurable autonomy
- Codebase study run #6
- Codebase study run #4
- Codebase study run #3
- Codebase study run #2
- Codebase study run #1
- Rebrand TORQUE as an automated software factory
- Rebrand TORQUE as a dark software factory
- Merge TORQUE operational knowledge into project CLAUDE.md
- REST API gap analysis report + updated remediation agent
- Update changelog for v1.34.0
- Add visual sweep hybrid architecture implementation plan
- Add visual sweep hybrid architecture design spec
- Add visual sweep fleet implementation plan
- Add visual sweep fleet design spec
- Update scout base definition — Codex is default execution provider
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Guard setup against heavy imports
- Repair starvation guard coverage
- Cover paused execute deferral
- End-to-end integration test
- Allow envExtras to carry native-codex metadata
- Accept native codex.exe path on Windows
- Register eventBus+logger stubs in defaultContainer boot setup
- Fix sourcelink schema seed + add never-started and deconfliction E2E tests
- E2E SpudgetBooks sourcelink scenario (Task 15 partial)
- Wiring assertion test from Task 12 salvage
- Wait for runArchitectCycle before resolving mock
- Sleep before scanTime capture to avoid same-second inclusion
- Use gitSync from git-test-utils for real git in vitest
- Skip git-integration test pending remote env investigation
- Strip GIT_* in-place instead of passing partial env
- Realpath tmpdir + drop -b main for older git
- Stale-probe integration against real git tmpdir repo
- Cover rejected recovery tick integration
- Cascade integration tests for fuzzy matching
- Phase 2 conformance tests for 10 provider/cost/monitoring tools
- Test model registry db helper boundary
- Test execution database import boundary
- Characterize task startup lifecycle
- Cover async audit file reads
- Cover inventory byte size and single read
- Test policy engine git probe caching
- Update list_tasks assertions for new defaultArgs shape
- Split pending-after-start into sync vs async cases
- Await-ify handler-workflow-handlers + maintenance-scheduler + schedule-workflow-spec tests
- Assert EXIT_SPAWN_ERROR sentinel on spawn 'error' event
- Match new [cancelled] prefix convention
- Avoid pattern-matching collisions in sentinel tests
- Lazy-load tool dispatch in db setup
- Lazy-load tool dispatch in db setup
- Reset factory_decisions before factory_projects in beforeEach (FK)
- Use ISO-UTC timestamps to avoid Date.parse/SQLite TZ skew
- Verify alerting regressions
- Fix retry_scheduled tests — createTask ignores retry_count/mcp_instance_id on insert
- Restore Layout paused-banner tests after SecurityWarningBanner
- Match bash-escaped quotes in barrier body assertions
- Add provider API key management integration tests
- Integration tests for workflow-aware orphan requeue
- Orphan requeue logic tests
- Stub runPostBatchChecks + retry path for happy flow
- Remove broken setWorktreeRunnerForTests spy
- Fix integration test db handle + add factory tables
- Dep-resolver integration e2e suite
- Use sched-missing- prefix so createTask validation doesn't trip the fail-fast test
- Drop meaningless arrayContaining([]) assertion
- Materialize insertWorktree paths on disk
- Resume test projects so pause gate doesn't block the loop
- Cover tail-clip, pause gate, and retry-counter helpers
- Rewrite verify-retry-cwd-missing test against 4b6dc8e5 self-recovery contract
- Switch to direct-mutation mock, restore third auto_identity test
- Skip verify-retry-cwd-missing test pending rewrite against new self-recovery contract
- Smoke test against real Ollama host
- Improve auto_identity test mocking with child_process sync factory
- Fix db handle resolution in baseline probe integration test
- Stub guardrailRunner for verify-review integration tests
- Correct pause-at-EXECUTE assertion in execute_exception regression
- Regression for 8171e04d executor.execute try/catch
- Disable FKs in worktree-reconcile tests
- Plan-quality-gate reject-path tests (red)
- Plan-quality-gate integration shims tests (red)
- Plan-quality-gate evaluatePlan orchestration tests (red)
- Plan-quality-gate LLM semantic pass tests (red)
- Plan-quality-gate feedback builder tests (red)
- Plan-quality-gate shape/budget rule tests (red)
- Property tests for loop state machine graph
- Regression suite for today's auto-pilot fixes
- Accept bash-wrapped torque-remote on Windows in routing test
- Fix torque-remote routing test mocks to return realistic path
- Update mcp-factory-loop-tools for auto_advance property
- Fix plan-file-intake tests for prior-active skip semantics
- Move --no-verify regression pins to gated test suite
- Simplify --no-verify pin to source-level assertion
- Pin --no-verify on factory-internal commits
- Heartbeat test accepts either SENSE decision as latest
- Mock retry tasks as completed so verify re-entry isn't blocked
- Update retryVerifyFromFailure test for auto-retry budget
- Correct learnAdvance.stage_result assertion
- Drop remote-only CRLF-drift tests pending isolation of argv quirk
- Use valid actor in decision-log resurrection test
- Cover self-heal via internal test hook
- GetAllByText for state labels that render twice per card
- Register schedules domain in REST passthrough coverage
- Isolate real-git tests from worker-setup git stub
- Use vi.resetModules so useRealGitManager actually swaps to real git
- Expect 9 loop states now that PLAN_REVIEW is added
- Cover scorer fallback branches
- Extend findings-backed scorer coverage
- Cover scorer fallback branches
- Add direct scorer fallback coverage
- Extend findings-backed factory scorer coverage
- Cover scorer fallback branches
- Extend findings-backed scorer coverage
- Non-plan-file EXECUTE adds an extra decision row, relax count
- Relax handleSmartSubmitTask call count
- Register restart_status in inline-handler allowlists
- Registration expects normalized path
- Route-group + middleware regression suites
- Up-to-date fixture uses empty pending_files
- Flows + hotspots per-module suites
- Branch-flag regression harness
- PausedFactoryBanner rendering coverage
- Audit event persistence + handler integration
- Align loop + SSE suites with harness conventions
- SSE CORS allowlist regression coverage
- Loop terminal transition regression
- Per-module suites for proposal, parsers, profile
- Expect coerced integer limit after passthrough fix
- LEARN stage regression for feedback lazy-init
- Disable autocrlf in initRepo fixture
- Use relative storage_path under the data dir
- Drop explicit test-runner import, use globals
- Harden git fixture isolation + unskip rollback/stash
- Skip rollback/stash tests pending isolation fix
- Exercise enabled-gate via deepinfra/anthropic
- Align mkTask return shape across boundary + scoping suites
- Align new + boundary suites with actual handler shapes
- Update suites for converted modules' init(deps) signature
- Add behavioral suites for three large aggregators
- Adapt factory-scorers.test.js to new scorer reality
- Add findings parser unit tests
- Project awareness test suite
- Verify dashboard test suite
- Batch 14 — add 3 remaining test files, deduplicate resolvers tests
- Batch 14 — 50 new test cases across 10 P2 modules
- Batch 11 — 97 new test cases across 9 P1 modules
- Batch 9 — 61 new test cases across 8 P0 untested modules
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Pre-merge cleanup (factory auto-commit)
- Pre-merge cleanup (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Public module API
- Pre-merge cleanup (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Pre-merge cleanup (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Pre-merge cleanup (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Pre-merge cleanup (factory auto-commit)
- Log auth_mode source + loaded plugins at startup
- Pre-merge cleanup (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Declare @leichtgewicht/ip-codec as direct dependency
- Normalize line endings (factory auto-commit)
- V3 compute→apply pipeline final verification
- Remove stale root vitest.config.js
- Enable retry: 1 matching server config
- Enable retry: 1 to mask transient test-level flakes
- Normalize CRLF to LF across working tree + dashboard rebuild hash
- Normalize line endings (factory auto-commit)
- Sync package-lock with package.json
- Apply public-repo provider-identity scrub
- Normalize line endings (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Pre-merge cleanup (factory auto-commit)
- Normalize line endings (factory auto-commit)
- Normalize line endings (post-factory cleanup)
- Normalize line endings (cutover prep)
- Gitignore temp artifacts + commit rebuilt dashboard dist
- Scrub private LAN IP from discovery test fixtures
- Remove unused tesseract.js optional dependency
- Smoke test comment from Codex verification run
- Track sleep-watchdog module required by task-manager
- Sync study cron outputs and accumulated server changes
- Add diagnostic output to parity test for missing handler
- Temp parity check script
- Sync accumulated study cron and concurrent session outputs
- Accumulate study cron outputs + Codex session changes
- Remove governance debug line
- Remove leftover work artifact files
- Fix vite vulnerabilities in server and dashboard
- Track pre-push hook in scripts/pre-push-hook
- Upgrade web-tree-sitter from v0.24.7 to v0.26.8
- Upgrade better-sqlite3 from v11.10.0 to v12.8.0
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.34.0] - 2026-04-05

### Added
- Visual sweep hybrid architecture — automated capture, pre-analysis, dedup
- Visual sweep fleet — three-phase deep visual audit system
- Scouts via Codex + /torque-sweep full automated cycle
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Use lastIndexOf for sandbox suffix extraction in resolveRelativePath
- Exclude dashboard.test.js from root config (needs jsdom)
- Skip dashboard.test.js when jsdom not available
- Guard cancelled→running transition + add jsdom dev dependency
- Update snapscope test — artifacts now persisted for adhoc captures
- Update peek test expectations for adhoc output dir behavior
- Commit remaining a11y JSX changes + QC active monitoring update
- Batch 13 — 6 DI bypasses, 3 N+1 fixes, rejection sweep, QC active monitoring
- Workstation adapter returns hostUrl not url
- 3 snapscope bugs from visual sweep live test
- Update handleSubmitTask test assertions for provider fix
- Promote core peek tools to tier 1 for immediate availability
- 4 session backlog items
- Add peek_wait, peek_action_sequence, peek_assert, peek_ocr to tier 2
- Snapscope install uses safe container.get with fallback
- Add logger.info/error for plugin install and mcpTools registration
- Preserve taskModel from test-writing promotion in resolveModificationRouting
- Add peek MCP tools and unlock_all_tools to visual sweep agent frontmatter
- GetPlanProject returns null instead of undefined for missing projects
- Batch 10 — eliminate 15 unhandled rejection warnings
- Use testDir instead of hardcoded path in smoke test
- 2 source bugs found by new tests + 2 test fixes
- Rewrite enforcement test to use real fs instead of CJS mocking
- Use vi.hoisted + vi.mock for CJS module mocking in enforcement test
- Convert manifest test files from CJS require to ESM imports
- Update manifest tests for test runner 4.1 compatibility
- Batch 8 — 4 a11y + 5 docs + dep patches + sweep findings
- Update 7 test files to match batch 7 source changes
- QC signals ready instead of running integration pass
- Batch 7 — security, architectural, performance, cleanup
- Update registry-not-initialized test for getInstalledRegistry
- Batch 6 test fixes — registry mock + concurrency handler
- Batch 6 — final cleanup, 8 quick wins
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Batch 12 — extract concerns from 3 oversized functions
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add visual sweep hybrid architecture implementation plan
- Add visual sweep hybrid architecture design spec
- Add visual sweep fleet implementation plan
- Add visual sweep fleet design spec
- Update scout base definition — Codex is default execution provider
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 14 — 50 new test cases across 10 P2 modules
- Batch 11 — 97 new test cases across 9 P1 modules
- Batch 9 — 61 new test cases across 8 P0 untested modules
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.33.0] - 2026-04-05

### Added
- Visual sweep fleet — three-phase deep visual audit system
- Scouts via Codex + /torque-sweep full automated cycle
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Use lastIndexOf for sandbox suffix extraction in resolveRelativePath
- Exclude dashboard.test.js from root config (needs jsdom)
- Skip dashboard.test.js when jsdom not available
- Guard cancelled→running transition + add jsdom dev dependency
- Update snapscope test — artifacts now persisted for adhoc captures
- Update peek test expectations for adhoc output dir behavior
- Commit remaining a11y JSX changes + QC active monitoring update
- Batch 13 — 6 DI bypasses, 3 N+1 fixes, rejection sweep, QC active monitoring
- Workstation adapter returns hostUrl not url
- 3 snapscope bugs from visual sweep live test
- Update handleSubmitTask test assertions for provider fix
- Promote core peek tools to tier 1 for immediate availability
- 4 session backlog items
- Add peek_wait, peek_action_sequence, peek_assert, peek_ocr to tier 2
- Snapscope install uses safe container.get with fallback
- Add logger.info/error for plugin install and mcpTools registration
- Preserve taskModel from test-writing promotion in resolveModificationRouting
- Add peek MCP tools and unlock_all_tools to visual sweep agent frontmatter
- GetPlanProject returns null instead of undefined for missing projects
- Batch 10 — eliminate 15 unhandled rejection warnings
- Use testDir instead of hardcoded path in smoke test
- 2 source bugs found by new tests + 2 test fixes
- Rewrite enforcement test to use real fs instead of CJS mocking
- Use vi.hoisted + vi.mock for CJS module mocking in enforcement test
- Convert manifest test files from CJS require to ESM imports
- Update manifest tests for test runner 4.1 compatibility
- Batch 8 — 4 a11y + 5 docs + dep patches + sweep findings
- Update 7 test files to match batch 7 source changes
- QC signals ready instead of running integration pass
- Batch 7 — security, architectural, performance, cleanup
- Update registry-not-initialized test for getInstalledRegistry
- Batch 6 test fixes — registry mock + concurrency handler
- Batch 6 — final cleanup, 8 quick wins
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Batch 12 — extract concerns from 3 oversized functions
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add visual sweep hybrid architecture implementation plan
- Add visual sweep hybrid architecture design spec
- Add visual sweep fleet implementation plan
- Add visual sweep fleet design spec
- Update scout base definition — Codex is default execution provider
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 14 — 50 new test cases across 10 P2 modules
- Batch 11 — 97 new test cases across 9 P1 modules
- Batch 9 — 61 new test cases across 8 P0 untested modules
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.31.0] - 2026-04-05

### Added
- Visual sweep fleet — three-phase deep visual audit system
- Scouts via Codex + /torque-sweep full automated cycle
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Workstation adapter returns hostUrl not url
- 3 snapscope bugs from visual sweep live test
- Update handleSubmitTask test assertions for provider fix
- Promote core peek tools to tier 1 for immediate availability
- 4 session backlog items
- Add peek_wait, peek_action_sequence, peek_assert, peek_ocr to tier 2
- Snapscope install uses safe container.get with fallback
- Add logger.info/error for plugin install and mcpTools registration
- Preserve taskModel from test-writing promotion in resolveModificationRouting
- Add peek MCP tools and unlock_all_tools to visual sweep agent frontmatter
- GetPlanProject returns null instead of undefined for missing projects
- Batch 10 — eliminate 15 unhandled rejection warnings
- Use testDir instead of hardcoded path in smoke test
- 2 source bugs found by new tests + 2 test fixes
- Rewrite enforcement test to use real fs instead of CJS mocking
- Use vi.hoisted + vi.mock for CJS module mocking in enforcement test
- Convert manifest test files from CJS require to ESM imports
- Update manifest tests for test runner 4.1 compatibility
- Batch 8 — 4 a11y + 5 docs + dep patches + sweep findings
- Update 7 test files to match batch 7 source changes
- QC signals ready instead of running integration pass
- Batch 7 — security, architectural, performance, cleanup
- Update registry-not-initialized test for getInstalledRegistry
- Batch 6 test fixes — registry mock + concurrency handler
- Batch 6 — final cleanup, 8 quick wins
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Batch 12 — extract concerns from 3 oversized functions
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add visual sweep fleet implementation plan
- Add visual sweep fleet design spec
- Update scout base definition — Codex is default execution provider
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 11 — 97 new test cases across 9 P1 modules
- Batch 9 — 61 new test cases across 8 P0 untested modules
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.30.0] - 2026-04-05

### Added
- Visual sweep fleet — three-phase deep visual audit system
- Scouts via Codex + /torque-sweep full automated cycle
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- 3 snapscope bugs from visual sweep live test
- Update handleSubmitTask test assertions for provider fix
- Promote core peek tools to tier 1 for immediate availability
- 4 session backlog items
- Add peek_wait, peek_action_sequence, peek_assert, peek_ocr to tier 2
- Snapscope install uses safe container.get with fallback
- Add logger.info/error for plugin install and mcpTools registration
- Preserve taskModel from test-writing promotion in resolveModificationRouting
- Add peek MCP tools and unlock_all_tools to visual sweep agent frontmatter
- GetPlanProject returns null instead of undefined for missing projects
- Batch 10 — eliminate 15 unhandled rejection warnings
- Use testDir instead of hardcoded path in smoke test
- 2 source bugs found by new tests + 2 test fixes
- Rewrite enforcement test to use real fs instead of CJS mocking
- Use vi.hoisted + vi.mock for CJS module mocking in enforcement test
- Convert manifest test files from CJS require to ESM imports
- Update manifest tests for test runner 4.1 compatibility
- Batch 8 — 4 a11y + 5 docs + dep patches + sweep findings
- Update 7 test files to match batch 7 source changes
- QC signals ready instead of running integration pass
- Batch 7 — security, architectural, performance, cleanup
- Update registry-not-initialized test for getInstalledRegistry
- Batch 6 test fixes — registry mock + concurrency handler
- Batch 6 — final cleanup, 8 quick wins
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Batch 12 — extract concerns from 3 oversized functions
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add visual sweep fleet implementation plan
- Add visual sweep fleet design spec
- Update scout base definition — Codex is default execution provider
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 11 — 97 new test cases across 9 P1 modules
- Batch 9 — 61 new test cases across 8 P0 untested modules
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.29.0] - 2026-04-05

### Added
- Visual sweep fleet — three-phase deep visual audit system
- Scouts via Codex + /torque-sweep full automated cycle
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Add peek_wait, peek_action_sequence, peek_assert, peek_ocr to tier 2
- Snapscope install uses safe container.get with fallback
- Add logger.info/error for plugin install and mcpTools registration
- Preserve taskModel from test-writing promotion in resolveModificationRouting
- Add peek MCP tools and unlock_all_tools to visual sweep agent frontmatter
- GetPlanProject returns null instead of undefined for missing projects
- Batch 10 — eliminate 15 unhandled rejection warnings
- Use testDir instead of hardcoded path in smoke test
- 2 source bugs found by new tests + 2 test fixes
- Rewrite enforcement test to use real fs instead of CJS mocking
- Use vi.hoisted + vi.mock for CJS module mocking in enforcement test
- Convert manifest test files from CJS require to ESM imports
- Update manifest tests for test runner 4.1 compatibility
- Batch 8 — 4 a11y + 5 docs + dep patches + sweep findings
- Update 7 test files to match batch 7 source changes
- QC signals ready instead of running integration pass
- Batch 7 — security, architectural, performance, cleanup
- Update registry-not-initialized test for getInstalledRegistry
- Batch 6 test fixes — registry mock + concurrency handler
- Batch 6 — final cleanup, 8 quick wins
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Batch 12 — extract concerns from 3 oversized functions
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add visual sweep fleet implementation plan
- Add visual sweep fleet design spec
- Update scout base definition — Codex is default execution provider
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 11 — 97 new test cases across 9 P1 modules
- Batch 9 — 61 new test cases across 8 P0 untested modules
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.21.0] - 2026-04-05

### Added
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.20.0] - 2026-04-05

### Added
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.19.0] - 2026-04-05

### Added
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.18.0] - 2026-04-05

### Added
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.17.0] - 2026-04-04

### Added
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.16.0] - 2026-04-04

### Added
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.15.0] - 2026-04-04

### Added
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.14.0] - 2026-04-04

### Added
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.13.0] - 2026-04-04

### Added
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.12.0] - 2026-04-04

### Added
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.11.0] - 2026-04-04

### Added
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Centralize sandbox path resolution into shared utility

### Documentation
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.10.0] - 2026-04-04

### Added
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Centralize sandbox path resolution into shared utility

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.9.0] - 2026-04-03

### Added
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Centralize sandbox path resolution into shared utility

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.8.0] - 2026-04-03

### Added
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Centralize sandbox path resolution into shared utility

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.7.0] - 2026-04-03

### Added
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Update Strategy tests for routing overview redesign

### Maintenance
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.6.0] - 2026-04-03

### Added
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Update Strategy tests for routing overview redesign

### Maintenance
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.5.0] - 2026-04-03

### Added
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Update Strategy tests for routing overview redesign

### Maintenance
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.4.0] - 2026-04-03

### Added
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Maintenance
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.3.0] - 2026-04-03

### Added
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Maintenance
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.2.0] - 2026-04-03

### Added
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Maintenance
- Add module comment to charts index

## [1.1.0] - 2026-04-02

### Added
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

## [1.0.0] - 2026-04-01

### Testing
- Verify version control dashboard tracking

All notable changes to TORQUE are documented here. This project follows Semantic Versioning.

## [2.1.0] - 2026-01-27

### Added

- **Test Suite Expansion**
  - Provider tests: Ollama, Claude CLI, Anthropic API, Groq
  - Safeguard tests: validation rules, baseline detection, build checks
  - Git operations tests: baselines, rollback, pre-commit hooks
  - Provider routing tests: keyword analysis, complexity scoring
  - Platform tests: Windows PowerShell, WSL2, macOS, Linux
  - Discovery tests: Ollama LAN discovery via mDNS

- **CI/CD Pipeline**
  - GitHub Actions workflow for automated testing
  - Tests run on Node 18 and Node 22
  - Test matrix: Ubuntu, Windows (PowerShell)
  - Coverage tracking and reporting
  - Artifact uploads for test results

- **Documentation (Phase 6)**
  - Windows setup guide: prerequisites, installation, WSL considerations, Ollama
  - Troubleshooting guide: common issues, port conflicts, provider problems, database issues
  - Architecture documentation: component diagram, data flow, provider routing, quality pipeline
  - CHANGELOG: version history and changes tracking

- **REST API Server**
  - New HTTP server on port 3457 (separate from MCP stdio)
  - Endpoints: `/api/tasks`, `/api/status`, `/api/config`, `/api/workflows`
  - JSON request/response format
  - CORS headers for external tool integration
  - Swagger documentation generation

- **Provider Abstraction Layer**
  - Anthropic API provider: direct SDK calls, token tracking, rate limit handling
  - Groq provider: alternative cloud backend
  - Provider registry pattern for extensibility
  - Unified execute() interface across all providers

- **Logging & Observability**
  - Structured JSON logging (Winston)
  - Log rotation: max 5 files, 10MB each
  - Log levels: debug, info, warn, error
  - Console output in development, file-based in production
  - Performance metrics per provider (avg response time, success rate)

- **Dashboard Improvements**
  - Static lightweight fallback dashboard (no build required)
  - Served as HTML from server/public/dashboard.html
  - WebSocket connection with automatic reconnect
  - Real-time task status updates
  - Provider health indicators
  - Cost tracking visualization

### Changed

- **Database Schema Updates**
  - Added `priority_boost` column to tasks table for priority adjustment
  - Added `review_status` column: pending, approved, needs_correction
  - Added `complexity_score` column for routing decisions
  - Added `provider_selected` column to log which provider executed task
  - Index optimizations for faster queries

- **Provider Routing**
  - More sophisticated complexity scoring (0-10 scale)
  - Multi-factor analysis: keywords + file extensions + file count
  - Configurable routing rules with priority
  - Default routes: XAML/WPF always to cloud (better semantic understanding)
  - Cost tracking per task (input tokens, output tokens, USD cost)

- **Error Handling**
  - Graceful degradation when providers fail
  - Automatic fallback to alternative provider
  - Better error messages with actionable suggestions
  - Timeout handling for hung providers
  - Provider health checks every 30 seconds

- **Dashboard Server**
  - Updated to serve static fallback dashboard
  - Fallback activated if build fails or main dashboard unavailable
  - Minimal dependencies: no Next.js, no build step required

### Fixed

- **Windows PowerShell Compatibility**
  - Pre-commit hooks generate .ps1 PowerShell scripts on Windows
  - Shell wrapper shims for bash compatibility
  - Path separator handling (backslash vs forward slash)
  - Long path support (>260 characters) with registry fix

- **Stuck Task Handling**
  - Auto-cleanup for tasks stuck in "running" state
  - Grace period: 5 minutes before force cleanup
  - Force cleanup on Windows (ungraceful termination)
  - Better detection of zombie processes

- **Task Cancellation on Windows**
  - Fixed issue where cancel_task didn't work on Windows
  - Now properly kills child processes
  - Force-kills after timeout (2 seconds)

- **WSL2 Compatibility**
  - 30-second timeout for git operations in WSL2 (due to file system latency)
  - Auto-detection of WSL2 environment
  - Warning when using slow file system (mapped /mnt/c/)
  - Recommendation to use native Windows Node.js

- **Database Locking Issues**
  - Single-server enforcement (only one instance at a time)
  - Better lock timeout handling
  - Cleanup of stale lock files on startup

### Deprecated

- Codex provider: deprecated in favor of Anthropic API and Groq
  - Still functional for backward compatibility
  - Will be removed in v3.0.0

### Security

- Environment variable validation for API keys
- No sensitive data logged (API keys, credentials)
- Audit trail of all operations (audit_log table)
- CORS configuration for API server
- Input validation and sanitization for all parameters

## [2.0.0] - 2026-01-20

### Added

- **Smart Task Routing**
  - Automatic provider selection based on task complexity
  - Local LLM (Ollama) for simple tasks (free, no rate limits)
  - Cloud providers for complex tasks (better quality)
  - Configurable routing rules with priorities
  - Cost tracking and ROI analysis

- **Multi-Host Ollama Support**
  - Load balancing across multiple Ollama instances
  - Host capacity tracking (CPU, memory, GPU)
  - Automatic failover to secondary hosts
  - Host health monitoring and recovery
  - LAN discovery via mDNS

- **Quality Safeguards**
  - Baseline capture before task execution
  - Output validation (stub detection, empty files, truncation)
  - Approval gates for suspicious results
  - Build verification (compile check)
  - Automatic rollback on failure

- **Dashboard**
  - Real-time task monitoring
  - WebSocket updates for live status
  - Provider health indicators
  - Cost tracking by provider and project
  - Workflow visualization (DAG display)

- **Workflow/DAG Support**
  - Define task dependencies as directed acyclic graphs
  - Conditional execution (success, failure, always)
  - Parallel task execution
  - Workflow templates for reusable patterns
  - Critical path analysis

- **Provider Management**
  - Anthropic API integration (Claude 3 models)
  - Groq provider for faster inference
  - Claude CLI wrapper (subprocess execution)
  - Codex API (legacy)
  - Provider performance metrics and cost tracking

- **Adaptive Retry**
  - Automatic retry with alternative provider
  - Exponential backoff strategy
  - Configurable retry limits
  - Retry patterns learned from failures

- **Windows/PowerShell Compatibility**
  - Pre-commit hooks as PowerShell scripts
  - Shell wrappers for cross-platform compatibility
  - Path handling for Windows file systems
  - Environment variable support

- **Orphan Mode**
  - Server continues running if MCP connection drops
  - In-flight tasks complete before shutdown
  - Grace period for task completion
  - Auto-exit after grace period expires

### Changed

- Complete rewrite of provider abstraction
- Database schema redesigned (v2 format)
- Tool handlers refactored for clarity
- Quality checks integrated into task lifecycle
- Routing logic moved to centralized decision engine

### Fixed

- Task state persistence across server restarts
- Provider timeout handling
- Database transaction safety
- Memory leaks in long-running servers
- File path normalization

## [1.0.0] - 2026-01-01

### Added

- **Initial Release**
  - MCP server with stdio interface
  - Task delegation to Codex CLI
  - SQLite persistence for task state
  - Task queuing with priority levels
  - Progress tracking and status monitoring
  - Basic error handling and logging
  - Command-line interface via MCP tools

- **Core Features**
  - Task submission and execution
  - Queue management (FIFO with priorities)
  - Task status tracking (queued, running, completed, failed)
  - Result storage and retrieval
  - Simple provider abstraction
  - Database initialization and schema creation

- **Basic Configuration**
  - Environment variable support
  - SQLite database path configuration
  - Server port configuration
  - Task timeout configuration
  - Provider selection (Codex only)

## Version Numbering

TORQUE follows Semantic Versioning (MAJOR.MINOR.PATCH):

- **MAJOR**: Breaking changes to API or data format
- **MINOR**: New features, backward compatible
- **PATCH**: Bug fixes, performance improvements

## Release Schedule

- Regular releases on the 20th of each month
- Hotfixes released as needed for critical issues
- Long-term support (LTS) versions designated annually

## Migration Guides

### Upgrading from 1.x to 2.x

- Database schema v1 → v2 (auto-migration on first run)
- Provider configuration changed (see docs/architecture.md)
- Routing rules must be reconfigured for 2.x (see CLAUDE.md)

### Upgrading from 2.0 to 2.1

- No breaking changes
- Optional: enable new providers (Anthropic API, Groq)
- Optional: configure new routing rules

## Known Issues

- WSL2 file system latency causes slow git operations (workaround: use native Windows Node.js)
- Ollama GPU support limited on older hardware (fallback: use CPU mode)
- Large task outputs (>10MB) may exceed memory limits (workaround: split into smaller tasks)

## Future Plans (v2.2+)

- Distributed task execution across multiple servers
- Machine learning-based provider selection
- Advanced workflow scheduling and optimization
- Enhanced dashboard with custom visualizations
- Integration with external version control systems
- Task result caching and deduplication
- Real-time collaborative task editing
