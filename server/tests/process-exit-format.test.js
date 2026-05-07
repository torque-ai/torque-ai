'use strict';

const {
  PROCESS_EXIT_PREFIX,
  formatProcessExitLine,
  parseProcessExitLine,
  findLastProcessExitAnnotation,
} = require('../utils/process-exit-format');

describe('process-exit-format', () => {
  describe('formatProcessExitLine', () => {
    it('emits a line starting with the canonical prefix', () => {
      const line = formatProcessExitLine({ code: 0, signal: null, durationMs: 1234, provider: 'codex' });
      expect(line.startsWith(PROCESS_EXIT_PREFIX)).toBe(true);
    });

    it('represents null exit code as the literal "null"', () => {
      const line = formatProcessExitLine({ code: null, signal: 'SIGTERM', durationMs: 0, provider: 'codex' });
      expect(line).toContain('code=null');
      expect(line).toContain('signal=SIGTERM');
    });

    it('represents missing signal as the literal "none"', () => {
      const line = formatProcessExitLine({ code: 0, signal: null, durationMs: 0, provider: 'codex' });
      expect(line).toContain('signal=none');
    });

    it('omits the model field when not provided', () => {
      const line = formatProcessExitLine({ code: 0, signal: null, durationMs: 0, provider: 'codex' });
      expect(line).not.toContain('model=');
    });

    it('includes the model field when provided', () => {
      const line = formatProcessExitLine({ code: 0, signal: null, durationMs: 0, provider: 'codex', model: 'gpt-5.3' });
      expect(line).toContain('model=gpt-5.3');
    });

    it('coerces non-number durations to 0', () => {
      const line = formatProcessExitLine({ code: 0, signal: null, durationMs: 'oops', provider: 'codex' });
      expect(line).toContain('duration_ms=0');
    });

    it('uses "unknown" when provider is missing', () => {
      const line = formatProcessExitLine({ code: 0, signal: null, durationMs: 0 });
      expect(line).toContain('provider=unknown');
    });
  });

  describe('parseProcessExitLine', () => {
    it('parses a fully-populated line', () => {
      const line = '[process-exit] code=0 signal=none duration_ms=12345 provider=codex model=gpt-5.3';
      expect(parseProcessExitLine(line)).toEqual({
        code: 0,
        signal: null,
        duration_ms: 12345,
        provider: 'codex',
        model: 'gpt-5.3',
      });
    });

    it('parses code=null as null', () => {
      const r = parseProcessExitLine('[process-exit] code=null signal=SIGTERM duration_ms=42 provider=codex');
      expect(r.code).toBeNull();
      expect(r.signal).toBe('SIGTERM');
    });

    it('returns null for non-matching lines', () => {
      expect(parseProcessExitLine('Some other log line')).toBeNull();
      expect(parseProcessExitLine('')).toBeNull();
      expect(parseProcessExitLine(null)).toBeNull();
      expect(parseProcessExitLine(undefined)).toBeNull();
    });

    it('returns null for malformed prefix', () => {
      expect(parseProcessExitLine('[process-exit] ')).toBeNull(); // empty body fails (.+) match
    });

    it('treats missing model field as null', () => {
      const r = parseProcessExitLine('[process-exit] code=0 signal=none duration_ms=0 provider=codex');
      expect(r.model).toBeNull();
    });
  });

  describe('round-trip writer ↔ reader', () => {
    // The whole point of pinning both ends to this module: any future
    // contributor who edits formatProcessExitLine without updating
    // parseProcessExitLine (or vice versa) will break this test.
    it.each([
      { code: 0, signal: null, durationMs: 1234, provider: 'codex' },
      { code: 1, signal: null, durationMs: 999, provider: 'codex-spark', model: 'gpt-5.3' },
      { code: null, signal: 'SIGTERM', durationMs: 30000, provider: 'claude-cli', model: 'claude-sonnet-4-6' },
      { code: 137, signal: 'SIGKILL', durationMs: 5000, provider: 'codex' },
    ])('round-trips %j', (input) => {
      const line = formatProcessExitLine(input);
      const parsed = parseProcessExitLine(line);
      expect(parsed.code).toBe(input.code);
      expect(parsed.signal).toBe(input.signal); // null stays null
      expect(parsed.duration_ms).toBe(input.durationMs);
      expect(parsed.provider).toBe(input.provider);
      expect(parsed.model).toBe(input.model || null);
    });
  });

  describe('findLastProcessExitAnnotation', () => {
    it('finds the annotation at the end of a multi-line buffer', () => {
      const buf = [
        '+ ----------------- prompt -----------------',
        'some output line',
        'another line',
        '[process-exit] code=0 signal=none duration_ms=500 provider=codex',
        '',
      ].join('\n');
      const r = findLastProcessExitAnnotation(buf);
      expect(r.code).toBe(0);
      expect(r.duration_ms).toBe(500);
    });

    it('returns the LAST annotation when multiple are present', () => {
      // Pathological case (shouldn't happen in practice — wrapper writes
      // exactly one — but the LAST wins for safety).
      const buf = [
        '[process-exit] code=1 signal=none duration_ms=100 provider=codex',
        'restart noise',
        '[process-exit] code=0 signal=none duration_ms=200 provider=codex',
      ].join('\n');
      expect(findLastProcessExitAnnotation(buf).code).toBe(0);
      expect(findLastProcessExitAnnotation(buf).duration_ms).toBe(200);
    });

    it('returns null when no annotation present', () => {
      expect(findLastProcessExitAnnotation('some unrelated stderr')).toBeNull();
      expect(findLastProcessExitAnnotation('')).toBeNull();
      expect(findLastProcessExitAnnotation(null)).toBeNull();
    });
  });
});
