# Tier 3-4 Feature Plans (Medium and Lower Priority)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Collection of smaller features inspired by competitive analysis. Each is independently implementable.

**Tech Stack:** Various -- see individual features

---

## Feature 10: Process Tree CPU Activity Detection

**Inspired by:** EnsoAI's PtyManager (pidtree + pidusage)

**Goal:** Complement output-timeout stall detection with CPU activity monitoring. A process using CPU is not stalled, even without output.

**Files:**
- Create: `server/utils/process-activity.js`
- Modify: `server/utils/activity-monitoring.js` -- integrate CPU check
- Test: `server/tests/process-activity.test.js`

### Task 1: Process activity checker

- [ ] Step 1: Implement `getProcessTreeCpu(pid)` using pidtree + pidusage npm packages
- [ ] Step 2: Returns { totalCpu, processCount, isActive } where isActive = totalCpu > 5%
- [ ] Step 3: Add 2-second cache to avoid excessive polling (Map of pid to { result, timestamp })
- [ ] Step 4: Write tests (mock pidtree/pidusage)
- [ ] Step 5: Commit

### Task 2: Integrate into stall detection

- [ ] Step 1: In activity-monitoring.js getTaskActivity(), when output timeout is exceeded for agent providers, check CPU activity before declaring stalled
- [ ] Step 2: If CPU is active, update lastOutputAt to current time (prevents stall) and set a flag `cpuRescued: true`
- [ ] Step 3: Write test -- process with CPU activity but no output is not marked stalled
- [ ] Step 4: Commit

---

## Feature 11: Side-by-Side Provider Comparison Tool

**Inspired by:** CreedFlow's BackendComparisonRunner

**Goal:** Fan out the same prompt to N providers, collect results with timing, present side-by-side.

**Files:**
- Create: `server/handlers/comparison-handler.js`
- Modify: MCP tool definitions -- add `compare_providers` tool
- Test: `server/tests/comparison-handler.test.js`

### Task 1: ComparisonRunner

- [ ] Step 1: Implement `runComparison({ prompt, providers, workingDirectory })` -- submits identical tasks to each provider, collects results
- [ ] Step 2: Returns array of { provider, output, durationMs, exitCode, costUsd, success }
- [ ] Step 3: Add timeout (max 5 minutes per provider)
- [ ] Step 4: Write tests
- [ ] Step 5: Commit

### Task 2: MCP tool and formatting

- [ ] Step 1: Register compare_providers MCP tool
- [ ] Step 2: Format results as a comparison table in the response
- [ ] Step 3: Write tests
- [ ] Step 4: Commit

---

## Feature 12: Agent Auto-Discovery Scan

**Inspired by:** Goblin Forge's registry Scan() + NotInstalled()

**Goal:** Detect installed CLI tools (claude, codex, gemini, ollama) and suggest configuration.

**Files:**
- Create: `server/utils/agent-discovery.js`
- Modify: MCP tool definitions -- add `discover_agents` tool
- Test: `server/tests/agent-discovery.test.js`

### Task 1: Discovery module

- [ ] Step 1: Implement `discoverAgents()` -- checks PATH for: claude, codex, gemini, ollama, aider
- [ ] Step 2: For each found: extract version (--version), check authentication status where possible
- [ ] Step 3: Return { installed: [...], missing: [...], suggestions: [...] }
- [ ] Step 4: Suggestions include: "codex found but not configured -- run configure_provider({ provider: 'codex', enabled: true })"
- [ ] Step 5: Write tests
- [ ] Step 6: Commit

### Task 2: MCP tool

- [ ] Step 1: Register discover_agents MCP tool
- [ ] Step 2: Add to tool annotations
- [ ] Step 3: Commit

---

## Feature 13: TUI Dashboard (torque top)

**Inspired by:** Goblin Forge's Bubble Tea TUI

**Goal:** Terminal UI showing running tasks, queue depth, provider health, recent completions.

**Files:**
- Create: `bin/torque-top` (shell script that calls Node)
- Create: `server/scripts/tui-dashboard.js`

### Task 1: Design and implement

This is a standalone script that polls the REST API and renders a terminal UI.

- [ ] Step 1: Use `blessed` or `ink` (React for CLI) npm package
- [ ] Step 2: Layout: header (TORQUE status), left panel (running tasks with progress), right panel (queue + recent completions), bottom (provider health indicators)
- [ ] Step 3: Auto-refresh every 2 seconds via REST API polling
- [ ] Step 4: Keybindings: q=quit, r=refresh, c=cancel task (with confirmation)
- [ ] Step 5: Test manually
- [ ] Step 6: Commit

---

## Feature 14: Streaming Code Review Service

**Inspired by:** EnsoAI's code-review.ts

**Goal:** Add a `review_task` MCP tool that runs AI-powered structured code review.

**Files:**
- Create: `server/handlers/review-handler.js`
- Modify: MCP tool definitions -- add `review_task_output` tool

### Task 1: Review handler

- [ ] Step 1: Implement `reviewTaskOutput(taskId)` -- reads task output, collects git diff, submits review prompt to a provider
- [ ] Step 2: Review prompt covers: logic/correctness, readability, performance, test coverage, security
- [ ] Step 3: Structured output: table with line number, file, issue, severity, suggestion
- [ ] Step 4: Restricts review agent tools (no Edit, no git push)
- [ ] Step 5: Write tests
- [ ] Step 6: Commit

### Task 2: MCP tool

- [ ] Step 1: Register review_task_output MCP tool
- [ ] Step 2: Accept taskId, optional provider override
- [ ] Step 3: Commit

---

## Feature 15: Batched Log Persistence

**Inspired by:** CreedFlow's MultiBackendRunner

**Goal:** Buffer task output and flush to DB in batches instead of per-line writes.

**Files:**
- Modify: `server/execution/process-streams.js` -- add output buffering
- Test: `server/tests/batched-output.test.js`

### Task 1: Output buffer

- [ ] Step 1: Add OutputBuffer class: collects lines, flushes at 20 lines or 500ms (whichever first)
- [ ] Step 2: Wire into stdout/stderr handlers in process-streams.js
- [ ] Step 3: Ensure flush on process exit (no lost output)
- [ ] Step 4: Write tests
- [ ] Step 5: Commit

---

## Feature 16: AI-Generated Branch Names

**Inspired by:** EnsoAI's branch-name.ts

**Goal:** Generate kebab-case branch names from task/workflow descriptions.

**Files:**
- Modify: `server/utils/git-worktree.js` -- add generateBranchName(description)

### Task 1: Branch name generator

- [ ] Step 1: Implement generateBranchName(description) -- strips common words, kebab-cases, truncates to 50 chars, prefixes with task-
- [ ] Step 2: No AI needed -- simple text processing (split, filter stop words, join with hyphens)
- [ ] Step 3: Write tests
- [ ] Step 4: Commit

---

## Feature 17: AI-Polished Task Descriptions

**Inspired by:** EnsoAI's todo-polish.ts

**Goal:** Convert rough task text into structured { title, description, acceptance_criteria } before submission.

**Files:**
- Create: `server/utils/task-polish.js`

### Task 1: Task polisher

- [ ] Step 1: Implement `polishTaskDescription(rawText, provider)` -- sends to a fast provider, returns structured JSON
- [ ] Step 2: Prompt: "Convert this rough task description into structured format with title (under 80 chars), description (1-3 sentences), and acceptance criteria (checklist). Input: {rawText}"
- [ ] Step 3: Optional -- call from smart_submit_task when description is under 50 chars (likely rough)
- [ ] Step 4: Write tests
- [ ] Step 5: Commit

---

## Feature 18: Voice Control (Future/Experimental)

**Inspired by:** Goblin Forge's voice daemon

**Goal:** Local Whisper STT for hands-free task submission.

**Files:**
- Create: `server/voice/daemon.py` (Python -- uses faster-whisper)
- Create: `server/voice/command-parser.js`

### Task 1: Design only (no implementation yet)

- [ ] Step 1: Document architecture: Python daemon (faster-whisper) listening on localhost HTTP, TORQUE polls or receives webhook
- [ ] Step 2: Command patterns: "submit task [description]", "check status", "cancel task [id]"
- [ ] Step 3: This is experimental/future -- park until core features are complete
