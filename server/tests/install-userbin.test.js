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

describe('install-userbin.sh', () => {
  it('copies repo wrappers into TORQUE_USERBIN_DIR and skips unchanged files on rerun', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-userbin-'));
    try {
      const first = runInstaller(tmpDir);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('[install-userbin] done: 3 installed, 0 skipped, 0 missing');

      for (const name of WRAPPERS) {
        const src = fs.readFileSync(path.join(BIN_DIR, name));
        const dst = fs.readFileSync(path.join(tmpDir, name));
        expect(dst.equals(src)).toBe(true);
      }

      const second = runInstaller(tmpDir);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('[install-userbin] done: 0 installed, 3 skipped, 0 missing');
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
});
