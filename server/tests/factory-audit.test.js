import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');

const factoryHandlersPath = require.resolve('../handlers/factory-handlers');

let db;
let factoryAudit;
let factoryHealth;
let projectId;

function createBaseTables(dbHandle) {
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS provider_config (provider TEXT PRIMARY KEY, config_json TEXT);
    CREATE TABLE IF NOT EXISTS ollama_hosts (id TEXT PRIMARY KEY, name TEXT, url TEXT, enabled INTEGER DEFAULT 1, last_model_used TEXT, model_loaded_at TEXT, default_model TEXT);
    CREATE TABLE IF NOT EXISTS distributed_locks (id TEXT PRIMARY KEY, owner TEXT, expires_at TEXT, last_heartbeat TEXT);
    CREATE TABLE IF NOT EXISTS provider_task_stats (id INTEGER PRIMARY KEY, provider TEXT, task_type TEXT, total_tasks INTEGER);
    CREATE TABLE IF NOT EXISTS model_family_templates (family TEXT PRIMARY KEY, tuning_json TEXT);
    CREATE TABLE IF NOT EXISTS model_registry (model_name TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE IF NOT EXISTS routing_templates (id TEXT PRIMARY KEY, rules TEXT);
  `);
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

function registerProject(overrides = {}) {
  return factoryHealth.registerProject({
    name: overrides.name || 'audit-project',
    path: overrides.path || `/tmp/audit-project-${Math.random().toString(16).slice(2)}`,
    brief: overrides.brief,
    trust_level: overrides.trust_level,
  });
}

function setProjectStatus(id, status) {
  db.prepare("UPDATE factory_projects SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

function getProjectRow(id = projectId) {
  return db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(id);
}

function recordEvent(overrides = {}) {
  return factoryAudit.recordAuditEvent({
    project_id: projectId,
    event_type: 'pause',
    previous_status: 'running',
    reason: 'manual',
    actor: 'alice',
    source: 'mcp',
    ...overrides,
  });
}

function listRows() {
  return db.prepare(`
    SELECT id, project_id, event_type, previous_status, reason, actor, source, created_at
    FROM factory_audit_events
    ORDER BY created_at DESC, id DESC
  `).all();
}

function loadHandlersWithMockedFactoryHealth(project) {
  vi.resetModules();

  const actualFactoryHealth = require('../db/factory-health');
  const projectState = { ...project };
  const mockFactoryHealth = {
    ...actualFactoryHealth,
    getProject: vi.fn((ref) => (ref === projectState.id ? { ...projectState } : null)),
    getProjectByPath: vi.fn((ref) => (ref === projectState.path ? { ...projectState } : null)),
    updateProject: vi.fn((id, updates) => {
      if (id !== projectState.id) return null;
      Object.assign(projectState, updates);
      db.prepare("UPDATE factory_projects SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(projectState.status, id);
      return { ...projectState };
    }),
  };

  vi.doMock('../db/factory-health', () => mockFactoryHealth);
  installCjsModuleMock('../db/factory-health', mockFactoryHealth);
  delete require.cache[factoryHandlersPath];

  const freshFactoryAudit = require('../db/factory-audit');
  freshFactoryAudit.setDb(db);

  return {
    handlers: require('../handlers/factory-handlers'),
    mockFactoryHealth,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../db/factory-health');
  vi.resetModules();

  db = new Database(':memory:');
  createBaseTables(db);
  runMigrations(db);

  factoryAudit = require('../db/factory-audit');
  factoryHealth = require('../db/factory-health');
  factoryAudit.setDb(db);
  factoryHealth.setDb(db);

  db.exec('DELETE FROM factory_audit_events');
  db.exec('DELETE FROM factory_projects');

  projectId = registerProject().id;
});

afterEach(() => {
  if (factoryAudit && typeof factoryAudit.setDb === 'function') {
    factoryAudit.setDb(null);
  }
  if (factoryHealth && typeof factoryHealth.setDb === 'function') {
    factoryHealth.setDb(null);
  }
  vi.doUnmock('../db/factory-health');
  vi.restoreAllMocks();
  vi.resetModules();
  db.close();
});

describe('factory-audit DB module', () => {
  it('recordAuditEvent persists a row', () => {
    recordEvent();

    const rows = db.prepare(`
      SELECT project_id, event_type, previous_status, reason, actor, source
      FROM factory_audit_events
    `).all();

    expect(rows).toEqual([
      {
        project_id: projectId,
        event_type: 'pause',
        previous_status: 'running',
        reason: 'manual',
        actor: 'alice',
        source: 'mcp',
      },
    ]);
  });

  it('listAuditEvents filters by project_id', () => {
    const otherProjectId = registerProject({ name: 'other-project' }).id;

    recordEvent({ project_id: projectId, reason: 'first-p1' });
    recordEvent({ project_id: otherProjectId, reason: 'other-project' });
    recordEvent({ project_id: projectId, event_type: 'resume', previous_status: 'paused', reason: 'second-p1' });

    const events = factoryAudit.listAuditEvents({ project_id: projectId });

    expect(events).toHaveLength(2);
    expect(events.every((event) => event.project_id === projectId)).toBe(true);
    expect(events.map((event) => event.reason)).toEqual(['second-p1', 'first-p1']);
  });

  it('listAuditEvents filters by event_type', () => {
    recordEvent({ event_type: 'pause', reason: 'pause-event' });
    recordEvent({ event_type: 'resume', previous_status: 'paused', reason: 'resume-event' });

    const events = factoryAudit.listAuditEvents({ event_type: 'pause' });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        project_id: projectId,
        event_type: 'pause',
        reason: 'pause-event',
      })
    );
  });

  it('listAuditEvents orders by created_at DESC', async () => {
    recordEvent({ reason: 'older-event' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    recordEvent({ event_type: 'resume', previous_status: 'paused', reason: 'newer-event' });

    const events = factoryAudit.listAuditEvents({ project_id: projectId });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.reason)).toEqual(['newer-event', 'older-event']);
  });
});

describe('factory pause/resume audit handlers', () => {
  it('pause handler emits audit row via DB', async () => {
    setProjectStatus(projectId, 'running');

    const { handlers, mockFactoryHealth } = loadHandlersWithMockedFactoryHealth(getProjectRow(projectId));
    await handlers.handlePauseProject({
      project: projectId,
      reason: 'manual',
      actor: 'alice',
      source: 'mcp',
    });

    expect(mockFactoryHealth.updateProject).toHaveBeenCalledWith(projectId, { status: 'paused' });
    expect(listRows()).toEqual([
      expect.objectContaining({
        project_id: projectId,
        event_type: 'pause',
        previous_status: 'running',
        reason: 'manual',
        actor: 'alice',
        source: 'mcp',
      }),
    ]);
  });

  it('resume handler emits audit row via DB', async () => {
    setProjectStatus(projectId, 'paused');

    const { handlers, mockFactoryHealth } = loadHandlersWithMockedFactoryHealth(getProjectRow(projectId));
    await handlers.handleResumeProject({
      project: projectId,
      reason: 'manual',
      actor: 'alice',
      source: 'mcp',
    });

    expect(mockFactoryHealth.updateProject).toHaveBeenCalledWith(projectId, { status: 'running' });
    expect(listRows()).toEqual([
      expect.objectContaining({
        project_id: projectId,
        event_type: 'resume',
        previous_status: 'paused',
        reason: 'manual',
        actor: 'alice',
        source: 'mcp',
      }),
    ]);
  });
});
