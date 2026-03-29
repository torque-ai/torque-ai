'use strict';

const piiGuard = require('../utils/pii-guard');

describe('POST /api/pii-scan logic', () => {
  it('detects and sanitizes user paths', () => {
    const result = piiGuard.scanAndReplace('Path C:\\Users\\Werem\\Projects\\app');
    expect(result.clean).toBe(false);
    expect(result.sanitized).toContain('<user>');
    expect(result.findings).toHaveLength(1);
  });

  it('returns clean=true for safe text', () => {
    const result = piiGuard.scanAndReplace('No PII here');
    expect(result.clean).toBe(true);
  });

  it('applies custom patterns from options', () => {
    const result = piiGuard.scanAndReplace('Machine BahumutsOmen running', {
      customPatterns: [{ pattern: 'BahumutsOmen', replacement: 'example-host' }]
    });
    expect(result.sanitized).toBe('Machine example-host running');
  });

  it('handles missing text gracefully', () => {
    const result = piiGuard.scanAndReplace(undefined);
    expect(result.clean).toBe(true);
    expect(result.sanitized).toBe('');
  });
});
