'use strict';

const { getParser, supportedLanguages } = require('../parser');

describe('codegraph parser pool', () => {
  it('lists supported languages including javascript and typescript', () => {
    const langs = supportedLanguages();
    expect(langs).toEqual(expect.arrayContaining(['javascript', 'typescript', 'tsx']));
  });

  it('returns the same parser instance on repeated calls (caching)', async () => {
    const a = await getParser('javascript');
    const b = await getParser('javascript');
    expect(a).toBe(b);
  });

  it('parses a JS snippet into a tree with a non-null root', async () => {
    const parser = await getParser('javascript');
    const tree = parser.parse('function foo() { return 42; }');
    expect(tree.rootNode).not.toBeNull();
    expect(tree.rootNode.type).toBe('program');
  });

  it('rejects unknown languages with a clear error', async () => {
    await expect(getParser('cobol')).rejects.toThrow(/unsupported language/i);
  });
});
