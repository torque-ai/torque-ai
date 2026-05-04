import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const path = require('path');
const {
  setupTestDbOnly,
  teardownTestDb,
  resetTables,
} = require('./vitest-setup');
const database = require('../database');
const factoryGuardrails = require('../db/factory/guardrails');
const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const factoryLoopInstances = require('../db/factory/loop-instances');
const routingModule = require('../handlers/integration/routing');
const awaitModule = require('../handlers/workflow/await');
const taskCore = require('../db/task-core');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES } = require('../factory/loop-states');
const queueScheduler = require('../execution/queue-scheduler');
const planQualityGate = require('../factory/plan-quality-gate');

const originalHandleSmartSubmitTask = routingModule.handleSmartSubmitTask;
const originalHandleAwaitTask = awaitModule.handleAwaitTask;

// Plan body must satisfy the plan-quality-gate that runs on pre-written
// plans in executePlanStage: each task body needs >=100 chars of concrete
// instruction, a file path reference, an acceptance criterion (expect/
// assert/etc.), and no vague verbs ("update", "cover") without object
// detail. Same pattern as commit 670552f5 in factory-loop-controller.test.
const PLAN = `# Pending Approval Plan

**Tech Stack:** Node.js, vitest.

## Task 1: wire executor

- [ ] **Step 1: wire approval helper in executor**

    Edit server/factory/plan-executor.js to wire the approval-decision callback into the existing executor entry point. Add the new helper alongside the existing exported helpers without disturbing call sites. Acceptance criterion: \`expect(planExecutor.handleApproval('seed').wired).toBe(true)\` in a colocated unit test.

## Task 2: add approval test

- [ ] **Step 1: cover approval flow with a focused handler test**

    Create server/tests/task-approve-handler.test.js with a focused test that constructs a fake task, drives the handler through the pending-approval branch, and asserts the resulting status. Acceptance criterion: \`expect(handler(...).status).toBe('approved')\` covers the happy path and one rejection.
`;

function registerPlanProject(testDir) {
  const projectDir = path.join(testDir, `factory-project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(projectDir, { recursive: true });
  const planPath = path.join(projectDir, 'plan.md');
  fs.writeFileSync(planPath, PLAN);

  const project = factoryHealth.registerProject({
    name: 'Pending Approval Project',
    path: projectDir,
    trust_level: 'supervised',
  });

  const workItem = factoryIntake.createWorkItem({
    project_id: project.id,
    source: 'plan_file',
    title: 'Pending approval work item',
    description: 'Exercise supervised execute mode.',
    requestor: 'test',
    origin: {
      plan_path: planPath,
    },
  });

  return { project, workItem, planPath, projectDir };
}

async function advanceToExecute(projectId) {
  loopController.startLoopForProject(projectId);

  const senseAdvance = await loopController.advanceLoopForProject(projectId);
  expect(senseAdvance.new_state).toBe(LOOP_STATES.PRIORITIZE);
  expect(senseAdvance.paused_at_stage).toBe(LOOP_STATES.PRIORITIZE);

  loopController.approveGateForProject(projectId, LOOP_STATES.PRIORITIZE);

  const prioritizeAdvance = await loopController.advanceLoopForProject(projectId);
  expect(prioritizeAdvance.new_state).toBe(LOOP_STATES.EXECUTE);
}

describe('factory supervised execute pending approval', () => {
  let dbModule;
  let testDir;
  let safeStartTask;

  beforeEach(() => {
    ({ db: dbModule, testDir } = setupTestDbOnly(`factory-pending-approval-${Date.now()}`));
    const rawDb = dbModule.getDbInstance();
    loopController.setWorktreeRunnerForTests(null);
    factoryGuardrails.setDb(rawDb);
    factoryLoopInstances.setDb(rawDb);
    resetTables([
      'tasks',
      'factory_projects',
      'factory_loop_instances',
      'factory_work_items',
      'factory_decisions',
      'factory_health_snapshots',
      'factory_health_findings',
    ]);

    // Bypass the plan-quality-gate's LLM semantic check. The gate runs at
    // PLAN stage on pre-written plans (Bug D fix) and submits an internal
    // task via handleSmartSubmitTask + awaits it via handleAwaitTask.
    // Without this stub, the gate's submit and await calls would pollute
    // the per-plan-task mock counters this test asserts on.
    vi.spyOn(planQualityGate, 'evaluatePlan').mockResolvedValue({
      passed: true,
      hardFails: [],
      warnings: [],
      llmCritique: null,
      feedbackPrompt: null,
    });

    routingModule.handleSmartSubmitTask = vi.fn(async (args) => {
      const taskId = `pending-approval-task-${args.plan_task_number}`;
      taskCore.createTask({
        id: taskId,
        task_description: args.task,
        working_directory: args.working_directory,
        project: args.project,
        status: args.initial_status,
        tags: args.tags,
        metadata: {
          plan_path: args.plan_path,
          plan_title: args.plan_title,
          plan_task_number: args.plan_task_number,
          plan_task_title: args.plan_task_title,
          file_paths: args.file_paths,
        },
      });
      return { task_id: taskId };
    });

    awaitModule.handleAwaitTask = vi.fn(async () => {
      throw new Error('await should not run for pending approval submissions');
    });

    safeStartTask = vi.fn(() => ({ started: true }));
    queueScheduler.init({
      db: database,
      safeStartTask,
      safeConfigInt: (_key, fallback) => fallback,
      isLargeModelBlockedOnHost: () => ({ blocked: false }),
      getProviderInstance: () => ({ id: 'test-provider' }),
      cleanupOrphanedRetryTimeouts: () => {},
      notifyDashboard: () => {},
      analyzeTaskForRouting: () => ({ provider: 'codex', reason: 'test routing' }),
    });
  });

  afterEach(() => {
    queueScheduler.stop();
    factoryGuardrails.setDb(null);
    factoryLoopInstances.setDb(null);
    loopController.setWorktreeRunnerForTests(null);
    routingModule.handleSmartSubmitTask = originalHandleSmartSubmitTask;
    awaitModule.handleAwaitTask = originalHandleAwaitTask;
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('submits supervised EXECUTE tasks in pending_approval status with factory provenance tags', async () => {
    const { project, workItem, planPath } = registerPlanProject(testDir);
    const expectedBatchId = `factory-${project.id}-${workItem.id}`;

    await advanceToExecute(project.id);
    const executeAdvance = await loopController.advanceLoopForProject(project.id);

    expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();
    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalledTimes(2);

    const heldTasks = taskCore.listTasks({ status: 'pending_approval', limit: 10 });
    expect(heldTasks).toHaveLength(2);

    const taskOne = heldTasks.find((task) => task.tags.includes('factory:plan_task_number=1'));
    const taskTwo = heldTasks.find((task) => task.tags.includes('factory:plan_task_number=2'));

    expect(taskOne).toBeTruthy();
    expect(taskTwo).toBeTruthy();

    for (const task of heldTasks) {
      expect(task.status).toBe('pending_approval');
      expect(task.tags).toEqual(expect.arrayContaining([
        `factory:batch_id=${expectedBatchId}`,
        `factory:work_item_id=${workItem.id}`,
        'factory:pending_approval',
      ]));
    }

    expect(taskOne.tags).toContain('factory:plan_task_number=1');
    expect(taskTwo.tags).toContain('factory:plan_task_number=2');

    queueScheduler.processQueueInternal({ skipRecentProcessGuard: true });
    expect(safeStartTask).not.toHaveBeenCalled();

    const queuedTasks = taskCore.listTasks({ status: 'queued', limit: 10 });
    expect(queuedTasks).toHaveLength(0);

    // Tasks were held for approval, not completed — the plan file's [ ]
    // checkboxes must remain unchecked. Assert against the actual step
    // titles in PLAN above rather than placeholders from an earlier draft.
    const planContents = fs.readFileSync(planPath, 'utf8');
    expect(planContents).toContain('- [ ] **Step 1: wire approval helper in executor**');
    expect(planContents).toContain('- [ ] **Step 1: cover approval flow with a focused handler test**');
  });
});
