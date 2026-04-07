# Agentic Tool Calling — Free LLM Roster

**Date:** 2026-03-18
**Context:** Universal agentic tool calling shipped for TORQUE. All models below have been tested end-to-end with real tool execution (list_directory, read_file, edit_file, search_files, run_command) against the example-project codebase.

## Roster: 14 Grade A Models, All Free

### Tier 1 — Sub-Second (latency-critical tasks)

| Provider | Model | Params | Time | Adapter | Notes |
|----------|-------|--------|------|---------|-------|
| cerebras | qwen-3-235b-a22b-instruct-2507 | 235B (22B active) | 779ms | openai-chat | Best overall. Consistent, efficient, single tool call. |

### Tier 2 — Fast (1-3s, good all-rounders)

| Provider | Model | Params | Time | Adapter | Notes |
|----------|-------|--------|------|---------|-------|
| groq | openai/gpt-oss-120b | 120B | 923ms | openai-chat | GPT-OSS via groq. Fast and accurate. |
| groq | moonshotai/kimi-k2-instruct | ~1T MoE | 1.0s | openai-chat | Moonshot's flagship. Sometimes omits count. |
| groq | meta-llama/llama-4-scout-17b-16e-instruct | 17B x16 MoE | 1.5s | openai-chat | Meta's new scout model. Clean output. |
| google-ai | gemini-2.5-flash-lite | ~small | 1.6s | google-chat | Lightweight Gemini. Uses function calling API. |
| groq | qwen/qwen3-32b | 32B | 2.4s | openai-chat | **TORQUE default for groq.** Most consistent. |

### Tier 3 — Heavy Hitters (3-6s, largest models)

| Provider | Model | Params | Time | Adapter | Notes |
|----------|-------|--------|------|---------|-------|
| ollama-cloud | gpt-oss:120b | 120B | 3.1s | ollama-chat | GPT-OSS via Ollama Cloud. |
| google-ai | gemini-2.5-flash | ~medium | 3.6s | google-chat | **TORQUE default for google-ai.** Solid. |
| openrouter | nvidia/nemotron-3-nano-30b-a3b:free | 30B | 3.9s | openai-chat | **Best free-tier model on openrouter.** |
| ollama-cloud | kimi-k2:1t | 1T MoE | 4.5s | ollama-chat | **TORQUE default for ollama-cloud.** Largest model. |
| ollama-cloud | mistral-large-3:675b | 675B | 5.2s | ollama-chat | Mistral's flagship. Native tools. |
| ollama-cloud | qwen3-coder:480b | 480B | 6.0s | ollama-chat | Purpose-built code model. |

### Tier 4 — Local (no API, GPU-bound)

| Provider | Model | Params | Time | Adapter | Notes |
|----------|-------|--------|------|---------|-------|
| local ollama | codestral:22b | 22B | 20.7s | ollama-chat | Requires prompt injection mode. Mistral code model. |
| local ollama | qwen2.5-coder:32b | 32B | 75.9s | ollama-chat | Native tool support. Slow on 8GB VRAM. |

## Provider Summary

| Provider | Free Tier | Models Tested | Grade A | Best Model | API Format |
|----------|-----------|---------------|---------|------------|------------|
| **cerebras** | Yes (rate-limited) | 2 | 1 | qwen-3-235b (779ms) | OpenAI-compatible |
| **groq** | Yes (rate-limited) | 6 | 5 | gpt-oss-120b (923ms) | OpenAI-compatible |
| **google-ai** | Yes (quota-limited) | 3 | 2 | gemini-2.5-flash-lite (1.6s) | Gemini function calling |
| **ollama-cloud** | Yes (free) | 6 | 4 | gpt-oss:120b (3.1s) | Ollama /api/chat |
| **openrouter** | Yes (free models) | 3 | 1 | nemotron-30b:free (3.9s) | OpenAI-compatible |
| **local ollama** | N/A (self-hosted) | 2 | 2 | codestral:22b (20.7s) | Ollama /api/chat |

## TORQUE Default Models

These are auto-selected when `task.model` is null:

```
cerebras    → qwen-3-235b-a22b-instruct-2507
groq        → qwen/qwen3-32b
google-ai   → gemini-2.5-flash
ollama-cloud → kimi-k2:1t
openrouter  → nvidia/nemotron-3-nano-30b-a3b:free
```

Users can override via `model` parameter on `submit_task`.

## Adapter Architecture

Three adapters handle all 14 models:

| Adapter | API Format | Providers | Key Differences |
|---------|-----------|-----------|-----------------|
| **openai-chat** | `/v1/chat/completions` JSON | groq, cerebras, openrouter | Bearer auth, arguments as JSON string |
| **ollama-chat** | `/api/chat` NDJSON | local ollama, ollama-cloud | Optional Bearer auth, arguments as JSON object, strips tool_call_id |
| **google-chat** | Gemini `generateContent` | google-ai | API key in query param, functionDeclarations format |

### Format Differences Handled

| Issue | OpenAI Format | Ollama Format | Google Format |
|-------|---------------|---------------|---------------|
| Arguments | JSON string | JSON object | JSON object |
| Tool result ID | Required (`tool_call_id`) | Rejected (stripped) | Not used |
| Auth | `Authorization: Bearer` | `Authorization: Bearer` (optional) | `?key=` query param |
| Streaming | SSE `data:` lines | NDJSON lines | Single JSON response |

### Special Modes

**Prompt-injected tools** — For models whose Ollama template lacks `.Tools` support (codestral:22b):
- Tool definitions injected into system prompt via `[AVAILABLE_TOOLS]`
- Tool results sent as `role: 'user'` with `[TOOL_RESULTS]` format
- Model outputs tool calls as JSON arrays in content (parsed by parseToolCalls)
- Auto-detected via `needsPromptInjection(model)` in agentic-capability.js

## Integration Bugs Fixed (10 total)

All bugs were found during live provider testing. Unit tests with mock servers missed them because real APIs have stricter format requirements.

1. **URL path joining** — `new URL()` discards base path
2. **Missing tool_call_id** — OpenAI requires it, Ollama rejects it
3. **Arguments as objects vs strings** — Ollama needs objects, OpenAI needs strings
4. **Internal properties on messages** — `_wasError` rejected by strict APIs
5. **Double-complete race** — Two status updates, second dropped
6. **Missing default models** — `model=null` sent to APIs
7. **Encrypted API key resolution** — Missed new `provider_config.api_key_encrypted`
8. **Property stripping bug** — `!false` vs `'in'` operator
9. **Missing timeoutMs** — `timeout: undefined` on HTTP requests
10. **Ollama arguments format** — String args cause parse error on ollama-cloud

## Improvement: list_directory Structured Output

Changed tool output from flat list to structured format:

```
Before:                          After:
example-project.App.Tests/          Directories (13):
example-project.Domain.Tests/         example-project.App.Tests/
Directory.Build.props              example-project.Domain.Tests/
folder_count.txt                   ...
                                 Files (4):
                                   Directory.Build.props
                                   folder_count.txt
```

Impact: 4 of 5 B+ models upgraded to Grade A. The explicit directory count eliminates the files-vs-folders confusion that caused models to report 14 or 15 instead of 13.

## Cost

Zero. All models tested are free tier. No API credits spent.

The only costs are:
- Electricity for remote-gpu-host running local Ollama (2 models, consumer GPU)
- Internet bandwidth for API calls (minimal — text only, no images)
