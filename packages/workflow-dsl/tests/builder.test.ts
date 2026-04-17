import { describe, expect, it } from 'vitest';

import { createStep, createWorkflow } from '../src';

describe('createWorkflow().toSpec()', () => {
  it('linear workflow: .step().then().then()', () => {
    const spec = createWorkflow({ name: 'linear' })
      .step(createStep({ id: 'a', task_description: 'plan' }))
      .then(createStep({ id: 'b', task_description: 'build' }))
      .then(createStep({ id: 'c', task_description: 'verify' }))
      .toSpec();

    expect(spec.name).toBe('linear');
    expect(spec.tasks).toHaveLength(3);
    expect(spec.tasks.find((task) => task.id === 'b')!.depends_on).toEqual(['a']);
    expect(spec.tasks.find((task) => task.id === 'c')!.depends_on).toEqual(['b']);
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

    expect(spec.tasks.find((task) => task.id === 'x')!.depends_on).toEqual(['a']);
    expect(spec.tasks.find((task) => task.id === 'y')!.depends_on).toEqual(['a']);
    expect(spec.tasks.find((task) => task.id === 'z')!.depends_on!.sort()).toEqual(['x', 'y']);
  });

  it('conditional branch: .branch({...})', () => {
    const spec = createWorkflow({ name: 'b' })
      .step(createStep({ id: 'gate' }))
      .branch({
        approved: createStep({ id: 'deploy' }),
        rejected: createStep({ id: 'notify' }),
      })
      .toSpec();

    const deploy = spec.tasks.find((task) => task.id === 'deploy')!;
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
        .toSpec(),
    ).toThrow(/duplicate/i);
  });
});
