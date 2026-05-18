import { describe, it, expect } from 'vitest';

import {
  getWorkItemConstraintsObject,
  getWorkItemOriginObject,
  extractWorkItemAcceptanceCriteria,
  normalizeWorkItemDetail,
  getWorkItemDetail,
} from '../factory/shared/workitem-accessors.js';

// ---------------------------------------------------------------------------
// getWorkItemConstraintsObject
// ---------------------------------------------------------------------------
describe('getWorkItemConstraintsObject', () => {
  it('returns parsed object when constraints_json is a valid JSON string', () => {
    const workItem = { constraints_json: '{"maxFiles":3,"scope":"server"}' };
    expect(getWorkItemConstraintsObject(workItem)).toEqual({ maxFiles: 3, scope: 'server' });
  });

  it('returns the constraints object as-is when it is already a parsed object', () => {
    const obj = { maxFiles: 5 };
    const workItem = { constraints: obj };
    expect(getWorkItemConstraintsObject(workItem)).toBe(obj);
  });

  it('returns {} when constraints_json is null', () => {
    const workItem = { constraints_json: null };
    expect(getWorkItemConstraintsObject(workItem)).toEqual({});
  });

  it('returns {} when the workItem has no constraints or constraints_json', () => {
    expect(getWorkItemConstraintsObject({})).toEqual({});
  });

  it('returns {} when workItem is null or undefined', () => {
    expect(getWorkItemConstraintsObject(null)).toEqual({});
    expect(getWorkItemConstraintsObject(undefined)).toEqual({});
  });

  it('returns {} when constraints_json is malformed JSON', () => {
    const workItem = { constraints_json: '{not valid json' };
    expect(getWorkItemConstraintsObject(workItem)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getWorkItemOriginObject
// ---------------------------------------------------------------------------
describe('getWorkItemOriginObject', () => {
  it('returns parsed object from a JSON string in origin_json', () => {
    const workItem = { origin_json: '{"source":"github","id":42}' };
    expect(getWorkItemOriginObject(workItem)).toEqual({ source: 'github', id: 42 });
  });

  it('returns a shallow copy when origin is already an object', () => {
    const obj = { source: 'manual', priority: 'high' };
    const workItem = { origin: obj };
    const result = getWorkItemOriginObject(workItem);
    expect(result).toEqual(obj);
    expect(result).not.toBe(obj); // must be a copy
  });

  it('returns {} when origin_json is null', () => {
    const workItem = { origin_json: null };
    expect(getWorkItemOriginObject(workItem)).toEqual({});
  });

  it('returns {} when origin_json is missing/undefined', () => {
    expect(getWorkItemOriginObject({})).toEqual({});
  });

  it('returns {} when workItem is null or undefined', () => {
    expect(getWorkItemOriginObject(null)).toEqual({});
    expect(getWorkItemOriginObject(undefined)).toEqual({});
  });

  it('returns {} when origin_json is malformed JSON', () => {
    const workItem = { origin_json: '{"broken' };
    expect(getWorkItemOriginObject(workItem)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// extractWorkItemAcceptanceCriteria
// ---------------------------------------------------------------------------
describe('extractWorkItemAcceptanceCriteria', () => {
  it('extracts text after the "Acceptance criteria:" marker', () => {
    const workItem = {
      description: 'Implement auth module.\nAcceptance criteria: All endpoints return 200',
    };
    expect(extractWorkItemAcceptanceCriteria(workItem)).toBe('All endpoints return 200');
  });

  it('is case-insensitive for the marker', () => {
    const workItem = {
      description: 'Fix bug.\nacceptance CRITERIA: Tests pass on CI',
    };
    expect(extractWorkItemAcceptanceCriteria(workItem)).toBe('Tests pass on CI');
  });

  it('returns null when the description contains no marker', () => {
    const workItem = { description: 'Just a plain description with no criteria' };
    expect(extractWorkItemAcceptanceCriteria(workItem)).toBeNull();
  });

  it('returns null when description is empty or missing', () => {
    expect(extractWorkItemAcceptanceCriteria({ description: '' })).toBeNull();
    expect(extractWorkItemAcceptanceCriteria({})).toBeNull();
    expect(extractWorkItemAcceptanceCriteria(null)).toBeNull();
  });

  it('truncates extracted text at 800 characters', () => {
    const longText = 'A'.repeat(900);
    const workItem = {
      description: `Task.\nAcceptance criteria: ${longText}`,
    };
    const result = extractWorkItemAcceptanceCriteria(workItem);
    expect(result.length).toBe(800);
    expect(result).toBe('A'.repeat(800));
  });

  it('stops at the first blank-line-separated paragraph', () => {
    const workItem = {
      description:
        'Task.\nAcceptance criteria: First paragraph here.\n\nSecond paragraph should be excluded.',
    };
    expect(extractWorkItemAcceptanceCriteria(workItem)).toBe('First paragraph here.');
  });

  it('collapses internal whitespace to single spaces', () => {
    const workItem = {
      description: 'Task.\nAcceptance criteria: line one\n  line two\n   line three',
    };
    expect(extractWorkItemAcceptanceCriteria(workItem)).toBe('line one line two line three');
  });
});

// ---------------------------------------------------------------------------
// normalizeWorkItemDetail
// ---------------------------------------------------------------------------
describe('normalizeWorkItemDetail', () => {
  it('trims leading/trailing whitespace from a string input', () => {
    expect(normalizeWorkItemDetail('  hello world  ')).toBe('hello world');
  });

  it('returns the string as-is when already trimmed', () => {
    expect(normalizeWorkItemDetail('clean')).toBe('clean');
  });

  it('joins array elements with "; " separator', () => {
    expect(normalizeWorkItemDetail(['foo', 'bar', 'baz'])).toBe('foo; bar; baz');
  });

  it('trims individual array elements and filters out empty strings', () => {
    expect(normalizeWorkItemDetail(['  a ', '', '  b  ', '  '])).toBe('a; b');
  });

  it('returns null for an empty string', () => {
    expect(normalizeWorkItemDetail('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(normalizeWorkItemDetail('   ')).toBeNull();
  });

  it('returns null for an empty array', () => {
    expect(normalizeWorkItemDetail([])).toBeNull();
  });

  it('returns null for an array of only empty/whitespace strings', () => {
    expect(normalizeWorkItemDetail(['', '  ', ''])).toBeNull();
  });

  it('returns null for non-string, non-array inputs', () => {
    expect(normalizeWorkItemDetail(null)).toBeNull();
    expect(normalizeWorkItemDetail(undefined)).toBeNull();
    expect(normalizeWorkItemDetail(0)).toBeNull();
    expect(normalizeWorkItemDetail({})).toBeNull();
    expect(normalizeWorkItemDetail(false)).toBeNull();
  });

  it('filters out non-string elements in arrays', () => {
    expect(normalizeWorkItemDetail([42, null, 'valid', undefined])).toBe('valid');
  });
});

// ---------------------------------------------------------------------------
// getWorkItemDetail
// ---------------------------------------------------------------------------
describe('getWorkItemDetail', () => {
  it('returns the first matching detail from constraints, checked before origin', () => {
    const workItem = {
      constraints_json: '{"scope":"server","priority":"high"}',
      origin_json: '{"scope":"client","priority":"low"}',
    };
    expect(getWorkItemDetail(workItem, ['scope'])).toBe('server');
  });

  it('falls back to origin when constraints has no match', () => {
    const workItem = {
      constraints_json: '{"unrelated":"value"}',
      origin_json: '{"scope":"client"}',
    };
    expect(getWorkItemDetail(workItem, ['scope'])).toBe('client');
  });

  it('tries keys in order and returns the first non-null detail', () => {
    const workItem = {
      constraints_json: '{"fallback":"yes"}',
      origin_json: '{}',
    };
    expect(getWorkItemDetail(workItem, ['missing', 'fallback'])).toBe('yes');
  });

  it('returns null when no key matches in either source', () => {
    const workItem = {
      constraints_json: '{"a":"1"}',
      origin_json: '{"b":"2"}',
    };
    expect(getWorkItemDetail(workItem, ['x', 'y'])).toBeNull();
  });

  it('returns null when workItem is null or empty', () => {
    expect(getWorkItemDetail(null, ['scope'])).toBeNull();
    expect(getWorkItemDetail({}, ['scope'])).toBeNull();
  });

  it('normalizes values found in sources (trims strings, joins arrays)', () => {
    const workItem = {
      constraints_json: '{"tags":["  alpha ","beta"]}',
    };
    expect(getWorkItemDetail(workItem, ['tags'])).toBe('alpha; beta');
  });

  it('skips keys whose values normalize to null', () => {
    const workItem = {
      constraints_json: '{"empty":"   ","valid":"found"}',
      origin_json: '{}',
    };
    expect(getWorkItemDetail(workItem, ['empty', 'valid'])).toBe('found');
  });
});
