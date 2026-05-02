'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const taskCore = require('../db/task-core');
const routingModule = require('../handlers/integration/routing');
const factoryHandlers = require('../handlers/factory-handlers');
const factoryTick = require('../factory/factory-tick');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES } = require('../factory/loop-states');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAdvanceJob(instanceId, jobId, expectedStatus = 'completed') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = loopController.getLoopAdvanceJobStatus(instanceId, jobId);
    if (snapshot?.status === expectedStatus) {
      return snapshot;
    }
    await sleep(5);
  }
  throw new Error(`Timed out waiting for advance job ${jobId} to reach ${expectedStatus}`);
}

describe('factory pause enforcement', () => {
  let db;
  let testDir;
  let submitSpy;

  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`factory-pause-respects-${Date.now()}`));
    db = rawDb();
    submitSpy = vi.spyOn(routingModule, 'handleSmartSubmitTask')
      .mockResolvedValue({ task_id: 'factory-internal-task-1' });
  });

  afterEach(() => {
    factoryTick.stopAll();
    loopController.setWorktreeRunnerForTests(null);
    vi.restoreAllMocks();
    teardownTestDb();
    db = null;
    testDir = null;
  });

  function registerFactoryProject({ status = 'running', autoContinue = true, trustLevel = 'dark' } = {}) {
    const projectPath = path.join(testDir, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(projectPath, { recursive: true });
    const project = factoryHealth.registerProject({
      name: `Pause Respect ${Math.random().toString(16).slice(2)}`,
      path: projectPath,
      trust_level: trustLevel,
      config: {
        loop: { auto_continue: autoContinue },
      },
    });
    return factoryHealth.updateProject(project.id, { status });
  }

  it('tick against a project paused before instance advance produces zero submissions', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    factoryLoopInstances.createInstance({ project_id: project.id });
    const staleRunningProject = factoryHealth.getProject(project.id);
    const originalListInstances = factoryLoopInstances.listInstances;
    vi.spyOn(factoryLoopInstances, 'listInstances').mockImplementation((args = {}) => {
      const rows = originalListInstances(args);
      if (args.project_id === project.id && args.active_only) {
        factoryHealth.updateProject(project.id, { status: 'paused' });
      }
      return rows;
    });
    const advanceSpy = vi.spyOn(loopController, 'advanceLoopAsync')
      .mockReturnValue({ status: 'running', job_id: 'should-not-run' });

    await factoryTick.tickProject(staleRunningProject);

    expect(advanceSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
    expect(factoryHealth.getProject(project.id).status).toBe('paused');
  });

  it('does not auto-start a new loop when the project is paused before auto-start', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const staleRunningProject = factoryHealth.getProject(project.id);
    const originalListInstances = factoryLoopInstances.listInstances;
    vi.spyOn(factoryLoopInstances, 'listInstances').mockImplementation((args = {}) => {
      const rows = originalListInstances(args);
      if (args.project_id === project.id && args.active_only) {
        factoryHealth.updateProject(project.id, { status: 'paused' });
      }
      return rows;
    });
    const startSpy = vi.spyOn(loopController, 'startLoopAutoAdvance')
      .mockReturnValue({ project_id: project.id, instance_id: 'should-not-start' });

    await factoryTick.tickProject(staleRunningProject);

    expect(startSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
    expect(factoryHealth.getProject(project.id).status).toBe('paused');
  });

  it('does not auto-resume a paused auto-continue project', async () => {
    const project = registerFactoryProject({ status: 'paused', autoContinue: true });

    await factoryTick.tickProject(project);

    expect(factoryHealth.getProject(project.id).status).toBe('paused');
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('runAdvanceLoop returns early when the project is paused', async () => {
    const project = registerFactoryProject({ status: 'paused', autoContinue: false });
    const instance = factoryLoopInstances.createInstance({ project_id: project.id });

    const result = await loopController.runAdvanceLoop(instance.id);

    expect(result).toMatchObject({
      project_id: project.id,
      instance_id: instance.id,
      previous_state: LOOP_STATES.SENSE,
      new_state: LOOP_STATES.SENSE,
      paused_at_stage: null,
      stage_result: null,
      reason: 'project_paused',
    });
    expect(factoryLoopInstances.getInstance(instance.id)).toMatchObject({
      loop_state: LOOP_STATES.SENSE,
      paused_at_stage: null,
    });
    const decisionCount = db.prepare('SELECT COUNT(*) AS count FROM factory_decisions WHERE project_id = ?').get(project.id).count;
    expect(decisionCount).toBe(0);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('runAdvanceLoop stops when the selected work item already has terminal escalation evidence', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'architect',
      title: 'Already exhausted selected item',
      description: 'A cancelled architect path must not keep executing this item.',
      status: 'verifying',
    });
    factoryIntake.updateWorkItem(item.id, {
      reject_reason: 'escalation_exhausted: chain_exhausted after 3x same-shape',
    });
    const batchId = `factory-closed-item-${Date.now()}`;
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      work_item_id: item.id,
      batch_id: batchId,
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.EXECUTE,
      work_item_id: item.id,
      batch_id: batchId,
      last_action_at: new Date().toISOString(),
    });
    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.EXECUTE,
      loop_batch_id: batchId,
    });

    const result = await loopController.runAdvanceLoop(instance.id);

    expect(result).toMatchObject({
      project_id: project.id,
      instance_id: instance.id,
      previous_state: LOOP_STATES.EXECUTE,
      new_state: LOOP_STATES.IDLE,
      reason: 'work_item_closed_escalation_exhausted_reject_reason',
    });
    expect(result.stage_result).toMatchObject({
      status: 'stopped',
      work_item_id: item.id,
      work_item_status: 'escalation_exhausted',
    });
    expect(factoryLoopInstances.getInstance(instance.id).terminated_at).toBeTruthy();
    expect(factoryIntake.getWorkItem(item.id)).toMatchObject({
      status: 'escalation_exhausted',
      reject_reason: 'escalation_exhausted: chain_exhausted after 3x same-shape',
    });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('advanceLoopAsync chain stops when the project is paused', async () => {
    const project = registerFactoryProject({ status: 'paused', autoContinue: true });
    const instance = factoryLoopInstances.createInstance({ project_id: project.id });

    const job = loopController.advanceLoopAsync(instance.id, { autoAdvance: true });
    const completed = await waitForAdvanceJob(instance.id, job.job_id);
    await sleep(150);

    expect(completed).toMatchObject({
      status: 'completed',
      reason: 'project_paused',
      new_state: LOOP_STATES.SENSE,
    });
    expect(loopController._internalForTests.getActiveAdvanceJobIdForTests(instance.id)).toBeNull();
    expect(factoryLoopInstances.getInstance(instance.id).loop_state).toBe(LOOP_STATES.SENSE);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('submitFactoryInternalTask rejects when the project is paused', async () => {
    const project = registerFactoryProject({ status: 'paused', autoContinue: false });
    const { submitFactoryInternalTask } = require('../factory/internal-task-submit');

    await expect(submitFactoryInternalTask({
      task: 'generate a plan',
      working_directory: project.path,
      kind: 'plan_generation',
      project_id: project.id,
    })).rejects.toThrow(/paused.*internal task submission blocked/i);

    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('retry_factory_verify clears the project-row pause and restarts ticking', async () => {
    const project = registerFactoryProject({ status: 'paused', autoContinue: true });
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'Retry paused verify project',
      description: 'A paused project-row VERIFY retry should resume the row gate and restart ticking.',
      status: 'verifying',
    });
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      work_item_id: item.id,
      batch_id: 'factory-retry-paused-verify',
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.VERIFY,
      paused_at_stage: 'VERIFY',
      last_action_at: new Date().toISOString(),
    });
    const startTickSpy = vi.spyOn(factoryTick, 'startTick').mockImplementation(() => {});

    const response = await factoryHandlers.handleRetryFactoryVerify({
      project: project.id,
      actor: 'test-operator',
    });

    expect(response.structuredData).toMatchObject({
      project_id: project.id,
      state: LOOP_STATES.VERIFY,
      project_resumed: true,
      project_status: 'running',
    });
    expect(factoryHealth.getProject(project.id).status).toBe('running');
    expect(factoryLoopInstances.getInstance(instance.id).paused_at_stage).toBeNull();
    expect(startTickSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: project.id, status: 'running' }),
      undefined,
    );
    expect(db.prepare(`
      SELECT event_type, previous_status, reason, actor, source
      FROM factory_audit_events
      WHERE project_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(project.id)).toMatchObject({
      event_type: 'resume',
      previous_status: 'paused',
      reason: 'retry_factory_verify',
      actor: 'test-operator',
      source: 'mcp',
    });
  });

  it('keeps one scheduled auto-advance timer per instance', async () => {
    vi.useFakeTimers();
    const instanceId = 'timer-dedupe-instance';
    const calls = [];
    try {
      loopController._internalForTests.scheduleAutoAdvanceForTests(instanceId, 1000, () => {
        calls.push('first');
      });
      expect(loopController._internalForTests.getScheduledAutoAdvanceForTests(instanceId)).toMatchObject({
        delay_ms: 1000,
      });

      loopController._internalForTests.scheduleAutoAdvanceForTests(instanceId, 2000, () => {
        calls.push('second');
      });
      expect(loopController._internalForTests.getScheduledAutoAdvanceForTests(instanceId)).toMatchObject({
        delay_ms: 2000,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toEqual([]);
      expect(loopController._internalForTests.getScheduledAutoAdvanceForTests(instanceId)).toMatchObject({
        delay_ms: 2000,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toEqual(['second']);
      expect(loopController._internalForTests.getScheduledAutoAdvanceForTests(instanceId)).toBeNull();
    } finally {
      loopController._internalForTests.clearScheduledAutoAdvanceForTests(instanceId);
      vi.useRealTimers();
    }
  });

  it('resolves unrecoverable VERIFY stalls by rejecting the item and terminating the instance', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'architect',
      title: 'Exercise terminal verify stall handling',
      description: 'A test work item that should be rejected after VERIFY stall recovery exhausts.',
      status: 'verifying',
    });
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      work_item_id: item.id,
      batch_id: 'factory-test-batch',
    });
    const staleAt = new Date(Date.now() - (90 * 60 * 1000)).toISOString();
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.VERIFY,
      paused_at_stage: LOOP_STATES.VERIFY,
      last_action_at: staleAt,
    });
    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.PAUSED,
      loop_paused_at_stage: LOOP_STATES.VERIFY,
      loop_batch_id: 'factory-test-batch',
      loop_last_action_at: staleAt,
    });
    db.prepare('UPDATE factory_projects SET verify_recovery_attempts = 2 WHERE id = ?').run(project.id);

    const resolution = await factoryTick._internalForTests.resolveUnrecoverableVerifyLoop(
      {
        project_id: project.id,
        attempts: 2,
        last_action_at: staleAt,
      },
      { cancelGraceMs: 0, taskCore, taskManager: { cancelTask: vi.fn() } },
    );

    expect(resolution).toMatchObject({
      action: 'resolved_unrecoverable_verify',
      terminated_instances: [instance.id],
      rejected_work_items: [item.id],
    });
    expect(factoryLoopInstances.getInstance(instance.id)).toMatchObject({
      loop_state: LOOP_STATES.IDLE,
      paused_at_stage: null,
    });
    expect(factoryLoopInstances.getInstance(instance.id).terminated_at).toBeTruthy();
    expect(factoryHealth.getProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.IDLE,
      loop_paused_at_stage: null,
      loop_batch_id: null,
    });
    expect(factoryIntake.getWorkItem(item.id)).toMatchObject({
      status: 'rejected',
      reject_reason: 'verify_stalled_after_2_recovery_attempts',
    });
    expect(db.prepare('SELECT verify_recovery_attempts FROM factory_projects WHERE id = ?').get(project.id).verify_recovery_attempts).toBe(0);
  });

  it('cancels live batch tasks before terminating an unrecoverable VERIFY instance', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'architect',
      title: 'Cancel stale batch task',
      description: 'The associated running task should be cancelled before the instance is abandoned.',
      status: 'verifying',
    });
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      work_item_id: item.id,
      batch_id: 'factory-test-cancel-batch',
    });
    const staleAt = new Date(Date.now() - (90 * 60 * 1000)).toISOString();
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.VERIFY,
      paused_at_stage: LOOP_STATES.VERIFY,
      last_action_at: staleAt,
    });
    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.PAUSED,
      loop_paused_at_stage: LOOP_STATES.VERIFY,
      loop_batch_id: 'factory-test-cancel-batch',
      loop_last_action_at: staleAt,
    });
    db.prepare('UPDATE factory_projects SET verify_recovery_attempts = 2 WHERE id = ?').run(project.id);
    taskCore.createTask({
      id: 'task-stale-verify-batch',
      status: 'running',
      task_description: 'stale batch task',
      working_directory: project.path,
      tags: [
        'factory:batch_id=factory-test-cancel-batch',
        `factory:work_item_id=${item.id}`,
        'factory:plan_task_number=1',
        'project:torque-public',
      ],
    });
    const taskManager = {
      cancelTask: vi.fn((taskId, _reason, options) => {
        taskCore.updateTaskStatus(taskId, options.terminal_status || 'cancelled', {
          cancel_reason: options.cancel_reason,
        });
        return true;
      }),
    };

    const resolution = await factoryTick._internalForTests.resolveUnrecoverableVerifyLoop(
      {
        project_id: project.id,
        attempts: 2,
        last_action_at: staleAt,
      },
      { cancelGraceMs: 0, taskCore, taskManager },
    );

    expect(taskManager.cancelTask).toHaveBeenCalledWith(
      'task-stale-verify-batch',
      expect.stringContaining('VERIFY stall recovery exhausted'),
      { cancel_reason: 'factory_verify_unrecoverable', terminal_status: 'failed' },
    );
    expect(resolution.cancelled_tasks).toEqual(['task-stale-verify-batch']);
    expect(taskCore.getTask('task-stale-verify-batch')).toMatchObject({
      status: 'failed',
      cancel_reason: null,
    });
    expect(factoryLoopInstances.getInstance(instance.id).terminated_at).toBeTruthy();
    expect(factoryIntake.getWorkItem(item.id)).toMatchObject({
      status: 'rejected',
      reject_reason: 'verify_stalled_after_2_recovery_attempts',
    });
  });

  it('cancels active factory tasks whose work item is already closed', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const rejectedItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'architect',
      title: 'Already rejected item',
      description: 'Any still-running tasks for this item are stale.',
      status: 'rejected',
      reject_reason: 'verify_stalled_after_2_recovery_attempts',
    });
    const executingItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'architect',
      title: 'Still active item',
      description: 'This task should remain running.',
      status: 'executing',
    });
    taskCore.createTask({
      id: 'task-closed-work-item',
      status: 'running',
      task_description: 'stale closed work item task',
      working_directory: project.path,
      tags: [`factory:work_item_id=${rejectedItem.id}`, 'project:torque-public'],
    });
    taskCore.createTask({
      id: 'task-active-work-item',
      status: 'running',
      task_description: 'active work item task',
      working_directory: project.path,
      tags: [`factory:work_item_id=${executingItem.id}`, 'project:torque-public'],
    });
    const taskManager = {
      cancelTask: vi.fn((taskId, _reason, options) => {
        taskCore.updateTaskStatus(taskId, options.terminal_status || 'cancelled', {
          cancel_reason: options.cancel_reason,
        });
        return true;
      }),
    };

    const result = await factoryTick._internalForTests.cancelClosedFactoryWorkItemTasks(
      project.id,
      { cancelGraceMs: 0, taskCore, taskManager },
    );

    expect(result.cancelled_task_ids).toEqual(['task-closed-work-item']);
    expect(taskManager.cancelTask).toHaveBeenCalledTimes(1);
    expect(taskCore.getTask('task-closed-work-item')).toMatchObject({
      status: 'skipped',
      cancel_reason: null,
    });
    expect(taskCore.getTask('task-active-work-item')).toMatchObject({
      status: 'running',
    });
  });

  it('cancels active factory tasks whose work item is escalation_exhausted', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const exhaustedItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'architect',
      title: 'Exhausted item',
      description: 'Same-shape escalation exhausted this work item.',
      status: 'escalation_exhausted',
      reject_reason: 'escalation_exhausted: chain_exhausted after 3x same-shape',
    });
    taskCore.createTask({
      id: 'task-escalation-exhausted-work-item',
      status: 'running',
      task_description: 'stale exhausted work item task',
      working_directory: project.path,
      tags: [`factory:work_item_id=${exhaustedItem.id}`, 'project:torque-public'],
    });
    const taskManager = {
      cancelTask: vi.fn((taskId, _reason, options) => {
        taskCore.updateTaskStatus(taskId, options.terminal_status || 'cancelled', {
          cancel_reason: options.cancel_reason,
        });
        return true;
      }),
    };

    const result = await factoryTick._internalForTests.cancelClosedFactoryWorkItemTasks(
      project.id,
      { cancelGraceMs: 0, taskCore, taskManager },
    );

    expect(result.cancelled_task_ids).toEqual(['task-escalation-exhausted-work-item']);
    expect(result.closed_work_item_ids).toEqual([exhaustedItem.id]);
    expect(taskCore.getTask('task-escalation-exhausted-work-item')).toMatchObject({
      status: 'skipped',
      cancel_reason: null,
    });
  });

  it('cancels orphan factory-internal target-project tasks when the project is idle with no open work', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: false });
    taskCore.createTask({
      id: 'task-orphan-internal-idle',
      status: 'running',
      project: 'factory-architect',
      provider: 'codex',
      task_description: 'stale orphan architect handoff',
      working_directory: project.path,
      tags: [
        'factory:internal',
        'factory:architect_cycle',
        `factory:project_id=${project.id}`,
        `factory:target_project=${project.name}`,
      ],
      metadata: {
        factory_internal: true,
        kind: 'architect_cycle',
        project_id: project.id,
        target_project: project.name,
        agentic_handoff_from: 'ollama-cloud',
        agentic_handoff_to: 'codex',
      },
    });
    const taskManager = {
      cancelTask: vi.fn((taskId, _reason, options) => {
        taskCore.updateTaskStatus(taskId, options.terminal_status || 'cancelled', {
          cancel_reason: options.cancel_reason,
        });
        return true;
      }),
    };

    const result = await factoryTick._internalForTests.cancelOrphanInternalTasksForIdleProject(
      project,
      { cancelGraceMs: 0, taskCore, taskManager },
    );

    expect(result.cancelled_task_ids).toEqual(['task-orphan-internal-idle']);
    expect(taskManager.cancelTask).toHaveBeenCalledWith(
      'task-orphan-internal-idle',
      expect.stringContaining('no open work items or active loop instances'),
      expect.objectContaining({
        cancel_reason: 'factory_orphan_internal_idle',
        terminal_status: 'skipped',
      }),
    );
    expect(taskCore.getTask('task-orphan-internal-idle')).toMatchObject({
      status: 'skipped',
    });
  });

  it('keeps orphan factory-internal tasks when open work still exists', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: false });
    factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Open item',
      description: 'A legitimate prioritize cycle may still need the architect task.',
      status: 'pending',
    });
    taskCore.createTask({
      id: 'task-orphan-internal-with-open-work',
      status: 'running',
      project: 'factory-architect',
      provider: 'codex',
      task_description: 'active architect cycle',
      working_directory: project.path,
      tags: [
        'factory:internal',
        'factory:architect_cycle',
        `factory:project_id=${project.id}`,
        `factory:target_project=${project.name}`,
      ],
      metadata: {
        factory_internal: true,
        kind: 'architect_cycle',
        project_id: project.id,
        target_project: project.name,
      },
    });
    const taskManager = { cancelTask: vi.fn() };

    const result = await factoryTick._internalForTests.cancelOrphanInternalTasksForIdleProject(
      project,
      { cancelGraceMs: 0, taskCore, taskManager },
    );

    expect(result).toMatchObject({
      cancelled_task_ids: [],
      skipped_reason: 'open_work_items',
    });
    expect(taskManager.cancelTask).not.toHaveBeenCalled();
    expect(taskCore.getTask('task-orphan-internal-with-open-work')).toMatchObject({
      status: 'running',
    });
  });

  it('allows internal task submission for a running project', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: false });
    const { submitFactoryInternalTask } = require('../factory/internal-task-submit');

    await expect(submitFactoryInternalTask({
      task: 'generate a plan',
      working_directory: project.path,
      kind: 'plan_generation',
      project_id: project.id,
    })).resolves.toEqual({ task_id: 'factory-internal-task-1' });

    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('auto-clears a VERIFY gate paused with reason=batch_tasks_not_terminal when the batch becomes terminal', async () => {
    const decisionLog = require('../factory/decision-log');
    const factoryDecisions = require('../db/factory-decisions');
    factoryDecisions.setDb(db);

    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const batchId = `test-batch-${Date.now()}`;
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      batch_id: batchId,
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.VERIFY,
      paused_at_stage: LOOP_STATES.VERIFY,
    });

    db.prepare(`
      INSERT INTO tasks (id, task_description, provider, status, tags, working_directory, created_at)
      VALUES (?, 'batch-task-1', 'ollama', 'completed', ?, ?, datetime('now'))
    `).run('batch-task-1', JSON.stringify([`factory:batch_id=${batchId}`]), project.path);

    decisionLog.logDecision({
      project_id: project.id,
      stage: 'verify',
      actor: 'human',
      action: 'paused_at_gate',
      reasoning: 'Loop paused awaiting approval for VERIFY.',
      inputs: { previous_state: 'VERIFY', trust_level: 'dark' },
      outcome: {
        from_state: 'VERIFY',
        to_state: 'PAUSED',
        gate_stage: 'VERIFY',
        reason: 'batch_tasks_not_terminal',
      },
      confidence: 1,
      batch_id: batchId,
    });

    const approveSpy = vi.spyOn(loopController, 'approveGateForProject');
    const staleRunningProject = factoryHealth.getProject(project.id);

    await factoryTick.tickProject(staleRunningProject);

    expect(approveSpy).toHaveBeenCalledWith(project.id, 'VERIFY');
    const afterTick = factoryLoopInstances.getInstance(instance.id);
    expect(afterTick.paused_at_stage).toBeNull();
  });

  it('auto-clears a paused project-row VERIFY batch wait when the batch becomes terminal', async () => {
    const decisionLog = require('../factory/decision-log');
    const factoryDecisions = require('../db/factory-decisions');
    factoryDecisions.setDb(db);

    const project = registerFactoryProject({ status: 'paused', autoContinue: true });
    const batchId = `test-batch-paused-project-${Date.now()}`;
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      batch_id: batchId,
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.VERIFY,
      paused_at_stage: LOOP_STATES.VERIFY,
    });

    db.prepare(`
      INSERT INTO tasks (id, task_description, provider, status, tags, working_directory, created_at)
      VALUES (?, 'batch-task-1', 'ollama', 'completed', ?, ?, datetime('now'))
    `).run('paused-project-batch-task-1', JSON.stringify([`factory:batch_id=${batchId}`]), project.path);

    decisionLog.logDecision({
      project_id: project.id,
      stage: 'verify',
      actor: 'auto-recovery',
      action: 'paused_at_gate',
      reasoning: 'Loop paused awaiting batch task completion for VERIFY.',
      inputs: { previous_state: 'VERIFY', trust_level: 'dark' },
      outcome: {
        from_state: 'VERIFY',
        to_state: 'PAUSED',
        gate_stage: 'VERIFY',
        reason: 'batch_tasks_not_terminal',
      },
      confidence: 1,
      batch_id: batchId,
    });

    const approveSpy = vi.spyOn(loopController, 'approveGateForProject');

    await factoryTick.tickProject(factoryHealth.getProject(project.id));

    expect(approveSpy).toHaveBeenCalledWith(project.id, 'VERIFY');
    expect(factoryHealth.getProject(project.id).status).toBe('running');
    const afterTick = factoryLoopInstances.getInstance(instance.id);
    expect(afterTick.paused_at_stage).toBeNull();
  });

  it('starts ticks for paused project-row VERIFY batch waits on startup', () => {
    vi.useFakeTimers();
    const decisionLog = require('../factory/decision-log');
    const factoryDecisions = require('../db/factory-decisions');
    factoryDecisions.setDb(db);

    try {
      const project = registerFactoryProject({ status: 'paused', autoContinue: true });
      const batchId = `test-batch-startup-paused-${Date.now()}`;
      const instance = factoryLoopInstances.createInstance({
        project_id: project.id,
        batch_id: batchId,
      });
      factoryLoopInstances.updateInstance(instance.id, {
        loop_state: LOOP_STATES.VERIFY,
        paused_at_stage: LOOP_STATES.VERIFY,
      });

      db.prepare(`
        INSERT INTO tasks (id, task_description, provider, status, tags, working_directory, created_at)
        VALUES (?, 'batch-task-1', 'ollama', 'running', ?, ?, datetime('now'))
      `).run('startup-paused-project-batch-task-1', JSON.stringify([`factory:batch_id=${batchId}`]), project.path);

      decisionLog.logDecision({
        project_id: project.id,
        stage: 'verify',
        actor: 'auto-recovery',
        action: 'paused_at_gate',
        reasoning: 'Loop paused awaiting batch task completion for VERIFY.',
        inputs: { previous_state: 'VERIFY', trust_level: 'dark' },
        outcome: {
          from_state: 'VERIFY',
          to_state: 'PAUSED',
          gate_stage: 'VERIFY',
          reason: 'batch_tasks_not_terminal',
        },
        confidence: 1,
        batch_id: batchId,
      });

      expect(factoryTick._internalForTests.hasPausedVerifyBatchWait(factoryHealth.getProject(project.id))).toBe(true);
      expect(factoryTick.initFactoryTicks()).toBe(1);
    } finally {
      factoryTick.stopAll();
      vi.useRealTimers();
    }
  });

  it('auto-clears a VERIFY gate when batch tasks are all skipped', async () => {
    const decisionLog = require('../factory/decision-log');
    const factoryDecisions = require('../db/factory-decisions');
    factoryDecisions.setDb(db);

    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const batchId = `test-batch-skipped-${Date.now()}`;
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      batch_id: batchId,
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.VERIFY,
      paused_at_stage: LOOP_STATES.VERIFY,
    });

    db.prepare(`
      INSERT INTO tasks (id, task_description, provider, status, tags, working_directory, created_at)
      VALUES (?, 'batch-task-1', 'ollama', 'skipped', ?, ?, datetime('now')),
             (?, 'batch-task-2', 'ollama', 'skipped', ?, ?, datetime('now'))
    `).run(
      'skipped-batch-task-1', JSON.stringify([`factory:batch_id=${batchId}`]), project.path,
      'skipped-batch-task-2', JSON.stringify([`factory:batch_id=${batchId}`]), project.path,
    );

    decisionLog.logDecision({
      project_id: project.id,
      stage: 'verify',
      actor: 'human',
      action: 'paused_at_gate',
      reasoning: 'Loop paused awaiting approval for VERIFY.',
      outcome: {
        from_state: 'VERIFY',
        to_state: 'PAUSED',
        gate_stage: 'VERIFY',
        reason: 'batch_tasks_not_terminal',
      },
      confidence: 1,
      batch_id: batchId,
    });

    const approveSpy = vi.spyOn(loopController, 'approveGateForProject');
    const staleRunningProject = factoryHealth.getProject(project.id);

    await factoryTick.tickProject(staleRunningProject);

    expect(approveSpy).toHaveBeenCalledWith(project.id, 'VERIFY');
    const afterTick = factoryLoopInstances.getInstance(instance.id);
    expect(afterTick.paused_at_stage).toBeNull();
  });

  it('does not treat VERIFY batch waits with retry_scheduled tasks as unrecoverable stalls', async () => {
    const decisionLog = require('../factory/decision-log');
    const factoryDecisions = require('../db/factory-decisions');
    factoryDecisions.setDb(db);

    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'architect',
      title: 'Wait for retried batch task',
      description: 'Retry-scheduled batch tasks should block VERIFY recovery instead of rejecting the work item.',
      status: 'verifying',
    });
    const batchId = `test-batch-retry-${Date.now()}`;
    const staleAt = new Date(Date.now() - (90 * 60 * 1000)).toISOString();
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      work_item_id: item.id,
      batch_id: batchId,
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.VERIFY,
      paused_at_stage: LOOP_STATES.VERIFY,
      last_action_at: staleAt,
    });
    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.PAUSED,
      loop_paused_at_stage: LOOP_STATES.VERIFY,
      loop_batch_id: batchId,
      loop_last_action_at: staleAt,
    });
    db.prepare('UPDATE factory_projects SET verify_recovery_attempts = 2 WHERE id = ?').run(project.id);

    taskCore.createTask({
      id: 'retry-scheduled-batch-task',
      status: 'retry_scheduled',
      task_description: 'still draining retry budget',
      working_directory: project.path,
      tags: [
        `factory:batch_id=${batchId}`,
        `factory:work_item_id=${item.id}`,
        'factory:plan_task_number=2',
        'project:torque-public',
      ],
    });

    decisionLog.logDecision({
      project_id: project.id,
      stage: 'verify',
      actor: 'human',
      action: 'paused_at_gate',
      reasoning: 'Loop paused awaiting approval for VERIFY.',
      outcome: {
        from_state: 'VERIFY',
        to_state: 'PAUSED',
        gate_stage: 'VERIFY',
        reason: 'batch_tasks_not_terminal',
      },
      confidence: 1,
      batch_id: batchId,
    });

    const approveSpy = vi.spyOn(loopController, 'approveGateForProject');
    const staleRunningProject = factoryHealth.getProject(project.id);

    await factoryTick.tickProject(staleRunningProject);

    expect(approveSpy).not.toHaveBeenCalled();
    expect(factoryLoopInstances.getInstance(instance.id).terminated_at).toBeNull();
    expect(factoryIntake.getWorkItem(item.id)).toMatchObject({
      status: 'verifying',
      reject_reason: null,
    });
    expect(taskCore.getTask('retry-scheduled-batch-task')).toMatchObject({
      status: 'retry_scheduled',
    });
    expect(db.prepare('SELECT verify_recovery_attempts FROM factory_projects WHERE id = ?').get(project.id).verify_recovery_attempts).toBe(2);
  });

  it('does not auto-clear a VERIFY gate when a batch task is still non-terminal', async () => {
    const decisionLog = require('../factory/decision-log');
    const factoryDecisions = require('../db/factory-decisions');
    factoryDecisions.setDb(db);

    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const batchId = `test-batch-pending-${Date.now()}`;
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      batch_id: batchId,
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.VERIFY,
      paused_at_stage: LOOP_STATES.VERIFY,
    });

    db.prepare(`
      INSERT INTO tasks (id, task_description, provider, status, tags, working_directory, created_at)
      VALUES (?, 'batch-task-1', 'ollama', 'completed', ?, ?, datetime('now')),
             (?, 'batch-task-2', 'ollama', 'running',   ?, ?, datetime('now'))
    `).run(
      'pending-batch-task-1', JSON.stringify([`factory:batch_id=${batchId}`]), project.path,
      'pending-batch-task-2', JSON.stringify([`factory:batch_id=${batchId}`]), project.path,
    );

    decisionLog.logDecision({
      project_id: project.id,
      stage: 'verify',
      actor: 'human',
      action: 'paused_at_gate',
      reasoning: 'Loop paused awaiting approval for VERIFY.',
      outcome: { reason: 'batch_tasks_not_terminal' },
      confidence: 1,
      batch_id: batchId,
    });

    const approveSpy = vi.spyOn(loopController, 'approveGateForProject');
    const staleRunningProject = factoryHealth.getProject(project.id);

    await factoryTick.tickProject(staleRunningProject);

    expect(approveSpy).not.toHaveBeenCalled();
    expect(factoryLoopInstances.getInstance(instance.id).paused_at_stage).toBe('VERIFY');
  });

  it('does not terminate paused EXECUTE when the empty batch is waiting on plan generation', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const batchId = `factory-plan-gen-${Date.now()}`;
    const planPath = path.join(project.path, 'docs', 'superpowers', 'plans', 'auto-generated', 'tick-plan.md');
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'architect',
      title: 'Generate plan before execution',
      description: 'Exercise tick preservation for deferred plan generation.',
      requestor: 'test',
      origin: {
        plan_path: planPath,
        plan_generation_task_id: 'tick-plan-generation-task',
      },
      status: 'planned',
    });
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      work_item_id: item.id,
      batch_id: batchId,
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.EXECUTE,
      paused_at_stage: LOOP_STATES.EXECUTE,
      work_item_id: item.id,
      batch_id: batchId,
    });
    factoryIntake.updateWorkItem(item.id, {
      batch_id: batchId,
      claimed_by_instance_id: instance.id,
    });
    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.EXECUTE,
      loop_batch_id: batchId,
      loop_paused_at_stage: LOOP_STATES.EXECUTE,
    });
    taskCore.createTask({
      id: 'tick-plan-generation-task',
      status: 'completed',
      task_description: 'Generate a plan',
      working_directory: project.path,
      project: 'factory-plan',
      tags: [
        'factory:internal',
        'factory:plan_generation',
        `factory:work_item_id=${item.id}`,
      ],
    });
    const terminateSpy = vi.spyOn(loopController, 'terminateInstanceAndSync');
    const advanceSpy = vi.spyOn(loopController, 'advanceLoopAsync')
      .mockReturnValue({ status: 'running', job_id: 'advance-plan-generation' });

    await factoryTick.tickProject(factoryHealth.getProject(project.id));

    expect(terminateSpy).not.toHaveBeenCalled();
    expect(factoryLoopInstances.getInstance(instance.id).terminated_at).toBeNull();
    expect(advanceSpy).toHaveBeenCalledWith(instance.id, { autoAdvance: true });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('resume restores normal tick auto-start behavior', async () => {
    const project = registerFactoryProject({ status: 'paused', autoContinue: true });
    const stalePausedProject = factoryHealth.getProject(project.id);
    factoryHealth.updateProject(project.id, { status: 'running' });
    const startSpy = vi.spyOn(loopController, 'startLoopAutoAdvance')
      .mockReturnValue({ project_id: project.id, instance_id: 'started-after-resume' });

    await factoryTick.tickProject(stalePausedProject);

    expect(startSpy).toHaveBeenCalledWith(project.id);
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
