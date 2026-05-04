'use strict';

const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const {
  createDispatcher,
  resetReplanRecoverySweepStateForTests,
} = require('../factory/replan-recovery');
const { createRegistry } = require('../factory/recovery-strategies/registry');

const noopLogger = { warn() {}, error() {}, info() {} };

function createDarkProject(testDir, status = 'running') {
  const suffix = Math.random().toString(16).slice(2);
  const project = factoryHealth.registerProject({
    name: `Replan Recovery ${suffix}`,
    path: `${testDir}/${suffix}`,
    trust_level: 'dark',
    config: { loop: { auto_continue: false } },
  });
  return factoryHealth.updateProject(project.id, { status });
}

function createRejectedItem(db, projectId, {
  rejectReason = 'cannot_generate_plan: too vague',
  status = 'rejected',
  recoveryAttempts = 0,
  lastRecoveryAt = null,
  updatedAtMsAgo = 2 * 60 * 60 * 1000,
} = {}) {
  const item = factoryIntake.createWorkItem({
    project_id: projectId,
    source: 'manual',
    title: `Replan target ${Math.random().toString(16).slice(2)}`,
    description: 'baseline',
    status,
  });
  db.prepare(`
    UPDATE factory_work_items
    SET reject_reason = ?, recovery_attempts = ?, last_recovery_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    rejectReason,
    recoveryAttempts,
    lastRecoveryAt,
    new Date(Date.now() - updatedAtMsAgo).toISOString(),
    item.id,
  );
  return factoryIntake.getWorkItem(item.id);
}

const stubStrategy = (overrides = {}) => ({
  name: overrides.name || 'stub',
  reasonPatterns: overrides.reasonPatterns || [/^cannot_generate_plan:/i],
  replan: overrides.replan || (async () => ({ outcome: 'rewrote', updates: { description: 'rewritten desc' } })),
});

const baseConfig = (over = {}) => ({
  enabled: true,
  sweepIntervalMs: 1000,
  hardCap: 3,
  maxPerProjectPerSweep: 1,
  maxGlobalPerSweep: 5,
  skipIfOpenCountGte: 3,
  cooldownMs: [3600000, 86400000, 259200000],
  strategyTimeoutMs: 5000,
  strategyTimeoutMsEscalate: 1000,
  historyMaxEntries: 10,
  splitMaxChildren: 5,
  splitMaxDepth: 2,
  ...over,
});

describe('replan-recovery dispatcher', () => {
  let db, testDir;
  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`replan-recovery-${Date.now()}`));
    db = rawDb();
    resetReplanRecoverySweepStateForTests();
  });
  afterEach(() => { teardownTestDb(); });

  it('skips when feature disabled', async () => {
    const project = createDarkProject(testDir);
    createRejectedItem(db, project.id);
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    const actions = await dispatcher.runSweep({ config: baseConfig({ enabled: false }) });
    expect(actions).toEqual([]);
  });

  it('reopens an eligible item via the strategy and increments attempts', async () => {
    const project = createDarkProject(testDir);
    const item = createRejectedItem(db, project.id);
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    const actions = await dispatcher.runSweep({ config: baseConfig() });
    expect(actions.find((a) => a.work_item_id === item.id)?.action).toBe('rewrote');
    const updated = factoryIntake.getWorkItem(item.id);
    expect(updated.status).toBe('pending');
    expect(updated.recovery_attempts).toBe(1);
    expect(updated.description).toBe('rewritten desc');
    expect(updated.reject_reason).toBeNull();
  });

  it('routes split outcomes: parent superseded, children created with recovery_split source', async () => {
    const project = createDarkProject(testDir);
    const item = createRejectedItem(db, project.id, { rejectReason: 'plan_quality_gate_rejected_after_2_attempts' });
    const registry = createRegistry();
    registry.register(stubStrategy({
      name: 'decompose-stub',
      reasonPatterns: [/^plan_quality_gate_rejected_after_2_attempts$/i],
      replan: async () => ({
        outcome: 'split',
        children: [
          { title: 'Child A', description: 'x'.repeat(150) },
          { title: 'Child B', description: 'x'.repeat(150) },
        ],
      }),
    }));
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    await dispatcher.runSweep({ config: baseConfig() });
    const parent = factoryIntake.getWorkItem(item.id);
    expect(parent.status).toBe('superseded');
    const children = db.prepare(`
      SELECT id, title, source, linked_item_id, depth, status FROM factory_work_items
      WHERE linked_item_id = ?
    `).all(item.id);
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.source === 'recovery_split')).toBe(true);
    expect(children.every((c) => c.status === 'pending')).toBe(true);
    expect(children.every((c) => c.depth === 1)).toBe(true);
  });

  it('routes unrecoverable outcomes to needs_review (inbox)', async () => {
    const project = createDarkProject(testDir);
    const item = createRejectedItem(db, project.id);
    const registry = createRegistry();
    registry.register(stubStrategy({
      replan: async () => ({ outcome: 'unrecoverable', reason: 'rewrite_response_invalid' }),
    }));
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    await dispatcher.runSweep({ config: baseConfig() });
    const updated = factoryIntake.getWorkItem(item.id);
    expect(updated.status).toBe('needs_review');
    expect(updated.recovery_attempts).toBe(1);
  });

  it('respects cooldown ladder: skips items whose last_recovery_at is too recent', async () => {
    const project = createDarkProject(testDir);
    const recentMs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    createRejectedItem(db, project.id, {
      recoveryAttempts: 1,
      lastRecoveryAt: recentMs,
    });
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    const actions = await dispatcher.runSweep({ config: baseConfig() });
    expect(actions.find((a) => a.action === 'rewrote')).toBeUndefined();
  });

  it('routes items at hard-cap to needs_review without invoking strategy', async () => {
    const project = createDarkProject(testDir);
    const item = createRejectedItem(db, project.id, { recoveryAttempts: 3 });
    const registry = createRegistry();
    let strategyInvoked = false;
    registry.register(stubStrategy({
      replan: async () => { strategyInvoked = true; return { outcome: 'rewrote', updates: {} }; },
    }));
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    await dispatcher.runSweep({ config: baseConfig() });
    const updated = factoryIntake.getWorkItem(item.id);
    expect(updated.status).toBe('needs_review');
    expect(strategyInvoked).toBe(false);
  });

  it('respects per-project per-sweep throttle (1 by default)', async () => {
    const project = createDarkProject(testDir);
    createRejectedItem(db, project.id, { rejectReason: 'cannot_generate_plan: a' });
    createRejectedItem(db, project.id, { rejectReason: 'cannot_generate_plan: b' });
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    const actions = await dispatcher.runSweep({ config: baseConfig({ maxPerProjectPerSweep: 1 }) });
    const reopened = actions.filter((a) => a.action === 'rewrote');
    expect(reopened).toHaveLength(1);
  });

  it('respects global per-sweep cap', async () => {
    const projA = createDarkProject(testDir);
    const projB = createDarkProject(testDir);
    createRejectedItem(db, projA.id);
    createRejectedItem(db, projB.id);
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    const actions = await dispatcher.runSweep({ config: baseConfig({ maxGlobalPerSweep: 1 }) });
    const reopened = actions.filter((a) => a.action === 'rewrote');
    expect(reopened).toHaveLength(1);
  });

  it('skips projects with too many open items (backpressure)', async () => {
    const project = createDarkProject(testDir);
    createRejectedItem(db, project.id);
    factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'open A', description: 'x' });
    factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'open B', description: 'x' });
    factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'open C', description: 'x' });
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    const actions = await dispatcher.runSweep({ config: baseConfig({ skipIfOpenCountGte: 3 }) });
    expect(actions.find((a) => a.action === 'rewrote')).toBeUndefined();
    expect(actions.find((a) => a.action === 'skipped_project_backpressure')).toBeDefined();
  });

  it('on strategy failure: increments attempts but does not change status', async () => {
    const project = createDarkProject(testDir);
    const item = createRejectedItem(db, project.id);
    const registry = createRegistry();
    registry.register(stubStrategy({ replan: async () => { throw new Error('boom'); } }));
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    await dispatcher.runSweep({ config: baseConfig() });
    const updated = factoryIntake.getWorkItem(item.id);
    expect(updated.status).toBe('rejected');
    expect(updated.recovery_attempts).toBe(1);
    expect(updated.last_recovery_at).not.toBeNull();
  });

  it('appends to recovery_history_json (capped at historyMaxEntries)', async () => {
    const project = createDarkProject(testDir);
    const item = createRejectedItem(db, project.id);
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    await dispatcher.runSweep({ config: baseConfig() });
    const updated = factoryIntake.getWorkItem(item.id);
    const history = JSON.parse(updated.recovery_history_json || '[]');
    expect(history).toHaveLength(1);
    expect(history[0].strategy).toBe('stub');
    expect(history[0].outcome).toBe('rewrote');
  });

  it('logs a factory_decisions entry per dispatch', async () => {
    const project = createDarkProject(testDir);
    createRejectedItem(db, project.id);
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    await dispatcher.runSweep({ config: baseConfig() });
    const decisions = db.prepare(`
      SELECT action FROM factory_decisions WHERE action LIKE 'replan_recovery%'
    `).all();
    expect(decisions.find((d) => d.action === 'replan_recovery_attempted')).toBeDefined();
  });
});
