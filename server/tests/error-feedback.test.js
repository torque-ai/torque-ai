'use strict';

/**
 * Unit Tests: Error-Feedback Retry Loop
 *
 * Tests buildHashlineErrorFeedbackPrompt integration.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { computeLineHash } = require('../handlers/hashline-handlers');
const { buildHashlineErrorFeedbackPrompt } = require('../utils/context-enrichment');

let tempDir;

beforeAll(() => {
  tempDir = path.join(os.tmpdir(), `torque-error-feedback-test-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
});

afterAll(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── buildHashlineErrorFeedbackPrompt ──────────────────────────────────

describe('buildHashlineErrorFeedbackPrompt', () => {
  it('generates re-annotated content with line hashes', () => {
    const projDir = path.join(tempDir, 'feedback-prompt-1');
    fs.mkdirSync(projDir, { recursive: true });

    const fileContent = 'const x = 1;\nconst y = 2;\nconst z = 3;\n';
    fs.writeFileSync(path.join(projDir, 'test.js'), fileContent);

    const errors = ['test.js: Syntax error - unexpected token'];
    const result = buildHashlineErrorFeedbackPrompt(projDir, ['test.js'], errors, 'hashline');

    // Should contain re-annotated lines
    expect(result).toContain('L001:');
    expect(result).toContain('L002:');
    expect(result).toContain('L003:');

    // Should contain the error
    expect(result).toContain('unexpected token');

    // Should contain fix instruction
    expect(result).toContain('FIX THE FOLLOWING ERRORS');
    expect(result).toContain('HASHLINE_EDIT');
  });

  it('includes correct hashes matching computeLineHash', () => {
    const projDir = path.join(tempDir, 'feedback-prompt-hashes');
    fs.mkdirSync(projDir, { recursive: true });

    const line1 = 'function hello() {';
    const line2 = '  return "world";';
    const line3 = '}';
    fs.writeFileSync(path.join(projDir, 'func.js'), `${line1}\n${line2}\n${line3}\n`);

    const result = buildHashlineErrorFeedbackPrompt(projDir, ['func.js'], ['error'], 'hashline');

    const hash1 = computeLineHash(line1);
    const hash2 = computeLineHash(line2);
    const hash3 = computeLineHash(line3);

    expect(result).toContain(`L001:${hash1}:`);
    expect(result).toContain(`L002:${hash2}:`);
    expect(result).toContain(`L003:${hash3}:`);
  });

  it('uses SEARCH/REPLACE instruction for hashline-lite format', () => {
    const projDir = path.join(tempDir, 'feedback-prompt-lite');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'test.ts'), 'const x: number = "hello";\n');

    const result = buildHashlineErrorFeedbackPrompt(projDir, ['test.ts'], ['TS2322'], 'hashline-lite');
    expect(result).toContain('SEARCH');
    expect(result).toContain('REPLACE');
  });

  it('returns empty for no errors', () => {
    const result = buildHashlineErrorFeedbackPrompt(tempDir, ['test.js'], [], 'hashline');
    expect(result).toBe('');
  });

  it('returns empty for no modified files', () => {
    const result = buildHashlineErrorFeedbackPrompt(tempDir, [], ['error'], 'hashline');
    expect(result).toBe('');
  });

  it('returns empty for null inputs', () => {
    expect(buildHashlineErrorFeedbackPrompt(tempDir, null, ['error'], 'hashline')).toBe('');
    expect(buildHashlineErrorFeedbackPrompt(tempDir, ['f'], null, 'hashline')).toBe('');
  });

  it('handles multiple files', () => {
    const projDir = path.join(tempDir, 'feedback-prompt-multi');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'a.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(projDir, 'b.js'), 'const b = 2;\n');

    const errors = ['a.js: error1', 'b.js: error2'];
    const result = buildHashlineErrorFeedbackPrompt(projDir, ['a.js', 'b.js'], errors, 'hashline');

    expect(result).toContain('### FILE: a.js');
    expect(result).toContain('### FILE: b.js');
    expect(result).toContain('error1');
    expect(result).toContain('error2');
  });

  it('skips non-existent files gracefully', () => {
    const projDir = path.join(tempDir, 'feedback-prompt-missing');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'exists.js'), 'const x = 1;\n');

    const result = buildHashlineErrorFeedbackPrompt(projDir, ['exists.js', 'missing.js'], ['error'], 'hashline');
    expect(result).toContain('### FILE: exists.js');
    expect(result).not.toContain('### FILE: missing.js');
  });
});
