# Fabro #102: Procedural Memory + Prompt Optimizer (LangMem)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend TORQUE's memory subsystem (Plan 47 agent-memory, Plan 66 auto-extracted-memory, Plan 77 temporal-graph-memory, Plan 94 chroma-archival) with a **classification by cognitive role** — `semantic` / `episodic` / `procedural` — plus a **prompt optimizer** that treats system prompts as procedural memory that can evolve from feedback. Supports **hot-path** tool-driven writes and **background** reflective consolidation via a debounced `ReflectionExecutor`. Inspired by LangMem.

**Architecture:** Three small modules:
1. `memory-kind.js` — classifier + shape enforcement for the three memory kinds.
2. `prompt-optimizer.js` — takes a trajectory + feedback and proposes an updated prompt via one of three strategies (`metaprompt` / `gradient` / `prompt_memory`).
3. `reflection-executor.js` — debounced background runner that reads pending transcripts and extracts/consolidates memories.

Memories share a single `memories` table with a `kind` column and namespace support (e.g., `{user_id}/{project_id}/...`).

**Tech Stack:** Node.js, better-sqlite3. Existing embedding pipeline. No new deps.

---

## File Structure

**New files:**
- `server/migrations/0XX-memory-kind-namespace.sql`
- `server/memory/memory-kind.js`
- `server/memory/prompt-optimizer.js`
- `server/memory/reflection-executor.js`
- `server/tests/memory-kind.test.js`
- `server/tests/prompt-optimizer.test.js`
- `server/tests/reflection-executor.test.js`

**Modified files:**
- `server/memory/store.js` (existing Plan 47) — add `kind`, `namespace` columns
- `server/prompts/resolver.js` — look up the live prompt from `memories` where `kind='procedural'`
- `server/handlers/mcp-tools.js` — `save_memory`, `optimize_prompt`, `search_memory`, `reflect_on_run`

---

## Task 1: Kind classifier + namespace schema

- [ ] **Step 1: Migration**

Create `server/migrations/0XX-memory-kind-namespace.sql`:

```sql
ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'semantic';
ALTER TABLE memories ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_memories_kind_namespace ON memories(kind, namespace);
```

- [ ] **Step 2: Tests**

Create `server/tests/memory-kind.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { validateMemory, resolveNamespace, MEMORY_KINDS } = require('../memory/memory-kind');

describe('memory kinds', () => {
  it('MEMORY_KINDS exposes all three', () => {
    expect(MEMORY_KINDS).toEqual(['semantic', 'episodic', 'procedural']);
  });

  it('semantic memory requires content string', () => {
    expect(() => validateMemory({ kind: 'semantic', content: 'fact' })).not.toThrow();
    expect(() => validateMemory({ kind: 'semantic' })).toThrow(/content/);
  });

  it('episodic memory requires an episode object with input/output/rationale', () => {
    const ok = { kind: 'episodic', content: JSON.stringify({ input: 'q', output: 'a', rationale: 'why' }) };
    expect(() => validateMemory(ok)).not.toThrow();
    expect(() => validateMemory({ kind: 'episodic', content: JSON.stringify({ input: 'q' }) })).toThrow(/output/);
  });

  it('procedural memory requires role + prompt', () => {
    expect(() => validateMemory({ kind: 'procedural', role: 'planner', content: 'prompt body' })).not.toThrow();
    expect(() => validateMemory({ kind: 'procedural', content: 'prompt body' })).toThrow(/role/);
  });

  it('resolveNamespace interpolates template vars', () => {
    expect(resolveNamespace('{user_id}/{org_id}', { user_id: 'alice', org_id: 'acme' })).toBe('alice/acme');
  });

  it('resolveNamespace leaves literal slashes and unknown vars alone', () => {
    expect(resolveNamespace('shared/global', {})).toBe('shared/global');
    expect(resolveNamespace('{user_id}/mem', {})).toBe('{user_id}/mem');
  });
});
```

- [ ] **Step 3: Implement**

Create `server/memory/memory-kind.js`:

```js
'use strict';

const MEMORY_KINDS = ['semantic', 'episodic', 'procedural'];

function validateMemory(m) {
  if (!MEMORY_KINDS.includes(m.kind)) throw new Error(`unknown kind: ${m.kind}`);
  if (m.kind === 'semantic') {
    if (typeof m.content !== 'string' || !m.content.length) throw new Error('semantic memory requires content');
  } else if (m.kind === 'episodic') {
    let parsed;
    try { parsed = JSON.parse(m.content); } catch { throw new Error('episodic memory content must be JSON'); }
    for (const k of ['input', 'output', 'rationale']) {
      if (parsed[k] === undefined) throw new Error(`episodic memory missing ${k}`);
    }
  } else if (m.kind === 'procedural') {
    if (!m.role) throw new Error('procedural memory requires role');
    if (typeof m.content !== 'string' || !m.content.length) throw new Error('procedural memory requires content (prompt body)');
  }
}

function resolveNamespace(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

module.exports = { MEMORY_KINDS, validateMemory, resolveNamespace };
```

Run tests → PASS. Commit: `feat(memory): kind classifier + namespace templating + schema migration`.

---

## Task 2: Prompt optimizer

- [ ] **Step 1: Tests**

Create `server/tests/prompt-optimizer.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { createPromptOptimizer } = require('../memory/prompt-optimizer');

describe('promptOptimizer', () => {
  it('metaprompt strategy returns a rewritten prompt from an LLM adapter', async () => {
    const llm = { propose: async ({ current, feedback }) => `${current}\n\n[revised] ${feedback[0]}` };
    const opt = createPromptOptimizer({ strategy: 'metaprompt', llm });
    const out = await opt.optimize({ current: 'Be concise.', trajectory: [], feedback: ['add examples'] });
    expect(out.prompt).toContain('[revised] add examples');
    expect(out.strategy).toBe('metaprompt');
  });

  it('prompt_memory strategy appends successful trajectories as examples', async () => {
    const opt = createPromptOptimizer({ strategy: 'prompt_memory', llm: null });
    const out = await opt.optimize({
      current: 'Answer the user.',
      trajectory: [{ input: 'hi', output: 'hello', score: 1 }],
      feedback: [],
    });
    expect(out.prompt).toContain('hi');
    expect(out.prompt).toContain('hello');
  });

  it('gradient strategy increments a version + feedback delta', async () => {
    const llm = { propose: async ({ current, feedback }) => `${current} / revised: ${feedback.length} signals` };
    const opt = createPromptOptimizer({ strategy: 'gradient', llm });
    const out = await opt.optimize({ current: 'P0', trajectory: [], feedback: ['too verbose', 'missed step 3'] });
    expect(out.prompt).toMatch(/revised: 2 signals/);
  });

  it('returns unchanged prompt when no feedback and no successful trajectories', async () => {
    const opt = createPromptOptimizer({ strategy: 'prompt_memory', llm: null });
    const out = await opt.optimize({ current: 'P', trajectory: [], feedback: [] });
    expect(out.prompt).toBe('P');
    expect(out.changed).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/memory/prompt-optimizer.js`:

```js
'use strict';

function createPromptOptimizer({ strategy, llm }) {
  async function optimize({ current, trajectory = [], feedback = [] }) {
    if (strategy === 'prompt_memory') {
      const successful = trajectory.filter(t => (t.score ?? 0) > 0);
      if (successful.length === 0 && feedback.length === 0) return { prompt: current, strategy, changed: false };
      const examples = successful.map(t => `Input: ${t.input}\nOutput: ${t.output}`).join('\n---\n');
      const joined = examples ? `${current}\n\nExamples:\n${examples}` : current;
      return { prompt: joined, strategy, changed: examples.length > 0 };
    }
    if (strategy === 'metaprompt' || strategy === 'gradient') {
      if (!llm || typeof llm.propose !== 'function') throw new Error(`${strategy} strategy requires llm.propose()`);
      const prompt = await llm.propose({ current, feedback, trajectory });
      return { prompt, strategy, changed: prompt !== current };
    }
    throw new Error(`unknown strategy: ${strategy}`);
  }
  return { optimize, strategy };
}

module.exports = { createPromptOptimizer };
```

Run tests → PASS. Commit: `feat(memory): prompt-optimizer — metaprompt/gradient/prompt_memory`.

---

## Task 3: Reflection executor + MCP

- [ ] **Step 1: Executor tests**

Create `server/tests/reflection-executor.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { createReflectionExecutor } = require('../memory/reflection-executor');

describe('reflectionExecutor', () => {
  it('debounces repeated submit calls within window', async () => {
    const reflect = vi.fn(async () => {});
    const exec = createReflectionExecutor({ reflect, debounceMs: 50 });
    exec.submit('run1');
    exec.submit('run1');
    exec.submit('run1');
    await new Promise(r => setTimeout(r, 80));
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(reflect).toHaveBeenCalledWith('run1');
  });

  it('separate keys reflect independently', async () => {
    const reflect = vi.fn(async () => {});
    const exec = createReflectionExecutor({ reflect, debounceMs: 30 });
    exec.submit('a');
    exec.submit('b');
    await new Promise(r => setTimeout(r, 60));
    expect(reflect).toHaveBeenCalledTimes(2);
  });

  it('cancel before fire prevents reflect', async () => {
    const reflect = vi.fn(async () => {});
    const exec = createReflectionExecutor({ reflect, debounceMs: 50 });
    exec.submit('x');
    exec.cancel('x');
    await new Promise(r => setTimeout(r, 80));
    expect(reflect).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

Create `server/memory/reflection-executor.js`:

```js
'use strict';

function createReflectionExecutor({ reflect, debounceMs = 500 }) {
  const timers = new Map();

  function submit(key) {
    if (timers.has(key)) clearTimeout(timers.get(key));
    const t = setTimeout(async () => {
      timers.delete(key);
      try { await reflect(key); } catch (err) { console.error('reflect failed', err); }
    }, debounceMs);
    timers.set(key, t);
  }

  function cancel(key) {
    if (timers.has(key)) { clearTimeout(timers.get(key)); timers.delete(key); }
  }

  function cancelAll() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  return { submit, cancel, cancelAll };
}

module.exports = { createReflectionExecutor };
```

- [ ] **Step 3: MCP surface + wire**

In `server/handlers/mcp-tools.js`:

```js
save_memory: {
  description: 'Save a memory of kind semantic|episodic|procedural with namespace support.',
  inputSchema: {
    type: 'object',
    required: ['kind', 'content'],
    properties: {
      kind: { enum: ['semantic', 'episodic', 'procedural'] },
      content: { type: 'string', description: 'Body; for episodic pass JSON {input,output,rationale}.' },
      role: { type: 'string', description: 'Required when kind=procedural (e.g. planner, reviewer).' },
      namespace: { type: 'string', description: 'Template like {user_id}/{project_id}; resolved on save.' },
      vars: { type: 'object' },
      embedding: { type: 'array', items: { type: 'number' } },
    },
  },
},
search_memory: {
  description: 'Search memories by kind + namespace + optional similarity query.',
  inputSchema: { type: 'object', properties: { kind: { type: 'string' }, namespace: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } } },
},
optimize_prompt: {
  description: 'Run a prompt optimizer over a role\'s current prompt using the given trajectory + feedback.',
  inputSchema: {
    type: 'object',
    required: ['role', 'strategy'],
    properties: {
      role: { type: 'string' },
      strategy: { enum: ['metaprompt', 'gradient', 'prompt_memory'] },
      trajectory: { type: 'array' },
      feedback: { type: 'array', items: { type: 'string' } },
      apply: { type: 'boolean', description: 'If true, overwrite the procedural memory with the optimized prompt.' },
    },
  },
},
reflect_on_run: {
  description: 'Schedule a debounced background reflection pass over a run_id; extracts episodic memories + proposed procedural updates.',
  inputSchema: { type: 'object', required: ['run_id'], properties: { run_id: { type: 'string' } } },
},
```

Wire `server/prompts/resolver.js` to read `memories` where `kind='procedural' AND role=? AND namespace=?` and fall back to code-defined default when absent.

Smoke: save 3 episodic memories, call `optimize_prompt` with `strategy: prompt_memory, apply: true` → confirm the live prompt for that role now contains the example lines.

Commit: `feat(memory): procedural memory + prompt-optimizer + reflection-executor MCP`.
