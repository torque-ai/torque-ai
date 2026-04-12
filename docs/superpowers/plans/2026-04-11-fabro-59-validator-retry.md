# Fabro #59: Validator-Driven Retry Loop (Pydantic AI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade task completion from "validator passes or task fails" to a **validator-participating repair loop**: when a validator (schema, custom domain check, tool-arg validator) rejects output, feed the precise error back to the model and retry. Validators can raise `ModelRetry` with a message describing what needs to change. Inspired by Pydantic AI's validation retry.

**Architecture:** Builds on Plan 23 (typed signatures). When a task has `output_schema` or `validators` in metadata and the provider's response fails validation, instead of failing the task, `validator-retry-runtime.js` appends the validation error as a `repair_message` and re-calls the provider up to N times. Validators are pluggable functions `(output, context) => { ok, errors, retry_hint }`. Schema validation is the built-in default; domain validators can be registered per-plugin.

**Tech Stack:** Node.js, Ajv, existing provider dispatch. Builds on plans 23 (typed signatures), 31 (activities), 49 (surgical repair).

---

## File Structure

**New files:**
- `server/validation/validator-retry-runtime.js`
- `server/validation/built-in-validators.js` — schema, non-empty, JSON-parseable
- `server/tests/validator-retry-runtime.test.js`

**Modified files:**
- `server/execution/task-finalizer.js` — branch on `validators` metadata
- `server/tool-defs/task-defs.js` — accept `validators` + `max_validator_retries`

---

## Task 1: Built-in validators

- [ ] **Step 1: Tests inline with retry-runtime tests**

(covered in Task 2)

- [ ] **Step 2: Implement**

Create `server/validation/built-in-validators.js`:

```js
'use strict';
const Ajv = require('ajv');
const ajv = new Ajv({ strict: false, allErrors: true });

const VALIDATORS = {
  schema: (output, { schema }) => {
    if (!schema) return { ok: true };
    const parsed = tryParse(output);
    if (parsed === undefined) return { ok: false, errors: ['output is not valid JSON'], retry_hint: 'Respond with a single JSON object — no prose, no code fences.' };
    const validate = ajv.compile(schema);
    if (validate(parsed)) return { ok: true, value: parsed };
    const errs = validate.errors.map(e => `${e.instancePath || '(root)'}: ${e.message}`);
    return { ok: false, errors: errs, retry_hint: `Your output failed schema validation:\n${errs.map(e => '- ' + e).join('\n')}\n\nFix and return a valid JSON object.` };
  },

  non_empty: (output) => {
    if (output == null || (typeof output === 'string' && output.trim() === '')) {
      return { ok: false, errors: ['output is empty'], retry_hint: 'Provide a non-empty response.' };
    }
    return { ok: true };
  },

  json_parseable: (output) => {
    const parsed = tryParse(output);
    if (parsed === undefined) return { ok: false, errors: ['not JSON-parseable'], retry_hint: 'Respond with valid JSON.' };
    return { ok: true, value: parsed };
  },

  min_length: (output, { min = 10 }) => {
    if (typeof output !== 'string') return { ok: true };
    if (output.length < min) return { ok: false, errors: [`length ${output.length} < ${min}`], retry_hint: `Provide at least ${min} characters.` };
    return { ok: true };
  },
};

function tryParse(s) {
  if (s && typeof s === 'object') return s;
  if (typeof s !== 'string') return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

function runValidators(output, specs, registry = VALIDATORS) {
  for (const spec of specs) {
    const fn = registry[spec.type];
    if (!fn) return { ok: false, errors: [`unknown validator: ${spec.type}`], stop: true };
    const r = fn(output, spec);
    if (!r.ok) return { ...r, failed_validator: spec.type };
    if (r.value !== undefined) output = r.value;
  }
  return { ok: true, value: output };
}

module.exports = { VALIDATORS, runValidators };
```

Commit: `feat(validators): built-in schema/non_empty/json_parseable/min_length + runVlaidators`.

---

## Task 2: Retry runtime

- [ ] **Step 1: Tests**

Create `server/tests/validator-retry-runtime.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { runWithValidators } = require('../validation/validator-retry-runtime');

describe('runWithValidators', () => {
  it('passes immediately when first response validates', async () => {
    const callModel = vi.fn(async () => '{"ok": true}');
    const r = await runWithValidators({
      callModel,
      initialPrompt: 'hi',
      validators: [{ type: 'schema', schema: { type: 'object', required: ['ok'] } }],
      maxRetries: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ ok: true });
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it('retries with retry_hint when schema fails', async () => {
    let attempt = 0;
    const callModel = vi.fn(async ({ prompt }) => {
      attempt++;
      if (attempt === 1) return '{"wrong": true}';
      return '{"ok": true}';
    });
    const r = await runWithValidators({
      callModel,
      initialPrompt: 'hi',
      validators: [{ type: 'schema', schema: { type: 'object', required: ['ok'] } }],
      maxRetries: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    // Second call's prompt should include the retry hint
    const secondCall = callModel.mock.calls[1][0];
    expect(secondCall.prompt).toMatch(/schema validation|must have required property/i);
  });

  it('fails after maxRetries exhausted', async () => {
    const callModel = vi.fn(async () => '{"wrong": true}');
    const r = await runWithValidators({
      callModel,
      initialPrompt: 'hi',
      validators: [{ type: 'schema', schema: { type: 'object', required: ['ok'] } }],
      maxRetries: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(3); // initial + 2 retries
    expect(r.errors).toBeDefined();
  });

  it('stops immediately on unknown validator (no retry)', async () => {
    const callModel = vi.fn(async () => 'x');
    const r = await runWithValidators({
      callModel,
      initialPrompt: 'hi',
      validators: [{ type: 'bogus' }],
      maxRetries: 5,
    });
    expect(r.ok).toBe(false);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it('custom validator from registry participates in retry', async () => {
    let attempt = 0;
    const callModel = vi.fn(async () => {
      attempt++;
      return attempt < 2 ? 'short' : 'this response is long enough';
    });
    const r = await runWithValidators({
      callModel,
      initialPrompt: 'describe',
      validators: [{ type: 'custom_min_len' }],
      maxRetries: 3,
      registry: {
        custom_min_len: (output) => output.length >= 20
          ? { ok: true }
          : { ok: false, errors: ['too short'], retry_hint: 'Respond with at least 20 characters.' },
      },
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/validation/validator-retry-runtime.js`:

```js
'use strict';
const { runValidators, VALIDATORS } = require('./built-in-validators');

async function runWithValidators({
  callModel,
  initialPrompt,
  validators = [],
  maxRetries = 3,
  registry = VALIDATORS,
  logger = console,
}) {
  let prompt = initialPrompt;
  let attempts = 0;
  let lastErrors = null;

  while (attempts <= maxRetries) {
    attempts++;
    const output = await callModel({ prompt });
    const result = runValidators(output, validators, registry);
    if (result.ok) {
      return { ok: true, value: result.value, attempts };
    }
    if (result.stop) {
      return { ok: false, errors: result.errors, attempts };
    }
    lastErrors = result.errors;
    prompt = buildRepairPrompt(initialPrompt, output, result.retry_hint);
    logger.debug?.('validator retry', { attempts, failed_validator: result.failed_validator, errors: result.errors });
  }

  return { ok: false, errors: lastErrors || ['max retries exhausted'], attempts };
}

function buildRepairPrompt(originalPrompt, lastOutput, retryHint) {
  return `${originalPrompt}

Your previous attempt was:
---
${lastOutput}
---

${retryHint || 'The output failed validation. Please try again.'}`;
}

module.exports = { runWithValidators };
```

Run tests → PASS. Commit: `feat(validators): retry runtime with repair prompts`.

---

## Task 3: Wire into task-finalizer

- [ ] **Step 1: Tool def**

In `server/tool-defs/task-defs.js`:

```js
validators: {
  type: 'array',
  description: 'Validators applied to the task output. On failure, the validator retry runtime injects the error and retries.',
  items: {
    type: 'object',
    required: ['type'],
    properties: {
      type: { type: 'string', description: 'Name of the validator: schema | non_empty | json_parseable | min_length | <custom>' },
      schema: { type: 'object', description: 'For type=schema: JSON Schema to validate against.' },
      min: { type: 'integer', description: 'For type=min_length.' },
    },
  },
},
max_validator_retries: { type: 'integer', default: 3, minimum: 0, maximum: 10 },
```

- [ ] **Step 2: Adapter in task-startup**

In `server/execution/task-startup.js` around the provider invocation:

```js
const meta = parseTaskMetadata(task);
if (Array.isArray(meta.validators) && meta.validators.length > 0) {
  const { runWithValidators } = require('../validation/validator-retry-runtime');
  const provider = providerRegistry.getProviderInstance(task.provider);
  const result = await runWithValidators({
    callModel: async ({ prompt }) => provider.runPrompt({ prompt, format: 'json' }),
    initialPrompt: task.task_description,
    validators: meta.validators,
    maxRetries: meta.max_validator_retries ?? 3,
  });
  if (result.ok) {
    db.prepare(`UPDATE tasks SET status = 'completed', output = ?, completed_at = datetime('now') WHERE task_id = ?`)
      .run(typeof result.value === 'string' ? result.value : JSON.stringify(result.value), taskId);
  } else {
    db.prepare(`UPDATE tasks SET status = 'failed', error_output = ?, completed_at = datetime('now') WHERE task_id = ?`)
      .run(JSON.stringify(result.errors), taskId);
  }
  // Tag with attempt count for analytics
  addTaskTag(taskId, `validator_retries:${result.attempts - 1}`);
  return;
}
```

- [ ] **Step 3: Plugin hook for custom validators**

Allow plugins (Plan 50) to register validators in their `provides.validators` map. The retry runtime's registry is built by merging `VALIDATORS` with all registered plugin validators.

`await_restart`. Smoke: submit a task with prompt "return {ok: true}" and `validators: [{type:'schema', schema: {type:'object', required:['ok']}}]`. Have the first model call return "{wrong: true}" (e.g., via a stub provider). Confirm retry with the schema error in the second call's prompt. Confirm `validator_retries:1` tag appears on the task.

Commit: `feat(validators): task-finalizer honors validators + repair retries`.
