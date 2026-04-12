# Fabro #72: Functions + Variants + Optimization Loop (TensorZero)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce a **Function** abstraction — a stable task identity (e.g., `extract_invoice_line_items`) — under which many **Variants** compete: different prompts, models, temperatures, decoding strategies. Every production call records which variant ran. Scores (Plan 68) attach to the variant. An **optimizer** periodically proposes new variants from winning traces and promotes the best by rolling deployment label. Inspired by TensorZero.

**Architecture:** Three layers:
1. **Function registry** — named stable contract with `input_schema`, `output_schema`, default_variant.
2. **Variant store** — each variant is `{ function_id, variant_id, prompt, model, provider, temperature, tools, created_from }`. Deployment labels (Plan 68 prompt labels pattern) point traffic to variants.
3. **Optimizer** — reads recent traces + scores for a function, proposes a new variant from winners (prompt refinement, model swap, added few-shot examples, or fine-tune recipe). Human approval required before auto-promotion.

**Tech Stack:** Node.js, better-sqlite3, existing provider dispatch. Builds on plans 23 (signatures), 51 (revisions), 54 (fine-tune), 68 (observability).

---

## File Structure

**New files:**
- `server/migrations/0NN-functions-variants.sql`
- `server/functions/function-store.js`
- `server/functions/variant-store.js`
- `server/functions/variant-selector.js`
- `server/functions/optimizer.js`
- `server/tests/function-store.test.js`
- `server/tests/variant-store.test.js`
- `server/tests/variant-selector.test.js`
- `server/tests/optimizer.test.js`

**Modified files:**
- `server/tool-defs/task-defs.js` — accept `function_name` as alternative to raw prompt
- `server/execution/task-startup.js` — resolve function + variant before dispatch
- `server/handlers/mcp-tools.js` — CRUD for functions + variants + optimizer

---

## Task 1: Migration + stores

- [ ] **Step 1: Migration**

`server/migrations/0NN-functions-variants.sql`:

```sql
CREATE TABLE IF NOT EXISTS torque_functions (
  function_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  input_schema_json TEXT,
  output_schema_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS function_variants (
  variant_id TEXT PRIMARY KEY,
  function_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  prompt_template TEXT NOT NULL,
  temperature REAL,
  extra_params_json TEXT,
  created_by TEXT,
  parent_variant_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (function_id) REFERENCES torque_functions(function_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS variant_labels (
  function_id TEXT NOT NULL,
  label TEXT NOT NULL,                 -- 'production' | 'canary' | 'staging'
  variant_id TEXT NOT NULL,
  traffic_pct REAL DEFAULT 1.0,        -- For canary splits
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (function_id, label)
);

CREATE TABLE IF NOT EXISTS variant_invocations (
  invocation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  function_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  input_hash TEXT,
  output_preview TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_variant_invocations_variant ON variant_invocations(function_id, variant_id);
CREATE INDEX IF NOT EXISTS idx_variant_invocations_time ON variant_invocations(created_at);
```

- [ ] **Step 2: Tests for both stores**

Create `server/tests/variant-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createFunctionStore } = require('../functions/function-store');
const { createVariantStore } = require('../functions/variant-store');

describe('functions + variants', () => {
  let db, fnStore, varStore;
  beforeEach(() => {
    db = setupTestDb();
    fnStore = createFunctionStore({ db });
    varStore = createVariantStore({ db });
  });

  it('register function + create variant + set label', () => {
    const fnId = fnStore.register({ name: 'extract_name', inputSchema: { type: 'object' } });
    const v1 = varStore.create({ functionId: fnId, name: 'v1-codex', provider: 'codex', prompt: 'extract the name from: {{input}}' });
    varStore.setLabel(fnId, 'production', v1);
    expect(varStore.resolveByLabel(fnId, 'production').variant_id).toBe(v1);
  });

  it('setLabel overwrites prior label', () => {
    const fnId = fnStore.register({ name: 'f' });
    const a = varStore.create({ functionId: fnId, name: 'a', provider: 'codex', prompt: 'x' });
    const b = varStore.create({ functionId: fnId, name: 'b', provider: 'codex', prompt: 'y' });
    varStore.setLabel(fnId, 'production', a);
    varStore.setLabel(fnId, 'production', b);
    expect(varStore.resolveByLabel(fnId, 'production').variant_id).toBe(b);
  });

  it('listVariants returns all variants for a function', () => {
    const fnId = fnStore.register({ name: 'f' });
    varStore.create({ functionId: fnId, name: 'a', provider: 'codex', prompt: 'x' });
    varStore.create({ functionId: fnId, name: 'b', provider: 'ollama', prompt: 'y' });
    expect(varStore.listForFunction(fnId)).toHaveLength(2);
  });

  it('recordInvocation persists trace for optimizer', () => {
    const fnId = fnStore.register({ name: 'f' });
    const v = varStore.create({ functionId: fnId, name: 'v', provider: 'codex', prompt: 'x' });
    varStore.recordInvocation({ taskId: 't1', functionId: fnId, variantId: v, outputPreview: 'out', durationMs: 123 });
    const rows = db.prepare('SELECT * FROM variant_invocations WHERE function_id = ?').all(fnId);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Implement both stores**

Create `server/functions/function-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createFunctionStore({ db }) {
  function register({ name, description = null, inputSchema = null, outputSchema = null }) {
    const existing = db.prepare('SELECT function_id FROM torque_functions WHERE name = ?').get(name);
    if (existing) return existing.function_id;
    const id = `fn_${randomUUID().slice(0, 12)}`;
    db.prepare(`INSERT INTO torque_functions (function_id, name, description, input_schema_json, output_schema_json) VALUES (?,?,?,?,?)`)
      .run(id, name, description, inputSchema && JSON.stringify(inputSchema), outputSchema && JSON.stringify(outputSchema));
    return id;
  }
  function getByName(name) { return db.prepare('SELECT * FROM torque_functions WHERE name = ?').get(name) || null; }
  function get(id) { return db.prepare('SELECT * FROM torque_functions WHERE function_id = ?').get(id) || null; }
  function list() { return db.prepare('SELECT * FROM torque_functions ORDER BY name').all(); }
  return { register, getByName, get, list };
}

module.exports = { createFunctionStore };
```

Create `server/functions/variant-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createVariantStore({ db }) {
  function create({ functionId, name, provider, model = null, prompt, temperature = null, extraParams = null, createdBy = null, parentVariantId = null }) {
    const id = `var_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO function_variants (variant_id, function_id, name, provider, model, prompt_template, temperature, extra_params_json, created_by, parent_variant_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, functionId, name, provider, model, prompt, temperature, extraParams && JSON.stringify(extraParams), createdBy, parentVariantId);
    return id;
  }
  function setLabel(functionId, label, variantId, { trafficPct = 1.0 } = {}) {
    db.prepare(`
      INSERT OR REPLACE INTO variant_labels (function_id, label, variant_id, traffic_pct, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(functionId, label, variantId, trafficPct);
  }
  function resolveByLabel(functionId, label) {
    const row = db.prepare(`
      SELECT v.* FROM function_variants v
      JOIN variant_labels l ON v.variant_id = l.variant_id
      WHERE l.function_id = ? AND l.label = ?
    `).get(functionId, label);
    return row || null;
  }
  function listForFunction(functionId) {
    return db.prepare('SELECT * FROM function_variants WHERE function_id = ? ORDER BY created_at DESC').all(functionId);
  }
  function recordInvocation({ taskId, functionId, variantId, inputHash = null, outputPreview = null, durationMs = null }) {
    const id = `inv_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO variant_invocations (invocation_id, task_id, function_id, variant_id, input_hash, output_preview, duration_ms)
      VALUES (?,?,?,?,?,?,?)
    `).run(id, taskId, functionId, variantId, inputHash, outputPreview?.slice(0, 500), durationMs);
  }
  return { create, setLabel, resolveByLabel, listForFunction, recordInvocation };
}

module.exports = { createVariantStore };
```

Run tests → PASS. Commit: `feat(functions): function + variant stores with labels + invocation tracking`.

---

## Task 2: Variant selector (resolves label + traffic split)

- [ ] **Step 1: Tests**

Create `server/tests/variant-selector.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createFunctionStore } = require('../functions/function-store');
const { createVariantStore } = require('../functions/variant-store');
const { createVariantSelector } = require('../functions/variant-selector');

describe('variantSelector.pick', () => {
  let db, fnStore, varStore, selector;
  beforeEach(() => {
    db = setupTestDb();
    fnStore = createFunctionStore({ db });
    varStore = createVariantStore({ db });
    selector = createVariantSelector({ db });
  });

  it('picks production variant when no canary is set', () => {
    const fnId = fnStore.register({ name: 'f' });
    const v = varStore.create({ functionId: fnId, name: 'v', provider: 'codex', prompt: 'x' });
    varStore.setLabel(fnId, 'production', v);
    expect(selector.pick({ functionId: fnId }).variant_id).toBe(v);
  });

  it('splits traffic between production and canary by traffic_pct', () => {
    const fnId = fnStore.register({ name: 'f' });
    const prod = varStore.create({ functionId: fnId, name: 'prod', provider: 'codex', prompt: 'x' });
    const can = varStore.create({ functionId: fnId, name: 'can',  provider: 'codex', prompt: 'y' });
    varStore.setLabel(fnId, 'production', prod);
    varStore.setLabel(fnId, 'canary', can, { trafficPct: 0.1 });
    // Run 1000 picks and confirm canary gets ~10%
    let canaryHits = 0;
    for (let i = 0; i < 1000; i++) {
      if (selector.pick({ functionId: fnId }).variant_id === can) canaryHits++;
    }
    expect(canaryHits).toBeGreaterThan(50);
    expect(canaryHits).toBeLessThan(200);
  });

  it('stable pick given seed reproduces same variant', () => {
    const fnId = fnStore.register({ name: 'f' });
    const a = varStore.create({ functionId: fnId, name: 'a', provider: 'codex', prompt: 'x' });
    const b = varStore.create({ functionId: fnId, name: 'b', provider: 'codex', prompt: 'y' });
    varStore.setLabel(fnId, 'production', a);
    varStore.setLabel(fnId, 'canary', b, { trafficPct: 0.5 });
    const p1 = selector.pick({ functionId: fnId, seed: 'stable-key' });
    const p2 = selector.pick({ functionId: fnId, seed: 'stable-key' });
    expect(p1.variant_id).toBe(p2.variant_id);
  });

  it('throws when function has no labeled variants', () => {
    const fnId = fnStore.register({ name: 'f' });
    expect(() => selector.pick({ functionId: fnId })).toThrow(/no labeled variant/i);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/functions/variant-selector.js`:

```js
'use strict';
const crypto = require('crypto');

function createVariantSelector({ db }) {
  function pick({ functionId, seed = null }) {
    const labels = db.prepare(`
      SELECT l.label, l.variant_id, l.traffic_pct, v.*
      FROM variant_labels l JOIN function_variants v ON l.variant_id = v.variant_id
      WHERE l.function_id = ?
    `).all(functionId);

    const prod = labels.find(l => l.label === 'production');
    const canary = labels.find(l => l.label === 'canary');

    if (!prod && !canary) {
      throw new Error(`Function ${functionId} has no labeled variant`);
    }

    const roll = seed
      ? (parseInt(crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) / 0xffffffff)
      : Math.random();

    if (canary && roll < canary.traffic_pct) return canary;
    return prod || canary;
  }

  return { pick };
}

module.exports = { createVariantSelector };
```

Run tests → PASS. Commit: `feat(functions): variant selector with canary traffic split`.

---

## Task 3: Optimizer (proposes new variants from winners)

- [ ] **Step 1: Tests**

Create `server/tests/optimizer.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createFunctionStore } = require('../functions/function-store');
const { createVariantStore } = require('../functions/variant-store');
const { createOptimizer } = require('../functions/optimizer');

describe('optimizer.propose', () => {
  let db, fnStore, varStore, opt;
  beforeEach(() => {
    db = setupTestDb();
    fnStore = createFunctionStore({ db });
    varStore = createVariantStore({ db });
    opt = createOptimizer({
      db,
      callModel: vi.fn(async () => ({ refined_prompt: 'improved prompt', rationale: 'added examples' })),
    });
  });

  it('proposes a child variant based on highest-scored parent', async () => {
    const fnId = fnStore.register({ name: 'f' });
    const v1 = varStore.create({ functionId: fnId, name: 'v1', provider: 'codex', prompt: 'basic prompt' });
    varStore.recordInvocation({ taskId: 't1', functionId: fnId, variantId: v1, outputPreview: 'good answer' });
    db.prepare(`INSERT INTO scores (score_id, subject_type, subject_id, name, value, source) VALUES ('s1','variant_invocation','t1','quality',0.9,'llm_judge')`).run();

    const r = await opt.propose({ functionId: fnId });
    expect(r.new_variant_id).toMatch(/^var_/);
    const child = db.prepare('SELECT * FROM function_variants WHERE variant_id = ?').get(r.new_variant_id);
    expect(child.parent_variant_id).toBe(v1);
    expect(child.prompt_template).toBe('improved prompt');
  });

  it('returns null when there are no scored invocations yet', async () => {
    const fnId = fnStore.register({ name: 'f' });
    const r = await opt.propose({ functionId: fnId });
    expect(r.new_variant_id).toBeNull();
    expect(r.reason).toMatch(/no scored/i);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/functions/optimizer.js`:

```js
'use strict';

const REFINEMENT_PROMPT = `You are optimizing an AI function. The best-performing variant has this prompt:

---
{{parent_prompt}}
---

Here are 3 high-scoring input/output pairs from production:
{{examples}}

Propose a refined prompt that should do even better. Return JSON: { "refined_prompt": "...", "rationale": "..." }.`;

function createOptimizer({ db, callModel, variantStore, logger = console }) {
  async function propose({ functionId }) {
    // Find highest-scored variant in last N invocations
    const winner = db.prepare(`
      SELECT v.variant_id, v.prompt_template, AVG(s.value) AS mean_score, COUNT(s.score_id) AS score_count
      FROM function_variants v
      LEFT JOIN variant_invocations inv ON v.variant_id = inv.variant_id
      LEFT JOIN scores s ON s.subject_id = inv.task_id AND s.subject_type = 'task'
      WHERE v.function_id = ? AND s.value IS NOT NULL
      GROUP BY v.variant_id
      HAVING score_count >= 3
      ORDER BY mean_score DESC LIMIT 1
    `).get(functionId);

    if (!winner) return { new_variant_id: null, reason: 'no scored variants with enough data' };

    // Fetch 3 exemplar invocations
    const examples = db.prepare(`
      SELECT inv.output_preview FROM variant_invocations inv
      WHERE inv.variant_id = ? ORDER BY inv.created_at DESC LIMIT 3
    `).all(winner.variant_id);

    const prompt = REFINEMENT_PROMPT
      .replace('{{parent_prompt}}', winner.prompt_template)
      .replace('{{examples}}', examples.map((e, i) => `[${i + 1}] ${e.output_preview}`).join('\n'));

    const result = await callModel({ prompt });
    if (!result?.refined_prompt) return { new_variant_id: null, reason: 'model returned no refined_prompt' };

    const fn = db.prepare('SELECT * FROM torque_functions WHERE function_id = ?').get(functionId);
    const parent = db.prepare('SELECT * FROM function_variants WHERE variant_id = ?').get(winner.variant_id);
    const newId = variantStore?.create?.({
      functionId,
      name: `${parent.name}-v${Date.now()}`,
      provider: parent.provider,
      model: parent.model,
      prompt: result.refined_prompt,
      temperature: parent.temperature,
      parentVariantId: winner.variant_id,
      createdBy: 'optimizer',
    });
    return {
      new_variant_id: newId,
      parent_variant_id: winner.variant_id,
      rationale: result.rationale,
      suggested_label: 'canary',
      suggested_traffic_pct: 0.1,
    };
  }

  return { propose };
}

module.exports = { createOptimizer };
```

Run tests → PASS. Commit: `feat(optimizer): proposes child variants from highest-scoring parent + examples`.

---

## Task 4: Task integration + MCP tools

- [ ] **Step 1: Resolve function + variant on submission**

In `server/execution/task-startup.js`:

```js
const meta = parseTaskMetadata(task);
if (meta.function_name) {
  const fn = defaultContainer.get('functionStore').getByName(meta.function_name);
  if (!fn) throw new Error(`Unknown function: ${meta.function_name}`);
  const variant = defaultContainer.get('variantSelector').pick({
    functionId: fn.function_id, seed: taskId,
  });
  task.provider = variant.provider;
  task.model = variant.model;
  task.task_description = renderTemplate(variant.prompt_template, meta.function_input || {});
  task.__function_id = fn.function_id;
  task.__variant_id = variant.variant_id;
}
```

In `task-finalizer.js` on success:

```js
if (task.__function_id && task.__variant_id) {
  defaultContainer.get('variantStore').recordInvocation({
    taskId, functionId: task.__function_id, variantId: task.__variant_id,
    outputPreview: typeof finalOutput === 'string' ? finalOutput.slice(0, 500) : JSON.stringify(finalOutput).slice(0, 500),
    durationMs: task.duration_ms,
  });
}
```

- [ ] **Step 2: MCP tools**

```js
register_function: { description: 'Register a function with input/output schemas.', inputSchema: {...} },
create_variant: { description: 'Create a variant (prompt, model, provider) for a function.', inputSchema: {...} },
label_variant: { description: 'Point a label (production, canary) at a variant with optional traffic %.', inputSchema: {...} },
propose_optimization: { description: 'Ask the optimizer to propose a refined variant from production traces.', inputSchema: { type: 'object', required: ['function_name'], properties: { function_name: { type: 'string' } } } },
```

`await_restart`. Smoke: register `extract_name` function, create variant v1, label as production. Submit 10 tasks with `function_name: 'extract_name'`, record scores. Call `propose_optimization` — confirm new variant created with improved prompt and 10% canary label.

Commit: `feat(functions): task integration + MCP for register/variant/label/optimize`.
