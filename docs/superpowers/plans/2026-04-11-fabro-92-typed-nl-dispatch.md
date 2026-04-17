# Fabro #92: Typed NL Dispatch (TypeAgent)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn natural-language operator commands into **typed action objects** validated against a TypeScript/JSON schema union, then **deterministically dispatch** to handlers. A separate **translator** stage maps NL → action; an **explainer** stage narrates the mapping; a **construction cache** remembers repeat translations so common commands bypass the LLM entirely. Inspired by Microsoft TypeAgent.

**Architecture:** Three modules:
1. **Action schema registry** — each TORQUE surface (workflow/task/factory/ops) declares an action union with discriminator `actionName`. Registered via `registerActionSchema(surface, schema)`.
2. **Translator** — given NL + schema, ask LLM for a validated action object. Retries + SAP (Plan 61) on malformed output.
3. **Construction cache** — (utterance_pattern → action template) with wildcard validation; cache hits skip the LLM call.
4. **Executor** — receives typed action, dispatches to `actionName` handler.

**Tech Stack:** Node.js, Ajv, existing provider dispatch. Builds on plans 23 (typed signatures), 61 (SAP), 71 (FSM).

---

## File Structure

**New files:**
- `server/migrations/0NN-construction-cache.sql`
- `server/dispatch/action-registry.js`
- `server/dispatch/translator.js`
- `server/dispatch/construction-cache.js`
- `server/dispatch/executor.js`
- `server/tests/action-registry.test.js`
- `server/tests/translator.test.js`
- `server/tests/construction-cache.test.js`
- `server/tests/executor.test.js`

**Modified files:**
- `server/handlers/mcp-tools.js` — `register_action_schema`, `dispatch_nl`, `list_actions`

---

## Task 1: Action registry + executor

- [x] **Step 1: Registry tests**

Create `server/tests/action-registry.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { createActionRegistry } = require('../dispatch/action-registry');

describe('actionRegistry', () => {
  it('register + getSurface stores schema + handlers', () => {
    const reg = createActionRegistry();
    reg.register({
      surface: 'workflow',
      schema: {
        oneOf: [
          { type: 'object', required: ['actionName', 'workflowId'], properties: { actionName: { const: 'cancel' }, workflowId: { type: 'string' } } },
          { type: 'object', required: ['actionName', 'workflowId'], properties: { actionName: { const: 'resume' }, workflowId: { type: 'string' } } },
        ],
      },
      handlers: {
        cancel: async (action) => ({ cancelled: action.workflowId }),
        resume: async (action) => ({ resumed: action.workflowId }),
      },
    });
    const s = reg.getSurface('workflow');
    expect(s.handlers.cancel).toBeInstanceOf(Function);
  });

  it('listActionNames returns all known actionName constants', () => {
    const reg = createActionRegistry();
    reg.register({
      surface: 'workflow',
      schema: {
        oneOf: [
          { properties: { actionName: { const: 'a' } } },
          { properties: { actionName: { const: 'b' } } },
        ],
      },
      handlers: { a: () => {}, b: () => {} },
    });
    expect(reg.listActionNames('workflow').sort()).toEqual(['a', 'b']);
  });

  it('throws on duplicate surface registration', () => {
    const reg = createActionRegistry();
    reg.register({ surface: 'ops', schema: {}, handlers: {} });
    expect(() => reg.register({ surface: 'ops', schema: {}, handlers: {} })).toThrow(/already registered/i);
  });
});
```

- [x] **Step 2: Implement registry + executor**

Create `server/dispatch/action-registry.js`:

```js
'use strict';

function createActionRegistry() {
  const surfaces = new Map();

  function register({ surface, schema, handlers, description = null }) {
    if (surfaces.has(surface)) throw new Error(`surface '${surface}' already registered`);
    surfaces.set(surface, { schema, handlers, description });
  }

  function getSurface(surface) { return surfaces.get(surface) || null; }
  function listSurfaces() { return Array.from(surfaces.keys()).sort(); }

  function listActionNames(surface) {
    const s = surfaces.get(surface);
    if (!s) return [];
    const names = new Set();
    collectConsts(s.schema, 'actionName', names);
    return Array.from(names);
  }

  function collectConsts(schema, field, names) {
    if (!schema || typeof schema !== 'object') return;
    if (schema.properties?.[field]?.const) names.add(schema.properties[field].const);
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(schema[key])) for (const s of schema[key]) collectConsts(s, field, names);
    }
  }

  return { register, getSurface, listSurfaces, listActionNames };
}

module.exports = { createActionRegistry };
```

Create `server/dispatch/executor.js`:

```js
'use strict';
const Ajv = require('ajv');
const ajv = new Ajv({ strict: false, allErrors: true });

function createExecutor({ registry }) {
  async function execute({ surface, action, context = {} }) {
    const s = registry.getSurface(surface);
    if (!s) return { ok: false, error: `unknown surface: ${surface}` };
    const validate = ajv.compile(s.schema);
    if (!validate(action)) return { ok: false, error: 'action schema validation failed', details: validate.errors };
    const handler = s.handlers[action.actionName];
    if (!handler) return { ok: false, error: `unknown actionName: ${action.actionName}` };
    try {
      const result = await handler(action, context);
      return { ok: true, action_name: action.actionName, result };
    } catch (err) {
      return { ok: false, error: `handler threw: ${err.message}` };
    }
  }

  return { execute };
}

module.exports = { createExecutor };
```

Run tests → PASS. Commit: `feat(dispatch): action registry + deterministic executor`.

---

## Task 2: Translator + construction cache

- [x] **Step 1: Translator tests**

Create `server/tests/translator.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { translateToAction } = require('../dispatch/translator');

describe('translateToAction', () => {
  const schema = {
    oneOf: [
      { type: 'object', required: ['actionName', 'workflow_id'], properties: { actionName: { const: 'cancel' }, workflow_id: { type: 'string' } } },
      { type: 'object', required: ['actionName', 'workflow_id'], properties: { actionName: { const: 'resume' }, workflow_id: { type: 'string' } } },
    ],
  };

  it('parses LLM JSON + validates against schema', async () => {
    const callModel = vi.fn(async () => JSON.stringify({ actionName: 'cancel', workflow_id: 'wf-1' }));
    const r = await translateToAction({ utterance: 'cancel wf-1', schema, callModel });
    expect(r.ok).toBe(true);
    expect(r.action).toEqual({ actionName: 'cancel', workflow_id: 'wf-1' });
  });

  it('retries once on schema failure', async () => {
    let call = 0;
    const callModel = vi.fn(async () => {
      call++;
      if (call === 1) return '{"actionName":"bogus"}';
      return '{"actionName":"resume", "workflow_id":"wf-9"}';
    });
    const r = await translateToAction({ utterance: 'resume wf-9', schema, callModel });
    expect(r.ok).toBe(true);
    expect(r.action.actionName).toBe('resume');
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it('returns error when model never emits valid action', async () => {
    const callModel = vi.fn(async () => '{"nope": true}');
    const r = await translateToAction({ utterance: 'x', schema, callModel, maxRetries: 2 });
    expect(r.ok).toBe(false);
  });

  it('strips markdown fences from LLM output', async () => {
    const callModel = vi.fn(async () => '```json\n{"actionName":"cancel","workflow_id":"abc"}\n```');
    const r = await translateToAction({ utterance: 'cancel abc', schema, callModel });
    expect(r.ok).toBe(true);
  });
});
```

- [x] **Step 2: Implement**

Create `server/dispatch/translator.js`:

```js
'use strict';
const Ajv = require('ajv');
const { parseAlignedToSchema } = require('../torquefn/sap');
const ajv = new Ajv({ strict: false, allErrors: true });

const TRANSLATE_PROMPT = `Translate the operator utterance below into a strict JSON action matching the schema. Respond with ONLY the JSON object — no prose.

Schema:
{{schema}}

Utterance:
{{utterance}}`;

async function translateToAction({ utterance, schema, callModel, maxRetries = 2 }) {
  let lastError = null;
  let prompt = TRANSLATE_PROMPT.replace('{{schema}}', JSON.stringify(schema, null, 2)).replace('{{utterance}}', utterance);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const raw = await callModel({ prompt });
    const sapResult = parseAlignedToSchema(raw, schema);
    if (sapResult.ok) return { ok: true, action: sapResult.value, attempts: attempt + 1 };
    lastError = sapResult.errors;
    prompt = `${TRANSLATE_PROMPT
      .replace('{{schema}}', JSON.stringify(schema, null, 2))
      .replace('{{utterance}}', utterance)}

Your previous response failed validation:
${sapResult.errors.join('; ')}

Output a corrected JSON object that matches the schema exactly.`;
  }
  return { ok: false, errors: lastError, attempts: maxRetries + 1 };
}

module.exports = { translateToAction };
```

Run tests → PASS. Commit: `feat(dispatch): translator with SAP + schema-retry loop`.

- [x] **Step 3: Construction cache tests + impl**

Create `server/tests/construction-cache.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createConstructionCache } = require('../dispatch/construction-cache');

describe('constructionCache', () => {
  let db, cache;
  beforeEach(() => {
    db = setupTestDb();
    cache = createConstructionCache({ db });
  });

  it('learn stores a pattern → action template', () => {
    cache.learn({
      utterance: 'cancel wf-1',
      normalizedTemplate: 'cancel wf-{id}',
      actionTemplate: { actionName: 'cancel', workflow_id: '{id}' },
      surface: 'workflow',
    });
    const n = db.prepare('SELECT COUNT(*) AS n FROM construction_cache').get().n;
    expect(n).toBe(1);
  });

  it('lookup finds a cached template match', () => {
    cache.learn({
      utterance: 'cancel wf-1',
      normalizedTemplate: 'cancel wf-{id}',
      actionTemplate: { actionName: 'cancel', workflow_id: '{id}' },
      surface: 'workflow',
    });
    const match = cache.lookup({ utterance: 'cancel wf-42', surface: 'workflow' });
    expect(match).toEqual(expect.objectContaining({ actionName: 'cancel', workflow_id: '42' }));
  });

  it('lookup returns null when no pattern matches', () => {
    cache.learn({ utterance: 'a', normalizedTemplate: 'foo', actionTemplate: {}, surface: 'x' });
    expect(cache.lookup({ utterance: 'bar', surface: 'x' })).toBeNull();
  });

  it('hit increments hit_count', () => {
    cache.learn({
      utterance: 'x', normalizedTemplate: 'cancel wf-{id}',
      actionTemplate: { actionName: 'cancel', workflow_id: '{id}' },
      surface: 'workflow',
    });
    cache.lookup({ utterance: 'cancel wf-5', surface: 'workflow' });
    cache.lookup({ utterance: 'cancel wf-6', surface: 'workflow' });
    const row = db.prepare('SELECT hit_count FROM construction_cache').get();
    expect(row.hit_count).toBe(2);
  });
});
```

Create `server/migrations/0NN-construction-cache.sql`:

```sql
CREATE TABLE IF NOT EXISTS construction_cache (
  pattern_id TEXT PRIMARY KEY,
  surface TEXT NOT NULL,
  normalized_template TEXT NOT NULL,
  template_regex TEXT NOT NULL,
  action_template_json TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  learned_from_utterance TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_construction_surface ON construction_cache(surface);
```

Create `server/dispatch/construction-cache.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function templateToRegex(template) {
  // Convert "cancel wf-{id}" → /^cancel wf-(?<id>[^ ]+)$/
  const re = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{(\w+)\\\}/g, (_, n) => `(?<${n}>[^ ]+)`);
  return new RegExp('^' + re + '$', 'i');
}

function fillTemplate(actionTemplate, captures) {
  if (typeof actionTemplate === 'string' && actionTemplate.startsWith('{') && actionTemplate.endsWith('}')) {
    const key = actionTemplate.slice(1, -1);
    return captures[key] !== undefined ? captures[key] : actionTemplate;
  }
  if (Array.isArray(actionTemplate)) return actionTemplate.map(v => fillTemplate(v, captures));
  if (actionTemplate && typeof actionTemplate === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(actionTemplate)) out[k] = fillTemplate(v, captures);
    return out;
  }
  return actionTemplate;
}

function createConstructionCache({ db }) {
  function learn({ utterance, normalizedTemplate, actionTemplate, surface }) {
    const id = `pat_${randomUUID().slice(0, 12)}`;
    const regex = templateToRegex(normalizedTemplate).source;
    db.prepare(`
      INSERT INTO construction_cache (pattern_id, surface, normalized_template, template_regex, action_template_json, learned_from_utterance)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, surface, normalizedTemplate, regex, JSON.stringify(actionTemplate), utterance);
    return id;
  }

  function lookup({ utterance, surface }) {
    const rows = db.prepare(`SELECT * FROM construction_cache WHERE surface = ? ORDER BY hit_count DESC`).all(surface);
    for (const row of rows) {
      const re = new RegExp(row.template_regex, 'i');
      const m = utterance.match(re);
      if (m) {
        db.prepare('UPDATE construction_cache SET hit_count = hit_count + 1 WHERE pattern_id = ?').run(row.pattern_id);
        const template = JSON.parse(row.action_template_json);
        return fillTemplate(template, m.groups || {});
      }
    }
    return null;
  }

  return { learn, lookup };
}

module.exports = { createConstructionCache };
```

Run tests → PASS. Commit: `feat(dispatch): construction cache with template → regex + named captures`.

---

## Task 3: MCP glue

- [x] **Step 1: Tools**

```js
register_action_schema: { description: 'Register a JSON schema + handlers for an action surface.', inputSchema: {...} },
list_actions: { description: 'List known action surfaces + actionNames.', inputSchema: { type: 'object' } },
dispatch_nl: {
  description: 'Translate a natural-language utterance into a typed action + execute. Uses construction cache first, LLM translator as fallback.',
  inputSchema: {
    type: 'object', required: ['surface', 'utterance'],
    properties: { surface: { type: 'string' }, utterance: { type: 'string' }, learn_on_success: { type: 'boolean', default: true } },
  },
},
```

- [x] **Step 2: dispatch_nl handler**

```js
case 'dispatch_nl': {
  const reg = defaultContainer.get('actionRegistry');
  const surface = reg.getSurface(args.surface);
  if (!surface) return { ok: false, error: `unknown surface` };

  const cache = defaultContainer.get('constructionCache');
  const cached = cache.lookup({ utterance: args.utterance, surface: args.surface });
  if (cached) {
    const executor = defaultContainer.get('executor');
    return { ...(await executor.execute({ surface: args.surface, action: cached })), source: 'cache' };
  }

  const provider = defaultContainer.get('providerRegistry').getProviderInstance('codex');
  const { translateToAction } = require('../dispatch/translator');
  const r = await translateToAction({
    utterance: args.utterance, schema: surface.schema,
    callModel: async ({ prompt }) => provider.runPrompt({ prompt, format: 'json', max_tokens: 500 }),
  });
  if (!r.ok) return { ok: false, error: 'translation failed', details: r.errors };

  const executor = defaultContainer.get('executor');
  const result = await executor.execute({ surface: args.surface, action: r.action });
  if (args.learn_on_success !== false && result.ok) {
    // (Future enhancement: derive template from utterance/action; stub for now)
  }
  return { ...result, source: 'llm' };
}
```

`await_restart`. Smoke: register a workflow action schema (cancel/resume). `dispatch_nl({surface:'workflow', utterance:'cancel wf-42'})` — confirm LLM translates to `{actionName:'cancel', workflow_id:'wf-42'}` and handler runs. Learn template manually, submit same utterance shape — confirm source='cache'.

Commit: `feat(dispatch): MCP dispatch_nl with cache-first + LLM fallback`.
