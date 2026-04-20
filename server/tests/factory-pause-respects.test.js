'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const factoryHealth = require('../db/factory-health');
const factoryLoopInstances = require('../db/factory-loop-instances');
const routingModule = require('../handlers/integration/routing');
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
