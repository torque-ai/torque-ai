import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcess = require('child_process');
const {
  validateCommand,
  executeValidatedCommand,
  executeValidatedCommandSync,
} = require('../execution/command-policy');

describe('command-policy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('validateCommand', () => {
    it('allows allowlisted commands in safe_verify', () => {
      expect(validateCommand('npx', ['tsc', '--noEmit'])).toEqual({ allowed: true });
      expect(validateCommand('npx vitest run')).toEqual({ allowed: true });
      expect(validateCommand('npm test')).toEqual({ allowed: true });
      expect(validateCommand('pytest', ['tests/', '-q'])).toEqual({ allowed: true });
      expect(validateCommand('python', ['-m', 'pytest', 'tests/', '-q'])).toEqual({ allowed: true });
      expect(validateCommand('py', ['-3.12', '-m', 'pytest', 'tests/', '-q'])).toEqual({ allowed: true });
      expect(validateCommand('node --check src/index.js')).toEqual({ allowed: true });
      expect(validateCommand('git diff --stat HEAD~1')).toEqual({ allowed: true });
      expect(validateCommand('git', ['status', '--short'])).toEqual({ allowed: true });
      expect(validateCommand('git', ['log', '--oneline', '-5'])).toEqual({ allowed: true });
    });

    it('blocks dangerous advanced_shell commands without the explicit flag', () => {
      const result = validateCommand('git', ['commit', '-m', 'test commit'], 'advanced_shell');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('dangerous: true');
    });

    it('rejects shell metacharacters in safe profiles', () => {
      const chained = validateCommand('git diff && git status');
      expect(chained.allowed).toBe(false);
      expect(chained.reason).toContain('metacharacter');

      const piped = validateCommand('npm', ['test', '|', 'cat']);
      expect(piped.allowed).toBe(false);
      expect(piped.reason).toContain('metacharacter');

      const subshell = validateCommand('node', ['--check', '$(whoami)']);
      expect(subshell.allowed).toBe(false);
      expect(subshell.reason).toContain('metacharacter');
    });

    it('allows cmd wrappers only when each chained command is allowlisted', () => {
      expect(validateCommand('cmd', ['/c', 'dotnet test App.Tests.csproj && dotnet test Integration.Tests.csproj']))
        .toEqual({ allowed: true });
      expect(validateCommand('cmd.exe', ['/d', '/s', '/c', 'dotnet test App.Tests.csproj && git status --short']))
        .toEqual({ allowed: true });
      expect(validateCommand('cmd', ['/c', 'py -3.12 -m pytest tests/ -q']))
        .toEqual({ allowed: true });

      const unsafeShell = validateCommand('cmd', ['/c', 'dotnet test App.Tests.csproj || git status --short']);
      expect(unsafeShell.allowed).toBe(false);
      expect(unsafeShell.reason).toContain('metacharacter');

      const unsafeCommand = validateCommand('cmd', ['/c', 'del important.db']);
      expect(unsafeCommand.allowed).toBe(false);
      expect(unsafeCommand.reason).toContain("Command 'del important.db' is not allowed");

      const unsafePython = validateCommand('cmd', ['/c', 'py -3.12 -c "import os"']);
      expect(unsafePython.allowed).toBe(false);
      expect(unsafePython.reason).toContain("Command 'py -3.12 -c import os' is not allowed");

      const nestedShell = validateCommand('cmd', ['/c', 'cmd /c dotnet test App.Tests.csproj']);
      expect(nestedShell.allowed).toBe(false);
      expect(nestedShell.reason).toContain('Nested shell wrappers');
    });

    it('allows advanced_shell commands when dangerous is true', () => {
      const result = validateCommand(
        'git',
        {
          args: ['commit', '-m', 'feat: test; safe because execFile is used'],
          dangerous: true,
          source: 'command-policy.test',
          caller: 'validateCommand',
        },
        'advanced_shell'
      );

      expect(result).toEqual({ allowed: true });
    });
  });

  describe('executeValidatedCommand', () => {
    it('executes allowed commands via execFile', async () => {
      const execSpy = vi.spyOn(childProcess, 'execFile').mockImplementation((cmd, args, options, callback) => {
        callback(null, 'ok', '');
      });

      const result = await executeValidatedCommand('git', ['status', '--short'], {
        profile: 'safe_verify',
        source: 'command-policy.test',
        caller: 'executeValidatedCommand',
        encoding: 'utf8',
      });

      expect(result.stdout).toBe('ok');
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['status', '--short'],
        expect.objectContaining({
          encoding: 'utf8',
          windowsHide: true,
        }),
        expect.any(Function)
      );
    });

    it('rejects blocked commands before execFile runs', async () => {
      const execSpy = vi.spyOn(childProcess, 'execFile');

      await expect(
        executeValidatedCommand('git status && git log', [], {
          profile: 'safe_verify',
          source: 'command-policy.test',
          caller: 'executeValidatedCommand',
        })
      ).rejects.toMatchObject({
        code: 'COMMAND_POLICY_REJECTED',
      });

      expect(execSpy).not.toHaveBeenCalled();
    });

    it('allows advanced_shell execution with dangerous flag', async () => {
      vi.spyOn(childProcess, 'execFile').mockImplementation((cmd, args, options, callback) => {
        callback(null, 'advanced-ok', '');
      });

      const result = await executeValidatedCommand('git', ['commit', '-m', 'feat: test'], {
        profile: 'advanced_shell',
        dangerous: true,
        source: 'command-policy.test',
        caller: 'executeValidatedCommand',
        encoding: 'utf8',
      });

      expect(result.stdout).toBe('advanced-ok');
    });
  });

  describe('executeValidatedCommandSync', () => {
    it('executes allowlisted cmd chains through execFileSync', () => {
      const execSpy = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('ok');

      const result = executeValidatedCommandSync('cmd', ['/c', 'dotnet test App.Tests.csproj && dotnet test Integration.Tests.csproj'], {
        profile: 'safe_verify',
        source: 'command-policy.test',
        caller: 'executeValidatedCommandSync',
        encoding: 'utf8',
      });

      expect(result).toBe('ok');
      expect(execSpy).toHaveBeenCalledWith(
        'cmd',
        ['/c', 'dotnet test App.Tests.csproj && dotnet test Integration.Tests.csproj'],
        expect.objectContaining({
          encoding: 'utf8',
          windowsHide: true,
        })
      );
    });
  });
});
