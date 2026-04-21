'use strict';

const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const configCore = require('../db/config-core');
const factoryTick = require('../factory/factory-tick');
const {
  RECOVERY_DECISION_ACTION,
  resetRejectedRecoverySweepStateForTests,
} = require('../factory/rejected-recovery');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

let db;
let testDir;

function createDarkProject({ status = 'running' } = {}) {
  const suffix = Math.random().toString(16).slice(2);
  const project = factoryHealth.registerProject({
    name: `Rejected Recovery ${suffix}`,
    path: `${testDir}/${suffix}`,
    trust_level: 'dark',
    config: {
      loop: { auto_continue: false },
    },
  });

  return factoryHealth.updateProject(project.id, { status });
}

function createRunningDarkProject() {
  return createDarkProject({ status: 'running' });
}

function createRejectedWorkItem(projectId, {
  rejectReason = 'verify_failed_after_3_retries',
  updatedAt = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString(),
} = {}) {
  const item = factoryIntake.createWorkItem({
    project_id: projectId,
    source: 'manual',
    title: `Rejected item ${Math.random().toString(16).slice(2)}`,
    description: 'Exercise rejected recovery gating.',
    status: 'rejected',
  });

  db.prepare(`
    UPDATE factory_work_items
    SET reject_reason = ?,
        updated_at = ?
    WHERE id = ?
  `).run(rejectReason, updatedAt, item.id);

  return factoryIntake.getWorkItem(item.id);
}

function enableRejectRecovery({
  sweepIntervalMs = 60 * 1000,
  ageThresholdMs = 60 * 1000,
  maxReopens = 1,
} = {}) {
  configCore.setConfig('reject_recovery_enabled', '1');
  configCore.setConfig('reject_recovery_sweep_interval_ms', String(sweepIntervalMs));
  configCore.setConfig('reject_recovery_age_threshold_ms', String(ageThresholdMs));
  configCore.setConfig('reject_recovery_max_reopens', String(maxReopens));
}

beforeEach(() => {
  ({ testDir } = setupTestDbOnly(`rejected-recovery-${Date.now()}`));
  db = rawDb();
  resetRejectedRecoverySweepStateForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-18T18:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  factoryTick.stopAll();
  resetRejectedRecoverySweepStateForTests();
  teardownTestDb();
  db = null;
  testDir = null;
});

describe('rejected work item recovery sweep', () => {
  it('manual factory tick leaves rejected items closed when reject recovery is disabled', async () => {
    const project = createRunningDarkProject();
    const item = createRejectedWorkItem(project.id);

    await factoryTick.tickProject(project);

    expect(factoryIntake.getWorkItem(item.id)).toMatchObject({
      id: item.id,
      status: 'rejected',
      reject_reason: 'verify_failed_after_3_retries',
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM factory_decisions
      WHERE action = ?
    `).get(RECOVERY_DECISION_ACTION).count).toBe(0);
  });

  it('factory tick reopens eligible rejected items only when reject recovery is enabled', async () => {
    const project = createRunningDarkProject();
    const item = createRejectedWorkItem(project.id);
    enableRejectRecovery();

    await factoryTick.tickProject(project);

    expect(factoryIntake.getWorkItem(item.id)).toMatchObject({
      id: item.id,
      status: 'pending',
      reject_reason: null,
      claimed_by_instance_id: null,
      batch_id: null,
    });
    const decision = db.prepare(`
      SELECT action, batch_id, outcome_json
      FROM factory_decisions
      WHERE action = ?
    `).get(RECOVERY_DECISION_ACTION);
    expect(decision).toMatchObject({
      action: RECOVERY_DECISION_ACTION,
      batch_id: `reject-recovery:${item.id}`,
    });
    expect(JSON.parse(decision.outcome_json)).toMatchObject({
      work_item_id: item.id,
      status: 'pending',
      reopens: 1,
    });
  });

  it('factory tick runs at most one rejected recovery sweep per configured interval', async () => {
    const project = createRunningDarkProject();
    const first = createRejectedWorkItem(project.id);
    enableRejectRecovery({ sweepIntervalMs: 5 * 60 * 1000, maxReopens: 2 });

    await factoryTick.tickProject(project);

    const second = createRejectedWorkItem(project.id);
    await factoryTick.tickProject(project);

    expect(factoryIntake.getWorkItem(first.id).status).toBe('pending');
    expect(factoryIntake.getWorkItem(second.id)).toMatchObject({
      id: second.id,
      status: 'rejected',
      reject_reason: 'verify_failed_after_3_retries',
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM factory_decisions
      WHERE action = ?
    `).get(RECOVERY_DECISION_ACTION).count).toBe(1);

    vi.setSystemTime(new Date('2026-04-18T18:05:01.000Z'));
    await factoryTick.tickProject(project);

    expect(factoryIntake.getWorkItem(second.id).status).toBe('pending');
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM factory_decisions
      WHERE action = ?
    `).get(RECOVERY_DECISION_ACTION).count).toBe(2);
  });

  it('factory tick skips inactive projects and caps reopened items per sweep', async () => {
    const runningProject = createRunningDarkProject();
    const inactiveProject = createDarkProject({ status: 'idle' });
    const reopened = [
      createRejectedWorkItem(runningProject.id),
      createRejectedWorkItem(runningProject.id),
    ];
    const capped = createRejectedWorkItem(runningProject.id);
    const inactive = createRejectedWorkItem(inactiveProject.id);
    enableRejectRecovery({ maxReopens: 2 });

    await factoryTick.tickProject(runningProject);

    expect(reopened.map((item) => factoryIntake.getWorkItem(item.id).status)).toEqual([
      'pending',
      'pending',
    ]);
    expect(factoryIntake.getWorkItem(capped.id)).toMatchObject({
      id: capped.id,
      status: 'rejected',
      reject_reason: 'verify_failed_after_3_retries',
    });
    expect(factoryIntake.getWorkItem(inactive.id)).toMatchObject({
      id: inactive.id,
      status: 'rejected',
      reject_reason: 'verify_failed_after_3_retries',
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM factory_decisions
      WHERE action = ?
    `).get(RECOVERY_DECISION_ACTION).count).toBe(2);
  });
});
