'use strict';

const { normalizeMetadata } = require('../utils/normalize-metadata');

// normalizeMetadata is the canonical "give me a plain object" helper used
// by task-core, crew-runner, the codex reasoning_effort classifier, and
// other paths that read task.metadata. The DB stores metadata as a JSON
// string but in-memory paths sometimes pass an already-parsed object.
// All consumers depend on the helper returning a fresh plain object so
// downstream `delete` / mutation can't leak through. Pin the contract:

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

    it('returns {} when the string parses to an array', () => {
      expect(normalizeMetadata('[1, 2, 3]')).toEqual({});
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
