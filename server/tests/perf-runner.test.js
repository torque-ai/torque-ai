const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('node:child_process');

const PERF_RUNNER = path.resolve(__dirname, '..', 'perf', 'run-perf.js');

describe('perf runner skeleton', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-runner-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('exits 0 with --metrics-list', () => {
    const result = cp.spawnSync(process.execPath, [PERF_RUNNER, '--metrics-list'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PERF_OUT_DIR: tmpHome },
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No metrics registered yet');
  });

  it('writes last-run.json under PERF_OUT_DIR after a smoke run', () => {
    const result = cp.spawnSync(process.execPath, [PERF_RUNNER], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PERF_OUT_DIR: tmpHome, PERF_SMOKE: '1' },
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    const lastRun = path.join(tmpHome, 'last-run.json');
    expect(fs.existsSync(lastRun)).toBe(true);
    const data = JSON.parse(fs.readFileSync(lastRun, 'utf8'));
    expect(data).toHaveProperty('metrics');
    expect(data).toHaveProperty('captured_at');
    expect(data).toHaveProperty('env');
  });
});
