'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const factoryDecisions = require('../db/factory/decisions');
const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const factoryLoopInstances = require('../db/factory/loop-instances');
const factoryWorktrees = require('../db/factory/worktrees');
const taskCore = require('../db/task-core');
const routingModule = require('../handlers/integration/routing');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES } = require('../factory/loop-states');
const planQualityGate = require('../factory/plan-quality-gate');

function writeTwoTaskPlan(planPath) {
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, `# Pause Execute Deferral

**Tech Stack:** Node.js, vitest.

## Task 1: completed setup

- [x] **Step 1: Record setup**

Document that the batch already completed its first plan task.

## Task 2: remaining execute work

- [ ] **Step 1: Add paused execute handling**

Edit server/factory/loop-controller.js.

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

function passingPlanGateVerdict() {
  return {
    passed: true,
    hardFails: [],
    warnings: [],
    llmCritique: null,
    feedbackPrompt: null,
  };
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
    taskCore.setDb(db);
    loopController.setWorktreeRunnerForTests(null);
    submitSpy = vi.spyOn(routingModule, 'handleSmartSubmitTask')
      .mockResolvedValue({ task_id: 'execute-task-2' });
    // Bypass the plan-quality-gate. Bug D-extension at executePlanFileStage
    // re-runs the gate on resumed deferred EXECUTE batches; the abbreviated
    // plan body in this test deliberately omits the file-reference and
    // acceptance-criterion details the gate enforces, so a real gate run
    // would auto-reject the work item before EXECUTE submits anything.
    vi.spyOn(planQualityGate, 'evaluatePlan').mockResolvedValue(passingPlanGateVerdict());
  });

  afterEach(() => {
    loopController.setWorktreeRunnerForTests(null);
    vi.restoreAllMocks();
    factoryDecisions.setDb(null);
    factoryHealth.setDb(null);
    factoryIntake.setDb(null);
    factoryLoopInstances.setDb(null);
    factoryWorktrees.setDb(null);
    taskCore.setDb(null);
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

  it('defers the next EXECUTE plan task without submitting when the project pauses at the submit boundary', async () => {
    const { project, workItem, batchId } = stageExecutePlanProject({ status: 'running' });
    planQualityGate.evaluatePlan.mockImplementationOnce(async () => {
      factoryHealth.updateProject(project.id, { status: 'paused' });
      return passingPlanGateVerdict();
    });

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
        remaining_plan_task_number: 2,
        next_state: LOOP_STATES.EXECUTE,
      }),
    });
  });

  it('submits the same next plan task after the paused project resumes running', async () => {
    const { project, batchId, instance, workItem } = stageExecutePlanProject({ status: 'paused' });

    await loopController.advanceLoopForProject(project.id);
    expect(submitSpy).not.toHaveBeenCalled();

    factoryHealth.updateProject(project.id, { status: 'running' });
    const resumedAdvance = await loopController.advanceLoopForProject(project.id);

    expect(resumedAdvance.instance_id).toBe(instance.id);
    expect(resumedAdvance.previous_state).toBe(LOOP_STATES.EXECUTE);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const submitted = submitSpy.mock.calls[0][0];
    expect(submitted.plan_task_number).toBe(2);
    expect(submitted.tags).toEqual(expect.arrayContaining([
      `factory:batch_id=${batchId}`,
      'factory:plan_task_number=2',
    ]));
    expect(submitted.task).toContain('Task 2: remaining execute work');

    expect(factoryLoopInstances.getInstance(resumedAdvance.instance_id)).toMatchObject({
      work_item_id: workItem.id,
      batch_id: batchId,
    });
    const resumed = listDecisionRows(db, project.id).find((row) => row.action === 'execute_deferred_resumed');
    expect(resumed).toMatchObject({
      stage: 'execute',
      batch_id: batchId,
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        remaining_plan_task_number: 2,
      }),
    });
  });

  it('warns and does not duplicate work for an obsolete deferred EXECUTE task that already started', async () => {
    const { project, workItem, batchId, planPath } = stageExecutePlanProject({ status: 'running' });
    const activeTaskId = 'execute-task-2-already-started';
    taskCore.createTask({
      id: activeTaskId,
      task_description: 'Task 2 already started',
      working_directory: project.path,
      project: project.name,
      status: 'pending_approval',
      tags: [
        `factory:batch_id=${batchId}`,
        `factory:work_item_id=${workItem.id}`,
        'factory:plan_task_number=2',
      ],
    });
    factoryDecisions.recordDecision({
      project_id: project.id,
      stage: 'execute',
      actor: 'executor',
      action: 'execute_deferred_paused',
      reasoning: 'test stale deferred row after task submission',
      inputs: {
        work_item_id: workItem.id,
        plan_task_number: 2,
        remaining_plan_task_number: 2,
      },
      outcome: {
        work_item_id: workItem.id,
        plan_path: planPath,
        plan_task_number: 2,
        remaining_plan_task_number: 2,
        next_state: LOOP_STATES.EXECUTE,
      },
      confidence: 1,
      batch_id: batchId,
    });

    await loopController.advanceLoopForProject(project.id);

    expect(submitSpy).not.toHaveBeenCalled();
    const decisions = listDecisionRows(db, project.id);
    const warning = decisions.find((row) => row.action === 'execute_deferred_paused_stale_warning');
    expect(warning).toMatchObject({
      stage: 'execute',
      batch_id: batchId,
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        stale_reason: 'remaining_plan_task_already_started',
        remaining_plan_task_number: 2,
        existing_task_id: activeTaskId,
        existing_task_status: 'pending_approval',
        ignored: true,
      }),
    });
    const matchingTaskIds = taskCore.listTasks({
      project: project.name,
      tag: `factory:work_item_id=${workItem.id}`,
      statuses: ['pending_approval', 'pending', 'queued', 'running'],
      columns: ['id', 'status', 'tags'],
    }).filter((task) => (
      Array.isArray(task.tags)
      && task.tags.includes('factory:plan_task_number=2')
    )).map((task) => task.id);
    expect(matchingTaskIds).toEqual([activeTaskId]);
  });
});
