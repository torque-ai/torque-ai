# Fabro #23: Typed Task Signatures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let workflow tasks declare typed input/output contracts in their YAML node, and have the runtime validate them. A task that declares `signature.output` must produce JSON matching that schema or it is marked `failed` with a structured `signature_violation` reason; downstream tasks can then reference the parsed shape via the existing `{{node_id.output}}` / `context_from` injection. Inspired by DSPy's signatures, but expressed as a first-class YAML field rather than a side-table.

**Architecture:** This is an **additive extension to the shipped workflow YAML schema** (`server/workflow-spec/schema.js`), not a parallel signature registry. Each item under `tasks[]` may declare an optional `signature` object with `inputs` and/or `output`, both ordinary JSON Schema fragments. The schema is propagated through three already-canonical paths: (1) `parseSpec` keeps the field on the normalized task object; (2) `buildWorkflowTaskMetadata` (in `server/handlers/workflow/index.js`) persists `signature` into `tasks.metadata.signature`; (3) the completion pipeline (`server/execution/completion-pipeline.js`, Phase 8 of the close-handler sequence) validates `task.output` against `signature.output` before firing the `task_complete` hook. Validation reuses the same Ajv plumbing the crew runner already uses for `crew.output_schema` (`server/crew/crew-runner.js:150`), so this introduces no new dependency. Inputs are validated at task admission inside `evaluateWorkflowTaskSubmissionPolicy` against the `invoked_with_params` block already attached to sub-workflow / template tasks.

**Tech Stack:** Node.js, Ajv (already a dependency, used by `workflow-spec/parse.js` and `crew/crew-runner.js`), js-yaml (workflow-spec), better-sqlite3 (metadata persistence), Vitest.

**Test invocation:** Run all `torque-remote` commands with the remote project path substituted in. From the worktree root: `torque-remote bash -c "cd server && npx vitest run tests/<file> --no-coverage"`. Do not hard-code local absolute paths.

---

## File Structure

**New files:**
- `server/workflow-spec/signature-validator.js` — pure module: `compileSignature`, `validateInputs`, `validateOutput`, `parseStructuredOutput`. Reuses the shared Ajv instance pattern.
- `server/tests/workflow-spec-signature.test.js` — unit tests for the validator (compile, valid/invalid inputs, valid/invalid output, JSON parsing, missing-signature passthrough).
- `server/tests/workflow-spec-signature-integration.test.js` — end-to-end: a YAML spec with `signature` survives parse → `create_workflow` → `tasks.metadata` → completion-pipeline validation, and a violating output produces `status='failed'` with `signature_violation` populated.
- `docs/workflow-signatures.md` — user-facing reference; lives next to `docs/workflow-specs.md`.

**Modified files:**
- `server/workflow-spec/schema.js` — add `signature` to the per-task properties block (additive only; preserves `additionalProperties: false`).
- `server/workflow-spec/parse.js` — no logic change, but extend test coverage to confirm `signature` round-trips.
- `server/handlers/workflow/index.js` — `buildWorkflowTaskMetadata` copies `signature` into the metadata blob.
- `server/tool-defs/workflow-defs.js` — mirror the `signature` field on the `create_workflow` / `add_workflow_task` task-item schema so MCP callers see it.
- `server/execution/completion-pipeline.js` — new helper `validateTaskSignature(task)` invoked just before terminal hooks fire; on violation, mutates the close context to `failed` and records the structured reason.
- `docs/workflow-specs.md` — append a "Typed signatures" section with a forward link to `workflow-signatures.md`.
- `workflows/example-plan-implement.yaml` — annotate one node with a `signature.output` so the example doubles as a smoke test.

---

## Task 1: Validator module

**Files:**
- Create: `server/workflow-spec/signature-validator.js`
- Create: `server/tests/workflow-spec-signature.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/workflow-spec-signature.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const {
  validateInputs,
  validateOutput,
  parseStructuredOutput,
} = require('../workflow-spec/signature-validator');

describe('signature-validator', () => {
  it('passes through when no signature is provided', () => {
    expect(validateInputs(null, {}).valid).toBe(true);
    expect(validateInputs(undefined, {}).valid).toBe(true);
    expect(validateOutput(null, 'whatever').valid).toBe(true);
  });

  it('validates inputs against an inputs schema', () => {
    const sig = {
      inputs: {
        type: 'object',
        required: ['target_file'],
        properties: { target_file: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
    };
    expect(validateInputs(sig, { target_file: 'a.js' }).valid).toBe(true);
    const bad = validateInputs(sig, {});
    expect(bad.valid).toBe(false);
    expect(bad.errors).toMatch(/target_file/);
  });

  it('validates structured output against an output schema', () => {
    const sig = {
      output: {
        type: 'object',
        required: ['summary'],
        properties: { summary: { type: 'string' }, score: { type: 'number' } },
      },
    };
    expect(validateOutput(sig, { summary: 'ok', score: 5 }).valid).toBe(true);
    const missing = validateOutput(sig, { score: 5 });
    expect(missing.valid).toBe(false);
    expect(missing.errors).toMatch(/summary/);
  });

  it('parses string output as JSON before validating', () => {
    const sig = {
      output: { type: 'object', required: ['x'], properties: { x: { type: 'number' } } },
    };
    const ok = validateOutput(sig, '{"x": 5}');
    expect(ok.valid).toBe(true);
    expect(ok.parsed).toEqual({ x: 5 });
    const bad = validateOutput(sig, '{"x": "no"}');
    expect(bad.valid).toBe(false);
  });

  it('reports parse failures clearly when output is not JSON', () => {
    const sig = { output: { type: 'object' } };
    const result = validateOutput(sig, 'free text not json');
    expect(result.valid).toBe(false);
    expect(result.errors).toMatch(/not valid JSON|JSON/i);
  });

  it('parseStructuredOutput extracts the first JSON code fence when present', () => {
    const text = 'Here is the result:\n```json\n{"x":1}\n```\nDone.';
    expect(parseStructuredOutput(text)).toEqual({ x: 1 });
  });

  it('parseStructuredOutput returns null when no JSON is found', () => {
    expect(parseStructuredOutput('plain text')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

`torque-remote bash -c "cd server && npx vitest run tests/workflow-spec-signature.test.js --no-coverage"`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the validator**

Create `server/workflow-spec/signature-validator.js`:

```js
'use strict';

const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });
const schemaCache = new WeakMap();

function compile(schema) {
  if (!schema || typeof schema !== 'object') return null;
  let validate = schemaCache.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    schemaCache.set(schema, validate);
  }
  return validate;
}

function describeErrors(errors) {
  return (errors || [])
    .map((err) => `${err.instancePath || '(root)'}: ${err.message}`)
    .join('; ');
}

function validateInputs(signature, inputs) {
  if (!signature || !signature.inputs) return { valid: true };
  const validator = compile(signature.inputs);
  if (!validator) return { valid: true };
  const ok = validator(inputs || {});
  return { valid: ok, errors: ok ? null : describeErrors(validator.errors) };
}

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;

function parseStructuredOutput(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  // Try whole-string JSON first.
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  // Try a fenced ```json block.
  const fence = trimmed.match(FENCE_RE);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ }
  }
  return null;
}

function validateOutput(signature, output) {
  if (!signature || !signature.output) return { valid: true };
  const parsed = parseStructuredOutput(output);
  if (parsed === null) {
    return { valid: false, errors: 'output is not valid JSON', parsed: null };
  }
  const validator = compile(signature.output);
  if (!validator) return { valid: true, parsed };
  const ok = validator(parsed);
  return {
    valid: ok,
    errors: ok ? null : describeErrors(validator.errors),
    parsed,
  };
}

module.exports = {
  validateInputs,
  validateOutput,
  parseStructuredOutput,
};
```

- [ ] **Step 4: Run tests to verify they pass**

`torque-remote bash -c "cd server && npx vitest run tests/workflow-spec-signature.test.js --no-coverage"`

Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/workflow-spec/signature-validator.js server/tests/workflow-spec-signature.test.js
git commit -m "feat(workflow-spec): typed signature validator"
```

---

## Task 2: Schema extension + parser round-trip

**Files:**
- Modify: `server/workflow-spec/schema.js`
- Modify: `server/tests/workflow-spec-parse.test.js` (add cases)

- [ ] **Step 1: Add `signature` to the per-task schema**

In `server/workflow-spec/schema.js`, inside the `tasks.items.properties` block (the existing object that already lists `node_id`, `task`, `provider`, `crew`, etc.), add — preserving the existing `additionalProperties: false` constraint:

```js
signature: {
  type: 'object',
  additionalProperties: false,
  description:
    'Typed I/O contract. Inputs validated at task admission; output validated post-execution against the JSON Schema. On violation the task transitions to status=failed with metadata.signature_violation populated.',
  properties: {
    inputs: { type: 'object', description: 'JSON Schema fragment for the input bag (params, context).' },
    output: { type: 'object', description: 'JSON Schema fragment for the parsed task output.' },
  },
},
```

Do not touch any other schema field. Do not relax `additionalProperties: false` — the new field is now explicitly listed.

- [ ] **Step 2: Append round-trip tests to the existing parse test file**

In `server/tests/workflow-spec-parse.test.js`, append:

```js
describe('workflow-spec parseSpecString — signatures', () => {
  it('preserves signature on the normalized task', () => {
    const yaml = `
version: 1
name: x
tasks:
  - node_id: a
    task: Produce JSON
    signature:
      output:
        type: object
        required: [name]
        properties:
          name: { type: string }
`;
    const result = parseSpecString(yaml);
    expect(result.ok).toBe(true);
    expect(result.spec.tasks[0].signature.output.required).toEqual(['name']);
  });

  it('rejects unknown keys inside signature (additionalProperties: false)', () => {
    const yaml = `
version: 1
name: x
tasks:
  - node_id: a
    task: y
    signature:
      bogus: true
`;
    const result = parseSpecString(yaml);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/bogus|additional/i);
  });
});
```

- [ ] **Step 3: Run parse tests**

`torque-remote bash -c "cd server && npx vitest run tests/workflow-spec-parse.test.js --no-coverage"`

Expected: PASS — pre-existing tests still green plus the two new tests.

- [ ] **Step 4: Commit**

```bash
git add server/workflow-spec/schema.js server/tests/workflow-spec-parse.test.js
git commit -m "feat(workflow-spec): add per-task signature field to YAML schema"
```

---

## Task 3: Persist signature through workflow metadata

**Files:**
- Modify: `server/handlers/workflow/index.js`
- Modify: `server/tool-defs/workflow-defs.js`
- Modify: `server/tests/workflow-handlers.test.js` (or sibling) — add a metadata-shape assertion.

- [ ] **Step 1: Persist signature in `buildWorkflowTaskMetadata`**

In `server/handlers/workflow/index.js`, locate the `buildWorkflowTaskMetadata` function (around line 410). Add a single field copy alongside the existing `kind === 'crew'` block:

```js
if (taskLike.signature && typeof taskLike.signature === 'object') {
  metaObj.signature = taskLike.signature;
}
```

Do not transform or re-validate — the YAML schema already validated shape; the runtime treats `metadata.signature` as the source of truth.

- [ ] **Step 2: Mirror `signature` in the MCP tool definitions**

In `server/tool-defs/workflow-defs.js`, locate the per-task schema used by `create_workflow` / `add_workflow_task`. Add a `signature` property mirroring the YAML schema (object with `inputs` / `output` as JSON Schema fragments). Do not introduce a new top-level tool.

- [ ] **Step 3: Assert metadata round-trip**

Append to an appropriate handler test (e.g. `server/tests/workflow-handlers.test.js`):

```js
it('persists signature on task metadata', () => {
  const result = handleCreateWorkflow({
    name: 'sig-roundtrip',
    tasks: [{
      node_id: 'a',
      task: 'Return JSON',
      signature: { output: { type: 'object', required: ['x'], properties: { x: { type: 'number' } } } },
    }],
  });
  const workflowId = result.structuredData.workflow_id;
  const tasks = db.getWorkflowTasks(workflowId);
  const meta = JSON.parse(tasks[0].metadata || '{}');
  expect(meta.signature.output.required).toEqual(['x']);
});
```

- [ ] **Step 4: Run handler tests**

`torque-remote bash -c "cd server && npx vitest run tests/workflow-handlers.test.js --no-coverage"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/handlers/workflow/index.js server/tool-defs/workflow-defs.js server/tests/workflow-handlers.test.js
git commit -m "feat(workflow): persist signature on task metadata"
```

---

## Task 4: Validate output in completion-pipeline

**Files:**
- Modify: `server/execution/completion-pipeline.js`
- Modify or create: `server/tests/completion-pipeline-signature.test.js`

- [ ] **Step 1: Write failing integration test**

Create `server/tests/completion-pipeline-signature.test.js`. The test should: insert a task whose `metadata.signature.output` requires `{ summary: string }`, simulate a completion with output `"plain text"`, drive the completion pipeline, and assert the task ends `status='failed'` with `metadata.signature_violation` set. Use the same DI / setup helpers other completion-pipeline tests use (see `server/tests/close-handler-helpers.test.js` for a template). A second case asserts that valid JSON output keeps the task `completed`.

- [ ] **Step 2: Run test to verify it fails**

`torque-remote bash -c "cd server && npx vitest run tests/completion-pipeline-signature.test.js --no-coverage"`

Expected: FAIL.

- [ ] **Step 3: Implement validation hook**

In `server/execution/completion-pipeline.js`, add a helper `validateTaskSignature(task)` that:

1. Parses `task.metadata` (handle string or object).
2. If no `signature.output`, return `{ valid: true }` (zero-cost passthrough).
3. Loads `validateOutput` lazily: `const { validateOutput } = require('../workflow-spec/signature-validator');`.
4. Calls `validateOutput(meta.signature, task.output)`.
5. Returns `{ valid, errors, parsed }`.

Wire the helper into the pipeline immediately before the terminal `task_complete` hook fires, **only when the incoming status is `completed`**. On `valid === false`:

- Mutate the close context: `status = 'failed'`, append a clearly-labeled `[signature]` block to `error_output`, and write `signature_violation: <error string>` into `metadata`.
- Persist via the existing raw-DB update path the pipeline already uses for terminal mutations (do not introduce a new persistence mechanism).
- Fire `task_fail` instead of `task_complete`.

On `valid === true` with a non-null `parsed`, optionally write `metadata.signature_parsed = parsed` so downstream `{{node.output}}` consumers can reference structured fields without re-parsing. This is opt-in — only when `parsed !== null`.

- [ ] **Step 4: Run test to verify it passes**

`torque-remote bash -c "cd server && npx vitest run tests/completion-pipeline-signature.test.js --no-coverage"`

Expected: PASS — both cases green.

- [ ] **Step 5: Run the full completion-pipeline test bundle**

`torque-remote bash -c "cd server && npx vitest run tests/completion-pipeline tests/close-handler --no-coverage"`

Expected: PASS — no regressions in adjacent close-handler tests.

- [ ] **Step 6: Commit**

```bash
git add server/execution/completion-pipeline.js server/tests/completion-pipeline-signature.test.js
git commit -m "feat(workflow): validate task output against signature in completion pipeline"
```

---

## Task 5: Validate inputs at admission (opt-in path)

**Files:**
- Modify: `server/handlers/workflow/index.js`

- [ ] **Step 1: Wire `validateInputs` into submission policy**

In `server/handlers/workflow/index.js`, inside `evaluateWorkflowTaskSubmissionPolicy` (or an equivalent admission helper that already touches `metadata`), add:

```js
if (taskLike.signature?.inputs) {
  const { validateInputs } = require('../workflow-spec/signature-validator');
  const inputs = taskLike.invoked_with_params || taskLike.params || {};
  const result = validateInputs(taskLike.signature, inputs);
  if (!result.valid) {
    return {
      blocked: true,
      reason: `signature_inputs: ${result.errors}`,
      stage: 'task_submission',
    };
  }
}
```

This piggybacks on the existing rejection path — rejected tasks are already collected via `appendRejectedTasks`. No new error sink is needed.

- [ ] **Step 2: Add a handler test**

Add a case to `server/tests/workflow-handlers.test.js` asserting that a workflow whose task declares `signature.inputs` requiring `target_file` and is invoked without one is rejected with reason matching `/signature_inputs/`.

- [ ] **Step 3: Run + commit**

```bash
torque-remote bash -c "cd server && npx vitest run tests/workflow-handlers.test.js --no-coverage"
git add server/handlers/workflow/index.js server/tests/workflow-handlers.test.js
git commit -m "feat(workflow): validate signature.inputs at task admission"
```

---

## Task 6: End-to-end integration test

**Files:**
- Create: `server/tests/workflow-spec-signature-integration.test.js`

- [ ] **Step 1: Write the test**

The test writes a YAML spec containing two tasks where node `b` depends on node `a`, `a` declares `signature.output: { required: ['summary'] }`, and the test stubs `a`'s execution to produce a non-conforming string. Drive the spec through `handleRunWorkflowSpec` (already shipped in `server/handlers/workflow-spec-handlers.js`), force-complete `a` via the test DB helpers used by `workflow-spec-integration.test.js`, then run the completion pipeline and assert:

1. `a.status === 'failed'`.
2. `JSON.parse(a.metadata).signature_violation` matches `/summary/`.
3. `b` remains `blocked` (signature failure does not silently propagate).

Then repeat with a conforming JSON output and assert `a.status === 'completed'`, `b.status === 'pending'`, and `JSON.parse(a.metadata).signature_parsed.summary` is set.

- [ ] **Step 2: Run + commit**

```bash
torque-remote bash -c "cd server && npx vitest run tests/workflow-spec-signature-integration.test.js --no-coverage"
git add server/tests/workflow-spec-signature-integration.test.js
git commit -m "test(workflow-spec): end-to-end signature validation integration"
```

---

## Task 7: Documentation + example

**Files:**
- Create: `docs/workflow-signatures.md`
- Modify: `docs/workflow-specs.md` (append a "Typed signatures" link section)
- Modify: `workflows/example-plan-implement.yaml` (add a `signature.output` to one node)

- [ ] **Step 1: Author `docs/workflow-signatures.md`**

Sections, in order: Overview (what, why), YAML form (example with both `inputs` and `output`), Validation lifecycle (admission for inputs, completion-pipeline for output), Failure shape (the `signature_violation` metadata field), Output reuse (how `metadata.signature_parsed` interacts with `{{node_id.output}}` injection), Compatibility (untyped tasks unchanged — the field is opt-in), Limitations (only validates when output parses as JSON; non-JSON outputs in signed tasks fail by design).

- [ ] **Step 2: Append a forward link to `docs/workflow-specs.md`**

Add a short "Typed signatures" subsection under the Schema table that says signatures are documented in `workflow-signatures.md` and links the file.

- [ ] **Step 3: Annotate the example workflow**

In `workflows/example-plan-implement.yaml`, add a `signature.output` to one node (e.g. a hypothetical `summarize` node, or annotate the existing `simplify` step) so that running the example exercises the validator. Keep the schema minimal (`type: object, required: [status]`).

- [ ] **Step 4: Commit**

```bash
git add docs/workflow-signatures.md docs/workflow-specs.md workflows/example-plan-implement.yaml
git commit -m "docs(workflow-spec): typed signatures guide and annotated example"
```

---

## Task 8: Verification + restart

- [ ] **Step 1: Full workflow-spec test bundle**

`torque-remote bash -c "cd server && npx vitest run tests/workflow-spec tests/completion-pipeline-signature tests/workflow-handlers --no-coverage"`

Expected: all green.

- [ ] **Step 2: Cutover**

Use `scripts/worktree-cutover.sh feat-plan-rewrites` (or the equivalent merge + `await_restart` flow) so the new validator and metadata path go live without violating the restart-barrier discipline.

- [ ] **Step 3: Smoke test via MCP**

After restart:

```
validate_workflow_spec { spec_path: "workflows/example-plan-implement.yaml" }
```

Expected: `valid: true` and the new `signature` field appears in the parsed spec for the annotated node.

```
run_workflow_spec { spec_path: "workflows/example-plan-implement.yaml" }
```

Expected: workflow created; the annotated task's `metadata.signature` is present in `tasks` rows when inspected via `task_info` or the dashboard.

---

## Verification

The feature is correctly integrated when all of the following hold:

1. A workflow YAML with a `signature.output` block parses without error and the field round-trips through `tasks.metadata.signature` in the DB.
2. A signed task whose final output is non-JSON, or fails JSON-Schema validation, ends in `status='failed'` with `metadata.signature_violation` populated and a `[signature]` marker in `error_output`.
3. A signed task whose final output is conforming JSON ends in `status='completed'` with `metadata.signature_parsed` populated.
4. A signed task with `signature.inputs` is rejected at admission when called without the required params, surfacing through the existing `appendRejectedTasks` path.
5. Untyped tasks (no `signature` field) behave exactly as before — no new validation cost, no new code paths reached.
6. Existing tests (`workflow-spec-parse.test.js`, `workflow-spec-integration.test.js`, `workflow-handlers.test.js`, the close-handler suite) all stay green.

## Compatibility

- **Opt-in.** The `signature` field is optional everywhere. Existing YAML specs and existing `create_workflow` calls remain valid and produce identical behavior.
- **Schema-additive.** `additionalProperties: false` on the per-task block is preserved by explicitly enumerating `signature` — no rewrite of existing field validation.
- **No DB migration.** Signatures live inside the existing `tasks.metadata` JSON blob; no column additions, no new indexes.
- **Auto-inference is out of scope.** Phase 1 ships the explicit form only. A future plan can add inferred signatures from `crew.output_schema` or from declared structured-output tools, but that is separate work.
- **Provider neutrality.** Validation is post-execution and provider-agnostic; it does not require any provider to support structured outputs natively. Providers that do produce JSON pass; providers that produce free text fail signed tasks by design — that is the contract the plan ships.

---

**version_intent:** `feature`
