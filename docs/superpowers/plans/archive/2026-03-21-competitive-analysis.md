# Competitive Landscape Analysis — March 2026

> Research conducted 2026-03-21 by reading actual source code from all five projects.

## Projects Analyzed

| Project | Stars | Language | Architecture | License |
|---------|-------|----------|-------------|---------|
| **Gobby** (GobbyAI/gobby) | 10 | Python | Local daemon + MCP proxy + Web UI | Apache 2.0 |
| **EnsoAI** (J3n5en/EnsoAI) | 816 | TypeScript | Electron desktop app | MIT |
| **CreedFlow** (fatihkan/creedflow) | 2 | Swift/Rust | Native macOS + Tauri | MIT |
| **agent-orchestrator** (stefan1294/agent-orchestrator) | 0 | Node.js | Server + React dashboard | -- |
| **Goblin Forge** (astoreyai/goblin-forge) | 1 | Go | CLI + TUI + tmux | Apache 2.0 |

---

## Gobby (GobbyAI/gobby)

**Profile:** Alpha-stage local daemon that unifies Claude Code, Gemini CLI, Codex under one platform. Built itself with itself (10,000+ tasks tracked). Most feature-rich competitor.

### MCP Proxy -- Progressive Discovery

Three-tier API avoids context bloat:
- `list_tools(server)` returns names + 100-char descriptions only (~200 tokens for 50 tools)
- `get_tool_schema(server, tool)` fetches full inputSchema on demand
- `call_tool(server, tool, args)` executes with pre-validation

Additional features:
- **Lazy server connections** with circuit breaker (3 failures, 30s recovery, half-open test)
- **Schema hash tracking**: SHA-256 hashes in SQLite; only tools with changed schemas re-indexed on reconnect
- **Tool filtering by workflow phase**: list_tools and call_tool accept session_id and apply allowed/blocked tool lists

### Task System

Tasks stored in `.gobby/tasks.jsonl` (git-native) + SQLite.

**TDD Expansion** -- two-phase design that survives /compact:
1. `save_expansion_spec(task_id, spec)` -- persists subtask plan to task.expansion_context
2. `execute_expansion(parent_task_id)` -- atomically creates subtasks, wires dependencies

Validation includes: cycle detection (DFS with WHITE/GRAY/BLACK coloring), out-of-bounds dependency indices, plan section coverage matching.

**Validation Gates** -- three-source context gathering:
1. Uncommitted changes (staged + unstaged diff)
2. Multi-commit window (last N commits combined diff)
3. File-based analysis (regex-extracts file paths from validation criteria, reads those files)

LLM evaluates whether gathered evidence satisfies criteria. Tasks cannot close without passing.

### Session Handoffs

**Dual-path design:**
- **Fast path**: Agent calls `set_handoff_context(session_id, content)` with its own summary
- **Automated fallback**: TranscriptAnalyzer extracts: initial goal, active task, files modified, git commits, recent activity (last 10 tool calls), key decisions

Cross-CLI handoffs supported via inter-session P2P messages.

### Rule Engine

Seven effect types (not just blocking):
1. `block` -- prevent tool execution (tools, command patterns, MCP tools)
2. `set_variable` -- mutate session state
3. `inject_context` -- add text to system message
4. `mcp_call` -- trigger MCP tool as side-effect (background, inject_result, block_on_failure)
5. `observe` -- append structured observations to session variable
6. `rewrite_input` -- modify tool input before execution
7. `compress_output` -- compress tool output after execution

Uses SafeExpressionEvaluator (AST-based, no code execution). LazyBool defers expensive checks until the condition actually references them.

### OpenTelemetry Integration

- `@traced` decorator for sync/async with global enable flag (zero overhead when disabled)
- Spans stored in SQLite for built-in trace viewer (no Jaeger dependency)
- Pre-registered instruments for: HTTP requests, sessions, memory ops, MCP calls, tasks, hooks
- Exporters: OTLP gRPC, Prometheus

### Web UI

30+ React components including: KanbanBoard, DependencyGraph, GanttChart, TaskTree, PriorityBoard, ActionFeed, ActivityPulse, CostTracker, EscalationCard, RiskBadges, LaunchAgentDialog, MemoryTable, KnowledgeGraph (Neo4j 3D), TraceWaterfall, terminal (xterm.js), file browser/editor.

### Code Indexing

tree-sitter parsing for 15+ languages into SQLite (symbols) + Qdrant (vectors) + Neo4j (graph). Incremental indexing via content hashes. Symbol-level retrieval claims 90%+ token savings vs whole-file reads.

---

## EnsoAI (J3n5en/EnsoAI)

**Profile:** Electron desktop app (816 stars). GUI-first -- every branch is a workspace with its own AI context.

### Multi-Agent Matrix

AgentRegistry maps agents with capability flags: chat, codeEdit, terminal, fileRead, fileWrite. Built-in: Claude, Codex, Gemini, Cursor, Droid, Auggie. Custom agents via any CLI binary. Per-agent output parsers (Claude: JSON streaming, Gemini: NDJSON, Codex: plain text).

### Worktree Management

Built on simple-git. Full merge workflow: merge/squash/rebase with auto-stash, conflict detection, cleanup. 3-way conflict resolution reads base/ours/theirs via git show. Windows-specific: PowerShell kills node.exe processes under worktree path before removal.

### AI Code Review

Streaming review with: git diff HEAD, 5 review categories (logic, readability, performance, test coverage, questions), disallowed tools (Bash git, Edit), session continuity via --session-id. Structured table output: line number, code, issue, solution.

### IDE Bridge (ClaudeIdeBridge)

WebSocket + HTTP server on random port. Lock file at ~/.claude/ide/{port}.lock. MCP protocol compliance (JSON-RPC 2.0). Hook injection into ~/.claude/settings.json. Receives agent activity via POST /agent-hook. Bidirectional selection sync. Multi-client routing via longest-prefix-match on file paths.

### Process Activity Detection

pidtree + pidusage checks CPU activity of entire process tree with 2-second cache. Determines if agent is actively working vs. idle -- independent of output production.

---

## CreedFlow (fatihkan/creedflow)

**Profile:** macOS-native app (Swift 6 + SwiftUI + SQLite/GRDB). 9 CLI backends. v1.6.

### Backend Comparison

BackendComparisonRunner fans out same prompt to N backends concurrently via TaskGroup. Collects per-backend: output, durationMs, error.

BackendScore model tracks 4 dimensions: costEfficiency, speed, reliability, quality + compositeScore. Requires 5+ samples before trusting data. BackendScoringService updates from actual task execution data.

### Task Routing

Three layers:
1. **Agent-level defaults** -- 12 agent types with hardcoded backend preferences
2. **User overrides** -- customizable preferred order per agent type
3. **Cost strategy** -- cheapest (local first), balanced (score-weighted), qualityFirst (Claude first)

CostOptimizerService auto-switches to cheapest at 90% budget.

### Orchestrator Decomposition

Split from 2500 lines into: Orchestrator (polling loop), TaskQueue (SQLite priority queue with atomic dequeue), AgentScheduler (concurrency via AsyncSemaphore), DependencyGraph (Kahn's algorithm + cycle detection), RetryPolicy (exponential backoff with non-retryable filter), ChainExecutor (prompt chains with conditional branching).

### Batched Log Persistence

MultiBackendRunner buffers output lines, flushes to DB at 20 lines or 500ms (whichever first). Prevents per-line DB writes.

---

## agent-orchestrator (stefan1294/agent-orchestrator)

**Profile:** Node.js proof-of-concept implementing Anthropic's "effective harnesses" blog post pattern.

### Multi-Track Parallel Execution

Named execution lanes ("tracks"), each with own git worktree. Features routed by category field. All tracks run via Promise.all(). Three priority sub-queues per track: resume > retry > main.

### Verification Mutex

Parallelizes implementation but serializes merge+verify with a mutex. Only one track can merge and verify at a time. Prevents merge conflicts during the critical step.

### Auto-Merge Flow

Push-first strategy: always merge and push before verification. Verify loop with max 3 attempts. GitManager has preserved-files backup/restore across git operations. Symlinks node_modules into worktrees. Auto-cleans stale index.lock.

### Circuit Breaker

2+ consecutive critical failures of same type auto-pauses the track. Pattern matching classifies failures: environment, test_only, rate_limit, implementation, unknown.

### Retry with Resume Context

buildResumeContext() feeds last 20 structured messages from failed session into retry prompt. AgentMessage types: system, text, tool_use (with tool_name/tool_input), tool_result.

---

## Goblin Forge (astoreyai/goblin-forge)

**Profile:** Go CLI (v1.0). Each agent instance ("goblin") gets tmux session + git worktree. Linux-only.

### Template System

40+ YAML templates with auto-detection via file markers + dependency parsing. Priority scoring (frameworks 110 > languages 50). Template inheritance (extends). Each template has agent_context field injected into agent prompts with framework-specific instructions.

### Agent Registry

Auto-discovery via exec.LookPath. Version extraction via --version. Capability flags: code, git, fs, web, mcp, terminal, local, multimodal. Scan() reports installed; NotInstalled() shows missing with install hints.

### Voice Control

Python daemon (faster-whisper local STT) + Go client via Unix socket IPC. 20+ regex command patterns. Filler word stripping.

### TUI Dashboard

Bubble Tea (Charm.sh). 40/60 split layout. 500ms auto-refresh. Color-coded status. Seamless tmux attach/detach.

---

## TORQUE's Unique Differentiators (No Competitor Has These)

- 13-provider routing with fallback chains (others: 3-6 agents, no fallback)
- Multi-host Ollama load balancing across LAN
- Slot-pull scheduler (alternative scheduling model)
- Auto-verify-retry pipeline in close handler
- Routing templates as user-defined presets
- Context-stuffing for free providers (auto-inject project files)
- Policy engine with shadow enforcement mode
- Remote workstation routing for tests/builds
- Stall detection with provider-specific thresholds + auto-recovery
