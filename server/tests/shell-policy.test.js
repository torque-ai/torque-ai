const { validateShellCommand, ALLOWED_PREFIXES } = require('../utils/shell-policy');

describe('shell-policy', () => {
  describe('validateShellCommand', () => {
    // --- Allowed commands ---
    it('allows simple npm command', () => {
      expect(validateShellCommand('npm run lint')).toEqual({ ok: true });
    });

    it('allows npx command', () => {
      expect(validateShellCommand('npx vitest run')).toEqual({ ok: true });
    });

    it('allows tsc command', () => {
      expect(validateShellCommand('tsc --noEmit')).toEqual({ ok: true });
    });

    it('allows && chained commands', () => {
      expect(validateShellCommand('npx tsc --noEmit && npx vitest run')).toEqual({ ok: true });
    });

    it('allows triple && chain', () => {
      expect(validateShellCommand('npm run lint && npx tsc --noEmit && npx vitest run')).toEqual({ ok: true });
    });

    it('allows cargo test', () => {
      expect(validateShellCommand('cargo test')).toEqual({ ok: true });
    });

    it('allows dotnet test', () => {
      expect(validateShellCommand('dotnet test')).toEqual({ ok: true });
    });

    it('allows go test', () => {
      expect(validateShellCommand('go test ./...')).toEqual({ ok: true });
    });

    it('allows pytest', () => {
      expect(validateShellCommand('pytest -x')).toEqual({ ok: true });
    });

    it('allows jest', () => {
      expect(validateShellCommand('jest --watchAll=false')).toEqual({ ok: true });
    });

    it('allows node command', () => {
      expect(validateShellCommand('node --check src/index.js')).toEqual({ ok: true });
    });

    // --- Rejected commands ---
    it('rejects semicolon injection', () => {
      const result = validateShellCommand('npm test; rm -rf /');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('metacharacter');
    });

    it('rejects pipe', () => {
      const result = validateShellCommand('npm test | cat');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('metacharacter');
    });

    it('rejects backtick execution', () => {
      const result = validateShellCommand('npm test `whoami`');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('metacharacter');
    });

    it('rejects $() subshell', () => {
      const result = validateShellCommand('npm test $(whoami)');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('metacharacter');
    });

    it('rejects redirect', () => {
      const result = validateShellCommand('npm test > /tmp/out');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('metacharacter');
    });

    it('rejects append redirect', () => {
      const result = validateShellCommand('npm test >> /tmp/out');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('metacharacter');
    });

    it('rejects input redirect', () => {
      const result = validateShellCommand('npm test < /dev/null');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('metacharacter');
    });

    it('rejects unlisted command', () => {
      const result = validateShellCommand('curl http://evil.com');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('not in the allowlist');
    });

    it('rejects rm command', () => {
      const result = validateShellCommand('rm -rf /');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('not in the allowlist');
    });

    it('rejects bash command', () => {
      const result = validateShellCommand('bash -c "rm -rf /"');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('not in the allowlist');
    });

    it('rejects empty segment in &&', () => {
      const result = validateShellCommand('npm test && ');
      expect(result.ok).toBe(false);
    });

    // --- Edge cases ---
    it('rejects null', () => {
      const result = validateShellCommand(null);
      expect(result.ok).toBe(false);
    });

    it('rejects empty string', () => {
      const result = validateShellCommand('');
      expect(result.ok).toBe(false);
    });

    it('rejects very long command', () => {
      const result = validateShellCommand('npm test ' + 'a'.repeat(2100));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('maximum length');
    });

    it('rejects ${} variable expansion', () => {
      const result = validateShellCommand('npm test ${HOME}');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('metacharacter');
    });

    it('exports ALLOWED_PREFIXES array', () => {
      expect(Array.isArray(ALLOWED_PREFIXES)).toBe(true);
      expect(ALLOWED_PREFIXES).toContain('npm');
      expect(ALLOWED_PREFIXES).toContain('npx');
    });
  });
});
