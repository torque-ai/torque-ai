const path = require('path');
const Module = require('module');
const { rawDb, resetTables, safeTool, setupTestDb, teardownTestDb } = require('./vitest-setup');
const factoryIntake = require('../db/factory-intake');
const notifications = require('../factory/notifications');

function insertActiveLoopInstance(db, {
  projectId,
  loopState,
  pausedAtStage = null,
  lastActionAt = null,
  batchId = null,
}) {
  db.prepare(`
    INSERT INTO factory_loop_instances (
      id,
      project_id,
      batch_id,
      loop_state,
      paused_at_stage,
      last_action_at,
      created_at,
      terminated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    `${projectId}-instance`,
    projectId,
    batchId,
    loopState,
    pausedAtStage,
    lastActionAt,
    new Date().toISOString(),
  );
}

describe('factory_status', () => {
  let testDir;

  beforeAll(() => {
    ({ testDir } = setupTestDb('factory-handlers-status'));
  });

  beforeEach(() => {
    resetTables(['factory_loop_instances', 'factory_work_items', 'factory_projects']);
    notifications.flushAllDigests();
    notifications._testing.resetAlertRuntimeState();
  });

  afterEach(() => {
    notifications.flushAllDigests();
    notifications._testing.resetAlertRuntimeState();
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('resolves factory database dependencies through injection without loading the database facade', () => {
    const handlerPath = require.resolve('../handlers/factory-handlers');
    const originalLoad = Module._load;
    const blockedRequests = [];
    const db = rawDb();
    delete require.cache[handlerPath];
    const databaseLoadSpy = vi.spyOn(Module, '_load').mockImplementation(function patchedLoad(request, parent, isMain) {
      const parentFile = parent?.filename ? parent.filename.replace(/\\/g, '/') : '';
      if (request === '../database' && parentFile.endsWith('server/handlers/factory-handlers.js')) {
        blockedRequests.push(request);
        throw new Error('factory handler should not require database facade');
      }
      return originalLoad.call(this, request, parent, isMain);
    });

    try {
      const handlers = require('../handlers/factory-handlers');
      expect(handlers.__test.ensureFactoryDecisionDb({ db })).toBe(db);
      expect(blockedRequests).toEqual([]);
    } finally {
      databaseLoadSpy.mockRestore();
      delete require.cache[handlerPath];
    }
  });

  it('reports loop fields per project and counts only stale non-idle loops as stalled', async () => {
    const db = rawDb();
    const now = new Date();
    const oldActionAt = new Date(now.getTime() - (31 * 60 * 1000)).toISOString();
    const recentActionAt = new Date(now.getTime() - (5 * 60 * 1000)).toISOString();
    const createdAt = now.toISOString();
    const insertProject = db.prepare(`
      INSERT INTO factory_projects (
        id,
        name,
        path,
        brief,
        trust_level,
        status,
        config_json,
        loop_state,
        loop_batch_id,
        loop_last_action_at,
        loop_paused_at_stage,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertProject.run(
      'project-plan-stalled',
      'Plan Stalled',
      path.join(testDir, 'project-plan-stalled'),
      'stalled plan loop',
      'supervised',
      'running',
      null,
      'PLAN',
      'batch-plan',
      oldActionAt,
      null,
      createdAt,
      createdAt,
    );
    insertActiveLoopInstance(db, {
      projectId: 'project-plan-stalled',
      loopState: 'PLAN',
      lastActionAt: oldActionAt,
      batchId: 'batch-plan',
    });
    insertProject.run(
      'project-paused-recent',
      'Paused Recent',
      path.join(testDir, 'project-paused-recent'),
      'recent paused loop',
      'guided',
      'paused',
      null,
      'PAUSED',
      'batch-paused',
      recentActionAt,
      'VERIFY_FAIL',
      createdAt,
      createdAt,
    );
    insertActiveLoopInstance(db, {
      projectId: 'project-paused-recent',
      loopState: 'PAUSED',
      pausedAtStage: 'VERIFY_FAIL',
      lastActionAt: recentActionAt,
      batchId: 'batch-paused',
    });
    insertProject.run(
      'project-idle-old',
      'Idle Old',
      path.join(testDir, 'project-idle-old'),
      'idle loop should not count',
      'autonomous',
      'running',
      null,
      'IDLE',
      null,
      oldActionAt,
      null,
      createdAt,
      createdAt,
    );

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredData).toBeDefined();

    const payload = result.structuredData;
    const projectsById = Object.fromEntries(payload.projects.map(project => [project.id, project]));

    expect(projectsById['project-plan-stalled']).toMatchObject({
      loop_state: 'PLAN',
      loop_paused_at_stage: null,
    });
    expect(projectsById['project-paused-recent']).toMatchObject({
      loop_state: 'PAUSED',
      loop_paused_at_stage: 'VERIFY_FAIL',
    });
    expect(projectsById['project-idle-old']).toMatchObject({
      loop_state: 'IDLE',
      loop_paused_at_stage: null,
    });

    for (const project of payload.projects) {
      expect(project).toHaveProperty('loop_state');
      expect(project).toHaveProperty('loop_paused_at_stage');
    }

    expect(payload.summary).toMatchObject({
      total: 3,
      running: 2,
      paused: 1,
      stalled: 1,
    });
  });

  it('exposes alert_badge and clears stale idle badges when pending work exists', async () => {
    const db = rawDb();
    const createdAt = new Date().toISOString();
    const insertProject = db.prepare(`
      INSERT INTO factory_projects (
        id,
        name,
        path,
        brief,
        trust_level,
        status,
        config_json,
        loop_state,
        loop_batch_id,
        loop_last_action_at,
        loop_paused_at_stage,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertProject.run(
      'project-idle-alert',
      'Idle Alert',
      path.join(testDir, 'project-idle-alert'),
      'idle project',
      'autonomous',
      'running',
      null,
      'IDLE',
      null,
      null,
      null,
      createdAt,
      createdAt,
    );
    insertProject.run(
      'project-pending-clears-idle',
      'Pending Clears Idle',
      path.join(testDir, 'project-pending-clears-idle'),
      'pending work clears idle badge',
      'autonomous',
      'running',
      null,
      'IDLE',
      null,
      null,
      null,
      createdAt,
      createdAt,
    );

    notifications.recordFactoryIdleState({
      project_id: 'project-idle-alert',
      pending_count: 0,
      running_count: 0,
      reason: 'no_work_item_selected',
    });
    notifications.recordFactoryIdleState({
      project_id: 'project-pending-clears-idle',
      pending_count: 0,
      running_count: 0,
      reason: 'no_work_item_selected',
    });
    factoryIntake.createWorkItem({
      project_id: 'project-pending-clears-idle',
      source: 'manual',
      title: 'Queued follow-up',
      description: 'New work arrived after idle.',
    });

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    const payload = result.structuredData;
    const projectsById = Object.fromEntries(payload.projects.map(project => [project.id, project]));

    expect(projectsById['project-idle-alert'].alert_badge).toMatchObject({
      alert_type: notifications.ALERT_TYPES.FACTORY_IDLE,
      label: 'Factory idle',
      active: true,
    });
    expect(projectsById['project-pending-clears-idle'].alert_badge).toBeNull();
    expect(notifications.getFactoryAlertBadge({ project_id: 'project-pending-clears-idle' })).toBeNull();
  });
});
