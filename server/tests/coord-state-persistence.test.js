'use strict';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStateStore } = require('../coord/state');

const HOLDER = { host: 'omen', pid: 1234, user: 'kenten' };

describe('coord state persistence', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-state-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists lock state to active.json on every transition', () => {
    const file = path.join(tmpDir, 'active.json');
    const store = createStateStore({ max_concurrent_runs: 2, persist_path: file });
    store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    expect(fs.existsSync(file)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.locks).toHaveLength(1);
    expect(persisted.locks[0].project).toBe('torque-public');
  });

  it('restoreFromFile marks all restored entries as crashed and clears them', () => {
    const file = path.join(tmpDir, 'active.json');
    fs.writeFileSync(file, JSON.stringify({
      locks: [{
        lock_id: 'old',
        project: 'torque-public',
        sha: 'abc',
        suite: 'gate',
        holder: HOLDER,
        created_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        output_buffer: '',
        crashed: false,
      }],
    }));
    const store = createStateStore({ max_concurrent_runs: 2, persist_path: file });
    const reconciled = store.restoreFromFile();
    expect(reconciled.crashed_count).toBe(1);
    expect(store.listActive()).toHaveLength(0);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.locks).toHaveLength(0);
  });

  it('restoreFromFile is a no-op when the file does not exist', () => {
    const file = path.join(tmpDir, 'missing.json');
    const store = createStateStore({ max_concurrent_runs: 2, persist_path: file });
    const reconciled = store.restoreFromFile();
    expect(reconciled.crashed_count).toBe(0);
    expect(store.listActive()).toHaveLength(0);
  });
});
