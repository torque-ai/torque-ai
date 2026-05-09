'use strict';

const { summarizeTaskCompletion, _internals } = require('../utils/completion-summary');

describe('completion-summary', () => {
  it('flags completed codex tasks with no final answer, no files, and no verification evidence', () => {
    const summary = summarizeTaskCompletion({
      id: 'task-no-evidence',
      status: 'completed',
      provider: 'codex',
      exit_code: 0,
      files_modified: [],
      output: null,
      error_output: [
        'user',
        'Run `dotnet test tests/App.Tests.csproj` after making the edit.',
        'codex',
        "I'll first inspect the repo instructions, then make the change.",
        'exec',
        '"pwsh" -Command Get-Content AGENTS.md',
        'succeeded in 20ms:',
        '# AGENTS',
      ].join('\n'),
    });

    expect(summary.category).toBe('completed_no_evidence');
    expect(summary.confidence).toBe('low');
    expect(summary.summary).toContain('no completion evidence');
    expect(summary.summary).toContain('no modified files');
    expect(summary.verification.commands).toEqual([]);
    expect(summary.evidence.executed_command_count).toBe(1);
    expect(summary.final_answer).toBeNull();
    expect(summary.next_step).toContain('Review the transcript');
  });

  it('summarizes files, final answer, and executed verification commands', () => {
    const summary = summarizeTaskCompletion({
      id: 'task-evidence',
      status: 'completed',
      provider: 'codex',
      files_modified: JSON.stringify(['server/utils/completion-summary.js', 'server/tests/completion-summary.test.js']),
      output: '',
      error_output: [
        'codex',
        'Implemented the completion summary helper and wired it into task detail responses.',
        '',
        'Tests: npm run test:smoke passed.',
        'exec',
        'npm run test:smoke',
        'succeeded in 1s:',
        'PASS server/tests/completion-summary.test.js',
      ].join('\n'),
    });

    expect(summary.category).toBe('completed_with_changes');
    expect(summary.confidence).toBe('high');
    expect(summary.files_modified_count).toBe(2);
    expect(summary.final_answer).toEqual(expect.objectContaining({
      source: 'provider_transcript',
    }));
    expect(summary.final_answer.excerpt).toContain('Implemented the completion summary helper');
    expect(summary.verification).toMatchObject({
      status: 'passed',
      commands: ['npm run test:smoke'],
    });
    expect(summary.summary).toContain('Completed with 2 modified files');
    expect(summary.summary).toContain('Verification passed');
  });

  it('uses stdout as the final answer for non-transcript providers', () => {
    const summary = summarizeTaskCompletion({
      status: 'completed',
      files_modified: [],
      output: 'Created the requested migration notes.',
      error_output: '',
    });

    expect(summary.category).toBe('completed_with_evidence');
    expect(summary.final_answer).toEqual({
      source: 'stdout',
      excerpt: 'Created the requested migration notes.',
    });
  });

  it('only counts commands that were actually executed, not commands echoed in the prompt', () => {
    const commands = _internals.extractExecutedCommands([
      'user',
      'Please run `npm run test:smoke`.',
      'codex',
      'I will inspect first.',
      'exec',
      'rg "summary" server',
      'succeeded in 10ms:',
    ].join('\n'));

    expect(commands).toEqual(['rg "summary" server']);
    expect(_internals.extractVerificationEvidence('', commands).commands).toEqual([]);
  });
});
