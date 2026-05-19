'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const factoryLoopInstances = require('../db/factory/loop-instances');
const taskCore = require('../db/task-core');
const routingModule = require('../handlers/integration/routing');
const factoryHandlers = require('../handlers/factory-handlers');
const factoryTick = require('../factory/factory-tick');
const loopController = require('../factory/loop-controller');
const baselineAutoFix = require('../factory/baseline-auto-fix');
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
    factoryTick._internalForTests.setTestRunnerRegistryForTests(null);
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

  function markOperatorPaused(project, reason = 'test pause') {
    const cfg = project.config_json ? JSON.parse(project.config_json) : {};
    cfg.loop = {
      ...(cfg.loop || {}),
      operator_paused: true,
      operator_paused_at: new Date().toISOString(),
      operator_pause_reason: reason,
    };
    return factoryHealth.updateProject(project.id, {
      status: 'paused',
      config_json: JSON.stringify(cfg),
    });
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

  it('does not auto-start a new loop for string auto-continue config', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: 'true' });
    const startSpy = vi.spyOn(loopController, 'startLoopAutoAdvance')
      .mockReturnValue({ project_id: project.id, instance_id: 'should-not-start' });

    await factoryTick.tickProject(factoryHealth.getProject(project.id));

    expect(startSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('does not auto-start a new loop when approval gates are still enabled', async () => {
    const project = registerFactoryProject({
      status: 'running',
      autoContinue: true,
      trustLevel: 'autonomous',
    });
    const startSpy = vi.spyOn(loopController, 'startLoopAutoAdvance')
      .mockReturnValue({ project_id: project.id, instance_id: 'should-not-start' });

    await factoryTick.tickProject(factoryHealth.getProject(project.id));

    expect(startSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('does not advance an active loop from the tick when automation readiness drifts off', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: false });
    const instance = factoryLoopInstances.createInstance({ project_id: project.id });
    const advanceSpy = vi.spyOn(loopController, 'advanceLoopAsync')
      .mockReturnValue({ status: 'running', job_id: 'should-not-advance' });

    await factoryTick.tickProject(factoryHealth.getProject(project.id));

    expect(advanceSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
    expect(factoryLoopInstances.getInstance(instance.id).loop_state).toBe(LOOP_STATES.SENSE);
  });

  it('advances an active loop from the tick when the project remains automation-ready', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const instance = factoryLoopInstances.createInstance({ project_id: project.id });
    const advanceSpy = vi.spyOn(loopController, 'advanceLoopAsync')
      .mockReturnValue({ status: 'running', job_id: 'ready-advance' });

    await factoryTick.tickProject(factoryHealth.getProject(project.id));

    expect(advanceSpy).toHaveBeenCalledWith(instance.id);
  });

  it('does not auto-resume a paused auto-continue project', async () => {
    const project = registerFactoryProject({ status: 'paused', autoContinue: true });

    await factoryTick.tickProject(project);

    expect(factoryHealth.getProject(project.id).status).toBe('paused');
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('operator pause terminates active loop instances and cancels scheduled advancement', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const instance = factoryLoopInstances.createInstance({ project_id: project.id });
    loopController._internalForTests.scheduleAutoAdvanceForTests(instance.id, 60_000, () => {});

    const result = await factoryHandlers.handlePauseProject({
      project: project.id,
      reason: 'manual stop',
      actor: 'operator',
    });
    const data = JSON.parse(result.content[0].text);
    const pausedProject = factoryHealth.getProject(project.id);
    const pausedConfig = JSON.parse(pausedProject.config_json);

    expect(data).toMatchObject({
      parked_tasks: 0,
      terminated_loop_instances: 1,
      terminated_loop_instance_ids: [instance.id],
    });
    expect(factoryLoopInstances.getInstance(instance.id).terminated_at).toBeTruthy();
    expect(loopController._internalForTests.getScheduledAutoAdvanceForTests(instance.id)).toBeNull();
    expect(pausedProject).toMatchObject({
      status: 'paused',
      loop_state: LOOP_STATES.IDLE,
      loop_batch_id: null,
      loop_paused_at_stage: null,
    });
    expect(pausedConfig.loop).toMatchObject({
      operator_paused: true,
      operator_pause_reason: 'manual stop',
    });
  });

  it('operator pause cancels running factory tasks for the project', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'architect',
      title: 'Running factory task',
      description: 'The provider process should be cancelled when the project pauses.',
      status: 'executing',
    });
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      batch_id: 'factory-pause-running-task',
      work_item_id: item.id,
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.EXECUTE,
      batch_id: 'factory-pause-running-task',
      work_item_id: item.id,
    });
    const factoryTaskDir = path.join(project.path, '.worktrees', 'factory-task');
    fs.mkdirSync(factoryTaskDir, { recursive: true });
    taskCore.createTask({
      id: 'task-running-factory-pause',
      status: 'running',
      task_description: 'running factory task',
      working_directory: factoryTaskDir,
      project: project.name,
      tags: [
        'factory:batch_id=factory-pause-running-task',
        `factory:work_item_id=${item.id}`,
        'factory:plan_task_number=1',
        `project:${project.name}`,
      ],
    });
    taskCore.createTask({
      id: 'task-running-manual-same-project',
      status: 'running',
      task_description: 'manual project task',
      working_directory: project.path,
      project: project.name,
      tags: [`project:${project.name}`],
    });
    const liveTaskManager = require('../task-manager');
    const cancelSpy = vi.spyOn(liveTaskManager, 'cancelTask')
      .mockImplementation((taskId, _reason, options = {}) => {
        taskCore.updateTaskStatus(taskId, options.terminal_status || 'cancelled', {
          cancel_reason: options.cancel_reason,
        });
        return true;
      });

    const result = await factoryHandlers.handlePauseProject({
      project: project.id,
      reason: 'manual stop',
      actor: 'operator',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data).toMatchObject({
      cancelled_tasks: 1,
      cancelled_task_ids: ['task-running-factory-pause'],
      failed_task_cancellations: [],
      terminated_loop_instances: 1,
    });
    expect(cancelSpy).toHaveBeenCalledWith(
      'task-running-factory-pause',
      expect.stringContaining(`Factory project "${project.name}" was paused`),
      { cancel_reason: 'factory_project_paused', terminal_status: 'cancelled' },
    );
    expect(taskCore.getTask('task-running-factory-pause')).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'factory_project_paused',
    });
    expect(taskCore.getTask('task-running-manual-same-project')).toMatchObject({
      status: 'running',
    });
  });

  it('pause-all marks already-paused projects as operator-paused and terminates stale active loops', async () => {
    const runningProject = registerFactoryProject({ status: 'running', autoContinue: true });
    const pausedProject = registerFactoryProject({ status: 'paused', autoContinue: true });
    const runningInstance = factoryLoopInstances.createInstance({ project_id: runningProject.id });
    const pausedInstance = factoryLoopInstances.createInstance({ project_id: pausedProject.id });

    const result = await factoryHandlers.handlePauseAllProjects({ reason: 'fleet stop' });
    const data = JSON.parse(result.content[0].text);

    expect(data).toMatchObject({
      total: 2,
      paused: 1,
      already_paused: 1,
      terminated_loop_instances: 2,
    });
    for (const project of [runningProject, pausedProject]) {
      const fresh = factoryHealth.getProject(project.id);
      expect(fresh.status).toBe('paused');
      expect(JSON.parse(fresh.config_json).loop).toMatchObject({
        operator_paused: true,
        operator_pause_reason: 'fleet stop',
      });
    }
    expect(factoryLoopInstances.getInstance(runningInstance.id).terminated_at).toBeTruthy();
    expect(factoryLoopInstances.getInstance(pausedInstance.id).terminated_at).toBeTruthy();
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

  it('runAdvanceLoop stops when terminal escalation evidence survived but status was resurrected', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'architect',
      title: 'Resurrected exhausted selected item',
      description: 'A stale needs_replan write must not revive exhausted work.',
      status: 'needs_replan',
      origin: {
        last_escalation: {
          kind: 'chain_exhausted',
          reason_shape: 'empty_branch_after_execute',
        },
      },
    });
    const batchId = `factory-resurrected-closed-item-${Date.now()}`;
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
      reason: 'work_item_closed_escalation_exhausted_origin',
    });
    expect(result.stage_result).toMatchObject({
      status: 'stopped',
      work_item_id: item.id,
      work_item_status: 'escalation_exhausted',
    });
    expect(factoryIntake.getWorkItem(item.id)).toMatchObject({
      status: 'escalation_exhausted',
      reject_reason: 'escalation_exhausted: chain_exhausted (empty_branch_after_execute)',
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
    const startTickSpy = vi.spyOn(factoryTick, 'startTick').mockImplementation(() => ({
      started: true,
      already_active: false,
    }));

    const response = await factoryHandlers.handleRetryFactoryVerify({
      project: project.id,
      actor: 'test-operator',
    });

    expect(response.structuredData).toMatchObject({
      project_id: project.id,
      state: LOOP_STATES.VERIFY,
      project_resumed: true,
      project_status: 'running',
      tick_armed: true,
      tick_started: true,
      tick_skipped_reason: null,
      automation_readiness: {
        ready: true,
      },
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

  it('retry_factory_verify resumes but does not restart ticking when automation controls are blocked', async () => {
    const project = registerFactoryProject({
      status: 'paused',
      autoContinue: false,
      trustLevel: 'autonomous',
    });
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'Retry paused verify project without automation',
      description: 'The project row can resume, but the recurring tick should not arm.',
      status: 'verifying',
    });
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      work_item_id: item.id,
      batch_id: 'factory-retry-paused-verify-blocked',
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
      tick_armed: false,
      tick_started: false,
      tick_skipped_reason: 'automation_not_ready',
      automation_readiness: {
        ready: false,
        blocker_codes: expect.arrayContaining(['auto_continue_disabled', 'approval_gates_enabled']),
      },
    });
    expect(factoryHealth.getProject(project.id).status).toBe('running');
    expect(factoryLoopInstances.getInstance(instance.id).paused_at_stage).toBeNull();
    expect(startTickSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
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

  it('cancels active factory tasks whose work item has resurrected terminal escalation evidence', async () => {
    const project = registerFactoryProject({ status: 'running', autoContinue: true });
    const exhaustedItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'architect',
      title: 'Resurrected exhausted item',
      description: 'A later needs_replan write should not keep its task alive.',
      status: 'needs_replan',
      origin: {
        last_escalation: {
          kind: 'chain_exhausted',
          reason_shape: 'empty_branch_after_execute',
        },
      },
    });
    taskCore.createTask({
      id: 'task-resurrected-exhausted-work-item',
      status: 'running',
      task_description: 'stale resurrected exhausted work item task',
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

    expect(result.cancelled_task_ids).toEqual(['task-resurrected-exhausted-work-item']);
    expect(result.closed_work_item_ids).toEqual([exhaustedItem.id]);
    expect(factoryIntake.getWorkItem(exhaustedItem.id)).toMatchObject({
      status: 'escalation_exhausted',
      reject_reason: 'escalation_exhausted: chain_exhausted (empty_branch_after_execute)',
    });
    expect(taskCore.getTask('task-resurrected-exhausted-work-item')).toMatchObject({
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
    const factoryDecisions = require('../db/factory/decisions');
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
    const factoryDecisions = require('../db/factory/decisions');
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

  it('does not auto-clear an operator-paused VERIFY batch wait when the batch becomes terminal', async () => {
    const decisionLog = require('../factory/decision-log');
    const factoryDecisions = require('../db/factory/decisions');
    factoryDecisions.setDb(db);

    const project = markOperatorPaused(registerFactoryProject({ status: 'running', autoContinue: true }));
    const batchId = `test-batch-operator-paused-${Date.now()}`;
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
    `).run('operator-paused-project-batch-task-1', JSON.stringify([`factory:batch_id=${batchId}`]), project.path);

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

    expect(approveSpy).not.toHaveBeenCalled();
    expect(factoryHealth.getProject(project.id).status).toBe('paused');
    const afterTick = factoryLoopInstances.getInstance(instance.id);
    expect(afterTick.paused_at_stage).toBe(LOOP_STATES.VERIFY);
  });

  it('only starts startup ticks for running projects that are automation-ready', () => {
    vi.useFakeTimers();

    try {
      registerFactoryProject({ status: 'running', autoContinue: true });
      registerFactoryProject({ status: 'running', autoContinue: false });
      registerFactoryProject({
        status: 'running',
        autoContinue: true,
        trustLevel: 'autonomous',
      });

      const setImmediateSpy = vi.spyOn(global, 'setImmediate');
      expect(factoryTick.initFactoryTicks()).toBe(1);
      expect(setImmediateSpy).not.toHaveBeenCalled();
    } finally {
      factoryTick.stopAll();
      vi.useRealTimers();
    }
  });

  it('does not start startup ticks when factory project work is disabled', () => {
    const previous = process.env.TORQUE_FACTORY_PROJECT_WORK_ENABLED;
    process.env.TORQUE_FACTORY_PROJECT_WORK_ENABLED = '0';
    vi.useFakeTimers();

    try {
      registerFactoryProject({ status: 'running', autoContinue: true });
      const paused = registerFactoryProject({ status: 'paused', autoContinue: true });
      factoryHealth.updateProject(paused.id, {
        config_json: JSON.stringify({
          loop: { auto_continue: true },
          baseline_broken_since: new Date().toISOString(),
        }),
      });

      const setImmediateSpy = vi.spyOn(global, 'setImmediate');
      expect(factoryTick.initFactoryTicks()).toBe(0);
      expect(setImmediateSpy).not.toHaveBeenCalled();
    } finally {
      factoryTick.stopAll();
      vi.useRealTimers();
      if (previous === undefined) {
        delete process.env.TORQUE_FACTORY_PROJECT_WORK_ENABLED;
      } else {
        process.env.TORQUE_FACTORY_PROJECT_WORK_ENABLED = previous;
      }
    }
  });

  it('starts ticks for paused project-row VERIFY batch waits on startup', () => {
    vi.useFakeTimers();
    const decisionLog = require('../factory/decision-log');
    const factoryDecisions = require('../db/factory/decisions');
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
      const setImmediateSpy = vi.spyOn(global, 'setImmediate');
      expect(factoryTick.initFactoryTicks()).toBe(1);
      expect(setImmediateSpy).toHaveBeenCalledTimes(1);
    } finally {
      factoryTick.stopAll();
      vi.useRealTimers();
    }
  });

  it('does not start ticks for operator-paused VERIFY batch waits on startup', () => {
    vi.useFakeTimers();
    const decisionLog = require('../factory/decision-log');
    const factoryDecisions = require('../db/factory/decisions');
    factoryDecisions.setDb(db);

    try {
      const project = markOperatorPaused(registerFactoryProject({ status: 'running', autoContinue: true }));
      const batchId = `test-batch-startup-operator-paused-${Date.now()}`;
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
      `).run('startup-operator-paused-project-batch-task-1', JSON.stringify([`factory:batch_id=${batchId}`]), project.path);

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

      expect(factoryTick._internalForTests.hasPausedVerifyBatchWait(factoryHealth.getProject(project.id))).toBe(false);
      expect(factoryTick.initFactoryTicks()).toBe(0);
    } finally {
      factoryTick.stopAll();
      vi.useRealTimers();
    }
  });

  it('baseline auto-fix does not resume a project after an operator pause lands during a probe', () => {
    const factoryDecisions = require('../db/factory/decisions');
    factoryDecisions.setDb(db);
    const project = registerFactoryProject({ status: 'paused', autoContinue: true });
    const cfg = {
      loop: { auto_continue: true },
      baseline_broken_since: new Date(Date.now() - 60_000).toISOString(),
      baseline_fix_attempts: 0,
    };
    const staleRunningSnapshot = factoryHealth.updateProject(project.id, {
      status: 'running',
      config_json: JSON.stringify(cfg),
    });
    const operatorCfg = {
      ...cfg,
      loop: {
        ...cfg.loop,
        operator_paused: true,
        operator_paused_at: new Date().toISOString(),
        operator_pause_reason: 'operator paused while baseline probe was running',
      },
    };
    factoryHealth.updateProject(project.id, {
      status: 'paused',
      config_json: JSON.stringify(operatorCfg),
    });

    const result = baselineAutoFix.runBaselineAutoFix({
      project: staleRunningSnapshot,
      cfg,
      probe: { output: 'Example.Namespace.Test [FAIL]' },
      deps: {
        factoryHealth,
        factoryIntake,
        factoryDecisions,
        logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
        db,
      },
    });

    expect(result.action).toBe('operator_paused');
    const fresh = factoryHealth.getProject(project.id);
    expect(fresh.status).toBe('paused');
    expect(JSON.parse(fresh.config_json).loop).toMatchObject({
      operator_paused: true,
      operator_pause_reason: 'operator paused while baseline probe was running',
    });
    expect(factoryIntake.listWorkItems({ project_id: project.id })).toHaveLength(0);
    const decisions = db.prepare(`
      SELECT action
      FROM factory_decisions
      WHERE project_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).all(project.id);
    expect(decisions[0]?.action).toBe('baseline_auto_fix_skipped_operator_paused');
  });

  it('green baseline probe does not resume a project after an operator pause lands during the probe', async () => {
    const project = registerFactoryProject({ status: 'paused', autoContinue: true });
    const cfg = {
      loop: { auto_continue: true },
      baseline_broken_since: new Date(Date.now() - 60_000).toISOString(),
      baseline_broken_probe_attempts: 0,
      baseline_broken_tick_count: 1,
      baseline_verify_command: 'echo baseline green',
    };
    factoryHealth.updateProject(project.id, {
      status: 'paused',
      config_json: JSON.stringify(cfg),
    });
    factoryTick._internalForTests.setTestRunnerRegistryForTests({
      runVerifyCommand: vi.fn(async () => {
        const latest = factoryHealth.getProject(project.id);
        const latestCfg = latest.config_json ? JSON.parse(latest.config_json) : {};
        latestCfg.loop = {
          ...(latestCfg.loop || {}),
          operator_paused: true,
          operator_paused_at: new Date().toISOString(),
          operator_pause_reason: 'operator paused while green baseline probe was running',
        };
        factoryHealth.updateProject(project.id, {
          status: 'paused',
          config_json: JSON.stringify(latestCfg),
        });
        return {
          exitCode: 0,
          output: 'ok',
          error: '',
          durationMs: 1,
          timedOut: false,
        };
      }),
    });

    await factoryTick.tickProject(factoryHealth.getProject(project.id));

    const fresh = factoryHealth.getProject(project.id);
    expect(fresh.status).toBe('paused');
    const freshCfg = JSON.parse(fresh.config_json);
    expect(freshCfg.loop).toMatchObject({
      operator_paused: true,
      operator_pause_reason: 'operator paused while green baseline probe was running',
    });
    expect(freshCfg.baseline_broken_since).toBeTruthy();
  });

  it('auto-clears a VERIFY gate when batch tasks are all skipped', async () => {
    const decisionLog = require('../factory/decision-log');
    const factoryDecisions = require('../db/factory/decisions');
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
    const factoryDecisions = require('../db/factory/decisions');
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
    const factoryDecisions = require('../db/factory/decisions');
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
      paused_at_stage: loopController.EXECUTE_DEFERRED_PAUSED_AT_STAGE,
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
      loop_paused_at_stage: loopController.EXECUTE_DEFERRED_PAUSED_AT_STAGE,
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
    expect(advanceSpy).toHaveBeenCalledWith(instance.id);
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
