# Agentic Tool Calling — Comprehensive Model Baseline

**Date:** 2026-03-18
**Test:** "Use list_directory to list tests/. Report exact folder names and total count."
**Ground truth:** 13 test project folders (directories ending in `/`) + 2 files + 1 supervisor directory
**Methodology:** Standalone `runAgenticLoop()` against real provider APIs. 22 models across 7 providers.

## Results by Grade

### Grade A — Perfect (correct folder count + all names listed)

| Rank | Provider | Model | Time | Iters | Tools | Notes |
|------|----------|-------|------|-------|-------|-------|
| 1 | cerebras | qwen-3-235b-a22b-instruct-2507 | 779ms | 2 | 1 | Best overall. Sub-second. |
| 2 | groq | llama-3.3-70b-versatile | 1709ms | 3 | 2 | Solid but makes redundant 2nd tool call |
| 3 | groq | qwen3-32b | 2452ms | 2 | 1 | Clean, efficient |
| 4 | google-ai | gemini-2.5-flash | 3574ms | 2 | 1 | Excellent via Gemini function calling |
| 5 | openrouter | nemotron-3-nano-30b-a3b:free | 3920ms | 2 | 1 | Best free-tier model |
| 6 | ollama-cloud | kimi-k2:1t | 4529ms | 2 | 1 | 1T parameter model, accurate |
| 7 | ollama-cloud | qwen3-coder:480b | 6017ms | 2 | 1 | Purpose-built code model |
| 8 | ollama-cloud | deepseek-v3.2 | 9856ms | 4 | 3 | Accurate but chatty (3 tool calls) |
| 9 | local | codestral:22b (prompt-injected) | 20714ms | 2 | 1 | Works via [AVAILABLE_TOOLS] injection |
| 10 | local | qwen2.5-coder:32b | 75900ms | 2 | 1 | Accurate, GPU-bound |

### Grade B+ — Partial (names correct, count wrong or missing)

| Provider | Model | Time | Iters | Tools | Issue |
|----------|-------|------|-------|-------|-------|
| groq | gpt-oss-120b | 950ms | 2 | 1 | Counted 15 (included non-folder items) |
| groq | kimi-k2-instruct | 1014ms | 2 | 1 | Listed names, no explicit count |
| groq | llama-3.1-8b-instant | 1186ms | 2 | 6 | Over-called tools (6 calls), counted 10 |
| google-ai | gemini-2.5-flash-lite | 1377ms | 2 | 1 | Counted 15 (files + folders) |
| groq | llama-4-scout-17b | 1453ms | 2 | 1 | Counted 14 |
| ollama-cloud | gpt-oss:120b | 7150ms | 2 | 1 | Counted 15 (files + folders) |

### Grade C — Tool works, bad output

| Provider | Model | Time | Issue |
|----------|-------|------|-------|
| ollama-cloud | devstral-2:123b | 1529ms | Intermittent empty summaries |

### Grade F — Tools don't work

| Provider | Model | Time | Issue |
|----------|-------|------|-------|
| ollama-cloud | mistral-large-3:675b | 569ms | Didn't call tools at all |
| cerebras | llama3.1-8b | 4249ms | Output tool call as raw text (8B too small) |

### Errors (API/quota issues)

| Provider | Model | Error |
|----------|-------|-------|
| google-ai | gemini-2.5-pro | 429 quota exceeded |
| openrouter | gemma-3-27b:free | Guardrail restrictions |
| openrouter | llama-3.3-70b:free | Provider returned error |

## Issues Identified

### Issue 1: B+ models count files+folders instead of just folders
Six models report 14 or 15 instead of 13 because they count `Directory.Build.props` and `folder_count.txt` as entries. The `list_directory` tool annotates directories with `/` suffix, but the prompt doesn't tell the model to only count directories.

**Fix:** Improve the `list_directory` tool output to clearly separate directories from files, or improve the system prompt to specify "count entries ending in /".

### Issue 2: ollama-cloud/devstral-2:123b intermittent empty summaries
Sometimes returns content, sometimes empty. Root cause identified and fixed earlier (Ollama arguments format), but still intermittent. Likely model-level non-determinism on whether to generate a text summary after tool results.

### Issue 3: ollama-cloud/mistral-large-3:675b doesn't call tools
675B parameter Mistral model doesn't use tools via Ollama cloud. May need prompt injection like codestral (same Mistral family). The model template on ollama-cloud may lack .Tools support.

### Issue 4: groq/llama-3.1-8b makes too many tool calls
Makes 6 tool calls for a single directory listing. The 8B model lacks focus — calls the same tool repeatedly or calls unrelated tools. Too small for reliable agentic use.

### Issue 5: groq/llama-3.3-70b intermittent "failed to call function"
Sometimes groq rejects the model's tool call format. This is a groq-side issue, not controllable from our end. The same model works most of the time.

## Recommended Default Models

Based on this baseline, the optimal default model per provider:

| Provider | Recommended Model | Reason |
|----------|------------------|--------|
| cerebras | qwen-3-235b-a22b-instruct-2507 | Fastest, most accurate |
| groq | qwen3-32b | More consistent than llama-3.3-70b (no "failed to call" errors), clean output |
| google-ai | gemini-2.5-flash | Only working model with quota |
| ollama-cloud | kimi-k2:1t | Most accurate, reasonable speed |
| openrouter | nvidia/nemotron-3-nano-30b-a3b:free | Only reliable free model |
| local ollama | qwen2.5-coder:32b | Only 32B+ model installed |

## Improvement Opportunities

1. **list_directory output format** — Separate dirs from files more clearly to help B+ models count correctly
2. **mistral-large-3 prompt injection** — Same technique that fixed codestral could work for mistral-large on ollama-cloud
3. **groq default model** — Switch from llama-3.3-70b to qwen3-32b for better consistency
4. **ollama-cloud default model** — Switch from devstral-2:123b to kimi-k2:1t for reliability
