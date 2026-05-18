import { describe, it, expect } from 'vitest';

import {
  PLAN_RELATED_STOP_WORDS,
  PLAN_RELATED_GENERIC_PATH_TOKENS,
  normalizePlannerAffinityToken,
  tokenizePlannerPathForAffinity,
  buildPlannerTitleAffinityTokens,
  tokenizePlannerSearchText,
  buildPlannerFileSearchTokens,
} from '../factory/shared/planner-tokens.js';

// ---------------------------------------------------------------------------
// normalizePlannerAffinityToken
// ---------------------------------------------------------------------------
describe('normalizePlannerAffinityToken', () => {
  it('lowercases and trims a normal token', () => {
    expect(normalizePlannerAffinityToken('  Hello  ')).toBe('hello');
  });

  it('depluralize -ies to -y for tokens longer than 4 chars', () => {
    // "entries" → length 7 > 4, ends with "ies" → "entry"
    expect(normalizePlannerAffinityToken('Entries')).toBe('entry');
    expect(normalizePlannerAffinityToken('FACTORIES')).toBe('factory');
  });

  it('does not depluralize -ies when length is 4 or less', () => {
    // "dies" → length 4, not > 4, returned as-is lowercase
    expect(normalizePlannerAffinityToken('dies')).toBe('dies');
    expect(normalizePlannerAffinityToken('TIES')).toBe('ties');
  });

  it('depluralize trailing -s for tokens longer than 4 chars', () => {
    // "items" → length 5 > 4, ends with "s" → "item"
    expect(normalizePlannerAffinityToken('Items')).toBe('item');
    expect(normalizePlannerAffinityToken('PARSERS')).toBe('parser');
  });

  it('does not depluralize trailing -s when length is 4 or less', () => {
    // "dogs" → length 4, not > 4, returned as-is
    expect(normalizePlannerAffinityToken('dogs')).toBe('dogs');
  });

  it('-ies rule takes priority over -s rule', () => {
    // "queries" → length 7 > 4, ends with "ies" → "query" (not "querie")
    expect(normalizePlannerAffinityToken('queries')).toBe('query');
  });

  it('returns empty string for null, undefined, and empty input', () => {
    expect(normalizePlannerAffinityToken(null)).toBe('');
    expect(normalizePlannerAffinityToken(undefined)).toBe('');
    expect(normalizePlannerAffinityToken('')).toBe('');
  });

  it('coerces non-string values via String()', () => {
    expect(normalizePlannerAffinityToken(12345)).toBe('12345');
    expect(normalizePlannerAffinityToken(0)).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// tokenizePlannerPathForAffinity
// ---------------------------------------------------------------------------
describe('tokenizePlannerPathForAffinity', () => {
  it('splits a file path into meaningful tokens, filtering generic path tokens', () => {
    // "server" is in PLAN_RELATED_GENERIC_PATH_TOKENS, "factory" is a stop word
    // (also in generic path tokens), "shared" has length 6 and is NOT in
    // generic path tokens → kept. "planner" has length 7, not in set → kept.
    // "tokens" → normalized to "token" (length 5, ends with s) → not in set → kept.
    const result = tokenizePlannerPathForAffinity('server/factory/shared/planner-tokens.js');
    expect(result).toContain('shared');
    expect(result).toContain('planner');
    expect(result).toContain('token');
    expect(result).not.toContain('server');
    expect(result).not.toContain('factory');
    // "js" has length 2 → filtered by length >= 4
    expect(result).not.toContain('js');
  });

  it('converts backslashes to forward slashes before splitting', () => {
    const result = tokenizePlannerPathForAffinity('server\\utils\\helper-funcs.js');
    expect(result).toContain('util');   // "utils" → "util" (depluralized)
    expect(result).toContain('helper');
    expect(result).toContain('func');   // "funcs" → "func" (depluralized)
  });

  it('splits camelCase segments into separate tokens', () => {
    // "camelCaseFile" → "camel Case File" → split → ["camel", "case", "file"]
    // "camel" (5 chars, not in set → kept), "case" (4 chars, not in set → kept),
    // "file" (4 chars, not in set → kept)
    const result = tokenizePlannerPathForAffinity('src/camelCaseFile.js');
    expect(result).toContain('camel');
    expect(result).toContain('case');
    expect(result).toContain('file');
    // "src" is in generic path tokens → filtered
    expect(result).not.toContain('src');
  });

  it('returns empty array for a path composed entirely of generic segments', () => {
    // "src/lib/index.js" → all tokens are in PLAN_RELATED_GENERIC_PATH_TOKENS or too short
    const result = tokenizePlannerPathForAffinity('src/lib/index.js');
    expect(result).toEqual([]);
  });

  it('returns empty array for null/undefined/empty input', () => {
    expect(tokenizePlannerPathForAffinity(null)).toEqual([]);
    expect(tokenizePlannerPathForAffinity(undefined)).toEqual([]);
    expect(tokenizePlannerPathForAffinity('')).toEqual([]);
  });

  it('filters tokens shorter than 4 characters', () => {
    // "a/bb/ccc/dddd" → "dddd" is the only one with length >= 4
    const result = tokenizePlannerPathForAffinity('a/bb/ccc/dddd');
    expect(result).toEqual(['dddd']);
  });
});

// ---------------------------------------------------------------------------
// buildPlannerTitleAffinityTokens
// ---------------------------------------------------------------------------
describe('buildPlannerTitleAffinityTokens', () => {
  it('splits a workItem title into affinity tokens filtering stop/generic words', () => {
    const workItem = { title: 'Refactor authentication handler' };
    // "refactor" (8 chars, not in generic → kept)
    // "authentication" (14 chars, not in generic → kept)
    // "handler" (7 chars, not in generic → kept)
    const result = buildPlannerTitleAffinityTokens(workItem);
    expect(result).toContain('refactor');
    expect(result).toContain('authentication');
    expect(result).toContain('handler');
  });

  it('filters tokens present in PLAN_RELATED_GENERIC_PATH_TOKENS', () => {
    // "update" is in stop words → in generic path tokens → filtered
    // "server" is in generic path tokens → filtered
    const workItem = { title: 'Update server configuration' };
    const result = buildPlannerTitleAffinityTokens(workItem);
    expect(result).not.toContain('update');
    expect(result).not.toContain('server');
    expect(result).toContain('configuration');
  });

  it('returns empty array for an empty or stop-word-only title', () => {
    const workItem = { title: 'update build tests' };
    // "update" (stop word), "build" (stop word), "tests" (stop word) → all filtered
    const result = buildPlannerTitleAffinityTokens(workItem);
    expect(result).toEqual([]);
  });

  it('returns empty array when workItem is null/undefined or has no title', () => {
    expect(buildPlannerTitleAffinityTokens(null)).toEqual([]);
    expect(buildPlannerTitleAffinityTokens(undefined)).toEqual([]);
    expect(buildPlannerTitleAffinityTokens({})).toEqual([]);
    expect(buildPlannerTitleAffinityTokens({ title: '' })).toEqual([]);
  });

  it('splits camelCase within titles', () => {
    const workItem = { title: 'fixBrokenParser' };
    // "fix" → 3 chars → filtered by length
    // "broken" → 6 chars, not in generic → kept
    // "parser" → in PLAN_RELATED_GENERIC_PATH_TOKENS → filtered
    const result = buildPlannerTitleAffinityTokens(workItem);
    expect(result).toContain('broken');
    expect(result).not.toContain('parser');
    expect(result).not.toContain('fix');
  });

  it('applies depluralization via normalizePlannerAffinityToken', () => {
    const workItem = { title: 'Remove obsolete strategies' };
    // "remove" → 6 chars, not in generic → kept
    // "obsolete" → 8 chars, not in generic → kept
    // "strategies" → "strategy" (depluralized -ies) → not in generic → kept
    const result = buildPlannerTitleAffinityTokens(workItem);
    expect(result).toContain('remove');
    expect(result).toContain('obsolete');
    expect(result).toContain('strategy');
  });
});

// ---------------------------------------------------------------------------
// tokenizePlannerSearchText
// ---------------------------------------------------------------------------
describe('tokenizePlannerSearchText', () => {
  it('lowercases and splits text into tokens filtered by stop words', () => {
    const result = tokenizePlannerSearchText('Refactor the authentication module');
    // "refactor" (8, not stop → kept), "the" (3 chars → filtered by length),
    // "authentication" (14, not stop → kept), "module" (stop word → filtered)
    expect(result).toContain('refactor');
    expect(result).toContain('authentication');
    expect(result).not.toContain('module');
    expect(result).not.toContain('the');
  });

  it('filters tokens shorter than 4 characters', () => {
    const result = tokenizePlannerSearchText('add a new API handler');
    // "add" (3), "a" (1), "new" (3), "handler" is not a stop word but "handle" is
    // Wait - "handler" → split produces "handler" (not in stop words) → kept
    // "api" → 3 chars → filtered
    expect(result).not.toContain('add');
    expect(result).not.toContain('new');
    expect(result).not.toContain('api');
    expect(result).toContain('handler');
  });

  it('filters tokens in PLAN_RELATED_STOP_WORDS', () => {
    // "update" (stop), "existing" (stop), "factory" (stop), "logic" (stop)
    const result = tokenizePlannerSearchText('update existing factory logic');
    expect(result).toEqual([]);
  });

  it('splits on non-alphanumeric characters', () => {
    const result = tokenizePlannerSearchText('hello-world_test.thing');
    // "hello" (5, not stop → kept), "world" (5, not stop → kept),
    // "test" (4 chars but... checking stop words: "tests" is stop, "test" is NOT in stop words
    // Actually check: PLAN_RELATED_STOP_WORDS has "tests" not "test"
    // But PLAN_RELATED_GENERIC_PATH_TOKENS has "test" - however this function only
    // filters against PLAN_RELATED_STOP_WORDS, not generic path tokens
    // So "test" → 4 chars, not in stop words → kept
    // "thing" → 5 chars, not in stop words → kept
    expect(result).toContain('hello');
    expect(result).toContain('world');
    expect(result).toContain('test');
    expect(result).toContain('thing');
  });

  it('returns empty array for null/undefined/empty input', () => {
    expect(tokenizePlannerSearchText(null)).toEqual([]);
    expect(tokenizePlannerSearchText(undefined)).toEqual([]);
    expect(tokenizePlannerSearchText('')).toEqual([]);
  });

  it('does NOT apply depluralization (unlike affinity token functions)', () => {
    // tokenizePlannerSearchText uses plain .trim(), not normalizePlannerAffinityToken
    const result = tokenizePlannerSearchText('strategies entries');
    // "strategies" stays as "strategies" (not depluralized), 10 chars, not a stop word → kept
    // "entries" stays as "entries" (not depluralized), 7 chars, not a stop word → kept
    expect(result).toContain('strategies');
    expect(result).toContain('entries');
  });
});

// ---------------------------------------------------------------------------
// buildPlannerFileSearchTokens
// ---------------------------------------------------------------------------
describe('buildPlannerFileSearchTokens', () => {
  it('combines tokens from title and description into a unique set', () => {
    const workItem = {
      title: 'Refactor authentication',
      description: 'Improve authentication security layer',
    };
    const result = buildPlannerFileSearchTokens(workItem);
    // From title: "refactor", "authentication"
    // From description: "improve", "authentication", "security", "layer"
    // "authentication" appears in both → deduplicated
    expect(result).toContain('refactor');
    expect(result).toContain('authentication');
    expect(result).toContain('improve');
    expect(result).toContain('security');
    expect(result).toContain('layer');
    // Count unique - authentication should appear only once
    expect(result.filter((t) => t === 'authentication')).toHaveLength(1);
  });

  it('includes tokens from seed files', () => {
    const workItem = { title: 'Fix handler' };
    const seedFiles = ['server/routing/middleware.js'];
    const result = buildPlannerFileSearchTokens(workItem, seedFiles);
    // From title: "handler" (4+ chars, not stop → kept)
    // From seed: "routing" (7 chars, not stop → kept),
    //            "middleware" (10 chars, not stop → kept)
    // "server" → stop word → filtered
    expect(result).toContain('handler');
    expect(result).toContain('routing');
    expect(result).toContain('middleware');
  });

  it('returns tokens from description only when title is empty', () => {
    const workItem = { title: '', description: 'Optimize database queries' };
    const result = buildPlannerFileSearchTokens(workItem);
    // "optimize" (8, not stop), "database" (8, not stop), "queries" (7, not stop)
    expect(result).toContain('optimize');
    expect(result).toContain('database');
    expect(result).toContain('queries');
  });

  it('returns tokens from title only when description is null', () => {
    const workItem = { title: 'Refactor validation', description: null };
    const result = buildPlannerFileSearchTokens(workItem);
    // "refactor" (8, not stop → kept), "validation" (10, not stop → kept)
    expect(result).toContain('refactor');
    expect(result).toContain('validation');
  });

  it('returns empty array when workItem has no meaningful text and no seed files', () => {
    const workItem = { title: '', description: '' };
    const result = buildPlannerFileSearchTokens(workItem);
    expect(result).toEqual([]);
  });

  it('returns empty array for null workItem with no seed files', () => {
    const result = buildPlannerFileSearchTokens(null);
    expect(result).toEqual([]);
  });

  it('handles null/undefined seedFiles gracefully', () => {
    const workItem = { title: 'Refactor validation' };
    const result = buildPlannerFileSearchTokens(workItem, null);
    expect(result).toContain('refactor');
    expect(result).toContain('validation');
  });
});

// ---------------------------------------------------------------------------
// PLAN_RELATED_STOP_WORDS (exported Set)
// ---------------------------------------------------------------------------
describe('PLAN_RELATED_STOP_WORDS', () => {
  it('is a Set instance', () => {
    expect(PLAN_RELATED_STOP_WORDS).toBeInstanceOf(Set);
  });

  it('is non-empty', () => {
    expect(PLAN_RELATED_STOP_WORDS.size).toBeGreaterThan(0);
  });

  it('contains expected stop words', () => {
    for (const word of ['factory', 'build', 'tests', 'module', 'logic', 'update', 'work']) {
      expect(PLAN_RELATED_STOP_WORDS.has(word)).toBe(true);
    }
  });

  it('does not contain non-stop words', () => {
    for (const word of ['authentication', 'refactor', 'database', 'middleware']) {
      expect(PLAN_RELATED_STOP_WORDS.has(word)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// PLAN_RELATED_GENERIC_PATH_TOKENS (exported Set)
// ---------------------------------------------------------------------------
describe('PLAN_RELATED_GENERIC_PATH_TOKENS', () => {
  it('is a Set instance', () => {
    expect(PLAN_RELATED_GENERIC_PATH_TOKENS).toBeInstanceOf(Set);
  });

  it('is non-empty', () => {
    expect(PLAN_RELATED_GENERIC_PATH_TOKENS.size).toBeGreaterThan(0);
  });

  it('contains expected generic path tokens', () => {
    for (const token of ['src', 'lib', 'index', 'server', 'app', 'test', 'type', 'types']) {
      expect(PLAN_RELATED_GENERIC_PATH_TOKENS.has(token)).toBe(true);
    }
  });

  it('is a superset of PLAN_RELATED_STOP_WORDS', () => {
    for (const word of PLAN_RELATED_STOP_WORDS) {
      expect(PLAN_RELATED_GENERIC_PATH_TOKENS.has(word)).toBe(true);
    }
  });

  it('contains path-specific tokens not in stop words', () => {
    // These are in generic path tokens but NOT in stop words
    for (const token of ['__tests__', 'component', 'schema', 'jsx', 'tsx']) {
      expect(PLAN_RELATED_GENERIC_PATH_TOKENS.has(token)).toBe(true);
      expect(PLAN_RELATED_STOP_WORDS.has(token)).toBe(false);
    }
  });
});
