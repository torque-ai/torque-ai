const path = require('path');
const os = require('os');
const fs = require('fs');

let testDir;
let origDataDir;
let db;
let taskCore;
let schedulingMod;
let hostMod;

const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;
const projectConfigCore = require('../db/project-config-core');

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-p1-atomicity-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  taskCore = require('../db/task-core');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);

  schedulingMod = require('../db/scheduling-automation');
  schedulingMod.setDb(db.getDb ? db.getDb() : db.getDbInstance());
  schedulingMod.setGetTask((id) => taskCore.getTask(id));
  schedulingMod.setRecordTaskEvent((_name, _taskId, _payload) => {});
  schedulingMod.setGetPipeline((id) => projectConfigCore.getPipeline(id));
  schedulingMod.setCreatePipeline((...args) => projectConfigCore.createPipeline(...args));

  hostMod = require('../db/host-management');
  hostMod.setDb(db.getDb ? db.getDb() : db.getDbInstance());
  hostMod.setGetTask((id) => taskCore.getTask(id));
  hostMod.setGetProjectRoot((dir) => dir); // identity for test environment
}

function teardown() {
  if (db) {
    try {
      db.close();
    } catch {}
  }

  if (testDir) {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
    if (origDataDir !== undefined) process.env.TORQUE_DATA_DIR = origDataDir;
    else delete process.env.TORQUE_DATA_DIR;
  }
}

function rawDb() {
  return db.getDb ? db.getDb() : db.getDbInstance();
}

function resetTables() {
  const conn = rawDb();
  for (const table of ['templates', 'tasks', 'ollama_hosts']) {
    try {
      conn.prepare(`DELETE FROM ${table}`).run();
    } catch {}
  }
}

function makeHost(overrides = {}) {
  return hostMod.addOllamaHost({
    id: overrides.id || `atomic-host-${Math.random().toString(36).slice(2, 10)}`,
    name: overrides.name || 'AtomicHost',
    url: overrides.url || `http://atomic-host-${Date.now()}.local:11434`,
    max_concurrent: 2,
    memory_limit_mb: 8192,
    ...overrides,
  });
}

describe('p1 db atomicity regressions', () => {
  beforeAll(() => {
    setup();
  });

  afterAll(() => {
    teardown();
  });

  beforeEach(() => {
    resetTables();
  });

  it('preserves template usage_count when saveTemplate updates an existing row', () => {
    schedulingMod.saveTemplate({
      name: 'atomic-template',
      task_template: 'echo one',
      default_timeout: 15,
      default_priority: 1,
      auto_approve: false,
    });

    schedulingMod.incrementTemplateUsage('atomic-template');
    schedulingMod.incrementTemplateUsage('atomic-template');

    const updated = schedulingMod.saveTemplate({
      name: 'atomic-template',
      description: 'updated',
      task_template: 'echo two',
      default_timeout: 30,
      default_priority: 2,
      auto_approve: true,
    });

    expect(updated.task_template).toBe('echo two');
    expect(updated.description).toBe('updated');
    expect(updated.usage_count).toBe(2);
  });

  it('disableStaleHosts uses last_health_check and does not fail on stale host cleanup', () => {
    const host = makeHost({
      id: 'stale-host',
      name: 'Stale Host',
      url: 'http://stale-host.local:11434',
    });

    const staleCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    rawDb().prepare(
      "UPDATE ollama_hosts SET status = 'down', enabled = 1, last_health_check = ? WHERE id = ?"
    ).run(staleCutoff, host.id);

    const disabled = hostMod.disableStaleHosts(24);
    const refreshed = hostMod.getOllamaHost(host.id);

    expect(disabled).toBe(1);
    expect(refreshed.enabled).toBe(0);
  });
});
