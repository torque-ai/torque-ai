---
name: torque-team
description: Spawn a TORQUE development team — Planner, Queue Manager, QC, Remediation, and optionally UI Reviewer
argument-hint: "<work brief or findings file path>"
allowed-tools:
  - Agent
  - TeamCreate
  - TaskCreate
  - TaskUpdate
  - TaskList
  - SendMessage
  - Read
  - Glob
  - AskUserQuestion
---

# TORQUE Team

Spawn a coordinated development team of background agents that plan, submit, monitor, QC, and remediate TORQUE tasks.

## Instructions

### 1. Parse the work brief

- If `$ARGUMENTS` ends in `.md`, read the file at that path to get the work brief text.
- If `$ARGUMENTS` is provided but is not a `.md` path, use it directly as the work brief.
- If no argument is provided, ask the user via AskUserQuestion: "What work should the team tackle? Provide a description or path to a findings file."

Store the resulting text as `work_brief`.

### 2. Detect UI work

Scan `work_brief` (case-insensitive) for any of these keywords:
`dashboard`, `frontend`, `UI`, `UX`, `layout`, `CSS`, `XAML`, `WPF`, `React`, `component`, `visual`, `render`, `peek`, `screenshot`

Set `spawn_ui_reviewer = true` if any keyword is found. Otherwise `spawn_ui_reviewer = false`.

### 3. Create the team

Call:
```
TeamCreate({
  team_name: "torque-dev",
  description: "<one-line summary of the work brief>"
})
```

### 4. Create team tasks

Create tasks that map to the pipeline stages:

1. `TaskCreate({ team_name: "torque-dev", title: "Plan and submit TORQUE tasks", description: "Read relevant source files, decompose the work brief into TORQUE tasks, write structured task descriptions, and submit them via smart_submit_task. Stream each task ID to queue-mgr as you submit.", assignee: "planner" })`

2. `TaskCreate({ team_name: "torque-dev", title: "Monitor task completions", description: "Watch for TORQUE task completions via check_notifications. As each task completes, forward the task ID and result summary to qc for review. Report stalls or failures to remediation.", assignee: "queue-mgr", blocked_by: [task_1_id] })`

3. `TaskCreate({ team_name: "torque-dev", title: "QC review completed tasks", description: "Review each completed task output for quality: check for stubs, truncation, missing error handling, unused imports, hallucinated APIs. Approve clean results. Send failures to remediation with diagnosis.", assignee: "qc" })`

4. `TaskCreate({ team_name: "torque-dev", title: "Remediate failures", description: "Receive failed or rejected tasks from QC. Diagnose root cause, write targeted fix task descriptions, and resubmit to TORQUE. Notify queue-mgr of resubmitted task IDs.", assignee: "remediation" })`

5. If `spawn_ui_reviewer`: `TaskCreate({ team_name: "torque-dev", title: "UI review visual changes", description: "After code tasks that touch UI are complete and approved by QC, use peek_ui to capture screenshots and verify visual correctness. Report layout issues, rendering bugs, or style regressions to remediation.", assignee: "ui-reviewer" })`

### 5. Spawn agents

For each agent to spawn, read its definition file and build the prompt:

- Read `~/.claude/agents/torque-planner.md`
- Read `~/.claude/agents/torque-queue-mgr.md`
- Read `~/.claude/agents/torque-qc.md`
- Read `~/.claude/agents/torque-remediation.md`
- If `spawn_ui_reviewer`: Read `~/.claude/agents/torque-ui-reviewer.md`

For each file, extract the markdown body (everything after the closing `---` of the YAML frontmatter). Build the agent prompt as:

```
## Work Brief
<work_brief>

## Your Role
<agent definition markdown body>
```

Spawn all agents **in parallel** (all with `run_in_background: true`):

- `Agent({ name: "planner", team_name: "torque-dev", prompt: <built prompt>, mode: "auto", run_in_background: true, model: "opus" })`
- `Agent({ name: "queue-mgr", team_name: "torque-dev", prompt: <built prompt>, mode: "auto", run_in_background: true, model: "sonnet" })`
- `Agent({ name: "qc", team_name: "torque-dev", prompt: <built prompt>, mode: "auto", run_in_background: true, model: "opus" })`
- `Agent({ name: "remediation", team_name: "torque-dev", prompt: <built prompt>, mode: "auto", run_in_background: true, model: "opus" })`
- If `spawn_ui_reviewer`: `Agent({ name: "ui-reviewer", team_name: "torque-dev", prompt: <built prompt>, mode: "auto", run_in_background: true, model: "opus" })`

### 6. Verify planner received the brief

The work brief is already embedded in the planner's spawn prompt (Step 5). Do NOT send a duplicate via SendMessage — the planner will start working immediately from its prompt context. If the planner goes idle without starting work, then send a nudge:

```
SendMessage({
  to: "planner",
  message: "You have a work brief in your prompt. Please begin reading source files and submitting TORQUE tasks. Stream each task ID to queue-mgr as you submit."
})
```

### 7. Report to user

Present a summary:

```
TORQUE Dev Team spawned for: <one-line work brief summary>

Agents:
  - planner (opus)      — Plans and submits TORQUE tasks
  - queue-mgr (sonnet)  — Monitors completions, routes to QC
  - qc (opus)           — Reviews task output quality
  - remediation (opus)  — Fixes failures, resubmits
  [- ui-reviewer (opus) — Visual verification via peek_ui]  ← only if spawned

The planner has received the work brief and is beginning task decomposition.
Use /torque-status to monitor TORQUE task progress.
Use TaskList to see team task status.
```

Show `ui-reviewer` line only if `spawn_ui_reviewer` is true.
