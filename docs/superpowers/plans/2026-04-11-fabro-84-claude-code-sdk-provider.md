# Fabro #84: Claude Code SDK Provider + Layered Permissions (Claude Agent SDK)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Formalize TORQUE's integration with Claude Code by implementing an official **Claude Code SDK provider** with: (a) subprocess lifecycle + streaming message API, (b) **layered permission evaluation** (hooks → settings → mode → runtime callback), (c) **filesystem-native skills + session resume/fork**, (d) programmatic **subagent dispatch** with isolated context. Inspired by Anthropic's Claude Agent SDK.

**Architecture:** A new provider adapter `server/providers/claude-code-sdk.js` that wraps Claude Code invocation. It speaks the streaming events schema (Plan 83), honors `.claude/skills/` and `.claude/commands/` on the task's working directory, and enforces a permission decision chain: (1) in-process hooks inspect the pending tool call and can allow/deny/modify; (2) `.claude/settings.json` declarative rules; (3) `permission_mode` (auto/acceptEdits/plan/bypassPermissions); (4) runtime `canUseTool` callback. Sessions are persisted by ID so tasks can resume a prior conversation or fork a new branch.

**Tech Stack:** Node.js, existing Claude Code CLI, Plan 83 streaming kernel, Plan 19 lifecycle hooks. Builds on plans 19 (hooks), 26 (crew/subagent), 50 (plugins), 83 (streaming).

---

## File Structure

**New files:**
- `server/providers/claude-code-sdk.js` — main adapter
- `server/providers/claude-code/session-store.js`
- `server/providers/claude-code/permission-chain.js`
- `server/providers/claude-code/skills-loader.js`
- `server/tests/permission-chain.test.js`
- `server/tests/session-store.test.js`
- `server/tests/skills-loader.test.js`

**Modified files:**
- `server/providers/registry.js` — register `claude-code-sdk` alongside existing `claude-cli`
- `server/handlers/mcp-tools.js` — `dispatch_subagent`, `resume_session`, `fork_session`

---

## Task 1: Permission chain

- [ ] **Step 1: Tests**

Create `server/tests/permission-chain.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { evaluatePermission } = require('../providers/claude-code/permission-chain');

describe('evaluatePermission', () => {
  it('allowed_tools in settings → allow', async () => {
    const r = await evaluatePermission({
      toolName: 'Read',
      args: { path: 'a.js' },
      settings: { allowed_tools: ['Read'], disallowed_tools: [] },
      mode: 'auto',
      hooks: [],
    });
    expect(r.decision).toBe('allow');
    expect(r.reason).toMatch(/settings\.allowed_tools/);
  });

  it('disallowed_tools in settings → deny (even in bypassPermissions)', async () => {
    const r = await evaluatePermission({
      toolName: 'Bash',
      args: { cmd: 'rm -rf /' },
      settings: { allowed_tools: [], disallowed_tools: ['Bash'] },
      mode: 'bypassPermissions',
      hooks: [],
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toMatch(/disallowed/);
  });

  it('hook returning deny short-circuits', async () => {
    const hook = vi.fn(async () => ({ decision: 'deny', reason: 'pii detected' }));
    const r = await evaluatePermission({
      toolName: 'Read',
      args: { path: 'a.js' },
      settings: { allowed_tools: ['Read'], disallowed_tools: [] },
      mode: 'auto',
      hooks: [hook],
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toMatch(/pii/);
  });

  it('hook returning modify swaps args', async () => {
    const hook = vi.fn(async ({ args }) => ({ decision: 'modify', args: { path: args.path + '.redacted' } }));
    const r = await evaluatePermission({
      toolName: 'Read',
      args: { path: 'a.js' },
      settings: { allowed_tools: ['Read'], disallowed_tools: [] },
      mode: 'auto',
      hooks: [hook],
    });
    expect(r.decision).toBe('allow');
    expect(r.modified_args).toEqual({ path: 'a.js.redacted' });
  });

  it('mode=plan → deny writes, allow reads', async () => {
    expect((await evaluatePermission({ toolName: 'Edit', args: {}, settings: {}, mode: 'plan', hooks: [] })).decision).toBe('deny');
    expect((await evaluatePermission({ toolName: 'Read', args: {}, settings: {}, mode: 'plan', hooks: [] })).decision).toBe('allow');
  });

  it('mode=acceptEdits → auto-allow Edit without prompt', async () => {
    const r = await evaluatePermission({ toolName: 'Edit', args: {}, settings: {}, mode: 'acceptEdits', hooks: [] });
    expect(r.decision).toBe('allow');
    expect(r.reason).toMatch(/acceptEdits/);
  });

  it('fallback to runtime canUseTool callback when undecided', async () => {
    const canUseTool = vi.fn(async () => ({ decision: 'allow' }));
    const r = await evaluatePermission({
      toolName: 'Custom', args: {}, settings: {}, mode: 'auto', hooks: [], canUseTool,
    });
    expect(canUseTool).toHaveBeenCalled();
    expect(r.decision).toBe('allow');
  });

  it('no decision anywhere → default deny', async () => {
    const r = await evaluatePermission({
      toolName: 'Bash', args: {}, settings: {}, mode: 'auto', hooks: [],
    });
    expect(r.decision).toBe('deny');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/providers/claude-code/permission-chain.js`:

```js
'use strict';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Bash']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

async function evaluatePermission({ toolName, args, settings = {}, mode = 'auto', hooks = [], canUseTool = null }) {
  // 1. Hooks run first — they can deny, allow, or modify args
  let effectiveArgs = args;
  for (const hook of hooks) {
    const r = await hook({ toolName, args: effectiveArgs, mode });
    if (!r) continue;
    if (r.decision === 'deny') return { decision: 'deny', reason: r.reason || 'hook denied', source: 'hook' };
    if (r.decision === 'modify') effectiveArgs = r.args;
    if (r.decision === 'allow') return { decision: 'allow', reason: r.reason || 'hook allowed', source: 'hook', modified_args: effectiveArgs };
  }

  // 2. disallowed_tools is absolute
  if ((settings.disallowed_tools || []).includes(toolName)) {
    return { decision: 'deny', reason: 'settings.disallowed_tools', source: 'settings' };
  }

  // 3. allowed_tools is explicit allow
  if ((settings.allowed_tools || []).includes(toolName)) {
    return { decision: 'allow', reason: 'settings.allowed_tools', source: 'settings', modified_args: effectiveArgs };
  }

  // 4. Mode-based rules
  if (mode === 'bypassPermissions') {
    return { decision: 'allow', reason: 'mode=bypassPermissions', source: 'mode', modified_args: effectiveArgs };
  }
  if (mode === 'plan') {
    if (READ_TOOLS.has(toolName)) return { decision: 'allow', reason: 'mode=plan (read-only)', source: 'mode', modified_args: effectiveArgs };
    if (WRITE_TOOLS.has(toolName)) return { decision: 'deny', reason: 'mode=plan blocks writes', source: 'mode' };
  }
  if (mode === 'acceptEdits' && WRITE_TOOLS.has(toolName)) {
    return { decision: 'allow', reason: 'mode=acceptEdits', source: 'mode', modified_args: effectiveArgs };
  }

  // 5. Fallback callback
  if (canUseTool) {
    const r = await canUseTool({ toolName, args: effectiveArgs });
    if (r?.decision) return { ...r, source: 'callback', modified_args: r.modified_args || effectiveArgs };
  }

  // 6. Default
  return { decision: 'deny', reason: 'no rule matched (default deny)', source: 'default' };
}

module.exports = { evaluatePermission };
```

Run tests → PASS. Commit: `feat(claude-code): permission chain with hook/settings/mode/callback order`.

---

## Task 2: Session store + skills loader

- [ ] **Step 1: Session store (file-backed)**

Create `server/providers/claude-code/session-store.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function createSessionStore({ rootDir }) {
  fs.mkdirSync(rootDir, { recursive: true });

  function create({ name = null, metadata = null } = {}) {
    const id = `sess_${randomUUID().slice(0, 12)}`;
    const dir = path.join(rootDir, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name, metadata, created_at: new Date().toISOString() }));
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '');
    return id;
  }

  function append(id, message) {
    const p = path.join(rootDir, id, 'messages.jsonl');
    fs.appendFileSync(p, JSON.stringify(message) + '\n');
  }

  function readAll(id) {
    const p = path.join(rootDir, id, 'messages.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  function fork(sourceId, { name = null } = {}) {
    const messages = readAll(sourceId);
    const newId = create({ name: name || `fork-of-${sourceId}`, metadata: { parent_session_id: sourceId } });
    for (const m of messages) append(newId, m);
    return newId;
  }

  function exists(id) {
    return fs.existsSync(path.join(rootDir, id, 'meta.json'));
  }

  function list() {
    if (!fs.existsSync(rootDir)) return [];
    return fs.readdirSync(rootDir).filter(d => d.startsWith('sess_')).map(id => ({
      session_id: id, meta: JSON.parse(fs.readFileSync(path.join(rootDir, id, 'meta.json'), 'utf8')),
    }));
  }

  return { create, append, readAll, fork, exists, list };
}

module.exports = { createSessionStore };
```

- [ ] **Step 2: Skills loader**

Create `server/providers/claude-code/skills-loader.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

// Walks .claude/skills/*/SKILL.md and returns { name, description, body, path }.
// Used by the provider to list available skills before each task turn.
function loadSkills(workingDir) {
  const skillsDir = path.join(workingDir, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  const skills = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    try {
      const parsed = matter(fs.readFileSync(skillFile, 'utf8'));
      skills.push({
        name: parsed.data.name || entry.name,
        description: parsed.data.description || '',
        body: parsed.content,
        path: skillFile,
      });
    } catch { /* skip malformed */ }
  }
  return skills;
}

module.exports = { loadSkills };
```

Tests + implementation straightforward. Commit: `feat(claude-code): session store + skills loader`.

---

## Task 3: Provider adapter + MCP

- [ ] **Step 1: Provider adapter**

Create `server/providers/claude-code-sdk.js`. The adapter spawns Claude Code with `--print` + `--output-format stream-json`, streams chunks, evaluates permissions on each tool call, manages sessions via `--resume <id>` or `--fork-session`, and yields events in the Plan 83 streaming event shape.

- [ ] **Step 2: MCP tools**

```js
dispatch_subagent: {
  description: 'Dispatch a Claude Code subagent with isolated context + restricted tool list + optional skill. Returns subagent result only.',
  inputSchema: { type: 'object', required: ['prompt'], properties: {
    prompt: { type: 'string' },
    model: { type: 'string' },
    allowed_tools: { type: 'array', items: { type: 'string' } },
    disallowed_tools: { type: 'array', items: { type: 'string' } },
    mode: { type: 'string', enum: ['auto','acceptEdits','plan','bypassPermissions'] },
    skill: { type: 'string' },
    timeout_ms: { type: 'integer' },
  } },
},
resume_session: { description: 'Resume a prior Claude Code session by ID.', inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' } } } },
fork_session: { description: 'Fork a prior session into a new branch.', inputSchema: { type: 'object', required: ['source_session_id'], properties: { source_session_id: { type: 'string' }, name: { type: 'string' } } } },
list_sessions: { description: 'List Claude Code sessions.', inputSchema: { type: 'object' } },
```

`await_restart`. Smoke: `dispatch_subagent({prompt:'summarize README', allowed_tools:['Read','Glob'], mode:'plan'})` — confirm Write/Edit denied, Read succeeds, subagent returns final text. Then `fork_session` from that session + add a follow-up — confirm the fork has parent's history plus new turn.

Commit: `feat(claude-code): SDK-style provider with subagent dispatch + session resume/fork`.
