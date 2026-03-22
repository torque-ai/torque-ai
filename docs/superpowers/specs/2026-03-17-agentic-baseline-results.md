# Agentic Tool Calling — Baseline Results

**Date:** 2026-03-17
**Test:** "Use list_directory to list tests/. Report folder names and count."
**Ground truth:** 13 test project folders + 2 files in `/path/to/project/tests/`
**Methodology:** Standalone agentic loop via `runAgenticLoop()` with `createToolExecutor()` and real provider APIs. Not routed through TORQUE task manager (avoids runtime event loop contention — see Known Issues).

## Results

| Provider | Model | Adapter | Time | Iters | Tool Calls | Count Correct | Names Listed | Grade |
|----------|-------|---------|------|-------|------------|---------------|--------------|-------|
| cerebras | qwen-3-235b-a22b-instruct-2507 | openai-chat | 884ms | 2 | 1 (list_directory) | Yes (13) | Yes | A |
| groq | llama-3.3-70b-versatile | openai-chat | 1274ms | 2 | 1 (list_directory) | No | Yes | A- |
| ollama-cloud | devstral-2:123b | ollama-chat | 3769ms | 2 | 1 (list_directory) | Yes (13) | Yes | A |
| ollama (local) | qwen2.5-coder:32b | ollama-chat | 60366ms | 2 | 1 (list_directory) | Yes (13) | Yes | B |
| openrouter | nemotron-3-nano-30b:free | openai-chat | 4929ms | 2 | 1 (list_directory) | Yes (13) | Yes | A |
| codestral (local) | codestral:22b | ollama-chat | 67ms | 1 | 0 | No | No | Excluded |
| google-ai | gemini-2.0-flash | google-chat | N/A | N/A | N/A | N/A | N/A | Blocked |

## Provider Notes

### cerebras (Grade A)
- Best overall: fastest, most accurate, most efficient
- Single tool call, complete summary with all folder names and count
- qwen-3-235b is a 235B parameter model — impressive tool-calling accuracy

### groq (Grade A-)
- Fast and accurate, listed all folder names
- Didn't always include the exact count "13" but listed all names correctly
- llama-3.3-70b has solid tool calling support

### ollama-cloud (Grade A)
- Tool calls execute correctly, accurate summaries with all folder names and count
- Root cause of earlier empty summaries: Ollama API requires arguments as JSON objects, not strings (opposite of OpenAI). Fixed in ollama-chat adapter.
- devstral-2:123b responds in ~3.8s — good balance of speed and quality
- Also tested qwen3-coder:480b, deepseek-v3.2 — all work after fix

### ollama local (Grade B)
- Accurate results — correct folder names and count
- Very slow (60s) due to 32B model on consumer GPU
- After prompt tuning, properly focused: 2 iterations instead of original 5
- Before fix: went off-task (wrote files, ran commands, 5 iterations)

### openrouter (Grade A)
- `nvidia/nemotron-3-nano-30b-a3b:free` supports tool calling on the free tier
- Earlier failures were transient rate limiting, not fundamental incompatibility
- 4.9s response time, accurate count and all folder names
- Re-added to CLOUD_TOOL_CAPABLE with nemotron as default model

### codestral (Excluded)
- codestral:22b via Ollama does not support tool calling
- Responds with plain text, ignores tool definitions
- Removed from whitelist — falls back to legacy

### google-ai (Blocked)
- Free tier quota exhausted (429 error)
- Adapter tested and working via unit tests
- Needs quota reset or plan upgrade

## Prompt Tuning Impact

System prompt was improved during baseline testing. Key changes:

| Rule | Before | After |
|------|--------|-------|
| Summary quality | "respond with a brief summary" | "respond with a COMPLETE summary that includes the actual data from tool results" |
| Focus | (none) | "Do ONLY what the task asks. Do NOT write files, run commands, or do extra work unless explicitly asked" |

Impact on ollama-local (qwen2.5-coder:32b):
- Before: 5 iterations, 5 tool calls (list_directory, run_command, write_file, read_file, run_command), inaccurate
- After: 2 iterations, 1 tool call (list_directory), accurate

## Integration Bugs Fixed During Baseline

9 bugs were found and fixed during live provider testing:

1. **URL path joining** — `new URL('/v1/...', host)` discards base path. Fixed to concatenate.
2. **Missing tool_call_id** — OpenAI APIs require it on tool result messages. Added.
3. **Parsed arguments as objects** — Groq requires `arguments` as JSON string. Re-stringify before sending.
4. **Internal properties on messages** — `_wasError` rejected by strict APIs. Strip before sending.
5. **Double-complete race** — Two `updateTaskStatus(completed)` calls, second dropped. Merged.
6. **Missing default models** — Cloud providers got `model=null`. Added PROVIDER_DEFAULT_MODEL map.
7. **Encrypted API key resolution** — `resolveApiKey` didn't read `provider_config.api_key_encrypted`. Delegated to `config.getApiKey()`.
8. **Property stripping bug** — `_wasError: false` not stripped (truthiness vs existence check). Fixed with `'in'` operator.
9. **Missing timeoutMs** — Adapter got `timeout: undefined`, causing premature timeouts. Defaulted to 120s.
10. **Ollama arguments format** — Ollama API requires `tool_calls.function.arguments` as a JSON object; OpenAI requires a JSON string. Our loop re-stringified for OpenAI, breaking Ollama Cloud. Fixed: Ollama adapter parses strings back to objects, strips `tool_call_id`.

## Known Issues

### TORQUE Runtime Hang
The agentic pipeline works perfectly in standalone Node.js execution but hangs on follow-up adapter calls when running inside the TORQUE server process. The first adapter call succeeds, but iteration 2+ requests don't return. This appears to be a Node.js event loop contention issue — TORQUE runs 4 HTTP servers (API, dashboard, GPU metrics, MCP SSE) which may saturate the connection pool or block the event loop with synchronous DB operations. Adding `Connection: close` and `agent: false` partially mitigates but doesn't fully resolve. Needs investigation in a separate session.

### Ollama Cloud Empty Summaries — RESOLVED
**Root cause:** Ollama's API requires `tool_calls[].function.arguments` as a JSON object, not a string. OpenAI requires the opposite. Our agentic loop re-stringified arguments for OpenAI compatibility, which caused Ollama Cloud to return a parse error ("Value looks like object, but can't find closing '}' symbol"). The error was swallowed silently, resulting in empty content.

**Fix:** The Ollama adapter now parses stringified arguments back to objects before sending, and strips `tool_call_id` (another OpenAI-only field that Ollama rejects).

**Result:** ollama-cloud now works perfectly — 3.8s, 2 iterations, 1 tool call, accurate count (13) and all folder names.
