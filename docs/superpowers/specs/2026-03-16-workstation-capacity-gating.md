# Workstation Capacity Gating — Design Spec

**Date:** 2026-03-16
**Status:** Implemented

## Problem

Multiple Ollama-based providers (hashline-ollama, aider-ollama, ollama) independently select hosts and reserve slots on the `ollama_hosts` table. When a host's `max_concurrent` allows 3+ tasks but the physical GPU only has enough VRAM for 1-2 models simultaneously, providers load competing models that thrash the GPU via model eviction.

Example: BahumutsOmen (RTX 3090, 24GB VRAM) with `max_concurrent=3`:
- hashline-ollama reserves slot → loads qwen2.5-coder:32b (18GB)
- aider-ollama reserves slot → loads deepseek-r1:14b (8GB)
- Total: 26GB > 24GB VRAM → model eviction → thrashing

## Fix

VRAM-aware dynamic gating. All providers funnel through `db.tryReserveHostSlot()` and `db.decrementHostTasks()` in `host-management.js`. The gate checks whether the requested model fits in GPU memory alongside currently loaded models.

## Design

### VRAM-aware gate (primary)

When `tryReserveHostSlot(hostId, requestedModel)` is called:

1. Find the corresponding workstation by hostname
2. Look up `gpu_vram_mb` from the workstation (or `memory_limit_mb` from the host)
3. Get the requested model's size from `models_cache`
4. Check if the model is already warm (loaded) → allow (no extra VRAM)
5. Check running tasks on the host → sum their model sizes → add requested model
6. If total > `gpu_vram_mb × 0.85` (15% overhead reserve) → **reject**
7. If fits → **allow**, also reserve workstation slot

### Static gate (fallback)

When model name is unavailable (e.g., v2-local-providers), falls back to the workstation's `max_concurrent` as a static capacity gate.

### Slot release

`releaseHostSlot()` and `decrementHostTasks()` also release the corresponding workstation slot.

### Dynamic behavior by hardware

- **24GB GPU (RTX 3090):** qwen2.5-coder:32b (18GB) + gemma3:4b (4GB) = 22GB → allowed. + deepseek-r1:14b (8GB) = 26GB → rejected.
- **48GB GPU (dual 4090 / A6000):** both models fit → both allowed.
- **80GB GPU (A100):** essentially unrestricted for current model sizes.

## Files Modified

- `server/db/host-management.js` — `checkVramBudget()`, `getModelSizeMb()`, `findWorkstationForOllamaHost()`, modified `tryReserveHostSlot()` / `releaseHostSlot()` / `decrementHostTasks()`
- `server/task-manager.js` — `tryReserveHostSlotWithFallback()` now looks up task model and passes to `tryReserveHostSlot()`
