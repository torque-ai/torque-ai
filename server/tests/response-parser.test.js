import { describe, it, expect } from 'vitest';

const { extractJson, extractJsonArray } = require('../orchestrator/response-parser');

describe('response-parser', () => {
  describe('extractJson', () => {
    it('extracts bare JSON object', () => {
      expect(extractJson('{"key": "value"}')).toEqual({ key: 'value' });
    });

    it('extracts JSON from markdown code fence', () => {
      const input = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
      expect(extractJson(input)).toEqual({ key: 'value' });
    });

    it('extracts JSON from unlabeled code fence', () => {
      expect(extractJson('```\n{"key": "value"}\n```')).toEqual({ key: 'value' });
    });

    it('extracts first JSON object when multiple exist', () => {
      expect(extractJson('First: {"a": 1} and second: {"b": 2}')).toEqual({ a: 1 });
    });

    it('handles nested objects', () => {
      expect(extractJson('{"outer": {"inner": [1, 2, 3]}}')).toEqual({ outer: { inner: [1, 2, 3] } });
    });

    it('returns null for no JSON', () => {
      expect(extractJson('no json here')).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(extractJson('')).toBeNull();
      expect(extractJson(null)).toBeNull();
    });

    it('returns null for invalid JSON in fence', () => {
      expect(extractJson('```json\n{invalid}\n```')).toBeNull();
    });

    it('handles JSON with escaped characters', () => {
      const input = '{"msg": "line1\\nline2", "path": "C:\\\\Users"}';
      expect(extractJson(input)).toEqual({ msg: 'line1\nline2', path: 'C:\\Users' });
    });
  });

  describe('extractJsonArray', () => {
    it('extracts bare JSON array', () => {
      expect(extractJsonArray('[1, 2, 3]')).toEqual([1, 2, 3]);
    });

    it('extracts array from code fence', () => {
      expect(extractJsonArray('```json\n[{"id": 1}]\n```')).toEqual([{ id: 1 }]);
    });

    it('returns null for non-array JSON', () => {
      expect(extractJsonArray('{"key": "value"}')).toBeNull();
    });

    it('returns null for no JSON', () => {
      expect(extractJsonArray('just text')).toBeNull();
    });
  });
});
