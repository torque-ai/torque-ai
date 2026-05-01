# Universal Agentic Tool Calling Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give all API-based LLM providers (ollama, groq, cerebras, google-ai, openrouter, deepinfra, hyperbolic) the ability to read files, edit code, run commands, and verify work through tool calling — turning text-only providers into autonomous coding agents.

**Architecture:** A provider-agnostic agentic execution layer inserted into `execution.js` that intercepts tasks for capable providers. Three API adapters (Ollama, OpenAI-compatible, Google) feed a single tool-calling loop. Six sandboxed tools (read_file, write_file, edit_file, list_directory, search_files, run_command) with enforced path jail and configurable command sandbox. Post-completion git safety net reverts unauthorized changes.

**Tech Stack:** Node.js (CommonJS), better-sqlite3, Vitest, Ollama /api/chat, OpenAI /v1/chat/completions, Google Gemini generateContent

**Spec:** `docs/superpowers/specs/2026-03-17-universal-agentic-tool-calling-design.md`

**Security note:** The `run_command` tool is intentionally shell-capable. TORQUE tasks need to execute build/test/diagnostic commands (dotnet build, npm test, etc.). This is the same trust model as Claude Code's Bash tool — the LLM is the agent, and shell access is the point. The `allowlist` command mode provides opt-in restriction when needed.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/providers/ollama-tools.js` | Exists — rewrite: 6 tool definitions, sandboxed executor with enforced path jail, pure-JS search, platform detection, replace_all support |
| `server/providers/adapters/ollama-chat.js` | New — Ollama /api/chat NDJSON streaming adapter with tool call parsing (structured + XML + raw JSON) |
| `server/providers/adapters/openai-chat.js` | New — OpenAI-compatible /v1/chat/completions SSE streaming adapter (groq, cerebras, deepinfra, openrouter, hyperbolic) |
| `server/providers/adapters/google-chat.js` | New — Google Gemini generateContent adapter with function calling mapping |
| `server/providers/agentic-capability.js` | New — 3-layer capability detection: config override > probe cache > whitelist |
| `server/providers/agentic-git-safety.js` | New — Pre/post git snapshot, authorization check, selective revert |
| `server/providers/ollama-agentic.js` | Exists — rewrite: provider-agnostic loop with adapter interface, context management, stuck detection, structured logging |
| `server/providers/execution.js` | Exists — expand wrapper: capability detection, adapter selection, git safety, workflow termination, cloud provider intercept |
| `server/providers/execute-ollama.js` | Modify — remove POC agentic branch and import |
| `server/db/schema-migrations.js` | Modify — add `agentic_model_probes` table + `task_metadata` column on `tasks` |
| `server/db/config-keys.js` | Modify — add agentic config keys to VALID_CONFIG_KEYS |
| `server/db/schema-seeds.js` | Modify — seed default agentic config values, alias `ollama_agentic_enabled` to `agentic_enabled` |
| `server/tests/agentic-tools.test.js` | New — tool executor unit tests |
| `server/tests/agentic-capability.test.js` | New — capability detection unit tests |
| `server/tests/agentic-adapters.test.js` | New — adapter unit tests (mocked HTTP) |
| `server/tests/agentic-loop.test.js` | New — agentic loop unit tests |
| `server/tests/agentic-git-safety.test.js` | New — git safety net unit tests |
| `server/tests/agentic-integration.test.js` | New — end-to-end integration tests (live Ollama + cloud provider + workflow termination) |

---

### Task 1: Tool Executor — Hardened Rewrite

Rewrite `ollama-tools.js` from POC to production: enforced path jail, pure-JS file search, platform-aware commands, replace_all edit support, structured return values.

**Files:**
- Rewrite: `server/providers/ollama-tools.js`
- Create: `server/tests/agentic-tools.test.js`

- [ ] **Step 1: Write failing tests for path jail enforcement**

Create `server/tests/agentic-tools.test.js` with tests for:
- `write_file` rejects paths outside working directory (hard error, not warning)
- `write_file` allows paths inside working directory
- `edit_file` rejects paths outside working directory
- `read_file` allows paths outside working directory (read-only is safe)

Key: import `createToolExecutor` from `../providers/ollama-tools`. Create temp dirs with `fs.mkdtempSync`. Factory call: `createToolExecutor(tmpDir)` returns `{ execute(name, args) }`. Assert `result.error === true` and `result.result` contains `'outside working directory'` for write rejections.

- [ ] **Step 2: Write failing tests for edit_file replace_all**

Append tests:
- `edit_file` without `replace_all` fails when `old_text` matches multiple locations
- `edit_file` with `replace_all: true` replaces all occurrences, returns `metadata.replacements` count

- [ ] **Step 3: Write failing tests for pure-JS search_files**

Append tests:
- `search_files` finds pattern across multiple files in subdirectories
- `search_files` respects glob filter (e.g. `*.cs` excludes `.md` files)
- `search_files` handles regex patterns (`int x = \d`)

Key: search uses `fs.readdirSync` recursive + `RegExp.test`, not grep/findstr.

- [ ] **Step 4: Write failing tests for command sandbox allowlist mode**

Append tests:
- `allowlist` mode blocks non-matching commands (returns error)
- `allowlist` mode allows matching commands (glob pattern match)
- `unrestricted` mode allows any command

Factory call with options: `createToolExecutor(tmpDir, { commandMode: 'allowlist', commandAllowlist: ['echo *'] })`

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd /path/to/torque && npx vitest run server/tests/agentic-tools.test.js`
Expected: FAIL — `createToolExecutor` does not exist yet.

- [ ] **Step 6: Rewrite ollama-tools.js with all hardening**

Rewrite `server/providers/ollama-tools.js`:
1. Export `createToolExecutor(workingDir, options)` factory returning `{ execute(name, args) -> { result, error, metadata }, changedFiles: Set }`
2. `resolveSafePath` returns `{ resolvedPath, allowed }` — `allowed` false when outside workingDir
3. Write tools hard-refuse with `{ result: 'Error: path outside working directory', error: true }`
4. `edit_file` accepts optional `replace_all` — uses `String.prototype.replaceAll` when true
5. `search_files` uses pure Node.js: recursive `fs.readdirSync({ withFileTypes: true })` + `fs.readFileSync` + `new RegExp(pattern).test(line)`. Glob filter: simple extension check (`path.extname(file) matches glob`). Returns `filePath:lineNo: lineContent` format, capped at 100 matches.
6. `run_command` checks `options.commandMode`: `'allowlist'` validates against `options.commandAllowlist` patterns. Uses `shell: true` in `execSync` (Node.js picks platform-appropriate shell automatically). Do NOT hardcode `cmd.exe` — preserve Node.js default behavior.
7. `IS_WINDOWS = process.platform === 'win32'` cached at module load
8. `TOOL_DEFINITIONS` adds `replace_all` optional boolean to `edit_file`
9. `parseToolCalls` stays here (already exported from ollama-tools.js in the POC — it's tool-layer parsing, not loop logic). Verify `ollama-agentic.js` imports it from here, not duplicates it.
10. All tools return `{ result, error, metadata }` — metadata varies per tool

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd /path/to/torque && npx vitest run server/tests/agentic-tools.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
cd /path/to/torque
git add server/providers/ollama-tools.js server/tests/agentic-tools.test.js
git commit -m "feat(agentic): rewrite tool executor — enforced path jail, pure-JS search, replace_all, command sandbox"
```

---

### Task 2: Ollama Chat Adapter

Extract Ollama `/api/chat` HTTP logic from POC into standalone adapter.

**Files:**
- Create: `server/providers/adapters/ollama-chat.js`
- Create: `server/tests/agentic-adapters.test.js`

- [ ] **Step 1: Create adapters directory**

```bash
mkdir -p /path/to/torque/server/providers/adapters
```

- [ ] **Step 2: Write failing tests for Ollama adapter**

Create `server/tests/agentic-adapters.test.js` with a mock HTTP server that responds with NDJSON:
- Test: sends chat request, parses NDJSON response with tool calls
- Test: normalizes Ollama `prompt_eval_count`/`eval_count` to `prompt_tokens`/`completion_tokens`

Mock server: on POST, write two NDJSON lines — one with `done: false` (streaming content), one with `done: true` (final with eval counts).

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /path/to/torque && npx vitest run server/tests/agentic-adapters.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement ollama-chat.js adapter**

Create `server/providers/adapters/ollama-chat.js`:
1. Extract `chatRequest` from POC `ollama-agentic.js`
2. Rename export to `chatCompletion` matching shared interface
3. Add token normalization: `prompt_eval_count` -> `prompt_tokens`, `eval_count` -> `completion_tokens`
4. Include `think: false` in request body
5. AbortSignal support via `signal` parameter on http.request
6. Export: `{ chatCompletion }`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /path/to/torque && npx vitest run server/tests/agentic-adapters.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /path/to/torque
git add server/providers/adapters/ollama-chat.js server/tests/agentic-adapters.test.js
git commit -m "feat(agentic): Ollama chat adapter with NDJSON streaming and token normalization"
```

---

### Task 3: OpenAI-Compatible Chat Adapter

Adapter for groq, cerebras, deepinfra, openrouter, hyperbolic.

**Files:**
- Create: `server/providers/adapters/openai-chat.js`
- Modify: `server/tests/agentic-adapters.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/tests/agentic-adapters.test.js`:
- Test: sends request with Bearer auth, parses SSE `data:` lines with `tool_calls`
- Test: handles incremental tool_call assembly (OpenAI streams tool calls by `index`)
- Test: rejects when no API key provided

Mock server: check `Authorization: Bearer` header, respond with SSE events ending in `data: [DONE]`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /path/to/torque && npx vitest run server/tests/agentic-adapters.test.js`

- [ ] **Step 3: Implement openai-chat.js adapter**

Create `server/providers/adapters/openai-chat.js`:
1. POST to `{host}/v1/chat/completions` with `Authorization: Bearer {apiKey}`
2. Parse SSE: split on `\n\n`, each chunk starts with `data: `
3. Handle `data: [DONE]` termination
4. Accumulate `delta.content` and `delta.tool_calls` (assemble by `index` field)
5. Return normalized `{ message, usage }` from final chunk
6. Export: `{ chatCompletion }`

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
cd /path/to/torque
git add server/providers/adapters/openai-chat.js server/tests/agentic-adapters.test.js
git commit -m "feat(agentic): OpenAI-compatible chat adapter with SSE streaming"
```

---

### Task 4: Google AI Chat Adapter

Adapter for Gemini function calling.

**Files:**
- Create: `server/providers/adapters/google-chat.js`
- Modify: `server/tests/agentic-adapters.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/tests/agentic-adapters.test.js`:
- Test: maps Gemini `functionCall` response to standard `tool_calls` format
- Test: normalizes `usageMetadata.promptTokenCount`/`candidatesTokenCount` to standard fields

Mock server: check `key=` query param, respond with Gemini JSON structure.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement google-chat.js adapter**

Create `server/providers/adapters/google-chat.js`:
1. Convert messages to Gemini `contents` format
2. Convert TORQUE tool definitions to `functionDeclarations`
3. POST to `{host}/v1beta/models/{model}:generateContent?key={apiKey}`
4. Map `candidates[0].content.parts[].functionCall` to `tool_calls`
5. Normalize token usage
6. Export: `{ chatCompletion }`

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
cd /path/to/torque
git add server/providers/adapters/google-chat.js server/tests/agentic-adapters.test.js
git commit -m "feat(agentic): Google AI Gemini adapter with function calling"
```

---

### Task 5: Capability Detection

3-layer detection: config override > probe cache > whitelist.

**Files:**
- Create: `server/providers/agentic-capability.js`
- Create: `server/tests/agentic-capability.test.js`
- Modify: `server/db/config-keys.js`
- Modify: `server/db/schema-migrations.js`

- [ ] **Step 1: Add config keys to VALID_CONFIG_KEYS**

In `server/db/config-keys.js`, add to `VALID_CONFIG_KEYS` set (alphabetically): `agentic_command_allowlist`, `agentic_command_mode`, `agentic_enabled`, `agentic_git_safety`, `agentic_max_iterations`, `agentic_provider_cerebras`, `agentic_provider_deepinfra`, `agentic_provider_google_ai`, `agentic_provider_groq`, `agentic_provider_hashline_ollama`, `agentic_provider_hyperbolic`, `agentic_provider_ollama`, `agentic_provider_ollama_cloud`, `agentic_provider_openrouter`, `agentic_whitelist`, `ollama_agentic_enabled` (backward compat alias).

- [ ] **Step 2: Add DB migrations**

Append to `server/db/schema-migrations.js` `runMigrations`:

```js
// Agentic tool-calling: model probe cache
db.exec(`
  CREATE TABLE IF NOT EXISTS agentic_model_probes (
    model_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    supports_tools INTEGER NOT NULL DEFAULT 0,
    probe_error TEXT,
    probed_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (model_name, provider)
  )
`);

// Agentic tool-calling: structured task metadata (tool log, token usage)
safeAddColumn('tasks', 'task_metadata TEXT');
```

Also add `'ollama_agentic_enabled'` to `VALID_CONFIG_KEYS` in `config-keys.js` for backward compatibility (alias to `agentic_enabled`).

- [ ] **Step 3: Write failing tests**

Create `server/tests/agentic-capability.test.js`:
- global `agentic_enabled=0` -> false
- excluded providers (hashline-ollama, codex, claude-cli, aider-ollama) -> false
- whitelisted ollama model (qwen2.5-coder) -> true
- cloud providers (groq) -> true (assumed capable)
- per-provider config override takes priority
- unknown model not on whitelist -> false
- custom whitelist extends built-in

Mock `serverConfig.get` and database prepare/get.

- [ ] **Step 4: Run tests to verify they fail**

- [ ] **Step 5: Implement agentic-capability.js**

Create `server/providers/agentic-capability.js` (~100 lines):
- `EXCLUDED_PROVIDERS` set: hashline-ollama, aider-ollama, codex, claude-cli
- `CLOUD_TOOL_CAPABLE` set: groq, cerebras, deepinfra, openrouter, hyperbolic, google-ai
- `WHITELIST_PREFIXES`: qwen2.5-coder, codestral, llama3.1, llama3.2, llama-3.1, llama-3.2, llama3.3, llama-3.3, mistral, command-r, gemma2
- `isAgenticCapable(provider, model)` checks layers in order, returns `{ capable, reason, source }`
- `init({ db, serverConfig })` for dependency injection
- Export: `{ init, isAgenticCapable }`

- [ ] **Step 6: Run tests to verify they pass**

- [ ] **Step 7: Commit**

```bash
cd /path/to/torque
git add server/providers/agentic-capability.js server/tests/agentic-capability.test.js server/db/config-keys.js server/db/schema-migrations.js
git commit -m "feat(agentic): 3-layer capability detection (config > probe > whitelist)"
```

---

### Task 6: Git Safety Net

Snapshot git state before task, revert unauthorized changes after.

**Files:**
- Create: `server/providers/agentic-git-safety.js`
- Create: `server/tests/agentic-git-safety.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/agentic-git-safety.test.js` with a real temp git repo:
- No changes -> empty reverted list
- Authorized change (file in task description) -> kept
- Unauthorized change (file not in task) -> reverted
- Unauthorized new file -> deleted
- New file matching gitignore -> kept
- Pre-existing dirty state -> preserved (not reverted)

Use `execFileSync('git', ['init'])` etc. to set up temp repos in `beforeEach`.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement agentic-git-safety.js**

Create `server/providers/agentic-git-safety.js` (~80 lines):
- `captureSnapshot(workingDir)` -> `{ dirtyFiles: Set, untrackedFiles: Set }`
- `checkAndRevert(workingDir, snapshot, taskDescription, mode)` -> `{ reverted: [], kept: [], report: string }`
- `isAuthorized(filePath, taskDescription)` — checks basename, parent dir, path components against task text
- `isGitIgnored(filePath, workingDir)` — `execFileSync('git', ['check-ignore', '-q', filePath])`
- All git calls use `execFileSync('git', [...])` — no shell injection
- Export: `{ captureSnapshot, checkAndRevert }`

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
cd /path/to/torque
git add server/providers/agentic-git-safety.js server/tests/agentic-git-safety.test.js
git commit -m "feat(agentic): git safety net with snapshot/revert/authorize"
```

---

### Task 7: Agentic Loop Refactor

Refactor POC loop to provider-agnostic with context management, stuck detection, structured logging.

**Files:**
- Rewrite: `server/providers/ollama-agentic.js`
- Create: `server/tests/agentic-loop.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/agentic-loop.test.js` with mock adapter and executor:
- Completes when model returns no tool calls (1 iteration)
- Executes tool calls and continues loop (2 iterations, 1 tool call logged)
- Stops on stuck loop (identical consecutive tool calls)
- Stops on consecutive errors from same tool
- Tracks token usage across iterations (accumulated prompt_tokens + completion_tokens)
- Truncates oldest tool results when context budget exceeded (80% of contextBudget), preserves system prompt and last 2 iterations

Mock adapter: `{ chatCompletion: async () => responseArray[callNum++] }`.
Mock executor: `{ execute: (name, args) => { result: 'ok', metadata: {} } }`.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Rewrite ollama-agentic.js**

Rewrite `server/providers/ollama-agentic.js`:
1. Remove `chatRequest` (moved to ollama-chat adapter), remove `http`/`https` imports
2. `runAgenticLoop` takes `adapter` object (with `chatCompletion` method) instead of `host`/`model`
3. Pass `options.host` and `options.model` through to `adapter.chatCompletion` (adapter resolves them)
4. Context budget: track `cumulativeChars`, when `cumulativeChars / 4 > contextBudget` truncate oldest tool results in messages array
5. Stuck detection: `JSON.stringify({ name, args })` hash comparison, stop on 2 consecutive identical
6. Error detection: track `lastErrorTool`, stop on 2 consecutive errors from same tool name
7. Token accumulator: `{ prompt_tokens: 0, completion_tokens: 0 }` summed per iteration
8. Tool log entries: `{ iteration, name, arguments_preview (500 char), result_preview (500 char), error, duration_ms }`
9. For `write_file` arguments, store `{ path, content_hash: crypto.createHash('sha256').update(content).digest('hex').slice(0,12), content_bytes }` instead of full content
10. Parse failure: if content contains `"name"` but no tool calls parsed, inject correction message, one retry
11. Export: `{ runAgenticLoop, MAX_ITERATIONS }`

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
cd /path/to/torque
git add server/providers/ollama-agentic.js server/tests/agentic-loop.test.js
git commit -m "feat(agentic): adapter-agnostic loop with context management and stuck detection"
```

---

### Task 8: Execution Wrapper Integration

Wire everything into `execution.js`.

**Files:**
- Modify: `server/providers/execution.js`
- Modify: `server/db/schema-seeds.js`

- [ ] **Step 1: Seed default config values**

In `server/db/schema-seeds.js`, add using `setConfigDefault`:
- `agentic_enabled` = `'1'`
- `agentic_max_iterations` = `'10'`
- `agentic_command_mode` = `'unrestricted'`
- `agentic_git_safety` = `'on'`

- [ ] **Step 2: Update execution.js imports**

Add imports for all agentic modules: `agentic-capability`, `ollama-tools`, `agentic-git-safety`, `ollama-agentic`, and all three adapters.

- [ ] **Step 3: Capture handleWorkflowTermination in init deps**

Add `handleWorkflowTermination: deps.handleWorkflowTermination` to `_agenticDeps`.

- [ ] **Step 4: Add adapter selection function**

```js
function selectAdapter(provider) {
  if (provider === 'ollama') return ollamaChatAdapter;
  if (provider === 'google-ai') return googleChatAdapter;
  if (['groq','cerebras','deepinfra','openrouter','hyperbolic','ollama-cloud'].includes(provider))
    return openaiChatAdapter;
  return null;
}
```

- [ ] **Step 5: Rewrite executeOllamaTaskWithAgentic**

Full production wrapper:
1. `isAgenticCapable(provider, model)` — delegate to legacy if not capable
2. `selectAdapter(provider)`
3. `createToolExecutor(workingDir, { commandMode, commandAllowlist })` from config
4. `captureSnapshot(workingDir)` in try/catch (non-git repos)
5. `runAgenticLoop(...)` with adapter, tools, executor
6. `checkAndRevert(workingDir, snapshot, taskDescription, gitSafetyMode)` — append report to output
7. Store `toolLog` + `tokenUsage` in task metadata JSON
8. `handleWorkflowTermination(taskId)` on success and failure
9. Platform-dynamic system prompt (rule 8)
10. `finally` block: clear timers, decrement host slot, notify dashboard, processQueue

- [ ] **Step 6: Remove POC agentic code from execute-ollama.js**

Check for and remove any `require('./ollama-agentic')` or inline agentic branches in `execute-ollama.js`.

- [ ] **Step 7: Add cloud provider agentic intercept**

In `execution.js`, add a wrapper for `executeApiProvider` (similar pattern to `executeOllamaTaskWithAgentic`):

1. Check `isAgenticCapable(task.provider, task.model)` — if not capable, delegate to `_executeApiModule.executeApiProvider`
2. Resolve API key and host from existing provider config (e.g., `GroqProvider.apiKey`, `GroqProvider.baseUrl`)
3. Select `openaiChatAdapter` or `googleChatAdapter` based on provider
4. Run `runAgenticLoop` with the selected adapter, passing `host`, `apiKey`, `model` in options
5. Same git safety, workflow termination, and metadata storage as Ollama path
6. Update `module.exports.executeApiProvider` to use this wrapper

This ensures groq, cerebras, deepinfra, openrouter, hyperbolic, and google-ai all get tool calling when they have API keys configured.

- [ ] **Step 8: Handle config backward compatibility**

In the `executeOllamaTaskWithAgentic` wrapper, check both `agentic_enabled` and the legacy `ollama_agentic_enabled` key:

```js
const agenticEnabled = serverConfig.get('agentic_enabled') !== '0'
  && serverConfig.get('ollama_agentic_enabled') !== '0';
```

This prevents breaking existing users who set `ollama_agentic_enabled=0`.

- [ ] **Step 9: Commit**

```bash
cd /path/to/torque
git add server/providers/execution.js server/db/schema-seeds.js server/providers/execute-ollama.js
git commit -m "feat(agentic): wire production pipeline with cloud provider routing into execution.js"
```

---

### Task 9: Integration Tests

End-to-end test with live Ollama.

**Files:**
- Create: `server/tests/agentic-integration.test.js`

- [ ] **Step 1: Write integration test**

Create `server/tests/agentic-integration.test.js`:
- Check Ollama availability at `OLLAMA_HOST` or `http://localhost:11434` — skip if unreachable
- Create temp directory with a test file
- Run `runAgenticLoop` with real ollama-chat adapter, real tool executor, real tools
- Assert: `toolLog` has entries, at least one tool from `[list_directory, read_file]` was called
- 2-minute timeout for cold model loads

- [ ] **Step 2: Write OpenAI-compatible cloud provider integration test**

Append to `server/tests/agentic-integration.test.js`:
- Start a mock OpenAI-compatible server that responds to tool calls
- Run `runAgenticLoop` with `openaiChatAdapter` pointing at the mock server
- Verify tool calls execute and the loop completes
- This tests the full cloud provider path without needing real API keys

- [ ] **Step 3: Write workflow termination integration test**

Append to `server/tests/agentic-integration.test.js`:
- Mock `handleWorkflowTermination` as a jest spy
- Run an agentic task through `executeOllamaTaskWithAgentic` (or the full wrapper)
- Assert `handleWorkflowTermination` was called with the correct task ID on success
- Assert it's also called on failure (submit a task that will error)

- [ ] **Step 4: Run integration tests**

Run: `cd /path/to/torque && OLLAMA_HOST=http://192.0.2.100:11434 npx vitest run server/tests/agentic-integration.test.js`
Note: OLLAMA_HOST env var syntax is Git Bash compatible. For PowerShell use `$env:OLLAMA_HOST="..." ; npx vitest run ...`

- [ ] **Step 5: Commit**

```bash
cd /path/to/torque
git add server/tests/agentic-integration.test.js
git commit -m "test(agentic): integration test with live Ollama"
```

---

### Task 10: Final Verification and Cleanup

**Files:** Various

- [ ] **Step 1: Run full test suite**

Run: `cd /path/to/torque && npx vitest run`
Expected: All existing + new tests pass.

- [ ] **Step 2: Verify end-to-end via TORQUE MCP**

Submit read-only task through MCP, verify real directory listing (not hallucinated).

- [ ] **Step 3: Verify git safety net end-to-end**

Submit task that creates unauthorized file, verify it gets reverted.

- [ ] **Step 4: Verify legacy fallback**

Set `agentic_enabled=0` in DB, submit task, verify legacy `/api/generate` runs. Re-enable after.

- [ ] **Step 5: Final commit**

```bash
cd /path/to/torque
git add server/providers/adapters/ server/providers/ollama-tools.js server/providers/ollama-agentic.js server/providers/agentic-capability.js server/providers/agentic-git-safety.js server/providers/execution.js server/providers/execute-ollama.js server/db/schema-migrations.js server/db/config-keys.js server/db/schema-seeds.js server/tests/agentic-*.test.js docs/superpowers/specs/2026-03-17-universal-agentic-tool-calling-design.md
git commit -m "feat(agentic): universal agentic tool calling for all API-based providers"
```
