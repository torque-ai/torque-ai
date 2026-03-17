# Workstation Capacity Gating — Design Spec

**Date:** 2026-03-16
**Status:** Approved

## Problem

Multiple Ollama-based providers (hashline-ollama, aider-ollama, ollama) independently select hosts and reserve slots on the `ollama_hosts` table. When a host's `max_concurrent` allows 3+ tasks but the physical GPU only has enough VRAM for 1-2 models simultaneously, providers load competing models that thrash the GPU via model eviction.

Example: BahumutsOmen (RTX 3090, 24GB VRAM) with `max_concurrent=3`:
- hashline-ollama reserves slot → loads qwen2.5-coder:32b (18GB)
- aider-ollama reserves slot → loads deepseek-r1:14b (8GB)
- Total: 26GB > 24GB VRAM → model eviction → thrashing

## Fix

Make the workstation's `max_concurrent` the **physical machine gate**. All providers already funnel through `db.tryReserveHostSlot()` and `db.decrementHostTasks()` in `host-management.js`. Modify these two functions to also reserve/release on the corresponding workstation. Zero changes to providers or task-manager.js.

## Design

1. **`tryReserveHostSlot(hostId)`** — after reserving the ollama_host slot, look up the corresponding workstation by matching hostname. If found, call `workstationModel.tryReserveSlot(wsId)`. If workstation is at capacity, roll back the ollama_host reservation and return `{ acquired: false }`.

2. **`decrementHostTasks(hostId)` / `releaseHostSlot(hostId)`** — after decrementing ollama_host, also call `workstationModel.releaseSlot(wsId)` on the corresponding workstation.

3. **Hostname matching** — `findWorkstationForOllamaHost(hostId)`: get the ollama_host URL, parse hostname, find workstation with matching `host` field. Cache the mapping to avoid repeated lookups.

4. **Set workstation max_concurrent** — the Omen workstation should have `max_concurrent=1` (single-model at a time) or `max_concurrent=2` (if concurrent same-model tasks are OK).

## Files Modified

- `server/db/host-management.js` — modify `tryReserveHostSlot`, `releaseHostSlot`, `decrementHostTasks`; add `findWorkstationForOllamaHost` helper
