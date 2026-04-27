'use strict';

// tree-sitter-c-sharp ships as ESM with top-level await on its current
// release, which Node's require() refuses with ERR_REQUIRE_ASYNC_MODULE.
// parser.js wraps that require in try/catch so the rest of the codegraph
// plugin loads, but this extractor needs the real grammar — skip when
// it isn't available rather than crashing the suite. Re-enable when
// tree-sitter-c-sharp ships a CJS-compatible binding (or when parser.js
// migrates to dynamic import()).
let extractFromSource = null;
try { ({ extractFromSource } = require('../extractors/csharp')); } catch (_e) { /* grammar unavailable */ }
const csharpAvailable = extractFromSource != null;
const describeMaybe = csharpAvailable ? describe : describe.skip;

describeMaybe('csharp extractor — type bindings + method-call resolution', () => {
  it('records container_name on members', async () => {
    const r = await extractFromSource('public class Dog { public void Bark() {} }\n');
    const bark = r.symbols.find((s) => s.name === 'Bark');
    expect(bark.containerName).toBe('Dog');
  });

  it('captures method parameter types', async () => {
    const r = await extractFromSource(
      'public class Foo { public void M(Animal d, int x) {} }\n',
    );
    const map = Object.fromEntries(r.locals.map((l) => [l.localName, l.typeName]));
    expect(map.d).toBe('Animal');
    expect(map.x).toBe('int');
  });

  it('captures explicit-type local declarations', async () => {
    const r = await extractFromSource(
      'public class Foo { public void M() { Animal a = null; Dog b = null; } }\n',
    );
    const map = Object.fromEntries(r.locals.map((l) => [l.localName, l.typeName]));
    expect(map.a).toBe('Animal');
    expect(map.b).toBe('Dog');
  });

  it('infers var locals from object_creation_expression', async () => {
    const r = await extractFromSource(
      'public class Foo { public void M() { var a = new Animal(); } }\n',
    );
    const a = r.locals.find((l) => l.localName === 'a');
    expect(a.typeName).toBe('Animal');
  });

  it('records receiverName on member-call references', async () => {
    const r = await extractFromSource(
      'public class Foo { public void M(Animal d) { d.Speak(); } }\n',
    );
    const ref = r.references.find((x) => x.targetName === 'Speak');
    expect(ref.receiverName).toBe('d');
  });

  it('this.Foo() captures `this` as receiver', async () => {
    const r = await extractFromSource(
      'public class Foo { public void M() { this.Other(); } public void Other() {} }\n',
    );
    const ref = r.references.find((x) => x.targetName === 'Other');
    expect(ref.receiverName).toBe('this');
  });

  it('strips qualified type prefixes (System.IO.Foo → Foo)', async () => {
    const r = await extractFromSource(
      'public class C { public void M(System.IO.Stream s) {} }\n',
    );
    const s = r.locals.find((l) => l.localName === 's');
    expect(s.typeName).toBe('Stream');
  });

  it('strips generics (List<Foo> → List)', async () => {
    const r = await extractFromSource(
      'public class C { public void M(List<Foo> xs) {} }\n',
    );
    const xs = r.locals.find((l) => l.localName === 'xs');
    expect(xs.typeName).toBe('List');
  });

  it('handles nullable types (Foo? → Foo)', async () => {
    const r = await extractFromSource(
      'public class C { public void M(Animal? d) {} }\n',
    );
    const d = r.locals.find((l) => l.localName === 'd');
    expect(d.typeName).toBe('Animal');
  });
});
