'use strict';

const { extractFromSource } = require('../extractors/javascript');

describe('javascript extractor', () => {
  it('extracts named function declarations', async () => {
    const src = `function foo() {}\nfunction bar() {}\n`;
    const { symbols } = await extractFromSource(src, 'javascript');
    const names = symbols.map((s) => s.name).sort();
    expect(names).toEqual(['bar', 'foo']);
    expect(symbols.every((s) => s.kind === 'function')).toBe(true);
  });

  it('extracts call expressions as references', async () => {
    const src = `function foo() { return bar(1, 2); }\n`;
    const { references } = await extractFromSource(src, 'javascript');
    const targets = references.map((r) => r.targetName);
    expect(targets).toContain('bar');
  });

  it('attaches caller_symbol_index to references inside a function', async () => {
    const src = `function foo() { bar(); }\n`;
    const { symbols, references } = await extractFromSource(src, 'javascript');
    const fooIdx = symbols.findIndex((s) => s.name === 'foo');
    expect(fooIdx).toBeGreaterThanOrEqual(0);
    const ref = references.find((r) => r.targetName === 'bar');
    expect(ref.callerSymbolIndex).toBe(fooIdx);
  });

  it('extracts class declarations and methods', async () => {
    const src = `class Foo { bar() {} baz() {} }\n`;
    const { symbols } = await extractFromSource(src, 'javascript');
    const kinds = symbols.map((s) => `${s.kind}:${s.name}`).sort();
    expect(kinds).toEqual(['class:Foo', 'method:bar', 'method:baz']);
  });

  it('skips references with no target (anonymous calls)', async () => {
    const src = `function foo() { (() => 1)(); }\n`;
    const { references } = await extractFromSource(src, 'javascript');
    expect(references.find((r) => r.targetName === '')).toBeUndefined();
  });
});
