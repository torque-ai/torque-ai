# Universal Agentic Tool Calling for TORQUE

**Date:** 2026-03-17
**Status:** Approved
**Scope:** Add tool-calling agentic execution to all API-based providers (ollama, groq, cerebras, google-ai, openrouter, deepinfra, hyperbolic)

## Problem

TORQUE's `ollama` provider uses `/api/generate` — raw text completion with no tool access. The model receives a task description and can only output text. It cannot read files, make edits, run commands, or verify its work. This makes it useless for actual code tasks — it either hallucinates file contents or describes what it would do without doing it.

The same problem affects all free cloud providers (groq, cerebras, google-ai, openrouter) which go through `execute-api.js` — they generate text but can't act on the codebase.

Meanwhile, codex and claude-cli have full tool access through their native CLIs, and hashline-ollama has a custom file-editing protocol. But there's no universal tool-calling layer for API-based providers.

## Solution

A provider-agnostic agentic execution layer that gives any tool-capable LLM access to file I/O, search, and shell commands through the standard function-calling protocol. The layer sits between the task dispatcher and provider APIs, intercepting tasks for capable providers and running them through a tool-calling loop instead of raw text generation.

## Architecture

    Task Dispatcher (task-manager.js)
      -> execution.js (existing aggregator)
        -> Capability Detection (config -> probe cache -> whitelist)
          -> Agentic Loop (provider-agnostic tool-calling loop)
            -> API Adapter (ollama / openai-compat / google)
              -> Tool Executor (sandboxed file I/O + commands)
                -> Git Safety Net (post-completion revert of unauthorized changes)

Non-agentic providers (codex, claude-cli, aider-ollama, hashline-ollama) bypass all of this. Their paths through `execute-cli.js` and `execute-hashline.js` are unchanged. hashline-ollama is explicitly excluded — it already has a superior file-editing protocol with error feedback loops.

## Component 1: Capability Detection

Three-layer resolution, checked in priority order:

### Layer 1 — Config override (DB)

- `agentic_enabled` — global kill switch (default: `'1'`)
- `agentic_provider_{name}` — per-provider override (`'1'`, `'0'`, or absent)
- Checked via `serverConfig.get()`, same as existing tuning config

### Layer 2 — Probe cache (DB table)

- Table: `agentic_model_probes` with columns `model_name`, `provider`, `supports_tools` (boolean), `probed_at`, `probe_error`
- Probe request: system prompt `"You are a test assistant."`, user message `"List files in the current directory."`, one tool `list_directory`
- Pass criteria: response contains `tool_calls` field, or parseable tool call JSON/XML in content
- Fail criteria: response is pure text with no tool invocation attempt
- Network/timeout errors: not cached (retry next time). Stored in `probe_error` for diagnostics
- Cache with 30-day TTL, re-probe on model version change
- Probe timeout: 30 seconds. On cold model load, this may miss — falls through to whitelist
- Probe is non-blocking: if not cached, fall through to whitelist for this task, queue probe in background

### Layer 3 — Whitelist (hardcoded + configurable)

- Built-in list: `qwen2.5-coder`, `codestral`, `llama3.1`, `llama3.2`, `mistral`, `command-r`, `gemma2`
- All OpenAI-compatible cloud providers assumed tool-capable (groq, cerebras, deepinfra, openrouter, hyperbolic)
- Configurable additions via `agentic_whitelist` config key (comma-separated model prefixes)

### Excluded providers

- `hashline-ollama` — always returns `{ capable: false, reason: 'hashline protocol preferred' }` regardless of model capability. Its specialized file-editing protocol with error feedback loops is more reliable for edit-heavy tasks.
- `aider-ollama`, `codex`, `claude-cli` — use their own CLI execution paths, not intercepted.

### Resolution function

    function isAgenticCapable(provider, model)
      -> { capable: boolean, reason: string, source: 'config'|'probe'|'whitelist'|'default' }

Falls back to `false` (legacy mode) if no signal at any layer.

## Component 2: API Adapters

Three adapters sharing one interface:

    async function chatCompletion({ host, apiKey, model, messages, tools, options, timeoutMs, onChunk, signal })
      -> { message: { role, content, tool_calls }, usage: { prompt_tokens, completion_tokens } }

### Ollama adapter (`adapters/ollama-chat.js`, ~140 lines)

- POST `/api/chat` with NDJSON streaming
- Handles three tool call formats: structured `tool_calls` field, `<tool_call>` XML tags, raw JSON in content
- Extracted from existing POC `ollama-agentic.js` chatRequest function
- Returns normalized `tool_calls` array regardless of how the model emitted them
- Token normalization: Ollama returns `prompt_eval_count` and `eval_count` — mapped to `prompt_tokens` and `completion_tokens`

### OpenAI-compatible adapter (`adapters/openai-chat.js`, ~120 lines)

- POST `/v1/chat/completions` with SSE streaming
- Covers: groq, cerebras, deepinfra, openrouter, hyperbolic
- Host URL and API key resolved from existing provider configs
- Standard `tool_calls` field — no parsing hacks needed
- Handles SSE `data: [DONE]` termination
- Token usage directly from `usage` field in response

### Google AI adapter (`adapters/google-chat.js`, ~100 lines)

- POST `generateContent` endpoint
- Maps TORQUE tool definitions to Gemini `functionDeclarations` format
- Maps Gemini `functionCall` responses back to standard `tool_calls`
- Only activated when google-ai provider has an API key configured
- Token normalization: Gemini `usageMetadata.promptTokenCount` / `candidatesTokenCount` mapped to standard fields

### Adapter selection

    ollama             -> ollama-chat
    groq, cerebras, deepinfra, openrouter, hyperbolic  -> openai-chat
    google-ai          -> google-chat
    hashline-ollama    -> excluded (uses execute-hashline.js)

All adapters normalize token usage into `{ prompt_tokens, completion_tokens }`.

## Component 3: Tool Executor (Sandboxed)

Six tools available to the model:

| Tool | Description | Write? |
|------|-------------|--------|
| `read_file` | Read file contents with line numbers | No |
| `write_file` | Create or overwrite a file | Yes |
| `edit_file` | Search-and-replace in a file (single or all matches) | Yes |
| `list_directory` | List files/dirs with annotations | No |
| `search_files` | Pattern search across files | No |
| `run_command` | Execute shell command | Configurable |

### Path jail (enforced, not advisory)

- `write_file`, `edit_file`: reject any resolved path outside the working directory. Returns error to model, does not proceed.
- `read_file`, `list_directory`, `search_files`: allowed outside working directory (read-only is safe).
- Implementation: `resolveSafePath` returns `{ path, allowed: boolean }`. Write tools check `allowed` and return hard error if false. POC warning-only behavior is replaced.

### Command sandbox

`run_command` has two modes via `agentic_command_mode` config:

- `'unrestricted'` (default) — any command, same trust model as Claude Code's Bash tool
- `'allowlist'` — only commands matching patterns in `agentic_command_allowlist` (e.g., `dotnet *`, `git status`, `dir *`). Positive match only — this is the only mode that provides real safety.

Note: The previously considered `'readonly'` mode (keyword blocking) was removed — it provides a false sense of security since keyword filters are trivially bypassed via aliased commands, scripting languages, or PowerShell cmdlets.

All commands: working directory as cwd, 30s timeout, 128KB output cap.

### Platform awareness

- Detect `process.platform` at startup, cache as `IS_WINDOWS`
- On Windows: `run_command` uses `cmd.exe /c` as shell
- `search_files`: pure Node.js implementation using recursive `fs.readdirSync` + `RegExp.test` (~40 lines). Not `grep` or `findstr` — both have different regex semantics from each other and from what models expect. The pure-JS implementation is portable and predictable across platforms.
- Path normalization: both `/` and `\` accepted as input. `path.resolve` normalizes before filesystem operations.

### Tool result quality

- `read_file`: line-numbered content
- `edit_file` on failure: first 30 lines of file plus diff-friendly error showing what was expected vs what exists
- `edit_file` supports optional `replace_all` boolean parameter (default false) — allows renaming variables or updating imports across a file without falling back to `write_file` full rewrites
- `list_directory`: annotates dirs with `/`, files over 1KB with size
- All tools return `{ result, error, metadata }` — metadata includes bytes read/written, lines changed, exit code

## Component 4: Agentic Loop (Provider-Agnostic)

### Loop flow

    1. Build messages: [system prompt, user task]
    2. Call adapter.chatCompletion(messages, tools)
    3. Parse response -> tool_calls?
       - Yes: execute tools, append results, go to 2
       - No: final response, exit loop
    4. Constraints: max 10 iterations, 512KB total output, task timeout

### Function signature

    async function runAgenticLoop({
      adapter,        // { chatCompletion }
      systemPrompt,
      taskPrompt,
      tools,          // tool definitions
      toolExecutor,   // { execute(name, args) -> result }
      options,        // model params (temperature, num_ctx, etc.)
      workingDir,
      timeoutMs,
      maxIterations,
      contextBudget,  // max estimated tokens before truncation
      onProgress,     // (iteration, max, lastTool) => void
      onToolCall,     // (name, args, result) => void
      signal,
    }) -> { output, toolLog, changedFiles, iterations, tokenUsage }

### Early termination signals

- Model emits no tool calls (done)
- Max iterations reached (10, configurable via `agentic_max_iterations`)
- Total output exceeds 512KB cap
- Task cancelled (abort signal)
- Two consecutive identical tool calls with identical arguments (stuck loop detection)
- Two consecutive errors from the same tool (strong signal the model is stuck — stop and report)

### Context window management

The agentic loop tracks cumulative message size to prevent context overflow:

- Rough token estimate: `messageChars / 4`
- `contextBudget` defaults to `num_ctx * 0.8` (80% of model context, leaving 20% for response)
- When cumulative tokens exceed budget: truncate oldest tool results in the message history, replacing content with `"[result truncated — N bytes, returned OK/ERROR]"`. System prompt and most recent 2 iterations are never truncated.
- Minimum `num_ctx` for agentic mode: 16384. If resolved `num_ctx` is lower, the agentic wrapper auto-increases it (matching existing behavior in execute-ollama.js context pre-check).

### Parse failure recovery

If the model returns content that looks like a malformed tool call (contains `"name"` but won't parse), send a correction message: "Your last response wasn't a valid tool call. Use the exact format." One retry, then treat as final text response.

### Token tracking

Each iteration's `usage` response is accumulated. Total stored in task metadata as `agentic_token_usage: { prompt_tokens, completion_tokens, total }`.

### Structured tool log

Each tool call recorded as `{ iteration, name, arguments_preview, result_preview, error, duration_ms }`. Stored as JSON in `task_metadata.agentic_log`.

- `arguments_preview`: truncated to 500 chars. For `write_file`, stores `{ path, content_hash, content_bytes }` instead of full content.
- `result_preview`: truncated to 500 chars.
- Total log capped at 256KB. Oldest entries dropped if exceeded.

## Component 5: Git Safety Net

### Flow

1. Before agentic loop: capture `git diff --name-only` and `git status --porcelain` to snapshot pre-existing dirty state
2. Agentic loop runs
3. After loop: capture new diff against pre-task snapshot
4. Any newly modified or newly created file not mentioned in the task description gets reverted/deleted
5. "Authorized" means the task description contains: the filename, the parent directory name, or a matching glob
6. Exception: new files matching `.gitignore` patterns are left alone (build artifacts, logs)
7. Report appended to task output: "Reverted N unauthorized changes: [list]"

### Edge cases

- Not a git repo: skip safety net, rely on path jail only
- Broad-scope task ("fix all tests"): set `agentic_git_safety` to `'off'`
- Pre-existing uncommitted changes: tracked in snapshot, never reverted
- New file created by model but not in task description: deleted (unless gitignored). Model can `write_file` anything — the question is whether it *should have*.

### Config

- `agentic_git_safety` — `'on'` (default), `'warn'` (log but don't revert), `'off'`
- Per-task override via `task.metadata.git_safety`

### Implementation

~80 lines. Uses `execFileSync('git', [...])` — no shell, no injection risk. Runs synchronously after loop, before task status is set to completed.

## Component 6: Integration Points

### Entry point — `execution.js`

The existing `executeOllamaTaskWithAgentic` wrapper, expanded to:

1. Call `isAgenticCapable(provider, model)`
2. If capable: select adapter, build sandboxed executor, run agentic loop with git safety
3. If not: fall through to legacy `executeOllamaTask`

Same pattern added for `executeApiProvider` — cloud providers that pass capability detection get the agentic loop with the OpenAI adapter.

The agentic wrapper calls `handleWorkflowTermination(taskId)` on both success and failure, matching the pattern in `executeApiProvider`. This ensures workflow dependency resolution works correctly for agentic tasks.

### Cleanup: remove duplicate agentic code

The inline agentic system prompt in `execute-ollama.js` (if present from POC iterations) must be removed. The system prompt lives exclusively in the agentic loop's wrapper in `execution.js`. One source of truth.

### DB schema additions

- `agentic_model_probes` table for probe cache
- `task_metadata` column on `tasks` populated with `agentic_log` JSON
- Config keys: `agentic_enabled`, `agentic_provider_*`, `agentic_max_iterations`, `agentic_command_mode`, `agentic_command_allowlist`, `agentic_git_safety`, `agentic_whitelist`

### Dashboard

- `onToolCall` callback fires `dashboard.notifyTaskOutput(taskId, toolCallEvent)` for live tool activity
- No dashboard UI changes needed — existing task output stream shows tool calls

### File structure

    providers/
      adapters/
        ollama-chat.js         ~140 lines
        openai-chat.js         ~120 lines
        google-chat.js         ~100 lines
      ollama-tools.js          ~400 lines (exists, hardened: path jail enforced, pure-JS search, replace_all, platform detection)
      ollama-agentic.js        ~350 lines (exists, refactored: adapter-agnostic, context management, stuck detection)
      agentic-capability.js    ~100 lines (new: 3-layer detection + probe logic)
      agentic-git-safety.js    ~80 lines (new: snapshot/revert/authorize)
      execution.js             ~350 lines (exists, wrapper expanded + workflow termination)

Total: ~850 lines net new across 4 new files (3 adapters + capability detection + git safety). ~400 lines refactored across 3 existing files (tools, loop, execution wrapper).

### What doesn't change

- `execute-ollama.js` — untouched, legacy fallback (any POC agentic code removed)
- `execute-hashline.js` — untouched
- `execute-cli.js` — untouched (codex, claude-cli, aider)
- `execute-api.js` — untouched, but cloud providers passing capability detection get routed through the agentic wrapper before reaching it

### Known limitations

- `openrouter` and `cerebras` are not registered in `adapter-registry.js` (v2 API routing). The agentic path uses v1 execution through `execute-api.js`, so this is not a blocker, but documented for awareness.
- The `readonly` command sandbox mode was removed. Only `unrestricted` and `allowlist` remain. If stronger sandboxing is needed, use `allowlist` with explicit patterns.

## System prompt

The agentic system prompt is appended to the provider's base system prompt. It lives in one place: the agentic wrapper in `execution.js`. Platform detection sets rule 8 dynamically.

    You are an autonomous coding agent with tool access. Complete the task using ONLY the provided tools.

    RULES:
    1. Use tools to read files, make edits, list directories, search code, and run commands.
    2. NEVER describe what you would do -- actually do it with tools.
    3. ONLY modify files explicitly mentioned in the task. Do NOT touch unrelated files.
    4. If a build/test fails for reasons UNRELATED to your change, report the failure and stop.
    5. If a tool call fails, try ONE alternative approach. If that also fails, report the error and stop.
    6. When done, respond with a brief summary of what you did and what changed.
    7. Be efficient -- you have limited iterations. Read, edit, verify, done.
    8. [Platform-specific: Windows -> "Use PowerShell or cmd syntax, not Unix." / Linux -> "Use bash commands."]

## Testing strategy

- Unit tests for each adapter (mock HTTP responses with tool_calls)
- Unit tests for tool executor (path jail enforcement hard refusal, command sandbox allowlist, platform-aware search, replace_all)
- Unit tests for capability detection (config > probe > whitelist priority, hashline exclusion)
- Unit tests for git safety net (mock git diff, verify revert logic, new file deletion, gitignore exception)
- Unit tests for context window management (truncation triggers at 80% budget, system prompt preserved)
- Unit tests for stuck loop detection (identical calls, consecutive errors from same tool)
- Integration test: submit task to local Ollama with tools, verify file was actually edited
- Integration test: submit task to OpenAI-compatible endpoint, verify tool loop completes
- Integration test: verify workflow termination fires after agentic task completes
