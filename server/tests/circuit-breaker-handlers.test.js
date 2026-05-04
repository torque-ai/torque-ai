'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

const Database = require('better-sqlite3');
const { createTables } = require('../db/schema/tables');
const { createCircuitBreaker } = require('../execution/circuit-breaker');

const SILENT_LOGGER = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// Patch require.cache directly — the automation-handlers test uses this
// pattern because vi.mock() hoisting doesn't reliably intercept CJS
// require chains for the handler module.
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

// Top-level static mocks keep vi.mock hoisting happy (required by vitest).
vi.mock('../container', () => ({ defaultContainer: {} }));

describe('codex-breaker MCP handlers', () => {
  let db;
  let cb;
  let handlers;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db, SILENT_LOGGER);
    cb = createCircuitBreaker({ eventBus: { emit: () => {} }, config: {}, store: null });

    const mockContainer = {
      has: (name) => name === 'circuitBreaker' || name === 'providerCircuitBreakerStore',
      get: (name) => {
        if (name === 'circuitBreaker') return cb;
        if (name === 'db') return db;
        return null;
      },
    };

    // Override require.cache so the handler picks up our mock on fresh load.
    installCjsModuleMock('../container', { defaultContainer: mockContainer });
    removeCjsModuleMock('../handlers/circuit-breaker-handlers');
    handlers = require('../handlers/circuit-breaker-handlers');
  });

  afterEach(() => {
    removeCjsModuleMock('../container', '../handlers/circuit-breaker-handlers');
    if (db) {
      db.close();
      db = null;
    }
  });

  it('exports the new handlers', () => {
    expect(typeof handlers.handleTripCodexBreaker).toBe('function');
    expect(typeof handlers.handleUntripCodexBreaker).toBe('function');
    expect(typeof handlers.handleGetCodexBreakerStatus).toBe('function');
    expect(typeof handlers.handleConfigureCodexPolicy).toBe('function');
  });

  it('handleTripCodexBreaker trips and reports OPEN', async () => {
    const out = await handlers.handleTripCodexBreaker({ reason: 'test_trip_unique_xyz' });
    expect(out.isError).toBeFalsy();
    const text = out.content[0].text;
    expect(text).toMatch(/OPEN/);
    expect(text).toMatch(/test_trip_unique_xyz/);
  });

  it('handleUntripCodexBreaker untrips after a trip', async () => {
    await handlers.handleTripCodexBreaker({ reason: 'test_trip' });
    const out = await handlers.handleUntripCodexBreaker({ reason: 'test_untrip' });
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/CLOSED/);
  });

  it('handleGetCodexBreakerStatus returns state info', async () => {
    const out = await handlers.handleGetCodexBreakerStatus({});
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/codex|state/i);
  });

  it('handleConfigureCodexPolicy validates mode value', async () => {
    const pid = 'codex-policy-test-' + Date.now();
    const INSERT_PROJECT = `INSERT INTO factory_projects (id, name, path, brief, trust_level, status, config_json)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.prepare(INSERT_PROJECT).run(pid, 'Test', '/tmp', 'b', 'cautious', 'running', '{}');

    const out = await handlers.handleConfigureCodexPolicy({ project_id: pid, mode: 'manual' });
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/manual/);

    const row = db.prepare(`SELECT config_json FROM factory_projects WHERE id = ?`).get(pid);
    const cfg = JSON.parse(row.config_json);
    expect(cfg.codex_fallback_policy).toBe('manual');
  });

  it('handleConfigureCodexPolicy rejects invalid mode', async () => {
    const out = await handlers.handleConfigureCodexPolicy({ project_id: 'irrelevant', mode: 'bogus' });
    expect(out.isError).toBeTruthy();
  });
});
