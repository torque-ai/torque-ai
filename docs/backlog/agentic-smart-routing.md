# Backlog: Agentic Smart Routing with Fallback Chains

**Priority:** High (after TORQUE runtime hang fix)
**Depends on:** Universal agentic tool calling (DONE), 14 Grade A models baselined (DONE)

## Vision

Every agentic task gets the best free model for its category, with automatic fallback to the next-best model if the primary fails (rate limit, quota, error). Claude orchestrates, TORQUE dispatches to the optimal free LLM, and the agentic pipeline executes with real tool calling.

## Task Categories

| Category | Description | Best Model Profile |
|----------|-------------|-------------------|
| targeted-edit | Single file, focused change | Fast + accurate (sub-2s) |
| multi-file-edit | Coordinated changes across files | Large context + strong reasoning |
| code-review | Read-only analysis, pattern detection | Large model, accuracy over speed |
| test-generation | Write test cases for existing code | Code-aware, test pattern knowledge |
| search-and-report | Find patterns, summarize findings | Fast, good at search tool usage |
| build-and-verify | Run commands, check output | Reliable command execution |
| documentation | Generate docs, comments, summaries | Good prose, follows conventions |

## Fallback Chains (from baseline data)

    targeted-edit:
      1. cerebras / qwen-3-235b          (779ms)
      2. groq / gpt-oss-120b             (923ms)
      3. groq / qwen3-32b                (2.4s)
      4. google-ai / gemini-2.5-flash    (3.6s)

    multi-file-edit:
      1. ollama-cloud / kimi-k2:1t       (4.5s, 1T params)
      2. ollama-cloud / qwen3-coder:480b (6.0s, code-specialized)
      3. cerebras / qwen-3-235b          (779ms)
      4. google-ai / gemini-2.5-flash    (3.6s)

    code-review:
      1. ollama-cloud / mistral-large-3:675b  (5.2s)
      2. ollama-cloud / kimi-k2:1t            (4.5s)
      3. google-ai / gemini-2.5-flash         (3.6s)
      4. cerebras / qwen-3-235b               (779ms)

    test-generation:
      1. ollama-cloud / qwen3-coder:480b (6.0s)
      2. cerebras / qwen-3-235b          (779ms)
      3. groq / qwen3-32b                (2.4s)
      4. google-ai / gemini-2.5-flash    (3.6s)

    search-and-report:
      1. cerebras / qwen-3-235b          (779ms)
      2. groq / gpt-oss-120b             (923ms)
      3. openrouter / nemotron-30b:free  (3.9s)
      4. google-ai / gemini-2.5-flash-lite (1.6s)

    build-and-verify:
      1. groq / qwen3-32b                (2.4s)
      2. cerebras / qwen-3-235b          (779ms)
      3. google-ai / gemini-2.5-flash    (3.6s)
      4. ollama-cloud / kimi-k2:1t       (4.5s)

    documentation:
      1. groq / gpt-oss-120b             (923ms)
      2. google-ai / gemini-2.5-flash    (3.6s)
      3. ollama-cloud / mistral-large-3:675b (5.2s)
      4. cerebras / qwen-3-235b          (779ms)

## Implementation

1. Extend `routing/category-classifier.js` for 7 agentic categories
2. Store fallback chains in DB (similar to routing templates)
3. On provider failure (429/timeout/quota), auto-retry with next in chain
4. Track success rates per model per category — re-order chains over time
5. Token budget routing: small tasks to fast models, large to big-context models

## Blocker

TORQUE runtime hang must be fixed first. Agentic tasks work in standalone execution but hang on follow-up adapter calls inside the TORQUE server process. Likely Node.js event loop contention from TORQUE's 4 HTTP servers.
