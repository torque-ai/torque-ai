'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');

function seedProjectAndItem(db, { trust = 'autonomous', originOverrides = {}, projectPath } = {}) {
  const projectId = 'proj-e2e-1';
  const resolvedPath = projectPath || fs.mkdtempSync(path.join(os.tmpdir(), 'pqg-e2e-'));
  db.prepare(`INSERT INTO factory_projects (id, name, path, trust_level, status, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', '{}', datetime('now'), datetime('now'))`)
    .run(projectId, 'Test', resolvedPath, trust);
  const item = {
    project_id: projectId,
    source: 'architect',
    title: 'Edit src/foo.ts to do a thing',
    description: 'In src/foo.ts adjust handleFoo and run npx vitest tests/foo.test.ts.',
    priority: 50,
    status: 'planned',
    origin_json: JSON.stringify({ plan_path: path.join(resolvedPath, 'plan.md'), ...originOverrides }),
  };
  const { lastInsertRowid } = db.prepare(`INSERT INTO factory_work_items (project_id, source, title, description, priority, status, origin_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
    .run(item.project_id, item.source, item.title, item.description, item.priority, item.status, item.origin_json);
  return { projectId, workItemId: lastInsertRowid, projectPath: resolvedPath };
}

describe('executeNonPlanFileStage plan-quality-gate integration', () => {
  let db;
  beforeEach(() => {
    setupTestDb('plan-quality-gate-e2e');
    db = rawDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('Scenario 1 (autonomous, good plan first try): EXECUTE proceeds and plan_gen_attempts becomes 1', async () => {
    const loopController = require('../factory/loop-controller');
    const planGate = require('../factory/plan-quality-gate');

    const { projectId, workItemId } = seedProjectAndItem(db, { trust: 'autonomous' });
    const goodPlan = '## Task 1: Edit src/foo.ts\n\nIn src/foo.ts rename handleX to handleY and run npx vitest tests/foo.test.ts. Body is long enough for rule 4.\n\n## Task 2: Edit src/bar.ts\n\nIn src/bar.ts call handleY via the new export and run npx vitest tests/bar.test.ts. Body is long enough for rule 4.';

    vi.spyOn(planGate, 'evaluatePlan').mockResolvedValue({ passed: true, hardFails: [], warnings: [], llmCritique: null, feedbackPrompt: null });
    vi.spyOn(require('../factory/internal-task-submit'), 'submitFactoryInternalTask').mockResolvedValue({ task_id: 't-1' });
    vi.spyOn(require('../handlers/workflow/await'), 'handleAwaitTask').mockResolvedValue({ status: 'completed' });
    vi.spyOn(require('../db/task-core'), 'getTask').mockReturnValue({ status: 'completed', output: goodPlan });

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    const instance = { id: 'inst-1', project_id: projectId, batch_id: 'batch-1' };
    const workItem = db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(workItemId);

    const result = await loopController.executeNonPlanFileStage(project, instance, workItem);

    expect(result?.stop_execution).not.toBe(true);
    const after = db.prepare('SELECT origin_json FROM factory_work_items WHERE id = ?').get(workItemId);
    const origin = JSON.parse(after.origin_json);
    expect(origin.plan_gen_attempts).toBe(1);
  });

  it('Scenario 5 (skip_plan_quality_gate metadata): evaluatePlan is NOT called', async () => {
    const loopController = require('../factory/loop-controller');
    const planGate = require('../factory/plan-quality-gate');

    const { projectId, workItemId } = seedProjectAndItem(db, { trust: 'autonomous', originOverrides: { skip_plan_quality_gate: true } });
    const gateSpy = vi.spyOn(planGate, 'evaluatePlan').mockResolvedValue({ passed: false, hardFails: [{ rule: 'x', detail: 'x' }], warnings: [], llmCritique: null, feedbackPrompt: 'x' });
    vi.spyOn(require('../factory/internal-task-submit'), 'submitFactoryInternalTask').mockResolvedValue({ task_id: 't-2' });
    vi.spyOn(require('../handlers/workflow/await'), 'handleAwaitTask').mockResolvedValue({ status: 'completed' });
    vi.spyOn(require('../db/task-core'), 'getTask').mockReturnValue({ status: 'completed', output: '## Task 1: Fine\n\nIn src/foo.ts run npx vitest.' });

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    const instance = { id: 'inst-5', project_id: projectId, batch_id: 'batch-5' };
    const workItem = db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(workItemId);

    const result = await loopController.executeNonPlanFileStage(project, instance, workItem);

    expect(gateSpy).not.toHaveBeenCalled();
    expect(result?.stop_execution).not.toBe(true);
  });

  it('Scenario 6 (gate exception): fail-open, EXECUTE proceeds', async () => {
    const loopController = require('../factory/loop-controller');
    const planGate = require('../factory/plan-quality-gate');

    const { projectId, workItemId } = seedProjectAndItem(db, { trust: 'autonomous' });
    vi.spyOn(planGate, 'evaluatePlan').mockRejectedValue(new Error('scorer exploded'));
    vi.spyOn(require('../factory/internal-task-submit'), 'submitFactoryInternalTask').mockResolvedValue({ task_id: 't-6' });
    vi.spyOn(require('../handlers/workflow/await'), 'handleAwaitTask').mockResolvedValue({ status: 'completed' });
    vi.spyOn(require('../db/task-core'), 'getTask').mockReturnValue({ status: 'completed', output: '## Task 1: Fine\n\nIn src/foo.ts run npx vitest.' });

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    const instance = { id: 'inst-6', project_id: projectId, batch_id: 'batch-6' };
    const workItem = db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(workItemId);

    const result = await loopController.executeNonPlanFileStage(project, instance, workItem);

    expect(result?.stop_execution).not.toBe(true);
  });
});

describe('executeNonPlanFileStage plan-quality-gate — reject paths', () => {
  let db;
  beforeEach(() => {
    setupTestDb('plan-quality-gate-e2e-rejects');
    db = rawDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('Scenario 2 (autonomous, bad plan first, good plan on replan): attempts=2, EXECUTE proceeds', async () => {
    const loopController = require('../factory/loop-controller');
    const planGate = require('../factory/plan-quality-gate');

    const { projectId, workItemId } = seedProjectAndItem(db, { trust: 'autonomous' });
    const gateSpy = vi.spyOn(planGate, 'evaluatePlan')
      .mockResolvedValueOnce({ passed: false, hardFails: [{ rule: 'task_has_file_reference', taskNumber: 1, detail: 'no file' }], warnings: [], llmCritique: null, feedbackPrompt: '## Prior plan rejected\n\n- [task_has_file_reference] Task 1: no file' })
      .mockResolvedValueOnce({ passed: true, hardFails: [], warnings: [], llmCritique: null, feedbackPrompt: null });

    const submitStub = vi.spyOn(require('../factory/internal-task-submit'), 'submitFactoryInternalTask').mockResolvedValue({ task_id: 't-2' });
    vi.spyOn(require('../handlers/workflow/await'), 'handleAwaitTask').mockResolvedValue({ status: 'completed' });
    vi.spyOn(require('../db/task-core'), 'getTask').mockReturnValue({ status: 'completed', output: '## Task 1: Fine\n\nIn src/foo.ts run npx vitest.' });

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    const instance = { id: 'inst-2', project_id: projectId, batch_id: 'batch-2' };
    const workItem = db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(workItemId);

    const result = await loopController.executeNonPlanFileStage(project, instance, workItem);

    expect(result?.stop_execution).not.toBe(true);
    expect(gateSpy).toHaveBeenCalledTimes(2);
    expect(submitStub).toHaveBeenCalledTimes(2); // initial plan gen + re-plan
    const after = db.prepare('SELECT origin_json FROM factory_work_items WHERE id = ?').get(workItemId);
    const origin = JSON.parse(after.origin_json);
    expect(origin.plan_gen_attempts).toBe(2);
  });

  it('Scenario 3 (autonomous, bad plan twice): item rejected, next_state IDLE', async () => {
    const loopController = require('../factory/loop-controller');
    const planGate = require('../factory/plan-quality-gate');

    const { projectId, workItemId } = seedProjectAndItem(db, { trust: 'autonomous' });
    vi.spyOn(planGate, 'evaluatePlan').mockResolvedValue({ passed: false, hardFails: [{ rule: 'task_has_file_reference', taskNumber: 1, detail: 'no file' }], warnings: [], llmCritique: null, feedbackPrompt: '## Prior plan rejected\n...' });
    vi.spyOn(require('../factory/internal-task-submit'), 'submitFactoryInternalTask').mockResolvedValue({ task_id: 't-3' });
    vi.spyOn(require('../handlers/workflow/await'), 'handleAwaitTask').mockResolvedValue({ status: 'completed' });
    vi.spyOn(require('../db/task-core'), 'getTask').mockReturnValue({ status: 'completed', output: '## Task 1: Still bad\n\nNot good.' });

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    const instance = { id: 'inst-3', project_id: projectId, batch_id: 'batch-3' };
    const workItem = db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(workItemId);

    const result = await loopController.executeNonPlanFileStage(project, instance, workItem);

    expect(result?.stop_execution).toBe(true);
    expect(result?.next_state).toBe('IDLE');
    const after = db.prepare('SELECT status, reject_reason FROM factory_work_items WHERE id = ?').get(workItemId);
    expect(after.status).toBe('rejected');
    expect(after.reject_reason).toContain('plan_quality_gate_rejected_after_2_attempts');
  });

  it('Scenario 4 (supervised, bad plan): paused at PLAN_REVIEW with gate_feedback populated', async () => {
    const loopController = require('../factory/loop-controller');
    const planGate = require('../factory/plan-quality-gate');

    const { projectId, workItemId } = seedProjectAndItem(db, { trust: 'supervised' });
    vi.spyOn(planGate, 'evaluatePlan').mockResolvedValue({ passed: false, hardFails: [{ rule: 'task_has_file_reference', taskNumber: 1, detail: 'no file' }], warnings: [], llmCritique: null, feedbackPrompt: '## Prior plan rejected\n\n- [task_has_file_reference] Task 1: no file' });
    vi.spyOn(require('../factory/internal-task-submit'), 'submitFactoryInternalTask').mockResolvedValue({ task_id: 't-4' });
    vi.spyOn(require('../handlers/workflow/await'), 'handleAwaitTask').mockResolvedValue({ status: 'completed' });
    vi.spyOn(require('../db/task-core'), 'getTask').mockReturnValue({ status: 'completed', output: '## Task 1: Fine\n\nIn src/foo.ts run npx vitest.' });

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    const instance = { id: 'inst-4', project_id: projectId, batch_id: 'batch-4' };
    const workItem = db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(workItemId);

    const result = await loopController.executeNonPlanFileStage(project, instance, workItem);

    expect(result?.stop_execution).toBe(true);
    expect(result?.paused_at_stage).toBe('PLAN_REVIEW');
    expect(result?.stage_result?.gate_feedback).toContain('## Prior plan rejected');
    expect(result?.stage_result?.hardFails).toHaveLength(1);
  });
});
