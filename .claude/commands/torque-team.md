---
name: torque-team
description: Spawn a TORQUE development team — Planner, QC, Remediation, and optionally UI Reviewer
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

Spawn a coordinated development team of background agents that plan, submit, QC, and remediate TORQUE tasks.

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

1. `TaskCreate({ subject: "Plan and submit TORQUE tasks", description: "Read relevant source files, decompose the work brief into TORQUE tasks, write structured task descriptions, and submit them via smart_submit_task. Stream each task ID to qc as you submit." })`

2. `TaskCreate({ subject: "QC: await, review, and test completed tasks", description: "Await TORQUE task completions, review each for quality (stubs, truncation, missing error handling, regressions). Run targeted tests. Route approvals to team lead, rejections to remediation. Auto-trigger integration pass after all approved." })`

3. `TaskCreate({ subject: "Remediate failures", description: "Receive rejected tasks from QC. Diagnose root cause, fix directly or resubmit to TORQUE. Route fixes back to QC for re-review." })`

4. If `spawn_ui_reviewer`: `TaskCreate({ subject: "UI review visual changes", description: "After code tasks that touch UI are approved by QC, use peek_ui to capture screenshots and verify visual correctness. Report issues to remediation." })`

Set task 2 blocked by task 1.

### 5. Spawn agents

For each agent to spawn, read its definition file. Try project-local first, fall back to global. **If neither exists, STOP and report the error to the user — do not spawn with an empty prompt.**

- Read `.claude/agents/torque-planner.md` (project) or `~/.claude/agents/torque-planner.md` (global)
- Read `.claude/agents/torque-qc.md` (project) or `~/.claude/agents/torque-qc.md` (global)
- Read `.claude/agents/torque-remediation.md` (project) or `~/.claude/agents/torque-remediation.md` (global)
- If `spawn_ui_reviewer`: Read `.claude/agents/torque-ui-reviewer.md` (project) or `~/.claude/agents/torque-ui-reviewer.md` (global)

If any required agent file is missing from both locations, report: "Missing agent definition: <name>. Run: cp .claude/agents/* ~/.claude/agents/ to bootstrap from repo."

For each file, extract the markdown body (everything after the closing `---` of the YAML frontmatter). Build the agent prompt as:

```
## Work Brief
<work_brief>

## Your Role
<agent definition markdown body>
```

Spawn all agents **in parallel** (all with `run_in_background: true`):

- `Agent({ name: "planner", team_name: "torque-dev", prompt: <built prompt>, mode: "auto", run_in_background: true, model: "opus" })`
- `Agent({ name: "qc", team_name: "torque-dev", prompt: <built prompt>, mode: "auto", run_in_background: true, model: "opus" })`
- `Agent({ name: "remediation", team_name: "torque-dev", prompt: <built prompt>, mode: "auto", run_in_background: true, model: "opus" })`
- If `spawn_ui_reviewer`: `Agent({ name: "ui-reviewer", team_name: "torque-dev", prompt: <built prompt>, mode: "auto", run_in_background: true, model: "opus" })`

### 6. Verify planner received the brief

The work brief is already embedded in the planner's spawn prompt (Step 5). Do NOT send a duplicate via SendMessage. If the planner goes idle without starting work, then send a nudge:

```
SendMessage({
  to: "planner",
  message: "You have a work brief in your prompt. Please begin reading source files and submitting TORQUE tasks. Stream each task ID to qc as you submit."
})
```

### 7. Report to user

Present a summary:

```
TORQUE Dev Team spawned for: <one-line work brief summary>

Agents:
  - planner (opus)      — Plans and submits TORQUE tasks
  - qc (opus)           — Awaits completions, reviews quality, runs tests
  - remediation (opus)  — Fixes failures, resubmits
  [- ui-reviewer (opus) — Visual verification via peek_ui]  ← only if spawned

The planner has received the work brief and is beginning task decomposition.
Use /torque-status to monitor TORQUE task progress.
Use TaskList to see team task status.
```

Show `ui-reviewer` line only if `spawn_ui_reviewer` is true.
