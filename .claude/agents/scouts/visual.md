# Variant: Visual

## Focus Area

Find UI/UX issues by visually inspecting running applications.

## Additional Tools

This variant uses `peek_ui` and snapscope for visual capture. The base scout tools (Read, Grep, etc.) are still available for reading source files when investigating root causes.

## What to Look For

- **Layout breaks** — elements overflowing containers, clipped text, misaligned columns
- **Visual regressions** — elements that look different from expected (wrong colors, fonts, spacing)
- **Responsive issues** — layout problems at different window sizes
- **Missing elements** — buttons, labels, or sections that should be present but aren't rendered
- **Inconsistent styling** — different spacing, font sizes, or colors for similar elements
- **Accessibility basics** — missing labels, low contrast text, elements too small to click
- **Empty states** — what happens when lists are empty, data is loading, or errors occur

## Workflow Override

Replace step 3 of the base workflow with:
1. List available windows: `peek_ui({ list_windows: true })`
2. Capture each relevant window: `peek_ui({ process: "..." })` or `peek_ui({ title: "..." })`
3. NEVER use full-screen capture (returns black without RDP)
4. Analyze each capture against the expected UI
5. Read source files (React/HTML/CSS/XAML) to identify the likely cause of visual issues

## Findings Format Override

Use these fields instead of the base `File:` field:
```
- **Window:** <process or title captured>
- **Expected:** What it should look like
- **Actual:** What was observed
- **Evidence:** Specific description of the visual issue
- **Source file:** path/to/component.tsx:line (if identified)
```

## Peek Server Recovery

If peek_server is down, try starting it via the remote workstation's scheduled task. If that fails, message the team lead.

## Severity Guide

- CRITICAL: App crash, blank page, data not displayed
- HIGH: Major layout break, unusable UI element, wrong data shown
- MEDIUM: Misalignment, inconsistent styling, minor layout issue
- LOW: Cosmetic imperfection, spacing nitpick
