# Fabro #71: FSM-Guided Structured Generation (Outlines)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When TORQUE's provider supports logit-masked constrained decoding (llama.cpp, vLLM with `guided_json`, Ollama with JSON mode), compile a task's `output_schema` into a **constraint** that's enforced **pre-hoc** at generation time — not just validated post-hoc (Plan 61 SAP). For black-box providers, fall back to SAP. Unified type contract drives both paths. Inspired by Outlines.

**Architecture:** A new `constraint-compiler.js` takes a JSON Schema, `Literal` union, regex, or enum and emits a backend-specific constraint: `{ kind: 'json_schema', schema }` for vLLM's `guided_json`, `{ kind: 'regex', pattern }` for llama.cpp's grammar, or just `{ kind: 'json_mode' }` for Ollama. A `structured-provider-adapter.js` wraps each provider: when the provider supports a constraint, it's passed in the request; otherwise the provider runs freeform and the response goes through Plan 61's SAP as the fallback.

**Tech Stack:** Node.js, existing provider adapters. Builds on plans 23 (typed signatures), 50 (plugin catalog), 59 (validators), 61 (SAP).

---

## File Structure

**New files:**
- `server/constraints/constraint-compiler.js`
- `server/constraints/backend-adapters.js` — per-provider translation
- `server/constraints/structured-provider-adapter.js` — wraps any provider
- `server/tests/constraint-compiler.test.js`
- `server/tests/structured-provider-adapter.test.js`

**Modified files:**
- `server/providers/ollama.js` — accept constraint param → JSON mode / format param
- `server/providers/codex.js` — no constraint (passthrough, SAP fallback)
- `server/providers/anthropic.js` — no constraint (passthrough, SAP fallback)

---

## Task 1: Constraint compiler

- [ ] **Step 1: Tests**

Create `server/tests/constraint-compiler.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { compileConstraint } = require('../constraints/constraint-compiler');

describe('compileConstraint', () => {
  it('JSON Schema → {kind: json_schema, schema}', () => {
    const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
    const c = compileConstraint({ output_schema: schema });
    expect(c.kind).toBe('json_schema');
    expect(c.schema).toEqual(schema);
  });

  it('Literal union of strings → {kind: regex, pattern: alternation}', () => {
    const c = compileConstraint({ literal_set: ['red', 'green', 'blue'] });
    expect(c.kind).toBe('regex');
    expect(c.pattern).toBe('^(red|green|blue)$');
  });

  it('Literal set with special regex chars is escaped', () => {
    const c = compileConstraint({ literal_set: ['a.b', 'c+d'] });
    expect(c.pattern).toBe('^(a\\.b|c\\+d)$');
  });

  it('Explicit regex passes through', () => {
    const c = compileConstraint({ regex: '^\\d{3}-\\d{2}-\\d{4}$' });
    expect(c.kind).toBe('regex');
    expect(c.pattern).toBe('^\\d{3}-\\d{2}-\\d{4}$');
  });

  it('No constraint input returns null', () => {
    expect(compileConstraint({})).toBeNull();
  });

  it('Both schema + literal_set: schema wins, literal ignored', () => {
    const c = compileConstraint({
      output_schema: { type: 'object' },
      literal_set: ['a'],
    });
    expect(c.kind).toBe('json_schema');
  });

  it('integer-only schema → {kind: regex, pattern: ^-?\\d+$}', () => {
    const c = compileConstraint({ output_schema: { type: 'integer' } });
    expect(c.kind).toBe('regex');
    expect(c.pattern).toBe('^-?\\d+$');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/constraints/constraint-compiler.js`:

```js
'use strict';

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function compileConstraint({ output_schema, literal_set, regex }) {
  if (regex) {
    return { kind: 'regex', pattern: regex };
  }
  if (output_schema) {
    // Simple scalars: compile to regex for finer control when backend supports it.
    if (output_schema.type === 'integer') return { kind: 'regex', pattern: '^-?\\d+$' };
    if (output_schema.type === 'number')  return { kind: 'regex', pattern: '^-?\\d+(\\.\\d+)?$' };
    if (output_schema.type === 'boolean') return { kind: 'regex', pattern: '^(true|false)$' };
    // Object/array/compound: use json_schema
    return { kind: 'json_schema', schema: output_schema };
  }
  if (Array.isArray(literal_set) && literal_set.length > 0) {
    const alts = literal_set.map(escapeRegex).join('|');
    return { kind: 'regex', pattern: `^(${alts})$` };
  }
  return null;
}

module.exports = { compileConstraint, escapeRegex };
```

Run tests → PASS. Commit: `feat(constraints): compile schema/literal/regex into backend-neutral constraint`.

---

## Task 2: Backend adapters + provider wrapper

- [ ] **Step 1: Backend adapters**

Create `server/constraints/backend-adapters.js`:

```js
'use strict';

const ADAPTERS = {
  // Ollama: only JSON mode supported. No grammar.
  ollama: (constraint) => {
    if (!constraint) return {};
    if (constraint.kind === 'json_schema') return { format: 'json' };
    return {};
  },

  // vLLM-style: guided_json / guided_regex / guided_grammar
  vllm: (constraint) => {
    if (!constraint) return {};
    if (constraint.kind === 'json_schema') return { guided_json: constraint.schema };
    if (constraint.kind === 'regex')       return { guided_regex: constraint.pattern };
    if (constraint.kind === 'grammar')     return { guided_grammar: constraint.grammar };
    return {};
  },

  // llama.cpp server: JSON schema or regex grammar
  'llama-cpp': (constraint) => {
    if (!constraint) return {};
    if (constraint.kind === 'json_schema') return { json_schema: constraint.schema };
    if (constraint.kind === 'regex')       return { grammar: regexToLlamaGrammar(constraint.pattern) };
    return {};
  },

  // Cloud providers with no constraint support — pass nothing, rely on SAP.
  codex: () => ({}),
  anthropic: () => ({}),
  groq: () => ({}),
  deepinfra: () => ({}),
};

function regexToLlamaGrammar(pattern) {
  // Minimal converter: wraps the regex in a grammar shape llama.cpp accepts.
  return `root ::= "${pattern}"`;
}

function translate({ providerBackend, constraint }) {
  const adapter = ADAPTERS[providerBackend];
  if (!adapter) return {};
  return adapter(constraint);
}

module.exports = { translate, ADAPTERS };
```

- [ ] **Step 2: Structured provider adapter tests**

Create `server/tests/structured-provider-adapter.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { wrapWithStructuredSupport } = require('../constraints/structured-provider-adapter');

describe('wrapWithStructuredSupport', () => {
  it('passes constraint params to supporting backend', async () => {
    const baseProvider = { runPrompt: vi.fn(async () => '{"name":"Alice"}') };
    const wrapped = wrapWithStructuredSupport(baseProvider, { backend: 'vllm' });
    const r = await wrapped.runPrompt({
      prompt: 'extract name',
      output_schema: { type: 'object', required: ['name'] },
    });
    expect(baseProvider.runPrompt).toHaveBeenCalledWith(expect.objectContaining({
      guided_json: { type: 'object', required: ['name'] },
    }));
    expect(r.parsed.name).toBe('Alice');
  });

  it('skips constraint params for non-supporting backend + falls back to SAP', async () => {
    const baseProvider = { runPrompt: vi.fn(async () => 'Here is the answer:\n{"name":"Bob"}') };
    const wrapped = wrapWithStructuredSupport(baseProvider, { backend: 'codex' });
    const r = await wrapped.runPrompt({
      prompt: 'extract name',
      output_schema: { type: 'object', required: ['name'] },
    });
    // codex received no guided_json
    expect(baseProvider.runPrompt).toHaveBeenCalledWith(expect.not.objectContaining({ guided_json: expect.anything() }));
    // SAP extracted the name
    expect(r.parsed.name).toBe('Bob');
    expect(r.used_sap).toBe(true);
  });

  it('reports validation failure when output fails both constraint AND sap', async () => {
    const baseProvider = { runPrompt: vi.fn(async () => 'hopelessly unrelated prose') };
    const wrapped = wrapWithStructuredSupport(baseProvider, { backend: 'codex' });
    const r = await wrapped.runPrompt({
      prompt: 'x', output_schema: { type: 'object', required: ['name'] },
    });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Implement adapter**

Create `server/constraints/structured-provider-adapter.js`:

```js
'use strict';
const { compileConstraint } = require('./constraint-compiler');
const { translate } = require('./backend-adapters');
const { parseAlignedToSchema } = require('../torquefn/sap');

function wrapWithStructuredSupport(baseProvider, { backend }) {
  return {
    async runPrompt(args) {
      const constraint = compileConstraint({
        output_schema: args.output_schema,
        literal_set: args.literal_set,
        regex: args.regex,
      });
      const constraintParams = translate({ providerBackend: backend, constraint });
      const supportedAtBackend = Object.keys(constraintParams).length > 0;

      const providerArgs = { ...args, ...constraintParams };
      const raw = await baseProvider.runPrompt(providerArgs);

      if (args.output_schema) {
        const sapResult = parseAlignedToSchema(
          typeof raw === 'string' ? raw : JSON.stringify(raw),
          args.output_schema,
        );
        return {
          raw,
          parsed: sapResult.value,
          ok: sapResult.ok,
          errors: sapResult.errors,
          used_sap: !supportedAtBackend, // fell back to post-hoc recovery
          backend,
        };
      }

      return { raw, parsed: null, ok: true, backend };
    },
  };
}

module.exports = { wrapWithStructuredSupport };
```

Run tests → PASS. Commit: `feat(constraints): structured-provider-adapter + SAP fallback`.

---

## Task 3: Wire into provider dispatch

- [ ] **Step 1: Provider registry flag**

Each provider registration gets a `backend` string identifying its constraint capability:

```js
providerRegistry.register('codex',     { runPrompt, backend: 'codex' });      // no constraints, SAP only
providerRegistry.register('ollama',    { runPrompt, backend: 'ollama' });     // JSON mode
providerRegistry.register('deepinfra', { runPrompt, backend: 'deepinfra' });  // SAP only
// vLLM adapter (if TORQUE is configured with a vLLM endpoint)
providerRegistry.register('vllm',      { runPrompt, backend: 'vllm' });
```

- [ ] **Step 2: Dispatch wraps with structured support**

In the task dispatch path that calls a provider:

```js
const baseProvider = providerRegistry.getProviderInstance(providerName);
const backend = providerRegistry.getBackend(providerName) || providerName;
const { wrapWithStructuredSupport } = require('../constraints/structured-provider-adapter');
const provider = args.output_schema ? wrapWithStructuredSupport(baseProvider, { backend }) : baseProvider;
const result = await provider.runPrompt({
  prompt: task.task_description,
  output_schema: meta.output_schema,
  ...
});
if (!result.ok) {
  // treat as validation failure; hand to Plan 59 validator retry if configured
  ...
}
```

- [ ] **Step 3: MCP tool surface**

Existing task submission already accepts `output_schema`. Add:

```js
literal_set: { type: 'array', items: { type: 'string' }, description: 'Constrain output to one of these literal strings. Used with low-latency decoding backends.' },
regex: { type: 'string', description: 'Constrain output to match this regex. Used with grammar-aware backends.' },
```

Tag tasks that used pre-hoc constraint vs SAP fallback for analytics:

```js
addTaskTag(taskId, result.used_sap ? 'constraint:sap_fallback' : `constraint:${backend}_native`);
```

`await_restart`. Smoke: submit task to ollama with `output_schema: {type:'object', required:['name']}` and see `constraint:ollama_native` tag. Submit same task to codex, see `constraint:sap_fallback` tag but same parsed result.

Commit: `feat(constraints): wire provider dispatch through structured-adapter`.
