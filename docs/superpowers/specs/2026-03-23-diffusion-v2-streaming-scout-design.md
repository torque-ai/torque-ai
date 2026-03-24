# Diffusion Engine v2: Streaming Scout & Quality Fixes

**Date:** 2026-03-23
**Status:** Draft
**Author:** Claude + Werem
**Predecessor:** `2026-03-23-task-diffusion-engine-design.md`

## Problem

The v1 diffusion engine test run (SpudgetBooks EditorDialog refactor, 26 files) revealed three issues:

1. **Scout timeout** — the scout hit a 10-minute ceiling while generating its final JSON output. Analysis was complete but the plan was truncated. The batch architecture (analyze everything → output one JSON → exit) is fragile — if the scout dies at any point after analysis but before output, all work is lost.

2. **Exemplar quality** — abbreviated diffs in fan-out prompts left ambiguity about parameter order, return types, and calling conventions. Three different providers produced three different interpretations of the same transformation. Cerebras dropped an argument entirely, Ollama swapped parameter order, another Ollama batch inverted the boolean sense.

3. **No verification** — all fan-out tasks reported exit code 0 (success) but the code wouldn't compile. A `dotnet build` after each task would have caught 100% of the issues immediately.

## Solution

Three changes to the diffusion engine:

### 1. Two-Phase Streaming Scout

Replace the batch scout (analyze → output JSON → exit) with a streaming scout that has two internal phases:

**Phase 1 (Discovery):** Read a sample of candidate files (first 10-20), identify distinct transformation patterns, produce exemplar diffs, identify shared dependencies. Emit a `__PATTERNS_READY__` signal containing patterns + exemplars + shared deps. Claude receives this, creates the anchor task, and prepares the fan-out task template.

**Phase 2 (Classification):** Continue scanning remaining files. Emit `__SCOUT_DISCOVERY__` blocks as batches of manifest entries are classified (5-10 files per block). Claude dispatches fan-out tasks for each batch immediately as they arrive. When all files are exhausted, emit `__SCOUT_COMPLETE__` and exit.

**Timeline overlap:**
```
Scout Phase 1: ████████░░░░░░░░░░░░░░░░░░░░░░░░
Scout Phase 2:         ████████████████████████████
Anchor task:           ██████░░░░░░░░░░░░░░░░░░░░░
Fan-out batch 1:             █████░░░░░░░░░░░░░░░░
Fan-out batch 2:                  █████░░░░░░░░░░░
Fan-out batch 3:                       █████░░░░░░
Verify + fix:                                █████
```

**Signal formats:**

`__PATTERNS_READY__` — emitted once at the end of Phase 1:
```json
{
  "patterns": [
    {
      "id": "pattern-a",
      "description": "...",
      "transformation": "...",
      "exemplar_files": ["path/to/file.cs"],
      "exemplar_diff": "unified diff (backward compat with v1)",
      "exemplar_before": "full file content before transformation (v2)",
      "exemplar_after": "full file content after transformation (v2)",
      "file_count": 15
    }
  ],
  "shared_dependencies": [
    { "file": "path/to/shared.cs", "change": "description" }
  ],
  "total_candidates": 115,
  "scanned_so_far": 20
}
```

`__SCOUT_DISCOVERY__` — emitted repeatedly during Phase 2:
```json
{
  "manifest_chunk": [
    { "file": "path/to/file1.cs", "pattern": "pattern-a" },
    { "file": "path/to/file2.cs", "pattern": "pattern-b" }
  ],
  "scanned_so_far": 45,
  "total_candidates": 115
}
```

`__SCOUT_COMPLETE__` — emitted once at the end:
```json
{
  "total_classified": 26,
  "total_skipped": 89,
  "scanned_so_far": 115,
  "total_candidates": 115
}
```

**No arbitrary timeout.** The scout runs until it finishes or stalls. The existing stall detection handles true stalls. Claude supervises via the progress signals — if the scout has been classifying files for 30 minutes and Claude has already dispatched enough work, Claude can cancel it.

**Monitoring mechanism:** The scout monitor hooks into the live `stdout.on('data')` pipeline in `process-streams.js:setupStdoutHandler`. A signal detection callback is injected for tasks with `metadata.mode === 'scout'` that parses new output chunks for marker boundaries in real time — before the output buffer truncation logic runs. This avoids the truncation risk (where `proc.output` is clipped at `MAX_OUTPUT_BUFFER`) and provides zero-latency signal detection.

The callback uses a stateful buffer that accumulates partial chunks until a complete marker pair (e.g., `__PATTERNS_READY__` ... `__PATTERNS_READY_END__`) is found. This handles JSON that spans multiple `data` events. Once a complete marker is parsed and validated, the scout monitor calls `dispatchTaskEvent` with a `scout_signal` event type to push it to the subscribed MCP session.

**Session subscription:** When `submit_scout` is called, the session is auto-subscribed to `scout_signal` events for that task (same pattern as `submit_task` auto-subscribing to completion events). Claude receives signals via `check_notifications`.

**Monitor lifecycle:** The signal detection callback is registered when the scout task's process is spawned (in `process-streams.js`) and automatically cleaned up when the process exits. No separate start/stop management needed.

**Progressive dispatch model:** Claude-driven. Claude calls `submit_scout`, then enters an await/notification loop. Each `__PATTERNS_READY__` or `__SCOUT_DISCOVERY__` notification triggers Claude to call `create_diffusion_plan` (for the anchor + first batch) or `add_workflow_task` (for subsequent batches). The timeline overlap depends on Claude's response latency, but in practice this is seconds — fast enough for meaningful parallelism with scouts that run for minutes.

This is NOT a server-side autonomous dispatcher. Claude remains the architect — it reviews each signal, decides whether to dispatch, and can adjust the plan based on early fan-out results.

### 2. Complete Exemplar Embedding

Fan-out task prompts include the **complete file content** of at least one exemplar — both before and after the transformation. Not a diff summary.

The `__PATTERNS_READY__` signal includes `exemplar_before` and `exemplar_after` fields with full file content. The `expandTaskDescription` function in the planner embeds these in each fan-out task prompt.

**Task prompt template (v2):**
```
Apply the following transformation to the files listed below.

## Pattern
[pattern.description]

## Exemplar — BEFORE (exact file content)
```[language]
[full content of exemplar file before transformation]
```

## Exemplar — AFTER (exact file content)
```[language]
[full content of exemplar file after transformation]
```

## Your files to modify
- [file1]
- [file2]

Match the exemplar's exact calling conventions, parameter order,
import statements, and code style. Do NOT deviate from the pattern
shown in the exemplar.

Working directory: [working_directory]
```

**Token budget:** A typical code-behind is 20-40 lines. Two copies (before + after) is ~500 tokens. Well within budget for all providers (96K for free, 800K for google-ai).

**Why this works:** The v1 test showed that providers are reliable at pattern-matching when given concrete examples, but unreliable at interpreting abstract descriptions. A complete before/after file eliminates all ambiguity about parameter order, return type usage, and calling conventions.

### 3. Mandatory verify_command

`create_diffusion_plan` requires a `verify_command`. Resolution order:

1. Explicit `verify_command` parameter on the `create_diffusion_plan` call
2. Project defaults (`get_project_defaults` for the working directory)
3. If neither exists → return error: "Diffusion workflows require a verify_command (e.g., 'dotnet build', 'npx tsc --noEmit'). Set one via the parameter or via set_project_defaults."

**When it runs:** After each fan-out task completes, the existing auto-verify-retry pipeline (Phase 6.5 in the close-handler) runs the verify command. If verification fails, TORQUE auto-submits a fix task with the compiler error output. No new infrastructure needed — this is the existing `auto_verify_on_completion` behavior, just made mandatory for diffusion workflows.

**Propagation to all providers:** The existing `AUTO_VERIFY_PROVIDERS` set in `auto-verify-retry.js` only includes `codex`, `codex-spark`, `hashline-ollama`, and `ollama`. Fan-out tasks routed to free API providers (cerebras, groq, deepinfra) are skipped by default. To make verification truly mandatory for diffusion workflows, `create_diffusion_plan` sets `auto_verify_on_completion: true` in each fan-out task's metadata. The auto-verify-retry stage already checks this flag as an opt-in override — no code change needed in the auto-verify module itself.

**Anchor task behavior:** When Claude receives the `__PATTERNS_READY__` signal, the `shared_dependencies` field tells Claude what needs to be created before fan-out can begin. Claude creates an anchor task for each shared dependency (e.g., "Create `EditorDialogValidation.cs` with the following API...") using the pattern exemplars as the specification. The anchor task is a normal TORQUE task routed to Codex (or the provider specified). Fan-out tasks are added to the workflow with dependency edges on the anchor(s) — identical to the v1 DAG convergence model.

**What this prevents:** In the v1 test run, a fan-out task that produced `ValidateRequired(NameBox, "Name")` (missing ErrorMessage arg) would have immediately failed `dotnet build`, gotten a fix task auto-submitted with the compiler error, and the fix task would have corrected the parameter order. Zero manual reconciliation needed.

## Implementation Changes

### Modified Files

| File | Change |
|------|--------|
| `server/orchestrator/prompt-templates.js` | Update `scout` template to instruct two-phase behavior with signal markers |
| `server/diffusion/signal-parser.js` | Add parsers for `__PATTERNS_READY__`, `__SCOUT_DISCOVERY__`, `__SCOUT_COMPLETE__` markers |
| `server/diffusion/planner.js` | Update `expandTaskDescription` to embed full exemplar before/after content |
| `server/handlers/diffusion-handlers.js` | Add scout monitor (tail output, parse signals, push notifications); update `create_diffusion_plan` to require verify_command; add progressive dispatch logic |
| `server/tool-defs/diffusion-defs.js` | Add `verify_command` to `create_diffusion_plan` schema; add `submit_streaming_scout` tool or update `submit_scout` |

### New Components

| Component | Responsibility |
|-----------|---------------|
| Scout monitor | Tails running scout task output, parses signal markers, pushes notifications to Claude's session |
| Progressive dispatcher | Receives `__SCOUT_DISCOVERY__` notifications, creates fan-out tasks incrementally, adds them to the running workflow |

### Signal Parsing

The existing `parseDiffusionSignal` function handles `__DIFFUSION_REQUEST__` markers at task close. The streaming scout needs **mid-execution** parsing of three new marker types. This is a different code path:

- Close-handler parsing (existing): runs once when task exits, scans last 8KB
- Stream parsing (new): runs continuously while task is running, scans new output as it arrives

The stream parser is stateful — it accumulates a buffer of incoming chunks and scans for complete marker pairs. When a complete `__MARKER__` ... `__MARKER_END__` pair is found, it extracts the JSON, validates it against the appropriate schema, and dispatches a notification. The buffer is then trimmed. This handles JSON that arrives split across multiple `stdout.on('data')` events.

The parser reuses the same JSON extraction and schema validation logic from `signal-parser.js` but operates incrementally rather than on a post-hoc output snapshot.

**Scout prompt design:** The scout prompt template must include a few-shot example showing the expected interleaved output format — Phase 1 analysis followed by the `__PATTERNS_READY__` signal, then Phase 2 classification with `__SCOUT_DISCOVERY__` batches. Without this, the model's natural tendency is to produce one big output at the end (the v1 failure mode).

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Two phases in one task (not two separate tasks) | Avoids the overhead of task creation/teardown between phases. The scout has filesystem context loaded — don't throw it away. |
| Full file content in exemplars (not diffs) | Diffs are ambiguous without context. Full before/after is unambiguous and fits in token budgets. |
| verify_command mandatory (not optional) | The v1 test proved that without verification, silent failures are guaranteed. The cost of a build check is trivial compared to manual reconciliation. |
| Reuse auto-verify-retry pipeline | No new verification infrastructure. The existing Phase 6.5 pipeline handles verify → fail → auto-fix → retry automatically. |
| Scout signals as structured JSON markers | Consistent with the `__DIFFUSION_REQUEST__` pattern. Parseable, schema-validated, provider-agnostic. |

## Out of Scope

- Provider routing improvements (anchor to Codex, free for fan-out) — deferred to v3
- Reconciliation step after workflow completion — deferred to v3 (auto-verify-retry handles per-task reconciliation)
- Recursive diffusion — v1 spec covers this, no changes needed
- Dashboard visualization — deferred
