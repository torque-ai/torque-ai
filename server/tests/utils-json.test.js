'use strict';

const { safeJsonParse, safeJsonStringify } = require('../utils/json');

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
