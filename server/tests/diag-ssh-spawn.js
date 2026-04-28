// Diagnostic: test whether spawn('ssh') uses the process's own PATH
// when no explicit env is passed to spawn.
// Run: node diag-ssh-spawn.js
'use strict';
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsh-diag-'));
const argvFile = path.join(dir, 'argv.json');
const nodeScript = path.join(dir, 'ssh');
const cmdWrapper = path.join(dir, 'ssh.cmd');

// Write the shebang script
fs.writeFileSync(nodeScript, [
  '#!/usr/bin/env node',
  `const fs = require('fs');`,
  `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
  `process.stdout.write('FAKE_CALLED\\n');`,
  `process.exit(0);`,
].join('\n'));
fs.chmodSync(nodeScript, 0o755);

// Write the .cmd wrapper
fs.writeFileSync(cmdWrapper, `@"${process.execPath}" "${nodeScript}" %*\r\n`);

// Write helper that inherits PATH and spawns ssh without explicit env
const helperScript = path.join(dir, 'helper.js');
fs.writeFileSync(helperScript, `
'use strict';
const {spawn} = require('child_process');
// No explicit env — inherits from THIS process (which has fakeSshDir in PATH)
const p = spawn('ssh', ['test-arg'], {windowsHide: true});
let out = '', err = '';
p.stdout.on('data', d => { out += d.toString(); });
p.stderr.on('data', d => { err += d.toString(); });
p.on('error', e => { process.stdout.write('SPAWN_ERROR:' + e.message + '\\n'); });
p.on('close', c => {
  process.stdout.write('exit=' + c + '\\n');
  process.stdout.write('stdout=' + out.slice(0, 200) + '\\n');
  process.stdout.write('stderr=' + err.slice(0, 200) + '\\n');
});
`);

// Run helper with modified PATH
const result = spawnSync(process.execPath, [helperScript], {
  encoding: 'utf8',
  env: { ...process.env, PATH: dir + path.delimiter + (process.env.PATH || '') },
  timeout: 8000,
});

console.log('helper stdout:', result.stdout);
console.log('helper stderr:', result.stderr.slice(0, 200));
console.log('argv_file_exists:', fs.existsSync(argvFile));
if (fs.existsSync(argvFile)) {
  console.log('argv_content:', fs.readFileSync(argvFile, 'utf8'));
}
console.log('dir:', dir);
fs.rmSync(dir, { recursive: true, force: true });
