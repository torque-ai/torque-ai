'use strict';

const r = require('../perf/metrics');

describe('perf metric registry contract', () => {
  beforeEach(() => {
    r._reset();
  });

  it('rejects metric without id', () => {
    expect(() => r.register({ run: () => 0 })).toThrow(/metric\.id required/);
  });

  it('rejects metric without run()', () => {
    expect(() => r.register({ id: 'foo' })).toThrow(/metric\.run/);
  });

  it('rejects duplicate id', () => {
    r.register({ id: 'foo', run: () => 0 });
    expect(() => r.register({ id: 'foo', run: () => 0 })).toThrow(/duplicate metric id/);
  });

  it('list() returns registered metrics in insertion order', () => {
    r.register({ id: 'a', name: 'A', category: 'cat', run: () => 0 });
    r.register({ id: 'b', name: 'B', category: 'cat', run: () => 0 });
    expect(r.list().map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('list() returns a copy — caller mutation does not affect registry', () => {
    r.register({ id: 'a', run: () => 0 });
    const snapshot = r.list();
    // Array-level: pushing into snapshot must not grow the registry
    snapshot.push({ id: 'rogue', run: () => 0 });
    expect(r.list().length).toBe(1);
    // Object-level: entries are frozen; mutation in strict mode throws
    expect(() => { snapshot[0].id = 'mutated'; }).toThrow(TypeError);
    expect(r.list()[0].id).toBe('a');
  });
});
