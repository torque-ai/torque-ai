import { describe, it } from 'vitest';

const cp = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

describe('probe: git init inside vitest', () => {
  it('captures full output + listing + env info', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-vitest-git-'));

    // Inspect env
    // eslint-disable-next-line no-console
    console.error('[probe] cwd =', process.cwd());
    // eslint-disable-next-line no-console
    console.error('[probe] TORQUE_DATA_DIR =', process.env.TORQUE_DATA_DIR);
    const gitEnv = Object.entries(process.env).filter(([k]) => k.startsWith('GIT_'));
    // eslint-disable-next-line no-console
    console.error('[probe] GIT_* env =', gitEnv);
    // eslint-disable-next-line no-console
    console.error('[probe] HOME =', process.env.HOME);
    // eslint-disable-next-line no-console
    console.error('[probe] USERPROFILE =', process.env.USERPROFILE);

    // Try via PATH
    try {
      const out = cp.spawnSync('git', ['init', tmp], { encoding: 'utf8' });
      // eslint-disable-next-line no-console
      console.error('[probe] bare spawn stdout:', JSON.stringify(out.stdout));
      // eslint-disable-next-line no-console
      console.error('[probe] bare spawn stderr:', JSON.stringify(out.stderr));
      // eslint-disable-next-line no-console
      console.error('[probe] bare spawn status:', out.status);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[probe] bare spawn err:', err.message);
    }
    // eslint-disable-next-line no-console
    console.error('[probe] post-bare listing:', fs.readdirSync(tmp));

    // Try absolute mingw64 path
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-vitest-git2-'));
    try {
      const out2 = cp.spawnSync('C:\\Program Files\\Git\\mingw64\\bin\\git.exe', ['init', tmp2], { encoding: 'utf8' });
      // eslint-disable-next-line no-console
      console.error('[probe] mingw64 stdout:', JSON.stringify(out2.stdout));
      // eslint-disable-next-line no-console
      console.error('[probe] mingw64 stderr:', JSON.stringify(out2.stderr));
      // eslint-disable-next-line no-console
      console.error('[probe] mingw64 status:', out2.status);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[probe] mingw64 err:', err.message);
    }
    // eslint-disable-next-line no-console
    console.error('[probe] post-mingw64 listing:', fs.readdirSync(tmp2));

    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  });
});
