'use strict';

const { extractFromSource } = require('../extractors/python');

describe('python extractor — type bindings + method-call resolution', () => {
  it('records container_name on methods', async () => {
    const r = await extractFromSource('class Animal:\n    def speak(self): pass\n');
    const speak = r.symbols.find((s) => s.name === 'speak');
    expect(speak.containerName).toBe('Animal');
  });

  it('binds self to the enclosing class', async () => {
    const r = await extractFromSource('class Animal:\n    def speak(self): pass\n');
    const self = r.locals.find((l) => l.localName === 'self');
    expect(self.typeName).toBe('Animal');
  });

  it('captures typed parameters as cg_locals', async () => {
    const r = await extractFromSource('def f(d: Animal, c: int = 1): pass\n');
    const map = Object.fromEntries(r.locals.map((l) => [l.localName, l.typeName]));
    expect(map.d).toBe('Animal');
    expect(map.c).toBe('int');
  });

  it('captures annotated assignment as cg_locals', async () => {
    const r = await extractFromSource('def f():\n    x: Animal = make()\n');
    const x = r.locals.find((l) => l.localName === 'x');
    expect(x.typeName).toBe('Animal');
  });

  it('infers constructor: y = ClassName() binds y to ClassName', async () => {
    const r = await extractFromSource('def f():\n    y = Animal()\n');
    const y = r.locals.find((l) => l.localName === 'y');
    expect(y.typeName).toBe('Animal');
  });

  it('skips constructor inference for snake_case calls', async () => {
    const r = await extractFromSource('def f():\n    y = make_thing()\n');
    expect(r.locals.find((l) => l.localName === 'y')).toBeUndefined();
  });

  it('records receiverName on member-call references', async () => {
    const r = await extractFromSource('def f(d):\n    d.speak()\n');
    const ref = r.references.find((x) => x.targetName === 'speak');
    expect(ref.receiverName).toBe('d');
  });

  it('strips generics on type subscripts (List[Foo] → List)', async () => {
    const r = await extractFromSource('def f(xs: List[Foo]): pass\n');
    const xs = r.locals.find((l) => l.localName === 'xs');
    expect(xs.typeName).toBe('List');
  });

  it('skips forward-ref string annotations (treated as untyped for v1)', async () => {
    const r = await extractFromSource('def f(d: "Animal"): pass\n');
    expect(r.locals.find((l) => l.localName === 'd')).toBeUndefined();
  });

  it('attribute type annotations resolve to rightmost name (pkg.Foo → Foo)', async () => {
    const r = await extractFromSource('def f(d: pkg.Animal): pass\n');
    const d = r.locals.find((l) => l.localName === 'd');
    expect(d.typeName).toBe('Animal');
  });
});
