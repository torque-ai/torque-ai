# Task Diffusion Engine

**Date:** 2026-03-23
**Status:** Draft
**Author:** Claude + Werem

## Problem

TORQUE can decompose *features* into a fixed pipeline (types→data→events→system→tests→wire) and flags complex tasks with `split_advisory`, but it cannot auto-decompose arbitrary work — bug fixes, refactors, cross-cutting changes, or large natural-language goals. The split advisory is informational only; nothing acts on it.

When a developer says "migrate all 87 test files from direct DB imports to the DI container," the current workflow is: Claude reads files one by one, writes tasks manually, submits them serially. This doesn't scale and wastes Claude's context window on repetitive work that execution providers could analyze faster.

## Solution

A **Task Diffusion Engine** that decomposes large issues into small, provider-routed subtasks via a two-phase model:

1. **Claude decomposes** the issue into initial work units (strategic, high-level)
2. **Execution providers scout** the codebase and discover the true scope — patterns, file counts, shared dependencies
3. **Claude reviews** the scout's structured output and approves the diffusion plan
4. **TORQUE fans out** subtasks across all available providers as a workflow
5. **Claude orchestrates** convergence — conflict resolution, verification, integration

Every execution provider becomes a potential *scout* that amplifies Claude's understanding of actual scope, turning single-threaded analysis into parallel reconnaissance.

## Architecture

### The Loop

```
Issue (natural language)
    │
    ▼
Claude decomposes into initial work units
    │
    ▼
┌─────────────────────────────────────┐
│  For each unit, Claude decides:     │
│                                     │
│  • Small/clear → submit directly    │
│  • Large/unknown → submit as scout  │
└─────────────────────────────────────┘
    │                    │
    ▼                    ▼
 Normal task          Scout task
 (executes)           (analyzes, doesn't implement)
    │                    │
    ▼                    ▼
 Results              Diffusion Plan
                     (exemplars + manifest)
                         │
                         ▼
                  Claude reviews plan
                         │
                    ┌────┴────┐
                    ▼         ▼
              Isolated?    Shared deps?
                    │         │
                    ▼         ▼
              Optimistic    DAG workflow
              parallel      (anchor → fan-out)
                    │         │
                    └────┬────┘
                         ▼
              Providers execute subtasks
              (any subtask can signal
               further diffusion → recurse)
                         │
                         ▼
              Claude reconciles & verifies
                         │
                         ▼
                      Commit
```

### Diffusion Triggers (Three Mechanisms)

The system provides three ways to initiate diffusion, used as a toolkit:

#### 1. Scout-Mode Tasks (MVP)

A new execution mode where the provider analyzes but does not modify files. The prompt instructs: "Read the codebase, identify the scope, classify files by transformation pattern, produce exemplar implementations for 2-3 files, and output a structured diffusion plan for the rest."

Scout tasks are standard TORQUE tasks with `mode: "scout"` in metadata and a modified prompt template.

**Provider constraint:** Scout tasks require filesystem access. They must route to providers that can read the project directory (Codex, claude-cli). API providers (DeepInfra, Groq, Cerebras) cannot perform filesystem analysis. `submit_scout` enforces this constraint — if a user-specified provider lacks filesystem access, the tool returns an error suggesting Codex or claude-cli.

**When to use:** When Claude knows the work is large upfront, or when the scope is genuinely unknown and needs filesystem-level analysis.

#### 2. Structured Output from Normal Tasks

Any Codex task can signal mid-execution that it discovered more work than expected. If a task outputs a `__DIFFUSION_REQUEST__` JSON block, the close-handler extracts it and surfaces it to Claude as a notification instead of treating the task as simply complete.

The task is marked `completed` normally, with the diffusion plan stored in `metadata.diffusion_request`. The notification system detects this metadata flag and includes the plan in the standard `task_completed` event payload.

**When to use:** Organic discovery — a task starts working and realizes the scope is larger than described.

#### 3. Partial Completion + Manifest

The provider handles the first 2-3 files as exemplars (actually writes the code), then outputs a manifest of remaining work with the pattern it discovered. Claude uses the committed exemplars as ground-truth templates for fan-out task descriptions.

**When to use:** When showing-by-example produces more reliable fan-out than description alone. The exemplar diffs serve as both validation and template.

### Scout Prompt Contract

Scout tasks use a dedicated prompt template registered in `server/orchestrator/prompt-templates.js`. The prompt instructs the provider to:

1. **Read the project** — traverse the working directory, identify files matching the scope description
2. **Classify by pattern** — group files by the transformation they need (same change = same pattern)
3. **Produce exemplars** — for the 2-3 most representative files per pattern, write the actual transformed code as a diff
4. **Output the diffusion plan** — emit a JSON block matching the diffusion plan schema as the **final output block**

The prompt includes the full JSON schema for the diffusion plan so the provider knows the exact output format. It explicitly instructs: "Do NOT modify any files. Your output is analysis only. Write the diffusion plan JSON as the last thing in your response."

For partial-completion scouts (mechanism 3), the prompt instead says: "Implement the transformation for the first 2-3 files. Then output a diffusion plan manifest for the remaining files as the last thing in your response."

### Task Prompt Generation

When `create_diffusion_plan` expands the manifest into subtask descriptions:

1. **Exemplar diffs are stored once** as a shared artifact in workflow metadata, not duplicated into every subtask prompt. Each subtask prompt references the pattern by ID and includes a summary of the transformation (from `pattern.description` + `pattern.transformation`).

2. **Batch sizing** — each subtask handles 1 file by default. For very large manifests (50+ files), the planner groups files into batches of N (based on `recommended_batch_size` or provider concurrency). Each batch-task receives a list of files and the pattern description.

3. **Token budget** — each subtask prompt is estimated at: base instructions (~500 tokens) + pattern description (~200 tokens) + file list (~50 tokens/file). For context-stuffed providers, the file contents are added within the provider's token budget. Tasks exceeding budget are split into smaller batches.

4. **Template format:**
   ```
   Apply the following transformation to [file(s)]:

   Pattern: [pattern.description]
   Transformation: [pattern.transformation]

   Files to modify:
   - [file1]
   - [file2]

   Reference: see exemplar diff for pattern [pattern.id] in the workflow metadata
   for the exact before/after if needed.

   Working directory: [working_directory]
   ```

### Diffusion Plan Format

Structured output from scouts and mid-task diffusion signals:

```json
{
  "summary": "Migrate 87 test files from direct DB import to DI container",
  "patterns": [
    {
      "id": "pattern-a",
      "description": "Files that import database.js directly and use db.getTask()",
      "transformation": "Replace require('../database') with container.get('taskCore')",
      "exemplar_files": ["server/tests/task-manager.test.js"],
      "exemplar_diff": "--- a/server/tests/task-manager.test.js\n+++ b/...",
      "file_count": 72
    },
    {
      "id": "pattern-b",
      "description": "Files that import database.js and use db.getConfig()",
      "transformation": "Replace require('../database') with container.get('configCore')",
      "exemplar_files": ["server/tests/config.test.js"],
      "exemplar_diff": "--- a/server/tests/config.test.js\n+++ b/...",
      "file_count": 15
    }
  ],
  "manifest": [
    { "file": "server/tests/api-server.test.js", "pattern": "pattern-a" },
    { "file": "server/tests/provider-routing.test.js", "pattern": "pattern-a" },
    { "file": "server/tests/v2-config-api.test.js", "pattern": "pattern-b" }
  ],
  "shared_dependencies": [
    {
      "file": "server/tests/test-container.js",
      "change": "Add configCore registration to test container setup"
    }
  ],
  "estimated_subtasks": 87,
  "isolation_confidence": 0.95,
  "recommended_batch_size": 8
}
```

**Key fields:**

- `patterns` — the distinct transformation types discovered, each with exemplar diffs that serve as templates
- `manifest` — every file that needs work, tagged with which pattern applies. Compact (file path + pattern ID only)
- `shared_dependencies` — files that multiple subtasks depend on. Drives convergence strategy selection
- `isolation_confidence` — 0.0-1.0 score. High confidence = optimistic parallel. Low = needs DAG
- `recommended_batch_size` — scout's suggestion based on file complexity observed

### Diffusion Planner

Runs after Claude reviews and approves the scout's plan. Responsibilities:

1. **Select convergence strategy** based on `isolation_confidence` and `shared_dependencies`:
   - `isolation_confidence >= 0.8` and no `shared_dependencies` → optimistic parallel
   - Otherwise → DAG workflow with shared deps as anchor nodes

2. **Size batches** by querying current host topology (`list_ollama_hosts`) and provider concurrency limits. Groups manifest entries into batches tuned to available slots.

3. **Expand templates** — for each batch, generate task descriptions by combining the exemplar diff/description from the matching pattern with the specific file list. Claude reviews a sample before fan-out.

4. **Construct workflow** — calls `create_workflow` + `add_workflow_task` with dependency edges derived from the plan. For DAG mode, shared dependency tasks are root nodes; fan-out tasks depend on them.

5. **Assign providers** — routes batches using smart routing or explicit provider preferences. Repetitive, well-patterned work goes to free/fast providers (Ollama, Cerebras, Groq). Complex anchor tasks go to Codex or cloud models.

### Convergence Strategies

#### Optimistic Parallel

All subtasks run simultaneously with no dependency constraints. Used when `isolation_confidence` is high and there are no `shared_dependencies`.

After all subtasks complete:
1. `detect_file_conflicts` runs automatically
2. If no conflicts → `auto_verify_and_fix` → commit
3. If conflicts found → Claude gets a structured conflict report and reconciles manually

**Best for:** Independent file updates (test migrations, adding logging, renaming patterns).

#### DAG Workflow

The diffusion plan produces a proper dependency graph:
- **Anchor nodes** — tasks that modify `shared_dependencies` (e.g., update a shared type file)
- **Fan-out nodes** — independent tasks that depend on anchor completion
- **Multi-layer** — anchors can depend on other anchors if there are layered shared changes

TORQUE's existing workflow engine executes this naturally. Fan-out tasks only start after their dependency anchors complete and are verified.

**Note:** DAG mode reduces conflict risk by serializing shared-dependency modifications, but sibling fan-out tasks at the same DAG layer run concurrently and can still touch the same files (e.g., a shared utility, a barrel export). `detect_file_conflicts` runs after DAG workflows complete, not just optimistic parallel workflows.

**Best for:** Changes with shared foundations (updating a base type, modifying a shared test helper).

### Mid-Task Diffusion Signal

For non-scout tasks, a structured output convention enables organic discovery:

```
__DIFFUSION_REQUEST__
{
  "reason": "Found 45 handler files following the same pattern, only modified 3",
  "patterns": [...],
  "manifest": [...],
  "shared_dependencies": [],
  "isolation_confidence": 0.9
}
__DIFFUSION_REQUEST_END__
```

**Close-handler behavior:**
1. After output capture is finalized (post-Phase 2 safeguard checks), scan the **last 8KB of stdout** for `__DIFFUSION_REQUEST__` markers. Only stdout is scanned — stderr is not checked.
2. If found, extract and validate the JSON against the diffusion plan schema
3. Store the validated plan in `metadata.diffusion_request` on the task record
4. Mark the task as `completed` normally (preserving the existing terminal status lifecycle)
5. The standard `task_completed` notification includes the `diffusion_request` field — existing subscriptions receive it automatically without needing new event type filters
6. Claude receives the notification, reviews the embedded plan, and can invoke `create_diffusion_plan` to fan out

**Phase placement:** This detection runs as a new Phase 2.5 in the close-handler pipeline — after safeguard checks (Phase 2) but before the completion pipeline fires workflow dependency resolution (Phase 8).

**Prompt injection:** The close-handler validates that the diffusion request is well-formed JSON matching the expected schema. Malformed requests are logged and ignored — the task completes normally without a `diffusion_request` in metadata.

**Truncation safety:** The `__DIFFUSION_REQUEST__` block must appear in the final 8KB of stdout to survive output truncation. Scout and diffusion-aware prompts instruct the provider to output the diffusion request as the last block of their response.

### Recursive Diffusion

Subtasks spawned by diffusion can themselves signal further diffusion. This handles cases where a subtask discovers unexpected sub-scope (e.g., "update this test file" reveals it needs a new test helper that 20 other files could also use).

**Depth limit:** Configurable, default 2. Each diffusion plan carries a `depth` counter. When a subtask signals diffusion, the counter increments. At max depth, the signal is surfaced to Claude but auto-fan-out is disabled — Claude must explicitly approve further recursion.

### Error Handling & Recovery

**Scout failures:** If a scout task fails or produces unparseable output, Claude receives a notification with the error. Recovery options:
- Resubmit to a different provider
- Fall back to Claude doing the analysis manually via `scan_project` + file reads
- Narrow the scope and retry with a more specific scout prompt

**Batch failure threshold:** If >30% of subtasks in a fan-out batch fail with the same error pattern (detected via `fallbackDiagnose` pattern matching), the remaining batch is paused and Claude is notified. The pattern is probably wrong, not the providers.

**Partial completion recovery:** If a fan-out is 80% complete and 3 tasks failed, Claude can:
- Review the specific failures
- Tweak the prompt or switch providers for just those tasks
- Resubmit only the failed subtasks, not the whole batch

**Conflict on convergence:** `detect_file_conflicts` runs after all subtasks complete — for both optimistic parallel and DAG workflows. DAG mode serializes anchor dependencies but sibling fan-out tasks are concurrent. If conflicts are found, Claude gets a structured report (which tasks touched which files, the diffs) and reconciles.

### New MCP Tools

Three new tools, registered in the standard tool lifecycle:

| Tool | Tier | Purpose |
|------|------|---------|
| `submit_scout` | core | Submit a scout-mode task. Accepts `scope` (description of what to analyze), `working_directory`, optional `file_patterns` (globs to focus on), optional `provider` (must be filesystem-capable: codex, claude-cli). `file_patterns` are expanded server-side into a file list that is embedded in the scout prompt (e.g., `["server/tests/**/*.test.js"]` → list of matching paths). Returns task ID. |
| `create_diffusion_plan` | core | Generate a workflow from a scout's output or a manually constructed diffusion plan JSON. Accepts: plan JSON, optional `batch_size` override, optional `provider` preference for fan-out tasks, optional `convergence` override ("optimistic" or "dag"). Returns workflow ID. |
| `diffusion_status` | core | View active diffusion sessions. Data is derived from workflow metadata — workflows with `metadata.diffusion = true` are diffusion sessions. Shows: scout task status, fan-out workflow progress, convergence state, depth counters, conflict reports. No new database table required. |

### Relationship to Existing Decomposition

TORQUE already has two decomposition mechanisms:

- **`strategic_decompose`** (StrategicBrain) — LLM-powered feature decomposition into types→data→events→system→tests→wire steps. Works from natural-language descriptions without filesystem access.
- **Auto-decompose in smart routing** — splits complex C# tasks into workflow DAGs with dependency chains (currently C#-specific).

The diffusion engine generalizes both. `strategic_decompose` remains useful for initial high-level decomposition (Claude's first pass). The diffusion engine picks up where it leaves off — when a work unit needs filesystem-level analysis to determine actual scope. Over time, `strategic_decompose` could feed directly into `submit_scout` for units it identifies as large.

The C#-specific auto-decompose in smart routing is a special case of diffusion with hardcoded patterns. It can be migrated to use the diffusion engine's pattern/manifest format in a future phase.

### Safety Caps

- **Max tasks per diffusion session:** 200 (configurable via project defaults). Prevents a single diffusion from creating unmanageable workflow graphs. If the scout's manifest exceeds this limit, `create_diffusion_plan` returns an error suggesting scope narrowing.
- **Max recursive depth:** 2 (configurable). Subtask-initiated diffusion increments a depth counter. At max depth, signals are surfaced but auto-fan-out is disabled.
- **Scout cost ceiling:** Scout tasks use the same `timeout_minutes` as normal tasks. A project-level `max_scout_timeout` default (default: 10 minutes) caps analysis time.

### Integration with Existing Systems

**No new execution infrastructure.** Diffusion plans produce standard TORQUE workflows via `create_workflow` + `add_workflow_task`. Scout tasks are normal tasks with metadata flags and modified prompt templates.

| Existing System | Integration Point |
|-----------------|-------------------|
| **Workflow engine** | Diffusion plans produce standard workflows with dependency edges |
| **Smart routing** | Scout tasks route normally. Fan-out tasks inherit routing from planner, which considers host capacity |
| **Close handler** | Extended to detect `__DIFFUSION_REQUEST__` blocks in output |
| **Notification system** | Diffusion plans piggyback on `task_completed` events via `metadata.diffusion_request` — no new event type needed |
| **`await_workflow`** | Works unchanged for diffusion workflows |
| **`detect_file_conflicts`** | Called automatically after optimistic parallel convergence |
| **`auto_commit_batch`** | Used for final commit after convergence |
| **`auto_verify_and_fix`** | Runs verification after fan-out completion |
| **Routing templates** | Fan-out batches respect active routing template |
| **Stall detection** | Works unchanged for individual subtasks |

### Implementation Phases

#### Phase 1: Scout Mode (MVP)

- Scout task type with `mode: "scout"` metadata
- Scout prompt template (analysis-only instructions + diffusion plan schema)
- `submit_scout` MCP tool
- Diffusion plan JSON schema validation
- `create_diffusion_plan` tool (plan → workflow conversion with batch sizing)
- `diffusion_status` tool
- Unit tests for planner logic (grouping, batching, DAG construction)
- Integration test: scout → plan → workflow creation (mock providers)

#### Phase 2: Mid-Task Diffusion Signal

- Close-handler Phase 2.5 extension to parse `__DIFFUSION_REQUEST__` blocks from last 8KB of stdout
- `metadata.diffusion_request` field on task records (no new task status)
- Include diffusion plan in standard `task_completed` notification payload (no new event type)
- Modified task prompt templates with diffusion signal instructions
- Schema validation for mid-task diffusion requests
- Tests for close-handler parsing, metadata storage, and notification flow

#### Phase 3: Convergence Intelligence

- Automatic convergence strategy selection (optimistic vs. DAG)
- Batch failure threshold detection and pause
- Recursive diffusion with depth tracking
- Provider-aware batch sizing (query host topology at plan time)
- End-to-end integration tests with real providers

### Testing Strategy

**Unit tests:** Diffusion planner logic — pattern grouping, batch sizing, DAG construction from shared dependencies, template expansion from exemplars, convergence strategy selection. Pure functions, no providers needed.

**Integration tests:** End-to-end scout → plan → fan-out → converge using mock providers. Verify workflow validity, dependency correctness, close-handler diffusion signal parsing, notification delivery.

**Live validation:** Submit a real scout task against the TORQUE repo itself (e.g., "analyze all test files still importing database.js directly") and verify the diffusion plan matches reality.

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Tiered exemplar format (2-3 full + compact manifest) | Token efficiency + exemplars validate the pattern before fan-out |
| DAG as default, optimistic parallel as fast path | DAG reduces conflicts by serializing shared-dependency writes; optimistic parallel is a speed optimization for high-confidence isolated work. Both strategies run `detect_file_conflicts` after completion. |
| Depth limit 2 for recursive diffusion | Prevents runaway recursion while allowing one level of sub-discovery |
| 30% batch failure threshold | Enough signal that the pattern is wrong, not random provider failures |
| Scout tasks are regular tasks with metadata | No new execution infrastructure; reuses all existing routing, retry, and monitoring |
| `__DIFFUSION_REQUEST__` text markers in output | Simple, parseable, works with any provider's output format (no special API needed) |
| Claude-as-architect model | Claude has the strategic context (user intent, project state, cost constraints) that execution providers lack |

## Resolved Questions

1. **Scout cost budget** — yes. Scouts use `timeout_minutes` (capped by `max_scout_timeout` project default, default 10 min). See Safety Caps section.
2. **Exemplar commit policy** — exemplars must be committed before fan-out. Codex tasks start from filesystem state at spawn time. Uncommitted exemplars are invisible to fan-out tasks (same sandbox staleness issue documented in CLAUDE.md).
3. **Dashboard visualization** — deferred to a future phase. The data model supports it: workflows with `metadata.diffusion = true` can be grouped and displayed as scout → fan-out → convergence trees. A `diffusion_session_id` field in workflow metadata enables cross-workflow grouping.
