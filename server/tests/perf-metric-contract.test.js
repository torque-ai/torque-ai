'use strict';

describe('perf metric registry contract', () => {
  beforeEach(() => {
    delete require.cache[require.resolve('../perf/metrics')];
  });

  it('rejects metric without id', () => {
    const r = require('../perf/metrics');
    expect(() => r.register({ run: () => 0 })).toThrow(/metric\.id required/);
  });

  it('rejects metric without run()', () => {
    const r = require('../perf/metrics');
    expect(() => r.register({ id: 'foo' })).toThrow(/metric\.run/);
  });

  it('rejects duplicate id', () => {
    const r = require('../perf/metrics');
    r.register({ id: 'foo', run: () => 0 });
    expect(() => r.register({ id: 'foo', run: () => 0 })).toThrow(/duplicate metric id/);
  });

  it('list() returns registered metrics in insertion order', () => {
    const r = require('../perf/metrics');
    r.register({ id: 'a', name: 'A', category: 'cat', run: () => 0 });
    r.register({ id: 'b', name: 'B', category: 'cat', run: () => 0 });
    expect(r.list().map((m) => m.id)).toEqual(['a', 'b']);
  });
});
