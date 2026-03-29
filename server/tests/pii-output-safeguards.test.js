'use strict';

const piiGuard = require('../utils/pii-guard');

describe('PII guard in output safeguards', () => {
  it('replaces PII in task output text', () => {
    const output = 'Created file at C:\\Users\\Werem\\Projects\\app\\src\\main.ts';
    const result = piiGuard.scanAndReplace(output);
    expect(result.clean).toBe(false);
    expect(result.sanitized).not.toContain('Werem');
    expect(result.sanitized).toContain('<user>');
  });

  it('replaces private IPs in task output', () => {
    const output = 'Connected to Ollama at http://192.168.1.100:11434';
    const result = piiGuard.scanAndReplace(output);
    expect(result.clean).toBe(false);
    expect(result.sanitized).toContain('192.0.2.100');
  });

  it('leaves clean output unchanged', () => {
    const output = 'Task completed: 5 files modified, all tests passing';
    const result = piiGuard.scanAndReplace(output);
    expect(result.clean).toBe(true);
    expect(result.sanitized).toBe(output);
  });

  it('handles output with multiple PII types', () => {
    const output = 'Working in C:\\Users\\Werem\\Projects\\app\nHost: 192.168.1.100\nAuthor: weremittens@gmail.com';
    const result = piiGuard.scanAndReplace(output);
    expect(result.findings.length).toBeGreaterThanOrEqual(3);
    expect(result.sanitized).not.toContain('Werem');
    expect(result.sanitized).not.toContain('192.168');
    expect(result.sanitized).not.toContain('weremittens');
  });
});
