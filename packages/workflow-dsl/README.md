# `@torque/workflow-dsl`

TypeScript-first fluent workflow authoring for TORQUE.

## Install

```bash
npm install @torque/workflow-dsl
```

## Example

```ts
import { createWorkflow, createStep, submitToTorque } from '@torque/workflow-dsl';

const spec = createWorkflow({ name: 'ci-and-deploy' })
  .step(createStep({ id: 'plan', task_description: 'Plan deployment', kind: 'agent' }))
  .then(createStep({ id: 'build', task_description: 'Build artifact', produces: ['bundle:release'] }))
  .parallel([
    createStep({ id: 'unit', task_description: 'Run unit tests' }),
    createStep({ id: 'lint', task_description: 'Run linter' }),
  ])
  .branch({
    all_passed: createStep({ id: 'deploy', task_description: 'Deploy' }),
    any_failed: createStep({ id: 'notify', task_description: 'Notify team' }),
  })
  .toSpec();

await submitToTorque(spec, { torqueBaseUrl: 'http://localhost:3457' });
```

`toSpec()` compiles the fluent builder output into the canonical workflow JSON shape, and `submitToTorque()` posts that JSON to `${torqueBaseUrl}/api/workflows`.
