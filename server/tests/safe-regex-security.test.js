'use strict';
const { isSafeRegex, safeRegexTest } = require('../utils/safe-regex');

describe('safe-regex security', () => {
  describe('isSafeRegex', () => {
    it('rejects nested group quantifiers like (a+)+', () => {
      expect(isSafeRegex('(a+)+b')).toBe(false);
    });

    it('rejects alternation in quantified groups like (a|a)+', () => {
      expect(isSafeRegex('(a|a)+b')).toBe(false);
    });

    it('rejects adjacent quantifiers like a++', () => {
      expect(isSafeRegex('a++')).toBe(false);
    });

    it('accepts safe patterns', () => {
      expect(isSafeRegex('error.*timeout')).toBe(true);
      expect(isSafeRegex('^[a-z]+$')).toBe(true);
      expect(isSafeRegex('\\d{3}-\\d{4}')).toBe(true);
    });

    it('rejects patterns over max length', () => {
      expect(isSafeRegex('a'.repeat(201))).toBe(false);
    });

    it('rejects invalid regex syntax', () => {
      expect(isSafeRegex('(?P<name>test)')).toBe(false); // invalid in JS
    });
  });

  describe('safeRegexTest', () => {
    it('returns false for unsafe patterns', () => {
      expect(safeRegexTest('(a+)+b', 'aaaaab')).toBe(false);
    });

    it('works correctly for safe patterns', () => {
      expect(safeRegexTest('hello', 'hello world')).toBe(true);
      expect(safeRegexTest('hello', 'goodbye')).toBe(false);
    });

    it('truncates input to 10000 chars', () => {
      const start = Date.now();
      safeRegexTest('a.*b', 'a'.repeat(100000) + 'b');
      expect(Date.now() - start).toBeLessThan(1000);
    });
  });

  describe('tool-registry pattern guard', () => {
    it('isSafeRegex rejects patterns that would cause ReDoS in schema validation', () => {
      expect(isSafeRegex('(\\w+\\s*)+$')).toBe(false);
    });
  });
});
