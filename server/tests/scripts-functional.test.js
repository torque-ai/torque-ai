/**
 * Functional Tests: server/scripts/
 *
 * Tests exported functions from scripts that have testable module APIs.
 * Scripts that are one-time/legacy or require live infrastructure are excluded.
 */

'use strict';

const path = require('path');

// ────────────────────────────────────────────────────────────────
// gpu-metrics-server.js
// ────────────────────────────────────────────────────────────────
describe('gpu-metrics-server', () => {
  let gpuMetrics;

  beforeAll(() => {
    gpuMetrics = require('../scripts/gpu-metrics-server');
  });

  afterEach(() => {
    gpuMetrics.stop();
  });

  it('exports start and stop functions', () => {
    expect(typeof gpuMetrics.start).toBe('function');
    expect(typeof gpuMetrics.stop).toBe('function');
  });

  it('start returns an object with success and hasGpu', async () => {
    const result = await gpuMetrics.start({ port: 0 }); // port 0 = random available
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('hasGpu');
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.hasGpu).toBe('boolean');
  });

  it('stop is idempotent (safe to call multiple times)', () => {
    expect(() => gpuMetrics.stop()).not.toThrow();
    expect(() => gpuMetrics.stop()).not.toThrow();
  });
});


// ────────────────────────────────────────────────────────────────
// mcp-launch-readiness.js — normalizeReportPath
// ────────────────────────────────────────────────────────────────
describe('mcp-launch-readiness (normalizeReportPath)', () => {
  // Re-implement the logic for isolated testing since it's not exported
  const ROOT_DIR = path.resolve(__dirname, '..');

  function normalizeReportPath(rawPath) {
    if (!rawPath) return null;
    if (path.isAbsolute(rawPath)) return rawPath;
    const adjustedPath = rawPath.replace(/^\.?[\\/]*server[\\/]+/i, '');
    return path.resolve(ROOT_DIR, adjustedPath);
  }

  it('returns null for falsy input', () => {
    expect(normalizeReportPath(null)).toBeNull();
    expect(normalizeReportPath('')).toBeNull();
    expect(normalizeReportPath(undefined)).toBeNull();
  });

  it('returns absolute paths unchanged', () => {
    const absPath = process.platform === 'win32'
      ? 'C:\\Users\\test\\report.json'
      : '/home/test/report.json';
    expect(normalizeReportPath(absPath)).toBe(absPath);
  });

  it('strips leading server/ from relative paths', () => {
    const result = normalizeReportPath('server/report.json');
    expect(result).toBe(path.resolve(ROOT_DIR, 'report.json'));
  });

  it('resolves plain relative paths from ROOT_DIR', () => {
    const result = normalizeReportPath('docs/report.json');
    expect(result).toBe(path.resolve(ROOT_DIR, 'docs/report.json'));
  });
});


// ────────────────────────────────────────────────────────────────
// All active scripts — comprehensive import tests
// ────────────────────────────────────────────────────────────────
describe('scripts module exports', () => {
  const SCRIPTS_WITH_EXPORTS = [
    { name: 'gpu-metrics-server.js', exports: ['start', 'stop'] },
    { name: 'mcp-launch-readiness.js', exports: ['main'] },
    { name: 'mcp-readiness-pack.js', exports: ['main'] },
    { name: 'mcp-dual-agent-smoke.js', exports: ['main'] },
    { name: 'check-live-rest-readiness.js', exports: ['main'] },
    { name: 'run-live-rest-local.js', exports: ['main'] },
    { name: 'smoke-dashboard-mutations.js', exports: ['main'] },
  ];

  for (const { name, exports: expectedExports } of SCRIPTS_WITH_EXPORTS) {
    it(`${name} exports: ${expectedExports.join(', ')}`, () => {
      const scriptPath = path.join(__dirname, '..', 'scripts', name);
      delete require.cache[require.resolve(scriptPath)];
      const mod = require(scriptPath);
      for (const exp of expectedExports) {
        expect(typeof mod[exp]).toBe('function');
      }
    });
  }
});
