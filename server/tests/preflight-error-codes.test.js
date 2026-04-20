import { describe, test, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const {
  PREFLIGHT_ERROR_CODES,
  PREFLIGHT_ERROR_CODE_PATTERN,
} = require('../execution/preflight-error');

describe('PreflightError code convention', () => {
  test('every registered code matches the UPPER_SNAKE_CASE pattern', () => {
    for (const code of Object.values(PREFLIGHT_ERROR_CODES)) {
      expect(code).toMatch(PREFLIGHT_ERROR_CODE_PATTERN);
    }
  });

  test('codes are between 3 and 40 characters long', () => {
    for (const code of Object.values(PREFLIGHT_ERROR_CODES)) {
      expect(code.length).toBeGreaterThanOrEqual(3);
      expect(code.length).toBeLessThanOrEqual(40);
    }
  });

  test('registry keys match their values', () => {
    for (const [key, value] of Object.entries(PREFLIGHT_ERROR_CODES)) {
      expect(key).toBe(value);
    }
  });

  test('no duplicate codes in the registry', () => {
    const values = Object.values(PREFLIGHT_ERROR_CODES);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  test('every code used in task-startup.js is registered', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'execution', 'task-startup.js'),
      'utf8',
    );
    const codeRegex = /new PreflightError\s*\([^)]*?code:\s*'([A-Z_][A-Z0-9_]*)'/gms;
    const foundCodes = new Set();
    let match;
    while ((match = codeRegex.exec(source)) !== null) {
      foundCodes.add(match[1]);
    }
    expect(foundCodes.size).toBeGreaterThan(0);
    const registered = new Set(Object.values(PREFLIGHT_ERROR_CODES));
    for (const code of foundCodes) {
      expect(registered.has(code)).toBe(true);
    }
  });
});
