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
- `--mode` — "hybrid" (default) or "full". Hybrid uses automated capture + pre-analysis + dedup. Full uses original all-agent approach.

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

### Phase 1: Discovery (unchanged)

Read `.claude/agents/visual-sweep-discovery.md` and extract the markdown body (after frontmatter).

Spawn the discovery agent:

    Agent({
      name: "sweep-discovery",
      prompt: "You are running a visual sweep discovery phase.\n\nApp: <app>\nWorking directory: <project dir>\nDepth: <depth>\nSection filter: <section or none>\n\n<discovery agent body>",
      model: "opus",
      mode: "auto"
    })

Wait for completion. If discovery fails, report the error and stop.

Report to user:

    Phase 1 — Discovery complete:
      - <N> sections found (<M> from manifest, <K> discovered)
      - <U> unreachable sections
      - Sweep plan: <plan_path>

### Phase 2: Capture (automated — no agent)

Read the sweep plan JSON. For each target with status "pending":

1. **Navigate** to the section using `peek_interact` based on the navigation type:
   - `nav_element`: `peek_interact({ process: "<process>", action: "click", element: "<navigation.target>" })`
   - `url`: `peek_interact({ process: "<process>", action: "hotkey", keys: "ctrl+l" })` then `peek_interact({ process: "<process>", action: "type", text: "<navigation.target>" })` then `peek_interact({ process: "<process>", action: "hotkey", keys: "Enter" })`
   - `keyboard`: `peek_interact({ process: "<process>", action: "hotkey", keys: "<navigation.target>" })`
   - `menu`: for each item in the path, `peek_interact({ process: "<process>", action: "click", element: "<item>" })`
   - `discovered`: `peek_interact({ process: "<process>", action: "click", element: "<navigation.element>" })`

2. **Wait for settle** — `peek_wait({ process: "<process>", conditions: [{ type: "element_exists", name: "*" }], wait_timeout: <settle_seconds> })` where settle_seconds defaults to 2. Override per-section in manifest with `"settle_seconds": N`.

3. **Capture full bundle** via `peek_diagnose({ process: "<process>", screenshot: true, annotated: true, elements: true, layout: true, text_content: true })`. This returns the full diagnostic bundle needed for pre-analysis (element tree + layout measurements + screenshots).

4. **Save** the capture result to `<working_directory>/docs/visual-sweep-captures/<target.id>.json`.

5. **Update** target status to `"captured"`. On failure, retry once. If app crashed (window not found), attempt `peek_launch`, wait 10s, retry. On second failure, mark `"status": "failed"` and continue.

Report to user:

    Phase 2 — Capture complete:
      - <N> sections captured, <F> failed
      - Captures in: <capture_dir>

**Fallback:** If the manifest has `"capture_mode": "agent"`, spawn the capture coordinator agent instead (original Phase 2 behavior). Read `.claude/agents/visual-sweep-capture.md` and spawn as before.

### Phase 3a: Pre-Analysis (mechanical checks)

For each captured target, call:

    peek_pre_analyze({ capture_path: "<capture_dir>/<target.id>.json", section_id: "<target.id>", section_label: "<target.label>" })

Collect results into a `pre_analysis` map keyed by section ID.

Report to user:

    Phase 3a — Pre-analysis complete:
      - <N> sections analyzed
      - <F> total mechanical findings
      - Top issues: <list top 3 by frequency>

### Phase 3b: Dedup (cross-section filtering)

Build finding signatures from all pre-analysis results. A finding appearing in 3+ sections is "global" — report once, don't send to individual scouts.

For each section, compute:
- `unique_findings`: findings not in the global set
- `flagged_elements`: elements with issues not covered by global dedup
- `needs_llm`: true if unique_findings > 0 OR flagged_elements > 0

Report to user:

    Phase 3b — Dedup complete:
      - <G> global findings (will report once)
      - <L> sections need LLM analysis, <S> sections skip LLM

### Phase 3c: Analysis Fleet (optimized)

Read `.claude/agents/visual-sweep-analyzer.md` and extract the body.

**For sections where `needs_llm` is true**, spawn a full analysis scout:

    Agent({
      name: "sweep-analyzer-<section_id>",
      prompt: "You are an analysis scout in a visual sweep fleet.\n\nApp: <app>\nSection ID: <target.id>\nSection Label: <target.label>\nCapture path: <capture_dir>/<target.id>.json\nWorking directory: <project dir>\nFramework: <framework>\nManifest section: <JSON or null>\n\n## Pre-Analysis Context\nThe following mechanical issues were already found by automated pre-analysis. Do NOT re-report these — focus on visual issues, stale content, novel problems, and source tracing.\n\nGlobal findings (reported separately): <JSON list of global finding signatures>\nThis section's automated findings: <JSON list of unique findings for this section>\n\n<analyzer agent body>",
      model: "opus",
      mode: "auto",
      run_in_background: true
    })

**For sections where `needs_llm` is false**, spawn a lightweight screenshot-only scout:

    Agent({
      name: "sweep-lite-<section_id>",
      prompt: "You are a lightweight visual scout. Check this screenshot for visual-only issues (wrong colors, misaligned images, stale content, broken layouts) that automated element tree analysis cannot detect. The element tree was already checked mechanically — only report issues visible in the screenshot.\n\nApp: <app>\nSection: <target.label>\nCapture path: <capture_dir>/<target.id>.json\nWorking directory: <project dir>\n\nRead the capture bundle. Look ONLY at the screenshot and annotated screenshot. If you find visual issues, write findings to docs/findings/<date>-visual-sweep-<app>-<section_id>.md. If the section looks clean, report 0 findings.\n\nAfter writing (or deciding 0 findings), send:\nSendMessage({ to: 'orchestrator', message: { type: 'analysis_complete', section_id: '<id>', findings_path: '<path or null>', finding_count: N, severity_counts: {critical:0,high:0,medium:0,low:0} } })",
      model: "sonnet",
      mode: "auto",
      run_in_background: true
    })

Note: lightweight scouts use **sonnet** (cheaper, sufficient for visual-only checks).

Collect all results as agents complete.

### Phase 4: Rollup (updated — merges both sources)

Read `.claude/agents/visual-sweep-rollup.md` and extract the body.

Spawn the rollup agent with combined context:

    Agent({
      name: "sweep-rollup",
      prompt: "You are the rollup agent for a visual sweep.\n\nApp: <app>\nFindings directory: docs/findings/\nDate: <today>\nPlan path: <plan_path>\n\n## Pre-Analysis Findings\nGlobal findings (cross-section, reported once):\n<JSON of global_findings>\n\nPer-section automated findings (sections that skipped LLM):\n<JSON of pre-analysis findings for non-LLM sections>\n\n## LLM Analysis Results\n<JSON array of analysis scout results>\n\nMerge ALL finding sources into a single summary. Include pre-analysis findings alongside LLM findings. Mark pre-analysis findings with source: 'automated' and LLM findings with source: 'visual-analysis'.\n\n<rollup agent body>",
      model: "sonnet",
      mode: "auto"
    })

Wait for completion.

### Phase 5: Report + Cleanup (unchanged)

Present to user:

    ## Visual Sweep Complete: <app>

    **Mode:** hybrid (automated capture + pre-analysis + LLM fleet)
    **Sections:** <captured>/<total> captured
    **Findings:** <total> (<automated> automated, <llm> visual analysis)
      - <critical> critical, <high> high, <medium> medium, <low> low

    ### Pre-Analysis (mechanical)
    - <G> global findings, <S> section-specific
    - Top: <list top 3>

    ### LLM Analysis
    - <L> sections analyzed by LLM, <K> sections skipped (clean)
    - <F> additional findings from visual reasoning

    ### Summary
    See: <summary file path>

    ### Action Items
    - <list CRITICAL and HIGH findings>
    - To fix: /torque-team <summary file path>

Remove temporary capture files. Keep findings files.

### Mode Flag

If the user passes `--mode full`, skip Phases 3a and 3b entirely. Run the original Phase 3 (all-LLM fleet, no pre-analysis, no dedup). This is the Take 5 behavior.

Default is `--mode hybrid`.
