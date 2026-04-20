const path = require('path');
const { rawDb, safeTool, setupTestDb, teardownTestDb } = require('./vitest-setup');

describe('factory_status', () => {
  let testDir;

  beforeAll(() => {
    ({ testDir } = setupTestDb('factory-handlers-status'));
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
});
