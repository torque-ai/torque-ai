# Fabro #64: Build-Time DAG Validation (Haystack)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Validate every workflow DAG at **build time** (when the spec is submitted), not run time. Check: (a) all node IDs unique, (b) all `depends_on`/`consumes` references resolve to actual nodes/assets, (c) no cycles, (d) input/output socket types compatible on each edge, (e) producing-asset nodes match consuming-asset nodes. Reject invalid workflows with precise errors before dispatch. Inspired by Haystack's connect-time validation.

**Architecture:** A new `workflow-validator.js` runs over a parsed workflow spec. It builds the dependency graph, topologically sorts it (failing if cyclic), and walks each edge comparing producer output schema to consumer input schema (Plan 23). For assets (Plan 34) it verifies the asset key appears in some node's `produces` list before any node consumes it. All errors are aggregated (not first-fail) and returned with node IDs + path. MCP tool + REST endpoint expose validation without submission.

**Tech Stack:** Node.js, Ajv. Builds on plans 1 (workflow-as-code), 23 (typed signatures), 34 (assets).

---

## File Structure

**New files:**
- `server/validation/workflow-validator.js`
- `server/validation/cycle-detector.js`
- `server/validation/socket-compat.js`
- `server/tests/workflow-validator.test.js`
- `server/tests/cycle-detector.test.js`
- `server/tests/socket-compat.test.js`

**Modified files:**
- `server/handlers/workflow/index.js` — call validator before insert
- `server/handlers/mcp-tools.js` — `validate_workflow` tool

---

## Task 1: Cycle detector

- [ ] **Step 1: Tests**

Create `server/tests/cycle-detector.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { detectCycles, topologicalSort } = require('../validation/cycle-detector');

describe('detectCycles', () => {
  it('returns empty array for acyclic DAG', () => {
    const edges = [['a','b'],['b','c'],['a','c']];
    expect(detectCycles(edges)).toEqual([]);
  });

  it('finds a simple 2-node cycle', () => {
    const edges = [['a','b'],['b','a']];
    const cycles = detectCycles(edges);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0].sort()).toEqual(['a','b']);
  });

  it('finds a 3-node cycle', () => {
    const cycles = detectCycles([['a','b'],['b','c'],['c','a']]);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0].sort()).toEqual(['a','b','c']);
  });

  it('finds multiple disjoint cycles', () => {
    const cycles = detectCycles([['a','b'],['b','a'],['c','d'],['d','c']]);
    expect(cycles.length).toBe(2);
  });
});

describe('topologicalSort', () => {
  it('returns nodes in dependency order', () => {
    const nodes = ['a','b','c','d'];
    const edges = [['a','b'],['a','c'],['b','d'],['c','d']];
    const order = topologicalSort(nodes, edges);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('throws on cycle', () => {
    expect(() => topologicalSort(['a','b'], [['a','b'],['b','a']])).toThrow(/cycle/i);
  });

  it('handles disconnected nodes', () => {
    const order = topologicalSort(['a','b','c'], []);
    expect(order.sort()).toEqual(['a','b','c']);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/validation/cycle-detector.js`:

```js
'use strict';

function buildAdjacency(edges) {
  const adj = new Map();
  for (const [from, to] of edges) {
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from).add(to);
  }
  return adj;
}

function detectCycles(edges) {
  const adj = buildAdjacency(edges);
  const nodes = new Set();
  for (const [from, to] of edges) { nodes.add(from); nodes.add(to); }

  const cycles = [];
  const visited = new Set();
  const stack = new Set();
  const parent = new Map();

  function dfs(node) {
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    for (const next of (adj.get(node) || [])) {
      if (stack.has(next)) {
        // Found cycle. Walk back from node through parent chain to 'next'.
        const cycle = [next];
        let cur = node;
        while (cur !== next && cur !== undefined) {
          cycle.push(cur);
          cur = parent.get(cur);
          if (cycle.length > nodes.size) break;
        }
        if (!cycles.some(c => sameSet(c, cycle))) cycles.push(cycle);
      } else if (!visited.has(next)) {
        parent.set(next, node);
        dfs(next);
      }
    }
    stack.delete(node);
  }

  for (const node of nodes) dfs(node);
  return cycles;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every(x => s.has(x));
}

function topologicalSort(nodes, edges) {
  const adj = buildAdjacency(edges);
  const inDegree = new Map(nodes.map(n => [n, 0]));
  for (const [, to] of edges) inDegree.set(to, (inDegree.get(to) || 0) + 1);

  const queue = nodes.filter(n => (inDegree.get(n) || 0) === 0);
  const order = [];
  while (queue.length > 0) {
    const node = queue.shift();
    order.push(node);
    for (const next of (adj.get(node) || [])) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) throw new Error('cycle detected in topological sort');
  return order;
}

module.exports = { detectCycles, topologicalSort };
```

Run tests → PASS. Commit: `feat(validation): cycle detector + topological sort`.

---

## Task 2: Socket compatibility

- [ ] **Step 1: Tests**

Create `server/tests/socket-compat.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { socketsCompatible } = require('../validation/socket-compat');

describe('socketsCompatible', () => {
  it('identical scalar types are compatible', () => {
    expect(socketsCompatible({ type: 'string' }, { type: 'string' })).toEqual({ ok: true });
    expect(socketsCompatible({ type: 'number' }, { type: 'number' })).toEqual({ ok: true });
  });

  it('mismatched scalar types are incompatible', () => {
    const r = socketsCompatible({ type: 'string' }, { type: 'number' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/string.*number/i);
  });

  it('consumer=object accepting subset of producer=object is compatible', () => {
    const producer = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' } } };
    const consumer = { type: 'object', properties: { a: { type: 'string' } } };
    expect(socketsCompatible(producer, consumer).ok).toBe(true);
  });

  it('consumer requiring field producer does not emit is incompatible', () => {
    const producer = { type: 'object', properties: { a: { type: 'string' } } };
    const consumer = { type: 'object', required: ['b'], properties: { b: { type: 'number' } } };
    const r = socketsCompatible(producer, consumer);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/b/);
  });

  it('producer=array<string> compatible with consumer=array<string>', () => {
    expect(socketsCompatible({ type: 'array', items: { type: 'string' } }, { type: 'array', items: { type: 'string' } }).ok).toBe(true);
  });

  it('producer=array<string> incompatible with consumer=array<number>', () => {
    expect(socketsCompatible({ type: 'array', items: { type: 'string' } }, { type: 'array', items: { type: 'number' } }).ok).toBe(false);
  });

  it('missing schemas on either side are treated as any-compatible', () => {
    expect(socketsCompatible(null, { type: 'string' }).ok).toBe(true);
    expect(socketsCompatible({ type: 'string' }, null).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/validation/socket-compat.js`:

```js
'use strict';

function socketsCompatible(producerSchema, consumerSchema) {
  if (!producerSchema || !consumerSchema) return { ok: true };

  if (producerSchema.type !== consumerSchema.type) {
    return { ok: false, reason: `type mismatch: producer=${producerSchema.type} consumer=${consumerSchema.type}` };
  }

  if (producerSchema.type === 'array') {
    return socketsCompatible(producerSchema.items, consumerSchema.items);
  }

  if (producerSchema.type === 'object') {
    const required = consumerSchema.required || [];
    const producerProps = producerSchema.properties || {};
    const consumerProps = consumerSchema.properties || {};
    for (const r of required) {
      if (!(r in producerProps)) {
        return { ok: false, reason: `consumer requires '${r}' but producer does not emit it` };
      }
    }
    for (const [name, subSchema] of Object.entries(consumerProps)) {
      if (name in producerProps) {
        const r = socketsCompatible(producerProps[name], subSchema);
        if (!r.ok) return { ok: false, reason: `field ${name}: ${r.reason}` };
      }
    }
    return { ok: true };
  }

  return { ok: true };
}

module.exports = { socketsCompatible };
```

Run tests → PASS. Commit: `feat(validation): socket-compat checker for edge type safety`.

---

## Task 3: Workflow validator

- [ ] **Step 1: Tests**

Create `server/tests/workflow-validator.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { validateWorkflow } = require('../validation/workflow-validator');

describe('validateWorkflow', () => {
  it('passes a simple valid DAG', () => {
    const r = validateWorkflow({
      name: 'ok',
      tasks: [
        { id: 'a', task_description: 'step a' },
        { id: 'b', task_description: 'step b', depends_on: ['a'] },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects duplicate node IDs', () => {
    const r = validateWorkflow({
      name: 'dup',
      tasks: [{ id: 'a' }, { id: 'a' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/duplicate/i);
  });

  it('rejects depends_on referencing unknown node', () => {
    const r = validateWorkflow({
      name: 'bad',
      tasks: [{ id: 'a', depends_on: ['ghost'] }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/ghost/);
  });

  it('rejects cycles', () => {
    const r = validateWorkflow({
      name: 'cyc',
      tasks: [
        { id: 'a', depends_on: ['b'] },
        { id: 'b', depends_on: ['a'] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /cycle/i.test(e))).toBe(true);
  });

  it('rejects socket mismatch on edge', () => {
    const r = validateWorkflow({
      name: 'types',
      tasks: [
        { id: 'a', output_schema: { type: 'string' } },
        { id: 'b', depends_on: ['a'], input_schema: { type: 'number' } },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /type mismatch/i.test(e))).toBe(true);
  });

  it('rejects consumer requiring an asset no node produces', () => {
    const r = validateWorkflow({
      name: 'asset',
      tasks: [
        { id: 'a' },
        { id: 'b', consumes: ['code:ghost.js'] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /code:ghost/.test(e))).toBe(true);
  });

  it('aggregates ALL errors, not just the first', () => {
    const r = validateWorkflow({
      name: 'many',
      tasks: [
        { id: 'a' }, { id: 'a' }, // duplicate
        { id: 'c', depends_on: ['ghost'] },
      ],
    });
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/validation/workflow-validator.js`:

```js
'use strict';
const { detectCycles } = require('./cycle-detector');
const { socketsCompatible } = require('./socket-compat');

function validateWorkflow(spec) {
  const errors = [];
  if (!spec || !Array.isArray(spec.tasks)) {
    return { ok: false, errors: ['workflow must have tasks array'] };
  }
  const tasks = spec.tasks;

  // 1. Duplicate IDs
  const ids = new Set();
  const tasksById = new Map();
  for (const t of tasks) {
    if (!t.id) { errors.push(`task without id`); continue; }
    if (ids.has(t.id)) errors.push(`duplicate node id: ${t.id}`);
    ids.add(t.id);
    tasksById.set(t.id, t);
  }

  // 2. depends_on references exist
  const edges = [];
  for (const t of tasks) {
    for (const dep of (t.depends_on || [])) {
      if (!ids.has(dep)) errors.push(`node ${t.id} depends_on unknown node: ${dep}`);
      else edges.push([dep, t.id]);
    }
  }

  // 3. Cycles
  const cycles = detectCycles(edges);
  for (const cyc of cycles) errors.push(`cycle detected: ${cyc.join(' → ')}`);

  // 4. Socket compatibility along each edge
  for (const [from, to] of edges) {
    const producer = tasksById.get(from);
    const consumer = tasksById.get(to);
    if (producer?.output_schema && consumer?.input_schema) {
      const r = socketsCompatible(producer.output_schema, consumer.input_schema);
      if (!r.ok) errors.push(`edge ${from} → ${to}: type mismatch — ${r.reason}`);
    }
  }

  // 5. Asset produces/consumes coverage
  const allProduces = new Set();
  for (const t of tasks) for (const a of (t.produces || [])) allProduces.add(a);
  for (const t of tasks) {
    for (const a of (t.consumes || [])) {
      if (!allProduces.has(a)) errors.push(`node ${t.id} consumes asset '${a}' but no node produces it`);
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validateWorkflow };
```

Run tests → PASS. Commit: `feat(validation): workflow-validator with duplicate/missing/cycle/type/asset checks`.

---

## Task 4: Wire into workflow handler + MCP

- [ ] **Step 1: Reject on submit**

In `server/handlers/workflow/index.js` at the top of `createWorkflow`:

```js
const { validateWorkflow } = require('../../validation/workflow-validator');
const validation = validateWorkflow(params);
if (!validation.ok) {
  return makeError(ErrorCodes.INVALID_PARAM, `Workflow validation failed:\n${validation.errors.map(e => '- ' + e).join('\n')}`);
}
```

- [ ] **Step 2: MCP tool**

In `server/tool-defs/`:

```js
validate_workflow: {
  description: 'Validate a workflow definition without submitting it. Returns {ok, errors} with precise messages for duplicate ids, unresolved dependencies, cycles, type mismatches, and missing asset producers.',
  inputSchema: {
    type: 'object',
    required: ['workflow'],
    properties: { workflow: { type: 'object' } },
  },
},
```

Handler:

```js
case 'validate_workflow':
  return require('../validation/workflow-validator').validateWorkflow(args.workflow);
```

`await_restart`. Smoke: call `validate_workflow` with a deliberately broken spec (dup id + cycle + bad dep). Confirm returns `ok: false` with all three errors listed. Then submit a good workflow — confirm accepted.

Commit: `feat(validation): workflow handler + MCP tool enforce build-time validation`.
