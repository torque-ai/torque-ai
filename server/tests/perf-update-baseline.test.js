'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('node:child_process');

const PERF_RUNNER = path.resolve(__dirname, '..', 'perf', 'run-perf.js');

describe('perf --update-baseline', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ub-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes baseline.json from last-run.json when --update-baseline is passed', () => {
    fs.writeFileSync(path.join(tmpHome, 'last-run.json'), JSON.stringify({
      captured_at: '2026-04-25T00:00:00Z',
      env: { host_label: 'test' },
      metrics: { foo: { median: 50 } }
    }));
    const result = cp.spawnSync(process.execPath, [PERF_RUNNER, '--update-baseline'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PERF_OUT_DIR: tmpHome, PERF_SMOKE: '1' },
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    const baseline = JSON.parse(fs.readFileSync(path.join(tmpHome, 'baseline.json'), 'utf8'));
    expect(baseline.metrics.foo.median).toBe(50);
    expect(baseline.metrics.foo.last_updated_at).toBeDefined();
    expect(baseline.last_updated_at).toBeDefined();
  });

  it('exits non-zero when last-run.json is missing', () => {
    const result = cp.spawnSync(process.execPath, [PERF_RUNNER, '--update-baseline'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PERF_OUT_DIR: tmpHome },
      encoding: 'utf8'
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('last-run.json not found');
  });
});
