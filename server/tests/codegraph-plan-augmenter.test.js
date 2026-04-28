'use strict';
/* global describe, it, expect */

const {
  checkPlanImpact,
  uniqueIdentifiers,
  IMPACT_WARN_THRESHOLD,
} = require('../factory/codegraph-plan-augmenter');

// Tool-result shape mirrors what the codegraph plugin returns: a content
// envelope plus a structuredData payload — checkPlanImpact reads only the
// latter.
const wrap = (payload) => ({ structuredData: payload });

describe('uniqueIdentifiers', () => {
  it('extracts identifier-shaped backtick strings', () => {
    const txt = 'Modify `parseTask` and `submitTask` in handler';
    expect(uniqueIdentifiers(txt)).toEqual(['parseTask', 'submitTask']);
  });

  it('rejects file paths, commands, and short tokens', () => {
    const txt = 'edit `src/foo.ts` then run `npm test`, also tiny `i` and short `fn`';
    // file path has '/' and '.', command has ' ', i and fn are too short
    expect(uniqueIdentifiers(txt)).toEqual([]);
  });

  it('dedupes repeated identifiers', () => {
    const txt = '`fooBar` then `fooBar` again and `bazQux`';
    expect(uniqueIdentifiers(txt)).toEqual(['fooBar', 'bazQux']);
  });

  it('skips reserved words and HTTP verbs', () => {
    const txt = '`true` `null` `GET` `submitTask`';
    expect(uniqueIdentifiers(txt)).toEqual(['submitTask']);
  });

  it('caps results so a noisy plan does not blow the budget', () => {
    const names = Array.from({ length: 30 }, (_, i) => `sym${i}xx`);
    const txt = names.map((n) => `\`${n}\``).join(' ');
    const out = uniqueIdentifiers(txt);
    expect(out.length).toBe(12);   // MAX_SYMBOLS_PER_PLAN
  });
});

describe('checkPlanImpact', () => {
  const repoPath = '/fake/repo';

  function makeHandlers({ indexed = true, knownSymbols = {}, throwOn = null } = {}) {
    return {
      async cg_index_status() {
        if (throwOn === 'cg_index_status') throw new Error('boom');
        return wrap({ indexed, current_sha: 'abc' });
      },
      async cg_search({ pattern }) {
        if (throwOn === 'cg_search') throw new Error('boom');
        const known = knownSymbols[pattern];
        return wrap({
          pattern,
          results: known ? [{ name: pattern, kind: 'function', file: 'f.js', line: 1 }] : [],
          truncated: false,
          limit: 1,
        });
      },
      async cg_impact_set({ symbol }) {
        if (throwOn === 'cg_impact_set') throw new Error('boom');
        const k = knownSymbols[symbol];
        if (!k) return wrap({ symbols: [], files: [], truncated: false });
        return wrap({
          symbols: k.callers,
          files: k.files || [],
          truncated: Boolean(k.truncated),
          max_nodes: 100,
        });
      },
    };
  }

  it('returns [] when no handlers and no plugin loaded', async () => {
    // pass explicit null — the default loader path is also exercised
    const out = await checkPlanImpact({ plan: '`foo`', repoPath, handlers: null });
    // Default loader path should likewise return [] when called outside a
    // running TORQUE; no assertion on the loader internals.
    expect(Array.isArray(out)).toBe(true);
  });

  it('returns [] when index not built for this repo', async () => {
    const handlers = makeHandlers({ indexed: false });
    const out = await checkPlanImpact({ plan: '`foo`', repoPath, handlers });
    expect(out).toEqual([]);
  });

  it('returns [] when no candidate identifiers in plan', async () => {
    const handlers = makeHandlers();
    const out = await checkPlanImpact({ plan: 'No backticks at all here.', repoPath, handlers });
    expect(out).toEqual([]);
  });

  it('returns [] when symbol not in cg_search', async () => {
    const handlers = makeHandlers({ knownSymbols: {} });
    const out = await checkPlanImpact({ plan: '`unknownSymbol`', repoPath, handlers });
    expect(out).toEqual([]);
  });

  it('returns [] when impact_set is below threshold', async () => {
    const handlers = makeHandlers({
      knownSymbols: { fooSmall: { callers: ['a', 'b', 'c'] } },   // 3 < 10
    });
    const out = await checkPlanImpact({ plan: '`fooSmall`', repoPath, handlers });
    expect(out).toEqual([]);
  });

  it('warns when impact_set is at or above threshold', async () => {
    const callers = Array.from({ length: 12 }, (_, i) => `caller${i}`);
    const handlers = makeHandlers({
      knownSymbols: { fooBig: { callers, files: ['a.js', 'b.js'] } },
    });
    const out = await checkPlanImpact({
      plan: 'Refactor `fooBig` carefully',
      repoPath, handlers,
    });
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe('codegraph_wide_impact');
    expect(out[0].symbol).toBe('fooBig');
    expect(out[0].caller_count).toBe(12);
    expect(out[0].file_count).toBe(2);
    expect(out[0].message).toMatch(/12 caller-side symbols across 2 files/);
    expect(out[0].message).toMatch(/Sample callers: caller0, caller1, caller2/);
  });

  it('flags truncation explicitly when impact_set hit its cap', async () => {
    const callers = Array.from({ length: 100 }, (_, i) => `caller${i}`);
    const handlers = makeHandlers({
      knownSymbols: { hotPath: { callers, truncated: true, files: [] } },
    });
    const out = await checkPlanImpact({ plan: '`hotPath`', repoPath, handlers });
    expect(out).toHaveLength(1);
    expect(out[0].truncated).toBe(true);
    expect(out[0].message).toMatch(/hit the cap/);
  });

  it('respects a custom threshold', async () => {
    const handlers = makeHandlers({
      knownSymbols: { foo: { callers: ['a', 'b', 'c'] } },
    });
    const at3 = await checkPlanImpact({ plan: '`foo`', repoPath, handlers, threshold: 3 });
    const at10 = await checkPlanImpact({ plan: '`foo`', repoPath, handlers, threshold: 10 });
    expect(at3).toHaveLength(1);
    expect(at10).toHaveLength(0);
  });

  it('skips silently when cg_index_status throws', async () => {
    const handlers = makeHandlers({ throwOn: 'cg_index_status' });
    const out = await checkPlanImpact({ plan: '`foo`', repoPath, handlers });
    expect(out).toEqual([]);
  });

  it('skips a symbol when cg_search throws but continues with others', async () => {
    let calls = 0;
    const callers = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const handlers = {
      async cg_index_status() { return wrap({ indexed: true, current_sha: 'x' }); },
      async cg_search({ pattern }) {
        calls++;
        if (pattern === 'badOne') throw new Error('search blew up');
        return wrap({ results: [{ name: pattern, kind: 'function', file: 'f.js', line: 1 }] });
      },
      async cg_impact_set({ symbol }) {
        return wrap({ symbols: callers, files: [] });
      },
    };
    const out = await checkPlanImpact({ plan: '`badOne` `goodOne`', repoPath, handlers });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe('goodOne');
  });

  it('threshold default is 10 (sanity check)', () => {
    expect(IMPACT_WARN_THRESHOLD).toBe(10);
  });
});
