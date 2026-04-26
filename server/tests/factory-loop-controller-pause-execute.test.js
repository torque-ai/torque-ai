'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const factoryWorktrees = require('../db/factory-worktrees');
const routingModule = require('../handlers/integration/routing');
const loopController = require('../factory/loop-controller');
const planQualityGate = require('../factory/plan-quality-gate');
const { LOOP_STATES } = require('../factory/loop-states');

function writeTwoTaskPlan(planPath) {
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  // Plan body must satisfy the plan-quality-gate (Bug D fix in
  // executePlanStage): each task body needs >=100 chars, a file path
  // reference, an acceptance criterion, and avoid bare vague verbs.
  //
  // Task 1 is `[x]` (trusted-complete). Its file reference is a BARE
  // filename (no slash) so plan-quality-gate's FILE_PATH_RE accepts it
  // but plan-executor's stricter `(seg + slash)+ + seg` extractor returns
  // no paths — so verifyCompletedTaskArtifacts honors the [x] instead of
  // re-submitting it as stale (the project working_directory is a temp
  // dir, not the real server tree, so any path with a slash would
  // resolve to a missing file).
  //
  // Task 2 is `[ ]` (pending). Its file reference can be any shape —
  // the trusted-complete check only fires on [x] tasks.
  fs.writeFileSync(planPath, `# Pause Execute Deferral

**Tech Stack:** Node.js, vitest.

## Task 1: completed setup

- [x] **Step 1: Record setup completion in plan-executor.js**

    Edit plan-executor.js to record the setup completion entry alongside the existing batch ledger. Already pre-completed by this fixture. Acceptance criterion: \`expect(plan).toContain('- [x]')\` proves the executor saw a trusted-complete task.

## Task 2: remaining execute work

- [ ] **Step 1: Add paused execute handling in loop-controller.js**

    Edit server/factory/loop-controller.js to add the paused-EXECUTE deferral path that the resumeProject flow needs. The handling must persist a deferral marker the resume code can pick up. Acceptance criterion: \`expect(deferral.kind).toBe('execute_paused')\` after a fixture run.

- [ ] **Step 2: Commit**

\`\`\`bash
git commit -m "fix(factory): defer execute while paused"
\`\`\`
`);
}

function listDecisionRows(db, projectId) {
  return db.prepare(`
    SELECT id, stage, actor, action, inputs_json, outcome_json, batch_id
    FROM factory_decisions
    WHERE project_id = ?
    ORDER BY id ASC
  `).all(projectId).map((row) => ({
    ...row,
    inputs: row.inputs_json ? JSON.parse(row.inputs_json) : null,
    outcome: row.outcome_json ? JSON.parse(row.outcome_json) : null,
  }));
}

describe('factory loop-controller paused EXECUTE deferral', () => {
  let db;
  let testDir;
  let submitSpy;

  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`factory-loop-pause-execute-${Date.now()}`));
    db = rawDb();
    factoryDecisions.setDb(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryLoopInstances.setDb(db);
    factoryWorktrees.setDb(db);
    loopController.setWorktreeRunnerForTests(null);
    submitSpy = vi.spyOn(routingModule, 'handleSmartSubmitTask')
      .mockResolvedValue({ task_id: 'execute-task-2' });
    // Bug D's pre-written-plan gate runs an LLM semantic check that
    // submits a factory-internal task — that goes through the same
    // handleSmartSubmitTask spy and would inflate `submitSpy` call counts.
    // Skip the LLM check; deterministic gate rules still run on the plan.
    vi.spyOn(planQualityGate, 'runLlmSemanticCheck').mockResolvedValue(null);
  });

  afterEach(() => {
    loopController.setWorktreeRunnerForTests(null);
    vi.restoreAllMocks();
    factoryDecisions.setDb(null);
    factoryHealth.setDb(null);
    factoryIntake.setDb(null);
    factoryLoopInstances.setDb(null);
    factoryWorktrees.setDb(null);
    teardownTestDb();
    db = null;
    testDir = null;
  });

  function stageExecutePlanProject({ status = 'paused' } = {}) {
    const projectDir = path.join(testDir, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const planPath = path.join(projectDir, 'plans', 'pause-execute-plan.md');
    fs.mkdirSync(projectDir, { recursive: true });
    writeTwoTaskPlan(planPath);

    const projectRow = factoryHealth.registerProject({
      name: 'Pause Execute Deferral Project',
      path: projectDir,
      trust_level: 'supervised',
      config: { execute_mode: 'pending_approval' },
    });

    const workItem = factoryIntake.createWorkItem({
      project_id: projectRow.id,
      source: 'plan_file',
      title: 'Pause execute work item',
      description: 'Exercise paused EXECUTE deferral.',
      requestor: 'test',
      origin: { plan_path: planPath },
      status: 'executing',
    });
    const batchId = `factory-${projectRow.id}-${workItem.id}`;
    const instance = factoryLoopInstances.createInstance({
      project_id: projectRow.id,
      work_item_id: workItem.id,
      batch_id: batchId,
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.EXECUTE,
      work_item_id: workItem.id,
      batch_id: batchId,
      paused_at_stage: null,
    });
    factoryIntake.updateWorkItem(workItem.id, {
      status: 'executing',
      batch_id: batchId,
      claimed_by_instance_id: instance.id,
    });
    const project = factoryHealth.updateProject(projectRow.id, {
      status,
      loop_state: LOOP_STATES.EXECUTE,
      loop_batch_id: batchId,
      loop_paused_at_stage: null,
    });

    return {
      project,
      workItem: factoryIntake.getWorkItem(workItem.id),
      instance: factoryLoopInstances.getInstance(instance.id),
      batchId,
      planPath,
    };
  }

  it('defers the next EXECUTE plan task without submitting while project status is paused', async () => {
    const { project, workItem, batchId } = stageExecutePlanProject({ status: 'paused' });

    const pausedAdvance = await loopController.advanceLoopForProject(project.id);

    expect(submitSpy).not.toHaveBeenCalled();
    expect(pausedAdvance).toMatchObject({
      project_id: project.id,
      previous_state: LOOP_STATES.EXECUTE,
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
    });
    expect(factoryLoopInstances.getInstance(pausedAdvance.instance_id)).toMatchObject({
      loop_state: LOOP_STATES.EXECUTE,
      batch_id: batchId,
      paused_at_stage: null,
    });
    expect(factoryHealth.getProject(project.id)).toMatchObject({
      status: 'paused',
      loop_state: LOOP_STATES.EXECUTE,
      loop_batch_id: batchId,
      loop_paused_at_stage: null,
    });

    const deferred = listDecisionRows(db, project.id).find((row) => row.action === 'execute_deferred_paused');
    expect(deferred).toMatchObject({
      stage: 'execute',
      actor: 'executor',
      batch_id: batchId,
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        plan_task_number: 2,
        next_state: LOOP_STATES.EXECUTE,
      }),
    });
  });

  it('submits the same next plan task after the paused project resumes running', async () => {
    const { project, batchId } = stageExecutePlanProject({ status: 'paused' });

    await loopController.advanceLoopForProject(project.id);
    expect(submitSpy).not.toHaveBeenCalled();

    factoryHealth.updateProject(project.id, { status: 'running' });
    const resumedAdvance = await loopController.advanceLoopForProject(project.id);

    expect(resumedAdvance.previous_state).toBe(LOOP_STATES.EXECUTE);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const submitted = submitSpy.mock.calls[0][0];
    expect(submitted.plan_task_number).toBe(2);
    expect(submitted.tags).toEqual(expect.arrayContaining([
      `factory:batch_id=${batchId}`,
      'factory:plan_task_number=2',
    ]));
    expect(submitted.task).toContain('Task 2: remaining execute work');
  });
});
