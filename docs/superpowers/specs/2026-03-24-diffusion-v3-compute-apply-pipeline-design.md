# Diffusion Engine v3: Compute→Apply Pipeline

**Date:** 2026-03-24
**Status:** Draft
**Author:** Claude + Werem
**Predecessor:** `2026-03-23-diffusion-v2-streaming-scout-design.md`

## Problem

The v2 test run (SpudgetBooks BindableBase refactor, 83 files) revealed a fundamental provider capability mismatch:

- **Cerebras** processed 17 fan-out batches in 1 second each (free, parallel) but couldn't write to the filesystem. All 17 tasks reported "success" with zero files actually modified.
- **Ollama** modified files successfully but was 26x slower (26s vs 1s) and was the workflow bottleneck.

The current architecture asks every fan-out provider to do two fundamentally different jobs:
1. **Compute** — read the file, understand the transformation, determine the exact edits
2. **Apply** — write the edits to disk

These are separable concerns with different provider requirements. Compute needs intelligence and speed. Apply needs filesystem access and reliability. No single provider is best at both.

## Solution

A **compute→apply pipeline** where fan-out tasks are split into two chained stages:

**Stage 1 (Compute):** A fast, cheap provider (Cerebras, Groq, DeepInfra) reads the file content, compares it against the exemplar transformation, and produces structured edit instructions — exact old/new text replacements. No filesystem access needed. The file content is context-stuffed into the prompt.

**Stage 2 (Apply):** A filesystem-capable provider (Ollama, Codex) receives the pre-computed edit instructions and mechanically applies them. No reasoning needed — just execute the replacements. This is a trivial task with near-deterministic success.

### Timeline

```
Anchor (create shared dep):  ██████░░░░░░░░░░░░░░░░░░░░░░░░░
Compute batch 1 (Cerebras):        █░░░░░░░░░░░░░░░░░░░░░░░░
Compute batch 2 (Cerebras):        █░░░░░░░░░░░░░░░░░░░░░░░░
Compute batch 3 (Cerebras):        █░░░░░░░░░░░░░░░░░░░░░░░░
  ... (all 17 in parallel)         █░░░░░░░░░░░░░░░░░░░░░░░░
Apply batch 1 (Ollama):             ███░░░░░░░░░░░░░░░░░░░░░
Apply batch 2 (Ollama):             ███░░░░░░░░░░░░░░░░░░░░░
Apply batch 3 (Ollama):              ███░░░░░░░░░░░░░░░░░░░░
  ... (parallel on available hosts)    ███░░░░░░░░░░░░░░░░░░
Verify (dotnet build):                     █████░░░░░░░░░░░░
```

All compute tasks run in parallel on Cerebras (~1s each). Apply tasks start as each compute task completes, running in parallel on available filesystem providers. Total wall-clock time is dominated by the apply phase, not the compute phase.

### Compute Stage Output Format

The compute task produces structured edit instructions:

```json
{
  "file_edits": [
    {
      "file": "src/SpudgetBooks.App/Tax/TaxDashboardViewModel.cs",
      "operations": [
        {
          "type": "replace",
          "old_text": "using System.ComponentModel;\nusing System.Runtime.CompilerServices;",
          "new_text": ""
        },
        {
          "type": "replace",
          "old_text": "public sealed class TaxDashboardViewModel : INotifyPropertyChanged",
          "new_text": "public sealed class TaxDashboardViewModel : BindableBase"
        },
        {
          "type": "replace",
          "old_text": "    public event PropertyChangedEventHandler? PropertyChanged;",
          "new_text": ""
        },
        {
          "type": "replace",
          "old_text": "    private bool SetProperty<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)\n    {\n        if (Equals(field, value))\n        {\n            return false;\n        }\n\n        field = value;\n        OnPropertyChanged(propertyName);\n        return true;\n    }\n\n    private void OnPropertyChanged(string? propertyName) =>\n        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));",
          "new_text": ""
        }
      ]
    }
  ],
  "compute_provider": "cerebras",
  "compute_duration_ms": 850
}
```

The format is deliberately simple — `replace` operations with exact `old_text`/`new_text` strings. This is the same format that TORQUE's `edit_file` tool already uses, making the apply stage nearly trivial.

### Apply Stage Prompt

The apply task receives the pre-computed edits and applies them mechanically:

```
Apply the following pre-computed edits to the specified files.
Each edit is an exact string replacement. Apply them in order.

## Edits

File: [file path]
Replace:
```
[old_text]
```
With:
```
[new_text]
```

[repeat for each operation]

These edits were pre-computed by an analysis step. Apply them exactly
as specified — do not modify, reformat, or add anything beyond what
is listed. If an old_text block is not found in the file, skip it and
report which edit could not be applied.

Working directory: [working_directory]
```

### Pipeline Construction

The diffusion planner creates a three-layer DAG:

```
Layer 0: Anchor tasks (shared dependencies)
    │
    ▼
Layer 1: Compute tasks (Cerebras/Groq — no filesystem needed)
    │ each compute task depends on all anchors
    ▼
Layer 2: Apply tasks (Ollama/Codex — filesystem access)
    │ each apply task depends on its corresponding compute task
    ▼
Verify: auto-verify-retry runs after each apply task
```

Each fan-out batch becomes a two-node chain: `compute-N` → `apply-N`. The compute node runs on a fast free provider. The apply node depends on the compute node and runs on a filesystem provider. The apply node's task description is generated from the compute node's output.

### Dynamic Apply Task Generation

Apply tasks can't be fully defined at plan creation time because their content depends on the compute task's output. The close-handler creates apply tasks dynamically after validating the compute output.

**Mechanism (close-handler dynamic creation):**

When a compute task completes, the existing completion pipeline (Phase 8 in `task-finalizer.js`) fires. A new diffusion-specific hook in the pipeline detects tasks with `metadata.diffusion_role === 'compute'` and:

1. **Extracts JSON** from the compute output — handles markdown fences, conversational wrapping, and raw JSON. Uses the same extraction logic as the `__DIFFUSION_REQUEST__` parser.
2. **Validates the schema** — checks for `file_edits[].operations[].{type, old_text, new_text}`. If validation fails, the compute task is marked `failed` and no apply task is created. Claude is notified.
3. **Creates the apply task** — constructs the apply task description directly from the parsed JSON (no 5KB output cap limitation). Adds it to the same workflow with a `diffusion_role: 'apply'` metadata flag.
4. **Sets the apply task status** to `queued` and triggers task startup.

This approach avoids the 5KB `OUTPUT_CAP_BYTES` limit in `injectDependencyOutputs` (which would truncate compute JSON), allows schema validation before wasting an apply task, and handles LLM output formatting quirks (fences, wrapping) at extraction time.

**Apply task description format:** For deletion operations (empty `new_text`), the apply prompt uses explicit "DELETE this block" instructions instead of empty replacement blocks, avoiding LLM ambiguity with adjacent empty code fences.

### Provider Routing

The planner automatically routes each stage to the optimal provider:

| Stage | Routes to | Rationale |
|-------|-----------|-----------|
| Anchor | Codex (filesystem) | Creates shared files; needs filesystem access |
| Compute | Cerebras → Groq → DeepInfra | Speed + free; no filesystem needed |
| Apply | Ollama → Codex | Filesystem access; mechanical task |

The compute stage embeds file contents directly in the task description at plan creation time — `expandComputeTaskDescription` reads each file and includes its full content in the prompt. This bypasses the `CONTEXT_STUFFING_PROVIDERS` pipeline and its per-provider token budgets (Cerebras has only 6K tokens in the context-stuffing budget, which is too small for file content + exemplar + instructions). The actual constraint becomes the provider's API context window, not the conservative TORQUE budget. For Cerebras models with 8K-32K windows, a batch of 1-2 files fits comfortably. For larger batches, the planner auto-adjusts batch size or falls back to Groq (128K context) or Google AI (800K context).

### When to Use Compute→Apply

Not every diffusion task needs the pipeline. The planner decides based on:

- **Pattern has `exemplar_before` + `exemplar_after`** → compute→apply is safe (transformation is well-defined)
- **Files are independent** (high `isolation_confidence`) → compute→apply works
- **Free compute providers are available** → pipeline saves cost and time
- **Only filesystem providers available** → skip compute stage, direct apply (v1/v2 behavior)

If no free compute providers are enabled, the planner falls back to single-stage fan-out on filesystem providers (backward compatible with v1/v2).

### Verification

The `verify_command` runs after each **apply** task (not after compute). The existing auto-verify-retry pipeline handles this — apply tasks inherit `auto_verify_on_completion: true` from the diffusion plan.

If the verify fails, the auto-fix task gets the compiler error AND the original compute output (stored in the apply task's metadata by the close-handler hook). The fix task can either re-apply with corrected edits or fall back to direct editing.

### Compute Output Reliability

LLMs may wrap JSON in markdown fences, add conversational text, or subtly alter whitespace in `old_text` strings. The close-handler extraction step handles this:

1. **Fence extraction** — strips `` ```json ... ``` `` wrappers and any text before/after the JSON block.
2. **Whitespace normalization** — if an `old_text` exact match fails during apply, the apply task tries normalized whitespace (trimmed trailing spaces, `\r\n` → `\n`) before reporting failure.
3. **Max tokens** — compute tasks set `max_tokens` to at least 8192 (overriding Cerebras's default 4096) to avoid truncating the output JSON mid-stream.
4. **Prompt discipline** — the compute prompt explicitly says "Output ONLY the JSON object, no explanation, no code fences" and includes a concrete example of the expected output format.

## Implementation Changes

### Modified Files

| File | Change |
|------|--------|
| `server/diffusion/planner.js` | Add `buildComputeApplyPipeline` function that creates two-node chains per batch. Update `buildWorkflowTasks` to select pipeline vs. direct based on provider availability. |
| `server/diffusion/planner.js` | Add `expandComputeTaskDescription` for compute stage prompts (reads file content directly, embeds in prompt with exemplar). |
| `server/diffusion/planner.js` | Add `expandApplyTaskDescription` for apply stage prompts (called by close-handler with parsed compute output). |
| `server/diffusion/compute-output-parser.js` | **NEW** — Extract JSON from compute output (fence stripping, validation, schema check). |
| `server/handlers/diffusion-handlers.js` | Update `handleCreateDiffusionPlan` to detect available providers and choose pipeline vs. direct. Add `compute_provider` and `apply_provider` options. |
| `server/tool-defs/diffusion-defs.js` | Add `compute_provider` and `apply_provider` to `create_diffusion_plan` schema. |
| `server/execution/task-finalizer.js` | Add diffusion compute close-handler hook — extract JSON, validate, create apply task dynamically. |

### New Concepts in Planner

```
buildWorkflowTasks(plan, options)
  │
  ├─ options.compute_provider set AND available?
  │     YES → buildComputeApplyPipeline()
  │             Creates: anchor → [compute-0, compute-1, ...]
  │             Compute tasks: file content embedded directly, no filesystem
  │             Apply tasks: created dynamically by close-handler after compute completes
  │     NO  → existing single-stage fan-out (v1/v2 behavior)
  │
  └─ Returns workflow tasks with correct dependency edges

Close-handler flow for compute tasks:
  compute-N completes → extract JSON → validate schema
    │                                        │
    ├─ valid → create apply-N task           ├─ invalid → mark compute failed
    │          (Ollama/Codex, queued)        │             notify Claude
    │          auto_verify_on_completion     │
    ▼                                        ▼
  apply-N runs → verify_command           Claude reviews failure
```

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Structured edit output (old_text/new_text) | Matches TORQUE's existing edit_file format. Unambiguous. Machine-parseable. |
| Direct file embedding (not context stuffing) | Bypasses the conservative per-provider token budgets (Cerebras 6K is too small). File content is read and embedded at plan creation time. |
| Close-handler dynamic apply (not template placeholder) | Avoids 5KB OUTPUT_CAP_BYTES truncation. Allows JSON validation before apply. Handles LLM output formatting quirks at extraction time. |
| Apply tasks are near-trivial | Pre-computed edits eliminate reasoning. Success rate should approach 100%. |
| Pipeline is opt-in based on provider availability | If no free compute providers exist, falls back to single-stage. No regression. |
| Verify runs on apply stage only | Compute produces instructions, apply produces code. Only code needs build verification. |
| Template placeholder for compute output | Avoids dynamic task creation. Uses existing workflow dependency resolution. |

## Observed Performance (Projected from v2 Test)

| Metric | v2 (single-stage) | v3 (compute→apply) |
|--------|--------------------|--------------------|
| Compute time (83 files) | N/A (combined) | ~17s (17 batches × 1s on Cerebras, parallel) |
| Apply time (83 files) | Bottlenecked on Ollama | ~90s (17 batches × ~5s on Ollama, limited parallelism) |
| Reasoning quality | Provider-dependent | Cerebras reasons, Ollama just applies |
| Filesystem writes | 10/83 succeeded (Cerebras can't write) | 83/83 expected (all applies go to Ollama) |
| Total wall-clock | ~5 min (mostly wasted on Cerebras no-ops) | ~2 min (compute parallel + apply parallel) |
| Cost | Free (Cerebras) + free (Ollama) | Same — both free |

## Out of Scope

- Streaming scout improvements beyond v2 — already shipped
- Recursive diffusion — v1 spec covers this
- Dashboard visualization — deferred
- Automatic provider capability detection — use explicit `compute_provider`/`apply_provider` for now
