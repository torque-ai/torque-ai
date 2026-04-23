'use strict';

const {
  buildWindowsPowerShellModulePath,
  isPowerShellCoreModulePath,
  isWindowsPowerShellCommand,
  resolveWindowsPowerShellEnv,
} = require('../utils/windows-powershell-env');

describe('windows-powershell-env', () => {
  const mixedPowerShellEnv = {
    Path: 'C:\\bin',
    PSModulePath: [
      'C:\\Users\\TestUser\\OneDrive\\Documents\\PowerShell\\Modules',
      'C:\\Program Files\\PowerShell\\Modules',
      'c:\\program files\\powershell\\7\\Modules',
      'C:\\Custom\\Modules',
      'C:\\Users\\TestUser\\OneDrive\\Documents\\WindowsPowerShell\\Modules',
      'C:\\Program Files\\WindowsPowerShell\\Modules',
      'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules',
    ].join(';'),
    ProgramFiles: 'C:\\Program Files',
    SystemRoot: 'C:\\WINDOWS',
    USERPROFILE: 'C:\\Users\\TestUser',
  };

  it('detects Windows PowerShell commands without matching pwsh', () => {
    expect(isWindowsPowerShellCommand('powershell -NoProfile -File Tools\\Invoke-AllChecks.ps1')).toBe(true);
    expect(isWindowsPowerShellCommand('cmd /d /c C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile')).toBe(true);
    expect(isWindowsPowerShellCommand('pwsh -NoProfile -File Tools\\Invoke-AllChecks.ps1')).toBe(false);
    expect(isWindowsPowerShellCommand('npm test')).toBe(false);
  });

  it('classifies PowerShell Core module paths separately from Windows PowerShell paths', () => {
    expect(isPowerShellCoreModulePath('C:\\Program Files\\PowerShell\\7\\Modules')).toBe(true);
    expect(isPowerShellCoreModulePath('C:\\Users\\TestUser\\Documents\\PowerShell\\Modules')).toBe(true);
    expect(isPowerShellCoreModulePath('C:\\Program Files\\WindowsPowerShell\\Modules')).toBe(false);
  });

  it('removes PowerShell Core module paths and keeps Windows PowerShell paths', () => {
    const modulePath = buildWindowsPowerShellModulePath(mixedPowerShellEnv);
    const entries = modulePath.split(';');

    expect(entries).not.toContain('C:\\Users\\TestUser\\OneDrive\\Documents\\PowerShell\\Modules');
    expect(entries).not.toContain('C:\\Program Files\\PowerShell\\Modules');
    expect(entries).not.toContain('c:\\program files\\powershell\\7\\Modules');
    expect(entries).toContain('C:\\Custom\\Modules');
    expect(entries).toContain('C:\\Users\\TestUser\\OneDrive\\Documents\\WindowsPowerShell\\Modules');
    expect(entries).toContain('C:\\Program Files\\WindowsPowerShell\\Modules');
    expect(entries).toContain('C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules');
    expect(entries).toContain('C:\\Users\\TestUser\\Documents\\WindowsPowerShell\\Modules');
  });

  it('returns a sanitized env only for Windows PowerShell commands on Windows', () => {
    const env = resolveWindowsPowerShellEnv(
      'powershell -NoProfile -File Tools\\Invoke-AllChecks.ps1',
      mixedPowerShellEnv,
      { platform: 'win32' }
    );

    expect(env).not.toBeUndefined();
    expect(env.Path).toBe('C:\\bin');
    expect(env.PSModulePath).toContain('WindowsPowerShell');
    expect(env.PSModulePath).not.toMatch(/\\PowerShell\\7\\Modules/i);
    expect(resolveWindowsPowerShellEnv('pwsh -NoProfile -File test.ps1', mixedPowerShellEnv, { platform: 'win32' })).toBeUndefined();
    expect(resolveWindowsPowerShellEnv('powershell -NoProfile -File test.ps1', mixedPowerShellEnv, { platform: 'linux' })).toBeUndefined();
  });
});
