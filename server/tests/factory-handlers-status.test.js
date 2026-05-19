const path = require('path');
const { rawDb, resetTables, safeTool, setupTestDb, teardownTestDb } = require('./vitest-setup');
const factoryIntake = require('../db/factory/intake');
const factoryTick = require('../factory/factory-tick');
const notifications = require('../factory/notifications');
const { validateSchemaNode } = require('../mcp/tool-registry');
const { getOutputSchema } = require('../tool-output-schemas');

function expectStructuredDataConformsToOutputSchema(name, structuredData) {
  const schema = getOutputSchema(name);
  expect(schema).toBeDefined();
  const errors = validateSchemaNode(schema, structuredData, '$')
    .map((error) => `${error.path}: ${error.message}`);
  expect(errors).toEqual([]);
}

function insertActiveLoopInstance(db, {
  projectId,
  workItemId = null,
  loopState,
  pausedAtStage = null,
  lastActionAt = null,
  batchId = null,
}) {
  db.prepare(`
    INSERT INTO factory_loop_instances (
      id,
      project_id,
      work_item_id,
      batch_id,
      loop_state,
      paused_at_stage,
      last_action_at,
      created_at,
      terminated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    `${projectId}-instance`,
    projectId,
    workItemId,
    batchId,
    loopState,
    pausedAtStage,
    lastActionAt,
    new Date().toISOString(),
  );
}

function insertFactoryProject(db, {
  id,
  name,
  status = 'running',
  loopState = 'IDLE',
  loopBatchId = null,
  loopLastActionAt = null,
  loopPausedAtStage = null,
  trustLevel = 'autonomous',
  configJson = null,
  testDir,
}) {
  const createdAt = new Date().toISOString();
  db.prepare(`
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
  `).run(
    id,
    name,
    path.join(testDir, id),
    `${name} test project`,
    trustLevel,
    status,
    configJson,
    loopState,
    loopBatchId,
    loopLastActionAt,
    loopPausedAtStage,
    createdAt,
    createdAt,
  );
}

async function withFactoryProjectWorkDisabled(fn) {
  const previous = process.env.TORQUE_FACTORY_PROJECT_WORK_ENABLED;
  process.env.TORQUE_FACTORY_PROJECT_WORK_ENABLED = '0';
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.TORQUE_FACTORY_PROJECT_WORK_ENABLED;
    } else {
      process.env.TORQUE_FACTORY_PROJECT_WORK_ENABLED = previous;
    }
  }
}

describe('factory_status', () => {
  let testDir;

  beforeAll(() => {
    ({ testDir } = setupTestDb('factory-handlers-status'));
  });

  beforeEach(() => {
    resetTables(['tasks', 'factory_loop_instances', 'factory_work_items', 'factory_projects']);
    factoryTick.stopAll();
    notifications.flushAllDigests();
    notifications._testing.resetAlertRuntimeState();
  });

  afterEach(() => {
    factoryTick.stopAll();
    notifications.flushAllDigests();
    notifications._testing.resetAlertRuntimeState();
  });

  afterAll(() => {
    teardownTestDb();
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
      'project-paused-execute-old',
      'Paused Execute Old',
      path.join(testDir, 'project-paused-execute-old'),
      'paused project with stale execute loop',
      'guided',
      'paused',
      null,
      'EXECUTE',
      'batch-paused-execute',
      oldActionAt,
      null,
      createdAt,
      createdAt,
    );
    insertActiveLoopInstance(db, {
      projectId: 'project-paused-execute-old',
      loopState: 'EXECUTE',
      lastActionAt: oldActionAt,
      batchId: 'batch-paused-execute',
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
    insertProject.run(
      'project-starved-old',
      'Starved Old',
      path.join(testDir, 'project-starved-old'),
      'starved loop should not count as stalled',
      'autonomous',
      'running',
      null,
      'STARVED',
      null,
      oldActionAt,
      null,
      createdAt,
      createdAt,
    );
    insertActiveLoopInstance(db, {
      projectId: 'project-starved-old',
      loopState: 'STARVED',
      lastActionAt: oldActionAt,
    });

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
    expect(projectsById['project-paused-execute-old']).toMatchObject({
      status: 'paused',
      loop_state: 'EXECUTE',
    });
    expect(projectsById['project-idle-old']).toMatchObject({
      loop_state: 'IDLE',
      loop_paused_at_stage: null,
    });
    expect(projectsById['project-starved-old']).toMatchObject({
      loop_state: 'STARVED',
      loop_paused_at_stage: null,
    });

    for (const project of payload.projects) {
      expect(project).toHaveProperty('loop_state');
      expect(project).toHaveProperty('loop_paused_at_stage');
      expect(project).toHaveProperty('health_model_status');
      expect(project).toHaveProperty('health_missing_dimensions');
    }

    expect(projectsById['project-idle-old']).toMatchObject({
      dimension_count: 0,
      health_model_status: 'missing',
    });
    expect(projectsById['project-idle-old'].health_missing_dimensions).toContain('build_ci');

    expect(payload.summary).toMatchObject({
      total: 5,
      running: 3,
      paused: 2,
      stalled: 1,
    });
  });

  it('does not report a running execute loop as stalled while its batch still has live tasks', async () => {
    const db = rawDb();
    const now = new Date();
    const oldActionAt = new Date(now.getTime() - (45 * 60 * 1000)).toISOString();
    const createdAt = now.toISOString();

    db.prepare(`
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
    `).run(
      'project-active-batch',
      'Active Batch',
      path.join(testDir, 'project-active-batch'),
      'active batch should suppress stalled status',
      'autonomous',
      'running',
      null,
      'EXECUTE',
      'batch-active',
      oldActionAt,
      null,
      createdAt,
      createdAt,
    );
    insertActiveLoopInstance(db, {
      projectId: 'project-active-batch',
      loopState: 'EXECUTE',
      lastActionAt: oldActionAt,
      batchId: 'batch-active',
    });
    db.prepare('INSERT INTO tasks (id, task_description, status, tags, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        'task-active-batch',
        'Active factory batch task',
        'running',
        JSON.stringify(['factory:batch_id=batch-active']),
        createdAt,
      );

    notifications.notifyFactoryStalled({
      project_id: 'project-active-batch',
      stalled_minutes: 45,
      threshold_minutes: 30,
      stage: 'EXECUTE',
      instance_id: 'project-active-batch-instance',
      batch_id: 'batch-active',
      last_action_at: oldActionAt,
    });

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredData.summary.stalled).toBe(0);
    const project = result.structuredData.projects.find((item) => item.id === 'project-active-batch');
    expect(project.alert_badge).toBeNull();
    expect(project).not.toHaveProperty('_has_non_terminal_batch_tasks');
  });

  it('surfaces active plan generation as the effective active stage', async () => {
    const db = rawDb();
    const createdAt = new Date().toISOString();
    const planTaskId = '11111111-1111-1111-1111-111111111111';

    db.prepare(`
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
    `).run(
      'project-plan-generation',
      'Plan Generation',
      path.join(testDir, 'project-plan-generation'),
      'execute loop waiting on generated plan',
      'autonomous',
      'running',
      null,
      'EXECUTE',
      'batch-plan-generation',
      createdAt,
      null,
      createdAt,
      createdAt,
    );

    const workItem = factoryIntake.createWorkItem({
      project_id: 'project-plan-generation',
      source: 'manual',
      title: 'Implement status coherence',
      description: 'Generate the concrete execution plan before edits.',
      status: 'executing',
      origin: {
        plan_generation_task_id: planTaskId,
        plan_generation_status: 'submitted',
      },
    });
    insertActiveLoopInstance(db, {
      projectId: 'project-plan-generation',
      workItemId: workItem.id,
      loopState: 'EXECUTE',
      lastActionAt: createdAt,
      batchId: 'batch-plan-generation',
    });
    db.prepare(`
      INSERT INTO tasks (id, task_description, status, provider, tags, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      planTaskId,
      'Generate factory plan',
      'running',
      'codex',
      JSON.stringify(['factory:kind=plan_generation']),
      createdAt,
    );

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    const payload = result.structuredData;
    const project = payload.projects.find((item) => item.id === 'project-plan-generation');
    expect(project).toMatchObject({
      loop_state: 'EXECUTE',
      active_stage: 'PLAN',
      active_task: {
        id: planTaskId,
        kind: 'plan_generation',
        status: 'running',
        provider: 'codex',
      },
      state_consistency: {
        ok: true,
        project_loop_state: 'EXECUTE',
        instance_loop_state: 'EXECUTE',
        active_stage: 'PLAN',
      },
    });
    expect(project.state_consistency.mismatches).toEqual([]);
    expect(payload.summary).toMatchObject({
      active_internal_tasks: 1,
      state_mismatch_projects: 0,
    });
  });

  it('infers active plan generation from project and work-item tags when origin lacks task id', async () => {
    const db = rawDb();
    const createdAt = new Date().toISOString();
    const planTaskId = '11111111-1111-1111-1111-111111111112';
    const architectTaskId = '11111111-1111-1111-1111-111111111113';

    db.prepare(`
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
    `).run(
      'project-plan-generation-tags',
      'Plan Generation Tags',
      path.join(testDir, 'project-plan-generation-tags'),
      'execute loop waiting on tagged generated plan',
      'autonomous',
      'running',
      null,
      'EXECUTE',
      null,
      createdAt,
      null,
      createdAt,
      createdAt,
    );
    const workItem = factoryIntake.createWorkItem({
      project_id: 'project-plan-generation-tags',
      source: 'manual',
      title: 'Implement tagged status coherence',
      description: 'The plan generation task is only linked through tags.',
      status: 'executing',
    });
    insertActiveLoopInstance(db, {
      projectId: 'project-plan-generation-tags',
      workItemId: workItem.id,
      loopState: 'EXECUTE',
      lastActionAt: createdAt,
    });
    db.prepare(`
      INSERT INTO tasks (id, task_description, status, provider, tags, created_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      architectTaskId,
      'Older architect cycle',
      'queued',
      'codex',
      JSON.stringify([
        'factory:internal',
        'factory:architect_cycle',
        'factory:project_id=project-plan-generation-tags',
      ]),
      createdAt,
      null,
    );
    db.prepare(`
      INSERT INTO tasks (id, task_description, status, provider, model, tags, created_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      planTaskId,
      'Generate factory plan from tags',
      'running',
      'codex',
      'gpt-5.5',
      JSON.stringify([
        'factory:internal',
        'factory:plan_generation',
        'factory:project_id=project-plan-generation-tags',
        `factory:work_item_id=${workItem.id}`,
      ]),
      createdAt,
      createdAt,
    );

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    const payload = result.structuredData;
    const project = payload.projects.find((item) => item.id === 'project-plan-generation-tags');
    expect(project).toMatchObject({
      loop_state: 'EXECUTE',
      active_stage: 'PLAN',
      active_task: {
        id: planTaskId,
        kind: 'plan_generation',
        status: 'running',
        provider: 'codex',
        model: 'gpt-5.5',
      },
      state_consistency: {
        ok: true,
        project_loop_state: 'EXECUTE',
        instance_loop_state: 'EXECUTE',
        active_stage: 'PLAN',
      },
    });
    expect(project.state_consistency.mismatches).toEqual([]);
    expect(payload.summary).toMatchObject({
      active_internal_tasks: 1,
      state_mismatch_projects: 0,
    });
  });

  it('surfaces active architect tasks as PLAN-stage work', async () => {
    const db = rawDb();
    const createdAt = new Date().toISOString();
    const olderTaskAt = new Date(Date.now() - 60_000).toISOString();
    const currentTaskAt = new Date(Date.now() - 1_000).toISOString();
    const currentArchitectTaskId = '33333333-3333-3333-3333-333333333333';

    db.prepare(`
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
    `).run(
      'project-architect-active',
      'Architect Active',
      path.join(testDir, 'project-architect-active'),
      'plan loop waiting on architect work',
      'autonomous',
      'running',
      null,
      'PLAN',
      null,
      createdAt,
      null,
      createdAt,
      createdAt,
    );
    const workItem = factoryIntake.createWorkItem({
      project_id: 'project-architect-active',
      source: 'manual',
      title: 'Split command handlers',
      description: 'Use architect output to build a concrete plan.',
      status: 'prioritized',
    });
    insertActiveLoopInstance(db, {
      projectId: 'project-architect-active',
      workItemId: workItem.id,
      loopState: 'PLAN',
      lastActionAt: createdAt,
    });
    db.prepare(`
      INSERT INTO tasks (id, task_description, status, provider, tags, created_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      '22222222-3333-3333-3333-333333333333',
      'Older architect cycle',
      'queued',
      'codex',
      JSON.stringify([
        'factory:internal',
        'factory:architect_cycle',
        'factory:project_id=project-architect-active',
      ]),
      olderTaskAt,
      null,
    );
    db.prepare(`
      INSERT INTO tasks (id, task_description, status, provider, tags, created_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      currentArchitectTaskId,
      'Current architect cycle',
      'queued',
      'codex',
      JSON.stringify([
        'factory:internal',
        'factory:architect_cycle',
        'factory:project_id=project-architect-active',
      ]),
      currentTaskAt,
      null,
    );

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    const payload = result.structuredData;
    const project = payload.projects.find((item) => item.id === 'project-architect-active');
    expect(project).toMatchObject({
      loop_state: 'PLAN',
      active_stage: 'PLAN',
      active_task: {
        id: currentArchitectTaskId,
        kind: 'architect_cycle',
        status: 'queued',
        provider: 'codex',
      },
      state_consistency: {
        ok: true,
        project_loop_state: 'PLAN',
        instance_loop_state: 'PLAN',
        active_stage: 'PLAN',
      },
    });
    expect(project.state_consistency.mismatches).toEqual([]);
    expect(payload.summary).toMatchObject({
      active_internal_tasks: 1,
      state_mismatch_projects: 0,
    });
  });

  it('surfaces active execution batch tasks under EXECUTE loops', async () => {
    const db = rawDb();
    const createdAt = new Date().toISOString();
    const batchTaskId = '22222222-2222-2222-2222-222222222222';
    const newerBatchTaskId = '22222222-2222-2222-2222-222222222223';
    const newerTaskAt = new Date(Date.now() + 1_000).toISOString();
    const batchId = 'factory-project-execution-1';

    db.prepare(`
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
    `).run(
      'project-execution-active',
      'Execution Active',
      path.join(testDir, 'project-execution-active'),
      'execute-stage active batch task view',
      'dark',
      'running',
      null,
      'EXECUTE',
      batchId,
      createdAt,
      null,
      createdAt,
      createdAt,
    );
    insertActiveLoopInstance(db, {
      projectId: 'project-execution-active',
      loopState: 'EXECUTE',
      lastActionAt: createdAt,
      batchId,
    });
    db.prepare(`
      INSERT INTO tasks (id, task_description, status, provider, tags, created_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchTaskId,
      'Implement selected factory work item',
      'running',
      'codex',
      JSON.stringify([`factory:batch_id=${batchId}`, 'factory:work_item_id=42', 'project:example']),
      createdAt,
      createdAt,
    );
    db.prepare(`
      INSERT INTO tasks (id, task_description, status, provider, tags, created_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      newerBatchTaskId,
      'Implement later factory work item',
      'running',
      'codex',
      JSON.stringify([`factory:batch_id=${batchId}`, 'factory:work_item_id=43', 'project:example']),
      newerTaskAt,
      newerTaskAt,
    );

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    const payload = result.structuredData;
    const project = payload.projects.find((item) => item.id === 'project-execution-active');
    expect(project).toMatchObject({
      loop_state: 'EXECUTE',
      active_stage: 'EXECUTE',
      active_task: {
        id: batchTaskId,
        kind: 'execution',
        status: 'running',
        provider: 'codex',
      },
      state_consistency: {
        ok: true,
        project_loop_state: 'EXECUTE',
        instance_loop_state: 'EXECUTE',
        active_stage: 'EXECUTE',
      },
    });
    expect(project.state_consistency.mismatches).toEqual([]);
    expect(payload.summary).toMatchObject({
      active_internal_tasks: 0,
      active_project_tasks: 1,
      state_mismatch_projects: 0,
    });
  });

  it('treats paused legacy project rows as consistent with the active instance stage', async () => {
    const db = rawDb();
    const createdAt = new Date().toISOString();

    db.prepare(`
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
    `).run(
      'project-paused-execute',
      'Paused Execute',
      path.join(testDir, 'project-paused-execute'),
      'legacy paused execute view',
      'dark',
      'running',
      null,
      'PAUSED',
      'batch-paused-execute',
      createdAt,
      'EXECUTE',
      createdAt,
      createdAt,
    );
    insertActiveLoopInstance(db, {
      projectId: 'project-paused-execute',
      loopState: 'EXECUTE',
      pausedAtStage: 'EXECUTE',
      lastActionAt: createdAt,
      batchId: 'batch-paused-execute',
    });

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    const payload = result.structuredData;
    const project = payload.projects.find((item) => item.id === 'project-paused-execute');
    expect(project).toMatchObject({
      loop_state: 'EXECUTE',
      loop_paused_at_stage: 'EXECUTE',
      state_consistency: {
        ok: true,
        project_loop_state: 'EXECUTE',
        instance_loop_state: 'EXECUTE',
        active_stage: 'EXECUTE',
        mismatches: [],
      },
    });
    expect(payload.summary).toMatchObject({
      state_mismatch_projects: 0,
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

  it('clears stale stall badges for projects that are no longer stallable', async () => {
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
      'project-cleared-idle-stall',
      'Cleared Idle Stall',
      path.join(testDir, 'project-cleared-idle-stall'),
      'old stall badge but no active loop',
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
      'project-cleared-starved-stall',
      'Cleared Starved Stall',
      path.join(testDir, 'project-cleared-starved-stall'),
      'old stall badge but starved loop',
      'autonomous',
      'running',
      null,
      'STARVED',
      null,
      createdAt,
      null,
      createdAt,
      createdAt,
    );
    insertProject.run(
      'project-cleared-paused-stall',
      'Cleared Paused Stall',
      path.join(testDir, 'project-cleared-paused-stall'),
      'old stall badge but project paused',
      'autonomous',
      'paused',
      null,
      'EXECUTE',
      null,
      createdAt,
      null,
      createdAt,
      createdAt,
    );
    insertActiveLoopInstance(db, {
      projectId: 'project-cleared-starved-stall',
      loopState: 'STARVED',
      lastActionAt: createdAt,
    });
    insertActiveLoopInstance(db, {
      projectId: 'project-cleared-paused-stall',
      loopState: 'EXECUTE',
      lastActionAt: createdAt,
    });

    for (const projectId of [
      'project-cleared-idle-stall',
      'project-cleared-starved-stall',
      'project-cleared-paused-stall',
    ]) {
      notifications.notifyFactoryStalled({
        project_id: projectId,
        stalled_minutes: 45,
        threshold_minutes: 30,
        stage: 'EXECUTE',
        instance_id: `${projectId}-old-instance`,
        last_action_at: createdAt,
      });
    }

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    const projectsById = Object.fromEntries(result.structuredData.projects.map(project => [project.id, project]));

    for (const projectId of [
      'project-cleared-idle-stall',
      'project-cleared-starved-stall',
      'project-cleared-paused-stall',
    ]) {
      expect(projectsById[projectId].alert_badge).toBeNull();
      expect(notifications.getFactoryAlertBadge({ project_id: projectId })).toBeNull();
    }
  });

  it('explains factory idle when every project is paused and the task queue is empty', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-paused-one',
      name: 'Paused One',
      status: 'paused',
      testDir,
    });
    insertFactoryProject(db, {
      id: 'project-paused-two',
      name: 'Paused Two',
      status: 'paused',
      testDir,
    });

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    const diagnosis = result.structuredData.summary.idle_diagnosis;
    expect(diagnosis).toMatchObject({
      idle: true,
      reason_code: 'all_projects_paused',
      counts: {
        total_projects: 2,
        running_projects: 0,
        paused_projects: 2,
        active_loop_projects: 0,
        open_work_items: 0,
        task_queue: {
          total_non_terminal: 0,
          schedulable: 0,
          manual_gate_pending: 0,
        },
      },
    });
    expect(diagnosis.project_ids.paused).toEqual(expect.arrayContaining(['project-paused-one', 'project-paused-two']));
    expect(diagnosis.project_ids.active_loops).toEqual([]);
    expect(diagnosis.actions).toContainEqual(expect.objectContaining({
      type: 'factory_automation_plan',
      effect_scope: 'control_plane',
      processes_project_work: false,
      project_ids: expect.arrayContaining(['project-paused-one', 'project-paused-two']),
    }));
    expect(result.structuredData.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'project-paused-one', open_work_item_count: 0 }),
      expect.objectContaining({ id: 'project-paused-two', open_work_item_count: 0 }),
    ]));
  });

  it('does not count project-paused waiting tasks as schedulable factory work', async () => {
    const db = rawDb();
    const createdAt = new Date().toISOString();

    insertFactoryProject(db, {
      id: 'project-paused-waiting',
      name: 'Paused Waiting',
      status: 'paused',
      testDir,
    });
    db.prepare(`
      INSERT INTO tasks (id, task_description, status, provider, tags, pause_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'task-project-paused-waiting',
      'Parked task for paused project',
      'waiting',
      'codex',
      JSON.stringify(['factory:internal', 'factory:project_id=project-paused-waiting']),
      'factory_project_paused',
      createdAt,
    );

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredData.summary.idle_diagnosis).toMatchObject({
      idle: true,
      reason_code: 'all_projects_paused',
      counts: {
        task_queue: {
          by_status: {
            waiting: 1,
          },
          total_non_terminal: 1,
          schedulable: 0,
          project_paused_waiting: 1,
        },
      },
    });
  });

  it('does not report idle while schedulable tasks remain queued', async () => {
    const db = rawDb();
    const createdAt = new Date().toISOString();

    insertFactoryProject(db, {
      id: 'project-queued-work',
      name: 'Queued Work',
      status: 'running',
      testDir,
    });
    db.prepare('INSERT INTO tasks (id, task_description, status, provider, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        'task-queued-work',
        'Queued factory work',
        'queued',
        'codex',
        JSON.stringify(['factory:internal', 'factory:project_id=project-queued-work']),
        createdAt,
      );

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredData.summary.idle_diagnosis).toMatchObject({
      idle: false,
      reason_code: 'queue_has_work',
      counts: {
        running_projects: 1,
        task_queue: {
          by_status: {
            queued: 1,
          },
          total_non_terminal: 1,
          schedulable: 1,
        },
      },
    });
  });

  it('keeps operator-paused projects idle even when stale loop instances remain active', async () => {
    const db = rawDb();
    const createdAt = new Date().toISOString();

    insertFactoryProject(db, {
      id: 'project-paused-active-loop',
      name: 'Paused Active Loop',
      status: 'paused',
      loopState: 'EXECUTE',
      loopLastActionAt: createdAt,
      testDir,
    });
    insertActiveLoopInstance(db, {
      projectId: 'project-paused-active-loop',
      loopState: 'EXECUTE',
      lastActionAt: createdAt,
      batchId: 'batch-paused-active-loop',
    });
    db.prepare('INSERT INTO tasks (id, task_description, status, provider, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        'task-paused-waiting',
        'Waiting task for paused project',
        'waiting',
        'codex',
        JSON.stringify(['factory:internal', 'factory:project_id=project-paused-active-loop']),
        createdAt,
      );

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredData.summary.idle_diagnosis).toMatchObject({
      idle: true,
      reason_code: 'all_projects_paused',
      counts: {
        paused_projects: 1,
        active_loop_projects: 0,
        paused_active_loop_projects: 1,
        task_queue: {
          by_status: {
            waiting: 1,
          },
          schedulable: 1,
        },
      },
      project_ids: {
        active_loops: [],
        paused_active_loops: ['project-paused-active-loop'],
      },
    });
  });

  it('recommends the automation plan instead of direct loop start when work is waiting', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-work-waiting',
      name: 'Work Waiting',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: true } }),
      testDir,
    });
    factoryIntake.createWorkItem({
      project_id: 'project-work-waiting',
      source: 'manual',
      title: 'Waiting work item',
      description: 'Exercise idle diagnosis control-plane recommendation.',
      requestor: 'test',
    });

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    const diagnosis = result.structuredData.summary.idle_diagnosis;
    expect(diagnosis).toMatchObject({
      idle: true,
      reason_code: 'work_waiting_for_loop',
      counts: {
        running_projects: 1,
        open_work_items: 1,
      },
    });
    expect(diagnosis.actions).toContainEqual(expect.objectContaining({
      type: 'factory_automation_plan',
      effect_scope: 'control_plane',
      mutates_control_plane: false,
      processes_project_work: false,
      project_ids: ['project-work-waiting'],
    }));
    expect(diagnosis.actions).not.toContainEqual(expect.objectContaining({
      type: 'start_factory_loop',
    }));
  });

  it('adds idle diagnosis to lightweight project lists when requested', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-list-paused',
      name: 'Project List Paused',
      status: 'paused',
      testDir,
    });

    const result = await safeTool('list_factory_projects', {
      summary: 'basic',
      include_idle_diagnosis: true,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredData.projects).toEqual([
      expect.objectContaining({
        id: 'project-list-paused',
        status: 'paused',
        loop_state: 'IDLE',
      }),
    ]);
    expect(result.structuredData.idle_diagnosis).toMatchObject({
      idle: true,
      reason_code: 'all_projects_paused',
      counts: {
        total_projects: 1,
        paused_projects: 1,
      },
    });
  });

  it('adds automation readiness to project lists only when requested', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-list-ready',
      name: 'Project List Ready',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: true } }),
      testDir,
    });
    factoryIntake.createWorkItem({
      project_id: 'project-list-ready',
      source: 'manual',
      title: 'Queued list item',
      description: 'Should appear in project-list work-item counts.',
      status: 'needs_replan',
    });

    const defaultResult = await safeTool('list_factory_projects', { summary: 'basic' });
    const enrichedResult = await safeTool('list_factory_projects', {
      summary: 'basic',
      include_automation_readiness: true,
    });

    expect(defaultResult.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('list_factory_projects', defaultResult.structuredData);
    expect(defaultResult.structuredData.projects[0].automation_readiness).toBeUndefined();
    expect(defaultResult.structuredData.automation_readiness).toBeUndefined();
    expect(enrichedResult.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('list_factory_projects', enrichedResult.structuredData);
    expect(enrichedResult.structuredData.projects[0]).toMatchObject({
      id: 'project-list-ready',
      open_work_item_count: 1,
      work_item_status_counts: {
        needs_replan: 1,
      },
      automation_readiness: {
        ready: true,
        blocker_codes: [],
        control_plane_plan: [],
      },
    });
    expect(enrichedResult.structuredData.automation_readiness).toMatchObject({
      ready: true,
      total_projects: 1,
      ready_projects: 1,
      blocked_projects: 0,
      control_plane_plan: [
        {
          action: 'arm_factory_tick immediate=false',
          tool: 'arm_factory_tick',
          args: {
            project: 'project-list-ready',
            immediate: false,
          },
          description: expect.any(String),
          effect_scope: 'control_plane',
          mutates_control_plane: true,
          processes_project_work: false,
          enables_future_processing: true,
        },
      ],
    });
  });

  it('reports an executable control-plane action for auto-continue blockers', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-dark-no-continue',
      name: 'Dark Without Continue',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: false } }),
      testDir,
    });

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('factory_status', result.structuredData);
    expect(result.structuredData.projects[0].automation_readiness).toMatchObject({
      ready: false,
      trust_level: 'dark',
      auto_continue: false,
      approval_gates: [],
      blocker_codes: ['auto_continue_disabled'],
      next_control_plane_action: 'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
      control_plane_actions: ['set_factory_trust_level trust_level=dark config.loop.auto_continue=true'],
      control_plane_plan: [
        {
          action: 'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
          tool: 'set_factory_trust_level',
          args: {
            project: 'project-dark-no-continue',
            trust_level: 'dark',
            config: { loop: { auto_continue: true } },
          },
          description: expect.any(String),
          effect_scope: 'control_plane',
          mutates_control_plane: true,
          processes_project_work: false,
          enables_future_processing: true,
        },
      ],
    });
    expect(result.structuredData.summary.automation_readiness.control_plane_plan).toMatchObject([
      {
        action: 'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
        tool: 'set_factory_trust_level',
        args: {
          project: 'project-dark-no-continue',
          trust_level: 'dark',
          config: { loop: { auto_continue: true } },
        },
      },
      {
        action: 'arm_factory_tick immediate=false',
        tool: 'arm_factory_tick',
        args: {
          project: 'project-dark-no-continue',
          immediate: false,
        },
        effect_scope: 'control_plane',
        mutates_control_plane: true,
        processes_project_work: false,
        enables_future_processing: true,
      },
    ]);
  });

  it('does not mark string auto-continue config values as automation-ready', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-string-continue',
      name: 'String Continue',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: 'true' } }),
      testDir,
    });

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredData.projects[0].automation_readiness).toMatchObject({
      ready: false,
      auto_continue: false,
      blocker_codes: ['auto_continue_disabled'],
      next_control_plane_action: 'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
      control_plane_actions: ['set_factory_trust_level trust_level=dark config.loop.auto_continue=true'],
    });
  });

  it('combines trust and auto-continue blockers into one readiness action', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-gated-no-continue',
      name: 'Gated Without Continue',
      status: 'running',
      trustLevel: 'autonomous',
      configJson: JSON.stringify({ loop: { auto_continue: false } }),
      testDir,
    });

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredData.projects[0].automation_readiness).toMatchObject({
      ready: false,
      trust_level: 'autonomous',
      auto_continue: false,
      approval_gates: ['LEARN'],
      blocker_codes: [
        'auto_continue_disabled',
        'approval_gates_enabled',
      ],
      next_control_plane_action: 'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
      control_plane_actions: ['set_factory_trust_level trust_level=dark config.loop.auto_continue=true'],
      control_plane_plan: [
        {
          action: 'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
          tool: 'set_factory_trust_level',
          args: {
            project: 'project-gated-no-continue',
            trust_level: 'dark',
            config: { loop: { auto_continue: true } },
          },
          description: expect.any(String),
        },
      ],
    });
  });

  it('reports automation readiness without processing projects', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-ready-dark',
      name: 'Ready Dark',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: true } }),
      testDir,
    });
    insertFactoryProject(db, {
      id: 'project-operator-paused',
      name: 'Operator Paused',
      status: 'paused',
      trustLevel: 'autonomous',
      configJson: JSON.stringify({
        loop: {
          auto_continue: false,
          operator_paused: true,
          operator_pause_reason: 'maintenance',
        },
      }),
      testDir,
    });
    factoryIntake.createWorkItem({
      project_id: 'project-ready-dark',
      source: 'manual',
      title: 'Ready pending item',
      description: 'Pending item should count as open work.',
      status: 'pending',
    });
    factoryIntake.createWorkItem({
      project_id: 'project-operator-paused',
      source: 'manual',
      title: 'Paused needs review item',
      description: 'Needs review should be visible in status counts.',
      status: 'needs_review',
    });
    factoryIntake.createWorkItem({
      project_id: 'project-operator-paused',
      source: 'manual',
      title: 'Paused needs replan item',
      description: 'Needs replan should be visible in status counts.',
      status: 'needs_replan',
    });

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    const projectsById = Object.fromEntries(result.structuredData.projects.map(project => [project.id, project]));
    expect(projectsById['project-ready-dark']).toMatchObject({
      open_work_item_count: 1,
      work_item_status_counts: { pending: 1 },
    });
    expect(projectsById['project-ready-dark'].automation_readiness).toMatchObject({
      ready: true,
      status: 'running',
      trust_level: 'dark',
      auto_continue: true,
      operator_paused: false,
      approval_gates: [],
      blocker_codes: [],
      next_control_plane_action: null,
      control_plane_actions: [],
      control_plane_plan: [],
    });
    expect(projectsById['project-operator-paused']).toMatchObject({
      open_work_item_count: 1,
      work_item_status_counts: {
        needs_review: 1,
        needs_replan: 1,
      },
    });
    expect(projectsById['project-operator-paused'].automation_readiness).toMatchObject({
      ready: false,
      status: 'paused',
      trust_level: 'autonomous',
      auto_continue: false,
      operator_paused: true,
      approval_gates: ['LEARN'],
      blocker_codes: [
        'operator_paused',
        'project_not_running',
        'auto_continue_disabled',
        'approval_gates_enabled',
      ],
      next_control_plane_action: 'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
      control_plane_actions: [
        'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
        'resume_project with clear_operator_pause=true immediate_tick=false',
      ],
      control_plane_plan: [
        {
          action: 'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
          tool: 'set_factory_trust_level',
          args: {
            project: 'project-operator-paused',
            trust_level: 'dark',
            config: { loop: { auto_continue: true } },
          },
          description: expect.any(String),
          effect_scope: 'control_plane',
          mutates_control_plane: true,
          processes_project_work: false,
          enables_future_processing: true,
        },
        {
          action: 'resume_project with clear_operator_pause=true immediate_tick=false',
          tool: 'resume_project',
          args: {
            project: 'project-operator-paused',
            clear_operator_pause: true,
            immediate_tick: false,
          },
          description: expect.any(String),
          effect_scope: 'control_plane',
          mutates_control_plane: true,
          processes_project_work: false,
          enables_future_processing: true,
        },
      ],
    });
    expect(result.structuredData.summary.automation_readiness).toMatchObject({
      ready: false,
      hands_off_ready: false,
      total_projects: 2,
      ready_projects: 1,
      blocked_projects: 1,
      auto_continue_enabled_projects: 1,
      dark_trust_projects: 1,
      operator_paused_projects: 1,
      approval_gated_projects: 1,
      blockers: {
        operator_paused: 1,
        project_not_running: 1,
        auto_continue_disabled: 1,
        approval_gates_enabled: 1,
      },
      project_ids: {
        ready: ['project-ready-dark'],
        blocked: ['project-operator-paused'],
      },
      manual_intervention: {
        required: true,
        reason_codes: expect.arrayContaining([
          'control_plane_blocked',
          'operator_paused_projects',
          'approval_gates_enabled',
          'work_items_need_review',
          'factory_tick_unarmed',
        ]),
        counts: {
          blocked_projects: 1,
          operator_paused_projects: 1,
          approval_gated_projects: 1,
          needs_review_work_items: 1,
          escalation_exhausted_work_items: 0,
          scheduler_unarmed_projects: 1,
        },
        project_ids: {
          scheduler_unarmed: ['project-ready-dark'],
        },
      },
      control_plane_plan: [
        {
          action: 'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
          tool: 'set_factory_trust_level',
          args: {
            project: 'project-operator-paused',
            trust_level: 'dark',
            config: { loop: { auto_continue: true } },
          },
          description: expect.any(String),
        },
        {
          action: 'resume_project with clear_operator_pause=true immediate_tick=false',
          tool: 'resume_project',
          args: {
            project: 'project-operator-paused',
            clear_operator_pause: true,
            immediate_tick: false,
          },
          description: expect.any(String),
        },
        {
          action: 'arm_factory_tick immediate=false',
          tool: 'arm_factory_tick',
          args: {
            project: 'project-ready-dark',
            immediate: false,
          },
          description: expect.any(String),
        },
      ],
    });
    expect(result.structuredData.summary).toMatchObject({
      needs_review_work_items: 1,
      needs_replan_work_items: 1,
      work_item_status_counts: {
        pending: 1,
        needs_review: 1,
        needs_replan: 1,
      },
    });
  });

  it('keeps control-plane readiness separate from operator-owned queue readiness', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-hands-off-blocked',
      name: 'Hands Off Blocked',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: true } }),
      testDir,
    });
    factoryIntake.createWorkItem({
      project_id: 'project-hands-off-blocked',
      source: 'manual',
      title: 'Operator review remains',
      description: 'Controls are ready but a closed manual-review row remains operator-owned.',
      status: 'needs_review',
    });

    const result = await safeTool('factory_automation_plan', {});

    expect(result.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('factory_automation_plan', result.structuredData);
    expect(result.structuredData).toMatchObject({
      ready: true,
      hands_off_ready: false,
      message: expect.stringMatching(/operator-owned work/i),
      summary: {
        ready: true,
        hands_off_ready: false,
        blocked_projects: 0,
        manual_intervention: {
          required: true,
          reason_codes: expect.arrayContaining(['work_items_need_review', 'factory_tick_unarmed']),
          counts: {
            blocked_projects: 0,
            pending_approval_tasks: 0,
            needs_review_work_items: 1,
            escalation_exhausted_work_items: 0,
            scheduler_unarmed_projects: 1,
          },
          project_ids: {
            scheduler_unarmed: ['project-hands-off-blocked'],
          },
          work_item_blockers: {
            needs_review: [
              {
                project_id: 'project-hands-off-blocked',
                project_name: 'Hands Off Blocked',
                status: 'needs_review',
                count: 1,
              },
            ],
            escalation_exhausted: [],
          },
        },
      },
      manual_intervention: {
        required: true,
        reason_codes: expect.arrayContaining(['work_items_need_review', 'factory_tick_unarmed']),
      },
      needs_review_work_items: 1,
      control_plane_plan: [
        {
          action: 'arm_factory_tick immediate=false',
          tool: 'arm_factory_tick',
          args: {
            project: 'project-hands-off-blocked',
            immediate: false,
          },
          description: expect.any(String),
          effect_scope: 'control_plane',
          mutates_control_plane: true,
          processes_project_work: false,
          enables_future_processing: true,
        },
      ],
    });
    expect(result.structuredData.projects[0]).toMatchObject({
      id: 'project-hands-off-blocked',
      automation_readiness: {
        ready: true,
      },
      open_work_item_count: 0,
      work_item_status_counts: {
        needs_review: 1,
      },
    });
  });

  it('breaks down operator-owned work item blockers by project without planning work', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-review-breakdown-a',
      name: 'Review Breakdown A',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: true } }),
      testDir,
    });
    insertFactoryProject(db, {
      id: 'project-review-breakdown-b',
      name: 'Review Breakdown B',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: true } }),
      testDir,
    });
    const reviewA = factoryIntake.createWorkItem({
      project_id: 'project-review-breakdown-a',
      source: 'manual',
      title: 'Needs review A',
      status: 'needs_review',
    });
    factoryIntake.updateWorkItem(reviewA.id, { reject_reason: 'zero_diff_across_retries' });
    const reviewB = factoryIntake.createWorkItem({
      project_id: 'project-review-breakdown-b',
      source: 'manual',
      title: 'Needs review B',
      status: 'needs_review',
    });
    factoryIntake.updateWorkItem(reviewB.id, { reject_reason: 'plan_quality_gate_rejected_after_intrabatch_retries' });
    const exhaustedB = factoryIntake.createWorkItem({
      project_id: 'project-review-breakdown-b',
      source: 'manual',
      title: 'Escalation exhausted B',
      status: 'escalation_exhausted',
    });
    factoryIntake.updateWorkItem(exhaustedB.id, {
      reject_reason: 'escalation_exhausted: chain_exhausted after 3x same-shape (cannot_generate_plan)',
    });
    const secondExhaustedB = factoryIntake.createWorkItem({
      project_id: 'project-review-breakdown-b',
      source: 'manual',
      title: 'Escalation exhausted B again',
      status: 'escalation_exhausted',
    });
    factoryIntake.updateWorkItem(secondExhaustedB.id, {
      reject_reason: 'escalation_exhausted: chain_exhausted after 3x same-shape (cannot_generate_plan)',
    });

    const result = await safeTool('factory_automation_plan', {});

    expect(result.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('factory_automation_plan', result.structuredData);
    expect(result.structuredData.summary.manual_intervention).toMatchObject({
      required: true,
      reason_codes: expect.arrayContaining([
        'work_items_need_review',
        'work_items_escalation_exhausted',
      ]),
      counts: {
        needs_review_work_items: 2,
        escalation_exhausted_work_items: 2,
      },
      work_item_blockers: {
        needs_review: expect.arrayContaining([
          {
            project_id: 'project-review-breakdown-a',
            project_name: 'Review Breakdown A',
            status: 'needs_review',
            count: 1,
            reject_reason_counts: [
              {
                reject_reason: 'zero_diff_across_retries',
                count: 1,
              },
            ],
          },
          {
            project_id: 'project-review-breakdown-b',
            project_name: 'Review Breakdown B',
            status: 'needs_review',
            count: 1,
            reject_reason_counts: [
              {
                reject_reason: 'plan_quality_gate_rejected_after_intrabatch_retries',
                count: 1,
              },
            ],
          },
        ]),
        escalation_exhausted: [
          {
            project_id: 'project-review-breakdown-b',
            project_name: 'Review Breakdown B',
            status: 'escalation_exhausted',
            count: 2,
            reject_reason_counts: [
              {
                reject_reason: 'escalation_exhausted: chain_exhausted after 3x same-shape (cannot_generate_plan)',
                count: 2,
              },
            ],
          },
        ],
      },
    });
    expect(result.structuredData.summary.control_plane_plan.every(
      (step) => step.processes_project_work === false
    )).toBe(true);
  });

  it('reports global project-work disablement without changing project-level readiness', async () => {
    await withFactoryProjectWorkDisabled(async () => {
      const db = rawDb();
      insertFactoryProject(db, {
        id: 'project-work-disabled-ready',
        name: 'Work Disabled Ready',
        status: 'running',
        trustLevel: 'dark',
        configJson: JSON.stringify({ loop: { auto_continue: true } }),
        testDir,
      });

      const result = await safeTool('factory_automation_plan', {});

      expect(result.isError).toBeFalsy();
      expectStructuredDataConformsToOutputSchema('factory_automation_plan', result.structuredData);
      expect(result.structuredData).toMatchObject({
        ready: true,
        hands_off_ready: false,
        summary: {
          ready: true,
          hands_off_ready: false,
          project_work_enabled: false,
          manual_intervention: {
            required: true,
            reason_codes: expect.arrayContaining([
              'factory_project_work_disabled',
              'factory_tick_unarmed',
            ]),
            counts: {
              factory_project_work_enabled: 0,
              scheduler_unarmed_projects: 1,
            },
          },
        },
        projects: [
          {
            id: 'project-work-disabled-ready',
            automation_readiness: {
              ready: true,
            },
          },
        ],
      });
    });
  });

  it('blocks manual project-processing factory loop tools when project work is disabled', async () => {
    await withFactoryProjectWorkDisabled(async () => {
      const db = rawDb();
      insertFactoryProject(db, {
        id: 'project-work-disabled-manual',
        name: 'Work Disabled Manual',
        status: 'running',
        trustLevel: 'dark',
        configJson: JSON.stringify({
          loop: { auto_continue: true },
          baseline_broken_since: new Date().toISOString(),
          baseline_verify_command: 'echo ok',
        }),
        testDir,
      });
      insertActiveLoopInstance(db, {
        projectId: 'project-work-disabled-manual',
        loopState: 'VERIFY',
        pausedAtStage: 'VERIFY_FAIL',
        batchId: 'factory-disabled-manual-batch',
      });

      const blockedCalls = [
        ['start_factory_loop', { project: 'project-work-disabled-manual' }],
        ['advance_factory_loop', { project: 'project-work-disabled-manual' }],
        ['approve_factory_gate', { project: 'project-work-disabled-manual', stage: 'PLAN' }],
        ['retry_factory_verify', { project: 'project-work-disabled-manual' }],
        ['resume_project_baseline_fixed', { project: 'project-work-disabled-manual' }],
        ['scan_project_health', { project: 'project-work-disabled-manual' }],
        ['poll_github_issues', { project: 'project-work-disabled-manual' }],
        ['trigger_architect', { project: 'project-work-disabled-manual' }],
        ['start_factory_loop_instance', { project: 'project-work-disabled-manual' }],
        ['advance_factory_loop_instance', { instance: 'project-work-disabled-manual-instance' }],
        ['approve_factory_gate_instance', { instance: 'project-work-disabled-manual-instance', stage: 'PLAN' }],
        ['retry_factory_verify_instance', { instance: 'project-work-disabled-manual-instance' }],
        ['attach_factory_batch', { project: 'project-work-disabled-manual', batch_id: 'factory-disabled-manual-batch' }],
      ];

      for (const [tool, args] of blockedCalls) {
        const result = await safeTool(tool, args);
        expect(result.isError).toBe(true);
        expect(result.error_code).toBe('CONFLICT');
        expect(result.content[0].text).toContain('factory_project_work_enabled');
        expect(result.content[0].text).toContain('factory_project_work_disabled');
      }
    });
  });

  it('resumes project control-plane state without requeuing paused tasks when project work is disabled', async () => {
    await withFactoryProjectWorkDisabled(async () => {
      const db = rawDb();
      const createdAt = new Date().toISOString();
      insertFactoryProject(db, {
        id: 'project-work-disabled-resume',
        name: 'Work Disabled Resume',
        status: 'paused',
        trustLevel: 'dark',
        configJson: JSON.stringify({ loop: { auto_continue: true } }),
        testDir,
      });
      db.prepare(`
        INSERT INTO tasks (id, task_description, status, provider, tags, pause_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'task-work-disabled-resume',
        'Paused task should remain parked',
        'waiting',
        'codex',
        JSON.stringify(['factory:internal', 'factory:project_id=project-work-disabled-resume']),
        'factory_project_paused',
        createdAt,
      );

      const result = await safeTool('resume_project', { project: 'project-work-disabled-resume' });

      expect(result.isError).toBeFalsy();
      expect(result.structuredData).toMatchObject({
        requeued_tasks: 0,
        queue_resume_skipped_reason: 'factory_project_work_disabled',
        tick_immediate: false,
      });
      expect(db.prepare('SELECT status, pause_reason FROM tasks WHERE id = ?')
        .get('task-work-disabled-resume')).toEqual({
        status: 'waiting',
        pause_reason: 'factory_project_paused',
      });
    });
  });

  it('scopes pending approval task counts to the requested automation plan project', async () => {
    const db = rawDb();
    const createdAt = new Date().toISOString();

    insertFactoryProject(db, {
      id: 'project-scope-target',
      name: 'Scope Target',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: true } }),
      testDir,
    });
    insertFactoryProject(db, {
      id: 'project-scope-other',
      name: 'Scope Other',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: true } }),
      testDir,
    });
    db.prepare('INSERT INTO tasks (id, task_description, status, provider, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        'task-other-factory-approval',
        'Approval for another factory project',
        'pending_approval',
        'codex',
        JSON.stringify(['factory:internal', 'factory:project_id=project-scope-other']),
        createdAt,
      );
    db.prepare('INSERT INTO tasks (id, task_description, status, provider, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        'task-non-factory-approval',
        'Approval for unrelated non-factory work',
        'pending_approval',
        'codex',
        JSON.stringify(['support']),
        createdAt,
      );

    const targetPlan = await safeTool('factory_automation_plan', { project: 'project-scope-target' });

    expect(targetPlan.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('factory_automation_plan', targetPlan.structuredData);
    expect(targetPlan.structuredData.summary.manual_intervention.counts.pending_approval_tasks).toBe(0);
    expect(targetPlan.structuredData.summary.manual_intervention.reason_codes)
      .not.toContain('task_approval_pending');

    const otherPlan = await safeTool('factory_automation_plan', { project: 'project-scope-other' });

    expect(otherPlan.isError).toBeFalsy();
    expect(otherPlan.structuredData.summary.manual_intervention.counts.pending_approval_tasks).toBe(1);
    expect(otherPlan.structuredData.summary.manual_intervention.reason_codes)
      .toContain('task_approval_pending');

    const allProjectsPlan = await safeTool('factory_automation_plan', {});
    expect(allProjectsPlan.structuredData.summary.manual_intervention.counts.pending_approval_tasks).toBe(1);
  });

  it('keeps scheduler arm plan complete when unarmed project id previews are capped', async () => {
    const db = rawDb();

    for (let index = 0; index < 22; index += 1) {
      insertFactoryProject(db, {
        id: `project-ready-${index}`,
        name: `Ready ${index}`,
        status: 'running',
        trustLevel: 'dark',
        configJson: JSON.stringify({ loop: { auto_continue: true } }),
        testDir,
      });
    }

    const result = await safeTool('factory_automation_plan', {});

    expect(result.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('factory_automation_plan', result.structuredData);
    expect(result.structuredData.summary.manual_intervention).toMatchObject({
      counts: {
        scheduler_unarmed_projects: 22,
      },
    });
    expect(result.structuredData.summary.manual_intervention.project_ids.scheduler_unarmed).toHaveLength(20);
    const armSteps = result.structuredData.control_plane_plan
      .filter((step) => step.tool === 'arm_factory_tick');
    expect(armSteps).toHaveLength(22);
    expect(armSteps.map((step) => step.args.project)).toEqual(
      expect.arrayContaining(['project-ready-0', 'project-ready-20', 'project-ready-21'])
    );
    expect(armSteps.every((step) => step.processes_project_work === false)).toBe(true);
  });

  it('returns a standalone automation plan without processing projects', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-plan-ready',
      name: 'Plan Ready',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: true } }),
      testDir,
    });
    insertFactoryProject(db, {
      id: 'project-plan-paused',
      name: 'Plan Paused',
      status: 'paused',
      trustLevel: 'autonomous',
      configJson: JSON.stringify({
        loop: {
          auto_continue: false,
          operator_paused: true,
        },
      }),
      testDir,
    });
    factoryIntake.createWorkItem({
      project_id: 'project-plan-paused',
      source: 'manual',
      title: 'Paused plan review item',
      description: 'Should be counted in the standalone automation plan.',
      status: 'needs_review',
    });

    const beforeLoopInstances = db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count;
    const result = await safeTool('factory_automation_plan', { blocked_only: true });

    expect(result.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('factory_automation_plan', result.structuredData);
    expect(result.structuredData).toMatchObject({
      ready: false,
      hands_off_ready: false,
      scope: {
        project: null,
        status: null,
        blocked_only: true,
      },
      summary: {
        total_projects: 2,
        ready_projects: 1,
        blocked_projects: 1,
      },
      work_item_status_counts: {
        needs_review: 1,
      },
      needs_review_work_items: 1,
      needs_replan_work_items: 0,
      manual_intervention: {
        required: true,
        reason_codes: expect.arrayContaining([
          'control_plane_blocked',
          'operator_paused_projects',
          'approval_gates_enabled',
          'work_items_need_review',
          'factory_tick_unarmed',
        ]),
      },
      control_plane_plan: [
        {
          action: 'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
          tool: 'set_factory_trust_level',
          args: {
            project: 'project-plan-paused',
            trust_level: 'dark',
            config: { loop: { auto_continue: true } },
          },
          description: expect.any(String),
          effect_scope: 'control_plane',
          mutates_control_plane: true,
          processes_project_work: false,
          enables_future_processing: true,
        },
        {
          action: 'resume_project with clear_operator_pause=true immediate_tick=false',
          tool: 'resume_project',
          args: {
            project: 'project-plan-paused',
            clear_operator_pause: true,
            immediate_tick: false,
          },
          description: expect.any(String),
          effect_scope: 'control_plane',
          mutates_control_plane: true,
          processes_project_work: false,
          enables_future_processing: true,
        },
        {
          action: 'arm_factory_tick immediate=false',
          tool: 'arm_factory_tick',
          args: {
            project: 'project-plan-ready',
            immediate: false,
          },
          description: expect.any(String),
          effect_scope: 'control_plane',
          mutates_control_plane: true,
          processes_project_work: false,
          enables_future_processing: true,
        },
      ],
      projects: [
        {
          id: 'project-plan-paused',
          loop_state: 'IDLE',
          open_work_item_count: 0,
          work_item_status_counts: {
            needs_review: 1,
          },
        },
      ],
    });
    expect(result.structuredData.message).toMatch(/need control-plane changes/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count).toBe(beforeLoopInstances);
    expect(db.prepare('SELECT status FROM factory_projects WHERE id = ?').get('project-plan-paused').status).toBe('paused');
  });

  it('requires an explicit scope before applying automation readiness controls', async () => {
    const result = await safeTool('apply_factory_automation_plan', {});

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    expect(result.content[0].text).toContain('all_projects=true');
  });

  it('requires confirmation before applying automation readiness controls to all projects', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-apply-confirm-required',
      name: 'Apply Confirm Required',
      status: 'paused',
      trustLevel: 'autonomous',
      configJson: JSON.stringify({ loop: { auto_continue: false, operator_paused: true } }),
      testDir,
    });

    const result = await safeTool('apply_factory_automation_plan', {
      all_projects: true,
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('CONFLICT');
    expect(result.content[0].text).toContain('confirm_scope=true');
    const project = db.prepare('SELECT status, trust_level, config_json FROM factory_projects WHERE id = ?')
      .get('project-apply-confirm-required');
    expect(project.status).toBe('paused');
    expect(project.trust_level).toBe('autonomous');
    expect(JSON.parse(project.config_json).loop.auto_continue).toBe(false);
  });

  it('requires confirmation before applying automation readiness controls to a status scope', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-apply-status-confirm',
      name: 'Apply Status Confirm',
      status: 'paused',
      trustLevel: 'autonomous',
      configJson: JSON.stringify({ loop: { auto_continue: false, operator_paused: true } }),
      testDir,
    });

    const result = await safeTool('apply_factory_automation_plan', {
      status: 'paused',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('CONFLICT');
    expect(result.content[0].text).toContain('multi-project scope');
    const project = db.prepare('SELECT status, trust_level, config_json FROM factory_projects WHERE id = ?')
      .get('project-apply-status-confirm');
    expect(project.status).toBe('paused');
    expect(project.trust_level).toBe('autonomous');
    expect(JSON.parse(project.config_json).loop.auto_continue).toBe(false);
  });

  it('applies confirmed status-scoped automation controls only to matching projects', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-apply-status-paused',
      name: 'Apply Status Paused',
      status: 'paused',
      trustLevel: 'autonomous',
      configJson: JSON.stringify({ loop: { auto_continue: false, operator_paused: true } }),
      testDir,
    });
    insertFactoryProject(db, {
      id: 'project-apply-status-running',
      name: 'Apply Status Running',
      status: 'running',
      trustLevel: 'autonomous',
      configJson: JSON.stringify({ loop: { auto_continue: false } }),
      testDir,
    });
    factoryIntake.createWorkItem({
      project_id: 'project-apply-status-paused',
      source: 'manual',
      title: 'Paused status-scope work',
      description: 'Status-scope apply must not process this work during the call.',
      status: 'pending',
    });
    const beforeLoopInstances = db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count;

    const result = await safeTool('apply_factory_automation_plan', {
      status: 'paused',
      confirm_scope: true,
    });

    expect(result.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('apply_factory_automation_plan', result.structuredData);
    expect(result.structuredData).toMatchObject({
      completed: true,
      dry_run: false,
      processes_project_work: false,
      scope: {
        project: null,
        status: 'paused',
      },
      planned_steps: 2,
      failed_steps: [],
      before: {
        ready: false,
        projects: [
          {
            id: 'project-apply-status-paused',
            status: 'paused',
          },
        ],
      },
      after: {
        ready: true,
        projects: [
          {
            id: 'project-apply-status-paused',
            status: 'running',
            automation_readiness: {
              ready: true,
            },
          },
        ],
      },
    });
    expect(result.structuredData.applied_steps.map((step) => step.args.project)).toEqual([
      'project-apply-status-paused',
      'project-apply-status-paused',
    ]);
    expect(result.structuredData.applied_steps.every((step) => step.processes_project_work === false)).toBe(true);

    const pausedProject = db.prepare('SELECT status, trust_level, config_json FROM factory_projects WHERE id = ?')
      .get('project-apply-status-paused');
    expect(pausedProject.status).toBe('running');
    expect(pausedProject.trust_level).toBe('dark');
    expect(JSON.parse(pausedProject.config_json).loop.auto_continue).toBe(true);
    expect(JSON.parse(pausedProject.config_json).loop.operator_paused).toBeUndefined();

    const runningProject = db.prepare('SELECT status, trust_level, config_json FROM factory_projects WHERE id = ?')
      .get('project-apply-status-running');
    expect(runningProject.status).toBe('running');
    expect(runningProject.trust_level).toBe('autonomous');
    expect(JSON.parse(runningProject.config_json).loop.auto_continue).toBe(false);
    expect(factoryTick.isTickActive('project-apply-status-paused')).toBe(true);
    expect(factoryTick.isTickActive('project-apply-status-running')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count).toBe(beforeLoopInstances);
  });

  it('includes hidden blocked-only scheduler arm targets in the apply after snapshot', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-apply-hidden-ready',
      name: 'Apply Hidden Ready',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: true, tick_interval_ms: 120000 } }),
      testDir,
    });
    insertFactoryProject(db, {
      id: 'project-apply-visible-blocked',
      name: 'Apply Visible Blocked',
      status: 'paused',
      trustLevel: 'autonomous',
      configJson: JSON.stringify({ loop: { auto_continue: false, operator_paused: true } }),
      testDir,
    });
    const beforeLoopInstances = db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count;

    const result = await safeTool('apply_factory_automation_plan', {
      allProjects: true,
      blockedOnly: true,
      confirmScope: true,
    });

    expect(result.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('apply_factory_automation_plan', result.structuredData);
    expect(result.structuredData).toMatchObject({
      completed: true,
      dry_run: false,
      processes_project_work: false,
      scope: {
        project: null,
        status: null,
        blocked_only: true,
      },
      planned_steps: 3,
      failed_steps: [],
      before: {
        projects: [
          {
            id: 'project-apply-visible-blocked',
          },
        ],
      },
    });
    expect(result.structuredData.before.projects).toHaveLength(1);
    expect(result.structuredData.applied_steps.map((step) => step.args.project)).toEqual([
      'project-apply-visible-blocked',
      'project-apply-visible-blocked',
      'project-apply-hidden-ready',
    ]);
    expect(result.structuredData.after.projects.map((project) => project.id).sort()).toEqual([
      'project-apply-hidden-ready',
      'project-apply-visible-blocked',
    ]);
    expect(result.structuredData.after.projects.every((project) => project.automation_readiness.ready === true)).toBe(true);
    expect(factoryTick.isTickActive('project-apply-hidden-ready')).toBe(true);
    expect(factoryTick.isTickActive('project-apply-visible-blocked')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count).toBe(beforeLoopInstances);
  });

  it('reports failed automation apply steps without losing the after snapshot', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-apply-arm-fails',
      name: 'Apply Arm Fails',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: true, tick_interval_ms: 120000 } }),
      testDir,
    });
    const beforeLoopInstances = db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count;
    const originalStartTick = factoryTick.startTick;
    factoryTick.startTick = () => {
      throw new Error('timer unavailable');
    };

    try {
      const result = await safeTool('apply_factory_automation_plan', {
        project: 'project-apply-arm-fails',
      });

      expect(result.isError).toBeFalsy();
      expectStructuredDataConformsToOutputSchema('apply_factory_automation_plan', result.structuredData);
      expect(result.structuredData).toMatchObject({
        completed: false,
        dry_run: false,
        processes_project_work: false,
        planned_steps: 1,
        applied_steps: [],
        failed_steps: [
          {
            tool: 'arm_factory_tick',
            status: 'failed',
            args: {
              project: 'project-apply-arm-fails',
              immediate: false,
            },
            processes_project_work: false,
          },
        ],
        after: {
          projects: [
            {
              id: 'project-apply-arm-fails',
              automation_readiness: {
                ready: true,
              },
            },
          ],
        },
      });
      expect(result.structuredData.failed_steps[0].error).toContain('Failed to arm factory tick');
      expect(factoryTick.isTickActive('project-apply-arm-fails')).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count).toBe(beforeLoopInstances);
    } finally {
      factoryTick.startTick = originalStartTick;
    }
  });

  it('dry-runs automation readiness apply without mutating projects', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-apply-dry-run',
      name: 'Apply Dry Run',
      status: 'paused',
      trustLevel: 'autonomous',
      configJson: JSON.stringify({ loop: { auto_continue: false, operator_paused: true } }),
      testDir,
    });

    const result = await safeTool('apply_factory_automation_plan', {
      project: 'project-apply-dry-run',
      dry_run: true,
    });

    expect(result.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('apply_factory_automation_plan', result.structuredData);
    expect(result.structuredData).toMatchObject({
      completed: true,
      dry_run: true,
      processes_project_work: false,
      planned_steps: 2,
      applied_steps: [],
      failed_steps: [],
    });
    expect(result.structuredData.skipped_steps).toHaveLength(2);
    expect(result.structuredData.skipped_steps.every((step) => step.status === 'dry_run')).toBe(true);
    const project = db.prepare('SELECT status, trust_level, config_json FROM factory_projects WHERE id = ?')
      .get('project-apply-dry-run');
    expect(project.status).toBe('paused');
    expect(project.trust_level).toBe('autonomous');
    expect(JSON.parse(project.config_json).loop.auto_continue).toBe(false);
    expect(factoryTick.isTickActive('project-apply-dry-run')).toBe(false);
  });

  it('applies automation readiness control-plane steps without running project work', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-apply-controls',
      name: 'Apply Controls',
      status: 'paused',
      trustLevel: 'autonomous',
      configJson: JSON.stringify({ loop: { auto_continue: false, operator_paused: true, tick_interval_ms: 120000 } }),
      testDir,
    });
    factoryIntake.createWorkItem({
      project_id: 'project-apply-controls',
      source: 'manual',
      title: 'Pending apply work',
      description: 'The readiness apply tool must not process this work item during the call.',
      status: 'pending',
    });
    const beforeLoopInstances = db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count;

    const result = await safeTool('apply_factory_automation_plan', {
      project: 'project-apply-controls',
    });

    expect(result.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('apply_factory_automation_plan', result.structuredData);
    expect(result.structuredData).toMatchObject({
      completed: true,
      dry_run: false,
      processes_project_work: false,
      planned_steps: 2,
      failed_steps: [],
      after: {
        ready: true,
        control_plane_plan: [],
      },
    });
    expect(result.structuredData.applied_steps.map((step) => step.tool)).toEqual([
      'set_factory_trust_level',
      'resume_project',
    ]);
    expect(result.structuredData.applied_steps.every((step) => step.processes_project_work === false)).toBe(true);
    const project = db.prepare('SELECT status, trust_level, config_json FROM factory_projects WHERE id = ?')
      .get('project-apply-controls');
    expect(project.status).toBe('running');
    expect(project.trust_level).toBe('dark');
    const config = JSON.parse(project.config_json);
    expect(config.loop.auto_continue).toBe(true);
    expect(config.loop.operator_paused).toBeUndefined();
    expect(factoryTick.isTickActive('project-apply-controls')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count).toBe(beforeLoopInstances);
  });

  it('applies config-only readiness controls and arms the scheduler without an immediate tick', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-apply-arm-controls',
      name: 'Apply Arm Controls',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: false, tick_interval_ms: 120000 } }),
      testDir,
    });
    factoryIntake.createWorkItem({
      project_id: 'project-apply-arm-controls',
      source: 'manual',
      title: 'Pending apply arm work',
      description: 'The readiness apply tool must arm future ticking without starting this work now.',
      status: 'pending',
    });
    const beforeLoopInstances = db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count;

    const result = await safeTool('apply_factory_automation_plan', {
      project: 'project-apply-arm-controls',
    });

    expect(result.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('apply_factory_automation_plan', result.structuredData);
    expect(result.structuredData).toMatchObject({
      completed: true,
      dry_run: false,
      processes_project_work: false,
      planned_steps: 2,
      failed_steps: [],
      after: {
        ready: true,
        control_plane_plan: [],
      },
    });
    expect(result.structuredData.applied_steps.map((step) => step.tool)).toEqual([
      'set_factory_trust_level',
      'arm_factory_tick',
    ]);
    expect(result.structuredData.applied_steps.every((step) => step.processes_project_work === false)).toBe(true);
    const project = db.prepare('SELECT status, trust_level, config_json FROM factory_projects WHERE id = ?')
      .get('project-apply-arm-controls');
    expect(project.status).toBe('running');
    expect(project.trust_level).toBe('dark');
    expect(JSON.parse(project.config_json).loop.auto_continue).toBe(true);
    expect(factoryTick.isTickActive('project-apply-arm-controls')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count).toBe(beforeLoopInstances);
  });

  it('arms factory tick without running an immediate project tick', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-arm-tick',
      name: 'Arm Tick',
      status: 'running',
      trustLevel: 'dark',
      configJson: JSON.stringify({ loop: { auto_continue: true, tick_interval_ms: 90000 } }),
      testDir,
    });
    factoryIntake.createWorkItem({
      project_id: 'project-arm-tick',
      source: 'manual',
      title: 'Pending work should not start immediately',
      description: 'The tick arming tool must not process this project during the call.',
      status: 'pending',
    });
    const beforeLoopInstances = db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count;

    const result = await safeTool('arm_factory_tick', { project: 'project-arm-tick' });

    expect(result.isError).toBeFalsy();
    expectStructuredDataConformsToOutputSchema('arm_factory_tick', result.structuredData);
    expect(result.structuredData).toMatchObject({
      tick_active: true,
      started: true,
      already_active: false,
      interval_ms: 90000,
      immediate_tick: false,
      processes_project_work: false,
      enables_future_processing: true,
      automation_readiness: {
        ready: true,
      },
    });
    expect(factoryTick.isTickActive('project-arm-tick')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM factory_loop_instances').get().count).toBe(beforeLoopInstances);
  });

  it('refuses to arm factory tick for projects that are not automation-ready', async () => {
    const db = rawDb();

    insertFactoryProject(db, {
      id: 'project-arm-blocked',
      name: 'Arm Blocked',
      status: 'paused',
      trustLevel: 'autonomous',
      configJson: JSON.stringify({ loop: { auto_continue: false, operator_paused: true } }),
      testDir,
    });

    const result = await safeTool('arm_factory_tick', { project: 'project-arm-blocked' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('CONFLICT');
    expect(result.content[0].text).toContain('not automation-ready');
    expect(result.content[0].text).toContain('operator_paused');
    expect(factoryTick.isTickActive('project-arm-blocked')).toBe(false);
  });
});
