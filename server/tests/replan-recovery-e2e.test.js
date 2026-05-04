'use strict';

const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const {
  runReplanRecoverySweep,
  resetReplanRecoverySweepStateForTests,
} = require('../factory/replan-recovery');
const { defaultRegistry } = require('../factory/recovery-strategies/registry');
const { bootstrapReplanRecovery } = require('../factory/replan-recovery-bootstrap');

const noopLogger = { warn() {}, error() {}, info() {} };

describe('replan-recovery end-to-end', () => {
  let db, testDir;
  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`replan-e2e-${Date.now()}`));
    db = rawDb();
    defaultRegistry.clear();
    bootstrapReplanRecovery();
    resetReplanRecoverySweepStateForTests();
  });
  afterEach(() => { teardownTestDb(); });

  it('decompose: rejected item with plan_quality_gate_rejected_after_2_attempts -> parent superseded, 2 children pending', async () => {
    const suffix = Math.random().toString(16).slice(2);
    const project = factoryHealth.registerProject({
      name: `E2E ${suffix}`,
      path: `${testDir}/${suffix}`,
      trust_level: 'dark',
      config: { loop: { auto_continue: false } },
    });
    factoryHealth.updateProject(project.id, { status: 'running' });

    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'Do an ambiguous thing across many files',
      description: 'This was too vague when first attempted; the plan-quality gate rejected it twice.',
    });
    db.prepare(`
      UPDATE factory_work_items
      SET reject_reason = 'plan_quality_gate_rejected_after_2_attempts',
          status = 'rejected',
          updated_at = ?
      WHERE id = ?
    `).run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), item.id);

    const architectRunner = require('../factory/architect-runner');
    const originalDecompose = architectRunner.decomposeWorkItem;
    architectRunner.decomposeWorkItem = async () => ({
      children: [
        { title: 'Child 1: do part A', description: 'Specific child task 1 covering one aspect of the parent. '.repeat(5), acceptance_criteria: ['must X'] },
        { title: 'Child 2: do part B', description: 'Specific child task 2 covering another aspect of the parent. '.repeat(5), acceptance_criteria: ['must Y'] },
      ],
    });

    try {
      const actions = await runReplanRecoverySweep({
        db,
        logger: noopLogger,
        config: {
          enabled: true,
          sweepIntervalMs: 1,
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
        },
        instanceId: 'e2e-instance',
      });

      const splitAction = actions.find((a) => a.action === 'split');
      expect(splitAction).toBeDefined();

      const parent = factoryIntake.getWorkItem(item.id);
      expect(parent.status).toBe('superseded');
      expect(parent.reject_reason).toBe('split_into_recovery_children');

      const children = db.prepare(`
        SELECT id, title, status, source, depth, linked_item_id FROM factory_work_items
        WHERE linked_item_id = ?
        ORDER BY id ASC
      `).all(item.id);
      expect(children.length).toBe(2);
      expect(children.every((c) => c.status === 'pending')).toBe(true);
      expect(children.every((c) => c.source === 'recovery_split')).toBe(true);
      expect(children.every((c) => c.depth === 1)).toBe(true);

      const splitDecision = db.prepare(`
        SELECT * FROM factory_decisions WHERE action = 'replan_recovery_split' ORDER BY id DESC LIMIT 1
      `).get();
      expect(splitDecision).toBeDefined();

      const history = JSON.parse(parent.recovery_history_json || '[]');
      expect(history.length).toBe(1);
      expect(history[0].strategy).toBe('decompose');
      expect(history[0].outcome).toBe('split');
    } finally {
      architectRunner.decomposeWorkItem = originalDecompose;
    }
  });
});
