# Smart Decomposition with Provider Capability Awareness

**Date:** 2026-04-05
**Status:** Approved

## Problem

Auto-decomposition triggers based on file characteristics (>500 lines, >=3 functions) regardless of which provider will execute the task. This causes:

1. **Agentic providers** (Codex, claude-cli) that handle complex tasks natively get unnecessarily decomposed into sub-tasks
2. **Sub-tasks lose routing context** — no template inheritance, `provider: null`, route independently through the scheduler
3. **Template bypass** — active routing template (e.g., "Codex Primary") is ignored for decomposed sub-tasks, which fall back to smart routing defaults and may route to unsuitable providers (e.g., Ollama, Cerebras)
4. **Security regression risk** — Ollama received a task it couldn't handle properly, converting `execFileSync` to `execSync` with shell injection

## Solution

Extract decomposition logic into `server/execution/task-decomposition.js`. Make decomposition a **post-routing decision** that checks provider capability class before triggering. Lock sub-tasks to the parent's resolved provider.

## Provider Classes

Defined as a constant map — architectural facts about providers, not user preferences:

| Class | Providers | Decomposition |
|-------|-----------|---------------|
| `agentic` | codex, codex-spark, claude-cli | Never — handles full complexity natively |
| `guided` | ollama | Only for: single file >1500 lines with >=3 functions, OR C# complex pattern match |
| `prompt-only` | cerebras, groq, deepinfra, google-ai, openrouter, hyperbolic, ollama-cloud, anthropic | Never — can't edit files, decomposition doesn't apply |

Note: Ollama's guided threshold is 1500 lines (not 300) because the task authoring rules (search → read range → replace_lines) make Ollama reliable up to 1500 lines.

## Architecture

### Decision Flow (new)

```
smart_submit_task
  → analyzeTaskForRouting() → provider + template resolved
  → shouldDecompose(task, routingResult)
      → getProviderClass(provider)
      → agentic? → return { decompose: false }
      → prompt-only? → return { decompose: false }
      → guided? → check file size + function count thresholds
  → if decompose: decomposeTask() → create workflow with locked sub-tasks
  → if no decompose: single task creation (existing path)
```

### Module: `server/execution/task-decomposition.js`

```js
module.exports = {
  PROVIDER_CLASSES,           // { codex: 'agentic', ollama: 'guided', ... }
  getProviderClass(provider), // returns 'agentic' | 'guided' | 'prompt-only'
  shouldDecompose(task, routingResult), // returns { decompose: bool, reason: string }
  decomposeTask(task, routingResult, options), // returns { workflow_id, tasks: [...] }
};
```

### `shouldDecompose(task, routingResult)`

1. Get provider from `routingResult.provider`
2. Look up class via `getProviderClass(provider)`
3. If `agentic` → `{ decompose: false, reason: 'agentic provider handles full complexity' }`
4. If `prompt-only` → `{ decompose: false, reason: 'prompt-only provider, decomposition not applicable' }`
5. If `guided`:
   - Check C# complex pattern (existing `isCSharpTask` + complexity check)
   - Check JS/TS: file >1500 lines AND >=3 extractable function boundaries
   - If either matches → `{ decompose: true, reason: '...' }`
   - Otherwise → `{ decompose: false, reason: 'guided provider within capability' }`

### `decomposeTask(task, routingResult, options)`

Moves existing decomposition logic from routing.js:
- C# decomposition (host-complexity.js patterns)
- JS/TS decomposition (function boundary extraction + batching)

Sub-tasks are created with:
- `provider`: locked to parent's resolved provider (not null)
- `model`: inherited from parent if set
- `version_intent`: inherited from parent
- `metadata.parent_task_id`: reference to original task
- `metadata.decomposed`: true
- `metadata.ui_review`: inherited from parent

Returns `{ workflow_id, tasks }` — caller creates the workflow.

## Changes to routing.js

Remove:
- C# decomposition block (~150 lines, routing.js:482-629)
- JS/TS decomposition block (~130 lines, routing.js:631-759)

Replace with:
```js
const { shouldDecompose, decomposeTask } = require('../execution/task-decomposition');

// After analyzeTaskForRouting() resolves routingResult:
const decomp = shouldDecompose(task, routingResult);
if (decomp.decompose) {
  const result = decomposeTask(task, routingResult, { workingDirectory, files, timeout });
  // Create workflow from result.tasks, return workflow response
} else {
  // Continue with single-task path (existing code)
}
```

This cuts ~280 lines from the 963-line `handleSmartSubmitTask`.

## No Configuration

Provider classes are constant — not configurable per-project. The classes reflect architectural capabilities:
- Agentic providers have sandboxes and file tools → no decomposition needed
- Guided providers have tool-calling but limited context → decompose huge tasks
- Prompt-only providers can't edit files → decomposition irrelevant

If a user wants to avoid decomposition, they set `provider: "codex"` explicitly (existing behavior — user override skips all routing including decomposition).

## Testing

- Unit tests for `shouldDecompose`: verify each provider class returns correct decision
- Unit tests for `decomposeTask`: verify sub-tasks inherit provider, model, version_intent, metadata
- Integration test: submit a complex task with Codex Primary template active, verify NO decomposition
- Integration test: submit a huge-file task with ollama, verify decomposition triggers at 1500 lines
- Regression test: verify decomposed sub-tasks have `provider` set (not null)

## Migration

- Existing C# and JS/TS decomposition logic moves 1:1 into the new module
- Threshold for JS/TS changes from 500 → 1500 lines (reflecting Ollama's improved capability)
- No database migration needed
- No API changes — `smart_submit_task` interface unchanged
