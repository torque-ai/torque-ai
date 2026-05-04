'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

describe('tool-metadata cold-import', () => {
  it('imports in under 200ms (no handler modules loaded)', () => {
    const script = `
      const start = Date.now();
      require(${JSON.stringify(path.resolve(__dirname, '..', 'tool-metadata'))});
      const elapsed = Date.now() - start;
      process.stdout.write(String(elapsed) + '\\n');
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    const elapsed = parseInt(result.stdout.trim(), 10);
    // Allow generous budget for slow CI: 200ms. The goal is <30ms; this test
    // catches runaway handler-loading (which takes ~335ms), not micro-optimization.
    expect(elapsed).toBeLessThan(200);
  });

  it('exports TOOLS as an array', () => {
    const reg = require('../tool-metadata');
    expect(Array.isArray(reg.TOOLS)).toBe(true);
    expect(reg.TOOLS.length).toBeGreaterThan(0);
  });

  it('exports schemaMap as a Map', () => {
    const reg = require('../tool-metadata');
    expect(reg.schemaMap instanceof Map).toBe(true);
  });

  it('exports routeMap as a Map', () => {
    const reg = require('../tool-metadata');
    expect(reg.routeMap instanceof Map).toBe(true);
  });

  it('exports decorateToolDefinition as a function', () => {
    const reg = require('../tool-metadata');
    expect(typeof reg.decorateToolDefinition).toBe('function');
  });
});
