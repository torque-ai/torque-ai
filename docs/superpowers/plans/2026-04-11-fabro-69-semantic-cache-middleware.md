# Fabro #69: Semantic Cache + Guardrails Middleware (Portkey)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend TORQUE's caching (Plan 65) with **semantic caching** — near-duplicate prompts return the stored result without re-invoking the provider. Layer a **guardrail middleware chain** around provider calls: pre-execution validators (PII filter, prompt-injection detector, scope check) and post-execution validators (toxicity scan, hallucination gate). Each middleware returns `pass | fail_open | fail_closed`. Inspired by Portkey.

**Architecture:** Semantic cache wraps Plan 65's exact cache: before the exact-key lookup, compute an embedding of the prompt, check the `semantic_cache` index (vector sim > threshold → hit). On miss, fall through to exact cache, then provider. Guardrails are registered per-plugin (Plan 50) and attached to tasks via `guardrails: ['pii_redact', 'prompt_injection', 'toxicity']`. Pre-hooks run before provider dispatch; post-hooks run after output; each can block, allow-with-modification, or warn.

**Tech Stack:** Node.js, existing embedding provider, Ajv for guardrail configs. Builds on plans 50 (plugin catalog), 52 (connections), 65 (cache).

---

## File Structure

**New files:**
- `server/migrations/0NN-semantic-cache.sql`
- `server/caching/semantic-cache.js`
- `server/guardrails/guardrail-chain.js`
- `server/guardrails/built-in/pii-redact.js`
- `server/guardrails/built-in/prompt-injection.js`
- `server/guardrails/built-in/toxicity.js`
- `server/tests/semantic-cache.test.js`
- `server/tests/guardrail-chain.test.js`

**Modified files:**
- `server/execution/task-startup.js` — run pre-guardrails + semantic-cache check
- `server/execution/task-finalizer.js` — run post-guardrails
- `server/tool-defs/task-defs.js` — accept `guardrails`, `semantic_cache`

---

## Task 1: Semantic cache

- [ ] **Step 1: Migration**

`server/migrations/0NN-semantic-cache.sql`:

```sql
CREATE TABLE IF NOT EXISTS semantic_cache (
  semantic_id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL,                 -- FK to task_cache.cache_key (exact)
  embedding_json TEXT NOT NULL,
  prompt_snippet TEXT,                     -- for debugging
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  hit_count INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 2: Tests**

Create `server/tests/semantic-cache.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createSemanticCache } = require('../caching/semantic-cache');

describe('semanticCache', () => {
  let db, cache, embedMock;
  beforeEach(() => {
    db = setupTestDb();
    embedMock = vi.fn(async (text) => {
      // Simple token-presence embedding for deterministic tests
      const tokens = ['cat', 'dog', 'bird', 'fish', 'red', 'blue'];
      return tokens.map(t => text.includes(t) ? 1 : 0);
    });
    cache = createSemanticCache({ db, embed: embedMock, threshold: 0.8 });
  });

  it('store + find exact returns cache_key', async () => {
    await cache.store({ cacheKey: 'k1', prompt: 'a red cat' });
    const hit = await cache.find('a red cat');
    expect(hit?.cache_key).toBe('k1');
  });

  it('find similar (above threshold) returns nearest key', async () => {
    await cache.store({ cacheKey: 'k1', prompt: 'the red cat' });
    const hit = await cache.find('a red cat sat');
    expect(hit?.cache_key).toBe('k1');
  });

  it('find dissimilar (below threshold) returns null', async () => {
    await cache.store({ cacheKey: 'k1', prompt: 'a red cat' });
    const miss = await cache.find('blue fish swimming');
    expect(miss).toBeNull();
  });

  it('hit_count increments on hit', async () => {
    await cache.store({ cacheKey: 'k1', prompt: 'a red cat' });
    await cache.find('a red cat');
    await cache.find('the red cat');
    const row = db.prepare('SELECT hit_count FROM semantic_cache LIMIT 1').get();
    expect(row.hit_count).toBeGreaterThanOrEqual(1);
  });

  it('respects custom threshold', async () => {
    const strict = createSemanticCache({ db, embed: embedMock, threshold: 0.99 });
    await strict.store({ cacheKey: 'k1', prompt: 'a red cat' });
    const miss = await strict.find('the red dog');
    expect(miss).toBeNull();
  });
});
```

- [ ] **Step 3: Implement**

Create `server/caching/semantic-cache.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function createSemanticCache({ db, embed, threshold = 0.92 }) {
  async function store({ cacheKey, prompt }) {
    const embedding = await embed(prompt);
    const id = `sem_${randomUUID().slice(0, 12)}`;
    db.prepare(`INSERT INTO semantic_cache (semantic_id, cache_key, embedding_json, prompt_snippet) VALUES (?,?,?,?)`)
      .run(id, cacheKey, JSON.stringify(embedding), prompt.slice(0, 200));
  }

  async function find(prompt) {
    const queryEmbed = await embed(prompt);
    const rows = db.prepare('SELECT * FROM semantic_cache').all();
    let best = null;
    for (const r of rows) {
      const e = JSON.parse(r.embedding_json);
      const score = cosine(queryEmbed, e);
      if (score >= threshold && (!best || score > best.score)) {
        best = { ...r, score };
      }
    }
    if (best) {
      db.prepare('UPDATE semantic_cache SET hit_count = hit_count + 1 WHERE semantic_id = ?').run(best.semantic_id);
      return { cache_key: best.cache_key, score: best.score };
    }
    return null;
  }

  return { store, find };
}

module.exports = { createSemanticCache };
```

Run tests → PASS. Commit: `feat(cache): semantic cache with cosine-similarity lookup`.

---

## Task 2: Guardrail chain

- [ ] **Step 1: Tests**

Create `server/tests/guardrail-chain.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { runGuardrails } = require('../guardrails/guardrail-chain');

describe('runGuardrails', () => {
  it('all pass → overall pass', async () => {
    const registry = {
      a: async () => ({ ok: true }),
      b: async () => ({ ok: true }),
    };
    const r = await runGuardrails({ specs: [{ name: 'a' }, { name: 'b' }], input: 'text', registry });
    expect(r.ok).toBe(true);
    expect(r.modifications).toEqual([]);
  });

  it('fail_closed blocks and short-circuits', async () => {
    const spy = vi.fn(async () => ({ ok: false, action: 'fail_closed', reason: 'pii found' }));
    const after = vi.fn(async () => ({ ok: true }));
    const registry = { block: spy, after };
    const r = await runGuardrails({ specs: [{ name: 'block' }, { name: 'after' }], input: 'text', registry });
    expect(r.ok).toBe(false);
    expect(r.blocked_by).toBe('block');
    expect(after).not.toHaveBeenCalled();
  });

  it('fail_open warns but passes + records warning', async () => {
    const registry = {
      warn: async () => ({ ok: false, action: 'fail_open', reason: 'weak signal' }),
    };
    const r = await runGuardrails({ specs: [{ name: 'warn' }], input: 'text', registry });
    expect(r.ok).toBe(true);
    expect(r.warnings).toContainEqual(expect.objectContaining({ name: 'warn', reason: 'weak signal' }));
  });

  it('modification replaces input for subsequent guardrails', async () => {
    const a = vi.fn(async (input) => ({ ok: true, modified: input.replace('ssn:123', '[REDACTED]') }));
    const b = vi.fn(async (input) => ({ ok: true }));
    const r = await runGuardrails({
      specs: [{ name: 'a' }, { name: 'b' }],
      input: 'here is ssn:123 for you',
      registry: { a, b },
    });
    expect(r.ok).toBe(true);
    expect(r.final_input).toMatch(/\[REDACTED\]/);
    expect(b).toHaveBeenCalledWith(expect.stringContaining('[REDACTED]'), expect.anything());
  });

  it('unknown guardrail name causes fail_closed', async () => {
    const r = await runGuardrails({ specs: [{ name: 'bogus' }], input: 'x', registry: {} });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/guardrails/guardrail-chain.js`:

```js
'use strict';

async function runGuardrails({ specs, input, context = {}, registry, phase = 'pre' }) {
  const warnings = [];
  const modifications = [];
  let current = input;

  for (const spec of (specs || [])) {
    const fn = registry[spec.name];
    if (!fn) {
      return { ok: false, blocked_by: spec.name, reason: `unknown guardrail '${spec.name}'`, warnings };
    }
    let result;
    try {
      result = await fn(current, { spec, phase, context });
    } catch (err) {
      return { ok: false, blocked_by: spec.name, reason: err.message, warnings };
    }

    if (result.modified !== undefined && result.modified !== current) {
      modifications.push({ name: spec.name, before_length: current.length, after_length: result.modified.length });
      current = result.modified;
    }
    if (result.ok) continue;
    const action = result.action || 'fail_closed';
    if (action === 'fail_open') {
      warnings.push({ name: spec.name, reason: result.reason });
      continue;
    }
    return { ok: false, blocked_by: spec.name, reason: result.reason, warnings };
  }

  return { ok: true, final_input: current, modifications, warnings };
}

module.exports = { runGuardrails };
```

Run tests → PASS. Commit: `feat(guardrails): chain with pass/fail_open/fail_closed + modification support`.

---

## Task 3: Built-in guardrails + wiring

- [ ] **Step 1: Built-in guardrails**

Create `server/guardrails/built-in/pii-redact.js`:

```js
'use strict';

const PATTERNS = [
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[EMAIL]' },
  { name: 'ssn',   re: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN]' },
  { name: 'phone', re: /\b\+?\d{1,3}?[-. ]?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g, replacement: '[PHONE]' },
  { name: 'credit_card', re: /\b(?:\d[ -]*?){13,16}\b/g, replacement: '[CC]' },
];

async function piiRedact(input) {
  let output = input;
  let found = [];
  for (const p of PATTERNS) {
    if (p.re.test(output)) {
      found.push(p.name);
      output = output.replace(p.re, p.replacement);
    }
  }
  if (found.length > 0) return { ok: true, modified: output, detected: found };
  return { ok: true };
}

module.exports = piiRedact;
```

Create `server/guardrails/built-in/prompt-injection.js`:

```js
'use strict';

// Simple pattern-based detector for common prompt injection signatures.
// For production, pair this with an LLM-based detector registered via plugin.
const SIGNATURES = [
  /ignore (all )?previous instructions/i,
  /disregard (the )?(system )?prompt/i,
  /you are now [^.]*/i,
  /print (the )?(system )?prompt/i,
  /\<\/?(system|user|assistant)\>/i,
];

async function promptInjection(input) {
  const hits = SIGNATURES.filter(re => re.test(input));
  if (hits.length === 0) return { ok: true };
  return { ok: false, action: 'fail_closed', reason: `suspicious pattern: ${hits[0].source}` };
}

module.exports = promptInjection;
```

Create `server/guardrails/built-in/toxicity.js` — placeholder that returns `{ok:true}` by default; real implementation calls a classifier through a plugin.

- [ ] **Step 2: Wire into task lifecycle**

In `server/execution/task-startup.js`:

```js
const meta = parseTaskMetadata(task);
const guardrails = meta.guardrails || [];
if (guardrails.length > 0) {
  const { runGuardrails } = require('../guardrails/guardrail-chain');
  const registry = buildGuardrailRegistry();
  const preResult = await runGuardrails({
    specs: guardrails.filter(g => g.phase === 'pre' || !g.phase).map(g => ({ name: g.name, ...g.options })),
    input: task.task_description,
    registry,
    phase: 'pre',
  });
  if (!preResult.ok) {
    db.prepare(`UPDATE tasks SET status = 'blocked', error_output = ? WHERE task_id = ?`).run(`Guardrail '${preResult.blocked_by}': ${preResult.reason}`, taskId);
    addTaskTag(taskId, 'guardrail:blocked');
    return { blocked: true };
  }
  task.task_description = preResult.final_input;
  task.__post_guardrails = guardrails.filter(g => g.phase === 'post');
  for (const w of preResult.warnings) addTaskTag(taskId, `guardrail:warn:${w.name}`);
}
```

In `server/execution/task-finalizer.js` on success:

```js
if (task.__post_guardrails) {
  const { runGuardrails } = require('../guardrails/guardrail-chain');
  const result = await runGuardrails({
    specs: task.__post_guardrails,
    input: typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput),
    registry: buildGuardrailRegistry(),
    phase: 'post',
  });
  if (!result.ok) {
    db.prepare(`UPDATE tasks SET status = 'failed', error_output = ? WHERE task_id = ?`).run(`Post-guardrail '${result.blocked_by}': ${result.reason}`, taskId);
    return;
  }
  finalOutput = result.final_input;
}
```

- [ ] **Step 3: Semantic cache hook**

In `server/execution/task-startup.js` after exact cache check, if `meta.semantic_cache` is true:

```js
const semantic = defaultContainer.get('semanticCache');
const hit = await semantic.find(task.task_description);
if (hit) {
  const cached = defaultContainer.get('taskCache').get(hit.cache_key);
  if (cached) {
    // Treat as cache hit
    db.prepare(`UPDATE tasks SET status = 'completed', output = ?, completed_at = datetime('now') WHERE task_id = ?`).run(cached.output, taskId);
    addTaskTag(taskId, `cache:semantic_hit:${hit.score.toFixed(2)}`);
    return { cached: true };
  }
}
```

After successful completion, also store the prompt's embedding in `semantic_cache` pointing at the same exact-cache key.

`await_restart`. Smoke: submit task with `semantic_cache: true` and prompt "write a haiku about cats". Submit near-duplicate "write a haiku about felines". Confirm second hits cache. Submit task with `guardrails: [{name:'pii_redact',phase:'pre'}]` containing an email. Confirm prompt is redacted before dispatch.

Commit: `feat(cache+guardrails): semantic cache + middleware chain wiring`.
