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
      // cancelReason added 2026-05-05 to drive heading switch between
      // "(failed)" and "(interrupted by server restart)" — null when
      // no metadata.cancel_reason was provided.
      cancelReason: null,
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

// recovery-decisions.md conflict #3 — cross-call-site integration. The
// fallback-retry path (server/execution/fallback-retry.js withResumeContextPrompt)
// and the retry-framework path (server/execution/retry-framework.js
// buildRetryResumeFields) both prepend a resume preamble onto
// task.task_description. Audit doc flagged the "possible context duplication
// if fallback + retry both fire in same task lifetime." These tests prove
// they don't stack — the strip-first contract in
// server/utils/resume-context.js ensures the second call replaces the first
// preamble even when the consumers are different modules and the task row
// has been written/re-read between calls.
describe('resume-context cross-call-site (fallback + retry sequencing)', () => {
  const fallbackRetry = require('../execution/fallback-retry');
  const retryFramework = require('../execution/retry-framework');

  it('fallback-retry then retry-framework writes one preamble (no stacking)', () => {
    // Phase 1: task fails on local provider; fallback writes a preamble
    // pointing at the cloud retry attempt.
    const initialTask = {
      id: 'tsk-123',
      task_description: 'Fix the auth bug in routes/login.js',
      provider: 'ollama',
      output: '$ npm run lint\n3 errors found',
      error_output: 'Lint failed',
      started_at: new Date(Date.now() - 30000).toISOString(),
    };

    const fallbackFields = fallbackRetry.withResumeContextPrompt(initialTask, {});

    expect(fallbackFields.task_description).toBeTruthy();
    expect(fallbackFields.task_description.match(/## Previous Attempt \(failed\)/g))
      .toHaveLength(1);
    expect(fallbackFields.task_description).toContain('Fix the auth bug in routes/login.js');

    // Phase 2: the cloud retry runs and also fails. retry-framework now
    // builds its own resume context using the task row that fallback already
    // wrote. The second prepend should REPLACE the first preamble, not stack.
    const taskAfterFallback = {
      ...initialTask,
      task_description: fallbackFields.task_description,
      resume_context: fallbackFields.resume_context,
      provider: 'deepinfra',
    };

    const retryFields = retryFramework.buildRetryResumeFields(
      taskAfterFallback,
      { output: '$ npm run lint\n5 errors found', errorOutput: 'Lint failed worse' },
      '$ npm run lint\n5 errors found'
    );

    expect(retryFields.task_description).toBeTruthy();
    // Exactly one preamble — the strip-first behavior held across modules.
    expect(retryFields.task_description.match(/## Previous Attempt \(failed\)/g))
      .toHaveLength(1);
    // Original task description is preserved at the bottom (not duplicated).
    expect(retryFields.task_description.match(/Fix the auth bug in routes\/login\.js/g))
      .toHaveLength(1);
    // The latest preamble references the latest provider (deepinfra), not
    // the prior one (ollama).
    expect(retryFields.task_description).toContain('**Provider:** deepinfra');
    expect(retryFields.task_description).not.toContain('**Provider:** ollama');
  });

  it('three sequential prepends (fallback → retry → fallback) stay at one preamble', () => {
    let task = {
      id: 'tsk-456',
      task_description: 'Add an integration test for the worker pool',
      provider: 'codex',
      output: 'made some progress',
      error_output: 'first failure',
      started_at: new Date(Date.now() - 10000).toISOString(),
    };

    // First fallback
    let fields = fallbackRetry.withResumeContextPrompt(task, {});
    task = { ...task, ...fields };

    // Retry framework sees a description with 1 preamble
    fields = retryFramework.buildRetryResumeFields(
      task,
      { output: 'still progressing', errorOutput: 'second failure' },
      'still progressing'
    );
    task = { ...task, ...fields };

    // Another fallback (e.g., post-retry the task hits cloud overflow)
    fields = fallbackRetry.withResumeContextPrompt(task, {
      output: 'progress 3',
      error_output: 'third failure',
    });
    task = { ...task, ...fields };

    // After three prepend cycles, exactly one preamble.
    expect(task.task_description.match(/## Previous Attempt \(failed\)/g))
      .toHaveLength(1);
    expect(task.task_description.match(/Add an integration test for the worker pool/g))
      .toHaveLength(1);
  });

  it('preserves original description through fallback when no resumable state exists', () => {
    // Empty output + empty error + no resume_context ⇒ no preamble added.
    const task = {
      id: 'tsk-789',
      task_description: 'Simple task with no failure history',
      provider: 'ollama',
      output: '',
      error_output: '',
    };

    const fields = fallbackRetry.withResumeContextPrompt(task, {});

    // No preamble means the helper returns the original fields untouched.
    expect(fields.task_description).toBeUndefined();
    expect(fields.resume_context).toBeUndefined();
  });
});
