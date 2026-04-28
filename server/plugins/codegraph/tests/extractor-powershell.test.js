'use strict';

// tree-sitter-powershell isn't always available on the test runner — npm
// install on Windows currently can't fetch a prebuilt for it on Node 24.
// parser.js's async loader throws when the grammar can't be required, which
// would otherwise surface as 11 file-load failures here. Probe the loader
// in beforeAll and skip per-test if the grammar is absent. Same pattern as
// extractor-python-types and extractor-csharp-types.
const { extractFromSource } = require('../extractors/powershell');

describe('powershell extractor', () => {
  let grammarReady = false;
  beforeAll(async () => {
    try {
      await extractFromSource('function _probe { 1 }\n');
      grammarReady = true;
    } catch (_e) {
      grammarReady = false;
    }
  });
  beforeEach((ctx) => {
    if (!grammarReady) ctx.skip();
  });
  it('extracts function statements', async () => {
    const r = await extractFromSource('function Get-Hello { return "hi" }\n');
    const fn = r.symbols.find((s) => s.name === 'Get-Hello');
    expect(fn).toBeTruthy();
    expect(fn.kind).toBe('function');
  });

  it('extracts class statements', async () => {
    const r = await extractFromSource('class Animal { [string] Speak() { return "noise" } }\n');
    const cls = r.symbols.find((s) => s.name === 'Animal');
    expect(cls.kind).toBe('class');
    const sp = r.symbols.find((s) => s.name === 'Speak');
    expect(sp.kind).toBe('method');
    expect(sp.containerName).toBe('Animal');
  });

  it('class extends → extends edge', async () => {
    const r = await extractFromSource('class Dog : Animal {}\n');
    expect(r.classEdges).toEqual([
      expect.objectContaining({ subtypeName: 'Dog', supertypeName: 'Animal', edgeKind: 'extends' }),
    ]);
  });

  it('extracts class properties with container_name', async () => {
    const r = await extractFromSource('class Animal { [string] $Name }\n');
    const prop = r.symbols.find((s) => s.name === 'Name');
    expect(prop.kind).toBe('property');
    expect(prop.containerName).toBe('Animal');
  });

  it('binds $this to the containing class inside methods', async () => {
    const r = await extractFromSource('class Animal { [void] M() { } }\n');
    const thisLocal = r.locals.find((l) => l.localName === 'this');
    expect(thisLocal.typeName).toBe('Animal');
  });

  it('captures class-method typed parameters', async () => {
    const r = await extractFromSource('class Dog { [void] Bark([Animal] $d) {} }\n');
    const d = r.locals.find((l) => l.localName === 'd');
    expect(d.typeName).toBe('Animal');
  });

  it('captures function inline-typed parameters', async () => {
    const r = await extractFromSource('function Caller([Other] $o) { return $null }\n');
    const o = r.locals.find((l) => l.localName === 'o');
    expect(o.typeName).toBe('Other');
  });

  it('captures function param_block parameters', async () => {
    const r = await extractFromSource(
      'function F {\n  param([string] $name, [int] $count)\n  return\n}\n',
    );
    const map = Object.fromEntries(r.locals.map((l) => [l.localName, l.typeName]));
    expect(map.name).toBe('string');
    expect(map.count).toBe('int');
  });

  it('records receiverName on $obj.Method() invokation', async () => {
    const r = await extractFromSource(
      'class Foo { [void] M() { $bar.Speak() } }\n',
    );
    const ref = r.references.find((x) => x.targetName === 'Speak');
    expect(ref.receiverName).toBe('bar');
  });

  it('records cmdlet/function calls with no receiver', async () => {
    const r = await extractFromSource('function F { Get-Hello }\n');
    const ref = r.references.find((x) => x.targetName === 'Get-Hello');
    expect(ref).toBeTruthy();
    expect(ref.receiverName).toBe(null);
  });

  it('strips dotted namespace from type literals (System.IO.Stream → Stream)', async () => {
    const r = await extractFromSource(
      'class Foo { [System.IO.Stream] $S }\n',
    );
    // The property symbol's container is what we'd resolve calls against;
    // for type-binding of the property itself, the schema currently doesn't
    // surface property types. This test documents that we capture the
    // *property symbol* correctly even with a dotted type literal.
    const prop = r.symbols.find((s) => s.name === 'S');
    expect(prop).toBeTruthy();
    expect(prop.containerName).toBe('Foo');
  });

  it('top-level functions and classes are exported', async () => {
    const r = await extractFromSource('function Foo {}\nclass Bar {}\n');
    const foo = r.symbols.find((s) => s.name === 'Foo');
    const bar = r.symbols.find((s) => s.name === 'Bar');
    expect(foo.isExported).toBe(true);
    expect(bar.isExported).toBe(true);
  });
});
