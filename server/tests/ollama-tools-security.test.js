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
});
