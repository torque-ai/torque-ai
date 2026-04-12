'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { setupTestDb, teardownTestDb, getText } = require('./vitest-setup');
const dataDir = require('../data-dir');
const { handleConfigureArtifactStorage } = require('../handlers/advanced/artifacts');

describe('handleConfigureArtifactStorage storage_path boundary', () => {
  let tempDataDir;

  beforeEach(() => {
    setupTestDb('artifact-storage-path');
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-artifact-test-'));
    dataDir.setDataDir(tempDataDir);
  });

  afterEach(() => {
    dataDir.setDataDir(null);
    if (tempDataDir) fs.rmSync(tempDataDir, { recursive: true, force: true });
    teardownTestDb();
  });

  it('accepts a relative path that resolves inside the data dir', () => {
    const result = handleConfigureArtifactStorage({ storage_path: 'my-artifacts' });
    const expectedPath = path.join(tempDataDir, 'my-artifacts');

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain(expectedPath);
  });

  it('rejects an absolute path outside the data dir', () => {
    const outside = process.platform === 'win32' ? 'C:/Windows/System32' : '/etc/passwd';
    const result = handleConfigureArtifactStorage({ storage_path: outside });

    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/must resolve within/i);
  });

  it('rejects a ../ escape attempt', () => {
    const result = handleConfigureArtifactStorage({ storage_path: '../../escape' });

    expect(result.isError).toBe(true);
  });

  it('rejects a sibling-prefix bypass', () => {
    const parent = path.dirname(tempDataDir);
    const siblingName = path.basename(tempDataDir) + '-evil';
    const bypass = path.join(parent, siblingName, 'x');
    const result = handleConfigureArtifactStorage({ storage_path: bypass });

    expect(result.isError).toBe(true);
  });
});
