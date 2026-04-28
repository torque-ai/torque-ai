import { describe, it, expect } from 'vitest';

// We test isCommandAllowed indirectly through createToolExecutor, which IS exported.

const { createToolExecutor } = require('../providers/ollama-tools');

describe('ollama-tools command security', () => {
  it('blocks rm -rf / even with specific allowlist containing rm *', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['rm *'],
    });
    const result = executor.execute('run_command', { command: 'rm -rf /' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not in allowlist');
  });

  it('blocks rm -rf / even with wildcard allowlist', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['*'],
    });
    const result = executor.execute('run_command', { command: 'rm -rf /' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not in allowlist');
  });

  it('blocks shell metacharacter semicolon injection', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'npm test; rm -rf /' });
    expect(result.error).toBe(true);
  });

  it('blocks pipe injection', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'npm test | cat /etc/passwd' });
    expect(result.error).toBe(true);
  });

  it('blocks backtick injection', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['echo *'],
    });
    const result = executor.execute('run_command', { command: 'echo `whoami`' });
    expect(result.error).toBe(true);
  });

  it('blocks ampersand injection', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['echo *'],
    });
    const result = executor.execute('run_command', { command: 'echo hello & rm -rf /' });
    expect(result.error).toBe(true);
  });

  it('blocks dollar-sign variable expansion', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['echo *'],
    });
    const result = executor.execute('run_command', { command: 'echo $HOME' });
    expect(result.error).toBe(true);
  });

  it('allows safe commands that match the allowlist', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['node *'],
    });
    const result = executor.execute('run_command', { command: 'node --version' });
    expect(result.error).toBeFalsy();
    expect(result.result).toMatch(/v\d+/);
  });

  it('allows any command in unrestricted mode without allowlist error', () => {
    // In unrestricted mode the allowlist check is skipped entirely.
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'unrestricted',
      commandAllowlist: [],
    });
    const result = executor.execute('run_command', { command: 'echo world' });
    // Should not produce an allowlist error; execution result may vary by OS
    expect(result.result).not.toContain('not in allowlist');
  });

  it('always allows Get-Content even when allowlist excludes it', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'], // explicitly does not include Get-Content
    });
    const result = executor.execute('run_command', { command: 'Get-Content package.json' });
    expect(result.result).not.toContain('not in allowlist');
  });

  it('always allows Get-ChildItem with no flags', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'Get-ChildItem' });
    expect(result.result).not.toContain('not in allowlist');
  });

  it('always allows Select-String pattern over a path', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'Select-String -Pattern foo package.json' });
    expect(result.result).not.toContain('not in allowlist');
  });

  it('always allows Measure-Object', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'Measure-Object' });
    expect(result.result).not.toContain('not in allowlist');
  });

  it('match is case-insensitive (get-content lowercase still allowed)', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'get-content package.json' });
    expect(result.result).not.toContain('not in allowlist');
  });

  it('still blocks dangerous cmdlets (Remove-Item) even though they share Get-* prefix family', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'Remove-Item foo.txt' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not in allowlist');
  });

  it('still blocks Get-Content when piped (shell metachar guard fires)', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['*'],
    });
    const result = executor.execute('run_command', { command: 'Get-Content foo | Set-Content bar' });
    expect(result.error).toBe(true);
  });

  it('always allows ls (Unix-style) when allowlist excludes it', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'ls' });
    expect(result.result).not.toContain('not in allowlist');
  });

  it('always allows gci (PS short alias for Get-ChildItem)', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'gci' });
    expect(result.result).not.toContain('not in allowlist');
  });

  it('rejection of cat suggests read_file', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'cat foo.txt' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('use read_file');
    expect(result._allowlist_rejection).toBe(true);
  });

  it('rejection of head suggests read_file with end_line', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'head -n 20 foo.txt' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('end_line');
    expect(result._allowlist_rejection).toBe(true);
  });

  it('rejection of tail suggests read_file with start_line', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'tail -n 20 foo.txt' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('start_line');
    expect(result._allowlist_rejection).toBe(true);
  });

  it('rejection of find suggests search_files', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'find . -name foo' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('use search_files');
    expect(result._allowlist_rejection).toBe(true);
  });

  it('rejection of grep suggests search_files', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'grep -r foo .' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('use search_files');
    expect(result._allowlist_rejection).toBe(true);
  });

  it('rejection of unknown destructive command sets marker but no specific suggestion', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'somethingweird --flag' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not in allowlist');
    expect(result.result).not.toContain(' — use ');
    expect(result._allowlist_rejection).toBe(true);
  });

  it('rejection marker is set on every allowlist-rejection (rm -rf included)', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'rm -rf node_modules' });
    expect(result.error).toBe(true);
    expect(result._allowlist_rejection).toBe(true);
  });

  it('successful command does not have _allowlist_rejection marker', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['node *'],
    });
    const result = executor.execute('run_command', { command: 'node --version' });
    expect(result._allowlist_rejection).toBeUndefined();
  });
});
