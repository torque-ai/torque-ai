'use strict';

const {
  sanitizePayloadValue,
  sanitizePayloadObject,
  fenceWebhookContent,
} = require('../utils/webhook-payload-sanitizer');

describe('sanitizePayloadValue', () => {
  it('truncates strings longer than 2000 characters', () => {
    const long = 'x'.repeat(3000);
    const result = sanitizePayloadValue(long);
    expect(result).toHaveLength(2000);
    expect(result).toBe('x'.repeat(2000));
  });

  it('strips null bytes from values', () => {
    const result = sanitizePayloadValue('hello\x00world');
    expect(result).toBe('helloworld');
  });

  it('collapses excessive newlines to at most two', () => {
    const result = sanitizePayloadValue('a\n\n\n\n\nb');
    expect(result).toBe('a\n\nb');
  });

  it('coerces non-string values via JSON.stringify', () => {
    const result = sanitizePayloadValue({ nested: true });
    expect(typeof result).toBe('string');
    expect(result).toContain('nested');
    expect(result).toContain('true');
  });

  it('returns empty string for null and undefined', () => {
    expect(sanitizePayloadValue(null)).toBe('');
    expect(sanitizePayloadValue(undefined)).toBe('');
  });

  it('normalizes fullwidth confusable characters to ASCII', () => {
    // \uFF5B = fullwidth {, \uFF5D = fullwidth }, \uFF1C = fullwidth <, \uFF1E = fullwidth >
    const result = sanitizePayloadValue('\uFF5B\uFF5Binjection\uFF5D\uFF5D');
    expect(result).toBe('{{injection}}');
  });
});

describe('sanitizePayloadObject', () => {
  it('rejects prototype-pollution keys', () => {
    const input = { __proto__: 'evil', constructor: 'bad', prototype: 'nope', safe: 'ok' };
    const result = sanitizePayloadObject(input);
    expect(result).toHaveProperty('safe', 'ok');
    expect(result).not.toHaveProperty('__proto__');
    expect(result).not.toHaveProperty('constructor');
    expect(result).not.toHaveProperty('prototype');
  });

  it('does not mutate the input object', () => {
    const inner = 'hello\x00world';
    const input = { greeting: inner };
    const result = sanitizePayloadObject(input);
    // Result should be sanitized
    expect(result.greeting).toBe('helloworld');
    // Original must be untouched
    expect(input.greeting).toBe(inner);
    expect(Object.is(input.greeting, inner)).toBe(true);
  });

  it('sanitizes nested object values one level deep', () => {
    const input = { data: { title: 'a\x00b' } };
    const result = sanitizePayloadObject(input);
    expect(result.data.title).toBe('ab');
  });

  it('returns empty object for non-object input', () => {
    expect(sanitizePayloadObject(null)).toEqual({});
    expect(sanitizePayloadObject('string')).toEqual({});
    expect(sanitizePayloadObject(42)).toEqual({});
    expect(sanitizePayloadObject([1, 2])).toEqual({});
  });

  it('rejects prototype-pollution keys inside nested objects', () => {
    const input = { data: { __proto__: 'evil', safe: 'ok' } };
    const result = sanitizePayloadObject(input);
    expect(result.data).toHaveProperty('safe', 'ok');
    expect(result.data).not.toHaveProperty('__proto__');
  });
});

describe('fenceWebhookContent', () => {
  it('wraps text in external-data delimiters', () => {
    const result = fenceWebhookContent('some text');
    expect(result).toContain('--- BEGIN EXTERNAL WEBHOOK DATA ---');
    expect(result).toContain('--- END EXTERNAL WEBHOOK DATA ---');
    expect(result).toContain('some text');

    // Verify ordering: BEGIN before content before END
    const beginIdx = result.indexOf('--- BEGIN EXTERNAL WEBHOOK DATA ---');
    const textIdx = result.indexOf('some text');
    const endIdx = result.indexOf('--- END EXTERNAL WEBHOOK DATA ---');
    expect(beginIdx).toBeLessThan(textIdx);
    expect(textIdx).toBeLessThan(endIdx);
  });

  it('coerces non-string input to string', () => {
    const result = fenceWebhookContent(12345);
    expect(result).toContain('12345');
    expect(result).toContain('--- BEGIN EXTERNAL WEBHOOK DATA ---');
  });

  it('handles null/undefined by coercing to empty string', () => {
    const resultNull = fenceWebhookContent(null);
    expect(resultNull).toContain('--- BEGIN EXTERNAL WEBHOOK DATA ---');
    expect(resultNull).toContain('--- END EXTERNAL WEBHOOK DATA ---');

    const resultUndefined = fenceWebhookContent(undefined);
    expect(resultUndefined).toContain('--- BEGIN EXTERNAL WEBHOOK DATA ---');
    expect(resultUndefined).toContain('--- END EXTERNAL WEBHOOK DATA ---');
  });
});
