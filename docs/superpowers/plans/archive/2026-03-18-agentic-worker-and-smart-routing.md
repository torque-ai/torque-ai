# Agentic Worker Isolation + Smart Routing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the TORQUE runtime hang by isolating agentic HTTP calls in worker threads, then evolve routing templates to support provider+model fallback chains with health-aware pre-filtering.

**Architecture:** Phase 1 moves the agentic loop into `worker_threads` Workers so outbound HTTP calls have their own event loop, isolated from TORQUE's 4 servers. Phase 2 evolves routing template `rules` values from single strings to ordered fallback chains of `{provider, model}` entries, with backward compatibility via `toString()/valueOf()`. A new "Free Agentic" preset template routes across 14 baselined free models.

**Tech Stack:** Node.js (CommonJS, `worker_threads`), better-sqlite3, Vitest

**Spec:** `docs/superpowers/specs/2026-03-18-agentic-worker-and-smart-routing-design.md`

---

## File Structure

### Phase 1 — Worker Thread Isolation
| File | Responsibility |
|------|---------------|
| `server/providers/agentic-worker.js` | New — worker thread script: receives config via workerData, runs agentic loop, posts messages back via parentPort |
| `server/providers/execution.js` | Modify — `runAgenticInWorker()` spawns Worker, replaces `runAgenticPipeline()` calls |
| `server/tests/agentic-worker.test.js` | New — worker isolation unit and integration tests |

### Phase 2 — Smart Routing with Fallback Chains
| File | Responsibility |
|------|---------------|
| `server/routing/template-store.js` | Modify — `resolveProvider` returns chain-aware object with toString/valueOf backward compat; `validateTemplate` accepts string and array formats |
| `server/routing/templates/free-agentic.json` | New — preset template with baseline-driven fallback chains |
| `server/db/provider-routing-core.js` | Modify — `analyzeTaskForRouting` propagates chain from template resolution |
| `server/providers/execution.js` | Modify — `executeWithFallback` retry loop, git revert between attempts, worker.terminate() cleanup |
| `server/tests/agentic-routing.test.js` | New — chain resolution, backward compat, fallback retry, health filtering tests |

---

## Phase 1: Worker Thread Isolation

### Task 1: Agentic Worker Script

Create `agentic-worker.js` — the worker thread that runs the agentic loop in isolation.

**Files:**
- Create: `server/providers/agentic-worker.js`
- Create: `server/tests/agentic-worker.test.js`

- [ ] **Step 1: Write failing tests for worker message protocol**

Create `server/tests/agentic-worker.test.js`:

Tests using a mock agentic loop (inject via a test seam):
- Worker posts `{ type: 'result', output, toolLog, changedFiles, iterations, tokenUsage }` on success
- Worker posts `{ type: 'error', message }` on failure
- Worker posts `{ type: 'progress', iteration, maxIterations, lastTool }` during execution
- Worker posts `{ type: 'toolCall', name, args, result, durationMs }` for each tool call
- Worker posts `{ type: 'chunk', text }` for streaming output
- Worker responds to `{ type: 'abort' }` message by aborting the loop
- Worker posts `{ type: 'log', level, message }` instead of writing to logger directly

Mock approach: the worker script should accept a `workerData._testMode` flag that replaces the real agentic loop with a controllable mock. This avoids needing real Ollama for unit tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /path/to/torque && npx vitest run server/tests/agentic-worker.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement agentic-worker.js**

Create `server/providers/agentic-worker.js`:

1. Import `workerData` and `parentPort` from `worker_threads`
2. Create a logger wrapper that posts `{ type: 'log', level, message }` to parentPort instead of writing to files. Inject this as the logger for `ollama-agentic.js` (or monkey-patch the logger module in the worker context)
3. Select adapter based on `workerData.adapterType`:
   ```js
   const adapters = {
     ollama: require('./adapters/ollama-chat'),
     openai: require('./adapters/openai-chat'),
     google: require('./adapters/google-chat'),
   };
   const adapter = adapters[workerData.adapterType];
   ```
4. Create tool executor: `createToolExecutor(workerData.workingDir, { commandMode: workerData.commandMode || 'unrestricted', commandAllowlist: workerData.commandAllowlist || [] })`
5. Create internal `AbortController`. Listen for `parentPort.on('message')` — on `{ type: 'abort' }`, call `controller.abort()`
6. Run `runAgenticLoop` with:
   - `adapter`, `systemPrompt`, `taskPrompt` from workerData
   - `tools: workerData.promptInjectedTools ? [] : TOOL_DEFINITIONS`
   - `promptInjectedTools: workerData.promptInjectedTools`
   - `options: workerData.adapterOptions`
   - `timeoutMs`, `maxIterations`, `contextBudget` from workerData
   - `signal: controller.signal`
   - `onProgress: (iter, max, tool) => parentPort.postMessage({ type: 'progress', iteration: iter, maxIterations: max, lastTool: tool })`
   - `onToolCall: (name, args, result) => parentPort.postMessage({ type: 'toolCall', name, args: JSON.stringify(args).slice(0,200), result: String(result?.result || '').slice(0,200), durationMs: result?.duration_ms })`
7. On success: `parentPort.postMessage({ type: 'result', ...result })` then `process.exit(0)`
8. On error: `parentPort.postMessage({ type: 'error', message: err.message })` then `process.exit(1)`
9. For `_testMode`: if `workerData._testMode`, run a simplified mock loop instead of the real one

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /path/to/torque && npx vitest run server/tests/agentic-worker.test.js`

- [ ] **Step 5: Commit**

```bash
cd /path/to/torque
git add server/providers/agentic-worker.js server/tests/agentic-worker.test.js
git commit -m "feat(agentic): worker thread script with message protocol and abort support"
```

---

### Task 2: Wire Worker into Execution Wrappers

Replace `runAgenticPipeline()` calls in `execution.js` with `runAgenticInWorker()`.

**Files:**
- Modify: `server/providers/execution.js`

- [ ] **Step 1: Add `runAgenticInWorker` function**

Add to `execution.js` (after imports, before `runAgenticPipeline`):

```js
const { Worker } = require('worker_threads');

async function runAgenticInWorker(config, callbacks = {}) {
  const { onProgress, onToolCall, onChunk, onLog } = callbacks;

  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(
      path.join(__dirname, 'agentic-worker.js'),
      { workerData: config }
    );

    // Proxy for abort — main thread can call workerAbort() to signal the worker
    const workerAbort = () => worker.postMessage({ type: 'abort' });

    worker.on('message', (msg) => {
      if (settled) return;
      switch (msg.type) {
        case 'progress': if (onProgress) onProgress(msg); break;
        case 'toolCall': if (onToolCall) onToolCall(msg); break;
        case 'chunk': if (onChunk) onChunk(msg); break;
        case 'log': if (onLog) onLog(msg); break;
        case 'result':
          settled = true;
          resolve(msg);
          break;
        case 'error':
          settled = true;
          reject(new Error(msg.message));
          break;
      }
    });

    worker.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });

    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        settled = true;
        reject(new Error(`Worker exited with code ${code}`));
      }
    });

    // Expose abort and terminate on the promise for callers
    resolve._worker = worker;
    resolve._abort = workerAbort;
  });
}
```

Note: the `_worker` and `_abort` attachment to `resolve` won't work on a standard Promise. Instead, return a wrapper object:

```js
// Better: return { promise, abort, terminate }
function spawnAgenticWorker(config, callbacks) {
  const worker = new Worker(...);
  const workerAbort = () => worker.postMessage({ type: 'abort' });
  const promise = new Promise((resolve, reject) => { /* message handlers */ });
  return { promise, abort: workerAbort, terminate: () => worker.terminate() };
}
```

- [ ] **Step 2: Replace `runAgenticPipeline` calls in `executeOllamaTaskWithAgentic`**

Find the `runAgenticPipeline({...})` call (around line 470) and replace with:

```js
const workerHandle = spawnAgenticWorker({
  adapterType: 'ollama',
  adapterOptions: { host: ollamaHost, apiKey: resolveApiKey(provider), model: resolvedModel, ...tuningOptions },
  systemPrompt,
  taskPrompt: task.task_description,
  workingDir,
  timeoutMs,
  maxIterations,
  contextBudget,
  promptInjectedTools: usePromptInjection,
  commandMode: serverConfig.get('agentic_command_mode') || 'unrestricted',
  commandAllowlist: (serverConfig.get('agentic_command_allowlist') || '').split(',').filter(Boolean),
}, {
  onProgress: (msg) => { /* update task status */ },
  onToolCall: (msg) => { /* notify dashboard */ },
  onChunk: (msg) => { /* stream to dashboard */ },
  onLog: (msg) => { logger[msg.level || 'info'](msg.message); },
});

// Wire abort: replace the abortController proxy
const origAbort = abortController.abort.bind(abortController);
abortController.abort = () => { origAbort(); workerHandle.abort(); };

const result = await workerHandle.promise;
```

Keep all post-pipeline code (git safety, metadata, workflow termination) unchanged.

- [ ] **Step 3: Replace `runAgenticPipeline` call in `executeApiProviderWithAgentic`**

Same pattern as Step 2, but with `adapterType` based on the provider:
```js
adapterType: provider === 'ollama-cloud' ? 'ollama' : provider === 'google-ai' ? 'google' : 'openai',
```

- [ ] **Step 4: Run all agentic tests to verify no regressions**

Run: `cd /path/to/torque && npx vitest run server/tests/agentic-*.test.js`
Expected: 129+ tests pass. The existing tests call `runAgenticLoop` directly (not through workers), so they should be unaffected.

- [ ] **Step 5: Integration test — run agentic task via TORQUE MCP**

Restart TORQUE and submit a task via MCP:
```
submit_task({ task: "Use list_directory to list tests/", working_directory: "/path/to/project", provider: "groq" })
```
Verify: task completes with real directory listing (no hang on iteration 2+).

- [ ] **Step 6: Commit**

```bash
cd /path/to/torque
git add server/providers/execution.js
git commit -m "feat(agentic): spawn worker threads for agentic tasks — fixes runtime hang"
```

---

## Phase 2: Smart Routing with Fallback Chains

### Task 3: Template Store Chain Support

Modify `resolveProvider` and `validateTemplate` to handle both string and array formats.

**Files:**
- Modify: `server/routing/template-store.js`
- Create: `server/tests/agentic-routing.test.js`

- [ ] **Step 1: Write failing tests for chain resolution**

Create `server/tests/agentic-routing.test.js`:

Tests:
- `resolveProvider` with legacy string rule returns `{ provider: 'cerebras', model: null, chain: [{provider:'cerebras'}] }`
- `resolveProvider` with chain array returns first entry with full chain
- `resolveProvider` result coerces to string via `toString()`/`valueOf()` (backward compat: `String(result) === 'cerebras'`, `result == 'cerebras'`)
- `resolveProvider` with complexity override (chain format) returns override entry
- `resolveProvider` with complexity override (legacy string) returns wrapped entry
- `resolveProvider` returns category-specific chain, falls back to `default` chain when category missing
- `validateTemplate` accepts legacy string format (existing behavior)
- `validateTemplate` accepts chain array format with `{provider, model}` entries
- `validateTemplate` accepts mixed format (some strings, some arrays)
- `validateTemplate` rejects chain with > 7 entries
- `validateTemplate` rejects chain entry without `provider` string
- `validateTemplate` rejects empty chain array

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /path/to/torque && npx vitest run server/tests/agentic-routing.test.js`

- [ ] **Step 3: Implement chain support in template-store.js**

Modify `server/routing/template-store.js`:

1. Add `resolveChain(template, category, complexity)` helper that:
   - Checks `complexity_overrides[category][complexity]` first
   - Falls back to `rules[category]`
   - Falls back to `rules.default`
   - Normalizes result: if string, wraps as `[{provider: string}]`; if array, returns as-is
   - Returns `null` if nothing found

2. Modify `resolveProvider(template, category, complexity)`:
   - Call `resolveChain()`
   - Return `null` if chain is empty/null
   - Return first entry as `{ provider, model, chain, toString(), valueOf() }`

3. Modify `validateTemplate(data)`:
   - For each `rules` value: accept string (non-empty) OR array (1-7 entries, each with `provider` string)
   - Same for `complexity_overrides` values
   - Max chain length: 7

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Run existing routing template tests to verify no regressions**

Run: `cd /path/to/torque && npx vitest run server/tests/routing-templates.test.js`

- [ ] **Step 6: Commit**

```bash
cd /path/to/torque
git add server/routing/template-store.js server/tests/agentic-routing.test.js
git commit -m "feat(routing): resolveProvider returns chain-aware objects with backward-compat toString"
```

---

### Task 4: Free Agentic Preset Template

Create the "Free Agentic" preset template with baseline-driven fallback chains.

**Files:**
- Create: `server/routing/templates/free-agentic.json`

- [ ] **Step 1: Create the template file**

Create `server/routing/templates/free-agentic.json` with the exact content from the spec (lines 264-326). All 9 categories have chains of 3-5 models, ordered by baseline performance. The `default` chain has all 5 providers as universal fallback.

- [ ] **Step 2: Verify template loads**

Run: `cd /path/to/torque/server && node -e "const ts = require('./routing/template-store'); const db = require('./database'); db.init(); ts.setDb(db.getDbInstance()); ts.ensureTable(); ts.seedPresets(); console.log(ts.listTemplates().map(t => t.name))"`

Expected: output includes "Free Agentic" alongside the 5 existing presets.

- [ ] **Step 3: Commit**

```bash
cd /path/to/torque
git add server/routing/templates/free-agentic.json
git commit -m "feat(routing): add Free Agentic preset template with fallback chains across 5 free providers"
```

---

### Task 5: Fallback Retry Loop in Execution

Wire the fallback chain into the agentic execution wrappers.

**Files:**
- Modify: `server/providers/execution.js`
- Modify: `server/tests/agentic-routing.test.js`

- [ ] **Step 1: Write failing tests for fallback retry**

Append to `server/tests/agentic-routing.test.js`:

Tests:
- `executeWithFallback` calls first provider, succeeds → returns result
- `executeWithFallback` first provider fails with 429, retries with second → succeeds
- `executeWithFallback` first provider fails with 400 (non-retryable) → throws immediately
- `executeWithFallback` all providers fail → throws last error
- `executeWithFallback` calls `worker.terminate()` before retrying
- `executeWithFallback` reverts git state between attempts (mock `checkAndRevert`)
- `isRetryableError` returns true for 429, 503, timeout, ECONNREFUSED, quota
- `isRetryableError` returns false for 400, 401, "old_text not found"

Mock `spawnAgenticWorker` to control success/failure per call.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement fallback retry**

Add to `server/providers/execution.js`:

1. `isRetryableError(error)` function:
   ```js
   function isRetryableError(error) {
     const msg = (error.message || '').toLowerCase();
     return /429|503|timeout|timed out|econnrefused|quota|rate.limit|overloaded/.test(msg);
   }
   ```

2. `executeWithFallback(task, chain, baseConfig, callbacks)` function:
   - Iterates chain entries
   - For each: builds worker config with entry's provider/model, calls `spawnAgenticWorker`
   - On success: return result
   - On retryable failure: `workerHandle.terminate()`, revert git state via `checkAndRevert(workingDir, snapshot, task.task_description, 'enforce')`, log fallback, call `recordProviderOutcome(entry.provider, false)`, continue to next
   - On non-retryable failure or last entry: throw
   - Log: `[Routing] Fallback: {provider}/{model} failed, trying {next} (position {n}/{total})`

3. Modify `executeOllamaTaskWithAgentic` and `executeApiProviderWithAgentic`:
   - If the routing result has a `chain` with > 1 entry, use `executeWithFallback`
   - If single entry (no chain or chain length 1), use direct `spawnAgenticWorker` (no retry overhead)

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
cd /path/to/torque
git add server/providers/execution.js server/tests/agentic-routing.test.js
git commit -m "feat(routing): fallback retry loop with worker cleanup and git revert between attempts"
```

---

### Task 6: Wire Chain into Provider Routing

Connect the template chain resolution to `analyzeTaskForRouting` so tasks get routed with their full fallback chain.

**Files:**
- Modify: `server/db/provider-routing-core.js`

- [ ] **Step 1: Modify template-based routing block**

In `analyzeTaskForRouting` (around line 459-493), the template routing block currently does:
```js
const targetProvider = templateStore.resolveProvider(activeTemplate, category, complexity);
```

Update to propagate the chain:
```js
const resolved = templateStore.resolveProvider(activeTemplate, category, complexity);
if (resolved) {
  const providerConfig = getProvider(resolved.provider);
  if (providerConfig && providerConfig.enabled) {
    return maybeApplyFallback({
      provider: resolved.provider,
      model: resolved.model,
      chain: resolved.chain,
      rule: null,
      complexity,
      reason: `Template '${activeTemplate.name}': ${category} -> ${resolved.provider}${resolved.model ? '/' + resolved.model : ''} (chain: ${resolved.chain.length})`,
    });
  }
  // Target unavailable — try next in chain instead of just default
  if (resolved.chain && resolved.chain.length > 1) {
    for (let i = 1; i < resolved.chain.length; i++) {
      const fallback = resolved.chain[i];
      const fbConfig = getProvider(fallback.provider);
      if (fbConfig && fbConfig.enabled) {
        return maybeApplyFallback({
          provider: fallback.provider,
          model: fallback.model,
          chain: resolved.chain,
          rule: null,
          complexity,
          reason: `Template '${activeTemplate.name}': ${category} -> ${resolved.provider} (unavailable), chain fallback to ${fallback.provider}`,
        });
      }
    }
  }
}
```

- [ ] **Step 2: Propagate `model` and `chain` from routing result to task**

In `task-manager.js` `resolveProviderRouting`, the routing result is `{ provider, ... }`. The `model` and `chain` fields need to flow to the execution wrappers. Check that `task.model` and `task._routing_chain` (or similar) are set from the routing result.

This may require adding `model` and `chain` to the routing result in `resolveProviderRouting` and reading them in the execution wrappers.

- [ ] **Step 3: Run existing routing tests**

Run: `cd /path/to/torque && npx vitest run server/tests/routing-templates.test.js server/tests/provider-routing.test.js`
Expected: all pass (backward compat via toString/valueOf).

- [ ] **Step 4: Commit**

```bash
cd /path/to/torque
git add server/db/provider-routing-core.js
git commit -m "feat(routing): propagate fallback chains from template resolution to task execution"
```

---

### Task 7: Integration Test and Final Verification

End-to-end test of the full pipeline: template routing → chain resolution → worker execution → fallback retry.

**Files:**
- Modify: `server/tests/agentic-routing.test.js`

- [ ] **Step 1: Write integration test**

Append to `server/tests/agentic-routing.test.js`:

- Test: activate "Free Agentic" template, submit a task, verify it routes through the chain
- Test: simulate first provider 429, verify fallback to second provider
- Use mock HTTP servers for deterministic control

- [ ] **Step 2: Run full test suite**

Run: `cd /path/to/torque && npx vitest run`
Expected: all existing tests pass, all new tests pass.

- [ ] **Step 3: Live verification via TORQUE**

Restart TORQUE with "Free Agentic" template activated:
```bash
sqlite3 "/path/to/torque-data/tasks.db" "INSERT OR REPLACE INTO config (key, value) VALUES ('active_routing_template', 'preset-free-agentic');"
```

Submit a task via MCP without specifying a provider:
```
submit_task({ task: "Use list_directory to list tests/", working_directory: "/path/to/project" })
```

Verify: task is routed to cerebras (first in default chain), uses the agentic pipeline, completes with real results.

- [ ] **Step 4: Final commit**

```bash
cd /path/to/torque
git add server/tests/agentic-routing.test.js
git commit -m "test(routing): integration tests for full agentic fallback chain pipeline"
```

---

## Plan Review Fixes

Issues identified by plan reviewer. All addressed below — implementers MUST read these before starting.

### C1: Health filtering placement — avoid circular dependency

`resolveProvider` in `template-store.js` must NOT call `isProviderHealthy` from `provider-routing-core.js` (circular require). Health filtering happens in `analyzeTaskForRouting` (Task 6), not in `resolveProvider` (Task 3).

**Task 3 fix:** `resolveProvider` returns the first entry in the chain WITHOUT health filtering. It simply normalizes and returns. Health-aware selection is the caller's job.

**Task 6 fix:** `analyzeTaskForRouting` iterates `resolved.chain` and skips unhealthy providers using `isProviderHealthy` (already imported in that file).

### C2: model/chain data flow through task-manager.js

Task 6 Step 2 is intentionally vague. Here is the concrete implementation:

In `task-manager.js:resolveProviderRouting()`, after calling `analyzeTaskForRouting`:
```js
const routing = analyzeTaskForRouting(...);
// Propagate model and chain to the task object
if (routing.model) task.model = task.model || routing.model;
if (routing.chain) {
  let meta = parseTaskMetadata(task.metadata);
  meta._routing_chain = routing.chain;
  task.metadata = JSON.stringify(meta);
}
```

In `execution.js:executeOllamaTaskWithAgentic` and `executeApiProviderWithAgentic`, read the chain:
```js
const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}') : (task.metadata || {});
const chain = meta._routing_chain || null;
```

### I1: Worker logger isolation

The worker uses this pattern to intercept `require('../logger')`:
```js
// At top of agentic-worker.js, BEFORE requiring ollama-agentic:
const { parentPort } = require('worker_threads');
const loggerProxy = {
  info: (msg) => parentPort.postMessage({ type: 'log', level: 'info', message: msg }),
  warn: (msg) => parentPort.postMessage({ type: 'log', level: 'warn', message: msg }),
  child: () => loggerProxy, // ollama-agentic.js calls logger.child()
};
// Override the logger module in require cache
require.cache[require.resolve('../logger')] = {
  id: require.resolve('../logger'),
  filename: require.resolve('../logger'),
  loaded: true,
  exports: loggerProxy,
};
// NOW require the modules that use logger
const { runAgenticLoop } = require('./ollama-agentic');
```

This is the same mock injection pattern used in TORQUE's existing test files (e.g., `adapter-registry.test.js:3-5`).

### I5: Git snapshot ownership in worker refactoring

Task 2 must move `captureSnapshot` and `checkAndRevert` OUT of `runAgenticPipeline` into the main-thread wrapper code. The pipeline function called from the worker should NOT do git operations.

Concretely: in Task 2, when replacing `runAgenticPipeline` with `spawnAgenticWorker`:
1. Call `captureSnapshot(workingDir)` BEFORE spawning the worker (main thread)
2. After the worker completes, call `checkAndRevert(workingDir, snapshot, ...)` (main thread)
3. For `executeWithFallback` (Task 5), the snapshot is captured once before the loop, and `checkAndRevert` runs between each fallback attempt

### I2: Worker _testMode specification

The `_testMode` seam works as follows:
```js
// In agentic-worker.js:
if (workerData._testMode) {
  const { mockBehavior } = workerData;
  if (mockBehavior === 'success') {
    parentPort.postMessage({ type: 'progress', iteration: 1, maxIterations: 1, lastTool: 'mock' });
    parentPort.postMessage({ type: 'result', output: 'mock output', toolLog: [], changedFiles: [], iterations: 1, tokenUsage: {} });
  } else if (mockBehavior === 'error') {
    parentPort.postMessage({ type: 'error', message: 'mock error' });
  } else if (mockBehavior === 'abort') {
    // Wait for abort message, then exit
    parentPort.on('message', (msg) => {
      if (msg.type === 'abort') parentPort.postMessage({ type: 'error', message: 'aborted' });
    });
  }
  return; // Skip real agentic loop
}
```

### File path corrections

- Task 6 Step 3: `server/tests/provider-routing.test.js` → `server/tests/provider-routing-core.test.js`
- Task 5 Step 3: add `const { recordProviderOutcome } = require('../db/provider-routing-core');` import to `execution.js`

### Parallelization note

Tasks 3-4 (template store + preset template) are independent of Tasks 1-2 (worker thread). They can be implemented in parallel for faster delivery. Task 5 (fallback retry) depends on both Phase 1 and Task 3. Tasks 6-7 depend on everything.
