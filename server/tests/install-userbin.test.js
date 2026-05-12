'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'install-userbin.sh');
const BIN_DIR = path.join(REPO_ROOT, 'bin');
const GIT_BASH_PATH = path.join('C:', 'Program Files', 'Git', 'bin', 'bash.exe');
const BASH_EXECUTABLE = process.platform === 'win32' && fs.existsSync(GIT_BASH_PATH)
  ? GIT_BASH_PATH
  : 'bash';

const WRAPPERS = [
  'torque-remote',
  'torque-remote-guard',
  'torque-coord-client',
  'torque-push',
  'torque-push.cmd',
  'torque-push-shim.ps1',
];

function toBashPath(value) {
  if (process.platform !== 'win32') return value;
  return value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

function runInstaller(userBinDir) {
  return childProcess.spawnSync(BASH_EXECUTABLE, [toBashPath(SCRIPT_PATH)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TORQUE_USERBIN_DIR: toBashPath(userBinDir),
    },
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runInstallerWithHome(homeDir) {
  const env = {
    ...process.env,
    HOME: toBashPath(homeDir),
  };
  delete env.TORQUE_USERBIN_DIR;
  delete env.TORQUE_POWERSHELL_USERBIN_DIR;

  return childProcess.spawnSync(BASH_EXECUTABLE, [toBashPath(SCRIPT_PATH)], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runPowerShell(command) {
  return childProcess.spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
}

describe('install-userbin.sh', () => {
  it('copies repo wrappers into TORQUE_USERBIN_DIR and skips unchanged files on rerun', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-userbin-'));
    try {
      const first = runInstaller(tmpDir);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain(`[install-userbin] done: ${WRAPPERS.length} installed, 0 skipped, 0 missing`);

      for (const name of WRAPPERS) {
        const src = fs.readFileSync(path.join(BIN_DIR, name));
        const dst = fs.readFileSync(path.join(tmpDir, name));
        expect(dst.equals(src)).toBe(true);
      }

      if (process.platform === 'win32') {
        const escapedTmpDir = tmpDir.replace(/'/g, "''");
        const discovery = runPowerShell(
          `$env:PATH = '${escapedTmpDir}' + [IO.Path]::PathSeparator + $env:PATH; (Get-Command torque-push).Path`
        );
        expect(discovery.status, discovery.stderr).toBe(0);
        expect(discovery.stdout.trim().toLowerCase()).toBe(path.join(tmpDir, 'torque-push.cmd').toLowerCase());
      }

      const second = runInstaller(tmpDir);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain(`[install-userbin] done: 0 installed, ${WRAPPERS.length} skipped, 0 missing`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips cleanly when TORQUE_USERBIN_DIR does not exist', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-userbin-missing-'));
    const missingDir = path.join(tmpRoot, 'bin');
    try {
      const result = runInstaller(missingDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[install-userbin] skip:');
      expect(result.stdout).toContain('does not exist');
      expect(fs.existsSync(missingDir)).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  const windowsIt = process.platform === 'win32' ? it : it.skip;
  windowsIt('mirrors default installs into the PowerShell-visible local bin', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-userbin-home-'));
    const bashBinDir = path.join(homeDir, 'bin');
    const powershellBinDir = path.join(homeDir, '.local', 'bin');
    fs.mkdirSync(bashBinDir, { recursive: true });
    fs.mkdirSync(powershellBinDir, { recursive: true });

    try {
      const result = runInstallerWithHome(homeDir);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`[install-userbin] done: ${WRAPPERS.length} installed, 0 skipped, 0 missing`);

      for (const name of WRAPPERS) {
        const src = fs.readFileSync(path.join(BIN_DIR, name));
        const bashCopy = fs.readFileSync(path.join(bashBinDir, name));
        const powershellCopy = fs.readFileSync(path.join(powershellBinDir, name));
        expect(bashCopy.equals(src)).toBe(true);
        expect(powershellCopy.equals(src)).toBe(true);
      }

      const escapedPowershellBinDir = powershellBinDir.replace(/'/g, "''");
      const discovery = runPowerShell(
        `$env:PATH = '${escapedPowershellBinDir}' + [IO.Path]::PathSeparator + $env:PATH; (Get-Command torque-push).Path`
      );
      expect(discovery.status, discovery.stderr).toBe(0);
      expect(discovery.stdout.trim().toLowerCase()).toBe(path.join(powershellBinDir, 'torque-push.cmd').toLowerCase());
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
