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

  test('detects ASP.NET controllers and minimal APIs as a real API surface', () => {
    writeFile(
      'SpudgetBooks.Api/Controllers/V1/InvoicesController.cs',
      `
        using Microsoft.AspNetCore.Mvc;

        namespace SpudgetBooks.Api.Controllers.V1;

        [ApiController]
        [Route("api/v1/invoices")]
        public class InvoicesController : ControllerBase
        {
          [HttpGet]
          public IActionResult List() => Ok();

          [HttpPost]
          public IActionResult Create() => Ok();
        }
      `,
    );
    writeFile(
      'SpudgetBooks.Api/Program.cs',
      `
        var builder = WebApplication.CreateBuilder(args);
        var app = builder.Build();
        app.MapControllers();
        app.MapGet("/api/v1/health", () => Results.Ok());
        app.MapPost("/api/v1/imports", () => Results.Ok());
        app.Run();
      `,
    );

    const result = score(tempDir, {}, null);

    expect(result.details.reason).toBeUndefined();
    expect(result.details.restToolCount).toBeGreaterThan(0);
    expect(result.details.controllerCount).toBeGreaterThan(0);
    expect(result.details.attributeEndpointCount).toBeGreaterThan(0);
    expect(result.details.minimalEndpointCount).toBeGreaterThan(0);
    expect(result.details.usesMapControllers).toBe(true);
    expect(result.details.surfaceMode).toBe('rest_only');
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
