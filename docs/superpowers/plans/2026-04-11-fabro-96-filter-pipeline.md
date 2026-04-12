# Fabro #96: Filter Pipeline (Semantic Kernel)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wrap every prompt send and tool invocation with a **pluggable filter chain**. Each filter receives `(context, next)`, can mutate inputs/outputs, short-circuit with a cancel or cached response, or observe without touching data. Inspired by Semantic Kernel's `IPromptRenderFilter` / `IFunctionInvocationFilter`.

**Architecture:** A single `createFilterPipeline()` module hosts two named chains: `prompt` (wraps `provider.send(prompt, messages)`) and `invocation` (wraps `tool.invoke(args)`). Filters register via `registerFilter({ chain, name, handler, priority })`. At send-time the pipeline composes filters right-to-left into a call tree — classic middleware pattern. Plan 19 (lifecycle hooks) fires at task boundaries; filters fire per prompt / per tool call, inside the boundary.

**Tech Stack:** Pure Node.js. Integrates into existing provider dispatch + MCP tool runner. No new deps.

---

## File Structure

**New files:**
- `server/filters/filter-pipeline.js`
- `server/filters/builtin-filters.js`
- `server/tests/filter-pipeline.test.js`
- `server/tests/builtin-filters.test.js`

**Modified files:**
- `server/providers/dispatch.js` — call `pipeline.runPrompt(ctx, () => provider.send(...))`
- `server/mcp/tool-runner.js` — call `pipeline.runInvocation(ctx, () => tool.handler(...))`
- `server/container.js` — register `filterPipeline` service
- `server/handlers/mcp-tools.js` — `register_filter`, `list_filters`, `unregister_filter`

---

## Task 1: Pipeline core

- [ ] **Step 1: Tests**

Create `server/tests/filter-pipeline.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { createFilterPipeline } = require('../filters/filter-pipeline');

describe('filterPipeline', () => {
  it('runs filters in priority order (higher priority first/outermost)', async () => {
    const pipeline = createFilterPipeline();
    const trace = [];
    pipeline.register({ chain: 'prompt', name: 'a', priority: 10, handler: async (c, next) => { trace.push('a-in'); const r = await next(); trace.push('a-out'); return r; } });
    pipeline.register({ chain: 'prompt', name: 'b', priority: 20, handler: async (c, next) => { trace.push('b-in'); const r = await next(); trace.push('b-out'); return r; } });
    await pipeline.runPrompt({}, async () => { trace.push('core'); return 'ok'; });
    expect(trace).toEqual(['b-in', 'a-in', 'core', 'a-out', 'b-out']);
  });

  it('filter can short-circuit without calling next', async () => {
    const pipeline = createFilterPipeline();
    pipeline.register({ chain: 'prompt', name: 'block', handler: async () => ({ cached: true }) });
    const result = await pipeline.runPrompt({}, async () => ({ cached: false }));
    expect(result.cached).toBe(true);
  });

  it('filter can mutate context and response', async () => {
    const pipeline = createFilterPipeline();
    pipeline.register({ chain: 'invocation', name: 'tag', handler: async (c, next) => {
      c.args = { ...c.args, tagged: true };
      const r = await next();
      return { ...r, wrapped: true };
    } });
    const out = await pipeline.runInvocation({ args: { x: 1 } }, async (c) => ({ received: c.args }));
    expect(out.received).toEqual({ x: 1, tagged: true });
    expect(out.wrapped).toBe(true);
  });

  it('unregister removes a filter', async () => {
    const pipeline = createFilterPipeline();
    pipeline.register({ chain: 'prompt', name: 'f', handler: async () => 'blocked' });
    expect(await pipeline.runPrompt({}, async () => 'core')).toBe('blocked');
    pipeline.unregister({ chain: 'prompt', name: 'f' });
    expect(await pipeline.runPrompt({}, async () => 'core')).toBe('core');
  });

  it('list returns registered filter summaries', () => {
    const pipeline = createFilterPipeline();
    pipeline.register({ chain: 'prompt', name: 'p1', priority: 5, handler: async () => {} });
    pipeline.register({ chain: 'invocation', name: 'i1', priority: 7, handler: async () => {} });
    expect(pipeline.list()).toEqual([
      { chain: 'invocation', name: 'i1', priority: 7 },
      { chain: 'prompt', name: 'p1', priority: 5 },
    ]);
  });

  it('error in filter propagates (not swallowed)', async () => {
    const pipeline = createFilterPipeline();
    pipeline.register({ chain: 'prompt', name: 'boom', handler: async () => { throw new Error('bad'); } });
    await expect(pipeline.runPrompt({}, async () => 'ok')).rejects.toThrow('bad');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/filters/filter-pipeline.js`:

```js
'use strict';

function createFilterPipeline() {
  const filters = { prompt: [], invocation: [] };

  function register({ chain, name, priority = 0, handler }) {
    if (!filters[chain]) throw new Error(`unknown chain: ${chain}`);
    unregister({ chain, name }); // replace if same name
    filters[chain].push({ name, priority, handler });
    filters[chain].sort((a, b) => b.priority - a.priority);
  }

  function unregister({ chain, name }) {
    if (!filters[chain]) return;
    filters[chain] = filters[chain].filter(f => f.name !== name);
  }

  function list() {
    const out = [];
    for (const chain of Object.keys(filters).sort()) {
      for (const f of filters[chain]) out.push({ chain, name: f.name, priority: f.priority });
    }
    return out;
  }

  function compose(chainName, core) {
    const chain = filters[chainName];
    let i = 0;
    return async function dispatch(ctx) {
      if (i >= chain.length) return core(ctx);
      const f = chain[i++];
      return f.handler(ctx, () => dispatch(ctx));
    };
  }

  async function runPrompt(ctx, core) { return compose('prompt', core)(ctx); }
  async function runInvocation(ctx, core) { return compose('invocation', core)(ctx); }

  return { register, unregister, list, runPrompt, runInvocation };
}

module.exports = { createFilterPipeline };
```

Run tests → PASS. Commit: `feat(filters): pluggable prompt/invocation filter pipeline`.

---

## Task 2: Built-in filters + MCP surface

- [ ] **Step 1: Built-in filter tests**

Create `server/tests/builtin-filters.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { createFilterPipeline } = require('../filters/filter-pipeline');
const { registerBuiltins } = require('../filters/builtin-filters');

describe('builtin filters', () => {
  it('pii-redact masks email-like strings in prompt', async () => {
    const p = createFilterPipeline();
    registerBuiltins(p);
    const sample = 'contact me at USER_PLACEHOLDER now';
    const sent = await p.runPrompt({ prompt: sample.replace('USER_PLACEHOLDER', ['foo', '@', 'example', '.', 'test'].join('')) }, async c => c.prompt);
    expect(sent).not.toMatch(/example\.test/);
    expect(sent).toContain('[redacted-email]');
  });

  it('tool-allowlist rejects unknown tools', async () => {
    const p = createFilterPipeline();
    registerBuiltins(p, { allowTools: ['read'] });
    await expect(
      p.runInvocation({ tool: 'write' }, async () => 'never'),
    ).rejects.toThrow(/not allowed/);
  });

  it('rate-limit short-circuits beyond threshold', async () => {
    const p = createFilterPipeline();
    registerBuiltins(p, { rateLimit: { max: 2, windowMs: 1000 } });
    const core = async () => 'ok';
    expect(await p.runInvocation({ tool: 'read' }, core)).toBe('ok');
    expect(await p.runInvocation({ tool: 'read' }, core)).toBe('ok');
    await expect(p.runInvocation({ tool: 'read' }, core)).rejects.toThrow(/rate/);
  });
});
```

- [ ] **Step 2: Implement builtins**

Create `server/filters/builtin-filters.js`:

```js
'use strict';

// Simple email-shaped regex; sufficient for prompt-level redaction smoke tests.
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;

function registerBuiltins(pipeline, opts = {}) {
  pipeline.register({
    chain: 'prompt', name: 'pii-redact', priority: 50,
    handler: async (ctx, next) => {
      if (typeof ctx.prompt === 'string') {
        ctx.prompt = ctx.prompt.replace(EMAIL_RE, '[redacted-email]');
      }
      return next();
    },
  });

  if (opts.allowTools) {
    const allow = new Set(opts.allowTools);
    pipeline.register({
      chain: 'invocation', name: 'tool-allowlist', priority: 100,
      handler: async (ctx, next) => {
        if (!allow.has(ctx.tool)) throw new Error(`tool ${ctx.tool} not allowed`);
        return next();
      },
    });
  }

  if (opts.rateLimit) {
    const { max, windowMs } = opts.rateLimit;
    const hits = [];
    pipeline.register({
      chain: 'invocation', name: 'rate-limit', priority: 90,
      handler: async (ctx, next) => {
        const now = Date.now();
        while (hits.length && now - hits[0] > windowMs) hits.shift();
        if (hits.length >= max) throw new Error('rate exceeded');
        hits.push(now);
        return next();
      },
    });
  }
}

module.exports = { registerBuiltins };
```

Run tests → PASS. Commit: `feat(filters): builtins — pii-redact, tool-allowlist, rate-limit`.

---

## Task 3: Wire into dispatch + MCP tools

- [ ] **Step 1: Container + dispatch**

In `server/container.js`:

```js
const { createFilterPipeline } = require('./filters/filter-pipeline');
container.singleton('filterPipeline', () => createFilterPipeline());
```

In `server/providers/dispatch.js` (where a provider sends a prompt), wrap:

```js
const pipeline = container.get('filterPipeline');
return pipeline.runPrompt({ prompt, messages, provider: name }, async (ctx) => provider.send(ctx.prompt, ctx.messages));
```

In `server/mcp/tool-runner.js`:

```js
const pipeline = container.get('filterPipeline');
return pipeline.runInvocation({ tool: name, args }, async (ctx) => handler(ctx.args));
```

- [ ] **Step 2: MCP tools**

Register in `server/handlers/mcp-tools.js`:

```js
register_filter: {
  description: 'Register a filter in the prompt or invocation chain. The handler runs as JS via vm2 in a restricted context.',
  inputSchema: {
    type: 'object',
    required: ['chain', 'name', 'handler_js'],
    properties: {
      chain: { enum: ['prompt', 'invocation'] },
      name: { type: 'string' },
      priority: { type: 'number' },
      handler_js: { type: 'string', description: 'JS source: async (ctx, next) => { ... return next(); }' },
    },
  },
},
list_filters: { description: 'List registered filters.', inputSchema: { type: 'object' } },
unregister_filter: {
  description: 'Remove a filter by name + chain.',
  inputSchema: { type: 'object', required: ['chain', 'name'], properties: { chain: { enum: ['prompt', 'invocation'] }, name: { type: 'string' } } },
},
```

Smoke: start TORQUE, register PII filter, send a prompt containing an email-shaped token → confirm it's redacted in the provider log.

Commit: `feat(filters): wire into dispatch + expose register_filter MCP tools`.
