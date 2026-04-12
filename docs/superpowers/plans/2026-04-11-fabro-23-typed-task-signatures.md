# Fabro #23: Typed Task Signatures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Define typed input/output contracts for tasks. Inputs declare expected fields with types; outputs declare expected return shape. The runtime validates outputs against the schema before marking the task complete. Inspired by DSPy's signatures.

**Architecture:** Per-task `signature: { inputs: {...JSON Schema}, output: {...JSON Schema} }`. When a task starts, declared inputs are validated against the prompt context and the workflow goal. When a task completes, if the output is structured (provider returned JSON), validate against `signature.output` and mark task `failed` if it doesn't match. This formalizes what TORQUE already does ad-hoc with verify gates and gives downstream tasks a typed handle on prior outputs.

---

## File Structure

**New files:**
- `server/signatures/validator.js` — input/output validation
- `server/tests/signatures.test.js`

**Modified files:**
- `server/handlers/workflow/index.js` — accept `signature` per task
- `server/tool-defs/workflow-defs.js`
- `server/workflow-spec/schema.js`
- `server/execution/task-startup.js` — validate inputs at start
- `server/execution/task-finalizer.js` — validate output at finalization
- `docs/signatures.md`

---

## Task 1: Validator

- [ ] **Step 1: Tests + implementation**

Create `server/tests/signatures.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { validateInputs, validateOutput } = require('../signatures/validator');

describe('signatures', () => {
  it('validates inputs against schema', () => {
    const sig = { inputs: { type: 'object', required: ['target_file'], properties: { target_file: { type: 'string' } } } };
    expect(validateInputs(sig, { target_file: 'a.js' }).valid).toBe(true);
    expect(validateInputs(sig, {}).valid).toBe(false);
  });

  it('validates output against schema', () => {
    const sig = { output: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' }, score: { type: 'number' } } } };
    expect(validateOutput(sig, { summary: 'ok', score: 5 }).valid).toBe(true);
    expect(validateOutput(sig, { score: 5 }).valid).toBe(false);
    expect(validateOutput(sig, 'not an object').valid).toBe(false);
  });

  it('returns valid=true when no signature provided', () => {
    expect(validateInputs(null, {}).valid).toBe(true);
    expect(validateOutput(null, 'anything').valid).toBe(true);
  });

  it('parses output as JSON when string', () => {
    const sig = { output: { type: 'object', required: ['x'], properties: { x: { type: 'number' } } } };
    expect(validateOutput(sig, '{"x": 5}').valid).toBe(true);
    expect(validateOutput(sig, '{"x": "not a number"}').valid).toBe(false);
  });
});
```

Create `server/signatures/validator.js`:

```js
'use strict';

const Ajv = require('ajv');
const ajv = new Ajv({ strict: false, allErrors: true });

function compile(schema) {
  return schema ? ajv.compile(schema) : null;
}

function describeErrors(errors) {
  return (errors || []).map(e => `${e.instancePath || '(root)'}: ${e.message}`).join('; ');
}

function validateInputs(signature, inputs) {
  if (!signature || !signature.inputs) return { valid: true };
  const validate = compile(signature.inputs);
  const ok = validate(inputs || {});
  return { valid: ok, errors: ok ? null : describeErrors(validate.errors) };
}

function validateOutput(signature, output) {
  if (!signature || !signature.output) return { valid: true };
  let parsed = output;
  if (typeof output === 'string') {
    try { parsed = JSON.parse(output); }
    catch { return { valid: false, errors: 'output is not valid JSON' }; }
  }
  const validate = compile(signature.output);
  const ok = validate(parsed);
  return { valid: ok, errors: ok ? null : describeErrors(validate.errors), parsed };
}

module.exports = { validateInputs, validateOutput };
```

Run tests → PASS. Commit: `feat(signatures): input/output validation`.

---

## Task 2: Wire into workflow + finalizer

- [ ] **Step 1: Tool def**

In `server/tool-defs/workflow-defs.js` `tasks.items.properties`:

```js
signature: {
  type: 'object',
  description: 'Typed input/output contract. Inputs validated at task start; outputs validated at finalization.',
  properties: {
    inputs: { type: 'object', description: 'JSON Schema for expected inputs' },
    output: { type: 'object', description: 'JSON Schema for expected output (parsed from task output if string)' },
  },
},
```

In `buildWorkflowTaskMetadata`:

```js
if (taskLike.signature) metaObj.signature = taskLike.signature;
```

- [ ] **Step 2: Validate inputs at task start**

In `task-startup.js`, after task is loaded:

```js
let taskMeta;
try { taskMeta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}); } catch { taskMeta = {}; }
if (taskMeta.signature?.inputs) {
  const { validateInputs } = require('../signatures/validator');
  // Inputs are derived from workflow context + task description (best effort — assemble what's available)
  const inputs = taskMeta.invoked_with_params || {};
  const result = validateInputs(taskMeta.signature, inputs);
  if (!result.valid) {
    db.updateTaskStatus(taskId, 'failed', { error_output: `Input signature violation: ${result.errors}` });
    return { queued: false, blocked: true };
  }
}
```

- [ ] **Step 3: Validate output at finalizer**

In `task-finalizer.js` after the provider produces output, before the final `updateTaskStatus`:

```js
let taskMeta;
try { taskMeta = typeof ctx.task.metadata === 'string' ? JSON.parse(ctx.task.metadata) : (ctx.task.metadata || {}); } catch { taskMeta = {}; }
if (taskMeta.signature?.output && ctx.status === 'completed') {
  const { validateOutput } = require('../signatures/validator');
  const result = validateOutput(taskMeta.signature, ctx.output);
  if (!result.valid) {
    ctx.status = 'failed';
    ctx.errorOutput = (ctx.errorOutput || '') + `\n\n[signature] Output validation failed: ${result.errors}`;
    metadata.signature_violation = result.errors;
  }
}
```

Commit: `feat(signatures): validate at task-start and finalization`.

---

## Task 3: Workflow-spec + docs

- [ ] **Step 1: Spec schema**

In `server/workflow-spec/schema.js` `tasks.items.properties`:

```js
signature: {
  type: 'object',
  properties: {
    inputs: { type: 'object' },
    output: { type: 'object' },
  },
},
```

- [ ] **Step 2: Docs**

Create `docs/signatures.md`:

````markdown
# Task Signatures

Declare typed input/output contracts for tasks. The runtime validates them and fails the task if outputs don't match the schema.

```yaml
- node_id: extract-summary
  task: |
    Read README.md and produce a JSON summary with name and stars.
  signature:
    output:
      type: object
      required: [name, stars]
      properties:
        name: { type: string }
        stars: { type: integer }
```

If the task's final output isn't valid JSON matching this schema, the task is marked `failed` with `signature_violation` in metadata.

## Inputs

```yaml
- node_id: render-card
  task: Render a card for {{ params.user_name }}
  signature:
    inputs:
      type: object
      required: [user_name]
      properties:
        user_name: { type: string, minLength: 1 }
```

Useful when a task is invoked as a sub-workflow with `params` (Plan 22).

## Why

Signatures formalize what verify gates do informally. A task that *says* it returns `{ name, stars }` and actually returns plain text fails fast, with a clear error in the task record, before downstream tasks try to consume the output.
````

Restart, smoke. Commit: `docs(signatures): typed task contracts guide`.
