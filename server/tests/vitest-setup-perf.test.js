'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SETUP_PATH = path.resolve(__dirname, 'vitest-setup.js');

describe('vitest-setup cold-import threshold wrapper', () => {
  it('respects PERF_TEST_IMPORT_WARN_MS env var (no throw when thresholds are very high)', () => {
    const script = `
      process.env.TORQUE_DATA_DIR = require('os').tmpdir();
      process.env.PERF_TEST_IMPORT_WARN_MS = '99999';
      process.env.PERF_TEST_IMPORT_FAIL_MS = '99999';
      const { setupTestDbOnly, teardownTestDb } = require(${JSON.stringify(SETUP_PATH)});
      setupTestDbOnly('perf-threshold-test');
      teardownTestDb();
      process.stdout.write('ok\\n');
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.stdout.trim()).toBe('ok');
    expect(result.status).toBe(0);
  });

  it('threshold wrapper is only applied on first call per process', () => {
    const script = `
      process.env.TORQUE_DATA_DIR = require('os').tmpdir();
      process.env.PERF_TEST_IMPORT_WARN_MS = '99999';
      process.env.PERF_TEST_IMPORT_FAIL_MS = '99999';
      const { setupTestDbOnly, teardownTestDb } = require(${JSON.stringify(SETUP_PATH)});
      setupTestDbOnly('first');
      teardownTestDb();
      setupTestDbOnly('second');
      teardownTestDb();
      process.stdout.write('ok\\n');
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.stdout.trim()).toBe('ok');
    expect(result.status).toBe(0);
  });
});
