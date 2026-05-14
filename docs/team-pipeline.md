# TORQUE Team Pipeline

Detail reference for the team pipeline spawned by `/torque-team <work brief>`. The high-level topology and orchestrator responsibilities live in `CLAUDE.md` "TORQUE Team Pipeline"; this doc covers the internal protocols.

## Streaming Protocol

- The **Planner** sends task IDs to **QC** as tasks are submitted, not in a batch at the end.
- QC awaits each task individually, reviews it immediately on completion, and routes verdicts without batching. This keeps QC's queue depth bounded and surfaces failures within minutes rather than at the end of a long run.

## Metadata Contract

Every task carries a `ui_review` boolean in metadata that determines whether the **UI Reviewer** agent runs on the output:

- **`ui_review: true`** — tasks that modify frontend, dashboard, or XAML surfaces. The UI Reviewer is spawned conditionally on these and runs `peek_ui` / `peek_diagnose` against the changed surface.
- **`ui_review: false`** — code-only tasks. UI Reviewer is skipped.

Mark this on the task submission, not at QC time. QC reads the flag when deciding whether to dispatch to the UI Reviewer after approval.

## QC Dual-Pass Testing

QC runs two verification passes:

1. **Per-task pass** — targeted verification as each task completes (the touched files' tests).
2. **Integration pass** — full-suite or integration verification after all tasks pass individually.

Integration failures go back to **Remediation** with the combined context (which task touched which files, which integration test failed, and the verifier's error output). Remediation then submits a fix task and the pipeline re-enters QC.

## Discovery Phase

When work isn't yet well-defined, the pipeline runs discovery before execution:

1. Use `/torque-scout <variant>` to run targeted scouts. Variants: `security`, `quality`, `visual`, `performance`, `dependency`, `test-coverage`, `documentation`, `accessibility`.
2. Read the findings file in `docs/findings/`.
3. Triage findings with the user and mark them actionable or deferred.
4. Feed the actionable items into `/torque-team`.

Use `/torque-sweep` when you want the full scout set, automatic triage, and an immediate team handoff for actionable findings — that's discovery + execution in one command.

## Agent Profiles

The pipeline's agent contracts live in `.claude/agents/torque-{planner,qc,remediation,ui-reviewer}.md`. Each agent's prompt template, output schema, and triggering conditions are documented there.

## Related

- `/torque-team` slash command: `.claude/commands/torque-team.md`
- `/torque-sweep` slash command: `.claude/commands/torque-sweep.md`
- Scout variants: `.claude/agents/scouts/{security,quality,visual,performance,dependency,test-coverage,documentation,accessibility}.md`
