# Fabro #70: Eval Framework (Promptfoo + DeepEval)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a native **eval framework** with two surfaces: (a) **declarative matrix tests** (prompt × model × test) with an assertion catalog — inspired by Promptfoo, and (b) **typed LLMTestCase** objects with span-level evaluation + G-Eval-style judges — inspired by DeepEval. Both sit on top of the Plan 68 observability platform (dataset + score stores). CI integration via `torque eval` CLI.

**Architecture:**
- **Matrix runner** — reads `torque-eval.yaml` (or inline config), crosses `prompts × providers × tests`, runs each combo, records scores per (prompt, provider, test, assertion).
- **TestCase runtime** — exports `defineTestCase({ name, input, expected, assertions })`; tests register via import and run under `torque eval run`.
- **Assertion catalog** — `contains`, `matches` (regex), `similar` (embedding), `json_schema`, `factuality` (model-graded), `custom` (user JS).
- **G-Eval judges** — reusable graders: instantiate `new GEval({ name, criterion, weights })` and invoke like any other assertion.
- **Red-team layer** — separate `torque eval redteam` that runs plugin-provided attack strategies against a target and collects safety scores.

**Tech Stack:** Node.js, Ajv, existing provider dispatch, Plan 68 stores. Builds on plans 23 (typed signatures), 50 (plugin catalog), 59 (validators), 68 (observability).

---

## File Structure

**New files:**
- `server/eval/matrix-runner.js`
- `server/eval/testcase-runtime.js`
- `server/eval/assertions.js` — built-in assertion catalog
- `server/eval/geval.js` — reusable LLM-judge metric
- `server/eval/redteam-runner.js`
- `server/eval/cli.js` — `torque eval` entry
- `server/tests/assertions.test.js`
- `server/tests/matrix-runner.test.js`
- `server/tests/geval.test.js`

**Modified files:**
- `package.json` — `"bin": { "torque": "./server/cli/torque.js" }` entry
- `server/handlers/mcp-tools.js` — `run_eval`, `list_eval_runs`

---

## Task 1: Assertion catalog

- [ ] **Step 1: Tests**

Create `server/tests/assertions.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { runAssertion } = require('../eval/assertions');

describe('assertion catalog', () => {
  it('contains: passes when substring present, fails otherwise', async () => {
    expect((await runAssertion('contains', { value: 'hello' }, 'hello world')).ok).toBe(true);
    expect((await runAssertion('contains', { value: 'nope' }, 'hello world')).ok).toBe(false);
  });

  it('matches: passes regex match, fails otherwise', async () => {
    expect((await runAssertion('matches', { pattern: '^\\d+$' }, '12345')).ok).toBe(true);
    expect((await runAssertion('matches', { pattern: '^\\d+$' }, '12abc')).ok).toBe(false);
  });

  it('json_schema: validates against provided schema', async () => {
    const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
    expect((await runAssertion('json_schema', { schema }, '{"name":"alice"}')).ok).toBe(true);
    expect((await runAssertion('json_schema', { schema }, '{"wrong": 1}')).ok).toBe(false);
  });

  it('similar: above threshold passes (with embed stub)', async () => {
    const embed = vi.fn(async (t) => t === 'apple' ? [1, 0] : [0.9, 0.1]);
    const r = await runAssertion('similar', { reference: 'apple', threshold: 0.8, embed }, 'red apple');
    expect(r.ok).toBe(true);
  });

  it('custom: invokes user JS function', async () => {
    const r = await runAssertion('custom', {
      fn: (output) => ({ ok: output.startsWith('A'), reason: 'must start with A' }),
    }, 'Alice rocks');
    expect(r.ok).toBe(true);
  });

  it('negated assertion inverts result', async () => {
    const r = await runAssertion('contains', { value: 'nope', negated: true }, 'hello world');
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/eval/assertions.js`:

```js
'use strict';
const Ajv = require('ajv');
const ajv = new Ajv({ strict: false });

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

async function runAssertion(type, opts, output) {
  const r = await runRaw(type, opts, output);
  if (opts?.negated) return { ...r, ok: !r.ok };
  return r;
}

async function runRaw(type, opts, output) {
  switch (type) {
    case 'contains':
      return { ok: typeof output === 'string' && output.includes(opts.value) };
    case 'matches': {
      const re = new RegExp(opts.pattern, opts.flags || '');
      return { ok: typeof output === 'string' && re.test(output) };
    }
    case 'json_schema': {
      let parsed;
      try { parsed = typeof output === 'string' ? JSON.parse(output) : output; }
      catch { return { ok: false, reason: 'not JSON-parseable' }; }
      const validate = ajv.compile(opts.schema);
      if (validate(parsed)) return { ok: true };
      return { ok: false, reason: validate.errors.map(e => e.message).join('; ') };
    }
    case 'similar': {
      if (!opts.embed) return { ok: false, reason: 'similar requires embed function' };
      const a = await opts.embed(opts.reference);
      const b = await opts.embed(output);
      const score = cosine(a, b);
      return { ok: score >= (opts.threshold ?? 0.8), score };
    }
    case 'custom':
      if (typeof opts.fn !== 'function') return { ok: false, reason: 'custom requires fn' };
      return await opts.fn(output);
    default:
      return { ok: false, reason: `unknown assertion: ${type}` };
  }
}

module.exports = { runAssertion };
```

Run tests → PASS. Commit: `feat(eval): assertion catalog (contains/matches/json_schema/similar/custom)`.

---

## Task 2: Matrix runner

- [ ] **Step 1: Tests**

Create `server/tests/matrix-runner.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { runMatrix } = require('../eval/matrix-runner');

describe('runMatrix', () => {
  it('crosses prompts × providers × tests', async () => {
    const run = vi.fn(async ({ prompt, provider, input }) => `${provider}:${prompt.slice(0, 5)}:${input.topic}`);
    const result = await runMatrix({
      prompts: [{ name: 'short', content: 'Summary: {{topic}}' }],
      providers: ['codex', 'ollama'],
      tests: [
        { name: 't1', input: { topic: 'apples' }, assertions: [{ type: 'contains', value: 'apples' }] },
        { name: 't2', input: { topic: 'oranges' }, assertions: [{ type: 'contains', value: 'oranges' }] },
      ],
      run,
    });
    expect(run).toHaveBeenCalledTimes(4); // 1 prompt * 2 providers * 2 tests
    expect(result.results).toHaveLength(4);
    expect(result.results.every(r => r.ok)).toBe(true);
  });

  it('aggregates per prompt/provider pass-rate', async () => {
    const run = vi.fn(async ({ input }) => input.topic === 'apples' ? 'has apples' : 'has nothing');
    const result = await runMatrix({
      prompts: [{ name: 'p1' }],
      providers: ['codex'],
      tests: [
        { name: 't1', input: { topic: 'apples' }, assertions: [{ type: 'contains', value: 'apples' }] },
        { name: 't2', input: { topic: 'oranges' }, assertions: [{ type: 'contains', value: 'oranges' }] },
      ],
      run,
    });
    expect(result.summary[0].pass_rate).toBeCloseTo(0.5);
  });

  it('records first failing assertion details', async () => {
    const run = vi.fn(async () => 'wrong answer');
    const result = await runMatrix({
      prompts: [{ name: 'p1' }], providers: ['codex'],
      tests: [{ name: 't1', input: {}, assertions: [{ type: 'contains', value: 'right' }] }],
      run,
    });
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].failed_assertion).toBe('contains');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/eval/matrix-runner.js`:

```js
'use strict';
const { runAssertion } = require('./assertions');

function renderTemplate(tpl, vars) {
  if (!tpl) return '';
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ''));
}

async function runMatrix({ prompts, providers, tests, run, embed = null, logger = console }) {
  const results = [];
  for (const prompt of prompts) {
    for (const provider of providers) {
      for (const test of tests) {
        const rendered = renderTemplate(prompt.content || '', test.input || {});
        let output;
        try { output = await run({ prompt: rendered, provider, input: test.input, test_name: test.name }); }
        catch (err) {
          results.push({ prompt: prompt.name, provider, test: test.name, ok: false, error: err.message });
          continue;
        }
        let allPass = true, failed = null;
        for (const assertion of (test.assertions || [])) {
          const r = await runAssertion(assertion.type, { ...assertion, embed }, output);
          if (!r.ok) { allPass = false; failed = assertion.type; break; }
        }
        results.push({ prompt: prompt.name, provider, test: test.name, ok: allPass, failed_assertion: failed, output });
      }
    }
  }

  // Aggregate pass_rate per (prompt, provider)
  const agg = new Map();
  for (const r of results) {
    const k = `${r.prompt}|${r.provider}`;
    if (!agg.has(k)) agg.set(k, { prompt: r.prompt, provider: r.provider, total: 0, passed: 0 });
    const a = agg.get(k);
    a.total++; if (r.ok) a.passed++;
  }
  const summary = Array.from(agg.values()).map(a => ({ ...a, pass_rate: a.passed / a.total }));

  return { results, summary };
}

module.exports = { runMatrix };
```

Run tests → PASS. Commit: `feat(eval): matrix runner for prompt × provider × test combinations`.

---

## Task 3: G-Eval judge

- [ ] **Step 1: Tests**

Create `server/tests/geval.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { GEval } = require('../eval/geval');

describe('GEval', () => {
  it('scores output using model-graded prompt', async () => {
    const callModel = vi.fn(async () => ({ score: 0.85, rationale: 'response is faithful' }));
    const metric = new GEval({
      name: 'faithfulness', criterion: 'Response accurately reflects context',
      callModel, threshold: 0.7,
    });
    const r = await metric.score({ input: 'what is 2+2?', actual: '4', context: 'arithmetic' });
    expect(r.ok).toBe(true);
    expect(r.score).toBe(0.85);
  });

  it('fails when score below threshold', async () => {
    const callModel = vi.fn(async () => ({ score: 0.3, rationale: 'hallucinated' }));
    const metric = new GEval({ name: 'x', criterion: 'accuracy', callModel, threshold: 0.7 });
    const r = await metric.score({ input: 'x', actual: 'y' });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed model output', async () => {
    const callModel = vi.fn(async () => ({ no_score: true }));
    const metric = new GEval({ name: 'x', criterion: 'x', callModel });
    const r = await metric.score({ input: 'x', actual: 'y' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/score/i);
  });

  it('asAssertion returns object compatible with assertion catalog', () => {
    const metric = new GEval({ name: 'x', criterion: 'y', callModel: async () => ({ score: 1 }) });
    const a = metric.asAssertion();
    expect(a.type).toBe('custom');
    expect(typeof a.fn).toBe('function');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/eval/geval.js`:

```js
'use strict';

const JUDGE_PROMPT = `You are evaluating AI output. Give a score 0.0-1.0 on this criterion.

Criterion: {{criterion}}

Input:
{{input}}

Context (if any):
{{context}}

Actual output:
{{actual}}

Respond with strict JSON: { "score": <number>, "rationale": "..." }`;

class GEval {
  constructor({ name, criterion, callModel, threshold = 0.7 }) {
    this.name = name;
    this.criterion = criterion;
    this.callModel = callModel;
    this.threshold = threshold;
  }

  async score({ input, actual, context = null, expected = null }) {
    const prompt = JUDGE_PROMPT
      .replace('{{criterion}}', this.criterion)
      .replace('{{input}}', typeof input === 'string' ? input : JSON.stringify(input))
      .replace('{{context}}', context ? String(context) : '(none)')
      .replace('{{actual}}', typeof actual === 'string' ? actual : JSON.stringify(actual));

    let result;
    try { result = await this.callModel({ prompt }); }
    catch (err) { return { ok: false, reason: `judge call failed: ${err.message}` }; }
    if (typeof result?.score !== 'number') return { ok: false, reason: 'judge returned no numeric score' };
    return { ok: result.score >= this.threshold, score: result.score, rationale: result.rationale };
  }

  asAssertion() {
    return {
      type: 'custom',
      fn: async (output, context) => this.score({ input: context?.input, actual: output, context: context?.context }),
    };
  }
}

module.exports = { GEval };
```

Run tests → PASS. Commit: `feat(eval): G-Eval judge + asAssertion adapter`.

---

## Task 4: CLI + MCP

- [ ] **Step 1: CLI**

Create `server/eval/cli.js`:

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const yaml = require('js-yaml');
const { runMatrix } = require('./matrix-runner');

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'run') {
    const configPath = process.argv[3] || 'torque-eval.yaml';
    const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
    const { runWithProvider } = require('../providers/registry');
    const result = await runMatrix({
      prompts: config.prompts || [],
      providers: config.providers || ['codex'],
      tests: config.tests || [],
      run: async ({ prompt, provider, input }) => await runWithProvider({ provider, prompt, inputs: input }),
    });
    console.log(JSON.stringify(result.summary, null, 2));
    const failed = result.results.filter(r => !r.ok);
    if (failed.length > 0) process.exit(1);
  } else if (cmd === 'redteam') {
    const { runRedteam } = require('./redteam-runner');
    await runRedteam({ configPath: process.argv[3] });
  } else {
    console.error('usage: torque eval {run|redteam} [config-path]');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: MCP tool + package.json bin**

```js
run_eval: {
  description: 'Run a declarative eval matrix over prompts × providers × tests. Results persist as scores against the eval run.',
  inputSchema: { type: 'object', required: ['config'], properties: { config: { type: 'object' }, dataset_id: { type: 'string' } } },
},
```

Handler records `dataset_run` scores (via Plan 68 score store).

`await_restart`. Smoke: write `torque-eval.yaml` with 2 prompts × 2 providers × 3 tests. Run `torque eval run`. Confirm JSON summary with pass_rate per combo.

Commit: `feat(eval): CLI + MCP tool + score persistence`.
