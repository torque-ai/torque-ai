import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig, DEFAULTS } = require('../coord/config');

describe('coord config', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', () => {
    const config = loadConfig(path.join(tmpDir, 'missing.json'));
    expect(config).toEqual(DEFAULTS);
  });

  it('overrides defaults with values from JSON file', () => {
    const file = path.join(tmpDir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({
      max_concurrent_runs: 4,
      result_ttl_seconds: 7200,
    }));
    const config = loadConfig(file);
    expect(config.max_concurrent_runs).toBe(4);
    expect(config.result_ttl_seconds).toBe(7200);
    expect(config.heartbeat_interval_ms).toBe(DEFAULTS.heartbeat_interval_ms);
    expect(config.shareable_suites).toEqual(DEFAULTS.shareable_suites);
  });

  it('rejects malformed JSON by returning defaults plus a warning flag', () => {
    const file = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(file, '{ not json');
    const config = loadConfig(file);
    expect(config).toMatchObject(DEFAULTS);
    expect(config.__load_error).toBeDefined();
  });
});
