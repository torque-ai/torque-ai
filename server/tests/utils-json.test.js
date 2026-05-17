'use strict';

const { safeJsonParse, safeJsonStringify } = require('../utils/json');
const { normalizeMetadata } = require('../utils/normalize-metadata');

// Focused unit tests for server/utils/json.js — the safe JSON helper used
// in 70+ files across the server (DB JSON columns, metadata, API
// serialization, workflow state, etc.). It had no direct unit tests
// despite being the canonical "parse this JSON without throwing" path.
// Pin the contract so a future "improve" doesn't break a downstream
// consumer that depends on a specific edge case.

describe('safeJsonParse', () => {
  describe('valid input', () => {
    it('parses a JSON object', () => {
      expect(safeJsonParse('{"a": 1, "b": "two"}')).toEqual({ a: 1, b: 'two' });
    });

    it('parses a JSON array', () => {
      expect(safeJsonParse('[1, 2, 3]')).toEqual([1, 2, 3]);
    });

    it('parses an object with nested values', () => {
      const input = '{"outer": {"inner": [true, null, 0]}}';
      expect(safeJsonParse(input)).toEqual({ outer: { inner: [true, null, 0] } });
    });

    it('trims surrounding whitespace before parsing', () => {
      expect(safeJsonParse('  {"a": 1}  ')).toEqual({ a: 1 });
      expect(safeJsonParse('\n\t[1]\n')).toEqual([1]);
    });
  });

  describe('null/undefined/empty input', () => {
    it('returns the default for null', () => {
      expect(safeJsonParse(null)).toBeNull();
      expect(safeJsonParse(null, 'fallback')).toBe('fallback');
    });

    it('returns the default for undefined', () => {
      expect(safeJsonParse(undefined)).toBeNull();
      expect(safeJsonParse(undefined, [])).toEqual([]);
    });

    it('returns the default for empty string', () => {
      expect(safeJsonParse('')).toBeNull();
    });

    it('returns the default for whitespace-only string', () => {
      expect(safeJsonParse('   ')).toBeNull();
      expect(safeJsonParse('\n\t\n')).toBeNull();
    });
  });

  describe('non-string non-null input', () => {
    it('passes through an existing object (no parse needed)', () => {
      const obj = { a: 1 };
      expect(safeJsonParse(obj)).toBe(obj);
    });

    it('passes through an existing array', () => {
      const arr = [1, 2];
      expect(safeJsonParse(arr)).toBe(arr);
    });

    it('returns the default for a number (not an object)', () => {
      expect(safeJsonParse(42)).toBeNull();
      expect(safeJsonParse(0, 'fallback')).toBe('fallback');
    });

    it('returns the default for a boolean (not an object)', () => {
      expect(safeJsonParse(true)).toBeNull();
      expect(safeJsonParse(false, 'fallback')).toBe('fallback');
    });
  });

  describe('rejects non-JSON-shaped strings', () => {
    // The helper short-circuits if the trimmed string doesn't start with
    // '{' or '['. This prevents JSON.parse from successfully parsing
    // bare numbers, strings, or booleans — which the consumers don't
    // expect since metadata is always object-shaped.

    it('returns the default for a bare number string', () => {
      expect(safeJsonParse('42')).toBeNull();
    });

    it('returns the default for a bare boolean string', () => {
      expect(safeJsonParse('true')).toBeNull();
      expect(safeJsonParse('false')).toBeNull();
    });

    it('returns the default for a bare null string', () => {
      expect(safeJsonParse('null')).toBeNull();
    });

    it('returns the default for a quoted-string JSON literal', () => {
      // This is valid JSON but not object-shaped.
      expect(safeJsonParse('"hello"')).toBeNull();
    });

    it('returns the default for non-JSON prose', () => {
      expect(safeJsonParse('hello world')).toBeNull();
      expect(safeJsonParse('not json')).toBeNull();
    });
  });

  describe('malformed JSON', () => {
    it('returns the default for unterminated objects', () => {
      expect(safeJsonParse('{')).toBeNull();
      expect(safeJsonParse('{"a":')).toBeNull();
    });

    it('returns the default for unterminated arrays', () => {
      expect(safeJsonParse('[')).toBeNull();
      expect(safeJsonParse('[1,')).toBeNull();
    });

    it('returns the default for trailing garbage', () => {
      expect(safeJsonParse('{}}}')).toBeNull();
    });

    it('uses the supplied default on parse failure', () => {
      expect(safeJsonParse('{not valid', { fallback: true })).toEqual({ fallback: true });
    });
  });

  describe('size limit', () => {
    it('returns the default for strings over 10MB', () => {
      // Build an oversized string that would otherwise be valid JSON.
      const oversized = '{' + '"a":1,'.repeat(2_000_000) + '"b":1}';
      expect(oversized.length).toBeGreaterThan(10 * 1024 * 1024);
      expect(safeJsonParse(oversized)).toBeNull();
    });
  });
});

describe('normalizeMetadata', () => {
  describe('null-ish and falsy', () => {
    it('returns {} for null', () => {
      expect(normalizeMetadata(null)).toEqual({});
    });

    it('returns {} for undefined', () => {
      expect(normalizeMetadata(undefined)).toEqual({});
    });

    it('returns {} for empty string', () => {
      expect(normalizeMetadata('')).toEqual({});
    });

    it('returns {} for whitespace-only string', () => {
      expect(normalizeMetadata('   ')).toEqual({});
      expect(normalizeMetadata('\n\t\n')).toEqual({});
    });

    it('returns {} for the string "null"', () => {
      // safeJsonParse returns null, which fails the typeof object guard.
      expect(normalizeMetadata('null')).toEqual({});
    });
  });

  describe('object input', () => {
    it('clones a plain object (does not return the same reference)', () => {
      const input = { factory_internal: true, kind: 'architect' };
      const result = normalizeMetadata(input);
      expect(result).toEqual(input);
      expect(result).not.toBe(input);
    });

    it('returns a shallow clone — nested values are still shared', () => {
      const nested = { allowed: ['ollama'] };
      const input = { provider_lane_policy: nested };
      const result = normalizeMetadata(input);
      expect(result.provider_lane_policy).toBe(nested);
    });

    it('copies enumerable own properties from object instances into a plain object', () => {
      class TaskMetadata {
        constructor() {
          this.kind = 'instance';
          this.factory_internal = true;
        }
      }

      const input = new TaskMetadata();
      const result = normalizeMetadata(input);

      expect(result).toEqual({ kind: 'instance', factory_internal: true });
      expect(result).not.toBe(input);
      expect(result).not.toBeInstanceOf(TaskMetadata);
    });

    it('returns {} for an empty object', () => {
      expect(normalizeMetadata({})).toEqual({});
    });
  });

  describe('array input (rejected)', () => {
    it('returns {} for an array (arrays are not metadata)', () => {
      expect(normalizeMetadata([])).toEqual({});
      expect(normalizeMetadata([{ kind: 'foo' }])).toEqual({});
    });
  });

  describe('JSON string input', () => {
    it('parses a JSON object string', () => {
      const result = normalizeMetadata('{"factory_internal": true, "kind": "scout"}');
      expect(result).toEqual({ factory_internal: true, kind: 'scout' });
    });

    it('parses a JSON object string with surrounding whitespace', () => {
      const result = normalizeMetadata('\n\t{"kind": "spaced", "priority": 2}  ');
      expect(result).toEqual({ kind: 'spaced', priority: 2 });
    });

    it('returns {} when the string parses to an array', () => {
      expect(normalizeMetadata('[1, 2, 3]')).toEqual({});
    });

    it('returns {} when the string parses to an array of objects', () => {
      expect(normalizeMetadata('[{"kind": "not-metadata"}]')).toEqual({});
    });

    it('returns {} when the string parses to a number', () => {
      expect(normalizeMetadata('42')).toEqual({});
    });

    it('returns {} when the string parses to a boolean', () => {
      expect(normalizeMetadata('true')).toEqual({});
      expect(normalizeMetadata('false')).toEqual({});
    });

    it('returns {} for malformed JSON', () => {
      expect(normalizeMetadata('{not valid json')).toEqual({});
      expect(normalizeMetadata('}{}')).toEqual({});
    });

    it('returns {} for a JSON string that parses to null', () => {
      expect(normalizeMetadata('null')).toEqual({});
    });

    it('returns {} for a quoted JSON string literal', () => {
      expect(normalizeMetadata('"metadata"')).toEqual({});
    });

    it('parses and clones — the parse result is not the returned object', () => {
      // The parsed object would be a new object anyway, but the spread
      // ensures consumers can mutate without surprises if some future
      // refactor reuses a cached parse.
      const result = normalizeMetadata('{"a": 1}');
      expect(result).toEqual({ a: 1 });
      expect(typeof result).toBe('object');
      expect(Array.isArray(result)).toBe(false);
    });
  });

  describe('other primitives', () => {
    it('returns {} for a number', () => {
      expect(normalizeMetadata(42)).toEqual({});
      expect(normalizeMetadata(0)).toEqual({});
    });

    it('returns {} for a boolean', () => {
      expect(normalizeMetadata(true)).toEqual({});
      expect(normalizeMetadata(false)).toEqual({});
    });

    it('returns {} for a function', () => {
      expect(normalizeMetadata(() => ({ a: 1 }))).toEqual({});
    });

    it('returns {} for a Symbol', () => {
      expect(normalizeMetadata(Symbol('m'))).toEqual({});
    });
  });
});

describe('safeJsonStringify', () => {
  it('serializes an object', () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
  });

  it('serializes an array', () => {
    expect(safeJsonStringify([1, 2])).toBe('[1,2]');
  });

  it('serializes primitives', () => {
    expect(safeJsonStringify(42)).toBe('42');
    expect(safeJsonStringify('hi')).toBe('"hi"');
    expect(safeJsonStringify(true)).toBe('true');
    expect(safeJsonStringify(null)).toBe('null');
  });

  it('returns the default on circular structures', () => {
    const circ = {};
    circ.self = circ;
    expect(safeJsonStringify(circ)).toBe('{}'); // default
  });

  it('honors a custom default for circular structures', () => {
    const circ = {};
    circ.self = circ;
    expect(safeJsonStringify(circ, 'CIRCULAR')).toBe('CIRCULAR');
  });

  it('returns "undefined" string for undefined? No — JSON.stringify returns undefined which gets passed through', () => {
    // JSON.stringify(undefined) === undefined (not throws). The helper
    // doesn't intercept this — it returns whatever JSON.stringify gave
    // back. Documenting current behavior so a future "fix" doesn't
    // accidentally change it for the 70+ consumers.
    expect(safeJsonStringify(undefined)).toBeUndefined();
  });

  it('throws-free for BigInt (which JSON.stringify rejects)', () => {
    // BigInt makes JSON.stringify throw; the helper must catch.
    expect(safeJsonStringify(BigInt(1))).toBe('{}');
    expect(safeJsonStringify({ x: BigInt(1) })).toBe('{}');
  });
});
