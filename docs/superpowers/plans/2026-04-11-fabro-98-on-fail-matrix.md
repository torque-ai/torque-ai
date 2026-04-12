# Fabro #98: Validator On-Fail Action Matrix (Guardrails AI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend Plan 59 (validator-driven retry) with a structured **on_fail action matrix**: every validator declares one of `reask`, `fix`, `filter`, `refrain`, `exception`, or `noop` — and the engine routes failures accordingly. Inspired by Guardrails AI.

**Architecture:** A `validator-registry.js` stores `{ name, validate(value), onFail, fix?(value,err) }`. A `on-fail-dispatcher.js` maps each action:
- `reask` — surface a `ReAsk` object with the validator's feedback; the provider sees it as a structured retry hint.
- `fix` — call the validator's `fix(value, err)` to transform the output in-place.
- `filter` — strip the offending value (null or remove from array).
- `refrain` — short-circuit; emit sentinel `{ refrained: true, reason }`.
- `exception` — throw a typed `ValidationFailedError`.
- `noop` — log + pass through.

This extends rather than replaces Plan 59's retry loop: Plan 59 owns the retry mechanics; Plan 98 owns the *policy* for each validator.

**Tech Stack:** Node.js. Builds on Plan 59 validator-retry.

---

## File Structure

**New files:**
- `server/validators/validator-registry.js`
- `server/validators/on-fail-dispatcher.js`
- `server/validators/reask.js`
- `server/tests/on-fail-dispatcher.test.js`
- `server/tests/validator-registry.test.js`

**Modified files:**
- `server/validators/retry-loop.js` (Plan 59) — call dispatcher instead of hard-retry
- `server/handlers/mcp-tools.js` — `register_validator`, `list_validators`

---

## Task 1: Registry + dispatcher

- [ ] **Step 1: Registry tests**

Create `server/tests/validator-registry.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { createValidatorRegistry } = require('../validators/validator-registry');

describe('validatorRegistry', () => {
  let reg;
  beforeEach(() => { reg = createValidatorRegistry(); });

  it('register + get', () => {
    reg.register({ name: 'non-empty', validate: v => !!v, onFail: 'exception' });
    const v = reg.get('non-empty');
    expect(v.name).toBe('non-empty');
    expect(v.onFail).toBe('exception');
  });

  it('rejects unknown onFail action', () => {
    expect(() => reg.register({ name: 'x', validate: () => true, onFail: 'bogus' })).toThrow(/onFail/);
  });

  it('list returns all registered validators', () => {
    reg.register({ name: 'a', validate: () => true, onFail: 'noop' });
    reg.register({ name: 'b', validate: () => true, onFail: 'reask' });
    expect(reg.list().map(v => v.name).sort()).toEqual(['a', 'b']);
  });

  it('fix required when onFail=fix', () => {
    expect(() => reg.register({ name: 'lower', validate: v => v === v.toLowerCase(), onFail: 'fix' })).toThrow(/fix/);
    reg.register({ name: 'lower', validate: v => v === v.toLowerCase(), fix: v => v.toLowerCase(), onFail: 'fix' });
    expect(reg.get('lower').fix('ABC')).toBe('abc');
  });
});
```

- [ ] **Step 2: Implement registry**

Create `server/validators/validator-registry.js`:

```js
'use strict';

const VALID_ON_FAIL = new Set(['reask', 'fix', 'filter', 'refrain', 'exception', 'noop']);

function createValidatorRegistry() {
  const map = new Map();

  function register({ name, validate, fix, onFail }) {
    if (!name || typeof validate !== 'function') throw new Error('name+validate required');
    if (!VALID_ON_FAIL.has(onFail)) throw new Error(`unknown onFail: ${onFail}`);
    if (onFail === 'fix' && typeof fix !== 'function') throw new Error('onFail=fix requires a fix(value,err) function');
    map.set(name, { name, validate, fix, onFail });
  }

  return {
    register,
    get: (name) => map.get(name),
    list: () => [...map.values()],
    has: (name) => map.has(name),
  };
}

module.exports = { createValidatorRegistry };
```

- [ ] **Step 3: Dispatcher tests**

Create `server/tests/on-fail-dispatcher.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { createValidatorRegistry } = require('../validators/validator-registry');
const { dispatch, ValidationFailedError } = require('../validators/on-fail-dispatcher');
const { isReask } = require('../validators/reask');

describe('on-fail dispatcher', () => {
  it('reask returns a ReAsk sentinel with feedback', async () => {
    const reg = createValidatorRegistry();
    reg.register({ name: 'needs-json', validate: () => false, onFail: 'reask' });
    const out = await dispatch({ registry: reg, validator: 'needs-json', value: 'not json', error: 'invalid JSON' });
    expect(isReask(out)).toBe(true);
    expect(out.feedback).toMatch(/invalid JSON/);
  });

  it('fix applies the transformer', async () => {
    const reg = createValidatorRegistry();
    reg.register({ name: 'lower', validate: v => v === v.toLowerCase(), fix: v => v.toLowerCase(), onFail: 'fix' });
    const out = await dispatch({ registry: reg, validator: 'lower', value: 'ABC', error: 'uppercase' });
    expect(out).toBe('abc');
  });

  it('filter returns null for single values', async () => {
    const reg = createValidatorRegistry();
    reg.register({ name: 'reject', validate: () => false, onFail: 'filter' });
    expect(await dispatch({ registry: reg, validator: 'reject', value: 'x', error: 'bad' })).toBeNull();
  });

  it('refrain returns a sentinel', async () => {
    const reg = createValidatorRegistry();
    reg.register({ name: 'unsafe', validate: () => false, onFail: 'refrain' });
    const out = await dispatch({ registry: reg, validator: 'unsafe', value: 'x', error: 'unsafe content' });
    expect(out).toEqual({ refrained: true, reason: 'unsafe content' });
  });

  it('exception throws typed error', async () => {
    const reg = createValidatorRegistry();
    reg.register({ name: 'strict', validate: () => false, onFail: 'exception' });
    await expect(dispatch({ registry: reg, validator: 'strict', value: 'x', error: 'strict fail' })).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('noop passes value through', async () => {
    const reg = createValidatorRegistry();
    reg.register({ name: 'soft', validate: () => false, onFail: 'noop' });
    expect(await dispatch({ registry: reg, validator: 'soft', value: 'x', error: 'ignored' })).toBe('x');
  });
});
```

- [ ] **Step 4: Implement dispatcher + ReAsk**

Create `server/validators/reask.js`:

```js
'use strict';

const REASK_TAG = Symbol.for('torque.validators.reask');

function createReask(feedback, { validator, originalValue } = {}) {
  return { [REASK_TAG]: true, __reask: true, feedback, validator, originalValue };
}

function isReask(x) { return !!(x && typeof x === 'object' && x[REASK_TAG] === true); }

module.exports = { createReask, isReask, REASK_TAG };
```

Create `server/validators/on-fail-dispatcher.js`:

```js
'use strict';
const { createReask } = require('./reask');

class ValidationFailedError extends Error {
  constructor(message, { validator, value } = {}) {
    super(message);
    this.name = 'ValidationFailedError';
    this.validator = validator;
    this.value = value;
  }
}

async function dispatch({ registry, validator, value, error }) {
  const v = registry.get(validator);
  if (!v) throw new Error(`unknown validator: ${validator}`);

  switch (v.onFail) {
    case 'reask':
      return createReask(`Validator ${validator} rejected output: ${error}`, { validator, originalValue: value });
    case 'fix':
      return v.fix(value, error);
    case 'filter':
      return null;
    case 'refrain':
      return { refrained: true, reason: error };
    case 'exception':
      throw new ValidationFailedError(`${validator}: ${error}`, { validator, value });
    case 'noop':
      return value;
    default:
      throw new Error(`unreachable onFail: ${v.onFail}`);
  }
}

module.exports = { dispatch, ValidationFailedError };
```

Run tests → PASS. Commit: `feat(validators): on-fail action matrix + ReAsk primitive`.

---

## Task 2: Retry-loop integration + MCP

- [ ] **Step 1: Patch Plan 59 retry loop**

In `server/validators/retry-loop.js`, when a validator rejects output:

```js
const { dispatch, ValidationFailedError } = require('./on-fail-dispatcher');
const { isReask } = require('./reask');

// inside the retry loop, after validator fails:
const handled = await dispatch({ registry, validator: v.name, value: output, error: verr });
if (isReask(handled)) {
  // Append ReAsk feedback to next prompt and retry
  messages.push({ role: 'system', content: `[ReAsk] ${handled.feedback}` });
  continue;
}
if (handled?.refrained) return handled;
output = handled; // fix/filter/noop replaced the value
break;
```

- [ ] **Step 2: MCP tools**

In `server/handlers/mcp-tools.js`:

```js
register_validator: {
  description: 'Register a named validator with an on_fail action. Validator JS runs in a restricted sandbox.',
  inputSchema: {
    type: 'object',
    required: ['name', 'validate_js', 'on_fail'],
    properties: {
      name: { type: 'string' },
      validate_js: { type: 'string', description: '(value) => boolean' },
      fix_js: { type: 'string', description: '(value, err) => value   (required when on_fail=fix)' },
      on_fail: { enum: ['reask', 'fix', 'filter', 'refrain', 'exception', 'noop'] },
    },
  },
},
list_validators: { description: 'List registered validators.', inputSchema: { type: 'object' } },
```

Smoke: register a `json-only` validator with `on_fail: reask` → provoke a non-JSON output → confirm a retry turn includes the ReAsk feedback.

Commit: `feat(validators): wire on-fail matrix into retry-loop + MCP surface`.
