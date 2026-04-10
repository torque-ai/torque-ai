'use strict';

const path = require('path');
const { scoreDimension, scoreAll, DIMENSIONS } = require('../factory/scorer-registry');

// Mock scan_project report matching REAL output shape from handleScanProject
const MOCK_SCAN_REPORT = {
  summary: {
    totalFiles: 200,
    byDirectory: { src: 80, tests: 40, docs: 10 },
    byExtension: { '.js': 100, '.jsx': 30, '.md': 15 },
  },
  missingTests: {
    covered: 60,
    missing: 20,
    total: 80,
    coveragePercent: 75,
    missingFiles: [
      { file: 'src/api/users.js', lines: 300 },
      { file: 'src/api/admin.js', lines: 150 },
    ],
  },
  todos: {
    count: 12,
    items: [
      { file: 'src/api/users.js', line: 42, type: 'TODO', text: '// TODO: add validation' },
      { file: 'src/utils/cache.js', line: 10, type: 'HACK', text: '// HACK: workaround for race' },
      { file: 'src/utils/cache.js', line: 20, type: 'FIXME', text: '// FIXME: memory leak' },
    ],
  },
  fileSizes: {
    totalCodeFiles: 130,
    totalBytes: 500000,
    totalLines: 15000,
    largest: [
      { file: 'src/database.js', bytes: 30000, lines: 800 },
      { file: 'src/api-server.js', bytes: 25000, lines: 650 },
      { file: 'src/task-manager.js', bytes: 20000, lines: 500 },
    ],
    smallest: [
      { file: 'src/constants.js', bytes: 100, lines: 5 },
    ],
  },
  dependencies: {
    name: 'test-app',
    version: '1.0.0',
    scripts: { test: 'vitest run', build: 'vite build' },
    dependencies: ['express', 'better-sqlite3', 'uuid'],
    devDependencies: ['vitest', 'vite'],
  },
};

describe('scorer-registry', () => {
  test('DIMENSIONS contains all 10', () => {
    expect(DIMENSIONS).toHaveLength(10);
    expect(DIMENSIONS).toContain('structural');
    expect(DIMENSIONS).toContain('test_coverage');
    expect(DIMENSIONS).toContain('security');
  });

  test('scoreDimension returns 0-100 for each dimension with mock data', () => {
    for (const dim of DIMENSIONS) {
      const result = scoreDimension(dim, '/fake/path', MOCK_SCAN_REPORT, null);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.details).toBeDefined();
    }
  });

  test('scoreDimension handles empty scan report gracefully', () => {
    for (const dim of DIMENSIONS) {
      const result = scoreDimension(dim, '/fake/path', {}, null);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  test('scoreAll returns results for all dimensions', () => {
    const results = scoreAll('/fake/path', MOCK_SCAN_REPORT, null);
    expect(Object.keys(results)).toHaveLength(10);
  });

  test('scoreAll accepts dimension filter', () => {
    const results = scoreAll('/fake/path', MOCK_SCAN_REPORT, null, ['test_coverage', 'debt_ratio']);
    expect(Object.keys(results)).toHaveLength(2);
  });
});

describe('individual scorers with real scan_project field names', () => {
  test('test_coverage uses missingTests.coveragePercent', () => {
    const result = scoreDimension('test_coverage', '/fake', MOCK_SCAN_REPORT, null);
    expect(result.score).toBe(75);
    expect(result.details.covered).toBe(60);
    expect(result.details.missing).toBe(20);
  });

  test('test_coverage returns 50 when no data', () => {
    const result = scoreDimension('test_coverage', '/fake', {}, null);
    expect(result.score).toBe(50);
  });

  test('structural uses fileSizes.largest', () => {
    const result = scoreDimension('structural', '/fake', MOCK_SCAN_REPORT, null);
    expect(result.score).toBeGreaterThan(30);
    expect(result.details.totalCodeFiles).toBe(130);
    expect(result.details.largeFileCount).toBeGreaterThan(0);
  });

  test('debt_ratio uses todos.count', () => {
    const result = scoreDimension('debt_ratio', '/fake', MOCK_SCAN_REPORT, null);
    expect(result.score).toBeGreaterThan(0);
    expect(result.details.todoCount).toBe(12);
  });

  test('security returns 50 with no findings', () => {
    const result = scoreDimension('security', '/fake', MOCK_SCAN_REPORT, null);
    expect(result.score).toBe(50);
  });

  test('build_ci scores from package.json on disk', () => {
    const torquePath = path.resolve(__dirname, '..');
    const result = scoreDimension('build_ci', torquePath, {}, null);
    expect(result.score).toBeGreaterThan(50);
  });
});

describe('scoreAll on real TORQUE codebase', () => {
  test('produces non-zero scores for filesystem dimensions', () => {
    const torquePath = path.resolve(__dirname, '..');
    const { handleScanProject } = require('../handlers/integration/infra');

    let scanReport = {};
    try {
      const result = handleScanProject({ path: torquePath });
      if (result?.content?.[0]) {
        scanReport = JSON.parse(result.content[0].text);
      }
    } catch { /* ok */ }

    const findingsDir = path.join(torquePath, '..', 'docs', 'findings');
    const results = scoreAll(torquePath, scanReport, findingsDir);

    expect(Object.keys(results)).toHaveLength(10);

    if (scanReport.fileSizes) {
      expect(results.structural.score).not.toBe(50);
    }
    if (scanReport.missingTests) {
      expect(results.test_coverage.score).toBeGreaterThan(0);
    }

    expect(results.build_ci.score).toBeGreaterThan(50);
  });
});
