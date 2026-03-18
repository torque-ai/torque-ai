'use strict';

const { isSafeRegex, safeRegexTest } = require('../utils/safe-regex');

describe('utils/safe-regex', () => {
  it('accepts simple valid patterns', () => {
    expect(isSafeRegex('error\\s+\\d+')).toBe(true);
  });

  it('rejects non-string and oversized patterns', () => {
    expect(isSafeRegex(null)).toBe(false);
    expect(isSafeRegex('a'.repeat(201))).toBe(false);
  });

  it('rejects invalid regex syntax', () => {
    expect(isSafeRegex('[')).toBe(false);
  });

  it('tests input with safe regexes only', () => {
    expect(safeRegexTest('hello', 'say hello')).toBe(true);
    expect(safeRegexTest('[', 'say hello')).toBe(false);
  });
});
