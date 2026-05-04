'use strict';

const path = require('path');
const fs = require('fs');
const { setupTestDbModule, teardownTestDb, resetTables } = require('./vitest-setup');

const {
  FILE_SIZE_TRUNCATION_THRESHOLD,
  FILE_SIZE_SHRINK_THRESHOLD,
} = require('../constants');

let mod, testDir;

describe('file size threshold constants and compare behavior', () => {
  beforeAll(() => {
    ({ mod, testDir } = setupTestDbModule('../db/file/baselines', 'p2-file-thresholds'));
  });

  afterAll(() => teardownTestDb());

  beforeEach(() => {
    resetTables(['file_baselines']);
  });

  it('exports expected file size threshold constants', () => {
    expect(FILE_SIZE_TRUNCATION_THRESHOLD).toBe(-50);
    expect(FILE_SIZE_SHRINK_THRESHOLD).toBe(-25);
  });

  it('flags a -60% size change as truncated', () => {
    const filePath = 'shrink-truncated.js';
    fs.writeFileSync(path.join(testDir, filePath), 'x'.repeat(100), 'utf8');
    mod.captureFileBaseline(filePath, testDir);
    fs.writeFileSync(path.join(testDir, filePath), 'x'.repeat(40), 'utf8');

    const result = mod.compareFileToBaseline(filePath, testDir);

    expect(result.isTruncated).toBe(true);
    expect(result.isSignificantlyShrunk).toBe(true);
    expect(result.sizeChangePercent).toBe(-60);
  });

  it('flags a -30% size change as significant shrink but not truncated', () => {
    const filePath = 'shrink-significant.js';
    fs.writeFileSync(path.join(testDir, filePath), 'x'.repeat(100), 'utf8');
    mod.captureFileBaseline(filePath, testDir);
    fs.writeFileSync(path.join(testDir, filePath), 'x'.repeat(70), 'utf8');

    const result = mod.compareFileToBaseline(filePath, testDir);

    expect(result.isTruncated).toBe(false);
    expect(result.isSignificantlyShrunk).toBe(true);
    expect(result.sizeChangePercent).toBe(-30);
  });

  it('does not flag a -10% size change as significant shrink', () => {
    const filePath = 'shrink-small.js';
    fs.writeFileSync(path.join(testDir, filePath), 'x'.repeat(100), 'utf8');
    mod.captureFileBaseline(filePath, testDir);
    fs.writeFileSync(path.join(testDir, filePath), 'x'.repeat(90), 'utf8');

    const result = mod.compareFileToBaseline(filePath, testDir);

    expect(result.isTruncated).toBe(false);
    expect(result.isSignificantlyShrunk).toBe(false);
    expect(result.sizeChangePercent).toBe(-10);
  });
});
