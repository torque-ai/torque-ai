'use strict';

const { extractFromSource } = require('../extractors/go');

describe('go extractor', () => {
  it('extracts top-level functions', async () => {
    const { symbols } = await extractFromSource(
      'package p\nfunc Foo() {}\nfunc bar() {}\n',
    );
    const names = symbols.map((s) => s.name).sort();
    expect(names).toEqual(['Foo', 'bar']);
  });

  it('flags capitalized names as exported (Go convention)', async () => {
    const { symbols } = await extractFromSource(
      'package p\nfunc Public() {}\nfunc internal() {}\n',
    );
    const map = Object.fromEntries(symbols.map((s) => [s.name, s]));
    expect(map.Public.isExported).toBe(true);
    expect(map.internal.isExported).toBe(false);
  });

  it('extracts method declarations and resolves receiver type', async () => {
    const { symbols } = await extractFromSource(
      'package p\ntype Dog struct{}\nfunc (d *Dog) Bark() {}\nfunc (d Dog) Sleep() {}\n',
    );
    const methods = symbols.filter((s) => s.kind === 'method');
    expect(methods).toHaveLength(2);
    const recvTypes = methods.map((m) => m.receiverType).sort();
    expect(recvTypes).toEqual(['Dog', 'Dog']);
  });

  it('captures struct + interface declarations with proper kinds', async () => {
    const { symbols } = await extractFromSource(
      'package p\ntype Dog struct{ name string }\ntype Animal interface{ Speak() }\n',
    );
    const map = Object.fromEntries(symbols.map((s) => [s.name, s]));
    expect(map.Dog.kind).toBe('struct');
    expect(map.Animal.kind).toBe('interface');
  });

  it('captures interface embedding as extends edges', async () => {
    const { classEdges } = await extractFromSource(
      'package p\ntype A interface{ A1() }\ntype B interface { A; B1() }\n',
    );
    expect(classEdges).toEqual([
      expect.objectContaining({ subtypeName: 'B', supertypeName: 'A', edgeKind: 'extends' }),
    ]);
  });

  it('captures struct embedding (anonymous fields) as extends edges', async () => {
    const { classEdges } = await extractFromSource(
      'package p\ntype Animal struct{}\ntype Dog struct { Animal; name string }\n',
    );
    expect(classEdges).toEqual([
      expect.objectContaining({ subtypeName: 'Dog', supertypeName: 'Animal', edgeKind: 'extends' }),
    ]);
  });

  it('does not treat named fields as extends', async () => {
    const { classEdges } = await extractFromSource(
      'package p\ntype Dog struct { name string; age int }\n',
    );
    expect(classEdges).toEqual([]);
  });

  it('captures call expressions as references', async () => {
    const { references } = await extractFromSource(
      'package p\nfunc Foo() { bar() }\n',
    );
    expect(references.map((r) => r.targetName)).toContain('bar');
  });

  it('selector calls resolve to the rightmost field_identifier', async () => {
    const { references } = await extractFromSource(
      'package p\nfunc Foo() { fmt.Println("x") }\n',
    );
    expect(references.map((r) => r.targetName)).toContain('Println');
  });

  it('attaches callerSymbolIndex to references inside methods', async () => {
    const { symbols, references } = await extractFromSource(
      'package p\ntype Dog struct{}\nfunc (d *Dog) Bark() { greet() }\n',
    );
    const barkIdx = symbols.findIndex((s) => s.name === 'Bark');
    const ref = references.find((r) => r.targetName === 'greet');
    expect(ref.callerSymbolIndex).toBe(barkIdx);
  });

  it('handles pointer receiver type unwrapping', async () => {
    const { symbols } = await extractFromSource(
      'package p\ntype T struct{}\nfunc (t *T) M() {}\n',
    );
    const m = symbols.find((s) => s.name === 'M');
    expect(m.receiverType).toBe('T');
  });

  it('emits empty dispatchEdges (Go has no JS-style dispatcher pattern in this MVP)', async () => {
    const { dispatchEdges } = await extractFromSource('package p\nfunc Foo() {}\n');
    expect(dispatchEdges).toEqual([]);
  });

  it('handles multiple type_specs in one declaration block', async () => {
    const src = [
      'package p',
      'type (',
      '  Dog struct{}',
      '  Cat struct{}',
      ')',
      '',
    ].join('\n');
    const { symbols } = await extractFromSource(src);
    const types = symbols.filter((s) => s.kind === 'struct').map((s) => s.name).sort();
    expect(types).toEqual(['Cat', 'Dog']);
  });
});
