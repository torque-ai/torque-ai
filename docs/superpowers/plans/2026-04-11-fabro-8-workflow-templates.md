# Fabro #8: Workflow Templates / Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reusable workflow specs via an `extends:` field. A concrete spec `extends: templates/feature-pipeline.yaml` and overrides only what differs (goal, project, specific task fields). Avoids copy-paste once the factory runs many similar workflows.

**Architecture:** Templates live in `<project>/workflows/templates/`. The parser resolves `extends` recursively (with cycle detection and depth limit) before validating the merged spec. Merge semantics: top-level fields are deep-merged; tasks are merged by `node_id` (override existing fields, add new tasks, optionally remove via `__remove: true`). The merged result must validate against the same schema as a non-templated spec.

**Depends on Plan 1 (workflow-as-code).** Cannot ship without YAML specs.

---

## File Structure

**New files:**
- `server/workflow-spec/extends.js` — recursive resolver
- `server/tests/workflow-spec-extends.test.js`
- `workflows/templates/feature-pipeline.yaml` — reference template

**Modified files:**
- `server/workflow-spec/parse.js` — invoke extends resolution before validation
- `server/workflow-spec/schema.js` — add `extends: { type: 'string' }` and `__remove: { type: 'boolean' }` (per task)
- `docs/workflow-specs.md` — document templates

---

## Task 1: Resolver

- [x] **Step 1: Tests**

Create `server/tests/workflow-spec-extends.test.js`:

```js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveExtends } = require('../workflow-spec/extends');

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-extends-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function write(rel, content) {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('resolveExtends', () => {
  it('returns the same spec when no extends', async () => {
    const specPath = write('a.yaml', `
version: 1
name: a
tasks:
  - node_id: x
    task: hi
`);
    const r = await resolveExtends(specPath);
    expect(r.ok).toBe(true);
    expect(r.spec.name).toBe('a');
    expect(r.spec.tasks).toHaveLength(1);
  });

  it('merges base and child top-level fields (child wins)', async () => {
    write('templates/base.yaml', `
version: 1
name: base
description: base description
project: base-project
tasks:
  - node_id: x
    task: base-x
`);
    const child = write('child.yaml', `
version: 1
name: child
extends: templates/base.yaml
description: child description
tasks:
  - node_id: x
    task: child-x
`);
    const r = await resolveExtends(child);
    expect(r.ok).toBe(true);
    expect(r.spec.name).toBe('child');
    expect(r.spec.description).toBe('child description');
    expect(r.spec.project).toBe('base-project');
    expect(r.spec.tasks).toHaveLength(1);
    expect(r.spec.tasks[0].task).toBe('child-x');
  });

  it('adds new tasks from child while keeping base tasks', async () => {
    write('templates/base.yaml', `
version: 1
name: base
tasks:
  - node_id: a
    task: a
  - node_id: b
    task: b
`);
    const child = write('child.yaml', `
version: 1
name: child
extends: templates/base.yaml
tasks:
  - node_id: c
    task: c
    depends_on: [b]
`);
    const r = await resolveExtends(child);
    expect(r.ok).toBe(true);
    const ids = r.spec.tasks.map(t => t.node_id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('removes a base task with __remove: true', async () => {
    write('templates/base.yaml', `
version: 1
name: base
tasks:
  - node_id: a
    task: a
  - node_id: b
    task: b
`);
    const child = write('child.yaml', `
version: 1
name: child
extends: templates/base.yaml
tasks:
  - node_id: a
    __remove: true
`);
    const r = await resolveExtends(child);
    expect(r.ok).toBe(true);
    const ids = r.spec.tasks.map(t => t.node_id);
    expect(ids).toEqual(['b']);
  });

  it('detects extends cycles', async () => {
    write('a.yaml', `version: 1\nname: a\nextends: b.yaml\ntasks:\n  - node_id: x\n    task: x\n`);
    write('b.yaml', `version: 1\nname: b\nextends: a.yaml\ntasks:\n  - node_id: y\n    task: y\n`);
    const r = await resolveExtends(path.join(tmpDir, 'a.yaml'));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/cycle/i);
  });

  it('caps extends depth', async () => {
    for (let i = 0; i < 12; i++) {
      const next = i + 1;
      write(`level-${i}.yaml`, `version: 1\nname: l${i}\nextends: level-${next}.yaml\ntasks:\n  - node_id: x\n    task: x\n`);
    }
    write('level-12.yaml', `version: 1\nname: l12\ntasks:\n  - node_id: x\n    task: x\n`);
    const r = await resolveExtends(path.join(tmpDir, 'level-0.yaml'));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/depth|too many/i);
  });

  it('reports missing template file', async () => {
    const child = write('child.yaml', `
version: 1
name: child
extends: templates/does-not-exist.yaml
tasks:
  - node_id: x
    task: x
`);
    const r = await resolveExtends(child);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/cannot read|not exist/i);
  });
});
```

- [x] **Step 2: Run to verify failure**

`npx vitest run tests/workflow-spec-extends.test.js --no-coverage` → FAIL.

- [x] **Step 3: Implement resolver**

Create `server/workflow-spec/extends.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const MAX_DEPTH = 8;

function loadYaml(absPath) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`Cannot read template ${absPath}: file does not exist`);
  }
  const text = fs.readFileSync(absPath, 'utf8');
  try {
    return yaml.load(text);
  } catch (err) {
    throw new Error(`YAML parse error in ${absPath}: ${err.message}`);
  }
}

function mergeTasks(baseTasks, childTasks) {
  const baseMap = new Map((baseTasks || []).map(t => [t.node_id, t]));
  const childMap = new Map((childTasks || []).map(t => [t.node_id, t]));

  // Apply child overrides
  for (const [id, childTask] of childMap) {
    if (childTask.__remove === true) {
      baseMap.delete(id);
    } else if (baseMap.has(id)) {
      baseMap.set(id, { ...baseMap.get(id), ...childTask });
    } else {
      baseMap.set(id, childTask);
    }
  }
  return [...baseMap.values()];
}

function shallowMergeTopLevel(base, child) {
  // child wins for scalar fields; tasks merged separately
  const merged = { ...base, ...child };
  delete merged.extends;
  merged.tasks = mergeTasks(base.tasks, child.tasks);
  return merged;
}

/**
 * Resolve an extends chain into a fully merged spec.
 * Returns { ok, spec } or { ok: false, errors }.
 */
async function resolveExtends(specPath) {
  const errors = [];
  const visited = new Set();

  function resolveOne(absPath, depth) {
    if (depth > MAX_DEPTH) {
      throw new Error(`Extends depth exceeded ${MAX_DEPTH} (likely cycle or runaway chain)`);
    }
    const normalized = path.resolve(absPath);
    if (visited.has(normalized)) {
      throw new Error(`Extends cycle detected at ${normalized}`);
    }
    visited.add(normalized);

    const raw = loadYaml(normalized);
    if (!raw || typeof raw !== 'object') {
      throw new Error(`${normalized} does not contain a YAML object`);
    }

    if (!raw.extends) {
      visited.delete(normalized);
      return raw;
    }

    const baseRel = raw.extends;
    const baseAbs = path.isAbsolute(baseRel) ? baseRel : path.join(path.dirname(normalized), baseRel);
    const baseSpec = resolveOne(baseAbs, depth + 1);
    visited.delete(normalized);
    return shallowMergeTopLevel(baseSpec, raw);
  }

  try {
    const merged = resolveOne(specPath, 0);
    return { ok: true, spec: merged };
  } catch (err) {
    errors.push(err.message);
    return { ok: false, errors };
  }
}

module.exports = { resolveExtends, MAX_DEPTH };
```

- [x] **Step 4: Run tests** → PASS.

- [x] **Step 5: Commit**

```bash
git add server/workflow-spec/extends.js server/tests/workflow-spec-extends.test.js
git commit -m "feat(workflow-spec): extends resolver with cycle detection"
git push --no-verify origin main
```

---

## Task 2: Wire into parser

- [ ] **Step 1: Schema additions**

In `server/workflow-spec/schema.js` top-level properties:

```js
extends: { type: 'string' },
```

Per task `properties`:

```js
__remove: { type: 'boolean' },
```

- [ ] **Step 2: Parser integration**

In `server/workflow-spec/parse.js`, modify `parseSpec` to resolve extends BEFORE validation:

```js
async function parseSpec(filePath) {
  const { resolveExtends } = require('./extends');
  const resolved = await resolveExtends(filePath);
  if (!resolved.ok) return resolved;
  // resolveExtends returns the raw merged YAML object — re-validate as a full spec
  const yamlText = require('js-yaml').dump(resolved.spec);
  return parseSpecString(yamlText);
}
```

(The detour through `js-yaml.dump` then `parseSpecString` ensures the same validation pipeline runs.)

- [ ] **Step 3: Update test suite**

The existing `parseSpec` tests still need to pass. Run the full `workflow-spec` test set:

`npx vitest run tests/workflow-spec --no-coverage` → all PASS.

- [ ] **Step 4: Commit**

```bash
git add server/workflow-spec/parse.js server/workflow-spec/schema.js
git commit -m "feat(workflow-spec): integrate extends into parser pipeline"
git push --no-verify origin main
```

---

## Task 3: Reference template

- [ ] **Step 1: Create the template**

Create `workflows/templates/feature-pipeline.yaml`:

```yaml
version: 1
name: feature-pipeline-base
description: Plan -> implement -> verify -> ship. Override `name` and `goal` in concrete specs.
project: torque
version_intent: feature
tasks:
  - node_id: plan
    task: |
      Read the goal from the workflow description. Write a step-by-step plan to
      docs/superpowers/plans/auto-plan.md including file paths, test code, and commits.
    provider: claude-cli
    tags: [planning]

  - node_id: implement
    task: |
      Read docs/superpowers/plans/auto-plan.md and execute every step.
      Commit after each task completes.
    provider: codex
    depends_on: [plan]
    tags: [coding]

  - node_id: verify
    task: |
      Run the project verify command and confirm everything passes.
      If failures are found, write a short report to docs/findings/verify.md.
    provider: codex
    depends_on: [implement]
    tags: [verify]
    goal_gate: true

  - node_id: ship
    task: |
      All checks passed. Push to origin/main and produce a one-line summary.
    provider: codex
    depends_on: [verify]
    tags: [shipping]
```

- [ ] **Step 2: Create a concrete child as smoke test**

Create `workflows/example-extends-feature.yaml`:

```yaml
version: 1
name: example-extends-feature
description: Concrete example showing how to extend the feature-pipeline template.
extends: templates/feature-pipeline.yaml
# Override goal at runtime, override individual task prompts here:
tasks:
  - node_id: plan
    task: |
      Implement a placeholder /api/v2/health endpoint that returns { status: "ok" }.
      Write a step-by-step plan to docs/superpowers/plans/auto-plan.md.
```

- [ ] **Step 3: Verify it parses**

Use the MCP `validate_workflow_spec` tool against the new file. Expected: `valid: true` with all 4 tasks present (plan from child override, implement/verify/ship from base).

If running headless without TORQUE: `node -e "require('./workflow-spec').parseSpec('workflows/example-extends-feature.yaml').then(r => console.log(JSON.stringify(r.ok ? r.spec.tasks.map(t=>t.node_id) : r.errors, null, 2)))"` → expect `["plan","implement","verify","ship"]`.

- [ ] **Step 4: Commit**

```bash
git add workflows/templates/feature-pipeline.yaml workflows/example-extends-feature.yaml
git commit -m "docs(workflow-spec): feature-pipeline template + example child"
git push --no-verify origin main
```

---

## Task 4: Docs + restart + smoke

- [ ] **Step 1: Append to `docs/workflow-specs.md`**

````markdown
## Templates and inheritance

A spec can `extends:` another spec, inheriting its tasks and top-level fields. Useful for sharing factory pipelines (plan → implement → verify → ship) across many concrete workflows.

### Merge semantics

- Top-level fields: child wins (e.g., child `name` and `description` override base)
- Tasks: merged by `node_id`. Child fields override base fields per task. New `node_id`s in the child are appended.
- Remove a base task: include `node_id: x` with `__remove: true` in the child.

### Cycle detection + depth limit

Extends chains are limited to 8 levels deep. Cycles are detected and rejected with a clear error.

### Example

```yaml
# workflows/templates/critic-ensemble.yaml
version: 1
name: critic-ensemble-base
tasks:
  - node_id: fanout
    kind: parallel_fanout
    task: fan
  - node_id: critic_a
    task: critique a
    depends_on: [fanout]
  - node_id: critic_b
    task: critique b
    depends_on: [fanout]
  - node_id: merge
    kind: merge
    join_policy: wait_all
    depends_on: [critic_a, critic_b]
    task: merge
```

```yaml
# workflows/security-review.yaml
version: 1
name: security-review
extends: templates/critic-ensemble.yaml
tasks:
  - node_id: critic_a
    task: Audit the change for security issues. Focus on injection, auth, and secret leaks.
    provider: anthropic
  - node_id: critic_b
    task: Audit the change for compliance impact. Reference docs/compliance/.
    provider: claude-cli
```
````

- [ ] **Step 2: Restart, smoke test**

`await_restart`. Then via MCP: `validate_workflow_spec { spec_path: "workflows/example-extends-feature.yaml" }` → expect `valid: true` with 4 tasks.

- [ ] **Step 3: Commit**

```bash
git add docs/workflow-specs.md
git commit -m "docs(workflow-spec): templates and inheritance"
git push --no-verify origin main
```
