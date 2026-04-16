'use strict';

import { describe, it, expect } from 'vitest';

const { createContextVariables } = require('../crew/context-variables');

describe('contextVariables', () => {
  it('get/set simple keys', () => {
    const cv = createContextVariables({ user: 'alice' });

    expect(cv.get('user')).toBe('alice');
    cv.set('user', 'bob');
    expect(cv.get('user')).toBe('bob');
  });

  it('merge applies a patch', () => {
    const cv = createContextVariables({ a: 1, b: 2 });

    cv.merge({ b: 3, c: 4 });
    expect(cv.snapshot()).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('snapshot returns a copy (mutating snapshot does not affect state)', () => {
    const cv = createContextVariables({ a: 1 });
    const s = cv.snapshot();

    s.a = 99;
    expect(cv.get('a')).toBe(1);
  });

  it('history tracks merges in order', () => {
    const cv = createContextVariables();

    cv.merge({ a: 1 });
    cv.merge({ b: 2 });
    expect(cv.history()).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
