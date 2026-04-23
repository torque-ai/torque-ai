'use strict';

const { createAction } = require('../actions/action');

describe('createAction', () => {
  it('requires reads, writes, run', () => {
    expect(() => createAction({ name: 'x' })).toThrow(/run/);
    expect(() => createAction({ name: 'x', run: async () => {} })).toThrow(/reads/);
  });

  it('enforces that run only reads declared keys (strict mode)', async () => {
    const a = createAction({
      name: 'greet',
      reads: ['name'],
      writes: ['greeting'],
      run: async (state) => ({ result: null, patch: { greeting: `hi ${state.name}` } }),
    });
    const { result, patch } = await a.invoke({ name: 'alice' });
    expect(result).toBeNull();
    expect(patch.greeting).toBe('hi alice');
  });

  it('rejects patch containing undeclared writes', async () => {
    const a = createAction({
      name: 'bad',
      reads: [],
      writes: ['a'],
      run: async () => ({ result: null, patch: { a: 1, b: 2 } }),
    });
    await expect(a.invoke({})).rejects.toThrow(/undeclared write.*b/);
  });

  it('action metadata exposed for introspection', () => {
    const a = createAction({
      name: 'sum',
      reads: ['x', 'y'],
      writes: ['z'],
      run: async () => ({ result: 0, patch: { z: 0 } }),
    });
    expect(a.name).toBe('sum');
    expect(a.reads).toEqual(['x', 'y']);
    expect(a.writes).toEqual(['z']);
  });
});
