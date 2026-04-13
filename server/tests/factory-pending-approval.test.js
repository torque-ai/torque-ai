import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const path = require('path');
const {
  setupTestDbOnly,
  teardownTestDb,
  resetTables,
} = require('./vitest-setup');
const database = require('../database');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const routingModule = require('../handlers/integration/routing');
const awaitModule = require('../handlers/workflow/await');
const taskCore = require('../db/task-core');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES } = require('../factory/loop-states');
const queueScheduler = require('../execution/queue-scheduler');

const originalHandleSmartSubmitTask = routingModule.handleSmartSubmitTask;
const originalHandleAwaitTask = awaitModule.handleAwaitTask;

const PLAN = `# Pending Approval Plan

**Tech Stack:** Node.js, vitest.

## Task 1: wire executor

- [ ] **Step 1: update executor**

\`\`\`text
Update server/factory/plan-executor.js.
\`\`\`

## Task 2: add approval test

- [ ] **Step 1: cover approval flow**

\`\`\`text
Create server/tests/task-approve-handler.test.js.
\`\`\`
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
  loopController.startLoop(projectId);

  const senseAdvance = await loopController.advanceLoop(projectId);
  expect(senseAdvance.new_state).toBe(LOOP_STATES.PAUSED);
  expect(senseAdvance.paused_at_stage).toBe(LOOP_STATES.PRIORITIZE);

  loopController.approveGate(projectId, LOOP_STATES.PRIORITIZE);

  const prioritizeAdvance = await loopController.advanceLoop(projectId);
  expect(prioritizeAdvance.new_state).toBe(LOOP_STATES.EXECUTE);
}

describe('factory supervised execute pending approval', () => {
  let testDir;
  let safeStartTask;

  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`factory-pending-approval-${Date.now()}`));
    resetTables([
      'tasks',
      'factory_projects',
      'factory_work_items',
      'factory_decisions',
      'factory_health_snapshots',
      'factory_health_findings',
    ]);

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
    routingModule.handleSmartSubmitTask = originalHandleSmartSubmitTask;
    awaitModule.handleAwaitTask = originalHandleAwaitTask;
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('submits supervised EXECUTE tasks in pending_approval status with factory provenance tags', async () => {
    const { project, workItem, planPath } = registerPlanProject(testDir);
    const expectedBatchId = `factory-${project.id}-${workItem.id}`;

    await advanceToExecute(project.id);
    const executeAdvance = await loopController.advanceLoop(project.id);

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

    const planContents = fs.readFileSync(planPath, 'utf8');
    expect(planContents).toContain('- [ ] **Step 1: update executor**');
    expect(planContents).toContain('- [ ] **Step 1: cover approval flow**');
  });
});
