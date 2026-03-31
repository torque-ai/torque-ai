'use strict';

/**
 * Unit Tests: Error-Feedback Retry Loop
 *
 * Tests buildErrorFeedbackPrompt integration.
 */

const { buildErrorFeedbackPrompt } = require('../utils/context-enrichment');

describe('buildErrorFeedbackPrompt', () => {
  it('includes the original description, errors, and previous output', () => {
    const result = buildErrorFeedbackPrompt(
      'Fix the syntax error in test.js',
      'const x = 1;\nconst y = ;\n',
      'test.js: Syntax error - unexpected token'
    );

    expect(result).toContain('Fix the syntax error in test.js');
    expect(result).toContain('PREVIOUS ATTEMPT PRODUCED ERRORS');
    expect(result).toContain('unexpected token');
    expect(result).toContain('const y = ;');
  });

  it('preserves multiline error output in the prompt body', () => {
    const errors = [
      'test.ts: TS2322 at L1:5 - Type mismatch',
      'test.ts: TS1005 at L2:1 - Expected semicolon',
    ].join('\n');

    const result = buildErrorFeedbackPrompt(
      'Fix the TypeScript errors in test.ts',
      'const x: number = "hello";\n',
      errors
    );

    expect(result).toContain('TS2322');
    expect(result).toContain('TS1005');
    expect(result).toContain('Type mismatch');
    expect(result).toContain('Expected semicolon');
  });

  it('truncates previous output to the current 2000-character cap', () => {
    const longOutput = 'x'.repeat(5000);
    const result = buildErrorFeedbackPrompt('Fix it', longOutput, 'error');

    expect(result).toContain('Previous output (for context of what was already done):');
    expect(result.endsWith('x'.repeat(2000))).toBe(true);
    expect(result).not.toContain('x'.repeat(2001));
  });

  it('returns the original description when errors are missing', () => {
    expect(buildErrorFeedbackPrompt('just do it', 'output', null)).toBe('just do it');
    expect(buildErrorFeedbackPrompt('just do it', 'output', '')).toBe('just do it');
  });
});
