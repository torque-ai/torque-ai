'use strict';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createResultStore } = require('../coord/result-store');

describe('coord result store (Phase 1 write-only stub)', () => {
  let tmpDir, store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-results-'));
    store = createResultStore({ results_dir: tmpDir, result_ttl_seconds: 3600 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeResult creates a JSON file at <project>/<sha>/<suite>.json', () => {
    store.writeResult({
      project: 'torque-public',
      sha: 'abc123',
      suite: 'gate',
      exit_code: 0,
      suite_status: 'pass',
      output_tail: 'all green',
      package_lock_hashes: { 'server/package-lock.json': 'deadbeef' },
    });
    const file = path.join(tmpDir, 'torque-public', 'abc123', 'gate.json');
    expect(fs.existsSync(file)).toBe(true);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(record).toMatchObject({
      project: 'torque-public',
      sha: 'abc123',
      suite: 'gate',
      exit_code: 0,
      suite_status: 'pass',
      output_tail: 'all green',
    });
    expect(record.completed_at).toBeDefined();
  });

  it('writeResult is a no-op for crashed runs', () => {
    store.writeResult({
      project: 'torque-public', sha: 'abc', suite: 'gate',
      exit_code: -1, suite_status: 'crashed', crashed: true,
    });
    const file = path.join(tmpDir, 'torque-public', 'abc', 'gate.json');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('getResult always returns null in Phase 1 (stub)', () => {
    store.writeResult({
      project: 'torque-public', sha: 'abc', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'ok',
    });
    expect(store.getResult({ project: 'torque-public', sha: 'abc', suite: 'gate' })).toBeNull();
  });
});
