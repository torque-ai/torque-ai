'use strict';

const { evaluateCondition } = require('../db/condition-eval');

describe('evaluateCondition', () => {
  it('treats no-condition as true', () => {
    expect(evaluateCondition(null, {})).toBe(true);
    expect(evaluateCondition('', {})).toBe(true);
  });

  it('equality on outcome', () => {
    expect(evaluateCondition('outcome=success', { outcome: 'success' })).toBe(true);
    expect(evaluateCondition('outcome=success', { outcome: 'fail' })).toBe(false);
    expect(evaluateCondition('outcome!=fail', { outcome: 'success' })).toBe(true);
  });

  it('reads context.KEY', () => {
    expect(evaluateCondition('context.score>80', { context: { score: 90 } })).toBe(true);
    expect(evaluateCondition('context.score>80', { context: { score: 50 } })).toBe(false);
  });

  it('truthiness check on bare key', () => {
    expect(evaluateCondition('context.flag', { context: { flag: true } })).toBe(true);
    expect(evaluateCondition('context.flag', { context: { flag: false } })).toBe(false);
    expect(evaluateCondition('context.flag', { context: { flag: '0' } })).toBe(false);
    expect(evaluateCondition('context.flag', { context: { flag: 'yes' } })).toBe(true);
    expect(evaluateCondition('context.flag', { context: {} })).toBe(false);
  });

  it('AND combinator', () => {
    expect(evaluateCondition(
      'outcome=success && context.tested=true',
      { outcome: 'success', context: { tested: true } }
    )).toBe(true);
    expect(evaluateCondition(
      'outcome=success && context.tested=true',
      { outcome: 'success', context: { tested: false } }
    )).toBe(false);
  });

  it('OR combinator', () => {
    expect(evaluateCondition(
      'outcome=success || outcome=partial_success',
      { outcome: 'partial_success' }
    )).toBe(true);
  });

  it('NOT prefix', () => {
    expect(evaluateCondition('!outcome=success', { outcome: 'fail' })).toBe(true);
  });

  it('handles failure_class lookups', () => {
    expect(evaluateCondition(
      'failure_class=transient_infra',
      { failure_class: 'transient_infra' }
    )).toBe(true);
  });

  it('contains operator (substring + array)', () => {
    expect(evaluateCondition(
      'context.message contains error',
      { context: { message: 'something error happened' } }
    )).toBe(true);
    expect(evaluateCondition(
      'context.tags contains coding',
      { context: { tags: ['coding', 'review'] } }
    )).toBe(true);
  });

  it('returns false for invalid expressions instead of throwing', () => {
    expect(evaluateCondition('outcome ==', {})).toBe(false);
    expect(evaluateCondition('(((', {})).toBe(false);
  });

  it('numeric operators', () => {
    expect(evaluateCondition('context.score >= 80', { context: { score: 80 } })).toBe(true);
    expect(evaluateCondition('context.score < 5', { context: { score: 3 } })).toBe(true);
    expect(evaluateCondition('context.score < 5', { context: { score: 10 } })).toBe(false);
  });
});
