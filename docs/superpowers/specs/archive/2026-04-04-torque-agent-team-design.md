# TORQUE Agent Team Design

**Date:** 2026-04-04
**Status:** Approved
**Scope:** Global — applies to all projects using TORQUE

## Problem

Claude Code can orchestrate TORQUE tasks, but the workflow is ad-hoc: bespoke agent prompts each session, manual ID forwarding between agents, no persistent discovery artifacts, and no standardized pipeline. This wastes context tokens on prompt engineering and requires the user to re-describe the process every time.

## Solution

Define a reusable agent team with self-wired pipeline topology, a one-shot slash command for spawning, and a two-phase workflow (discovery + execution) that works across all TORQUE-enabled projects.

## Design Principles

- **Stream per-task, never batch** — every handoff between agents happens per-task as it completes, not after an entire batch finishes.
- **Git is the source of truth** — scout findings are committed files, changelogs are auto-generated from conventional commits, ephemeral messages are not a persistence layer.
- **Agents are self-wired** — each agent definition encodes its upstream/downstream neighbors. No central routing config needed.
- **Lean roster** — 7 agents with clear responsibilities. Add roles only when practice reveals a real gap.
- **On-demand spawning** — UI Reviewer and Scouts are only spawned when relevant, not permanently running.

## Agents

### Shared Protocol

Every TORQUE team agent shares these conventions, encoded in each agent's definition file:

- **Streaming** — notify downstream per-task, never wait for a full batch.
- **Metadata contract** — all TORQUE tasks carry `ui_review: true/false` in metadata, set by Planner at submission time.
- **Team discovery** — agents read `~/.claude/teams/{team-name}/config.json` to find teammates by name.
- **Task list as shared state** — the team's TaskList is the source of truth for progress tracking.
- **Failure escalation** — any agent that cannot proceed messages the Orchestrator; never silently stall.
- **TORQUE tool usage** — agents use MCP tools directly (`submit_task`, `await_task`, `get_result`, etc.), not slash commands.

### 1. Orchestrator (Primary Session)

Not a spawned agent — the primary Claude Code session. Encoded in global `CLAUDE.md`.

**Responsibilities:**
- Receives orders from the user and translates them into work briefs for the Planner.
- Spawns the team via `/torque-team` slash command.
- Triages scout findings with user input: actionable items go to Planner, ambiguous items are discussed with user, deferred items stay in findings file.
- Receives success reports from QC (and UI Reviewer when applicable).
- Commits completed work using conventional commit messages with `version_intent`.
- Updates CLAUDE.md/README when the completed work changes project conventions or setup.
- Changelog updates are handled by TORQUE's auto-release pipeline via conventional commit prefixes, not manual edits.
- Runs final integration verification before committing if QC's integration pass was skipped.

**Upstream:** User, QC (success reports), UI Reviewer (success reports), Scouts (findings notifications).
**Downstream:** Planner (work briefs), Scouts (exploration requests).

### 2. Planner (`~/.claude/agents/torque-planner.md`)

**Role:** Reads codebase, writes precise TORQUE task descriptions, submits tasks, streams IDs to Queue Manager.

**Upstream:** Orchestrator sends a work brief (what to build/fix, relevant findings, scope).
**Downstream:** Streams each submitted task ID + metadata to `queue-mgr` via SendMessage.

**TORQUE tools:** `smart_submit_task`, `create_workflow`, `add_workflow_task`, `run_workflow`, `scan_project`, `get_project_defaults`.

**Key behaviors:**
- Reads source files to get exact line numbers before writing any task description.
- Follows Ollama authoring rules for files >300 lines (search -> read range -> replace_lines).
- Sets `ui_review: true` in task metadata when the task modifies frontend/dashboard/XAML files.
- Sends each task ID to Queue Manager immediately after submission.
- Groups related tasks into workflows when they have dependencies; submits independent tasks standalone.
- Ends every task description with "After making the edits, stop."
- Includes `version_intent` on tasks for versioned projects.

### 3. Queue Manager (`~/.claude/agents/torque-queue-mgr.md`)

**Role:** Awaits TORQUE task completions, verifies basic success, streams results to QC.

**Upstream:** Planner streams task/workflow IDs as they are submitted.
**Downstream:** Streams each completed task to `qc` via SendMessage (includes task ID, status, provider, duration, conflict warnings).

**TORQUE tools:** `await_task`, `await_workflow`, `task_info`, `get_result`, `check_notifications`, `detect_file_conflicts`.

**Key behaviors:**
- Starts awaiting each task/workflow as soon as the Planner sends the ID.
- Uses `await_task`/`await_workflow` with heartbeats; never polls `check_status`.
- On heartbeat: reports progress to Orchestrator, re-invokes await.
- Runs `detect_file_conflicts` on completed workflows before sending to QC.
- Includes conflict warnings in the message to QC when detected.
- If a task fails at the TORQUE level (exit code != 0, timeout, provider error): still sends to QC with failure context so QC can route to Remediation.

### 4. QC (`~/.claude/agents/torque-qc.md`)

**Role:** Reviews code quality of completed tasks, runs tests, routes results based on outcome and metadata.

**Upstream:** Queue Manager streams completed tasks one at a time.
**Downstream:** Three paths:
- Code-only success -> report to Orchestrator.
- `ui_review: true` success -> send to `ui-reviewer`.
- Any failure -> send to `remediation` with failure details.

**TORQUE tools:** `task_info`, `get_result`.
**Other tools:** Read, Grep, Bash (`torque-remote` for test execution).

**Dual-pass testing:**
- **Per-task pass:** As each task streams in from Queue Manager, review the diff, read modified files on disk, run targeted tests. Stream verdict immediately (APPROVED or REJECTED with reason).
- **Integration pass:** After ALL tasks in the batch are approved individually, run the full verify command + full test suite via `torque-remote`. This catches cross-task regressions that per-task testing misses. Integration failures route to Remediation with combined context ("tasks A, B, C each passed individually but together they break X").

**Key behaviors:**
- Reads actual modified files on disk, not just task output diffs.
- Validates each fix against the original task description.
- Checks for: stub implementations, incomplete fixes, regressions, unnecessary changes, missing error handling.
- Checks `ui_review` metadata tag to decide routing.
- Sends structured verdicts: APPROVED (with summary) or REJECTED (with specific failure reason).

### 5. UI Reviewer (`~/.claude/agents/torque-ui-reviewer.md`)

**Role:** Visually verifies UI changes using peek_ui and snapscope.

**Upstream:** QC sends tasks that passed code review and have `ui_review: true`.
**Downstream:** Report to Orchestrator (success) or `remediation` (visual issues found).

**Tools:** `peek_ui`, snapscope MCP tools (visual diff, compliance), Read.

**Key behaviors:**
- Captures the relevant application window via `peek_ui({ process: "..." })` or `peek_ui({ title: "..." })`.
- Compares against expected layout/behavior described in the task.
- Checks for: visual regressions, layout breaks, missing elements, incorrect styling.
- Only spawned when there are UI-touching tasks in the batch.
- Reports APPROVED or REJECTED with screenshot evidence.

### 6. Remediation (`~/.claude/agents/torque-remediation.md`)

**Role:** Diagnoses failures, fixes small issues directly, resubmits larger ones as new TORQUE tasks.

**Upstream:** QC or UI Reviewer sends failed tasks with rejection reason.
**Downstream:** After fixing, sends the task back to `qc` for re-review. Never routes directly to Orchestrator.

**TORQUE tools:** `smart_submit_task`, `await_task`, `task_info`, `get_result`.
**Other tools:** Read, Edit, Write, Grep, Bash.

**Key behaviors:**
- Reads the rejection reason and the task output to diagnose root cause.
- **Small fixes** (typos, missing imports, off-by-one, lint issues): fixes directly with Edit/Write, then notifies QC.
- **Larger fixes** (wrong approach, missing logic, structural issues): writes a new TORQUE task description with the error context included, submits via `smart_submit_task`, awaits completion, then notifies QC.
- Always includes the original error/rejection in resubmitted task descriptions so the provider has context.
- Tracks retry count — if a task fails remediation twice, escalates to Orchestrator instead of looping.
- Never routes directly to Orchestrator — all fixes go through QC.

### 7a. Code Scout (`~/.claude/agents/torque-code-scout.md`)

**Role:** Explores codebase to discover issues. On-demand, not permanent.

**Upstream:** Orchestrator requests a scan with scope/focus area.
**Downstream:** Writes findings to `docs/findings/<date>-<scan-name>.md`, notifies Orchestrator.

**Tools:** Read, Grep, Glob, Bash, `scan_project`.
**Agent type:** `Explore` or `general-purpose`.

**Key behaviors:**
- Writes structured findings with severity, file paths, line numbers, and descriptions.
- Commits findings file to git before notifying Orchestrator.
- Does not fix anything — discovery only.
- Can be scoped by the Orchestrator: "scan server/execution/ for error handling issues" or "full security audit."

### 7b. Visual Scout (`~/.claude/agents/torque-visual-scout.md`)

**Role:** Discovers UI/UX issues by visually inspecting running applications. On-demand, not permanent.

**Upstream:** Orchestrator requests a visual scan.
**Downstream:** Writes findings to `docs/findings/<date>-<scan-name>.md` (with screenshot references), notifies Orchestrator.

**Tools:** `peek_ui`, snapscope MCP tools, Read.

**Key behaviors:**
- Captures application windows and analyzes layout, consistency, accessibility.
- Writes structured findings with screenshot evidence.
- Commits findings file to git before notifying Orchestrator.
- Does not fix anything — discovery only.

## Findings Persistence

Scout findings are persisted as committed markdown files, not ephemeral messages.

**Location:** `docs/findings/<YYYY-MM-DD>-<scan-name>.md`

**Format:**
```markdown
# <Scan Name>
Date: YYYY-MM-DD
Scope: <what was scanned>
Agent: code-scout | visual-scout

## Findings

### [SEVERITY] Finding title
- **File:** path/to/file.ext:line
- **Description:** What the issue is
- **Status:** NEW | ACTIONED | DEFERRED
- **Evidence:** (for visual scout: screenshot path or description)
```

**Lifecycle:**
1. Scout writes file with all findings marked `NEW`.
2. Scout commits the file to git.
3. Orchestrator reads file, triages with user.
4. Orchestrator updates status to `ACTIONED` (sent to Planner) or `DEFERRED` (skip for now).
5. Future scans can check existing findings to avoid duplicates.

## Integration

### Slash Command: `/torque-team`

**Location:** `~/.claude/commands/torque-team.md`

**Behavior:**
1. Creates a team via `TeamCreate`.
2. Spawns permanent agents: Planner, Queue Manager, QC, Remediation.
3. Conditionally spawns UI Reviewer if the work brief mentions UI/frontend/dashboard/XAML.
4. Does NOT spawn Scouts — those are invoked separately by the Orchestrator when discovery is needed.
5. Creates tasks in the team's task list based on the work brief.
6. Sets up task dependencies (planner tasks -> queue-mgr -> qc -> orchestrator).

**Usage:**
```
/torque-team <work brief or findings file path>
```

**Variants (future, not in initial implementation):**
- `/torque-team discover` — spawns Scouts only, no execution pipeline.
- `/torque-team review` — spawns Scouts + full pipeline, discovery feeds execution.

**Scout spawning (initial implementation):** The Orchestrator spawns Code Scout and Visual Scout directly via the Agent tool when discovery is needed. The `/torque-team discover` variant is a future convenience shortcut.

### Global CLAUDE.md Additions

Add a "TORQUE Team Pipeline" section to global CLAUDE.md that encodes:
- The pipeline topology diagram.
- The Orchestrator's responsibilities (triage, conventional commits, doc updates).
- The streaming protocol (per-task, not batched).
- The metadata contract (`ui_review` tag).
- When to spawn UI Reviewer vs skip.
- When to spawn Scouts vs go straight to planning.
- The findings file convention.

This ensures the primary session always knows the pipeline without reading all 7 agent files.

## Pipeline Flow

### Phase 1: Discovery (on-demand)

```
Orchestrator spawns Code Scout and/or Visual Scout
  -> Scouts write docs/findings/<date>-<scan>.md, commit to git
  -> Scouts notify Orchestrator "findings ready, N issues found"
  -> Orchestrator reads findings, triages with user
  -> Actionable items: Orchestrator writes work brief for Planner
  -> Deferred items: stay in findings file marked DEFERRED
```

### Phase 2: Execution

```
Orchestrator -> /torque-team <work brief>
  -> Planner reads code, writes tasks, submits to TORQUE
     -> streams each task ID to Queue Manager
  -> Queue Manager awaits each task
     -> streams each completion to QC
  -> QC per-task review + targeted tests
     -> APPROVED: check ui_review tag
        -> ui_review=true: send to UI Reviewer
        -> ui_review=false: report to Orchestrator
     -> REJECTED: send to Remediation with reason
  -> (after all per-task approvals)
  -> QC integration pass: full test suite
     -> pass: report to Orchestrator
     -> fail: send to Remediation with cross-task context
  -> UI Reviewer (if spawned): visual verification
     -> pass: report to Orchestrator
     -> fail: send to Remediation
  -> Remediation: fix directly or resubmit
     -> small fix: Edit/Write, notify QC
     -> large fix: submit new TORQUE task, await, notify QC
     -> 2 retries exhausted: escalate to Orchestrator
  -> Orchestrator: conventional commits + version_intent
     -> TORQUE auto-release handles changelog
     -> Update CLAUDE.md/README if conventions changed
```

## File Manifest

| File | Location | Purpose |
|------|----------|---------|
| `torque-planner.md` | `~/.claude/agents/` | Planner agent definition |
| `torque-queue-mgr.md` | `~/.claude/agents/` | Queue Manager agent definition |
| `torque-qc.md` | `~/.claude/agents/` | QC agent definition |
| `torque-ui-reviewer.md` | `~/.claude/agents/` | UI Reviewer agent definition |
| `torque-remediation.md` | `~/.claude/agents/` | Remediation agent definition |
| `torque-code-scout.md` | `~/.claude/agents/` | Code Scout agent definition |
| `torque-visual-scout.md` | `~/.claude/agents/` | Visual Scout agent definition |
| `torque-team.md` | `~/.claude/commands/` | Slash command for one-shot team spawning |
| Global CLAUDE.md | `~/.claude/CLAUDE.md` | Pipeline overview for Orchestrator |
| Findings files | `docs/findings/` | Persisted scout discoveries |

## Implementation Order

1. Write the 7 agent definition files.
2. Write the `/torque-team` slash command.
3. Add pipeline section to global CLAUDE.md.
4. Test with a real task batch (use the remaining review findings or a small feature).
5. Iterate on agent prompts based on what works and what doesn't.

## Design Decisions Log

| Decision | Rationale |
|----------|-----------|
| Self-wired agents (hybrid with slash command) | Agents are resilient to restarts; slash command provides convenience. Avoids central routing config. |
| Stream per-task, not batch | Eliminates idle bottlenecks. Learned from mid-session correction in the review-fixes team run. |
| Planner does its own research (no separate Scout in pipeline) | Avoids "architecture tax" of context transfer between Scout and Planner. Scout role exists only for on-demand discovery. |
| Findings persisted to git, not messages | Git is the source of truth. Findings survive sessions, are reviewable, searchable, diff-able. |
| Changelog via auto-release, not manual | Conventional commits feed TORQUE's versioning pipeline. Manual changelog edits drift. |
| `ui_review` metadata tag set by Planner | Planner has context to decide at submission time. QC checks the tag instead of guessing from file paths. |
| QC dual-pass testing | Per-task tests give fast feedback. Integration pass catches cross-task regressions. Both are necessary. |
| Remediation escalates after 2 retries | Prevents infinite loops. Orchestrator (with user access) can make judgment calls on persistent failures. |
| UI Reviewer spawned conditionally | Code-only batches don't need visual verification. Saves context and cost. |
