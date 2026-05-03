'use strict';

const { summarizeTaskError } = require('../utils/error-summary');

describe('summarizeTaskError', () => {
  it('returns null for completed tasks', () => {
    expect(summarizeTaskError({
      status: 'completed', exit_code: 0, error_output: null,
    })).toBeNull();
  });

  it('returns null for shipped tasks', () => {
    expect(summarizeTaskError({
      status: 'shipped', exit_code: 0,
    })).toBeNull();
  });

  it('returns null for unknown task input', () => {
    expect(summarizeTaskError(null)).toBeNull();
    expect(summarizeTaskError(undefined)).toBeNull();
    expect(summarizeTaskError('not an object')).toBeNull();
  });

  it('classifies cancel-reason injected by the close handler (pre_reclaim_before_create)', () => {
    // Regression for the 2026-05-03 wi=2215 case: codex EXECUTE was
    // killed mid-run with reason pre_reclaim_before_create. The full
    // stderr was 3KB+ of prompt-echo and exec output ending with the
    // injected sentinel.
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: null,
      started_at: '2026-05-03T03:34:21.669Z',
      completed_at: '2026-05-03T03:44:49.055Z',
      error_output: [
        'OpenAI Codex v0.125.0 (research preview)',
        '--------',
        'workdir: C:\\repo',
        'model: gpt-5.5',
        'codex',
        "I'll start by reading the relevant files",
        'exec',
        '"PowerShell" -Command "ls"',
        '',
        '[failed] pre_reclaim_before_create',
      ].join('\n'),
    });
    expect(result).not.toBeNull();
    expect(result.category).toBe('cancelled');
    expect(result.summary).toMatch(/Cancelled by factory/i);
    expect(result.summary).toMatch(/pre-reclaim cancelled by factory/i);
    expect(result.summary).toMatch(/after 10m/);
    expect(result.evidence).toContain('[failed] pre_reclaim_before_create');
  });

  it('classifies the structured [process-exit] signal-kill annotation', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: -1,
      started_at: '2026-05-03T01:00:00Z',
      completed_at: '2026-05-03T01:02:30Z',
      error_output: [
        'codex output here',
        '[process-exit] code=null signal=SIGKILL duration_ms=150000 provider=codex model=gpt-5.5',
      ].join('\n'),
    });
    expect(result.category).toBe('signal_kill');
    expect(result.summary).toMatch(/Killed by SIGKILL/);
    expect(result.summary).toMatch(/after 2m30s/);
    expect(result.summary).toMatch(/codex/);
  });

  it('honors the legacy [process-exit] terminated-by-signal format', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: -1,
      error_output: 'noise\n[process-exit] terminated by signal SIGTERM',
    });
    expect(result.category).toBe('signal_kill');
    expect(result.summary).toMatch(/Killed by SIGTERM/);
  });

  it('classifies a structured non-zero exit with a downstream codex error', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: 1,
      started_at: '2026-05-03T01:00:00Z',
      completed_at: '2026-05-03T01:01:00Z',
      error_output: [
        '[Retry 1/2 - Network error] OpenAI Codex v0.125.0',
        'workdir: C:/repo',
        'model: gpt-5.5',
        '[process-exit] code=1 signal=none duration_ms=60000 provider=codex',
      ].join('\n'),
    });
    expect(result.category).toBe('codex_network');
    expect(result.summary).toMatch(/Codex network\/transport error/);
    expect(result.summary).toMatch(/retry 1\/2/i);
  });

  it('classifies a non-zero exit with a generic last-error line when no codex pattern matches', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'ollama',
      exit_code: 1,
      started_at: '2026-05-03T01:00:00Z',
      completed_at: '2026-05-03T01:00:30Z',
      error_output: [
        'doing stuff',
        'thing happened',
        'Error: failed to invoke tool: edit_file old_text mismatch',
        '[process-exit] code=1 signal=none duration_ms=30000 provider=ollama',
      ].join('\n'),
    });
    expect(result.category).toBe('nonzero_exit');
    expect(result.summary).toMatch(/exited with code 1/i);
    expect(result.summary).toMatch(/edit_file old_text mismatch/);
  });

  it('classifies a non-zero silent exit when no error line can be found', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: 1,
      started_at: '2026-05-03T01:00:00Z',
      completed_at: '2026-05-03T01:00:05Z',
      error_output: '[process-exit] code=1 signal=none duration_ms=5000 provider=codex',
    });
    expect(result.category).toBe('nonzero_exit_silent');
    expect(result.summary).toMatch(/exited with code 1/);
    expect(result.summary).toMatch(/no diagnostic output/);
  });

  it('classifies a codex network retry without a structured exit line', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: 1,
      error_output: '[Retry 2/2 - Network error] OpenAI Codex v0.125.0',
    });
    expect(result.category).toBe('codex_network');
    expect(result.summary).toMatch(/Codex network/);
    expect(result.summary).toMatch(/retry 2\/2/i);
  });

  it('classifies rate-limit / quota errors', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'anthropic',
      exit_code: 1,
      error_output: 'Provider returned 429 rate_limit_exceeded: too many requests',
    });
    expect(result.category).toBe('rate_limit');
    expect(result.summary).toMatch(/rate-limited|over quota/i);
  });

  it('classifies context-length errors', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'anthropic',
      exit_code: 1,
      error_output: 'Request failed: prompt exceeds maximum context length 200000 tokens',
    });
    expect(result.category).toBe('context_length');
    expect(result.summary).toMatch(/context window/);
  });

  it('classifies sandbox-block errors', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: 1,
      error_output: 'workspace-write denied: tried to write outside sandbox',
    });
    expect(result.category).toBe('sandbox_block');
    expect(result.summary).toMatch(/Sandbox blocked/);
  });

  it('classifies auth errors', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: 1,
      error_output: 'Please log in to use Codex CLI',
    });
    expect(result.category).toBe('auth');
    expect(result.summary).toMatch(/authentication/i);
  });

  it('classifies system errors (ENOENT/EACCES/etc.)', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: -103,
      error_output: 'spawn ENOENT: no such file or directory',
    });
    expect(result.category).toBe('system_error');
    expect(result.summary).toMatch(/ENOENT/);
  });

  it('classifies banner-only output (codex started, did exec calls, never produced work)', () => {
    // Mirrors task 65072ba9 — the original 2026-05-03 case before the
    // [process-exit] sentinel was added.
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: 1,
      started_at: '2026-05-03T01:00:56Z',
      completed_at: '2026-05-03T01:03:11Z',
      error_output: [
        'OpenAI Codex v0.125.0 (research preview)',
        '--------',
        'workdir: C:/repo',
        'model: gpt-5.5',
        'provider: openai',
        'reasoning effort: xhigh',
        '--------',
        'user',
        '## Task',
        'Plan: Add OTLP spans...',
        'codex',
        "I'll keep this scoped to the requested work.",
        'exec',
        '"PowerShell" -Command "ls"',
        ' succeeded in 70ms:',
      ].join('\n'),
    });
    // Banner-only takes the fallback path because the structured exit
    // line is absent and there's no parseable error line.
    expect(['banner_only', 'unknown_nonzero_exit']).toContain(result.category);
    expect(result.summary).toMatch(/codex|Provider/i);
    expect(result.summary).toMatch(/after 2m15s|exited with code/);
  });

  it('classifies a worktree-merge cancellation', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: 0,
      error_output: 'work output\n[Worktree] Merge failed: conflict in src/foo.js',
    });
    expect(result.category).toBe('cancelled');
    expect(result.summary).toMatch(/merge failed/i);
    expect(result.summary).toMatch(/conflict in src\/foo\.js/);
  });

  it('falls back to bare exit-code summary when nothing else parses', () => {
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'ollama',
      exit_code: 137,
      error_output: '',
    });
    expect(result.category).toBe('unknown_nonzero_exit');
    expect(result.summary).toMatch(/exited with code 137/);
  });

  it('falls back to status-only when there is no exit code or output', () => {
    const result = summarizeTaskError({
      status: 'cancelled',
      provider: null,
      exit_code: null,
      error_output: null,
    });
    expect(result.category).toBe('unknown');
    expect(result.summary).toMatch(/Cancelled/);
    expect(result.summary).toMatch(/no diagnostic/);
  });

  it('formats sub-second, sub-minute, and multi-hour durations correctly', () => {
    const sub = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: 1,
      started_at: '2026-05-03T01:00:00.000Z',
      completed_at: '2026-05-03T01:00:00.500Z',
      error_output: '[process-exit] code=1 signal=none duration_ms=500 provider=codex',
    });
    expect(sub.summary).toMatch(/500ms/);

    const min = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: 1,
      started_at: '2026-05-03T01:00:00Z',
      completed_at: '2026-05-03T01:05:30Z',
      error_output: '[process-exit] code=1 signal=none duration_ms=330000 provider=codex',
    });
    expect(min.summary).toMatch(/5m30s/);

    const hr = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: 1,
      started_at: '2026-05-03T01:00:00Z',
      completed_at: '2026-05-03T03:30:00Z',
      error_output: '[process-exit] code=1 signal=none duration_ms=9000000 provider=codex',
    });
    expect(hr.summary).toMatch(/2h30m/);
  });

  it('truncates very long error lines so the summary stays readable', () => {
    const longLine = 'Error: ' + 'x'.repeat(500);
    const result = summarizeTaskError({
      status: 'failed',
      provider: 'codex',
      exit_code: 1,
      error_output: longLine + '\n[process-exit] code=1 signal=none duration_ms=1000 provider=codex',
    });
    expect(result.summary.length).toBeLessThanOrEqual(280);
    expect(result.summary).toMatch(/…$|\.\.\.$|x{20,}/);
  });
});
