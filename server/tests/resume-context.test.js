'use strict';
/* global describe, it, expect */

const { buildResumeContext, formatResumeContextForPrompt } = require('../utils/resume-context');

describe('resume-context', () => {
  it('extracts files from Wrote output', () => {
    const context = buildResumeContext('Wrote server/foo.js', '', {});

    expect(context.filesModified).toEqual(['server/foo.js']);
  });

  it('extracts files from markdown link patterns', () => {
    const context = buildResumeContext('- [server/foo.js]', '', {});

    expect(context.filesModified).toEqual(['server/foo.js']);
  });

  it('extracts commands from $ lines', () => {
    const context = buildResumeContext('$ npx vitest run tests/foo.test.js', '', {});

    expect(context.commandsRun).toEqual(['npx vitest run tests/foo.test.js']);
  });

  it('truncates progressSummary to 500 chars', () => {
    const taskOutput = 'p'.repeat(600) + '\nError: boom';
    const context = buildResumeContext(taskOutput, '', {});

    expect(context.progressSummary.length).toBeLessThanOrEqual(500);
    expect(context.progressSummary).toBe('p'.repeat(500));
  });

  it('truncates errorDetails to 1000 chars', () => {
    const errorOutput = 'e'.repeat(1500);
    const context = buildResumeContext('', errorOutput, {});

    expect(context.errorDetails.length).toBeLessThanOrEqual(1000);
    expect(context.errorDetails).toBe('e'.repeat(1000));
  });

  it('handles null/empty inputs gracefully', () => {
    const context = buildResumeContext(null, null, null);

    expect(context).toEqual({
      goal: '',
      filesModified: [],
      commandsRun: [],
      progressSummary: '',
      errorDetails: '',
      approachTaken: '',
      durationMs: 0,
      provider: 'unknown',
    });
  });

  it('formats markdown with all sections', () => {
    const formatted = formatResumeContextForPrompt({
      goal: 'Fix resume context',
      provider: 'codex',
      durationMs: 1500,
      filesModified: ['server/foo.js'],
      progressSummary: 'progress',
      errorDetails: 'failure',
      approachTaken: 'restarted',
    });

    expect(formatted).toContain('## Previous Attempt (failed)');
    expect(formatted).toContain('**Provider:** codex | **Duration:** 1.5s');
    expect(formatted).toContain('**Files modified:** server/foo.js');
    expect(formatted).toContain('**Progress:** progress');
    expect(formatted).toContain('**Error:** failure');
    expect(formatted).toContain('**Approach taken:** restarted');
    expect(formatted).toContain('Do not repeat the same approach. Fix the error and complete the task.');
  });

  it('returns empty string for null context', () => {
    expect(formatResumeContextForPrompt(null)).toBe('');
  });

  it('deduplicates file paths', () => {
    const context = buildResumeContext(
      [
        'Wrote server/foo.js',
        'Updated server/foo.js',
        '- [server/foo.js]',
      ].join('\n'),
      '',
      {},
    );

    expect(context.filesModified).toEqual(['server/foo.js']);
  });

  it('caps commands at 20 entries', () => {
    const taskOutput = Array.from({ length: 25 }, (_, i) => `$ npx vitest run test-${i}.test.js`).join('\n');
    const context = buildResumeContext(taskOutput, '', {});

    expect(context.commandsRun.length).toBe(20);
    expect(context.commandsRun[0]).toBe('npx vitest run test-0.test.js');
    expect(context.commandsRun[19]).toBe('npx vitest run test-19.test.js');
  });
});
