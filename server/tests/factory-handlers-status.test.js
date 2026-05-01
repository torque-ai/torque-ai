const path = require('path');
const { rawDb, resetTables, safeTool, setupTestDb, teardownTestDb } = require('./vitest-setup');
const factoryIntake = require('../db/factory-intake');
const notifications = require('../factory/notifications');

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

describe('factory_status', () => {
  let testDir;

  beforeAll(() => {
    ({ testDir } = setupTestDb('factory-handlers-status'));
  });

  beforeEach(() => {
    resetTables(['tasks', 'factory_loop_instances', 'factory_work_items', 'factory_projects']);
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
});
