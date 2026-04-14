'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));

const database = require('../database');
const factoryArchitect = require('../db/factory-architect');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES } = require('../factory/loop-states');
const { FACTORY_V2_ROUTES } = require('../api/routes/factory-routes');

function createFactoryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      loop_state TEXT DEFAULT 'IDLE',
      loop_batch_id TEXT,
      loop_last_action_at TEXT,
      loop_paused_at_stage TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      dimension TEXT NOT NULL,
      score REAL NOT NULL,
      details_json TEXT,
      scan_type TEXT NOT NULL DEFAULT 'incremental',
      batch_id TEXT,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_health_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES factory_health_snapshots(id),
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      file_path TEXT,
      details_json TEXT
    );

    CREATE TABLE IF NOT EXISTS factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      source TEXT NOT NULL,
      origin_json TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      requestor TEXT,
      constraints_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      linked_item_id INTEGER,
      batch_id TEXT,
      claimed_by_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fwi_project_status
      ON factory_work_items(project_id, status);

    CREATE TABLE IF NOT EXISTS factory_loop_instances (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      work_item_id INTEGER REFERENCES factory_work_items(id),
      batch_id TEXT,
      loop_state TEXT NOT NULL DEFAULT 'IDLE',
      paused_at_stage TEXT,
      last_action_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      terminated_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_loop_instances_stage_occupancy
      ON factory_loop_instances(project_id, loop_state)
      WHERE terminated_at IS NULL AND loop_state NOT IN ('IDLE');

    CREATE INDEX IF NOT EXISTS idx_factory_loop_instances_project_active
      ON factory_loop_instances(project_id)
      WHERE terminated_at IS NULL;

    CREATE TABLE IF NOT EXISTS factory_architect_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      input_snapshot_json TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      backlog_json TEXT NOT NULL,
      flags_json TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      trigger TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      stage TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      reasoning TEXT,
      inputs_json TEXT,
      outcome_json TEXT,
      confidence REAL,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function registerProject({ name, trust_level = 'dark' } = {}) {
  return factoryHealth.registerProject({
    name: name || `Factory Pipeline ${Date.now()}`,
    path: path.join(os.tmpdir(), `factory-pipeline-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    trust_level,
  });
}

function seedInstance(project_id, updates = {}) {
  const instance = factoryLoopInstances.createInstance({ project_id });
  const nextUpdates = { ...updates };
  if (!Object.keys(nextUpdates).length) {
    return instance;
  }
  if (!nextUpdates.loop_state) {
    delete nextUpdates.loop_state;
  }
  return factoryLoopInstances.updateInstance(instance.id, nextUpdates);
}

function createPlanWorkItem(project_id, rootDir, name) {
  const planPath = path.join(rootDir, `${name}.md`);
  fs.writeFileSync(planPath, [
    `# ${name}`,
    '',
    '## Task 1: keep this plan deterministic',
    '- [ ] verify the claim path',
  ].join('\n'));

  return factoryIntake.createWorkItem({
    project_id,
    source: 'plan_file',
    title: name,
    description: `${name} description`,
    requestor: 'test',
    origin: { plan_path: planPath },
  });
}

function createRouteResponse() {
  return {
    statusCode: 200,
    headers: {},
    _body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers || {});
    },
    end(body) {
      this._body = typeof body === 'string' ? JSON.parse(body) : body;
    },
  };
}

function findFactoryRoute(predicate, label) {
  const route = FACTORY_V2_ROUTES.find(predicate);
  if (!route) {
    throw new Error(`Factory route not found: ${label}`);
  }
  return route;
}

async function invokeFactoryRoute(route, { params = {}, query = {}, body } = {}) {
  const req = {
    method: route.method,
    params,
    query,
    headers: {},
    requestId: `req-${Math.random().toString(16).slice(2)}`,
  };
  if (body !== undefined) {
    req.body = body;
  }
  const res = createRouteResponse();
  await route.handler(req, res, { requestId: req.requestId, params, query });
  return { req, res, body: res._body };
}

async function advanceLoopViaRest(instanceId) {
  const advanceRoute = findFactoryRoute(
    (route) => route.handlerName === 'handleAdvanceFactoryLoopInstanceAsync',
    'handleAdvanceFactoryLoopInstanceAsync',
  );
  const jobRoute = findFactoryRoute(
    (route) => route.handlerName === 'handleFactoryLoopInstanceJobStatus',
    'handleFactoryLoopInstanceJobStatus',
  );

  const started = await invokeFactoryRoute(advanceRoute, {
    params: { instance_id: instanceId },
  });
  expect(started.res.statusCode).toBe(202);
  expect(started.body?.data?.job_id).toBeTruthy();

  const jobId = started.body.data.job_id;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const polled = await invokeFactoryRoute(jobRoute, {
      params: { instance_id: instanceId, job_id: jobId },
    });
    expect(polled.res.statusCode).toBe(200);
    if (polled.body?.data?.status !== 'running') {
      return polled.body.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Loop advance job did not settle for instance ${instanceId}`);
}

describe('factory loop pipeline parallelism', () => {
  let db;
  let originalGetDbInstance;
  let tempDir;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryArchitect.setDb(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryDecisions.setDb(db);
    factoryLoopInstances.setDb(db);
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;
    loopController.setWorktreeRunnerForTests(null);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-loop-pipeline-'));
  });

  afterEach(() => {
    loopController.setWorktreeRunnerForTests(undefined);
    database.getDbInstance = originalGetDbInstance;
    factoryArchitect.setDb(null);
    factoryLoopInstances.setDb(null);
    factoryDecisions.setDb(null);
    factoryIntake.setDb(null);
    factoryHealth.setDb(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
    db.close();
    db = null;
  });

  it('allows three active instances in SENSE, PRIORITIZE, and EXECUTE at the same time', () => {
    const project = registerProject();
    const executeInstance = seedInstance(project.id, { loop_state: LOOP_STATES.EXECUTE, batch_id: 'batch-execute' });
    const prioritizeInstance = seedInstance(project.id, { loop_state: LOOP_STATES.PRIORITIZE });
    const senseInstance = loopController.startLoop(project.id);

    const activeStates = loopController.getActiveInstances(project.id)
      .map((instance) => `${instance.id}:${instance.loop_state}`);

    expect(activeStates).toEqual(expect.arrayContaining([
      `${executeInstance.id}:${LOOP_STATES.EXECUTE}`,
      `${prioritizeInstance.id}:${LOOP_STATES.PRIORITIZE}`,
      `${senseInstance.instance_id}:${LOOP_STATES.SENSE}`,
    ]));
  });

  it('rejects a second SENSE occupant and parks on READY_FOR when the next stage is occupied', async () => {
    const project = registerProject();
    const blocker = seedInstance(project.id, { loop_state: LOOP_STATES.PRIORITIZE });
    const started = loopController.startLoop(project.id);

    expect(() => loopController.startLoop(project.id)).toThrow(loopController.StageOccupiedError);

    const parked = await loopController.advanceLoop(started.instance_id);
    expect(parked).toMatchObject({
      instance_id: started.instance_id,
      new_state: LOOP_STATES.SENSE,
      paused_at_stage: 'READY_FOR_PRIORITIZE',
      reason: 'stage_occupied',
    });

    factoryLoopInstances.terminateInstance(blocker.id);

    const resumed = await loopController.advanceLoop(started.instance_id);
    expect(resumed).toMatchObject({
      instance_id: started.instance_id,
      new_state: LOOP_STATES.PRIORITIZE,
      paused_at_stage: null,
      reason: 'stage_ready',
    });
  });

  it('PRIORITIZE skips already-claimed items and claims a different work item for the advancing instance', async () => {
    const project = registerProject();
    const claimedItem = createPlanWorkItem(project.id, tempDir, 'claimed-item');
    const availableItem = createPlanWorkItem(project.id, tempDir, 'available-item');
    const priorInstance = seedInstance(project.id, {
      loop_state: LOOP_STATES.LEARN,
      batch_id: 'batch-learn',
      work_item_id: claimedItem.id,
    });
    factoryIntake.claimWorkItem(claimedItem.id, priorInstance.id);

    const started = loopController.startLoop(project.id);
    await loopController.advanceLoop(started.instance_id);
    const prioritized = await loopController.advanceLoop(started.instance_id);

    expect(prioritized.instance_id).toBe(started.instance_id);
    expect(factoryIntake.getWorkItem(claimedItem.id).claimed_by_instance_id).toBe(priorInstance.id);
    expect(factoryIntake.getWorkItem(availableItem.id).claimed_by_instance_id).toBe(started.instance_id);
    expect(loopController.getLoopState(started.instance_id)).toMatchObject({
      instance_id: started.instance_id,
      work_item_id: availableItem.id,
    });
  });

  it('rejectGate releases the claim so a later PRIORITIZE pass can re-pick the same work item', async () => {
    const project = registerProject();
    const item = createPlanWorkItem(project.id, tempDir, 'rejected-plan');
    const claimedInstance = seedInstance(project.id, {
      loop_state: LOOP_STATES.PLAN,
      paused_at_stage: LOOP_STATES.PLAN,
      work_item_id: item.id,
    });
    factoryIntake.claimWorkItem(item.id, claimedInstance.id);

    const rejected = loopController.rejectGate(claimedInstance.id, LOOP_STATES.PLAN);
    expect(rejected.state).toBe(LOOP_STATES.IDLE);
    expect(factoryIntake.getWorkItem(item.id).claimed_by_instance_id).toBeNull();

    const nextInstance = loopController.startLoop(project.id);
    await loopController.advanceLoop(nextInstance.instance_id);
    await loopController.advanceLoop(nextInstance.instance_id);

    expect(factoryIntake.getWorkItem(item.id).claimed_by_instance_id).toBe(nextInstance.instance_id);
  });

  it('instance termination clears claims and removes stage occupancy from the active set', () => {
    const project = registerProject();
    const item = createPlanWorkItem(project.id, tempDir, 'verify-plan');
    const instance = seedInstance(project.id, {
      loop_state: LOOP_STATES.VERIFY,
      paused_at_stage: LOOP_STATES.VERIFY,
      work_item_id: item.id,
      batch_id: 'batch-verify',
    });
    factoryIntake.claimWorkItem(item.id, instance.id);

    loopController.rejectGate(instance.id, LOOP_STATES.VERIFY);

    expect(factoryIntake.getWorkItem(item.id).claimed_by_instance_id).toBeNull();
    expect(factoryLoopInstances.getStageOccupant(project.id, LOOP_STATES.VERIFY)).toBeNull();
    expect(loopController.getActiveInstances(project.id).map((entry) => entry.id)).not.toContain(instance.id);
  });

  it('legacy project shims still operate on the oldest active instance', async () => {
    const project = registerProject();
    const oldest = seedInstance(project.id, { loop_state: LOOP_STATES.PRIORITIZE });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newest = loopController.startLoop(project.id);

    const advanced = await loopController.advanceLoopForProject(project.id);

    expect(advanced.instance_id).toBe(oldest.id);
    expect(loopController.getLoopState(newest.instance_id).loop_state).toBe(LOOP_STATES.SENSE);
  });

  it('drives three loop instances through the REST surface while preserving stage occupancy', async () => {
    const project = registerProject();
    createPlanWorkItem(project.id, tempDir, 'rest-parallel-plan');

    const startRoute = findFactoryRoute(
      (route) => route.tool === 'start_factory_loop_instance',
      'start_factory_loop_instance',
    );
    const listRoute = findFactoryRoute(
      (route) => route.tool === 'list_factory_loop_instances',
      'list_factory_loop_instances',
    );

    const startedFirst = await invokeFactoryRoute(startRoute, {
      params: { project: project.id },
    });
    expect(startedFirst.res.statusCode).toBe(200);
    const firstInstance = startedFirst.body.data;

    const firstPrioritize = await advanceLoopViaRest(firstInstance.id);
    expect(firstPrioritize).toMatchObject({
      previous_state: LOOP_STATES.SENSE,
      new_state: LOOP_STATES.PRIORITIZE,
      paused_at_stage: null,
      reason: 'stage_ready',
    });

    const firstAfterPrioritize = await advanceLoopViaRest(firstInstance.id);
    expect(firstAfterPrioritize).toMatchObject({
      previous_state: LOOP_STATES.PRIORITIZE,
      paused_at_stage: null,
    });
    expect([LOOP_STATES.PLAN, LOOP_STATES.EXECUTE]).toContain(firstAfterPrioritize.new_state);

    const startedSecond = await invokeFactoryRoute(startRoute, {
      params: { project: project.id },
    });
    expect(startedSecond.res.statusCode).toBe(200);
    const secondInstance = startedSecond.body.data;

    const secondPrioritize = await advanceLoopViaRest(secondInstance.id);
    expect(secondPrioritize).toMatchObject({
      previous_state: LOOP_STATES.SENSE,
      new_state: LOOP_STATES.PRIORITIZE,
      paused_at_stage: null,
      reason: 'stage_ready',
    });

    const startedThird = await invokeFactoryRoute(startRoute, {
      params: { project: project.id },
    });
    expect(startedThird.res.statusCode).toBe(200);
    const thirdInstance = startedThird.body.data;

    const listed = await invokeFactoryRoute(listRoute, {
      params: { project: project.id },
      query: { active_only: 'true' },
    });
    expect(listed.res.statusCode).toBe(200);
    expect(listed.body.data).toMatchObject({
      project_id: project.id,
      active_only: true,
      count: 3,
    });
    expect(listed.body.data.instances.map((instance) => instance.id)).toEqual(expect.arrayContaining([
      firstInstance.id,
      secondInstance.id,
      thirdInstance.id,
    ]));
    expect(listed.body.data.instances.map((instance) => `${instance.id}:${instance.loop_state}`)).toEqual(expect.arrayContaining([
      `${firstInstance.id}:${firstAfterPrioritize.new_state}`,
      `${secondInstance.id}:${LOOP_STATES.PRIORITIZE}`,
      `${thirdInstance.id}:${LOOP_STATES.SENSE}`,
    ]));

    const blockedThird = await advanceLoopViaRest(thirdInstance.id);
    expect(blockedThird).toMatchObject({
      previous_state: LOOP_STATES.SENSE,
      new_state: LOOP_STATES.SENSE,
      paused_at_stage: 'READY_FOR_PRIORITIZE',
      reason: 'stage_occupied',
    });
  });
});
