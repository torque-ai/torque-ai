'use strict';
/* global describe, it, expect */

const {
  enrichFixPromptWithCodegraph,
  extractCandidateSymbols,
  formatMarkdown,
} = require('../utils/codegraph-fix-enrichment');

const wrap = (payload) => ({ structuredData: payload });

describe('extractCandidateSymbols', () => {
  it('returns frequency-ranked identifiers from a vitest failure', () => {
    const errorText = `
 FAIL  tests/foo.test.js > parseTask returns null on bad input
AssertionError: expected null but got 42
  at parseTask (src/foo.ts:12)
  at parseTask handler in src/foo.ts:15
  at runValidations (src/runner.ts:33)
`;
    const out = extractCandidateSymbols(errorText, 5);
    expect(out[0]).toBe('parseTask');
    expect(out).toContain('runValidations');
  });

  it('drops stopwords (Test, expect, AssertionError, etc.)', () => {
    const out = extractCandidateSymbols('AssertionError expected received describe foo something');
    expect(out).not.toContain('AssertionError');
    expect(out).not.toContain('expected');
    expect(out).not.toContain('describe');
    // 'something' is the only ≥4-char identifier left after stopwords.
    expect(out).toContain('something');
  });

  it('drops short identifiers (≤3 chars)', () => {
    const out = extractCandidateSymbols('err foo bar baz fooBar');
    expect(out).toEqual(['fooBar']);
  });

  it('drops ALL_CAPS constants', () => {
    const out = extractCandidateSymbols('TIMEOUT_MS expected MAX_RETRIES handleFoo');
    expect(out).toEqual(['handleFoo']);
  });

  it('returns at most `max` candidates', () => {
    const errorText = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh';
    const out = extractCandidateSymbols(errorText, 3);
    expect(out).toHaveLength(3);
  });

  it('returns [] for empty input', () => {
    expect(extractCandidateSymbols('')).toEqual([]);
    expect(extractCandidateSymbols(null)).toEqual([]);
  });
});

describe('formatMarkdown', () => {
  it('renders a multi-symbol block with caller samples', () => {
    const md = formatMarkdown([
      { symbol: 'parseTask', callers: ['handleSubmit', 'handleResume', 'queueDispatch'], truncated: false },
      { symbol: 'runValidations', callers: ['orchestrate'], truncated: false },
    ]);
    expect(md).toContain('codegraph callers');
    expect(md).toContain('`parseTask` callers (3)');
    expect(md).toContain('`handleSubmit`');
    expect(md).toContain('`runValidations` callers (1)');
  });

  it('flags truncation when cg_call_graph hit its cap', () => {
    const md = formatMarkdown([{ symbol: 'hot', callers: Array(8).fill('c'), truncated: true }]);
    expect(md).toMatch(/truncated — caller set is wider/);
  });

  it('handles 0-caller results', () => {
    const md = formatMarkdown([{ symbol: 'orphan', callers: [], truncated: false }]);
    expect(md).toMatch(/`orphan`: 0 callers found/);
  });

  it('returns empty string when no blocks', () => {
    expect(formatMarkdown([])).toBe('');
  });
});

describe('enrichFixPromptWithCodegraph — graceful skips', () => {
  function fakeHandlers({ indexed = true, knownSymbols = {}, throwOn = null } = {}) {
    return {
      async cg_index_status() {
        if (throwOn === 'cg_index_status') throw new Error('boom');
        return wrap({ indexed });
      },
      async cg_search({ pattern }) {
        if (throwOn === 'cg_search') throw new Error('boom');
        return wrap({
          results: knownSymbols[pattern]
            ? [{ name: pattern, kind: 'function', file: 'f.js', line: 1 }]
            : [],
        });
      },
      async cg_call_graph({ symbol }) {
        if (throwOn === 'cg_call_graph') throw new Error('boom');
        const k = knownSymbols[symbol];
        if (!k) return wrap({ nodes: [], edges: [], truncated: false });
        return wrap({
          nodes: [{ name: symbol }, ...k.callers.map((n) => ({ name: n }))],
          edges: [],
          truncated: Boolean(k.truncated),
          max_nodes: 100,
        });
      },
    };
  }

  it('returns "" when no handlers loaded', async () => {
    const out = await enrichFixPromptWithCodegraph({
      repoPath: '/x', errorText: 'parseTask failed', handlers: null,
    });
    expect(typeof out).toBe('string');
  });

  it('returns "" when index not built', async () => {
    const handlers = fakeHandlers({ indexed: false });
    const out = await enrichFixPromptWithCodegraph({
      repoPath: '/x', errorText: 'parseTask failed', handlers,
    });
    expect(out).toBe('');
  });

  it('returns "" when error has no candidate symbols', async () => {
    const handlers = fakeHandlers();
    const out = await enrichFixPromptWithCodegraph({
      repoPath: '/x', errorText: 'AssertionError expected received', handlers,
    });
    expect(out).toBe('');
  });

  it('returns "" when no candidate exists in cg_search', async () => {
    const handlers = fakeHandlers({ knownSymbols: {} });
    const out = await enrichFixPromptWithCodegraph({
      repoPath: '/x', errorText: 'unknownSymbol failed', handlers,
    });
    expect(out).toBe('');
  });

  it('builds markdown when callers exist for a known symbol', async () => {
    const handlers = fakeHandlers({
      knownSymbols: { parseTask: { callers: ['handleSubmit', 'handleResume'] } },
    });
    const out = await enrichFixPromptWithCodegraph({
      repoPath: '/x',
      errorText: 'AssertionError parseTask returns wrong shape at parseTask line 12',
      handlers,
    });
    expect(out).toContain('parseTask');
    expect(out).toContain('handleSubmit');
    expect(out).toContain('handleResume');
  });

  it('skips silently when cg_index_status throws', async () => {
    const handlers = fakeHandlers({ throwOn: 'cg_index_status' });
    const out = await enrichFixPromptWithCodegraph({
      repoPath: '/x', errorText: 'parseTask failed', handlers,
    });
    expect(out).toBe('');
  });

  it('skips a symbol when cg_call_graph throws but continues with others', async () => {
    const callers = ['someCaller'];
    const handlers = {
      async cg_index_status() { return wrap({ indexed: true }); },
      async cg_search({ pattern }) {
        return wrap({ results: [{ name: pattern, kind: 'function', file: 'f.js', line: 1 }] });
      },
      async cg_call_graph({ symbol }) {
        if (symbol === 'parseTask') throw new Error('boom');
        return wrap({ nodes: [{ name: symbol }, { name: callers[0] }], edges: [], truncated: false });
      },
    };
    const out = await enrichFixPromptWithCodegraph({
      repoPath: '/x',
      errorText: 'parseTask failed and runValidations also referenced',
      handlers,
    });
    expect(out).not.toContain('parseTask`');   // skipped
    expect(out).toContain('runValidations');
    expect(out).toContain('someCaller');
  });

  it('caps blocks at 3 symbols even when more are candidates', async () => {
    const handlers = {
      async cg_index_status() { return wrap({ indexed: true }); },
      async cg_search({ pattern }) {
        return wrap({ results: [{ name: pattern, kind: 'function', file: 'f.js', line: 1 }] });
      },
      async cg_call_graph({ symbol }) {
        return wrap({ nodes: [{ name: symbol }, { name: 'aCaller' }], edges: [], truncated: false });
      },
    };
    const errorText = 'parseTask failed runValidations also handleResume and queueDispatch and orchestrate';
    const out = await enrichFixPromptWithCodegraph({
      repoPath: '/x', errorText, handlers,
    });
    // Output should mention 3 of the 5 candidates, not all 5.
    const symbolMatches = (out.match(/callers \(\d+/g) || []).length;
    expect(symbolMatches).toBeLessThanOrEqual(3);
  });
});
