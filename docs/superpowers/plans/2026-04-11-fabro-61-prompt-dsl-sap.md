# Fabro #61: Prompt DSL with Schema-Aligned Parsing (BAML)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce a compact `.torquefn` DSL under `torque/functions/` where each file declares a typed AI function: input schema, output schema, prompt template, provider config, and checked-in **test cases**. Add a **Schema-Aligned Parser** that repairs near-valid LLM outputs (extra prose, missing commas, code-fenced JSON) by aligning them to the target schema. Inspired by BAML.

**Architecture:** Parse `.torquefn` files with a custom grammar producing a `TorqueFunction` object. A generator emits a typed JS client (`torque-fn-client.js`) that application code imports. At call time, the runtime renders the prompt, invokes the configured provider, and runs the output through the Schema-Aligned Parser — which repairs JSON-ish text (strip code fences, trim trailing prose, coerce `'` to `"`, align near-miss shapes). Tests are runnable via `torque fn test` CLI.

**Tech Stack:** Node.js, handwritten parser (or peggy), existing provider dispatch. Builds on plans 23 (typed signatures), 59 (validator retry).

---

## File Structure

**New files:**
- `server/torquefn/grammar.js` — DSL tokenizer + parser
- `server/torquefn/sap.js` — Schema-Aligned Parser
- `server/torquefn/function-runner.js`
- `server/torquefn/client-generator.js`
- `server/torquefn/test-runner.js` — `torque fn test` CLI
- `server/tests/torquefn-grammar.test.js`
- `server/tests/torquefn-sap.test.js`
- `server/tests/torquefn-runner.test.js`
- `docs/torque-functions.md`
- `torque/functions/example.torquefn` — sample

---

## Task 1: Grammar

- [ ] **Step 1: Tests**

Create `server/tests/torquefn-grammar.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { parseTorqueFn } = require('../torquefn/grammar');

const SAMPLE = `
function ExtractName(input: { text: string }) -> { name: string; confidence: number } {
  prompt: """
    Given the text: {{ input.text }}
    Extract the person's full name and your confidence (0-1).
    Respond with JSON only.
  """
  provider: codex
  model: gpt-5.3-codex-spark
  temperature: 0.1

  test "simple" {
    input: { text: "Hi, I'm Alice Johnson." }
    expect: { name: "Alice Johnson" }
  }
}
`;

describe('parseTorqueFn', () => {
  it('parses function name + input/output schemas', () => {
    const fn = parseTorqueFn(SAMPLE);
    expect(fn.name).toBe('ExtractName');
    expect(fn.input.properties.text.type).toBe('string');
    expect(fn.output.properties.name.type).toBe('string');
    expect(fn.output.properties.confidence.type).toBe('number');
  });

  it('extracts prompt template body', () => {
    const fn = parseTorqueFn(SAMPLE);
    expect(fn.prompt).toMatch(/Given the text/);
    expect(fn.prompt).toMatch(/\{\{ input\.text \}\}/);
  });

  it('captures provider + model + temperature', () => {
    const fn = parseTorqueFn(SAMPLE);
    expect(fn.provider).toBe('codex');
    expect(fn.model).toBe('gpt-5.3-codex-spark');
    expect(fn.temperature).toBe(0.1);
  });

  it('captures test cases', () => {
    const fn = parseTorqueFn(SAMPLE);
    expect(fn.tests).toHaveLength(1);
    expect(fn.tests[0].name).toBe('simple');
    expect(fn.tests[0].input.text).toBe("Hi, I'm Alice Johnson.");
    expect(fn.tests[0].expect.name).toBe('Alice Johnson');
  });

  it('throws on malformed DSL', () => {
    expect(() => parseTorqueFn('not valid')).toThrow();
    expect(() => parseTorqueFn('function X {}')).toThrow();
  });
});
```

- [ ] **Step 2: Implement**

Create `server/torquefn/grammar.js`:

```js
'use strict';

// Minimal hand-written parser for .torquefn files.
// Grammar:
//   FunctionDecl := 'function' Ident '(' 'input' ':' ObjectType ')' '->' ObjectType Block
//   Block        := '{' FieldDecl* TestDecl* '}'
//   FieldDecl    := 'prompt' ':' TripleString | 'provider' ':' Ident | 'model' ':' Ident | 'temperature' ':' Number
//   TestDecl     := 'test' String Block
//   ObjectType   := '{' (Ident ':' TypeName (';' | ',')?)* '}'

function parseTorqueFn(source) {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = (n = 0) => tokens[pos + n];
  const expect = (type, value) => {
    const t = tokens[pos];
    if (!t) throw new Error('unexpected EOF');
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(`expected ${type}${value ? '(' + value + ')' : ''} got ${t.type}(${t.value}) at ${t.pos}`);
    }
    pos++;
    return t;
  };

  expect('kw', 'function');
  const name = expect('ident').value;
  expect('punct', '(');
  expect('kw', 'input');
  expect('punct', ':');
  const input = parseObjectType();
  expect('punct', ')');
  expect('punct', '->');
  const output = parseObjectType();
  expect('punct', '{');

  const fn = { name, input, output, tests: [] };
  while (peek() && peek().value !== '}') {
    const t = peek();
    if (t.type === 'kw' && t.value === 'test') {
      pos++;
      const testName = expect('str').value;
      expect('punct', '{');
      const testFields = parseTestBody();
      expect('punct', '}');
      fn.tests.push({ name: testName, ...testFields });
    } else if (t.type === 'kw' && ['prompt', 'provider', 'model', 'temperature'].includes(t.value)) {
      const key = t.value; pos++;
      expect('punct', ':');
      if (key === 'prompt') fn.prompt = expect('tripleStr').value.trim();
      else if (key === 'provider' || key === 'model') fn[key] = expect('ident').value;
      else if (key === 'temperature') fn.temperature = parseFloat(expect('num').value);
    } else {
      throw new Error(`unexpected token ${t.type}(${t.value})`);
    }
  }
  expect('punct', '}');
  return fn;
}

function parseObjectType() {
  // Handled in outer scope via shared pos/tokens... rewrite as closure-friendly later.
  throw new Error('parseObjectType placeholder');
}

// In practice, parseObjectType + parseTestBody share the closure in parseTorqueFn.
// For brevity here, see the full-scope version in the real implementation.

function tokenize(source) {
  // Very small tokenizer: keywords (function/input/prompt/provider/model/temperature/test),
  // identifiers, numbers, strings (", '), triple-strings ("""), punctuation (:;,(){}[]->).
  const KEYWORDS = new Set(['function', 'input', 'prompt', 'provider', 'model', 'temperature', 'test']);
  const tokens = [];
  let i = 0;
  const len = source.length;
  while (i < len) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    // Comments: // ... \n
    if (c === '/' && source[i + 1] === '/') { while (i < len && source[i] !== '\n') i++; continue; }
    // Triple-quoted strings
    if (source.slice(i, i + 3) === '"""') {
      let j = i + 3;
      while (j < len && source.slice(j, j + 3) !== '"""') j++;
      tokens.push({ type: 'tripleStr', value: source.slice(i + 3, j), pos: i });
      i = j + 3; continue;
    }
    if (c === '"' || c === "'") {
      const q = c; let j = i + 1;
      while (j < len && source[j] !== q) { if (source[j] === '\\') j++; j++; }
      tokens.push({ type: 'str', value: source.slice(i + 1, j), pos: i });
      i = j + 1; continue;
    }
    if (c === '-' && source[i + 1] === '>') { tokens.push({ type: 'punct', value: '->', pos: i }); i += 2; continue; }
    if ('{}()[]:;,'.includes(c)) { tokens.push({ type: 'punct', value: c, pos: i }); i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1]))) {
      let j = i + 1;
      while (j < len && /[0-9.]/.test(source[j])) j++;
      tokens.push({ type: 'num', value: source.slice(i, j), pos: i });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_]/.test(source[j])) j++;
      const word = source.slice(i, j);
      tokens.push({ type: KEYWORDS.has(word) ? 'kw' : 'ident', value: word, pos: i });
      i = j; continue;
    }
    throw new Error(`unexpected char '${c}' at ${i}`);
  }
  return tokens;
}

module.exports = { parseTorqueFn };
```

(Consolidate `parseObjectType` + `parseTestBody` into one closure over `pos`/`tokens` — written out in full in the actual file.)

Run tests → PASS. Commit: `feat(torquefn): DSL tokenizer + parser for function/input/output/prompt/test`.

---

## Task 2: Schema-Aligned Parser (SAP)

- [ ] **Step 1: Tests**

Create `server/tests/torquefn-sap.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { parseAlignedToSchema } = require('../torquefn/sap');

const SCHEMA = {
  type: 'object',
  required: ['name', 'age'],
  properties: { name: { type: 'string' }, age: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } } },
};

describe('parseAlignedToSchema', () => {
  it('parses clean JSON output', () => {
    const r = parseAlignedToSchema('{"name": "Alice", "age": 30}', SCHEMA);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ name: 'Alice', age: 30 });
  });

  it('strips trailing prose', () => {
    const r = parseAlignedToSchema('{"name": "Alice", "age": 30}\n\nThat is the answer.', SCHEMA);
    expect(r.ok).toBe(true);
  });

  it('strips leading prose', () => {
    const r = parseAlignedToSchema('Here is the answer:\n{"name": "Alice", "age": 30}', SCHEMA);
    expect(r.ok).toBe(true);
  });

  it('strips ```json fences', () => {
    const r = parseAlignedToSchema('```json\n{"name": "Alice", "age": 30}\n```', SCHEMA);
    expect(r.ok).toBe(true);
  });

  it('coerces single quotes to double quotes (JS-style object)', () => {
    const r = parseAlignedToSchema(`{'name': 'Alice', 'age': 30}`, SCHEMA);
    expect(r.ok).toBe(true);
    expect(r.value.name).toBe('Alice');
  });

  it('coerces numeric strings to numbers when schema says number', () => {
    const r = parseAlignedToSchema('{"name":"Alice","age":"30"}', SCHEMA);
    expect(r.ok).toBe(true);
    expect(r.value.age).toBe(30);
  });

  it('wraps single-item string into array when schema expects array', () => {
    const r = parseAlignedToSchema('{"name":"Alice","age":30,"tags":"admin"}', SCHEMA);
    expect(r.ok).toBe(true);
    expect(r.value.tags).toEqual(['admin']);
  });

  it('returns ok=false when required field missing', () => {
    const r = parseAlignedToSchema('{"name":"Alice"}', SCHEMA);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/age/);
  });

  it('returns ok=false when nothing resembling JSON is found', () => {
    const r = parseAlignedToSchema('just plain prose', SCHEMA);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/torquefn/sap.js`:

```js
'use strict';
const Ajv = require('ajv');
const ajv = new Ajv({ strict: false, coerceTypes: 'array', allErrors: true });

function parseAlignedToSchema(rawOutput, schema) {
  // Step 1: locate JSON-ish substring
  const cleaned = extractJsonish(rawOutput);
  if (!cleaned) return { ok: false, errors: ['no JSON-ish content found'] };

  // Step 2: try strict parse
  let parsed = safeJsonParse(cleaned);
  if (parsed === undefined) parsed = safeJsonParse(singleQuotesToDouble(cleaned));
  if (parsed === undefined) return { ok: false, errors: ['JSON parse failed'] };

  // Step 3: schema-guided coercions
  parsed = coerceToSchema(parsed, schema);

  // Step 4: validate
  const validate = ajv.compile(schema);
  if (validate(parsed)) return { ok: true, value: parsed };
  return { ok: false, errors: validate.errors.map(e => `${e.instancePath || '(root)'}: ${e.message}`) };
}

function extractJsonish(s) {
  if (typeof s !== 'string') return null;
  // Strip ```json ... ``` fences
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) return fence[1].trim();
  // Find first { to last matching }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return s.slice(first, last + 1).trim();
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

function singleQuotesToDouble(s) {
  // Naive but works for common LLM-generated JS-ish output.
  return s.replace(/'/g, '"');
}

function coerceToSchema(value, schema) {
  if (!schema || typeof schema !== 'object') return value;
  if (schema.type === 'object' && schema.properties && typeof value === 'object' && value !== null) {
    const out = { ...value };
    for (const [k, subSchema] of Object.entries(schema.properties)) {
      if (k in out) out[k] = coerceToSchema(out[k], subSchema);
    }
    return out;
  }
  if (schema.type === 'array' && !Array.isArray(value)) {
    return [coerceToSchema(value, schema.items)];
  }
  if (schema.type === 'number' && typeof value === 'string' && !isNaN(Number(value))) {
    return Number(value);
  }
  if (schema.type === 'boolean' && typeof value === 'string') {
    if (value.toLowerCase() === 'true')  return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return value;
}

module.exports = { parseAlignedToSchema, extractJsonish };
```

Run tests → PASS. Commit: `feat(torquefn): Schema-Aligned Parser with fence strip + coercions`.

---

## Task 3: Function runner + test CLI

- [ ] **Step 1: Runner tests**

Create `server/tests/torquefn-runner.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { callFunction } = require('../torquefn/function-runner');

const FN = {
  name: 'ExtractName',
  input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  output: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  prompt: 'Extract name from: {{ input.text }}',
  provider: 'codex',
};

describe('callFunction', () => {
  it('renders prompt with input template + parses output to schema', async () => {
    const callModel = vi.fn(async () => '```json\n{"name": "Alice"}\n```');
    const r = await callFunction({ fn: FN, input: { text: 'Hi Alice' }, callModel });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ name: 'Alice' });
    expect(callModel).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Extract name from: Hi Alice' }));
  });

  it('rejects input that does not match input schema', async () => {
    const r = await callFunction({ fn: FN, input: {}, callModel: vi.fn() });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/text/);
  });

  it('returns validator errors when SAP cannot align output', async () => {
    const callModel = vi.fn(async () => 'completely unrelated prose');
    const r = await callFunction({ fn: FN, input: { text: 'Hi' }, callModel });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/torquefn/function-runner.js`:

```js
'use strict';
const Ajv = require('ajv');
const { parseAlignedToSchema } = require('./sap');
const ajv = new Ajv({ strict: false, allErrors: true });

async function callFunction({ fn, input, callModel }) {
  // 1. Validate input
  const validateInput = ajv.compile(fn.input);
  if (!validateInput(input)) {
    return { ok: false, errors: validateInput.errors.map(e => `input${e.instancePath}: ${e.message}`) };
  }
  // 2. Render prompt
  const prompt = renderTemplate(fn.prompt, { input });
  // 3. Call model
  const raw = await callModel({ prompt, provider: fn.provider, model: fn.model, temperature: fn.temperature });
  // 4. SAP parse against output schema
  return parseAlignedToSchema(typeof raw === 'string' ? raw : JSON.stringify(raw), fn.output);
}

function renderTemplate(tpl, ctx) {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const parts = path.split('.');
    let cur = ctx;
    for (const p of parts) { if (cur == null) return ''; cur = cur[p]; }
    return String(cur ?? '');
  });
}

module.exports = { callFunction, renderTemplate };
```

- [ ] **Step 3: Test runner CLI**

Create `server/torquefn/test-runner.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { parseTorqueFn } = require('./grammar');
const { callFunction } = require('./function-runner');

async function runAllTests({ dir = 'torque/functions', callModel }) {
  if (!fs.existsSync(dir)) return { ok: true, total: 0, passed: 0, failures: [] };
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.torquefn'));
  let total = 0, passed = 0;
  const failures = [];
  for (const f of files) {
    const source = fs.readFileSync(path.join(dir, f), 'utf8');
    const fn = parseTorqueFn(source);
    for (const test of (fn.tests || [])) {
      total++;
      const result = await callFunction({ fn, input: test.input, callModel });
      const matched = result.ok && deepEqualSubset(test.expect, result.value);
      if (matched) passed++;
      else failures.push({ function: fn.name, test: test.name, expected: test.expect, actual: result });
    }
  }
  return { ok: failures.length === 0, total, passed, failures };
}

function deepEqualSubset(expected, actual) {
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (actual === null || typeof actual !== 'object') return false;
  for (const [k, v] of Object.entries(expected)) {
    if (!deepEqualSubset(v, actual[k])) return false;
  }
  return true;
}

module.exports = { runAllTests };
```

`await_restart`. Smoke: write `torque/functions/extract-name.torquefn` with one test. Run `node -e "require('./server/torquefn/test-runner').runAllTests({...})"`. Confirm test runs against Codex provider and passes.

Commit: `feat(torquefn): function runner + test CLI over .torquefn files`.
