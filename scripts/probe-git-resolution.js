'use strict';

// Diagnostic: show which git binary Node picks up, compared against shell's.
// Run remotely via torque-remote to compare local-Node vs Git-Bash resolution.

const cp = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

function run(cmd, args, opts = {}) {
  try {
    return {
      stdout: cp.execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim(),
      error: null,
    };
  } catch (err) {
    return { stdout: '', error: err.message };
  }
}

console.log('== PATH ==');
console.log(process.env.PATH || '(empty)');
console.log();

console.log('== where git ==');
console.log(run(process.platform === 'win32' ? 'where.exe' : 'which', ['git']).stdout || '(not found)');

console.log('== git --version (bare execFile) ==');
const ver = run('git', ['--version']);
console.log(ver.stdout || ver.error);

console.log('== git.exe --version (cmd wrapper) ==');
const verCmd = run('C:\\Program Files\\Git\\cmd\\git.exe', ['--version']);
console.log(verCmd.stdout || verCmd.error);

console.log('== git.exe --version (mingw64) ==');
const verMingw = run('C:\\Program Files\\Git\\mingw64\\bin\\git.exe', ['--version']);
console.log(verMingw.stdout || verMingw.error);

// Probe a fresh init
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-init-'));
console.log('\n== tmp dir ==', tmp);

function probeInit(label, gitPath) {
  console.log('\n-- ' + label + ' --');
  const sub = path.join(tmp, label.replace(/\W/g, '_'));
  fs.mkdirSync(sub);
  const out = run(gitPath, ['init', sub]);
  console.log('stdout:', JSON.stringify(out.stdout));
  console.log('error:', out.error || '(none)');
  console.log('listing:', fs.readdirSync(sub));
  console.log('gitExists:', fs.existsSync(path.join(sub, '.git')));
}

probeInit('bare_git', 'git');
probeInit('cmd_git', 'C:\\Program Files\\Git\\cmd\\git.exe');
probeInit('mingw64_git', 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe');

fs.rmSync(tmp, { recursive: true, force: true });
