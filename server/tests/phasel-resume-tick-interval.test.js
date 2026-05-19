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
 * operator can shorten example-project's tick (or any project's) without a
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
let isTickActiveMock;

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
  isTickActiveMock = vi.fn(() => false);
  const tickMock = {
    startTick: startTickMock,
    stopTick: stopTickMock,
    isTickActive: isTickActiveMock,
  };
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
      trust_level: 'dark',
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
    expect(startTickMock.mock.calls[0][2]).toEqual({ immediate: true });
  });

  it('can resume without running the immediate tick for readiness plan application', async () => {
    const project = {
      id: projectId,
      name: 'phasel-tick-test',
      path: '/tmp/phasel-tick-test',
      status: 'paused',
      trust_level: 'dark',
      config_json: JSON.stringify({
        loop: { auto_continue: true, tick_interval_ms: 90000 },
      }),
    };
    const handlers = loadHandlersWithMockedTick(project);
    const result = await handlers.handleResumeProject({
      project: projectId,
      immediate_tick: false,
    });

    expect(startTickMock).toHaveBeenCalledTimes(1);
    expect(startTickMock.mock.calls[0][1]).toBe(90000);
    expect(startTickMock.mock.calls[0][2]).toEqual({ immediate: false });
    expect(result.structuredData.tick_immediate).toBe(false);
  });

  it('forces resume immediate tick off when factory project work is disabled', async () => {
    const previous = process.env.TORQUE_FACTORY_PROJECT_WORK_ENABLED;
    process.env.TORQUE_FACTORY_PROJECT_WORK_ENABLED = '0';
    try {
      const project = {
        id: projectId,
        name: 'phasel-tick-test',
        path: '/tmp/phasel-tick-test',
        status: 'paused',
        trust_level: 'dark',
        config_json: JSON.stringify({
          loop: { auto_continue: true, tick_interval_ms: 90000 },
        }),
      };
      const handlers = loadHandlersWithMockedTick(project);
      startTickMock.mockReturnValueOnce({ started: true, already_active: false });
      const result = await handlers.handleResumeProject({ project: projectId });

      expect(startTickMock).toHaveBeenCalledTimes(1);
      expect(startTickMock.mock.calls[0][1]).toBe(90000);
      expect(startTickMock.mock.calls[0][2]).toEqual({ immediate: false });
      expect(result.structuredData.tick_immediate).toBe(false);
      expect(result.structuredData.tick_armed).toBe(true);
      expect(result.structuredData.requeued_tasks).toBe(0);
      expect(result.structuredData.queue_resume_skipped_reason).toBe('factory_project_work_disabled');
    } finally {
      if (previous === undefined) {
        delete process.env.TORQUE_FACTORY_PROJECT_WORK_ENABLED;
      } else {
        process.env.TORQUE_FACTORY_PROJECT_WORK_ENABLED = previous;
      }
    }
  });

  it('passes undefined to startTick when config has no tick_interval_ms', async () => {
    const project = {
      id: projectId,
      name: 'phasel-tick-test',
      path: '/tmp/phasel-tick-test',
      status: 'paused',
      trust_level: 'dark',
      config_json: JSON.stringify({ loop: { auto_continue: true } }),
    };
    const handlers = loadHandlersWithMockedTick(project);
    await handlers.handleResumeProject({ project: projectId });

    expect(startTickMock).toHaveBeenCalledTimes(1);
    const intervalMs = startTickMock.mock.calls[0][1];
    // Undefined falls through to startTick's DEFAULT_TICK_INTERVAL_MS default.
    expect(intervalMs).toBeUndefined();
  });

  it('does not arm a tick when resume leaves the project automation-blocked', async () => {
    const project = {
      id: projectId,
      name: 'phasel-tick-test',
      path: '/tmp/phasel-tick-test',
      status: 'paused',
      config_json: null,
    };
    const handlers = loadHandlersWithMockedTick(project);
    const result = await handlers.handleResumeProject({ project: projectId });

    expect(startTickMock).not.toHaveBeenCalled();
    expect(result.structuredData).toMatchObject({
      tick_armed: false,
      tick_started: false,
      tick_skipped_reason: 'automation_not_ready',
      automation_readiness: {
        ready: false,
        blocker_codes: expect.arrayContaining(['auto_continue_disabled', 'approval_gates_enabled']),
      },
    });
  });

  it('rejects non-positive tick_interval_ms (falls through to default)', async () => {
    const project = {
      id: projectId,
      name: 'phasel-tick-test',
      path: '/tmp/phasel-tick-test',
      status: 'paused',
      trust_level: 'dark',
      config_json: JSON.stringify({ loop: { auto_continue: true, tick_interval_ms: -1 } }),
    };
    const handlers = loadHandlersWithMockedTick(project);
    await handlers.handleResumeProject({ project: projectId });

    expect(startTickMock).toHaveBeenCalledTimes(1);
    expect(startTickMock.mock.calls[0][1]).toBeUndefined();
  });

  it('stops an armed tick when set_factory_trust_level disables automation readiness', async () => {
    const project = {
      id: projectId,
      name: 'phasel-tick-test',
      path: '/tmp/phasel-tick-test',
      status: 'running',
      trust_level: 'dark',
      config_json: JSON.stringify({ loop: { auto_continue: true, tick_interval_ms: 90000 } }),
    };
    const handlers = loadHandlersWithMockedTick(project);
    isTickActiveMock.mockReturnValue(true);

    const result = await handlers.handleSetFactoryTrustLevel({
      project: projectId,
      trust_level: 'dark',
      config: { loop: { auto_continue: false } },
    });

    expect(isTickActiveMock).toHaveBeenCalledWith(projectId);
    expect(stopTickMock).toHaveBeenCalledWith(projectId);
    expect(result.structuredData).toMatchObject({
      tick_stopped: true,
      tick_stop_reason: 'automation_not_ready',
      automation_readiness: {
        ready: false,
        blocker_codes: expect.arrayContaining(['auto_continue_disabled']),
      },
    });
  });

  it('does not auto-arm or stop a tick when set_factory_trust_level makes a project ready', async () => {
    const project = {
      id: projectId,
      name: 'phasel-tick-test',
      path: '/tmp/phasel-tick-test',
      status: 'running',
      trust_level: 'autonomous',
      config_json: JSON.stringify({ loop: { auto_continue: false, tick_interval_ms: 90000 } }),
    };
    const handlers = loadHandlersWithMockedTick(project);

    const result = await handlers.handleSetFactoryTrustLevel({
      project: projectId,
      trust_level: 'dark',
      config: { loop: { auto_continue: true } },
    });

    expect(startTickMock).not.toHaveBeenCalled();
    expect(stopTickMock).not.toHaveBeenCalled();
    expect(isTickActiveMock).not.toHaveBeenCalled();
    expect(result.structuredData).toMatchObject({
      tick_stopped: false,
      tick_stop_reason: null,
      automation_readiness: {
        ready: true,
        blocker_codes: [],
      },
    });
  });
});
