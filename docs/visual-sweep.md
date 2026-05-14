# Visual Sweep

Deep visual audit for a single application. Runs on-demand via `/torque-visual-sweep`, or as a one-time scheduled task.

## Usage

    /torque-visual-sweep <app>                                        # sweep all pages
    /torque-visual-sweep <app> --depth component --section dashboard  # deep dive one section
    /torque-visual-sweep <app> --schedule "11pm"                      # schedule for later

## Peek Manifest

Each project with UI declares its visual surfaces in `peek-manifest.json` at the project root. New visual surfaces are enforced by:

- **Pre-commit hook** — blocks commits with unregistered surfaces (`server/hooks/manifest-enforcement.js`)
- **TORQUE post-task hook** — flags unregistered surfaces after task completion (`server/hooks/post-tool-hooks.js`)

The manifest pattern matcher lives in `server/hooks/manifest-patterns.js`.

## Three Phases

1. **Discovery** — reads the manifest, validates entries against the live UI, detects unmanifested surfaces.
2. **Capture** — navigates to each section sequentially, captures via `peek_diagnose`.
3. **Analysis** — fleet of parallel Claude agents, one per section, writes per-section findings.

## Output

Findings are written to `docs/findings/<date>-visual-sweep-<app>-summary.md`. The summary file links to the per-section findings produced by the analysis fleet.

## Related

- `/torque-visual-sweep` slash command: `.claude/commands/torque-visual-sweep.md`
- `peek_ui` / `peek_diagnose` tools: provided by the `snapscope` plugin
- Visual sweep agents: `.claude/agents/visual-sweep-{discovery,capture,analyzer,rollup}.md`
