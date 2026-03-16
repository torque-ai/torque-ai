# TORQUE Claude Code Plugin — Packaging Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package TORQUE as a Claude Code plugin so users can install it with one command (`/plugin install torque`) instead of manually configuring `.mcp.json`. Distribute via self-hosted marketplace (immediate) and official Anthropic marketplace (after review).

**Architecture:** Wrap existing TORQUE codebase in Claude Code plugin format — plugin.json manifest, skills (from existing slash commands), MCP server config using `${CLAUDE_PLUGIN_ROOT}`, and marketplace.json for distribution. No code changes to the server itself.

**Tech Stack:** Claude Code plugin system, JSON manifests, markdown skills, npm packaging.

---

## Progress (Updated 2026-03-16)

| Task | Status | Commit |
|------|--------|--------|
| Task 1: Create plugin.json manifest | DONE | `32e8fca` |
| Task 2: MCP server config (Option B, inline) | DONE | `32e8fca` |
| Task 3: Convert 8 commands to skills | DONE (verify skills discovery remaining) | `32e8fca` |
| Task 4: Update README | DONE | `32e8fca` |
| Task 5: Create marketplace.json | DONE (validate remaining) | `32e8fca` |
| Task 6: Test full plugin install flow | TODO | — |
| Task 7: Submit to official Anthropic marketplace | TODO | — |
| Task 8: Publish npm package (optional) | TODO | — |

### Remaining Work (requires user action)
1. **Validate marketplace** — run `claude plugin validate .` or `/plugin validate .`
2. **Test local plugin loading** — `claude --plugin-dir .` to verify skills + MCP server
3. **Test marketplace install** — push to GitHub, then `/plugin marketplace add torque-ai/torque-ai`
4. **Submit to official marketplace** — web form at `claude.ai/settings/plugins/submit`
5. **npm publish** (optional) — requires `@torque-ai` npm org access

---

## File Structure

### New Files (plugin packaging layer)

| File | Responsibility |
|------|---------------|
| `.claude-plugin/plugin.json` | Plugin manifest — name, version, description, MCP server config |
| `.claude-plugin/marketplace.json` | Self-hosted marketplace catalog for the repo |
| `skills/torque-submit/SKILL.md` | Submit task skill (from commands/torque-submit.md) |
| `skills/torque-status/SKILL.md` | Status overview skill |
| `skills/torque-review/SKILL.md` | Review task output skill |
| `skills/torque-workflow/SKILL.md` | Workflow management skill |
| `skills/torque-budget/SKILL.md` | Budget tracking skill |
| `skills/torque-config/SKILL.md` | Configuration skill |
| `skills/torque-cancel/SKILL.md` | Cancel task skill |
| `skills/torque-restart/SKILL.md` | Restart server skill |

### Modified Files

| File | Change |
|------|--------|
| `.gitignore` | Ensure `.claude-plugin/` is NOT ignored (it must ship) |

### Files That Stay As-Is

| File | Why |
|------|-----|
| `server/` (entire directory) | Plugin's MCP server — runs unchanged |
| `CLAUDE.md` | Still loaded by Claude Code alongside the plugin |
| `.claude/commands/` | Keep for backward compatibility with non-plugin users |

---

## Chunk 1: Plugin Manifest & MCP Config

### Task 1: Create plugin.json manifest

**Files:**
- Create: `.claude-plugin/plugin.json`

- [x] **Step 1: Create the .claude-plugin directory**

```bash
mkdir -p .claude-plugin
```

- [x] **Step 2: Write plugin.json**

```json
{
  "name": "torque",
  "version": "2.1.0",
  "description": "AI task orchestration — multi-provider routing, DAG workflows, quality gates, and distributed execution across local and cloud LLMs. Delegates work to Codex, Claude, Ollama, DeepInfra, and more while you keep working.",
  "author": {
    "name": "TORQUE AI",
    "url": "https://github.com/torque-ai/torque-ai"
  },
  "repository": "https://github.com/torque-ai/torque-ai",
  "license": "BSL-1.1",
  "keywords": [
    "orchestration",
    "tasks",
    "workflows",
    "llm",
    "codex",
    "ollama",
    "deepinfra",
    "distributed",
    "quality-gates",
    "multi-provider"
  ],
  "category": "development"
}
```

Note: The MCP server is configured in `.mcp.json` at the plugin root (next task), not inline in plugin.json. This follows the standard plugin pattern where `.mcp.json` is auto-discovered.

- [x] **Step 3: Verify .gitignore does not exclude .claude-plugin/**

Check `.gitignore` — if it contains `.claude-plugin/`, remove that line. The manifest must ship with the repo.

- [x] **Step 4: Commit** (committed as part of `32e8fca`)

```bash
git add .claude-plugin/plugin.json
git commit -m "feat: add Claude Code plugin manifest"
```

### Task 2: Create plugin MCP server config (COMPLETE — merged into Task 1 via Option B)

**Files:**
- Create: `.mcp.json` (replaces `.mcp.json.example` for plugin installs)

- [x] **Step 1: Understand the current state**

Currently the repo has `.mcp.json.example` that users copy and edit paths manually. The plugin system uses `${CLAUDE_PLUGIN_ROOT}` to resolve paths automatically. We need a `.mcp.json` that works for BOTH plugin installs (auto-resolved paths) and manual installs (if someone clones and doesn't use the plugin system).

- [x] **Step 2: Write the plugin-compatible .mcp.json** (chose Option B — inline in plugin.json)

```json
{
  "mcpServers": {
    "torque": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server/index.js"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}/server",
      "description": "TORQUE - AI Task Orchestration with multi-provider routing, workflows, and quality gates"
    }
  }
}
```

When installed as a plugin, `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin install directory. The MCP server starts automatically when the plugin is enabled.

- [x] **Step 3: Keep .mcp.json.example for non-plugin users** (preserved, unchanged)

Don't delete `.mcp.json.example` — it serves users who clone the repo and configure manually without using the plugin system.

- [x] **Step 4: Update .gitignore** (.mcp.json stays gitignored; MCP config is inline in plugin.json)

If `.mcp.json` is currently in `.gitignore` (which it likely is, since it's meant to be user-configured), we need to handle this carefully. The plugin system needs `.mcp.json` to be checked in. Two options:

Option A: Check in `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}` paths (works for plugins, non-plugin users override with their own `.mcp.json`).

Option B: Use the `mcpServers` field inline in `plugin.json` instead of a separate `.mcp.json`.

**Choose Option B** — it's cleaner. Update `plugin.json` to include the MCP server config:

```json
{
  "name": "torque",
  "version": "2.1.0",
  "description": "AI task orchestration — multi-provider routing, DAG workflows, quality gates, and distributed execution across local and cloud LLMs. Delegates work to Codex, Claude, Ollama, DeepInfra, and more while you keep working.",
  "author": {
    "name": "TORQUE AI",
    "url": "https://github.com/torque-ai/torque-ai"
  },
  "repository": "https://github.com/torque-ai/torque-ai",
  "license": "BSL-1.1",
  "keywords": [
    "orchestration",
    "tasks",
    "workflows",
    "llm",
    "codex",
    "ollama",
    "deepinfra",
    "distributed",
    "quality-gates",
    "multi-provider"
  ],
  "category": "development",
  "mcpServers": {
    "torque": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server/index.js"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}/server"
    }
  }
}
```

This keeps `.mcp.json` in `.gitignore` (for user overrides) while the plugin gets its MCP config from the manifest.

- [x] **Step 5: Commit** (committed as part of `32e8fca`)

```bash
git add .claude-plugin/plugin.json
git commit -m "feat: add MCP server config to plugin manifest"
```

---

## Chunk 2: Convert Commands to Skills

Each existing slash command in `.claude/commands/` becomes a skill in `skills/`. Skills use the `SKILL.md` convention and get namespaced as `/torque:skill-name`.

### Task 3: Create skills directory structure (COMPLETE)

**Files:**
- Create: `skills/` directory with 8 subdirectories

- [x] **Step 1: Create skill directories**

```bash
mkdir -p skills/torque-submit
mkdir -p skills/torque-status
mkdir -p skills/torque-review
mkdir -p skills/torque-workflow
mkdir -p skills/torque-budget
mkdir -p skills/torque-config
mkdir -p skills/torque-cancel
mkdir -p skills/torque-restart
```

- [x] **Step 2: Convert each command to SKILL.md format** (copied with existing frontmatter intact)

For each command file in `.claude/commands/`, read its content and create a corresponding `skills/<name>/SKILL.md`. The skill format requires frontmatter:

```markdown
---
name: <skill-name>
description: <one-line description for discovery>
---

<original command content>
```

Read each source file and create the skill version:

| Source | Destination |
|--------|------------|
| `.claude/commands/torque-submit.md` | `skills/torque-submit/SKILL.md` |
| `.claude/commands/torque-status.md` | `skills/torque-status/SKILL.md` |
| `.claude/commands/torque-review.md` | `skills/torque-review/SKILL.md` |
| `.claude/commands/torque-workflow.md` | `skills/torque-workflow/SKILL.md` |
| `.claude/commands/torque-budget.md` | `skills/torque-budget/SKILL.md` |
| `.claude/commands/torque-config.md` | `skills/torque-config/SKILL.md` |
| `.claude/commands/torque-cancel.md` | `skills/torque-cancel/SKILL.md` |
| `.claude/commands/torque-restart.md` | `skills/torque-restart/SKILL.md` |

For each, read the source, prepend the frontmatter header, and write to the destination. The body content stays the same — skills are markdown just like commands.

Example for torque-submit:

```markdown
---
name: torque-submit
description: Submit work to TORQUE — auto-routes provider, captures baselines, configures retry
---

<content from .claude/commands/torque-submit.md>
```

- [ ] **Step 3: Verify skills are discovered** ← REMAINING (needs interactive testing)

Test locally:

```bash
claude --plugin-dir .
```

Then in Claude Code, run `/torque:torque-submit` to verify the skill loads. All 8 skills should appear in the skill list.

- [x] **Step 4: Keep .claude/commands/ for backward compatibility** (preserved, unchanged)

Don't delete the original commands. Users who installed TORQUE before the plugin system (via manual `.mcp.json`) still use `/torque-submit` from `.claude/commands/`. The plugin skills are namespaced as `/torque:torque-submit` and don't conflict.

- [x] **Step 5: Commit** (committed as part of `32e8fca`)

```bash
git add skills/
git commit -m "feat: convert 8 slash commands to plugin skills format"
```

---

## Chunk 3: Plugin README

### Task 4: Write plugin README (COMPLETE — updated existing README rather than full rewrite)

**Files:**
- Create: `README.md` (or update existing)

- [x] **Step 1: Write a plugin-focused README** (added plugin install + Superpowers companion to existing README)

The README needs to serve two audiences: plugin marketplace browsers (quick "what is this and why") and users who want more detail. Keep it scannable.

Structure:
1. One-line description + badge
2. What TORQUE does (3-4 bullet points, not a wall of text)
3. Quick install (plugin method — one command)
4. Manual install (for non-plugin users)
5. First steps after install
6. Link to full docs

```markdown
# TORQUE — AI Task Orchestration

Delegate work to multiple LLM providers (Codex, Claude, Ollama, DeepInfra, Groq) in parallel while you keep working. TORQUE handles routing, scheduling, quality gates, and workflows.

- **Multi-provider orchestration** — route tasks to the best available provider automatically
- **DAG workflows** — chain tasks with dependencies, run independent steps in parallel
- **30+ quality safeguards** — stub detection, baseline comparison, build verification, auto-retry
- **Progressive unlock** — start with 29 core tools, unlock 500+ as you need them

## Install

### As a Claude Code Plugin (recommended)

```bash
/plugin marketplace add torque-ai/torque-ai
/plugin install torque
```

That's it. The MCP server starts automatically.

### Manual Install

1. Clone: `git clone https://github.com/torque-ai/torque-ai.git`
2. Install deps: `cd torque-ai/server && npm install`
3. Copy `.mcp.json.example` to `.mcp.json` and update the path
4. Restart Claude Code

## First Steps

After installing, try:

- `/torque:torque-submit Write a function that checks if a number is prime` — submit your first task
- `/torque:torque-status` — see what's running
- `/torque:torque-review` — review completed task output
- `ping` — verify the MCP connection

## Commands

| Command | Purpose |
|---------|---------|
| `/torque:torque-submit [task]` | Submit work — auto-routes provider |
| `/torque:torque-status [filter]` | Queue overview |
| `/torque:torque-review [task-id]` | Review + validate output |
| `/torque:torque-workflow [name]` | DAG pipeline management |
| `/torque:torque-budget` | Cost tracking |
| `/torque:torque-config [setting]` | Configuration |
| `/torque:torque-cancel [task-id]` | Cancel tasks |

## Providers

TORQUE routes between 10 execution providers:

| Provider | Type | Best For |
|----------|------|----------|
| Codex (gpt-5.3-codex-spark) | Cloud | Greenfield code, multi-file tasks |
| Claude Code | Cloud | Architecture, complex debugging |
| Ollama (local) | Local | Fast edits, free |
| DeepInfra | Cloud | High-concurrency batch work |
| Groq | Cloud | Low-latency tasks |
| + 5 more | Mixed | Various specialties |

All cloud providers use your own API keys (BYOK). Local providers use your Ollama installation.

## Recommended Companion: Superpowers

TORQUE handles orchestration — where and how your tasks execute. For the best development workflow, pair it with [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent for brainstorming, TDD, systematic debugging, and code review.

```bash
/plugin install superpowers
```

Together: Superpowers helps you plan and structure work. TORQUE executes it across your providers in parallel.

## Documentation

Full docs: [CLAUDE.md](./CLAUDE.md) | [Safeguards](./docs/safeguards.md)

## License

BSL-1.1 — free for all use, converts to Apache 2.0 after 3 years.
```

- [x] **Step 2: Commit** (committed as part of `32e8fca`)

```bash
git add README.md
git commit -m "docs: rewrite README for plugin marketplace discovery"
```

---

## Chunk 4: Marketplace Distribution

### Task 5: Create self-hosted marketplace.json (COMPLETE)

**Files:**
- Create: `.claude-plugin/marketplace.json`

- [x] **Step 1: Write marketplace.json**

This file makes the GitHub repo itself a plugin marketplace. Users add it with `/plugin marketplace add torque-ai/torque-ai`.

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "torque-ai",
  "owner": {
    "name": "TORQUE AI"
  },
  "metadata": {
    "description": "TORQUE — AI Task Orchestration plugin for Claude Code",
    "version": "1.0.0"
  },
  "plugins": [
    {
      "name": "torque",
      "source": ".",
      "description": "Multi-provider task orchestration — DAG workflows, quality gates, distributed execution across Codex, Claude, Ollama, DeepInfra, and more",
      "version": "2.1.0",
      "author": {
        "name": "TORQUE AI"
      },
      "repository": "https://github.com/torque-ai/torque-ai",
      "license": "BSL-1.1",
      "keywords": [
        "orchestration",
        "tasks",
        "workflows",
        "llm",
        "multi-provider"
      ],
      "category": "development"
    }
  ]
}
```

- [ ] **Step 2: Validate the marketplace** ← REMAINING (needs `claude plugin validate .`)

```bash
claude plugin validate .
```

Or in Claude Code:

```
/plugin validate .
```

Expected: validation passes with no errors.

- [x] **Step 3: Commit** (committed as part of `32e8fca`)

```bash
git add .claude-plugin/marketplace.json
git commit -m "feat: add self-hosted marketplace.json for plugin distribution"
```

### Task 6: Test the full plugin install flow

- [ ] **Step 1: Test local plugin loading**

```bash
claude --plugin-dir .
```

Verify: TORQUE MCP server starts, all 8 skills are discoverable, `ping` tool works.

- [ ] **Step 2: Test marketplace install from local path**

In a fresh Claude Code session (different directory):

```
/plugin marketplace add /path/to/torque-public
/plugin install torque@torque-ai
```

Verify: Plugin installs, MCP server starts, skills work.

- [ ] **Step 3: Push to GitHub and test remote install**

After pushing all changes:

```
/plugin marketplace add torque-ai/torque-ai
/plugin install torque@torque-ai
```

Verify: Plugin installs from GitHub, MCP server starts, all tools available.

- [ ] **Step 4: Document any issues and fix**

```bash
git add -A
git commit -m "fix: plugin packaging fixes from install testing"
```

### Task 7: Submit to official Anthropic marketplace

- [ ] **Step 1: Verify all requirements**

Checklist before submission:
- [ ] plugin.json has name, version, description, author
- [ ] MCP server starts cleanly with `${CLAUDE_PLUGIN_ROOT}` paths
- [ ] All 8 skills load and work
- [ ] README.md is clear and complete
- [ ] LICENSE file exists (BSL-1.1)
- [ ] No personal data (IPs, usernames, paths)
- [ ] Security audit findings are resolved (3 critical fixes already applied)

- [ ] **Step 2: Submit via the official form**

Go to one of:
- `https://claude.ai/settings/plugins/submit`
- `https://platform.claude.com/plugins/submit`

Fill in:
- Plugin name: `torque`
- Repository: `https://github.com/torque-ai/torque-ai`
- Description: AI task orchestration with multi-provider routing, DAG workflows, and quality gates
- Category: Development

- [ ] **Step 3: Monitor for review feedback**

Anthropic reviews for quality and security. Respond to any feedback. The security audit already done (3 critical, 5 high fixes) should satisfy most concerns.

---

## Chunk 5: npm Package (optional, for marketplace source flexibility)

### Task 8: Publish as npm package

**Files:**
- Modify: `package.json` (root level)

- [ ] **Step 1: Verify package.json is plugin-ready**

The root `package.json` should have:
- `name`: `@torque-ai/torque` (or `torque-ai` if scoped org not available)
- `version`: matching plugin.json version
- `files`: whitelist what gets published (server/, skills/, .claude-plugin/, README.md, LICENSE, CLAUDE.md)
- `bin`: not needed (this isn't a CLI package — that's the agent)

- [ ] **Step 2: Create .npmignore if needed**

Exclude dev/CI files from the npm package:

```
.github/
docs/
server/tests/
server/coverage/
server/artifacts/
server/backups/
*.test.js
.env
.env.*
```

- [ ] **Step 3: Test with npm pack**

```bash
npm pack --dry-run
```

Verify the package size is reasonable (the CI work already got it to 1.3MB from 33MB).

- [ ] **Step 4: Publish**

```bash
npm publish --access public
```

- [ ] **Step 5: Update marketplace.json to reference npm**

Add an npm source option to marketplace.json so users can install from npm instead of git:

```json
{
  "plugins": [
    {
      "name": "torque",
      "source": {
        "source": "npm",
        "package": "@torque-ai/torque",
        "version": "2.1.0"
      },
      "description": "..."
    }
  ]
}
```

- [ ] **Step 6: Commit**

```bash
git add package.json .npmignore .claude-plugin/marketplace.json
git commit -m "feat: publish plugin as npm package for marketplace distribution"
```

---

## Summary

| Chunk | Tasks | Effort | Dependencies |
|-------|-------|--------|-------------|
| 1: Plugin manifest + MCP | Tasks 1-2 | 30 min | None |
| 2: Convert commands to skills | Task 3 | 1-2 hours | None |
| 3: Plugin README | Task 4 | 1 hour | None |
| 4: Marketplace + testing | Tasks 5-7 | 2-3 hours | Chunks 1-3 |
| 5: npm package (optional) | Task 8 | 1 hour | Chunks 1-3 |

**Total: ~1 day of work.** Chunks 1-3 can run in parallel. Chunk 4 depends on 1-3. Chunk 5 is optional but recommended.

**After completion:**
- Users install TORQUE with `/plugin install torque` (self-hosted marketplace) or one click from official marketplace
- Zero manual `.mcp.json` configuration
- All 8 slash commands available as namespaced skills
- MCP server starts automatically
- Monetization funnel: free plugin → tier unlock → MCPize → TORQUE Cloud
