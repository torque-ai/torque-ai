# Visual Sweep Hybrid Architecture Design

**Date:** 2026-04-05
**Status:** Draft
**Author:** Claude (brainstormed with user + Alcove)
**Prerequisite:** Visual Sweep Fleet (shipped 2026-04-05, live-tested on example-project)

## Overview

Optimizes the visual sweep by automating mechanical work and reserving Claude agents for tasks that require visual reasoning. Based on data from the first live test: 67 findings across 11 sections, where ~40% were mechanical (missing names, bounds overflow, empty containers) and ~30% were cross-section duplicates.

Three changes: (1) replace the capture coordinator agent with a direct MCP call loop, (2) add a pre-analysis phase that runs mechanical checks on element trees, (3) deduplicate cross-section findings before spawning LLM agents.

Target: 55% token reduction (~1.1M → ~400-500K) with the same or better finding coverage.

## Automated Capture (replaces Phase 2 agent)

The sweep command replaces the capture coordinator Claude agent with a direct loop. For each target in the sweep plan:

1. **Build steps** — `buildCaptureSteps(target)` translates the manifest navigation spec into a `peek_action_sequence` steps array.
2. **Validate steps** — `validateSteps(steps)` checks the output is well-formed before sending.
3. **Execute** — `peek_action_sequence({ process, steps })` navigates + captures in one round-trip.
4. **Save** — write the capture result to `docs/visual-sweep-captures/<target.id>.json`.
5. **Update** — mark target as `"captured"` in sweep plan. On failure, retry once, then mark `"failed"`.

### Step Builder

Translates navigation types to peek_action_sequence steps:

| Nav Type | Steps |
|----------|-------|
| `nav_element` | `[click element]` |
| `url` | `[hotkey ctrl+l, type url, hotkey Enter]` |
| `keyboard` | `[hotkey keys]` |
| `menu` | `[click item1, click item2, ...]` |
| `discovered` | `[click element]` |

Universal suffix appended to all: `[sleep settle_ms, capture]`.

### Step Validator

Validates the step builder's output before sending to peek_server:

```js
const VALID_ACTIONS = new Set(['click', 'type', 'hotkey', 'scroll', 'wait', 'sleep', 'capture', 'focus']);

function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return 'Empty steps array';
  for (const step of steps) {
    if (!step.action || !VALID_ACTIONS.has(step.action)) return `Invalid action: "${step.action}"`;
    if (step.action === 'click' && !step.element && !step.x) return 'Click requires element or coordinates';
    if (step.action === 'type' && !step.text) return 'Type requires text';
    if (step.action === 'hotkey' && !step.keys) return 'Hotkey requires keys';
  }
  return null;
}
```

### Validation Chain

Four layers, each catching a different class of error:

1. **Discovery** — validates navigation targets exist in the live UI
2. **Step builder** — validates navigation type is a known enum
3. **Step validator** — validates output steps are well-formed
4. **peek_action_sequence** — server-side execution validates and rejects bad requests

### Manifest Extension

New optional field per section:

```json
{
  "id": "dashboard",
  "label": "Dashboard",
  "navigation": { "type": "nav_element", "target": "DashboardNavItem" },
  "settle_ms": 2000
}
```

`settle_ms` — milliseconds to sleep after navigation before capture. Defaults to 1000. Replaces the fragile 5s peek_wait timeout.

### Fallback

The `visual-sweep-capture.md` agent definition stays for complex navigation (multi-step login flows, dynamic menus). The sweep command checks `capture_mode` on the manifest:

- `"auto"` (default) — uses the direct loop
- `"agent"` — spawns the capture coordinator agent (original behavior)

### Cost Impact

Eliminates the capture coordinator opus agent entirely. ~$5-10 saved per sweep.

## Pre-Analysis (new Phase 3a)

A new MCP tool `peek_pre_analyze` in the snapscope plugin. Reads a capture bundle's element tree JSON (not screenshots) and runs mechanical checks.

### Checks

| Check | Logic | Severity |
|-------|-------|----------|
| Missing accessible names | `element.name === ""` on interactive types (Button, Edit, ComboBox, RadioButton, MenuItem) | HIGH |
| Bounds overflow | child bounds exceed parent bounds (X or Y axis) | MEDIUM |
| Empty containers | List/DataGrid/TreeView/Custom with `children.length === 0` | MEDIUM |
| Small interactive elements | Interactive element with `bounds.w < 24` or `bounds.h < 24` | LOW |
| Duplicate automation IDs | Same `automation_id` appears multiple times in tree | MEDIUM |

### Input

```json
{
  "capture_path": "docs/visual-sweep-captures/dashboard.json",
  "section_id": "dashboard",
  "section_label": "Dashboard"
}
```

Reads only the `elements` field from the capture bundle. Ignores screenshots.

### Output

```json
{
  "findings": [
    {
      "check": "missing_name",
      "severity": "HIGH",
      "element_type": "Button",
      "element_name": "",
      "automation_id": "UnreadFilterBtn",
      "bounds": { "x": 100, "y": 200, "w": 30, "h": 30 },
      "parent": "NotificationPanel"
    }
  ],
  "flagged_elements": ["UnreadFilterBtn", "OverflowingGrid"],
  "stats": {
    "total_elements": 142,
    "interactive": 38,
    "checks_run": 5,
    "findings": 12
  }
}
```

### Performance

Pure JSON traversal — milliseconds per section. No network calls, no LLM tokens.

## Cross-Section Dedup (new Phase 3b)

After pre-analysis runs on all sections, the sweep command deduplicates findings before spawning LLM agents.

### Finding Signature

Each pre-analysis finding gets a hash key: `check + element_type + automation_id + element_name`. If the same signature appears in 3+ sections, it's a global issue — reported once in the rollup, not sent to every scout.

### Dedup Context

```json
{
  "global_findings": [
    {
      "signature": "missing_name:Button::UnreadFilterBtn",
      "sections_affected": 8,
      "finding": { ... }
    }
  ],
  "per_section": {
    "dashboard": { "unique_findings": 3, "flagged_elements": ["WidgetGrid"], "needs_llm": true },
    "sales": { "unique_findings": 0, "flagged_elements": [], "needs_llm": false }
  }
}
```

### LLM Agent Gating

A section gets a **full** LLM analysis scout if:

- It has unique pre-analysis findings (not covered by global dedup), OR
- It has flagged elements that need visual interpretation, OR
- `force_llm: true` in the manifest section (opt-in override)

A section gets a **lightweight** LLM pass (screenshot-only, no element tree, no source tracing) if:

- Zero pre-analysis flags, BUT visual-only issues (wrong colors, misaligned images, stale content) can't be caught by element tree checks alone

A section is **skipped entirely** only if `skip_llm: true` in the manifest section (opt-out override).

This ensures visual-only issues aren't missed while still reducing cost — lightweight passes use smaller context (~20K tokens vs ~60K for full).

### What LLM Scouts Receive

Each scout gets a trimmed input:

- Screenshot + annotated screenshot (for visual reasoning)
- Its section's unique flagged elements (focus areas)
- The global findings list (so it knows what's already reported — don't re-find)
- Instruction to skip mechanical checks (already done in 3a)

### Estimated Savings (example-project baseline)

- 11 sections → ~6-8 need LLM agents, ~3-5 are pre-analysis only
- Per-agent input drops from ~100K to ~60K tokens (smaller bundles, skip mechanical work)
- ~20 duplicate findings eliminated before agents spawn

## Updated Phase Flow

```
Phase 1: Discovery (unchanged)
  → reads manifest, validates sections, produces sweep plan

Phase 2: Capture (automated — no agent)
  → sweep command loops: buildCaptureSteps → validateSteps → peek_action_sequence
  → saves bundles to disk, updates sweep plan

Phase 3a: Pre-Analysis (new — MCP tool)
  → peek_pre_analyze() on each capture bundle's element tree
  → mechanical findings + flagged elements per section

Phase 3b: Dedup (new — in sweep command)
  → hash findings across sections, identify global vs unique
  → gate LLM agents: skip sections with 0 unique flags

Phase 3c: Analysis Fleet (optimized — fewer agents, smaller inputs)
  → only sections that need LLM get a scout
  → scouts receive: screenshot + unique flags + global findings (don't re-find)
  → scouts skip mechanical checks (already done in 3a)

Phase 4: Rollup (updated — merges both sources)
  → merges pre-analysis findings (3a) + global dedup findings (3b) + LLM findings (3c)
  → single summary file, same format as before

Phase 5: Report + Cleanup (unchanged)
```

### Mode Flag

`--mode full` skips pre-analysis and dedup, running the original all-LLM fleet. For debugging or maximum coverage regardless of cost. Default is `--mode hybrid`.

## Files Affected

| File | Change |
|------|--------|
| `.claude/commands/torque-visual-sweep.md` | Rewrite Phase 2 (loop), add Phases 3a/3b, update 3c/4 |
| `.claude/agents/visual-sweep-analyzer.md` | Accept pre-analysis context, skip mechanical checks |
| `.claude/agents/visual-sweep-rollup.md` | Merge two finding sources (pre-analysis + LLM) |
| `.claude/agents/visual-sweep-capture.md` | Kept as fallback (capture_mode: "agent") |
| `server/plugins/snapscope/handlers/analysis.js` | Add handlePeekPreAnalyze function |
| `server/plugins/snapscope/tool-defs.js` | Add peek_pre_analyze tool definition |
| `server/plugins/snapscope/index.js` | Add peek_pre_analyze to tier 1 |

## New Code

| Module | Purpose |
|--------|---------|
| `peek_pre_analyze` MCP tool | Mechanical element tree checks |
| `buildCaptureSteps(target)` | Translate manifest nav spec → peek_action_sequence steps |
| `validateSteps(steps)` | Validate step builder output before execution |
| Step builder + validator tests | TDD — tests written before implementation |

## Cost Comparison (example-project baseline)

| Phase | Current | Hybrid |
|-------|---------|--------|
| Discovery | ~$1-2 | ~$1-2 (unchanged) |
| Capture | ~$5-10 (opus agent) | ~$0 (MCP calls) |
| Pre-analysis | N/A | ~$0 (JSON traversal) |
| Analysis | 11 agents x ~100K = ~1.1M tokens | ~6-8 agents x ~60K = ~400K tokens |
| Rollup | ~$1 (sonnet) | ~$1 (sonnet) |
| **Total** | **~$17-30** | **~$7-12** |