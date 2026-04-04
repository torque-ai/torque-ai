---
name: torque-scout
description: Spawn a scout agent to discover issues — security, quality, visual, performance, dependency, test-coverage, documentation, or accessibility
argument-hint: "<variant> [scope]"
allowed-tools:
  - Agent
  - Read
  - Glob
  - AskUserQuestion
---

# TORQUE Scout

Spawn a scout agent with a specific focus area variant.

## Available Variants

| Variant | Focus |
|---------|-------|
| `security` | Injection, auth bypass, path traversal, SSRF, secrets |
| `quality` | DI consistency, dead code, complexity, patterns |
| `visual` | UI layout, rendering, accessibility via peek_ui |
| `performance` | Sync I/O, N+1 queries, memory leaks, missing indexes |
| `dependency` | Outdated packages, CVEs, deprecated APIs, licenses |
| `test-coverage` | Untested modules, test quality, missing edge cases |
| `documentation` | Stale docs, undocumented APIs, broken references |
| `accessibility` | WCAG compliance, keyboard nav, color contrast |

## Instructions

### 1. Parse arguments

Split `$ARGUMENTS` into:
- First word = `variant` (required)
- Remaining text = `scope` (optional — e.g., "server/execution/", "dashboard components", "the auth plugin")

If no argument, show the variant table above and ask via AskUserQuestion: "Which variant? Optionally add a scope."

If the variant isn't recognized, show the table and ask the user to pick one.

### 2. Read agent files

Read two files and concatenate them:
1. Base: `~/.claude/agents/torque-scout.md` — extract markdown body (after frontmatter `---`)
2. Variant: `~/.claude/agents/scouts/<variant>.md` — read the full file

Build the prompt:
```
## Scan Request
Variant: <variant>
Scope: <scope or "full project">
Working directory: <current project directory>

## Base Protocol
<base scout markdown body>

## Variant Focus
<variant file contents>
```

### 3. Spawn the scout

```
Agent({
  name: "scout-<variant>",
  prompt: <built prompt>,
  mode: "auto",
  model: "opus",
  run_in_background: true
})
```

### 4. Report to user

```
Scout deployed: <variant>
Scope: <scope or "full project">
Findings will be written to docs/findings/ and committed to git.
```

### 5. Multiple scouts

If the user passes multiple variants separated by commas or "and" (e.g., "security, quality" or "security and performance"), spawn each as a separate scout agent in parallel. Each gets its own name (`scout-security`, `scout-quality`, etc.).
