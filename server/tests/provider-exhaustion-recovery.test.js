'use strict';

const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const {
  RECOVERY_ACTION,
  getNoProviderChainEvidence,
  hasRecoveredProviderCapacity,
  recoverNoProviderChainExhaustedWorkItemsForProject,
} = require('../factory/provider-exhaustion-recovery');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

let db;
let testDir;

function createProject() {
  const suffix = Math.random().toString(16).slice(2);
  const project = factoryHealth.registerProject({
    name: `Provider exhausted recovery ${suffix}`,
    path: `${testDir}/${suffix}`,
    trust_level: 'dark',
    config: { loop: { auto_continue: false } },
  });
  return factoryHealth.updateProject(project.id, { status: 'running' });
}

function createExhaustedItem(projectId, overrides = {}) {
  const item = factoryIntake.createWorkItem({
    project_id: projectId,
    source: 'scout',
    title: `Provider exhausted item ${Math.random().toString(16).slice(2)}`,
    description: 'Exercise provider-exhaustion recovery.',
    priority: overrides.priority ?? 50,
    status: 'escalation_exhausted',
    origin: {
      last_rejection_reason: 'cannot_generate_plan: provider unavailable',
      last_escalation: {
        kind: overrides.kind || 'no_provider_chain',
        reason_shape: overrides.reasonShape || 'cannot_generate_plan',
      },
      escalation_history: [
        { reason: 'cannot_generate_plan: provider unavailable', missing_signals: [] },
      ],
      plan_generation_task_id: 'stale-task',
      plan_generation_started_at: '2026-05-18T00:00:00.000Z',
    },
  });
  db.prepare(`
    UPDATE factory_work_items
    SET reject_reason = ?,
        recovery_history_json = ?
    WHERE id = ?
  `).run(
    overrides.rejectReason || 'escalation_exhausted: no_provider_chain after 3x same-shape (cannot_generate_plan)',
    JSON.stringify(overrides.recoveryHistory || []),
    item.id,
  );
  return factoryIntake.getWorkItem(item.id);
}

function createPendingItem(projectId) {
  return factoryIntake.createWorkItem({
    project_id: projectId,
    source: 'manual',
    title: `Open item ${Math.random().toString(16).slice(2)}`,
    description: 'Existing open work.',
    status: 'pending',
  });
}

function countRecoveryDecisions() {
  return db.prepare('SELECT COUNT(*) AS count FROM factory_decisions WHERE action = ?')
    .get(RECOVERY_ACTION).count;
}

beforeEach(() => {
  ({ testDir } = setupTestDbOnly(`provider-exhaustion-recovery-${Date.now()}`));
  db = rawDb();
});

afterEach(() => {
  teardownTestDb();
  db = null;
  testDir = null;
});

describe('provider-exhaustion recovery', () => {
  it('identifies only no-provider-chain terminal escalations', () => {
    const project = createProject();
    const noProvider = createExhaustedItem(project.id);
    const chain = createExhaustedItem(project.id, {
      kind: 'chain_exhausted',
      rejectReason: 'escalation_exhausted: chain_exhausted after 3x same-shape (cannot_generate_plan)',
    });

    expect(getNoProviderChainEvidence(noProvider)).toMatchObject({
      source: 'reject_reason',
      reason_shape: 'cannot_generate_plan',
    });
    expect(getNoProviderChainEvidence(chain)).toBeNull();
  });

  it('reopens no-provider-chain exhausted items when intake is empty and provider capacity recovered', () => {
    const project = createProject();
    const first = createExhaustedItem(project.id, { priority: 80 });
    const second = createExhaustedItem(project.id, { priority: 70 });

    const result = recoverNoProviderChainExhaustedWorkItemsForProject({
      db,
      project,
      maxReopens: 2,
      hasRecoveredCapacity: () => true,
    });

    expect(result).toMatchObject({
      scanned: 2,
      reopened: 2,
      reopened_work_item_ids: [first.id, second.id],
    });
    for (const itemId of [first.id, second.id]) {
      const item = factoryIntake.getWorkItem(itemId);
      expect(item.status).toBe('pending');
      expect(item.reject_reason).toBeNull();
      expect(item.claimed_by_instance_id).toBeNull();
      expect(item.recovery_attempts).toBe(1);
      expect(item.origin.last_escalation).toBeUndefined();
      expect(item.origin.escalation_history).toBeUndefined();
      expect(item.origin.plan_generation_task_id).toBeUndefined();
      expect(item.origin.provider_exhaustion_recovery).toMatchObject({
        previous_status: 'escalation_exhausted',
        previous_reject_reason: expect.stringContaining('no_provider_chain'),
      });
    }
    expect(factoryIntake.listOpenWorkItems({ project_id: project.id }).map((item) => item.id))
      .toEqual([first.id, second.id]);
    expect(countRecoveryDecisions()).toBe(2);
  });

  it('uses the supplied db when checking recovered provider capacity', () => {
    const project = createProject();
    const item = createExhaustedItem(project.id);

    db.prepare(`
      UPDATE provider_config
      SET enabled = CASE WHEN provider = 'claude-cli' THEN 1 ELSE 0 END
    `).run();
    db.prepare(`
      INSERT OR REPLACE INTO config (key, value)
      VALUES ('codex_exhausted', '1')
    `).run();

    expect(hasRecoveredProviderCapacity({ db })).toBe(true);

    const result = recoverNoProviderChainExhaustedWorkItemsForProject({
      db,
      project,
      maxReopens: 1,
    });

    expect(result).toMatchObject({
      scanned: 1,
      reopened: 1,
      reopened_work_item_ids: [item.id],
    });
    expect(factoryIntake.getWorkItem(item.id).status).toBe('pending');
    expect(countRecoveryDecisions()).toBe(1);
  });

  it('does not reopen terminal items while normal open work exists', () => {
    const project = createProject();
    const exhausted = createExhaustedItem(project.id);
    createPendingItem(project.id);

    const result = recoverNoProviderChainExhaustedWorkItemsForProject({
      db,
      project,
      hasRecoveredCapacity: () => true,
    });

    expect(result).toMatchObject({ reopened: 0, skipped_reason: 'open_work_exists' });
    expect(factoryIntake.getWorkItem(exhausted.id).status).toBe('escalation_exhausted');
    expect(countRecoveryDecisions()).toBe(0);
  });

  it('does not reopen when provider capacity is still unavailable or the item was already recovered once', () => {
    const project = createProject();
    const unavailable = createExhaustedItem(project.id);

    expect(recoverNoProviderChainExhaustedWorkItemsForProject({
      db,
      project,
      hasRecoveredCapacity: () => false,
    })).toMatchObject({ reopened: 0, skipped_reason: 'provider_capacity_unavailable' });
    expect(factoryIntake.getWorkItem(unavailable.id).status).toBe('escalation_exhausted');

    db.prepare('DELETE FROM factory_work_items WHERE id = ?').run(unavailable.id);
    const previouslyRecovered = createExhaustedItem(project.id, {
      recoveryHistory: [{ strategy: 'provider_exhaustion_reopen', outcome: 'reopened' }],
    });
    const result = recoverNoProviderChainExhaustedWorkItemsForProject({
      db,
      project,
      hasRecoveredCapacity: () => true,
    });

    expect(result).toMatchObject({ scanned: 1, reopened: 0 });
    expect(factoryIntake.getWorkItem(previouslyRecovered.id).status).toBe('escalation_exhausted');
    expect(countRecoveryDecisions()).toBe(0);
  });
});
