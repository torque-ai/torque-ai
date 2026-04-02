'use strict';

const piiGuard = require('../utils/pii-guard');

describe('POST /api/pii-scan logic', () => {
  it('detects and sanitizes user paths', () => {
    // Build path at runtime to avoid PII commit hook auto-sanitizing the literal
    const fakePath = ['C:', 'Users', 'TestUser42', 'Projects', 'app'].join('\\');
    const result = piiGuard.scanAndReplace('Path ' + fakePath);
    expect(result.clean).toBe(false);
    expect(result.sanitized).toContain('<user>');
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('returns clean=true for safe text', () => {
    const result = piiGuard.scanAndReplace('No PII here');
    expect(result.clean).toBe(true);
  });

  it('applies custom patterns from options', () => {
    const result = piiGuard.scanAndReplace('Machine ZzTestHost999 running', {
      customPatterns: [{ pattern: 'ZzTestHost999', replacement: 'example-host' }]
    });
    expect(result.sanitized).toBe('Machine example-host running');
  });

  it('handles missing text gracefully', () => {
    const result = piiGuard.scanAndReplace(undefined);
    expect(result.clean).toBe(true);
    expect(result.sanitized).toBe('');
  });
});