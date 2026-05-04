/**
 * Phase L (2026-04-30): handleResumeProject honors cfg.loop.tick_interval_ms
 *
 * initFactoryTicks (server boot) reads `cfg?.loop?.tick_interval_ms` and
 * passes it to startTick — but handleResumeProject was calling
 * `startTick(updated)` without the interval, so a project pause+resume
 * cycle silently reverted to the 5-min default. The only way to apply
 * a new tick interval was a full TORQUE restart.
 *
 * Phase L plumbs the config-aware lookup through the resume path so an
 * operator can shorten DLPhone's tick (or any project's) without a
 * full server restart — pause + update config + resume now applies the
 * new interval immediately.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');

const factoryHandlersPath = require.resolve('../handlers/factory-handlers');
const factoryTickPath = require.resolve('../factory/factory-tick');

let db;
let factoryHealth;
let projectId;
let startTickMock;
let stopTickMock;

const SCHEMA_DDL = [
  'CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)',
  'CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS provider_config (provider TEXT PRIMARY KEY, config_json TEXT)',
  'CREATE TABLE IF NOT EXISTS ollama_hosts (id TEXT PRIMARY KEY, name TEXT, url TEXT, enabled INTEGER DEFAULT 1, last_model_used TEXT, model_loaded_at TEXT, default_model TEXT)',
  'CREATE TABLE IF NOT EXISTS distributed_locks (id TEXT PRIMARY KEY, owner TEXT, expires_at TEXT, last_heartbeat TEXT)',
  'CREATE TABLE IF NOT EXISTS provider_task_stats (id INTEGER PRIMARY KEY, provider TEXT, task_type TEXT, total_tasks INTEGER)',
  'CREATE TABLE IF NOT EXISTS model_family_templates (family TEXT PRIMARY KEY, tuning_json TEXT)',
  'CREATE TABLE IF NOT EXISTS model_registry (model_name TEXT PRIMARY KEY, status TEXT)',
  'CREATE TABLE IF NOT EXISTS routing_templates (id TEXT PRIMARY KEY, rules TEXT)',
];

function createBaseTables(dbHandle) {
  for (const ddl of SCHEMA_DDL) {
    dbHandle.prepare(ddl).run();
  }
}

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadHandlersWithMockedTick(project) {
  vi.resetModules();
  startTickMock = vi.fn();
  stopTickMock = vi.fn();
  const tickMock = { startTick: startTickMock, stopTick: stopTickMock };
  vi.doMock('../factory/factory-tick', () => tickMock);
  installCjsModuleMock('../factory/factory-tick', tickMock);
  delete require.cache[factoryHandlersPath];

  const actualFactoryHealth = require('../db/factory/health');
  const projectState = { ...project };
  const mockFactoryHealth = {
    ...actualFactoryHealth,
    getProject: vi.fn((ref) => (ref === projectState.id ? { ...projectState } : null)),
    getProjectByPath: vi.fn((ref) => (ref === projectState.path ? { ...projectState } : null)),
    updateProject: vi.fn((id, updates) => {
      if (id !== projectState.id) return null;
      Object.assign(projectState, updates);
      return { ...projectState };
    }),
  };
  vi.doMock('../db/factory/health', () => mockFactoryHealth);
  installCjsModuleMock('../db/factory/health', mockFactoryHealth);

  return require('../handlers/factory-handlers');
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../factory/factory-tick');
  vi.doUnmock('../db/factory/health');
  // eslint-disable-next-line torque/no-reset-modules-in-each -- re-requires factory-tick and factory-handlers fresh each run
  vi.resetModules();

  db = new Database(':memory:');
  createBaseTables(db);
  runMigrations(db);

  factoryHealth = require('../db/factory/health');
  factoryHealth.setDb(db);
  db.prepare('DELETE FROM factory_projects').run();
  projectId = factoryHealth.registerProject({
    name: 'phasel-tick-test',
    path: '/tmp/phasel-tick-test',
  }).id;
});

afterEach(() => {
  if (factoryHealth && typeof factoryHealth.setDb === 'function') {
    factoryHealth.setDb(null);
  }
  vi.doUnmock('../factory/factory-tick');
  vi.doUnmock('../db/factory/health');
  vi.restoreAllMocks();
  vi.resetModules();
  delete require.cache[factoryTickPath];
  db.close();
});

describe('Phase L: handleResumeProject honors cfg.loop.tick_interval_ms', () => {
  it('passes the configured interval to startTick when present', async () => {
    const project = {
      id: projectId,
      name: 'phasel-tick-test',
      path: '/tmp/phasel-tick-test',
      status: 'paused',
      config_json: JSON.stringify({
        loop: { auto_continue: true, tick_interval_ms: 90000 },
      }),
    };
    const handlers = loadHandlersWithMockedTick(project);
    await handlers.handleResumeProject({ project: projectId });

    expect(startTickMock).toHaveBeenCalledTimes(1);
    const [resumedProject, intervalMs] = startTickMock.mock.calls[0];
    expect(resumedProject.id).toBe(projectId);
    expect(resumedProject.status).toBe('running');
    expect(intervalMs).toBe(90000);
  });

  it('passes undefined to startTick when config has no tick_interval_ms', async () => {
    const project = {
      id: projectId,
      name: 'phasel-tick-test',
      path: '/tmp/phasel-tick-test',
      status: 'paused',
      config_json: JSON.stringify({ loop: { auto_continue: true } }),
    };
    const handlers = loadHandlersWithMockedTick(project);
    await handlers.handleResumeProject({ project: projectId });

    expect(startTickMock).toHaveBeenCalledTimes(1);
    const intervalMs = startTickMock.mock.calls[0][1];
    // Undefined falls through to startTick's DEFAULT_TICK_INTERVAL_MS default.
    expect(intervalMs).toBeUndefined();
  });

  it('passes undefined to startTick when config_json is missing', async () => {
    const project = {
      id: projectId,
      name: 'phasel-tick-test',
      path: '/tmp/phasel-tick-test',
      status: 'paused',
      config_json: null,
    };
    const handlers = loadHandlersWithMockedTick(project);
    await handlers.handleResumeProject({ project: projectId });

    expect(startTickMock).toHaveBeenCalledTimes(1);
    expect(startTickMock.mock.calls[0][1]).toBeUndefined();
  });

  it('rejects non-positive tick_interval_ms (falls through to default)', async () => {
    const project = {
      id: projectId,
      name: 'phasel-tick-test',
      path: '/tmp/phasel-tick-test',
      status: 'paused',
      config_json: JSON.stringify({ loop: { tick_interval_ms: -1 } }),
    };
    const handlers = loadHandlersWithMockedTick(project);
    await handlers.handleResumeProject({ project: projectId });

    expect(startTickMock).toHaveBeenCalledTimes(1);
    expect(startTickMock.mock.calls[0][1]).toBeUndefined();
  });
});
