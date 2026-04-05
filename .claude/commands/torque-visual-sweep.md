---
name: torque-visual-sweep
description: Deep visual audit for a single application — discovery, capture, analysis fleet
argument-hint: "<app> [--depth page|component] [--section <id>] [--schedule <time>]"
allowed-tools:
  - Agent
  - Read
  - Write
  - Glob
  - Bash
  - AskUserQuestion
  - SendMessage
  - mcp__plugin_torque_torque__store_artifact
  - mcp__plugin_torque_torque__get_artifact
  - mcp__plugin_torque_torque__list_artifacts
  - mcp__plugin_torque_torque__create_one_time_schedule
---

# TORQUE Visual Sweep

Deep visual audit for a single application. Discovers all sections, captures each sequentially via peek_diagnose, then spins up a parallel analysis fleet — one scout per section.

## Arguments

Parse `$ARGUMENTS` into:
- `app` — first positional argument (required). Project name or process name.
- `--depth` — "page" (default) or "component".
- `--section` — optional section ID to sweep only one section.
- `--schedule` — optional time string. If present, submit as one-time schedule instead of running immediately.

If no `app` argument, ask via AskUserQuestion: "Which app should I sweep? (e.g., example-project, torque-dashboard)"

## Locate Project

1. Check if `app` matches a directory name in common project locations:
   - `~/Projects/<app>/`
   - Current working directory (if it contains `peek-manifest.json`)
2. Read `peek-manifest.json` from the project directory.
3. If no manifest found, report: "No peek-manifest.json found for <app>. Create one first, or run the discovery agent to generate a draft."

## Scheduled Mode

If `--schedule` is present:
1. Parse the time (ISO 8601 or natural language like "11pm", "2h").
2. Submit via `create_one_time_schedule`:

    create_one_time_schedule({
      name: "visual-sweep-<app>",
      run_at: "<parsed ISO time>" OR delay: "<relative time>",
      task: "Run /torque-visual-sweep <app> --depth <depth>",
      working_directory: "<project dir>",
      provider: "claude-cli",
      timeout_minutes: 120
    })

3. Report: "Visual sweep for <app> scheduled at <time>. Findings will be in docs/findings/ when it completes."
4. Stop. Do not run the sweep now.

## Immediate Mode

### Phase 1: Discovery

Read `.claude/agents/visual-sweep-discovery.md` and extract the markdown body (after frontmatter).

Spawn the discovery agent:

    Agent({
      name: "sweep-discovery",
      prompt: "You are running a visual sweep discovery phase.\n\nApp: <app>\nWorking directory: <project dir>\nDepth: <depth>\nSection filter: <section or none>\n\n<discovery agent body>",
      model: "opus",
      mode: "auto"
    })

Wait for completion. The discovery agent sends a message with `type: "discovery_complete"` containing `plan_path` and target count. If it sends `type: "discovery_failed"`, report the error and stop.

Report to user:

Phase 1 — Discovery complete:
  - <N> sections found (<M> from manifest, <K> discovered)
  - <U> unreachable sections
  - Sweep plan: <plan_path>

### Phase 2: Capture

Read `.claude/agents/visual-sweep-capture.md` and extract the body.

Spawn the capture coordinator:

    Agent({
      name: "sweep-capture",
      prompt: "You are running a visual sweep capture phase.\n\nPlan path: <plan_path>\nProcess: <process from manifest>\n\n<capture agent body>",
      model: "opus",
      mode: "auto"
    })

Wait for completion. The coordinator sends `type: "capture_complete"` with captured/failed counts.

Report to user:

Phase 2 — Capture complete:
  - <N> sections captured
  - <F> sections failed
  - Captures in: <capture_dir>

### Phase 3: Analysis Fleet

Read the sweep plan JSON to get all captured targets. Read `.claude/agents/visual-sweep-analyzer.md` and extract the body.

For each target with status "captured", spawn an analysis scout:

    Agent({
      name: "sweep-analyzer-<section_id>",
      prompt: "You are an analysis scout in a visual sweep fleet.\n\nApp: <app>\nSection ID: <target.id>\nSection Label: <target.label>\nCapture path: <capture_dir>/<target.id>.json\nWorking directory: <project dir>\nFramework: <framework>\nManifest section: <JSON or null>\n\n<analyzer agent body>",
      model: "opus",
      mode: "auto",
      run_in_background: true
    })

**All analysis scouts run in parallel** (run_in_background: true). Collect results as they complete. Each sends `type: "analysis_complete"` with finding counts.

### Phase 4: Rollup

Once all scouts complete, read `.claude/agents/visual-sweep-rollup.md` and extract the body.

Spawn the rollup agent:

    Agent({
      name: "sweep-rollup",
      prompt: "You are the rollup agent for a visual sweep.\n\nApp: <app>\nFindings directory: docs/findings/\nDate: <today>\nPlan path: <plan_path>\nSection results: <JSON array of analysis results>\n\n<rollup agent body>",
      model: "sonnet",
      mode: "auto"
    })

Wait for completion.

### Phase 5: Report

Present to user:

## Visual Sweep Complete: <app>

**Sections:** <captured>/<total> captured
**Findings:** <total> (<critical> critical, <high> high, <medium> medium, <low> low)

### Summary
See: <summary file path>

### Per-Section
<table: section | findings | top severity>

### Action Items
- <list CRITICAL and HIGH findings>
- To fix: /torque-team <summary file path>

### Cleanup

Remove temporary capture files:

    rm -rf <working_directory>/docs/visual-sweep-captures/
    rm -f <working_directory>/docs/visual-sweep-plan.json

Keep findings files — they are the permanent output.
