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

  it('writeResult is a no-op for failed runs', () => {
    store.writeResult({
      project: 'torque-public', sha: 'abc', suite: 'gate',
      exit_code: 1, suite_status: 'fail', output_tail: 'failed',
    });
    const file = path.join(tmpDir, 'torque-public', 'abc', 'gate.json');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('writeResult is a no-op for unsafe path components', () => {
    store.writeResult({
      project: 'torque-public', sha: '../escape', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'ok',
    });
    expect(fs.existsSync(path.join(tmpDir, 'escape', 'gate.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'torque-public'))).toBe(false);
  });

  it('getResult returns the stored record when within TTL', () => {
    store.writeResult({
      project: 'torque-public', sha: 'abc', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'ok',
      package_lock_hashes: { 'server/package-lock.json': 'deadbeef' },
    });
    const hit = store.getResult({ project: 'torque-public', sha: 'abc', suite: 'gate' });
    expect(hit).not.toBeNull();
    expect(hit).toMatchObject({
      project: 'torque-public',
      sha: 'abc',
      suite: 'gate',
      exit_code: 0,
      suite_status: 'pass',
      output_tail: 'ok',
      package_lock_hashes: { 'server/package-lock.json': 'deadbeef' },
    });
    expect(hit.completed_at).toBeDefined();
  });

  it('getResult returns null when the record is older than TTL', () => {
    const shortTtlStore = createResultStore({ results_dir: tmpDir, result_ttl_seconds: 1 });
    shortTtlStore.writeResult({
      project: 'torque-public', sha: 'abc', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'ok',
    });
    // Backdate the on-disk record so it's clearly past TTL.
    const file = path.join(tmpDir, 'torque-public', 'abc', 'gate.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.completed_at = new Date(Date.now() - 10_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(record));
    expect(shortTtlStore.getResult({ project: 'torque-public', sha: 'abc', suite: 'gate' })).toBeNull();
  });

  it('getResult returns null when the record file does not exist', () => {
    expect(store.getResult({ project: 'torque-public', sha: 'never', suite: 'gate' })).toBeNull();
  });

  it('getResult returns null on unparseable record (corrupt file)', () => {
    const dir = path.join(tmpDir, 'torque-public', 'sha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gate.json'), '{ corrupt');
    expect(store.getResult({ project: 'torque-public', sha: 'sha', suite: 'gate' })).toBeNull();
  });
});
