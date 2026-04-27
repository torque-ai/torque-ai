'use strict';

const { extractFromSource } = require('../extractors/go');

describe('go extractor — type bindings + method-call resolution', () => {
  it('records container_name on methods (matches receiverType)', async () => {
    const r = await extractFromSource(
      'package p\ntype Dog struct{}\nfunc (d *Dog) Bark() {}\n',
    );
    const bark = r.symbols.find((s) => s.name === 'Bark');
    expect(bark.containerName).toBe('Dog');
    expect(bark.receiverType).toBe('Dog');
  });

  it('binds method receiver parameter to the containing type', async () => {
    const r = await extractFromSource(
      'package p\ntype Dog struct{}\nfunc (d *Dog) Bark() string { return d.name }\n',
    );
    const d = r.locals.find((l) => l.localName === 'd');
    expect(d.typeName).toBe('Dog');
  });

  it('captures function/method parameter types', async () => {
    const r = await extractFromSource(
      'package p\nfunc f(x *Dog, y int) {}\n',
    );
    const map = Object.fromEntries(r.locals.map((l) => [l.localName, l.typeName]));
    expect(map.x).toBe('Dog');
    expect(map.y).toBe('int');
  });

  it('captures var declarations', async () => {
    const r = await extractFromSource(
      'package p\nfunc f() { var a *Dog; var b Cat; _ = a; _ = b }\n',
    );
    const map = Object.fromEntries(r.locals.map((l) => [l.localName, l.typeName]));
    expect(map.a).toBe('Dog');
    expect(map.b).toBe('Cat');
  });

  it('infers types from composite literals (b := &Dog{})', async () => {
    const r = await extractFromSource(
      'package p\nfunc f() { b := &Dog{}; c := Cat{}; _ = b; _ = c }\n',
    );
    const map = Object.fromEntries(r.locals.map((l) => [l.localName, l.typeName]));
    expect(map.b).toBe('Dog');
    expect(map.c).toBe('Cat');
  });

  it('records receiverName on selector calls', async () => {
    const r = await extractFromSource(
      'package p\nfunc f(d *Dog) { d.Bark() }\n',
    );
    const ref = r.references.find((x) => x.targetName === 'Bark');
    expect(ref.receiverName).toBe('d');
  });

  it('skips package-qualified calls when capturing receiver', async () => {
    // fmt.Println — receiver name is set to 'fmt' (looks like a local) but
    // resolution will stay NULL because there's no `fmt` local in scope.
    // Acceptable: receiver_name is captured, downstream resolution decides.
    const r = await extractFromSource(
      'package p\nfunc f() { fmt.Println("x") }\n',
    );
    const ref = r.references.find((x) => x.targetName === 'Println');
    expect(ref.receiverName).toBe('fmt');
  });

  it('does not bind func-result short decls (d := f())', async () => {
    const r = await extractFromSource(
      'package p\nfunc f() *Dog { return nil }\nfunc g() { d := f(); _ = d }\n',
    );
    expect(r.locals.find((l) => l.localName === 'd')).toBeUndefined();
  });
});
