# Fabro #82: Fluent Workflow DSL (Mastra)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a **TypeScript-first chainable** workflow authoring layer alongside Plan 1's YAML: `createWorkflow({ name }).step(a).then(b).branch({ condA, condB }).parallel([x, y]).commit()`. Compiles to the same workflow spec YAML/JSON ingests. Inspired by Mastra.

**Architecture:** A new `@torque/workflow-dsl` module exports `createWorkflow`, `createStep`, `when()`, `parallel()`. Methods return a builder whose `.toSpec()` emits the canonical workflow JSON that Plan 1's submit handler consumes. Plan 64 validator runs on the emitted spec so TS authoring gets the same build-time guarantees as YAML.

**Tech Stack:** TypeScript, existing workflow submit API. Builds on plans 1 (workflow-as-code), 23 (typed signatures), 60 (graphs-as-library), 64 (build-time validation).

---

## File Structure

**New files:**
- `packages/workflow-dsl/package.json`
- `packages/workflow-dsl/src/index.ts`
- `packages/workflow-dsl/src/builder.ts`
- `packages/workflow-dsl/src/step.ts`
- `packages/workflow-dsl/src/compile.ts`
- `packages/workflow-dsl/tests/builder.test.ts`
- `packages/workflow-dsl/tests/compile.test.ts`

---

## Task 1: Step + Builder

- [x] **Step 1: Tests**

Create `packages/workflow-dsl/tests/builder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createWorkflow, createStep } from '../src';

describe('createWorkflow().toSpec()', () => {
  it('linear workflow: .step().then().then()', () => {
    const spec = createWorkflow({ name: 'linear' })
      .step(createStep({ id: 'a', task_description: 'plan' }))
      .then(createStep({ id: 'b', task_description: 'build' }))
      .then(createStep({ id: 'c', task_description: 'verify' }))
      .toSpec();
    expect(spec.name).toBe('linear');
    expect(spec.tasks).toHaveLength(3);
    expect(spec.tasks.find(t => t.id === 'b')!.depends_on).toEqual(['a']);
    expect(spec.tasks.find(t => t.id === 'c')!.depends_on).toEqual(['b']);
  });

  it('parallel branch: .parallel([x, y])', () => {
    const spec = createWorkflow({ name: 'p' })
      .step(createStep({ id: 'a' }))
      .parallel([
        createStep({ id: 'x' }),
        createStep({ id: 'y' }),
      ])
      .then(createStep({ id: 'z' }))
      .toSpec();
    // x and y both depend on a
    expect(spec.tasks.find(t => t.id === 'x')!.depends_on).toEqual(['a']);
    expect(spec.tasks.find(t => t.id === 'y')!.depends_on).toEqual(['a']);
    // z depends on both x and y (merge)
    expect(spec.tasks.find(t => t.id === 'z')!.depends_on!.sort()).toEqual(['x', 'y']);
  });

  it('conditional branch: .branch({...})', () => {
    const spec = createWorkflow({ name: 'b' })
      .step(createStep({ id: 'gate' }))
      .branch({
        approved: createStep({ id: 'deploy' }),
        rejected: createStep({ id: 'notify' }),
      })
      .toSpec();
    const deploy = spec.tasks.find(t => t.id === 'deploy')!;
    expect(deploy.when).toBe('approved');
    expect(deploy.depends_on).toEqual(['gate']);
  });

  it('supports produces/consumes on steps', () => {
    const spec = createWorkflow({ name: 'a' })
      .step(createStep({ id: 'build', produces: ['code:app.js'] }))
      .then(createStep({ id: 'test', consumes: ['code:app.js'] }))
      .toSpec();
    expect(spec.tasks[0].produces).toEqual(['code:app.js']);
    expect(spec.tasks[1].consumes).toEqual(['code:app.js']);
  });

  it('throws when committing duplicate step ids', () => {
    expect(() =>
      createWorkflow({ name: 'dup' })
        .step(createStep({ id: 'x' }))
        .then(createStep({ id: 'x' }))
        .toSpec()
    ).toThrow(/duplicate/i);
  });
});
```

- [x] **Step 2: Implement**

Create `packages/workflow-dsl/src/step.ts`:

```ts
export interface StepDef {
  id: string;
  task_description?: string;
  provider?: string;
  kind?: string;
  produces?: string[];
  consumes?: string[];
  depends_on?: string[];
  when?: string;
}

export function createStep(def: StepDef): StepDef {
  if (!def.id) throw new Error('step requires id');
  return { ...def };
}
```

Create `packages/workflow-dsl/src/builder.ts`:

```ts
import type { StepDef } from './step';

interface BuilderState {
  name: string;
  description?: string;
  tasks: StepDef[];
  frontier: string[]; // current tail nodes
}

export function createWorkflow({ name, description }: { name: string; description?: string }) {
  const state: BuilderState = { name, description, tasks: [], frontier: [] };

  function addStep(step: StepDef, overrideDepsOn?: string[]) {
    if (state.tasks.find(t => t.id === step.id)) {
      throw new Error(`duplicate step id: ${step.id}`);
    }
    const newStep = { ...step };
    const deps = overrideDepsOn !== undefined ? overrideDepsOn : [...state.frontier];
    if (deps.length > 0) {
      newStep.depends_on = [...(newStep.depends_on || []), ...deps];
    }
    state.tasks.push(newStep);
    return newStep;
  }

  const api = {
    step(s: StepDef) {
      const added = addStep(s);
      state.frontier = [added.id];
      return api;
    },
    then(s: StepDef) { return api.step(s); },
    parallel(steps: StepDef[]) {
      const parentFrontier = state.frontier;
      const ids: string[] = [];
      for (const s of steps) {
        addStep(s, parentFrontier);
        ids.push(s.id);
      }
      state.frontier = ids; // merge: next .then() depends on all parallel steps
      return api;
    },
    branch(branches: Record<string, StepDef>) {
      const parentFrontier = state.frontier;
      const ids: string[] = [];
      for (const [cond, s] of Object.entries(branches)) {
        const added = addStep({ ...s, when: cond }, parentFrontier);
        ids.push(added.id);
      }
      state.frontier = ids;
      return api;
    },
    toSpec() {
      return { name: state.name, description: state.description, tasks: state.tasks };
    },
  };
  return api;
}
```

Create `packages/workflow-dsl/src/index.ts`:

```ts
export { createStep } from './step';
export type { StepDef } from './step';
export { createWorkflow } from './builder';
```

Run tests → PASS. Commit: `feat(workflow-dsl): fluent builder with step/then/parallel/branch`.

---

## Task 2: Compile + submit helper

- [ ] **Step 1: Compile + submit**

Create `packages/workflow-dsl/src/compile.ts`:

```ts
import type { StepDef } from './step';

// Optional helper that posts a built workflow to a TORQUE endpoint.
export async function submitToTorque(spec: any, { torqueBaseUrl, fetcher = fetch }: { torqueBaseUrl: string; fetcher?: typeof fetch }) {
  const res = await fetcher(`${torqueBaseUrl.replace(/\/+$/, '')}/api/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  });
  if (!res.ok) throw new Error(`submit failed: HTTP ${res.status}`);
  return res.json();
}
```

Tests (`packages/workflow-dsl/tests/compile.test.ts`) use `vi.fn()` as a fake fetch + verify posted body equals `spec`.

- [ ] **Step 2: Docs + example**

`packages/workflow-dsl/README.md` — installation + example:

```ts
import { createWorkflow, createStep, submitToTorque } from '@torque/workflow-dsl';

const spec = createWorkflow({ name: 'ci-and-deploy' })
  .step(createStep({ id: 'plan',   task_description: 'Plan deployment', kind: 'agent' }))
  .then(createStep({ id: 'build',  task_description: 'Build artifact',  produces: ['bundle:release'] }))
  .parallel([
    createStep({ id: 'unit',       task_description: 'Run unit tests' }),
    createStep({ id: 'lint',       task_description: 'Run linter' }),
  ])
  .branch({
    all_passed: createStep({ id: 'deploy', task_description: 'Deploy' }),
    any_failed: createStep({ id: 'notify', task_description: 'Notify team' }),
  })
  .toSpec();

await submitToTorque(spec, { torqueBaseUrl: 'http://localhost:3457' });
```

Commit: `feat(workflow-dsl): compile + submit helper + README`.
