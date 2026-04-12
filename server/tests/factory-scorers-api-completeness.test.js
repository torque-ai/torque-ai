'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { score } = require('../factory/scorers/api-completeness');

describe('api-completeness scorer', () => {
  let tempDir;

  function writeFile(relativePath, content) {
    const filePath = path.join(tempDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-test-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('high-score path: full REST/MCP parity', () => {
    writeFile(
      'server/tool-defs/foo-defs.js',
      "module.exports = [{ name: 'foo' }, { name: 'bar' }, { name: 'baz' }];",
    );
    writeFile(
      'server/api/routes.js',
      "{ method: 'GET', tool: 'foo' }, { method: 'POST', tool: 'bar' }, { method: 'GET', tool: 'baz' }",
    );
    writeFile('openapi.json', '{}');

    const result = score(tempDir, {}, null);

    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.details.source).toBe('rest_mcp_parity');
    expect(result.details.parityPct).toBeGreaterThanOrEqual(0.9);
    expect(result.details.hasApiDocs).toBe(true);
  });

  test('low-score path: MCP tools but no REST routes', () => {
    writeFile(
      'server/tool-defs/foo-defs.js',
      "module.exports = [{ name: 'foo' }, { name: 'bar' }, { name: 'baz' }, { name: 'qux' }, { name: 'zap' }];",
    );

    const result = score(tempDir, {}, null);

    expect(result.score).toBeLessThan(50);
    expect(result.findings.some((finding) => /parity/i.test(finding.title))).toBe(true);
  });

  test('edge case: missing projectPath', () => {
    const result = score(null, {}, null);

    expect(result.score).toBe(50);
    expect(result.details.reason).toBe('no_project_path');
  });

  test('edge case: no API surface at all', () => {
    const result = score(tempDir, {}, null);

    expect(result.score).toBe(50);
    expect(result.details.reason).toBe('no_api_surface');
  });

  test('clamp: score stays in [0,100]', () => {
    writeFile(
      'server/tool-defs/foo-defs.js',
      "module.exports = [{ name: 'foo' }, { name: 'bar' }, { name: 'baz' }];",
    );
    writeFile(
      'server/api/routes.js',
      "{ method: 'GET', tool: 'foo' }, { method: 'POST', tool: 'bar' }, { method: 'GET', tool: 'baz' }",
    );
    writeFile('openapi.json', '{}');

    const result = score(tempDir, {}, null);

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
