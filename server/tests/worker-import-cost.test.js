'use strict';

const childProcess = require('child_process');
const path = require('path');

const WORKER_SETUP_PATH = require.resolve('./worker-setup');
const TOOLS_PATH = require.resolve('../../server/tools.js');

function runNodeScript(source) {
  return childProcess.execFileSync(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    windowsHide: true,
  });
}

describe('worker setup import cost', () => {
  it('does not load the tool catalog when the worker setup layer loads', () => {
    const script = `
      const workerSetupPath = ${JSON.stringify(WORKER_SETUP_PATH)};
      const toolsPath = require.resolve('../../server/tools.js', { paths: [${JSON.stringify(__dirname)}] });
      require(workerSetupPath);
      if (Object.prototype.hasOwnProperty.call(require.cache, toolsPath)) {
        throw new Error('server/tools.js was loaded by worker setup');
      }
      process.stdout.write('ok');
    `;

    expect(runNodeScript(script)).toBe('ok');
    expect(Object.prototype.hasOwnProperty.call(require.cache, TOOLS_PATH)).toBe(false);
  });
});
