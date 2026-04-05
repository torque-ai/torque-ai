---
name: torque-sweep
description: Full automated sweep — deploy all scouts, auto-triage findings, spawn team to fix actionable issues
argument-hint: "[scope]"
allowed-tools:
  - Agent
  - Read
  - Glob
  - Write
  - Edit
  - Bash
  - AskUserQuestion
  - TeamCreate
  - TaskCreate
  - TaskUpdate
  - TaskList
  - SendMessage
  - mcp__plugin_torque_torque__smart_submit_task
  - mcp__plugin_torque_torque__submit_task
  - mcp__plugin_torque_torque__await_task
  - mcp__plugin_torque_torque__task_info
  - mcp__plugin_torque_torque__get_result
  - mcp__plugin_torque_torque__check_notifications
---

# TORQUE Sweep

Full automated cycle: discover → triage → fix → verify. Deploys all scout variants, auto-triages findings, spawns `/torque-team` to fix actionable issues, and reports deferred items to the user.

## Instructions

### Phase 1: Deploy Scouts

Deploy all 8 scout variants using `/torque-scout` patterns:

**7 Codex scouts** (parallel TORQUE tasks):
- security, quality, performance, dependency, test-coverage, documentation, accessibility

**1 Claude agent** (for peek_ui):
- visual (only if `$ARGUMENTS` includes "visual" or no scope excludes it)

For each Codex scout:
1. Read `.claude/agents/torque-scout.md` (base) + `.claude/agents/scouts/<variant>.md` (variant)
2. Build the scout prompt with scope (from `$ARGUMENTS` or "full project")
3. Submit via `submit_task` with `provider: "codex"`, `auto_route: false`, `version_intent: "internal"`

Track all task IDs.

### Phase 2: Await All Scouts

Use `await_task` on each Codex scout task. For the visual scout (Claude agent), wait for its message.

As each completes, read the findings file from `docs/findings/`.

### Phase 3: Auto-Triage

Read all findings files. Classify each finding:

**Auto-actionable (fix without asking user):**
- CRITICAL severity — always fix
- HIGH severity security findings — always fix
- HIGH severity a11y findings — always fix
- Missing/stale documentation — always fix
- Unused dependencies — always remove
- Sync I/O in hot paths — always convert to async
- Missing test coverage on critical paths — always write tests

**Needs user input (report and wait):**
- Architectural refactors (splitting large functions, changing module boundaries)
- Breaking changes to public APIs
- Design decisions (should this feature exist?)
- Findings the scout explicitly flagged as ambiguous
- LOW severity items in bulk (present as a list, ask which to fix)

**Auto-defer (skip silently):**
- Issues already documented in prior findings files with status ACTIONED or DEFERRED
- Cosmetic/style issues (LOW severity, no functional impact)

### Phase 4: Fix Actionable Items

If there are actionable findings:

1. Compose a work brief from all auto-actionable findings
2. Use `/torque-team` to spawn the development team
3. The team fixes, QC reviews, remediation handles failures
4. Orchestrator commits after integration pass

### Phase 5: Report

Present to the user:

```
## TORQUE Sweep Complete

### Fixed (auto-actionable)
- <count> findings fixed across <batches> batches
- <list of what was fixed, grouped by category>

### Needs Your Input
- <count> findings require human decision
- <list with brief description of each>

### Deferred
- <count> low-priority items deferred
- See docs/findings/ for full details

### Test Status
- <pass count> passed, <fail count> failed
```

### Phase 6: Update Findings Files

Mark auto-actioned findings as `ACTIONED` in their findings files. Mark deferred items as `DEFERRED`. Commit the updated findings files.

## Scope

If `$ARGUMENTS` is provided, use it as the scope for all scouts (e.g., "server/execution/" scopes all 8 scouts to that directory).

If no argument, scope is "full project".

## When NOT to Use

- If you only need one specific variant → use `/torque-scout <variant>` directly
- If you already have findings and just need to fix them → use `/torque-team <findings file>`
- If the project is in a broken state (tests failing) → fix tests first, then sweep
