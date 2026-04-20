'use strict';
/* global describe, it, expect */

const {
  buildResumeContext,
  formatResumeContextForPrompt,
  prependResumeContextToPrompt,
} = require('../utils/resume-context');

describe('resume-context', () => {
  it('extracts files from Wrote output', () => {
    const context = buildResumeContext('Wrote server/foo.js', '', {});

    expect(context.filesModified).toEqual(['server/foo.js']);
  });

  it('extracts files from markdown link patterns', () => {
    const context = buildResumeContext('- [server/foo.js]', '', {});

    expect(context.filesModified).toEqual(['server/foo.js']);
  });

  it('extracts files from action lines with punctuation, code spans, and Windows paths', () => {
    const context = buildResumeContext([
      'Created file: `server/foo.js`',
      'Updated C:\\work\\repo\\server\\bar.test.js',
      'Modified path [server/baz.js](server/baz.js)',
    ].join('\n'), '', {});

    expect(context.filesModified).toEqual([
      'server/foo.js',
      'C:/work/repo/server/bar.test.js',
      'server/baz.js',
    ]);
  });

  it('merges file paths provided through metadata aliases', () => {
    const context = buildResumeContext('Wrote server/foo.js', '', {
      files_modified: ['server/bar.js', 'server/foo.js'],
    });

    expect(context.filesModified).toEqual(['server/foo.js', 'server/bar.js']);
  });

  it('extracts commands from $ lines', () => {
    const context = buildResumeContext('$ npx vitest run tests/foo.test.js', '', {});

    expect(context.commandsRun).toEqual(['npx vitest run tests/foo.test.js']);
  });

  it('extracts raw command lines and npm prompt lines without duplicates', () => {
    const context = buildResumeContext([
      'git status --short',
      '> npm run lint',
      '$ git status --short',
    ].join('\n'), '', {});

    expect(context.commandsRun).toEqual(['git status --short', 'npm run lint']);
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

  it('accepts metadata aliases for goal and duration', () => {
    const context = buildResumeContext('', '', {
      description: 'Finish the retry builder',
      started_at: '2026-04-19T10:00:00.000Z',
      completed_at: '2026-04-19T10:00:45.000Z',
      provider: 'codex',
    });

    expect(context.goal).toBe('Finish the retry builder');
    expect(context.durationMs).toBe(45000);
    expect(context.provider).toBe('codex');
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

  it('prepends formatted resume context to retry prompts', () => {
    const prompt = prependResumeContextToPrompt('Retry the task', {
      provider: 'codex',
      durationMs: 2500,
      filesModified: ['server/foo.js'],
      progressSummary: 'made progress',
      errorDetails: 'failed at lint',
      approachTaken: 'edited foo',
    });

    expect(prompt.startsWith('## Previous Attempt (failed)')).toBe(true);
    expect(prompt).toContain('**Provider:** codex | **Duration:** 2.5s');
    expect(prompt).toContain('\n\n---\n\nRetry the task');
  });

  it('replaces an existing resume preamble instead of duplicating it', () => {
    const first = prependResumeContextToPrompt('Retry the task', {
      provider: 'codex',
      durationMs: 1000,
      filesModified: [],
      progressSummary: 'old progress',
      errorDetails: 'old error',
      approachTaken: 'old approach',
    });
    const second = prependResumeContextToPrompt(first, {
      provider: 'deepinfra',
      durationMs: 2000,
      filesModified: ['server/bar.js'],
      progressSummary: 'new progress',
      errorDetails: 'new error',
      approachTaken: 'new approach',
    });

    expect(second.match(/## Previous Attempt \(failed\)/g)).toHaveLength(1);
    expect(second).toContain('**Provider:** deepinfra | **Duration:** 2s');
    expect(second).toContain('new error');
    expect(second).not.toContain('old error');
    expect(second).toContain('\n\n---\n\nRetry the task');
  });
});
