'use strict';

const { extractFromSource } = require('../extractors/csharp');

describe('csharp extractor', () => {
  it('extracts class and interface declarations with proper kinds', async () => {
    const { symbols } = await extractFromSource(
      'public class Dog {}\npublic interface IAnimal {}\npublic struct Point {}\npublic enum Color {}\n',
    );
    const map = Object.fromEntries(symbols.map((s) => [s.name, s.kind]));
    expect(map.Dog).toBe('class');
    expect(map.IAnimal).toBe('interface');
    expect(map.Point).toBe('struct');
    expect(map.Color).toBe('enum');
  });

  it('extracts methods, constructors, properties', async () => {
    const src = [
      'public class Dog {',
      '  public Dog() {}',
      '  public string Name { get; set; }',
      '  public void Bark() {}',
      '}',
      '',
    ].join('\n');
    const { symbols } = await extractFromSource(src);
    const map = symbols.reduce((acc, s) => { acc[`${s.kind}:${s.name}`] = s; return acc; }, {});
    expect(map['constructor:Dog']).toBeTruthy();
    expect(map['property:Name']).toBeTruthy();
    expect(map['method:Bark']).toBeTruthy();
  });

  it('flags static modifier', async () => {
    const { symbols } = await extractFromSource(
      'public class Foo { public static void M() {} public void N() {} }\n',
    );
    const m = symbols.find((s) => s.name === 'M');
    const n = symbols.find((s) => s.name === 'N');
    expect(m.isStatic).toBe(true);
    expect(n.isStatic).toBe(false);
  });

  it('flags async modifier', async () => {
    const { symbols } = await extractFromSource(
      'public class Foo { public async Task M() {} }\n',
    );
    const m = symbols.find((s) => s.name === 'M');
    expect(m.isAsync).toBe(true);
  });

  it('private members are not exported; public are', async () => {
    const { symbols } = await extractFromSource(
      'public class Foo { public void Pub() {} private void Priv() {} }\n',
    );
    const map = Object.fromEntries(symbols.map((s) => [s.name, s.isExported]));
    expect(map.Pub).toBe(true);
    expect(map.Priv).toBe(false);
  });

  it('captures base class as extends', async () => {
    const { classEdges } = await extractFromSource(
      'public class Animal {}\npublic class Dog : Animal {}\n',
    );
    expect(classEdges).toEqual([
      expect.objectContaining({ subtypeName: 'Dog', supertypeName: 'Animal', edgeKind: 'extends' }),
    ]);
  });

  it('disambiguates implements when supertype is an in-file interface', async () => {
    const src = [
      'public interface IAnimal {}',
      'public abstract class Animal {}',
      'public class Dog : Animal, IAnimal {}',
      '',
    ].join('\n');
    const { classEdges } = await extractFromSource(src);
    const map = classEdges.reduce((acc, e) => { acc[e.supertypeName] = e.edgeKind; return acc; }, {});
    expect(map.Animal).toBe('extends');
    expect(map.IAnimal).toBe('implements');
  });

  it('falls back to extends for unknown supertypes (cross-file)', async () => {
    const { classEdges } = await extractFromSource(
      'public class Dog : Animal, ISomeUnknownThing {}\n',
    );
    const kinds = classEdges.map((e) => e.edgeKind);
    expect(kinds.every((k) => k === 'extends')).toBe(true);
  });

  it('unwraps qualified base type names', async () => {
    const { classEdges } = await extractFromSource(
      'public class Dog : Some.Namespace.Animal {}\n',
    );
    expect(classEdges).toEqual([
      expect.objectContaining({ subtypeName: 'Dog', supertypeName: 'Animal' }),
    ]);
  });

  it('captures invocation_expression as references', async () => {
    const { references } = await extractFromSource(
      'public class Foo { public void M() { Bar(); } }\n',
    );
    expect(references.map((r) => r.targetName)).toContain('Bar');
  });

  it('selector calls resolve to the rightmost name', async () => {
    const { references } = await extractFromSource(
      'public class Foo { public void M() { Console.WriteLine("x"); } }\n',
    );
    expect(references.map((r) => r.targetName)).toContain('WriteLine');
  });

  it('attaches callerSymbolIndex to references inside methods', async () => {
    const { symbols, references } = await extractFromSource(
      'public class Foo { public void M() { Bar(); } }\n',
    );
    const mIdx = symbols.findIndex((s) => s.name === 'M');
    const ref = references.find((r) => r.targetName === 'Bar');
    expect(ref.callerSymbolIndex).toBe(mIdx);
  });

  it('record declarations surface as kind=record', async () => {
    const { symbols } = await extractFromSource('public record Cat(string Name);\n');
    const cat = symbols.find((s) => s.name === 'Cat');
    expect(cat).toBeTruthy();
    expect(cat.kind).toBe('record');
  });
});
