# Visual Sweep Fleet Design

**Date:** 2026-04-05
**Status:** Draft
**Author:** Claude (brainstormed with user)

## Overview

Visual Sweep is a deep visual audit for a single application. It splits the monolithic visual scout into three phases: discovery, sequential capture, and parallel analysis. Each phase is purpose-built for its constraint — discovery plans the sweep, capture serializes peek_server access, and analysis fans out across a fleet of scouts that reason over stored data.

The primary use case is overnight audits: the user kicks off a sweep before bed and has comprehensive findings waiting in the morning.

## Core Concepts

### Three-Phase Architecture

1. **Discovery** — One agent launches the app (if needed), walks the UI to enumerate all pages/routes/sections, cross-references the project's peek manifest, and produces a sweep plan.
2. **Capture** — A capture coordinator walks the sweep plan sequentially, navigating to each section and calling `peek_diagnose` for a full bundle (screenshot + annotated screenshot + element tree + layout measurements + text content). Each bundle is stored as a TORQUE artifact.
3. **Analysis** — A fleet of analysis scouts spin up in parallel, one per section. Each receives its capture bundle and the project context, then writes findings. No peek_server contention since they analyze stored data.

### Depth Levels

- **Page (depth B, default):** One analysis scout per page/route/view. Covers the full app at screen-level granularity.
- **Component (depth C, opt-in):** One analysis scout per component region within a section. For when a specific page needs fine-grained inspection.

### Sequential Constraint

The peek_server on Omen handles one capture at a time. The capture coordinator serializes all `peek_diagnose` calls. Analysis scouts run fully in parallel since they read stored artifacts, not live captures.

## Peek Manifest

Each project declares its visual surfaces in `peek-manifest.json` at the project root:

```json
{
  "app": "example-project",
  "process": "example-project.Desktop",
  "framework": "wpf",
  "sections": [
    {
      "id": "dashboard",
      "label": "Dashboard",
      "navigation": { "type": "nav_element", "target": "DashboardNavItem" },
      "depth": "page"
    },
    {
      "id": "transactions",
      "label": "Transactions List",
      "navigation": { "type": "nav_element", "target": "TransactionsNavItem" },
      "depth": "page",
      "subsections": [
        { "id": "transactions-filters", "label": "Filter Panel", "element": "FilterPanel" },
        { "id": "transactions-table", "label": "Data Grid", "element": "TransactionGrid" }
      ]
    }
  ]
}
```

- **`sections`** — depth-B targets (pages/routes). Always swept.
- **`subsections`** — depth-C targets (component regions). Swept only with `--depth component` or `--section <id>`.
- **`navigation`** — how to reach the section. Supported types:
  - `nav_element` — click a UI Automation element by automation ID or name.
  - `url` — navigate to a URL/route (Electron/React apps).
  - `keyboard` — send a key sequence (e.g., `Ctrl+Shift+S` for settings).
  - `menu` — traverse a menu path (e.g., `["File", "Preferences"]`).
  - `discovered` — auto-detected by discovery agent, not in manifest. Stored with the element reference.
- **`framework`** — `wpf`, `react`, or `electron`. Drives hook detection patterns.

### Manifest Enforcement Hooks

Two hooks ensure no visual surface goes unregistered:

#### Pre-commit Hook (catches human commits)

Scans staged files for visual-enabling patterns based on `framework`:
- **WPF:** new `.xaml` files containing `Window`, `Page`, or `UserControl`
- **React:** new files in `pages/`, `app/`, or route config changes
- **Electron:** new `BrowserWindow` creation calls

If a new visual surface is detected and not in `peek-manifest.json`, the commit is blocked:
> "New visual surface detected: `BudgetDetailPage.xaml`. Add it to peek-manifest.json or mark it `skip_visual: true`."

#### TORQUE Post-Task Hook (catches TORQUE-generated code)

After any task completes that touched files matching the visual patterns above, TORQUE checks the manifest. If a new surface is missing, it creates an approval gate:
> "New visual surface detected. Add to manifest?"

Auto-suggests a manifest entry based on the file's framework type, name, and location.

## Sweep Plan

The discovery agent produces a sweep plan stored as a TORQUE artifact:

```json
{
  "app": "example-project",
  "process": "example-project.Desktop",
  "host": "example-host",
  "depth": "page",
  "created_at": "2026-04-05T23:00:00Z",
  "targets": [
    {
      "id": "dashboard",
      "label": "Dashboard",
      "navigation": { "type": "nav_element", "target": "DashboardNavItem" },
      "capture_method": "peek_diagnose",
      "status": "pending"
    },
    {
      "id": "unmanifested-settings",
      "label": "Settings (unmanifested)",
      "navigation": { "type": "discovered", "element": "SettingsGearIcon" },
      "capture_method": "peek_diagnose",
      "status": "pending",
      "warning": "Not in peek-manifest.json"
    }
  ]
}
```

### Discovery Workflow

1. **Read manifest** — load `peek-manifest.json` from the project directory.
2. **Ensure app is running** — `peek_ui({ list_windows: true })` to check. If not running, use `peek_launch` to start it.
3. **Validate manifest sections** — for each section, use `peek_elements` to verify the navigation target exists. Flag unreachable sections as `"status": "unreachable"`.
4. **Detect unmanifested surfaces** — walk the element tree for nav items, tab controls, menu items, and route links not in the manifest. Add them as targets with a `warning` field.
5. **Depth expansion** — if `--depth component` was requested, expand each section's `subsections` into individual targets.
6. **Store sweep plan** as a TORQUE artifact via `store_artifact`.

## Capture Coordinator

A lightweight agent that walks the sweep plan sequentially. Its only job is navigating and capturing — no analysis.

### Workflow

1. Load sweep plan from artifact storage.
2. For each target in order:
   - Navigate to the section using `peek_interact` based on the target's `navigation` field.
   - Wait for UI to settle: `peek_wait({ process: "...", stable_ms: 1000 })`.
   - Capture via `peek_diagnose({ process: "..." })` — screenshot, annotated screenshot, element tree, layout measurements, text content.
   - Store capture bundle as TORQUE artifact keyed by target ID (e.g., `sweep-example-project-dashboard-capture`).
   - Update target status: `"pending"` → `"captured"`.
   - On failure: mark as `"failed"` with error, continue to next target.
3. Store updated sweep plan with all statuses.
4. Hand off to analysis phase.

### Resilience

- **App crash:** Coordinator attempts `peek_launch` to restart, navigates back, retries the failed target once.
- **Coordinator crash:** Retry skips already-captured targets by checking status in sweep plan.
- **Per-target independence:** One failure doesn't block the rest.

## Analysis Fleet

### Fleet Composition

- **Depth B (page):** One Claude agent per section.
- **Depth C (component):** One Claude agent per subsection within the targeted section.

### Each Analysis Scout Receives

- Capture bundle for its target (screenshot, annotated screenshot, element tree, layout measurements, text content).
- Section entry from `peek-manifest.json` (expected behavior context).
- Project framework type (WPF/React/Electron) for source file tracing.
- Access to project source files via Read/Grep.

### Analysis Checklist

- Layout breaks, overflow, clipping, misalignment
- Missing or empty elements (buttons, labels, data)
- Inconsistent styling compared to other sections (can reference other capture bundles for cross-section consistency)
- Accessibility basics — contrast, element sizes, missing labels (from element tree)
- Empty states and error states
- Text truncation, overlapping elements (from layout measurements)

### Findings Output

Each scout writes to: `docs/findings/<YYYY-MM-DD>-visual-sweep-<app>-<section-id>.md`

A rollup agent merges all section findings into: `docs/findings/<YYYY-MM-DD>-visual-sweep-<app>-summary.md`

Summary contains: severity rollup, per-section finding counts, cross-section consistency issues, and unmanifested surface warnings from discovery.

### Future: Codex Analysis Scouts

Currently analysis scouts are Claude agents (guaranteed multimodal). A future expansion could use Codex tasks instead (cheaper, fully parallel) if snapscope produces a text-only capture representation rich enough for non-multimodal analysis. This would require `peek_diagnose` to output: full element tree with bounds, layout measurements as structured data, OCR text with positions, color sampling at key elements, and a text-based spatial map.

## Command Interface

### `/torque-visual-sweep`

```
/torque-visual-sweep <app> [options]
```

**Arguments:**
- `<app>` — project name or process name (e.g., `example-project`, `torque-dashboard`)

**Options:**
- `--depth page|component` — sweep granularity (default: `page`)
- `--section <id>` — sweep only a specific section from the manifest
- `--schedule <time>` — submit as one-time schedule (e.g., `--schedule "11pm"`, `--schedule "2026-04-06T02:00:00"`)

**Examples:**
```
/torque-visual-sweep example-project
/torque-visual-sweep example-project --depth component --section transactions
/torque-visual-sweep torque-dashboard --schedule "11pm"
```

### Execution Modes

- **Immediate:** Spawns discovery agent → capture coordinator → analysis fleet. Reports progress as each phase completes.
- **Scheduled:** Submits via `create_one_time_schedule`. TORQUE fires at the specified time. Findings waiting in `docs/findings/` in the morning.

### Output

Entry point when complete: `docs/findings/<YYYY-MM-DD>-visual-sweep-<app>-summary.md`

## Scope & Non-Goals

- **Single app per sweep.** This is a deep audit, not a broad scan across all apps.
- **User-initiated only.** No recurring cron. The user kicks it off manually or via one-time schedule.
- **Discovery only.** Like all scouts, the sweep finds issues but does not fix them. Feed findings to `/torque-team` for fixes.
- **Omen-hosted projects only.** Targets projects running on the user's workstation with peek_server.