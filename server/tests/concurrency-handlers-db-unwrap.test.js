'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

// Regression for the dashboard's "concurrent sessions reverts to default"
// bug. Root cause: the v2 set_concurrency_limit handler resolved 'db' from
// the DI container and called .prepare() on it directly. The container's
// 'db' is the database facade — high-level helpers, no .prepare. The raw
// SQL therefore threw TypeError, the handler returned a plaintext error,
// and the dashboard saw HTTP 200 + a success toast while the DB never
// changed. (Regression introduced 2026-04-04 in 8a0430c8.)

const Database = require('better-sqlite3');

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function removeCjsModuleMock(...modulePaths) {
  for (const p of modulePaths) {
    try {
      delete require.cache[require.resolve(p)];
    } catch (_) {
      // ignore
    }
  }
}

vi.mock('../container', () => ({ defaultContainer: {} }));

describe('concurrency-handlers — unwraps facade before raw SQL', () => {
  let rawDb;
  let handlers;

  beforeEach(() => {
    rawDb = new Database(':memory:');
    rawDb.prepare(`
      CREATE TABLE provider_config (
        provider TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        max_concurrent INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        cli_path TEXT,
        transport TEXT,
        cli_args TEXT,
        quota_error_patterns TEXT,
        created_at TEXT
      )
    `).run();
    rawDb.prepare('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)').run();
    rawDb.prepare(`
      INSERT INTO provider_config (provider, enabled, max_concurrent, priority, transport, created_at)
      VALUES ('codex', 1, 10, 1, 'hybrid', datetime('now'))
    `).run();

    // Container 'db' is the database facade — it has getDbInstance() to
    // unwrap to the raw better-sqlite3 instance, but does NOT expose
    // .prepare() directly. This mirrors the real production wiring and is
    // exactly the shape that exposed the original bug.
    const facade = {
      getDbInstance: () => rawDb,
      // Common facade helper (irrelevant to this test, but documenting the
      // shape so future maintainers don't add .prepare here).
      getConfig: (key) => rawDb.prepare('SELECT value FROM config WHERE key = ?').get(key)?.value,
    };

    const mockContainer = {
      has: (name) => name === 'db',
      get: (name) => (name === 'db' ? facade : null),
    };

    installCjsModuleMock('../container', { defaultContainer: mockContainer });
    removeCjsModuleMock('../handlers/concurrency-handlers');
    handlers = require('../handlers/concurrency-handlers');
  });

  afterEach(() => {
    removeCjsModuleMock('../container', '../handlers/concurrency-handlers');
    if (rawDb) {
      rawDb.close();
      rawDb = null;
    }
  });

  it('handleSetConcurrencyLimit persists max_concurrent for an existing provider', () => {
    const result = handlers.handleSetConcurrencyLimit({
      scope: 'provider',
      target: 'codex',
      max_concurrent: 3,
    });

    const text = result?.content?.[0]?.text || '';
    expect(text).toMatch(/Set max_concurrent for provider 'codex' to 3/);
    expect(text).not.toMatch(/Failed to set/);
    // Success responses must not carry isError — that signal lets the
    // dispatch helper map only failures to non-2xx HTTP responses.
    expect(result?.isError).toBeFalsy();

    const row = rawDb.prepare('SELECT max_concurrent FROM provider_config WHERE provider = ?').get('codex');
    expect(row?.max_concurrent).toBe(3);
  });

  it('handleSetConcurrencyLimit flags missing-target validation as isError 400', () => {
    const result = handlers.handleSetConcurrencyLimit({ scope: 'provider', max_concurrent: 3 });
    expect(result?.isError).toBe(true);
    expect(result?.status).toBe(400);
    expect(result?.content?.[0]?.text).toMatch(/target is required/);
  });

  it('handleSetConcurrencyLimit flags out-of-range max_concurrent as isError 400', () => {
    const result = handlers.handleSetConcurrencyLimit({
      scope: 'provider',
      target: 'codex',
      max_concurrent: 9999,
    });
    expect(result?.isError).toBe(true);
    expect(result?.status).toBe(400);
    expect(result?.content?.[0]?.text).toMatch(/max_concurrent must be an integer/);
  });

  it('handleSetConcurrencyLimit flags unknown provider as isError 404', () => {
    const result = handlers.handleSetConcurrencyLimit({
      scope: 'provider',
      target: 'no-such-provider',
      max_concurrent: 3,
    });
    expect(result?.isError).toBe(true);
    expect(result?.status).toBe(404);
    expect(result?.code).toBe('provider_not_found');
    expect(result?.content?.[0]?.text).toMatch(/Provider 'no-such-provider' not found/);
  });

  it('handleSetConcurrencyLimit persists vram_factor via raw SQL on the config table', () => {
    const result = handlers.handleSetConcurrencyLimit({
      scope: 'vram_factor',
      vram_factor: 0.8,
    });

    const text = result?.content?.[0]?.text || '';
    expect(text).toMatch(/Set vram_overhead_factor to 0\.8/);
    expect(text).not.toMatch(/Failed to set/);

    const row = rawDb.prepare("SELECT value FROM config WHERE key = 'vram_overhead_factor'").get();
    expect(row?.value).toBe('0.8');
  });

  it('handleGetConcurrencyLimits reads provider_config rows through the unwrapped DB', () => {
    const result = handlers.handleGetConcurrencyLimits();
    const text = result?.content?.[0]?.text || '';
    expect(text).not.toMatch(/Failed to get/);

    const data = JSON.parse(text);
    const codex = (data.providers || []).find((p) => p.provider === 'codex');
    expect(codex).toBeTruthy();
    expect(codex.max_concurrent).toBe(10);
  });
});
