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

function createTerminalWorkItem(projectId, {
  status = 'rejected',
  rejectReason = 'verify_failed_after_3_retries',
  updatedAt = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString(),
} = {}) {
  const item = factoryIntake.createWorkItem({
    project_id: projectId,
    source: 'manual',
    title: `Rejected item ${Math.random().toString(16).slice(2)}`,
    description: 'Exercise rejected recovery gating.',
    status,
  });

  db.prepare(`
    UPDATE factory_work_items
    SET reject_reason = ?,
        updated_at = ?
    WHERE id = ?
  `).run(rejectReason, updatedAt, item.id);

  return factoryIntake.getWorkItem(item.id);
}

function createRejectedWorkItem(projectId, options = {}) {
  return createTerminalWorkItem(projectId, { status: 'rejected', ...options });
}

function createUnactionableWorkItem(projectId, options = {}) {
  return createTerminalWorkItem(projectId, {
    status: 'unactionable',
    rejectReason: 'zero_diff_across_retries',
    ...options,
  });
}

function createOpenWorkItem(projectId) {
  return factoryIntake.createWorkItem({
    project_id: projectId,
    source: 'manual',
    title: `Open item ${Math.random().toString(16).slice(2)}`,
    description: 'Exercise reject-recovery backpressure.',
    status: 'pending',
  });
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

function disableRejectRecovery() {
  configCore.setConfig('reject_recovery_enabled', '0');
}

function recordPriorReopen(workItemId) {
  const item = factoryIntake.getWorkItem(workItemId);
  db.prepare(`
    INSERT INTO factory_decisions (
      project_id, stage, actor, action, reasoning, inputs_json, outcome_json, confidence, batch_id, created_at
    )
    VALUES (?, 'learn', 'verifier', ?, 'prior reopen', '{}', '{}', 1, ?, datetime('now'))
  `).run(
    item.project_id,
    RECOVERY_DECISION_ACTION,
    `reject-recovery:${workItemId}`,
  );
}

function countRecoveryDecisions() {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM factory_decisions
    WHERE action = ?
  `).get(RECOVERY_DECISION_ACTION).count;
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
    disableRejectRecovery();

    await factoryTick.tickProject(project);

    expect(factoryIntake.getWorkItem(item.id)).toMatchObject({
      id: item.id,
      status: 'rejected',
      reject_reason: 'verify_failed_after_3_retries',
    });
    expect(countRecoveryDecisions()).toBe(0);
  });

  it('factory tick reopens eligible terminal items only when reject recovery is enabled', async () => {
    const rejectedProject = createRunningDarkProject();
    const unactionableProject = createRunningDarkProject();
    const rejected = createRejectedWorkItem(rejectedProject.id);
    const unactionable = createUnactionableWorkItem(unactionableProject.id);
    enableRejectRecovery();

    await factoryTick.tickProject(rejectedProject);

    expect(factoryIntake.getWorkItem(rejected.id)).toMatchObject({
      id: rejected.id,
      status: 'pending',
      reject_reason: null,
      claimed_by_instance_id: null,
      batch_id: null,
    });
    expect(factoryIntake.getWorkItem(unactionable.id)).toMatchObject({
      id: unactionable.id,
      status: 'pending',
      reject_reason: null,
      claimed_by_instance_id: null,
      batch_id: null,
    });
    const decisions = db.prepare(`
      SELECT action, batch_id, outcome_json
      FROM factory_decisions
      WHERE action = ?
      ORDER BY batch_id
    `).all(RECOVERY_DECISION_ACTION);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      action: RECOVERY_DECISION_ACTION,
      batch_id: `reject-recovery:${rejected.id}`,
    });
    expect(JSON.parse(decisions[0].outcome_json)).toMatchObject({
      work_item_id: rejected.id,
      status: 'pending',
      reopens: 1,
    });
    expect(decisions[1]).toMatchObject({
      action: RECOVERY_DECISION_ACTION,
      batch_id: `reject-recovery:${unactionable.id}`,
    });
    expect(JSON.parse(decisions[1].outcome_json)).toMatchObject({
      work_item_id: unactionable.id,
      status: 'pending',
      reopens: 1,
    });
  });

  it('reopens at most one terminal item per project per sweep', async () => {
    const project = createRunningDarkProject();
    const first = createRejectedWorkItem(project.id, {
      updatedAt: '2026-04-18T12:00:00.000Z',
    });
    const second = createUnactionableWorkItem(project.id, {
      updatedAt: '2026-04-18T12:30:00.000Z',
    });
    enableRejectRecovery({ sweepIntervalMs: 5 * 60 * 1000, maxReopens: 2 });

    await factoryTick.tickProject(project);

    expect(factoryIntake.getWorkItem(first.id)).toMatchObject({
      id: first.id,
      status: 'pending',
      reject_reason: null,
    });
    expect(factoryIntake.getWorkItem(second.id)).toMatchObject({
      id: second.id,
      status: 'unactionable',
      reject_reason: 'zero_diff_across_retries',
    });
    expect(countRecoveryDecisions()).toBe(1);

    vi.setSystemTime(new Date('2026-04-18T18:05:01.000Z'));
    db.prepare(`UPDATE factory_work_items SET status = 'shipped', updated_at = datetime('now') WHERE id = ?`).run(first.id);

    await factoryTick.tickProject(project);

    expect(factoryIntake.getWorkItem(second.id)).toMatchObject({
      id: second.id,
      status: 'pending',
      reject_reason: null,
    });
    expect(countRecoveryDecisions()).toBe(2);
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
    expect(countRecoveryDecisions()).toBe(1);

    vi.setSystemTime(new Date('2026-04-18T18:05:01.000Z'));
    db.prepare(`UPDATE factory_work_items SET status = 'shipped', updated_at = datetime('now') WHERE id = ?`).run(first.id);
    await factoryTick.tickProject(project);

    expect(factoryIntake.getWorkItem(second.id).status).toBe('pending');
    expect(countRecoveryDecisions()).toBe(2);
  });

  it('factory tick skips inactive projects and enforces reopen caps per item', async () => {
    const runningProject = createRunningDarkProject();
    const inactiveProject = createDarkProject({ status: 'idle' });
    const reopened = createRejectedWorkItem(runningProject.id);
    const capped = createRejectedWorkItem(runningProject.id);
    const inactive = createRejectedWorkItem(inactiveProject.id);
    recordPriorReopen(capped.id);
    enableRejectRecovery({ maxReopens: 1 });

    await factoryTick.tickProject(runningProject);

    expect(factoryIntake.getWorkItem(reopened.id).status).toBe('pending');
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
    expect(countRecoveryDecisions()).toBe(2);
  });

  it('skips reopening terminal items when the project already has open work', async () => {
    const project = createRunningDarkProject();
    const terminal = createRejectedWorkItem(project.id);
    createOpenWorkItem(project.id);
    enableRejectRecovery();

    await factoryTick.tickProject(project);

    expect(factoryIntake.getWorkItem(terminal.id)).toMatchObject({
      id: terminal.id,
      status: 'rejected',
      reject_reason: 'verify_failed_after_3_retries',
    });
    expect(countRecoveryDecisions()).toBe(0);
  });

  it('factory tick scans later terminal-item pages before giving up on recovery', async () => {
    const project = createRunningDarkProject();
    const olderCappedItems = Array.from({ length: 100 }, () => createRejectedWorkItem(project.id, {
      updatedAt: '2026-04-18T12:00:00.000Z',
    }));
    for (const item of olderCappedItems) {
      recordPriorReopen(item.id);
    }

    const starved = createUnactionableWorkItem(project.id, {
      updatedAt: '2026-04-18T12:30:00.000Z',
    });
    const beforeDecisions = countRecoveryDecisions();
    enableRejectRecovery({ maxReopens: 1 });

    await factoryTick.tickProject(project);

    expect(factoryIntake.getWorkItem(starved.id)).toMatchObject({
      id: starved.id,
      status: 'pending',
      reject_reason: null,
    });
    expect(countRecoveryDecisions()).toBe(beforeDecisions + 1);
  });
});
