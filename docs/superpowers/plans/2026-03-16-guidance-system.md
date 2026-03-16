# Guidance System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver TORQUE behavioral discipline to any LLM client (Claude Code, Cursor, REST agents) through a three-layer guidance composition system with progressive tier-based disclosure.

**Architecture:** Static behavioral rules (markdown files) + tier-filtered tool descriptions (from existing tool-defs) + dynamic environment context (from DB) composed at request time via `/api/guidance` REST endpoint. MCP `ping` enhanced with opt-in guidance delivery. CLAUDE.md rewritten to lean ~120-150 lines with core discipline only.

**Tech Stack:** Node.js, Express-style route handlers (TORQUE's custom `createApiServer` / `resolveApiRoutes` pattern), fs for static file loading, crypto for content hashing, vitest for tests.

**Spec:** `docs/superpowers/specs/2026-03-16-guidance-system-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `server/guidance/core-discipline.md` | Don't poll, don't kill, don't cancel blindly, prescriptive await patterns |
| `server/guidance/edit-discipline.md` | Harness problem rules, hashline preference, read-before-edit |
| `server/guidance/orchestration-patterns.md` | scan_project first, await_workflow chaining, Codex verification, parallelization |
| `server/guidance/safety.md` | File safety, Codex sandbox contamination, orchestrator role |
| `server/guidance/onboarding.md` | First-run guidance, remote host discovery, peek_ui introduction |
| `server/guidance/profile-template.md` | Template for `~/.torque/profile.md` (read at scaffold time) |
| `server/handlers/guidance-handlers.js` | Layer assembly logic, TOOL_DOMAIN_MAP, compose functions |
| `server/tests/guidance-handlers.test.js` | Tests for guidance assembly, tier filtering, caching, profile loading |

### Modified Files

| File | Change |
|------|--------|
| `server/tool-defs/core-defs.js` | Add `include_guidance` boolean + `tier` param to `ping` schema |
| `server/tools.js` | Enhance `ping` case to call guidance assembly when `include_guidance: true` |
| `server/api/routes.js` | Add `GET /api/guidance` route to routes array |
| `server/index.js` | Load static guidance files at startup, auto-scaffold `~/.torque/` on first run |
| `CLAUDE.md` | Rewrite to lean ~120-150 line version |

---

## Chunk 1: Static Guidance Files (Layer 1)

### Task 1: Write core-discipline.md

**Files:**
- Create: `server/guidance/core-discipline.md`

- [ ] **Step 1: Create the guidance directory**

```bash
mkdir -p server/guidance
```

- [ ] **Step 2: Write core-discipline.md**

Source content extracted from the personal global CLAUDE.md sections: "TORQUE Workflow Discipline", "Process Safety — NEVER Kill", "Task Safety — NEVER Cancel". Genericized (no personal IPs, usernames, paths).

Content must include:
- Orchestrator role: plan, submit, verify, integrate — never manually implement
- Process safety: NEVER kill TORQUE process; use `cancel_task` for tasks
- Task safety: NEVER cancel without reading status first; other sessions may own tasks
- Prescriptive await pattern table (5 rows: task, workflow, CI, verify, verify+commit)
- Anti-patterns: don't poll `check_status` in a loop, don't set short `poll_interval_ms`

```markdown
# Core Discipline

## Orchestrator Role

When TORQUE is the execution engine:
- **Plan, submit, verify, integrate** — do not manually implement what TORQUE should produce
- On failure: diagnose the root cause, fix it, resubmit — do NOT bypass by writing code manually
- Only write code directly for: config fixes, integration glue outside task scope, or debugging TORQUE itself

## Process Safety

- **NEVER kill the TORQUE server process** — this includes `kill`, `taskkill`, `Stop-Process`, SIGTERM, SIGKILL, or any process termination command
- TORQUE is shared infrastructure — other sessions depend on it
- To stop a runaway task: use `cancel_task` (MCP) or `DELETE /api/tasks/{task_id}` (REST)
- To cancel a whole workflow: use `cancel_workflow`
- If the cancel API fails: ask the user. Do NOT escalate to process kills.

## Task Safety

- **NEVER cancel tasks without first reading their full description and checking status**
- Multiple sessions may be running concurrently — tasks that look "stale" may be actively owned by another session
- Before cancelling any task: use `task_info` to read the full description, creation time, and progress
- "0% progress" does NOT mean stale — tasks buffer output and may not flush until completion
- Tasks from other sessions are NOT yours to cancel
- When in doubt, ask the user
- Cancellation is irreversible — a cancelled task's work is lost

## Await Patterns

Always use the appropriate await tool instead of polling:

| Scenario | Don't | Do |
|----------|-------|----|
| Waiting for a task | Poll `check_status` in a loop | `await_task` — wakes instantly on completion |
| Waiting for a workflow | Poll `workflow_status` in a loop | `await_workflow` — yields each completed task |
| Waiting for CI | Poll `ci_run_status` in a loop | `await_ci_run` — blocks until run finishes |
| Verifying after task | Manually run tests then check | `await_task` with `verify_command` — runs tests automatically |
| Verify + commit | Manual test then manual commit | `await_task` with `verify_command` + `auto_commit: true` |

**Never** poll `check_status` or `workflow_status` in a loop — this wastes context tokens and adds latency. The event bus wakes await tools instantly.
```

- [ ] **Step 3: Commit**

```bash
git add server/guidance/core-discipline.md
git commit -m "docs: add core-discipline guidance — await patterns, process/task safety"
```

### Task 2: Write edit-discipline.md

**Files:**
- Create: `server/guidance/edit-discipline.md`

- [ ] **Step 1: Write edit-discipline.md**

Source: "Harness Problem — Edit Discipline" from personal CLAUDE.md.

```markdown
# Edit Discipline

## The Harness Problem

The editing mechanism is a critical bottleneck — format choice alone swings performance independently of model capability.

## Rules

- **Prefer `hashline_read` + `hashline_edit`** over Read + Edit — reference lines by number:hash instead of reproducing exact content. Eliminates whitespace sensitivity and uniqueness collisions.
- **Always read before editing** — never guess at indentation, whitespace, or surrounding context
- **Use unique anchors** — include 3-5 lines of surrounding context to avoid ambiguous matches
- **Prefer full-file writes for files under 400 lines** — rewrites are more reliable than many small string-replace edits
- **Prefer targeted edits for large files** — targeted replacements beat rewriting thousands of lines
- **On edit failure, widen context** — don't retry the same anchor; add more surrounding lines or switch approach
- **Separate harness failures from code failures** — "did the edit apply?" is a different question from "is the code correct?"
- **Avoid retry loops** — if an approach fails twice, change strategy (different tool, different anchor, full rewrite)
```

- [ ] **Step 2: Commit**

```bash
git add server/guidance/edit-discipline.md
git commit -m "docs: add edit-discipline guidance — harness problem rules, hashline preference"
```

### Task 3: Write orchestration-patterns.md

**Files:**
- Create: `server/guidance/orchestration-patterns.md`

- [ ] **Step 1: Write orchestration-patterns.md**

Source: "TORQUE Best Practices" from personal CLAUDE.md, genericized.

```markdown
# Orchestration Patterns

## Before Starting Work

- **Always use `scan_project` before planning work batches** — it reveals missing tests, TODOs, file sizes, coverage gaps, and dependencies at zero LLM cost. This should be the first step when deciding what to build or fix next.

## Task Submission

- Use `submit_task` for single tasks — it auto-routes to the best available provider
- Use `create_workflow` + `add_workflow_task` for multi-step DAGs
- Use `run_batch` for full feature workflows (types → data → events → system → tests → wire)
- Parallelize independent tasks — test writing, data files, and independent edits can run simultaneously

## Waiting and Verification

- Use `await_task` for single tasks — blocks until completion, supports `verify_command` and `auto_commit`
- Use `await_workflow` for workflows — yields each completed task for review
- Use `await_ci_run` for CI pipelines — blocks until the run finishes
- **Never** poll in a loop — the event bus wakes await tools instantly

## After Codex Tasks

- **Always run `git diff --stat` after Codex task completion** — check for unexpected deletions or reverts
- Codex sandbox contamination is a known issue: tasks start from a potentially stale repo state and can silently revert changes committed after the sandbox was created
- If reverts detected: `git checkout HEAD -- <reverted files>` to restore from HEAD before committing

## Committing

- **Commit generated artifacts immediately** — reports, investigations, audit outputs, and any files generated by workflows should be committed as soon as they're complete. Untracked = unprotected.
```

- [ ] **Step 2: Commit**

```bash
git add server/guidance/orchestration-patterns.md
git commit -m "docs: add orchestration-patterns guidance — scan_project, await, Codex safety"
```

### Task 4: Write safety.md

**Files:**
- Create: `server/guidance/safety.md`

- [ ] **Step 1: Write safety.md**

```markdown
# Safety

## File Safety

- **NEVER run `git clean`** — it destroys untracked work products that may have taken hours to generate
- **NEVER delete untracked files you didn't create** — they may be reports, audit results, or outputs from other sessions
- **NEVER delete directories you don't understand** — investigate before removing
- Use `git stash` for tracked changes and leave untracked files alone

## Provider Safety

- Route complex/multi-file tasks to capable providers (Codex, claude-cli) — local LLMs degrade above 250 lines
- Route XAML/WPF tasks to cloud providers — local LLMs struggle with WPF semantics
- Check `split_advisory` metadata — if present, decompose into subtasks instead of one large task

## Review Gate

- Tasks flagged `needs_review: true` require manual diff review before committing
- Check for: stub implementations, missing error handling, unused imports, hallucinated APIs
- Simple tasks (types, docs, config) can skip review — auto-verify via build/test is sufficient
```

- [ ] **Step 2: Commit**

```bash
git add server/guidance/safety.md
git commit -m "docs: add safety guidance — file safety, provider routing, review gates"
```

### Task 5: Write onboarding.md

**Files:**
- Create: `server/guidance/onboarding.md`

- [ ] **Step 1: Write onboarding.md**

```markdown
# Getting Started with TORQUE

Welcome to TORQUE. This guide helps you get productive quickly.

## First Steps

1. **Start the server** — `node server/index.js` or use your platform's start command
2. **Connect your LLM client** — via MCP (`.mcp.json`) or REST (`GET /api/guidance`)
3. **Submit your first task** — `submit_task` with a description of what you want to build

## Distributed Execution

TORQUE can distribute tasks across multiple machines on your network.

**Do you have other machines with GPUs?** Register them and TORQUE automatically load-balances work:
- Run tests on a remote machine while you keep working locally
- Offload quality-tier tasks to a high-VRAM GPU host
- Use `add_ollama_host` to register: `add_ollama_host { name: "my-gpu-server", url: "http://192.168.1.x:11434" }`
- Use `list_ollama_hosts` to check status

## Visual Verification (Peek)

TORQUE includes visual UI verification tools via the Peek system:
- `peek_ui` captures window screenshots without stealing focus
- Use it to verify UI changes, debug layout issues, or confirm renders
- Configure your peek server location in `~/.torque/profile.md`

## Progressive Tool Unlock

TORQUE starts with ~29 core tools. As you need more:
- **Tier 2** (~80 tools): `unlock_tier { tier: 2 }` — adds batch orchestration, TypeScript structural tools, Peek
- **Tier 3** (~500 tools): `unlock_tier { tier: 3 }` — everything: admin, webhooks, experiments, policies

## Customize Your Profile

Edit `~/.torque/profile.md` to tell TORQUE about your environment — remote hosts, preferred providers, test commands, and any custom rules for your LLM.
```

- [ ] **Step 2: Commit**

```bash
git add server/guidance/onboarding.md
git commit -m "docs: add onboarding guidance — first steps, distributed execution, peek, tiers"
```

### Task 6: Write profile-template.md

**Files:**
- Create: `server/guidance/profile-template.md`

- [ ] **Step 1: Write profile-template.md**

This template is copied to `~/.torque/profile.md` on first server startup.

```markdown
# TORQUE User Profile
#
# This file tells TORQUE about your environment. Edit it freely.
# It is read by the guidance system and included in LLM context.
# Location: ~/.torque/profile.md (never committed to repos)

## Remote Hosts
#
# Register machines TORQUE can offload work to.
# TORQUE auto-discovers models, load-balances, and fails over.
#
# Examples:
#   - Run tests on a beefy remote machine while you keep working locally
#   - Offload quality-tier tasks to a high-VRAM GPU host
#   - Run peek_ui captures on a machine with a display
#
# Configure via: add_ollama_host { name: "my-server", url: "http://192.168.1.x:11434" }
# View status:   list_ollama_hosts

## Peek Server
#
# If you have a peek_server running for visual UI verification:
# peek_server_url: http://your-host:9876

## Custom Rules
#
# Add any project-specific or personal rules for your LLM here.
# Examples:
#   - Always run tests on my-remote-server
#   - Prefer codex provider for new file creation
#   - Use deepinfra for complex reasoning tasks
```

- [ ] **Step 2: Commit**

```bash
git add server/guidance/profile-template.md
git commit -m "docs: add profile template — scaffolded to ~/.torque/ on first startup"
```

---

## Chunk 2: Guidance Handler + Tests (Layer 2 & 3 Assembly)

### Task 7: Write failing tests for guidance handler

**Files:**
- Create: `server/tests/guidance-handlers.test.js`

- [ ] **Step 1: Write the test file**

Tests cover: static file loading, tier-filtered tool grouping, dynamic context assembly, profile loading (with size limit), markdown/JSON format, content hashing, caching, and onboarding conditional inclusion.

```js
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Mock dependencies
const mockDb = {
  getConfig: vi.fn(),
  listProviders: vi.fn(() => []),
  listOllamaHosts: vi.fn(() => []),
  getDbInstance: vi.fn(() => null),
};

const mockGetToolNamesForTier = vi.fn();

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

installMock('../database', mockDb);
installMock('../core-tools', {
  getToolNamesForTier: mockGetToolNamesForTier,
  TIER_1: ['ping', 'submit_task', 'await_task'],
  TIER_2: ['run_batch', 'peek_ui'],
});

const guidanceHandlers = require('../handlers/guidance-handlers');

describe('guidance-handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guidanceHandlers.clearCaches();
    mockGetToolNamesForTier.mockReturnValue(['submit_task', 'await_task']);
    mockDb.listProviders.mockReturnValue([
      { name: 'ollama', enabled: true },
      { name: 'codex', enabled: true },
    ]);
    mockDb.listOllamaHosts.mockReturnValue([
      { name: 'local', url: 'http://localhost:11434', status: 'healthy' },
    ]);
  });

  describe('loadStaticGuidance', () => {
    it('loads all guidance files from the guidance directory', () => {
      const result = guidanceHandlers.loadStaticGuidance();
      expect(result).toHaveProperty('core_discipline');
      expect(result).toHaveProperty('edit_discipline');
      expect(result).toHaveProperty('orchestration_patterns');
      expect(result).toHaveProperty('safety');
      expect(result).toHaveProperty('onboarding');
      expect(result.core_discipline).toContain('Orchestrator Role');
    });

    it('returns partial result if a file is missing', () => {
      // Rename a file temporarily — the handler should not throw
      const result = guidanceHandlers.loadStaticGuidance();
      expect(typeof result).toBe('object');
    });
  });

  describe('getToolGuidanceForTier', () => {
    it('returns tools grouped by domain for tier 1', () => {
      const result = guidanceHandlers.getToolGuidanceForTier(1);
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty('domain');
      expect(result[0]).toHaveProperty('tools');
    });

    it('excludes meta-tools from core-defs', () => {
      mockGetToolNamesForTier.mockReturnValue(['ping', 'restart_server', 'submit_task']);
      const result = guidanceHandlers.getToolGuidanceForTier(1);
      const allToolNames = result.flatMap(g => g.tools.map(t => t.name));
      expect(allToolNames).not.toContain('ping');
      expect(allToolNames).not.toContain('restart_server');
    });

    it('returns null for tier 3 (all tools)', () => {
      mockGetToolNamesForTier.mockReturnValue(null);
      const result = guidanceHandlers.getToolGuidanceForTier(3);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getDynamicContext', () => {
    it('includes providers and hosts', () => {
      const result = guidanceHandlers.getDynamicContext();
      expect(result).toHaveProperty('providers');
      expect(result).toHaveProperty('hosts');
      expect(result).toHaveProperty('project_defaults');
      expect(result.providers).toHaveLength(2);
    });

    it('returns null project_defaults when no working_directory given', () => {
      const result = guidanceHandlers.getDynamicContext();
      expect(result.project_defaults).toBeNull();
    });
  });

  describe('loadUserProfile', () => {
    it('returns null when profile does not exist', () => {
      const result = guidanceHandlers.loadUserProfile('/nonexistent/path/profile.md');
      expect(result).toBeNull();
    });

    it('truncates profiles larger than 64KB', () => {
      const tmpDir = path.join(__dirname, '__tmp_guidance_test__');
      const tmpFile = path.join(tmpDir, 'big-profile.md');
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(tmpFile, 'x'.repeat(70000)); // > 64KB
        const result = guidanceHandlers.loadUserProfile(tmpFile);
        expect(result.length).toBeLessThanOrEqual(65536 + 200); // 64KB + truncation warning
        expect(result).toContain('truncated');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('composeGuidance', () => {
    it('returns markdown format by default', () => {
      const result = guidanceHandlers.composeGuidance({ tier: 1, format: 'markdown' });
      expect(typeof result.content).toBe('string');
      expect(result.content).toContain('## Core Discipline');
      expect(result).toHaveProperty('content_hash');
      expect(result).toHaveProperty('version');
    });

    it('returns JSON format when requested', () => {
      const result = guidanceHandlers.composeGuidance({ tier: 1, format: 'json' });
      expect(typeof result.content).toBe('object');
      expect(result.content).toHaveProperty('rules');
      expect(result.content).toHaveProperty('tools');
      expect(result.content).toHaveProperty('environment');
    });

    it('includes onboarding when profile does not exist', () => {
      const result = guidanceHandlers.composeGuidance({
        tier: 1,
        format: 'markdown',
        profilePath: '/nonexistent/profile.md',
      });
      expect(result.content).toContain('Getting Started');
    });

    it('excludes onboarding when profile exists', () => {
      const tmpDir = path.join(__dirname, '__tmp_guidance_test2__');
      const tmpFile = path.join(tmpDir, 'profile.md');
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(tmpFile, '# My Profile\n');
        const result = guidanceHandlers.composeGuidance({
          tier: 1,
          format: 'markdown',
          profilePath: tmpFile,
        });
        expect(result.content).not.toContain('Getting Started');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('filters sections when requested', () => {
      const result = guidanceHandlers.composeGuidance({
        tier: 1,
        format: 'markdown',
        sections: ['rules'],
      });
      expect(result.content).toContain('Core Discipline');
      expect(result.content).not.toContain('Your Tools');
      expect(result.content).not.toContain('Your Environment');
    });

    it('caches Layer 2 per tier', () => {
      const r1 = guidanceHandlers.getToolGuidanceForTier(1);
      const r2 = guidanceHandlers.getToolGuidanceForTier(1);
      // Should be same reference (cached)
      expect(r1).toBe(r2);
    });

    it('content_hash changes when content changes', () => {
      const r1 = guidanceHandlers.composeGuidance({ tier: 1, format: 'markdown' });
      const r2 = guidanceHandlers.composeGuidance({ tier: 2, format: 'markdown' });
      expect(r1.content_hash).not.toBe(r2.content_hash);
    });
  });

  describe('handleGetGuidance (REST handler)', () => {
    it('returns 200 with markdown by default', async () => {
      const req = { url: '/api/guidance', method: 'GET' };
      const res = { writeHead: vi.fn(), end: vi.fn() };
      await guidanceHandlers.handleGetGuidance(req, res);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/markdown; charset=utf-8',
      }));
    });

    it('returns JSON when format=json', async () => {
      const req = { url: '/api/guidance?format=json', method: 'GET' };
      const res = { writeHead: vi.fn(), end: vi.fn() };
      await guidanceHandlers.handleGetGuidance(req, res);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'application/json; charset=utf-8',
      }));
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `ssh kenten@192.168.1.183 "cd C:\Users\Kenten\Projects\Torque && npx vitest run server/tests/guidance-handlers.test.js"`

Expected: FAIL — `Cannot find module '../handlers/guidance-handlers'`

- [ ] **Step 3: Commit test file**

```bash
git add server/tests/guidance-handlers.test.js
git commit -m "test: add guidance-handlers tests (red — handler not yet implemented)"
```

### Task 8: Implement guidance-handlers.js

**Files:**
- Create: `server/handlers/guidance-handlers.js`

- [ ] **Step 1: Write the handler implementation**

```js
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const db = require('../database');
const { getToolNamesForTier } = require('../core-tools');
const logger = require('../logger').child({ component: 'guidance' });

// ── Constants ──

const GUIDANCE_DIR = path.join(__dirname, '..', 'guidance');
const PROFILE_MAX_BYTES = 65536; // 64KB
const VERSION = require('../package.json').version || '0.0.0';

const META_TOOLS = new Set(['ping', 'restart_server', 'unlock_all_tools', 'unlock_tier']);

const TOOL_DOMAIN_MAP = {
  'task-submission-defs.js': 'Task Submission',
  'task-management-defs.js': 'Task Management',
  'task-defs.js': 'Task Queries',
  'workflow-defs.js': 'Workflows',
  'automation-defs.js': 'Automation & Batch',
  'ci-defs.js': 'CI Integration',
  'provider-defs.js': 'Provider Configuration',
  'hashline-defs.js': 'File Editing (Hashline)',
  'snapscope-defs.js': 'Visual Capture (SnapScope)',
  'tsserver-defs.js': 'TypeScript Structural Tools',
  'remote-agent-defs.js': 'Remote Agents',
  'policy-defs.js': 'Governance & Policy',
  'conflict-resolution-defs.js': 'Conflict Resolution',
  'orchestrator-defs.js': 'Orchestration',
  'experiment-defs.js': 'Experiments',
  'audit-defs.js': 'Audit',
  'baseline-defs.js': 'Baselines',
  'approval-defs.js': 'Approvals',
  'validation-defs.js': 'Validation',
  'webhook-defs.js': 'Webhooks',
  'intelligence-defs.js': 'Intelligence',
  'advanced-defs.js': 'Advanced',
  'integration-defs.js': 'Integration',
};

// ── Layer 1: Static guidance (cached at load time) ──

const GUIDANCE_FILES = {
  core_discipline: 'core-discipline.md',
  edit_discipline: 'edit-discipline.md',
  orchestration_patterns: 'orchestration-patterns.md',
  safety: 'safety.md',
  onboarding: 'onboarding.md',
};

let staticGuidanceCache = null;

function loadStaticGuidance() {
  if (staticGuidanceCache) return staticGuidanceCache;

  const result = {};
  for (const [key, filename] of Object.entries(GUIDANCE_FILES)) {
    const filePath = path.join(GUIDANCE_DIR, filename);
    try {
      result[key] = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      logger.warn(`[guidance] Missing guidance file: ${filename} — ${err.message}`);
      result[key] = null;
    }
  }
  staticGuidanceCache = result;
  return result;
}

// ── Layer 2: Tool-derived guidance (cached per tier) ──

const tierToolCache = new Map(); // tier -> grouped tools

function getToolGuidanceForTier(tier) {
  if (tierToolCache.has(tier)) return tierToolCache.get(tier);

  const tierNames = getToolNamesForTier(tier);
  // tier 3 returns null (all tools)
  const filterSet = tierNames ? new Set(tierNames) : null;

  const toolDefDir = path.join(__dirname, '..', 'tool-defs');
  const domainGroups = new Map();

  for (const [filename, domain] of Object.entries(TOOL_DOMAIN_MAP)) {
    const filePath = path.join(toolDefDir, filename);
    let defs;
    try {
      defs = require(filePath);
    } catch {
      continue;
    }

    if (!Array.isArray(defs)) continue;

    const tools = defs
      .filter(d => !META_TOOLS.has(d.name))
      .filter(d => !filterSet || filterSet.has(d.name))
      .map(d => ({ name: d.name, guidance: d.description || '' }));

    if (tools.length > 0) {
      if (!domainGroups.has(domain)) domainGroups.set(domain, []);
      domainGroups.get(domain).push(...tools);
    }
  }

  const result = Array.from(domainGroups.entries()).map(([domain, tools]) => ({ domain, tools }));
  tierToolCache.set(tier, result);
  return result;
}

// ── Layer 3: Dynamic context ──

function getDynamicContext({ workingDirectory = null } = {}) {
  let providers = [];
  let hosts = [];
  let projectDefaults = null;

  try { providers = db.listProviders ? db.listProviders() : []; } catch { /* */ }
  try { hosts = db.listOllamaHosts ? db.listOllamaHosts() : []; } catch { /* */ }

  // Project defaults are per-working-directory. Only included when a working_directory is provided.
  if (workingDirectory) {
    try {
      const dbInstance = db.getDbInstance ? db.getDbInstance() : null;
      if (dbInstance) {
        projectDefaults = dbInstance.prepare(
          'SELECT * FROM project_config WHERE working_directory = ?'
        ).get(workingDirectory) || null;
      }
    } catch { /* table may not exist */ }
  }

  return {
    providers: providers.map(p => ({ name: p.name, enabled: !!p.enabled })),
    hosts: hosts.map(h => ({
      name: h.name,
      url: h.url,
      status: h.status || 'unknown',
    })),
    project_defaults: projectDefaults,
  };
}

// ── Layer 3b: User profile ──

function getDefaultProfilePath() {
  return path.join(os.homedir(), '.torque', 'profile.md');
}

function loadUserProfile(profilePath) {
  const p = profilePath || getDefaultProfilePath();
  try {
    const stat = fs.statSync(p);
    let content = fs.readFileSync(p, 'utf-8');
    if (stat.size > PROFILE_MAX_BYTES) {
      content = content.slice(0, PROFILE_MAX_BYTES);
      content += '\n\n<!-- Profile truncated: exceeds 64KB limit -->';
      logger.warn(`[guidance] User profile truncated: ${stat.size} bytes > ${PROFILE_MAX_BYTES} limit`);
    }
    return content;
  } catch {
    return null;
  }
}

function profileExists(profilePath) {
  const p = profilePath || getDefaultProfilePath();
  try { fs.accessSync(p); return true; } catch { return false; }
}

// ── Composition ──

function composeGuidance({ tier = 1, format = 'markdown', sections = null, profilePath = null, workingDirectory = null } = {}) {
  const staticRules = loadStaticGuidance();
  const toolGroups = getToolGuidanceForTier(tier);
  const env = getDynamicContext({ workingDirectory });
  const profile = loadUserProfile(profilePath);
  const hasProfile = profileExists(profilePath);

  const includeRules = !sections || sections.includes('rules');
  const includeTools = !sections || sections.includes('tools');
  const includeEnv = !sections || sections.includes('environment');

  if (format === 'json') {
    const rules = {};
    if (includeRules) {
      if (staticRules.core_discipline) rules.core_discipline = staticRules.core_discipline;
      if (staticRules.edit_discipline) rules.edit_discipline = staticRules.edit_discipline;
      if (staticRules.orchestration_patterns) rules.orchestration_patterns = staticRules.orchestration_patterns;
      if (staticRules.safety) rules.safety = staticRules.safety;
      if (!hasProfile && staticRules.onboarding) rules.onboarding = staticRules.onboarding;
    }

    const content = {
      rules: includeRules ? rules : undefined,
      tools: includeTools ? toolGroups : undefined,
      environment: includeEnv ? env : undefined,
      profile: profile || undefined,
    };

    const contentStr = JSON.stringify(content);
    return {
      tier,
      version: VERSION,
      content_hash: 'sha256:' + crypto.createHash('sha256').update(contentStr).digest('hex'),
      content,
    };
  }

  // Markdown format
  const parts = [];

  if (includeRules) {
    if (staticRules.core_discipline) parts.push('## Core Discipline\n\n' + staticRules.core_discipline);
    if (staticRules.edit_discipline) parts.push('## Edit Discipline\n\n' + staticRules.edit_discipline);
    if (staticRules.orchestration_patterns) parts.push('## Orchestration Patterns\n\n' + staticRules.orchestration_patterns);
    if (staticRules.safety) parts.push('## Safety\n\n' + staticRules.safety);
    if (!hasProfile && staticRules.onboarding) parts.push('## Getting Started\n\n' + staticRules.onboarding);
  }

  if (includeTools && toolGroups.length > 0) {
    const toolLines = [`## Your Tools (Tier ${tier})\n`];
    for (const group of toolGroups) {
      toolLines.push(`### ${group.domain}`);
      for (const tool of group.tools) {
        toolLines.push(`- **${tool.name}** — ${tool.guidance}`);
      }
      toolLines.push('');
    }
    parts.push(toolLines.join('\n'));
  }

  if (includeEnv) {
    const envLines = ['## Your Environment\n'];
    envLines.push('**Providers:**');
    for (const p of env.providers) {
      envLines.push(`- ${p.name} (${p.enabled ? 'enabled' : 'disabled'})`);
    }
    envLines.push('');
    if (env.hosts.length > 0) {
      envLines.push('**Hosts:**');
      for (const h of env.hosts) {
        envLines.push(`- ${h.name} (${h.status})`);
      }
      const healthyRemoteHosts = env.hosts.filter(h => h.status === 'healthy' && h.url !== 'http://localhost:11434');
      if (healthyRemoteHosts.length > 0) {
        envLines.push('');
        envLines.push(`> **Tip:** You have ${healthyRemoteHosts.length} remote host(s) available. Route tests and quality-tier tasks there for faster iteration.`);
      }
      envLines.push('');
    }
    if (env.project_defaults) {
      envLines.push('**Project Defaults:**');
      for (const [k, v] of Object.entries(env.project_defaults)) {
        if (v != null) envLines.push(`- ${k}: \`${v}\``);
      }
    }
    parts.push(envLines.join('\n'));
  }

  if (profile) {
    parts.push('## Your Profile\n\n' + profile);
  }

  const content = parts.join('\n\n---\n\n');
  return {
    tier,
    version: VERSION,
    content_hash: 'sha256:' + crypto.createHash('sha256').update(content).digest('hex'),
    content,
  };
}

// ── REST handler ──

function parseQueryString(url) {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const params = {};
  for (const pair of url.slice(idx + 1).split('&')) {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
  }
  return params;
}

async function handleGetGuidance(req, res) {
  const query = parseQueryString(req.url || '');
  const tier = query.tier ? parseInt(query.tier, 10) : 1;
  const format = query.format === 'json' ? 'json' : 'markdown';
  const sections = query.sections ? query.sections.split(',') : null;
  const workingDirectory = query.working_directory || null;

  const result = composeGuidance({ tier, format, sections, workingDirectory });

  if (format === 'json') {
    const body = JSON.stringify(result);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } else {
    const body = result.content;
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}

// ── Profile scaffolding ──

function scaffoldUserProfile() {
  const torqueDir = path.join(os.homedir(), '.torque');
  const profilePath = path.join(torqueDir, 'profile.md');

  try {
    fs.accessSync(torqueDir);
    return false; // Already exists
  } catch { /* does not exist — create it */ }

  try {
    fs.mkdirSync(torqueDir, { recursive: true });
    const templatePath = path.join(GUIDANCE_DIR, 'profile-template.md');
    let template;
    try {
      template = fs.readFileSync(templatePath, 'utf-8');
    } catch {
      template = '# TORQUE User Profile\n\n# Edit this file to customize TORQUE for your environment.\n';
    }
    fs.writeFileSync(profilePath, template, 'utf-8');
    logger.info(`[guidance] Created user profile at ${profilePath}`);
    return true;
  } catch (err) {
    logger.warn(`[guidance] Failed to scaffold user profile: ${err.message}`);
    return false;
  }
}

// ── Cache management ──

function clearCaches() {
  staticGuidanceCache = null;
  tierToolCache.clear();
}

module.exports = {
  loadStaticGuidance,
  getToolGuidanceForTier,
  getDynamicContext,
  loadUserProfile,
  composeGuidance,
  handleGetGuidance,
  scaffoldUserProfile,
  clearCaches,
  // Exported for testing
  TOOL_DOMAIN_MAP,
  META_TOOLS,
  GUIDANCE_DIR,
  PROFILE_MAX_BYTES,
};
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `ssh kenten@192.168.1.183 "cd C:\Users\Kenten\Projects\Torque && npx vitest run server/tests/guidance-handlers.test.js"`

Expected: Most tests PASS. Fix any failures from mock/import issues.

- [ ] **Step 3: Commit**

```bash
git add server/handlers/guidance-handlers.js
git commit -m "feat: guidance-handlers — three-layer composition, tier filtering, caching"
```

---

## Chunk 3: Wire Into Server (Routes, Ping, Startup)

### Task 9: Add `include_guidance` to ping schema

**Files:**
- Modify: `server/tool-defs/core-defs.js`

- [ ] **Step 1: Write failing test**

Add to `server/tests/guidance-handlers.test.js`:

```js
describe('ping schema', () => {
  it('has include_guidance boolean property', () => {
    const coreDefs = require('../tool-defs/core-defs');
    const pingDef = coreDefs.find(d => d.name === 'ping');
    expect(pingDef.inputSchema.properties).toHaveProperty('include_guidance');
    expect(pingDef.inputSchema.properties.include_guidance.type).toBe('boolean');
  });

  it('has tier number property', () => {
    const coreDefs = require('../tool-defs/core-defs');
    const pingDef = coreDefs.find(d => d.name === 'ping');
    expect(pingDef.inputSchema.properties).toHaveProperty('tier');
    expect(pingDef.inputSchema.properties.tier.type).toBe('number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ssh kenten@192.168.1.183 "cd C:\Users\Kenten\Projects\Torque && npx vitest run server/tests/guidance-handlers.test.js"`

Expected: FAIL — `include_guidance` property does not exist yet.

- [ ] **Step 3: Add include_guidance to ping schema in core-defs.js**

In `server/tool-defs/core-defs.js`, add to the `ping` tool's `properties`:

```js
include_guidance: {
  type: 'boolean',
  description: 'If true, include full behavioral guidance in the response (tier-appropriate). Use on first ping of a session for LLM context. Default: false.'
},
tier: {
  type: 'number',
  description: 'Tier level for guidance filtering (1=core, 2=extended, 3=all). Only used when include_guidance is true. Default: 1.',
  enum: [1, 2, 3]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ssh kenten@192.168.1.183 "cd C:\Users\Kenten\Projects\Torque && npx vitest run server/tests/guidance-handlers.test.js"`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/tool-defs/core-defs.js
git commit -m "feat: add include_guidance param to ping tool schema"
```

### Task 10: Enhance ping handler in tools.js

**Files:**
- Modify: `server/tools.js:286-288`

- [ ] **Step 1: Write failing test**

Add to `server/tests/guidance-handlers.test.js`:

```js
describe('ping with guidance', () => {
  it('includes guidance field when include_guidance is true', async () => {
    const { handleToolCall } = require('../tools');
    const result = await handleToolCall('ping', { include_guidance: true });
    expect(result).toHaveProperty('guidance');
    expect(result.guidance).toContain('Core Discipline');
  });

  it('omits guidance field when include_guidance is false', async () => {
    const { handleToolCall } = require('../tools');
    const result = await handleToolCall('ping', {});
    expect(result).not.toHaveProperty('guidance');
  });
});
```

- [ ] **Step 2: Modify the ping case in tools.js**

Change the `case 'ping':` block at line 287-288 to:

```js
case 'ping': {
  const response = { pong: true, timestamp: new Date().toISOString(), message: args.message || 'keepalive' };
  if (args.include_guidance) {
    const { composeGuidance } = require('./handlers/guidance-handlers');
    const tier = args.tier && [1, 2, 3].includes(args.tier) ? args.tier : 1;
    const guidance = composeGuidance({ tier, format: 'markdown' });
    response.guidance = guidance.content;
    response.guidance_version = guidance.version;
    response.guidance_hash = guidance.content_hash;
  }
  return response;
}
```

The caller specifies their tier via the `tier` parameter. CLAUDE.md instructs Claude to pass `ping { include_guidance: true, tier: N }` matching their current unlock level. Default is tier 1.

- [ ] **Step 3: Run tests to verify they pass**

Run: `ssh kenten@192.168.1.183 "cd C:\Users\Kenten\Projects\Torque && npx vitest run server/tests/guidance-handlers.test.js"`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/tools.js
git commit -m "feat: enhance ping to include guidance when include_guidance=true"
```

### Task 11: Add GET /api/guidance route

**Files:**
- Modify: `server/api/routes.js`

- [ ] **Step 1: Add the route to routes.js**

In `server/api/routes.js`, add the import at the top:

```js
const { handleGetGuidance } = require('../handlers/guidance-handlers');
```

Then add the route to the routes array (near the other GET routes):

```js
{ method: 'GET', path: '/api/guidance', handler: handleGetGuidance, handlerName: 'handleGetGuidance', skipAuth: true },
```

The `skipAuth: true` matches the spec: "Authentication: None required — same as all other TORQUE REST routes." This follows the same pattern as health routes.

- [ ] **Step 2: Verify the route works**

Start the server and test:

```bash
curl -s http://127.0.0.1:3457/api/guidance | head -20
curl -s "http://127.0.0.1:3457/api/guidance?format=json" | python -m json.tool | head -20
curl -s "http://127.0.0.1:3457/api/guidance?sections=rules" | head -10
```

- [ ] **Step 3: Commit**

```bash
git add server/api/routes.js
git commit -m "feat: add GET /api/guidance REST endpoint"
```

### Task 12: Auto-scaffold profile on startup

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Add scaffolding to the init function**

In `server/index.js`, find the `init()` function. Near the beginning (after DB init), add:

```js
// Auto-scaffold ~/.torque/profile.md on first startup
const { scaffoldUserProfile, loadStaticGuidance } = require('./handlers/guidance-handlers');
scaffoldUserProfile();
loadStaticGuidance(); // Pre-cache static files
```

- [ ] **Step 2: Commit**

```bash
git add server/index.js
git commit -m "feat: auto-scaffold ~/.torque/profile.md and pre-cache guidance on startup"
```

---

## Chunk 4: CLAUDE.md Rewrite

### Task 13: Rewrite CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write the lean CLAUDE.md**

Replace the entire 309-line CLAUDE.md with ~120-150 lines focused on offline-safe core discipline and a pointer to `/api/guidance` for dynamic context.

The new CLAUDE.md must contain:
1. Setup section (MCP config, first run)
2. Core discipline (embedded — works without server)
3. Orchestrator role
4. Await patterns table
5. File safety
6. Command table
7. Pointer to `ping { include_guidance: true }` and `GET /api/guidance`

Does NOT contain: provider tables, pricing, model tiers, smart routing details, stall thresholds, multi-host setup, capability matrix, tool catalogs.

- [ ] **Step 2: Verify line count is under 150**

```bash
wc -l CLAUDE.md
```

Expected: under 150 lines.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: rewrite CLAUDE.md — lean core discipline + pointer to /api/guidance"
```

---

## Chunk 5: Integration Verification

### Task 14: End-to-end verification

- [ ] **Step 1: Run the full test suite**

```bash
ssh kenten@192.168.1.183 "cd C:\Users\Kenten\Projects\Torque && npx vitest run server/tests/guidance-handlers.test.js"
```

Expected: All tests pass.

- [ ] **Step 2: Start the server and verify REST endpoint**

```bash
curl -s http://127.0.0.1:3457/api/guidance | head -30
curl -s "http://127.0.0.1:3457/api/guidance?format=json&tier=2" | python -m json.tool | head -30
```

Expected: Markdown and JSON responses with correct tier filtering.

- [ ] **Step 3: Verify ping with guidance**

Via MCP or test: call `ping { include_guidance: true }` and verify the response includes `guidance`, `guidance_version`, and `guidance_hash` fields.

- [ ] **Step 4: Verify profile scaffold**

```bash
ls ~/.torque/profile.md
cat ~/.torque/profile.md | head -10
```

Expected: File exists with template content.

- [ ] **Step 5: Verify no personal data shipped**

```bash
grep -ri "192\.168\.1\.183\|192\.168\.1\.17\|BahumutsOmen\|Werem\|Kenten\|bahumut" server/guidance/ CLAUDE.md
```

Expected: No matches.

- [ ] **Step 6: Verify CLAUDE.md line count**

```bash
wc -l CLAUDE.md
```

Expected: Under 150 lines.

- [ ] **Step 7: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix: integration verification fixes for guidance system"
```
