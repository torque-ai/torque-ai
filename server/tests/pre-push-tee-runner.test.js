'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.resolve(__dirname, '..', '..', 'scripts', 'pre-push-tee-runner.js');

describe('pre-push-tee-runner', () => {
  it('streams, captures, and preserves the child exit code', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-tee-'));
    const output = path.join(dir, 'capture.log');
    const childScript = [
      'process.stdout.write("out-line\\n");',
      'process.stderr.write("err-line\\n");',
      'process.exit(7);',
    ].join('');

    const result = spawnSync(process.execPath, [
      RUNNER,
      '--output',
      output,
      '--',
      process.execPath,
      '-e',
      childScript,
    ], {
      encoding: 'utf8',
      windowsHide: true,
    });

    expect(result.status).toBe(7);
    expect(result.stdout).toContain('out-line');
    expect(result.stderr).toContain('err-line');
    const captured = fs.readFileSync(output, 'utf8');
    expect(captured).toContain('out-line');
    expect(captured).toContain('err-line');
  });

  it('returns 127 when the child cannot be spawned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-tee-missing-'));
    const output = path.join(dir, 'capture.log');

    const result = spawnSync(process.execPath, [
      RUNNER,
      '--output',
      output,
      '--',
      path.join(dir, 'missing-binary'),
    ], {
      encoding: 'utf8',
      windowsHide: true,
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain('spawn error');
    expect(fs.readFileSync(output, 'utf8')).toContain('spawn error');
  });
});
