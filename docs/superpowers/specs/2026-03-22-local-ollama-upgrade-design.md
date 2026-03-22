# Local Ollama Model Upgrade — qwen3-coder:30b-a3b

## Problem

The current local Ollama model (`qwen2.5-coder:32b`) has a 25% task success rate and frequent stalls. It was released Sept 2024 and predates agentic tool-calling training. Meanwhile, the agentic execution path in TORQUE already supports tool-use loops — the model just isn't good enough to use them reliably.

hashline-ollama achieves 100% on targeted edits but can't create files, so file-creation tasks fall back to codex (slow, opens windows).

## Solution

Swap to `qwen3-coder:30b-a3b` — a Mixture-of-Experts model (30B total, 3.3B active) trained on 800K agentic coding tasks with native tool calling. Runs ~112 tok/s on RTX 3090 (3x faster than current). Fits 24GB VRAM at Q4_K_M with num_ctx=16384.

## Changes

### 1. Model swap
- Pull `qwen3-coder:30b-a3b` on BahumutsOmen
- Update default model in TORQUE config
- Update fallback model reference (codestral:22b stays as fallback)

### 2. Smart routing update
- Route file-creation tasks to `ollama` (agentic) instead of falling back to codex
- Keep hashline-ollama for fast targeted edits (100% success, don't break it)
- Only fall to codex for complex multi-file tasks

### 3. Tuning profile
- temperature: 0.15 (code precision)
- num_ctx: 16384 (fits 24GB with KV cache)
- num_predict: -1 (unlimited generation)
- MoE-specific: adjust top_k/top_p for sparse activation

### 4. No changes needed
- Agentic loop (ollama-agentic.js) — already works
- Tool executor (ollama-tools.js) — already has write_file
- Capability detection — qwen3 prefix already whitelisted

## Success Criteria
- Local Ollama task success rate > 80% (up from 25%)
- File creation works without codex fallback
- hashline-ollama targeted edits remain 100%
- No VRAM OOM on RTX 3090
