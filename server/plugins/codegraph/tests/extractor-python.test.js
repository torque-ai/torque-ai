'use strict';

const { extractFromSource } = require('../extractors/python');

describe('python extractor', () => {
  it('extracts top-level functions', async () => {
    const { symbols } = await extractFromSource('def foo(): pass\ndef bar(): pass\n');
    const names = symbols.map((s) => s.name).sort();
    expect(names).toEqual(['bar', 'foo']);
    expect(symbols.every((s) => s.kind === 'function')).toBe(true);
  });

  it('flags top-level public names as exported (Python convention)', async () => {
    const { symbols } = await extractFromSource('def public(): pass\ndef _private(): pass\n');
    const map = Object.fromEntries(symbols.map((s) => [s.name, s]));
    expect(map.public.isExported).toBe(true);
    expect(map._private.isExported).toBe(false);
  });

  it('captures async def with isAsync=true', async () => {
    const { symbols } = await extractFromSource(
      'async def fetch(): pass\ndef sync_fn(): pass\n',
    );
    const map = Object.fromEntries(symbols.map((s) => [s.name, s]));
    expect(map.fetch.isAsync).toBe(true);
    expect(map.sync_fn.isAsync).toBe(false);
  });

  it('classes and methods are surfaced with the right kinds', async () => {
    const { symbols } = await extractFromSource(
      'class Animal:\n    def speak(self): pass\n',
    );
    const kinds = symbols.map((s) => `${s.kind}:${s.name}`).sort();
    expect(kinds).toEqual(['class:Animal', 'method:speak']);
  });

  it('promotes __init__ to constructor kind', async () => {
    const { symbols } = await extractFromSource(
      'class Foo:\n    def __init__(self): pass\n',
    );
    const init = symbols.find((s) => s.name === '__init__');
    expect(init.kind).toBe('constructor');
  });

  it('captures @staticmethod / @property / .setter as static/getter/setter', async () => {
    const src = [
      'class Foo:',
      '    @staticmethod',
      '    def kind(): return 1',
      '    @property',
      '    def name(self): return self._n',
      '    @name.setter',
      '    def name(self, v): self._n = v',
      '',
    ].join('\n');
    const { symbols } = await extractFromSource(src);
    const map = symbols.reduce((acc, s) => { acc[s.name] = (acc[s.name] || []).concat(s); return acc; }, {});
    expect(map.kind[0].kind).toBe('method');
    expect(map.kind[0].isStatic).toBe(true);
    // 'name' has both getter and setter symbols.
    const kinds = map.name.map((s) => s.kind).sort();
    expect(kinds).toEqual(['getter', 'setter']);
  });

  it('decorated functions are not duplicated', async () => {
    const src = '@staticmethod\ndef foo(): pass\n';
    const { symbols } = await extractFromSource(src);
    const foos = symbols.filter((s) => s.name === 'foo');
    expect(foos).toHaveLength(1);
  });

  it('captures call expressions as references', async () => {
    const { references } = await extractFromSource(
      'def alpha():\n    return beta()\n',
    );
    const targets = references.map((r) => r.targetName);
    expect(targets).toContain('beta');
  });

  it('attaches callerSymbolIndex to references inside a function', async () => {
    const { symbols, references } = await extractFromSource(
      'def alpha():\n    bar()\n',
    );
    const alphaIdx = symbols.findIndex((s) => s.name === 'alpha');
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    const ref = references.find((r) => r.targetName === 'bar');
    expect(ref.callerSymbolIndex).toBe(alphaIdx);
  });

  it('attribute calls resolve to the rightmost name', async () => {
    const { references } = await extractFromSource(
      'def alpha():\n    obj.method.foo()\n',
    );
    const targets = references.map((r) => r.targetName);
    expect(targets).toContain('foo');
  });

  it('captures class extends edges', async () => {
    const { classEdges } = await extractFromSource('class Dog(Animal): pass\n');
    expect(classEdges).toEqual([
      expect.objectContaining({ subtypeName: 'Dog', supertypeName: 'Animal', edgeKind: 'extends' }),
    ]);
  });

  it('handles multiple base classes', async () => {
    const { classEdges } = await extractFromSource('class C(A, B): pass\n');
    const supers = classEdges.map((e) => e.supertypeName).sort();
    expect(supers).toEqual(['A', 'B']);
  });

  it('skips keyword arguments in class bases (metaclass=)', async () => {
    const { classEdges } = await extractFromSource('class Mixin(metaclass=ABCMeta): pass\n');
    expect(classEdges).toEqual([]);
  });

  it('handles attribute supertypes (pkg.Animal)', async () => {
    const { classEdges } = await extractFromSource('class Dog(pkg.Animal): pass\n');
    expect(classEdges).toEqual([
      expect.objectContaining({ subtypeName: 'Dog', supertypeName: 'Animal' }),
    ]);
  });

  it('emits empty dispatchEdges (Python has no switch)', async () => {
    const { dispatchEdges } = await extractFromSource('def foo(): pass\n');
    expect(dispatchEdges).toEqual([]);
  });
});
