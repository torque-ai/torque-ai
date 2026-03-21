'use strict';
/* global describe, it, expect */

const { buildResumeContext, formatResumeContextForPrompt } = require('../utils/resume-context');

describe('resume-context', () => {
  it('extracts file paths from git diff output', () => {
    const taskOutput = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
    ].join('\n');

    const context = buildResumeContext(taskOutput, '', {});

    expect(context.filesModified).toEqual(['src/foo.ts']);
  });

  it('extracts file paths from editor output', () => {
    const taskOutput = [
      'Wrote src/bar.ts',
      'Created src/baz.ts',
      'Modified src/qux.ts',
      'Edit: src/quux.ts',
    ].join('\n');

    const context = buildResumeContext(taskOutput, '', {});

    expect(context.filesModified).toEqual([
      'src/bar.ts',
      'src/baz.ts',
      'src/qux.ts',
      'src/quux.ts',
    ]);
  });

  it('extracts commands from output', () => {
    const taskOutput = [
      '$ npx vitest run tests/foo.test.js',
      '> git status --short',
      'Command: node server/index.js',
      'Running npm test now',
    ].join('\n');

    const context = buildResumeContext(taskOutput, '', {});

    expect(context.commandsRun).toEqual([
      'npx vitest run tests/foo.test.js',
      'git status --short',
      'node server/index.js',
      'npm test now',
    ]);
  });

  it('truncates long fields', () => {
    const taskOutput = 'a'.repeat(2000);

    const context = buildResumeContext(taskOutput, '', {});

    expect(context.progressSummary.length).toBeLessThanOrEqual(500);
    expect(context.approachTaken.length).toBeLessThanOrEqual(500);
    expect(context.goal.length).toBeLessThanOrEqual(200);
  });

  it('formats markdown prompt correctly', () => {
    const formatted = formatResumeContextForPrompt({
      goal: 'Fix resume prompt generation',
      provider: 'codex',
      durationMs: 1234,
      filesModified: ['src/foo.ts', 'src/bar.ts'],
      commandsRun: ['npx vitest run'],
      progressSummary: 'Updated parsing logic.',
      errorDetails: 'TypeError: boom',
      approachTaken: 'Started by scanning retry handlers.',
    });

    expect(formatted).toContain('## Previous Attempt (failed)');
    expect(formatted).toContain('**Provider:** codex | **Duration:** 1234ms');
    expect(formatted).toContain('**Files touched:** src/foo.ts, src/bar.ts');
    expect(formatted).toContain('**Commands run:** npx vitest run');
    expect(formatted).toContain('**Progress before failure:**\nUpdated parsing logic.');
    expect(formatted).toContain('**Error:**\nTypeError: boom');
    expect(formatted).toContain('**Approach taken:**\nStarted by scanning retry handlers.');
    expect(formatted).toContain('Do NOT repeat the same approach.');
    expect(formatted.length).toBeLessThanOrEqual(3000);
  });

  it('omits empty sections in formatted output', () => {
    const formatted = formatResumeContextForPrompt({
      provider: 'codex',
      durationMs: 500,
      filesModified: [],
      commandsRun: [],
      progressSummary: '',
      errorDetails: 'failure',
      approachTaken: '',
    });

    expect(formatted).not.toContain('**Files touched:**');
    expect(formatted).not.toContain('**Commands run:**');
    expect(formatted).not.toContain('**Progress before failure:**');
    expect(formatted).not.toContain('**Approach taken:**');
    expect(formatted).toContain('**Error:**\nfailure');
  });

  it('handles null/undefined inputs gracefully', () => {
    const context = buildResumeContext(null, undefined, undefined);

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
});
