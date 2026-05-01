# Agentic Worker Isolation + Smart Routing with Fallback Chains

**Date:** 2026-03-18
**Status:** Approved
**Scope:** Two-phase delivery: (1) fix TORQUE runtime hang via worker thread isolation, (2) evolve routing templates to support provider+model fallback chains

## Problem

Two connected issues block production use of agentic tool calling in TORQUE:

1. **Runtime hang** — Agentic adapter HTTP calls hang on follow-up requests inside the TORQUE server process. The same code works perfectly in standalone Node.js. Root cause: TORQUE's 4 HTTP servers (API:3457, dashboard:3456, MCP SSE:3458, GPU metrics:9394) plus synchronous `better-sqlite3` DB operations share the event loop with outbound HTTPS requests, causing I/O starvation on the adapter connections.

2. **No fallback routing** — When a provider fails (429, timeout, quota), the task fails. There's no automatic retry with a different provider. The routing template system maps category to a single provider string, with no chain or model specification.

## Solution

**Phase 1:** Run the agentic loop in a `worker_threads` Worker, isolating outbound HTTP from TORQUE's event loop.

**Phase 2:** Evolve routing templates from `category → provider` to `category → [{provider, model}, ...]` fallback chains with health-aware pre-filtering.

## Phase 1: Worker Thread Isolation

### Architecture

```
Main Thread (TORQUE server)              Worker Thread (isolated)
─────────────────────────────           ─────────────────────────
execution.js                             agentic-worker.js
  │                                        │
  ├─ resolves provider, model, host        │
  ├─ captures git snapshot                 │
  ├─ spawns Worker ──────────────────────► │ receives task config
  │                                        ├─ creates tool executor
  │   ◄── progress messages ──────────────┤ ├─ runs agentic loop
  │   (iteration count, tool calls)        │ ├─ adapter HTTP calls
  │                                        │ │  (own event loop!)
  ├─ updates task status                   │ ├─ executes tools
  ├─ streams output to dashboard           │ ├─ manages context
  │                                        │ │
  │   ◄── result message ────────────────┤ └─ posts final result
  ├─ checks git safety                     │
  ├─ stores metadata                       │
  ├─ calls handleWorkflowTermination       Worker exits
  └─ processQueue
```

### New file: `providers/agentic-worker.js`

The worker thread script. Receives configuration via `workerData`, runs the agentic loop, posts results back.

**Input (via `workerData`):**
```js
{
  adapterType: 'ollama' | 'openai' | 'google',
  adapterOptions: { host, apiKey, model, temperature, ... },
  systemPrompt: string,
  taskPrompt: string,
  workingDir: string,
  timeoutMs: number,
  maxIterations: number,
  contextBudget: number,
  promptInjectedTools: boolean,
}
```

**Output (via `parentPort.postMessage`):**

Progress messages:
```js
{ type: 'progress', iteration: 2, maxIterations: 10, lastTool: 'list_directory' }
{ type: 'toolCall', name: 'edit_file', args: {...}, result: 'ok', durationMs: 5 }
{ type: 'chunk', text: '...' }  // streaming text output
```

Final result:
```js
{ type: 'result', output: string, toolLog: Array, changedFiles: string[], iterations: number, tokenUsage: Object }
```

Error:
```js
{ type: 'error', message: string }
```

**Worker internals:**
1. Requires `ollama-agentic.js` (runAgenticLoop), `ollama-tools.js` (createToolExecutor, TOOL_DEFINITIONS), and the appropriate adapter
2. Creates tool executor with `workingDir` and command sandbox settings
3. Runs `runAgenticLoop` with callbacks that post progress messages to `parentPort`
4. On completion, posts the result and exits
5. On error, posts the error and exits with code 1
6. Respects AbortSignal: main thread can post `{ type: 'abort' }` to trigger cancellation

**Cancellation:** Main thread listens for task cancellation (existing `cancelCheckInterval` pattern). When detected, posts `{ type: 'abort' }` to the worker, which sets an AbortController signal that the agentic loop respects.

### Modifications to `providers/execution.js`

Replace direct `runAgenticLoop` / `runAgenticPipeline` calls with worker spawning:

```js
const { Worker } = require('worker_threads');

async function runAgenticInWorker(config) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      path.join(__dirname, 'agentic-worker.js'),
      { workerData: config }
    );

    worker.on('message', (msg) => {
      switch (msg.type) {
        case 'progress': onProgress(msg); break;
        case 'toolCall': onToolCall(msg); break;
        case 'chunk': onChunk(msg); break;
        case 'result': resolve(msg); break;
        case 'error': reject(new Error(msg.message)); break;
      }
    });

    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
    });
  });
}
```

The `executeOllamaTaskWithAgentic` and `executeApiProviderWithAgentic` wrappers call `runAgenticInWorker` instead of `runAgenticPipeline`. Everything else (git safety, metadata storage, workflow termination) stays in the main thread.

### What stays in main thread
- Provider/model resolution
- Git snapshot capture and revert
- Task status updates and dashboard notifications
- Metadata storage
- Workflow termination
- Queue processing

### What moves to worker
- Adapter HTTP calls (the part that hangs)
- Tool execution (file I/O, commands)
- Agentic loop logic (context management, stuck detection)
- Tool call parsing

## Phase 2: Smart Routing with Fallback Chains

### Schema Evolution

The `rules` field in routing templates evolves from string values to chain arrays. Both formats are supported — backward compatible.

**Legacy format (still works):**
```json
{
  "rules": {
    "security": "cerebras",
    "documentation": "groq",
    "default": "ollama"
  }
}
```

**New format (fallback chains):**
```json
{
  "rules": {
    "security": [
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "groq", "model": "qwen/qwen3-32b"},
      {"provider": "google-ai", "model": "gemini-2.5-flash"}
    ],
    "default": [
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "groq", "model": "qwen/qwen3-32b"},
      {"provider": "google-ai", "model": "gemini-2.5-flash"},
      {"provider": "ollama-cloud", "model": "kimi-k2:1t"},
      {"provider": "openrouter", "model": "nvidia/nemotron-3-nano-30b-a3b:free"}
    ]
  }
}
```

**Mixed format (global chain + per-category overrides):**
```json
{
  "rules": {
    "security": "cerebras",
    "large_code_gen": [
      {"provider": "ollama-cloud", "model": "kimi-k2:1t"},
      {"provider": "ollama-cloud", "model": "qwen3-coder:480b"}
    ],
    "default": [
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "groq", "model": "qwen/qwen3-32b"}
    ]
  }
}
```

Legacy string values are auto-wrapped: `"cerebras"` becomes `[{"provider": "cerebras"}]` (no model = use PROVIDER_DEFAULT_MODEL).

### resolveProvider Evolution

Current signature:
```js
function resolveProvider(template, category, complexity)
  → string | null  // provider name
```

New signature:
```js
function resolveProvider(template, category, complexity)
  → { provider: string, model?: string, chain?: Array } | null
```

Returns the first healthy entry from the chain. The full chain is included so callers can retry with the next entry on failure.

### Health-Aware Pre-Filtering

Before returning a chain entry, check cached health:

```js
function resolveProvider(template, category, complexity) {
  const chain = resolveChain(template, category, complexity);
  if (!chain) return null;

  for (const entry of chain) {
    if (isProviderHealthy(entry.provider)) {
      return { ...entry, chain };
    }
  }
  // All unhealthy — return first anyway (let it fail and update health)
  return { ...chain[0], chain };
}
```

`isProviderHealthy` checks `provider_health_history` for recent failures (429 in last 60s, timeout in last 30s). This data is already tracked by the existing health monitoring.

### Fallback Retry Integration

In `execution.js`, when an agentic task fails with a retryable error:

```js
async function executeWithFallback(task, routing) {
  const { chain } = routing;
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    try {
      return await runAgenticInWorker({
        adapterType: selectAdapterType(entry.provider),
        adapterOptions: { host: getHost(entry.provider), apiKey: resolveApiKey(entry.provider), model: entry.model },
        ...commonConfig,
      });
    } catch (error) {
      if (!isRetryableError(error) || i === chain.length - 1) throw error;
      recordProviderFailure(entry.provider, error);
      logger.info(`[Routing] ${entry.provider}/${entry.model} failed (${error.message}), trying next in chain`);
    }
  }
}
```

`isRetryableError` returns true for: 429, 503, timeouts, connection refused, quota exceeded. Returns false for: 400 (bad request), 401 (auth), task-level errors.

### New Preset Template: "Free Agentic"

```json
{
  "name": "Free Agentic",
  "description": "Zero-cost agentic tool calling with automatic fallback across 5 free cloud providers",
  "rules": {
    "security": [
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "ollama-cloud", "model": "mistral-large-3:675b"},
      {"provider": "google-ai", "model": "gemini-2.5-flash"}
    ],
    "xaml_wpf": [
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "groq", "model": "qwen/qwen3-32b"},
      {"provider": "google-ai", "model": "gemini-2.5-flash"}
    ],
    "architectural": [
      {"provider": "ollama-cloud", "model": "kimi-k2:1t"},
      {"provider": "ollama-cloud", "model": "mistral-large-3:675b"},
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"}
    ],
    "reasoning": [
      {"provider": "ollama-cloud", "model": "mistral-large-3:675b"},
      {"provider": "ollama-cloud", "model": "kimi-k2:1t"},
      {"provider": "google-ai", "model": "gemini-2.5-flash"}
    ],
    "large_code_gen": [
      {"provider": "ollama-cloud", "model": "kimi-k2:1t"},
      {"provider": "ollama-cloud", "model": "qwen3-coder:480b"},
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"}
    ],
    "documentation": [
      {"provider": "groq", "model": "openai/gpt-oss-120b"},
      {"provider": "google-ai", "model": "gemini-2.5-flash"},
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"}
    ],
    "simple_generation": [
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "groq", "model": "qwen/qwen3-32b"},
      {"provider": "openrouter", "model": "nvidia/nemotron-3-nano-30b-a3b:free"}
    ],
    "targeted_file_edit": [
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "groq", "model": "openai/gpt-oss-120b"},
      {"provider": "groq", "model": "qwen/qwen3-32b"}
    ],
    "default": [
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "groq", "model": "qwen/qwen3-32b"},
      {"provider": "google-ai", "model": "gemini-2.5-flash"},
      {"provider": "ollama-cloud", "model": "kimi-k2:1t"},
      {"provider": "openrouter", "model": "nvidia/nemotron-3-nano-30b-a3b:free"}
    ]
  },
  "complexity_overrides": {
    "targeted_file_edit": {
      "complex": [
        {"provider": "ollama-cloud", "model": "kimi-k2:1t"},
        {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"}
      ]
    }
  }
}
```

### Existing Preset Updates

The 5 existing presets keep their legacy string format — no changes needed. They continue to work via auto-wrapping. Users can duplicate and convert to chain format if they want fallbacks.

## File Structure

### Phase 1
| File | Change |
|------|--------|
| `providers/agentic-worker.js` | New — worker thread script |
| `providers/execution.js` | Modify — spawn worker instead of direct loop call |
| `tests/agentic-worker.test.js` | New — worker isolation tests |

### Phase 2
| File | Change |
|------|--------|
| `routing/template-store.js` | Modify — `resolveProvider` handles chains, `validateTemplate` accepts both formats |
| `routing/templates/free-agentic.json` | New — preset template |
| `db/provider-routing-core.js` | Modify — `analyzeTaskForRouting` returns chain, health pre-filtering |
| `providers/execution.js` | Modify — fallback retry loop |
| `tests/agentic-routing.test.js` | New — chain resolution, fallback, health filtering tests |

### What doesn't change
- `routing/category-classifier.js` — existing 9 categories sufficient
- `routing/templates/*.json` (existing 5 presets) — legacy format keeps working
- `providers/ollama-tools.js` — tool executor unchanged
- `providers/ollama-agentic.js` — loop logic unchanged (runs inside worker)
- `providers/adapters/*.js` — all 3 adapters unchanged
- `providers/agentic-capability.js` — capability detection unchanged
- `providers/agentic-git-safety.js` — git safety unchanged (runs in main thread)

## Spec Review Fixes

Issues identified by code reviewer, all addressed:

### Critical: Logger isolation in worker thread

The `ollama-agentic.js` logger (`require('../logger')`) holds singleton state (file handles). Duplicating it in the worker causes interleaved writes.

**Fix:** The worker uses a lightweight logger wrapper that posts log messages to the main thread via `parentPort.postMessage({ type: 'log', level, message })`. The main thread handler feeds these into the real logger. The worker never imports `../logger` directly.

### Critical: `validateTemplate` rejects chain format

The existing validation at `template-store.js:93-97` enforces `typeof value === 'string'` for all rule values. This blocks the new array format.

**Fix:** Update validation to accept both:
```js
for (const [key, value] of Object.entries(data.rules)) {
  if (typeof value === 'string') {
    if (value.trim().length === 0) errors.push(`rules.${key} must be non-empty`);
  } else if (Array.isArray(value)) {
    if (value.length === 0) errors.push(`rules.${key} chain must have at least one entry`);
    for (const entry of value) {
      if (!entry.provider || typeof entry.provider !== 'string') {
        errors.push(`rules.${key} chain entry must have a provider string`);
      }
    }
  } else {
    errors.push(`rules.${key} must be a string or array of {provider, model?} objects`);
  }
}
```

Same treatment for `complexity_overrides` values.

### Important: `resolveProvider` return type breaking change

All callers expect a string. Changing to object breaks `analyzeTaskForRouting` and downstream consumers (`economy/queue-reroute.js`, `handlers/integration/index.js`, etc.).

**Fix:** `resolveProvider` returns a new shape but with backward-compatible accessors:
```js
function resolveProvider(template, category, complexity) {
  const chain = resolveChain(template, category, complexity);
  if (!chain || chain.length === 0) return null;

  // Find first healthy entry
  let selected = chain[0];
  for (const entry of chain) {
    if (isProviderHealthy(entry.provider)) { selected = entry; break; }
  }

  // Return string-coercible object: String(result) returns provider name
  // Callers expecting a string get backward compat via toString/valueOf
  return {
    provider: selected.provider,
    model: selected.model || null,
    chain,
    toString() { return selected.provider; },
    valueOf() { return selected.provider; },
  };
}
```

Callers that do `if (result === 'cerebras')` will work via `valueOf`. Callers that do `result.provider` get the explicit field. New code uses `result.chain` for fallback.

### Important: `isProviderHealthy` semantics

The spec described granular per-error-type tracking (429 in 60s, timeout in 30s), but the existing implementation uses aggregate failure rate in a 1-hour window.

**Fix:** Use the existing `isProviderHealthy` implementation as-is. The 30% failure rate threshold in a 1-hour window is sufficient for health-aware pre-filtering. No new health tracking mechanism needed for Phase 2. Per-error-type tracking can be added later if the aggregate approach proves insufficient.

### Important: `recordProviderFailure` does not exist

**Fix:** Use the existing `recordProviderOutcome(provider, false)` from `provider-routing-core.js`. The pseudocode in the spec is illustrative; implementation uses the actual function name.

### Important: System prompt augmentation for `promptInjectedTools`

**Fix:** The system prompt passed to the worker via `workerData.systemPrompt` is fully built by the main thread — `buildAgenticSystemPrompt()` + prompt-injected tool definitions (for codestral etc.) are applied before spawning the worker. The worker receives the final prompt string, not a base prompt.

### Important: Worker cleanup between fallback attempts

**Fix:** Before spawning the next worker in the fallback chain, call `worker.terminate()` on the previous worker. This is the hard-kill escape hatch for workers stuck in synchronous `execSync` calls. Add to `executeWithFallback`:
```js
} catch (error) {
  worker.terminate(); // Hard kill before fallback
  if (!isRetryableError(error) || i === chain.length - 1) throw error;
  ...
}
```

### Important: AbortSignal not cloneable

**Fix:** The AbortSignal is NOT passed via `workerData` (not cloneable). Instead:
- Main thread posts `{ type: 'abort' }` to the worker
- Worker creates its own `AbortController` internally
- Worker listens for `parentPort.on('message')` and calls `controller.abort()` on abort messages
- The `apiAbortControllers` map in the main thread is updated to reference a proxy that posts the abort message to the worker

### Suggestions addressed

- **Worker pool:** Noted as future optimization. Phase 1 spawns a new worker per task — overhead (~50-100ms) is negligible for tasks taking seconds to minutes.
- **Promise double-rejection:** Add `let settled = false` flag in `runAgenticInWorker` — first settlement wins, subsequent events are no-ops.
- **Chain length limits:** `validateTemplate` enforces max 7 entries per chain. Documented.
- **Partial completion / git state:** Git snapshot is captured before the first fallback attempt. If a provider fails mid-execution, `checkAndRevert` runs between attempts to restore clean state before retrying with the next provider.
- **Observability:** Fallback events logged as `logger.info('[Routing] Fallback: {provider}/{model} failed, trying {next} (position {n}/{total})')`. Dashboard notification via existing `notifyTaskOutput`. Per-category fallback frequency tracked via `recordProviderOutcome`.
- **Function name corrections:** `selectAdapterType` → use existing `selectAdapter` pattern. `getHost` → use existing `PROVIDER_HOST_MAP`. `recordProviderFailure` → use `recordProviderOutcome`.

## Testing Strategy

### Phase 1
- Unit test: worker receives config, runs mock loop, posts result
- Unit test: worker handles abort via `parentPort` message
- Unit test: main thread receives progress/toolCall/chunk messages
- Unit test: worker uses logger wrapper (no direct `../logger` import)
- Unit test: `worker.terminate()` kills stuck worker
- Integration test: full agentic task via worker against live Ollama (the test that currently hangs)
- Regression: all 129 existing agentic tests still pass (6 test files)

### Phase 2
- Unit test: `resolveProvider` returns chain entry for array format
- Unit test: `resolveProvider` auto-wraps legacy string to single-entry chain
- Unit test: `resolveProvider` result is string-coercible (backward compat)
- Unit test: health pre-filtering skips unhealthy providers
- Unit test: `validateTemplate` accepts both legacy and chain formats
- Unit test: `validateTemplate` enforces max 7 chain entries
- Unit test: fallback retry loop tries next provider on retryable error
- Unit test: fallback stops on non-retryable error
- Unit test: fallback calls `worker.terminate()` before retry
- Unit test: git state reverted between fallback attempts
- Unit test: `resolveProvider` return type works with existing callers (string comparison)
- Integration test: submit task with "Free Agentic" template, verify fallback on simulated 429
