---
name: torque-scout
description: Deploy scouts to discover issues — runs via Codex (visual variant uses Claude agent for peek_ui)
argument-hint: "<variant> [scope]"
allowed-tools:
  - Agent
  - Read
  - Glob
  - AskUserQuestion
  - mcp__plugin_torque_torque__smart_submit_task
  - mcp__plugin_torque_torque__submit_task
---

# TORQUE Scout

Deploy scout agents to discover issues in the codebase. Most variants run as Codex tasks (fast, parallel, no Claude API quota). The `visual` variant runs as a Claude agent (needs peek_ui).

## Available Variants

| Variant | Focus | Execution |
|---------|-------|-----------|
| `security` | Injection, auth bypass, path traversal, SSRF, secrets | Codex |
| `quality` | DI consistency, dead code, complexity, patterns | Codex |
| `performance` | Sync I/O, N+1 queries, memory leaks, missing indexes | Codex |
| `dependency` | Outdated packages, CVEs, deprecated APIs, licenses | Codex |
| `test-coverage` | Untested modules, test quality, missing edge cases | Codex |
| `documentation` | Stale docs, undocumented APIs, broken references | Codex |
| `accessibility` | WCAG compliance, keyboard nav, semantic HTML | Codex |
| `visual` | UI layout, rendering, visual regressions via peek_ui | Claude Agent |

## Instructions

### 1. Parse arguments

Split `$ARGUMENTS` into:
- First word(s) = variant(s) — comma or "and" separated
- Remaining text after variants = scope (optional)

If no argument, show the variant table and ask via AskUserQuestion.
If variant not recognized, show the table and ask.

### 2. Read agent files

For each variant, read two files and concatenate:
1. Base: `.claude/agents/torque-scout.md` (project) or `~/.claude/agents/torque-scout.md` (global) — extract markdown body (after frontmatter `---`)
2. Variant: `.claude/agents/scouts/<variant>.md` (project) or `~/.claude/agents/scouts/<variant>.md` (global) — read full file

Build the scout prompt:
```
## Scan Request
Variant: <variant>
Scope: <scope or "full project">
Working directory: <current project directory>

IMPORTANT: Check docs/findings/ for prior scan results. Skip any issue already documented.
Write findings to docs/findings/<YYYY-MM-DD>-<variant>-scan.md using the format in the base protocol.
After writing the findings file, stop. Do NOT fix anything.

## Base Protocol
<base scout markdown body>

## Variant Focus
<variant file contents>
```

### 3. Deploy each scout

**For `visual` variant — Claude Agent:**
```
Agent({
  name: "scout-visual",
  prompt: <built prompt>,
  mode: "auto",
  model: "opus",
  run_in_background: true
})
```

**For all other variants — Codex task:**
```
submit_task({
  task: <built prompt>,
  provider: "codex",
  auto_route: false,
  working_directory: <current project directory>,
  version_intent: "internal"
})
```

Submit multiple Codex scouts in parallel — they don't conflict (each writes a uniquely-named findings file).

### 4. Report to user

```
Scouts deployed:
  - <variant>: <Codex task ID or "Claude agent">
  - ...

Codex scouts will write findings to docs/findings/.
Use /torque-status to monitor progress.
Use await_task on each ID for completion notification.
```

### 5. Multiple scouts

If the user passes multiple variants (comma or "and" separated), deploy each independently:
- Codex variants: submit all as parallel TORQUE tasks
- Visual variant: spawn as Claude agent
- Mix of both: do both in parallel
