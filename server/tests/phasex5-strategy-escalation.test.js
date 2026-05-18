'use strict';

const Database = require('better-sqlite3');
const factoryIntake = require('../db/factory/intake');
const factoryHealth = require('../db/factory/health');
const { defaultContainer } = require('../container');
const {
  routeWorkItemToNeedsReplan,
  detectSameShapeEscalation,
  normalizeRejectionReasonForShape,
  SAME_SHAPE_THRESHOLD,
} = require('../factory/loop-controller');

function createMinimalSchema(database) {
  const sql = [
    "CREATE TABLE IF NOT EXISTS factory_projects (",
    "  id TEXT PRIMARY KEY,",
    "  name TEXT NOT NULL,",
    "  path TEXT NOT NULL UNIQUE,",
    "  status TEXT NOT NULL DEFAULT 'paused',",
    "  config_json TEXT,",
    "  provider_chain_json TEXT,",
    "  created_at TEXT NOT NULL DEFAULT (datetime('now')),",
    "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
    ");",
    "CREATE TABLE IF NOT EXISTS factory_work_items (",
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "  project_id TEXT NOT NULL REFERENCES factory_projects(id),",
    "  source TEXT NOT NULL,",
    "  origin_json TEXT,",
    "  title TEXT NOT NULL,",
    "  description TEXT,",
    "  priority INTEGER NOT NULL DEFAULT 50,",
    "  requestor TEXT,",
    "  constraints_json TEXT,",
    "  status TEXT NOT NULL DEFAULT 'pending',",
    "  reject_reason TEXT,",
    "  linked_item_id INTEGER,",
    "  depth INTEGER DEFAULT 0,",
    "  batch_id TEXT,",
    "  claimed_by_instance_id TEXT,",
    "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),",
    "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    ");",
    "CREATE TABLE IF NOT EXISTS provider_config (",
    "  provider TEXT PRIMARY KEY,",
    "  enabled INTEGER NOT NULL DEFAULT 1,",
    "  priority INTEGER NOT NULL DEFAULT 100,",
    "  quality_band TEXT DEFAULT 'C'",
    ");",
  ].join('\n');
  database.exec(sql);
}

function makeProject(database, providerChain) {
  const insertSql = "INSERT INTO factory_projects (id, name, path, status, provider_chain_json, created_at, updated_at) "
    + "VALUES ('p1', 'Proj', '/tmp/x5', 'running', ?, datetime('now'), datetime('now'))";
  database.prepare(insertSql).run(JSON.stringify(providerChain || []));
}

function makeProjectWithConfig(database, config) {
  const insertSql = "INSERT INTO factory_projects (id, name, path, status, config_json, created_at, updated_at) "
    + "VALUES ('p1', 'Proj', '/tmp/x5', 'running', ?, datetime('now'), datetime('now'))";
  database.prepare(insertSql).run(JSON.stringify(config || {}));
}

function seedProviderConfig(database, providers) {
  const stmt = database.prepare(
    'INSERT INTO provider_config (provider, enabled, priority, quality_band) VALUES (?, ?, ?, ?)'
  );
  for (const provider of providers) {
    stmt.run(
      provider.provider,
      provider.enabled === undefined ? 1 : provider.enabled,
      provider.priority === undefined ? 100 : provider.priority,
      provider.quality_band || 'C'
    );
  }
}

describe('Phase X5: same-shape escalation in routeWorkItemToNeedsReplan', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    createMinimalSchema(db);
    defaultContainer.resetForTest();
    defaultContainer.override('db', db);
    factoryIntake.setDb(db);
    factoryHealth.setDb(db);
  });

  afterEach(() => {
    factoryIntake.setDb(null);
    factoryHealth.setDb(null);
    defaultContainer.override('db', null);
    defaultContainer.resetForTest();
    db.close();
  });

  describe('normalizeRejectionReasonForShape', () => {
    it('drops colon-suffix details so similar rejections normalize together', () => {
      expect(normalizeRejectionReasonForShape('cannot_generate_plan: Task Timed Out **Task ID:** 4ff...')).toBe('cannot_generate_plan');
      expect(normalizeRejectionReasonForShape('cannot_generate_plan: parse error at line 42')).toBe('cannot_generate_plan');
    });

    it('lowercases for comparison stability', () => {
      expect(normalizeRejectionReasonForShape('Empty_Branch_After_Execute')).toBe('empty_branch_after_execute');
    });

    it('handles missing/non-string input', () => {
      expect(normalizeRejectionReasonForShape(null)).toBe('unknown');
      expect(normalizeRejectionReasonForShape(undefined)).toBe('unknown');
      expect(normalizeRejectionReasonForShape(42)).toBe('unknown');
    });
  });

  describe('detectSameShapeEscalation', () => {
    it('returns false when history is shorter than threshold-1', () => {
      const history = [
        { reason: 'cannot_generate_plan: x', missing_signals: [] },
      ];
      expect(detectSameShapeEscalation(history, { reason: 'cannot_generate_plan: y', missing_signals: [] })).toBe(false);
    });

    it('returns true when last (threshold-1) entries match the current shape', () => {
      const history = [
        { reason: 'plan_quality_gate: vague task 2', missing_signals: ['estimated_scope'] },
        { reason: 'plan_quality_gate: vague task 3', missing_signals: ['estimated_scope'] },
      ];
      const current = { reason: 'plan_quality_gate: vague task 1', missing_signals: ['estimated_scope'] };
      expect(detectSameShapeEscalation(history, current)).toBe(true);
    });

    it('returns false when the missing-signals set differs', () => {
      const history = [
        { reason: 'plan_quality_gate: x', missing_signals: ['estimated_scope'] },
        { reason: 'plan_quality_gate: y', missing_signals: ['estimated_scope'] },
      ];
      const current = { reason: 'plan_quality_gate: z', missing_signals: ['validation_steps'] };
      expect(detectSameShapeEscalation(history, current)).toBe(false);
    });

    it('returns false when reason category differs', () => {
      const history = [
        { reason: 'plan_quality_gate: x', missing_signals: [] },
        { reason: 'cannot_generate_plan: y', missing_signals: [] },
      ];
      const current = { reason: 'plan_quality_gate: z', missing_signals: [] };
      expect(detectSameShapeEscalation(history, current)).toBe(false);
    });

    it('returns true when same-shape rejections are interleaved with transient failures', () => {
      const history = [
        { reason: 'plan_quality_gate_rejected_after_intrabatch_retries', missing_signals: [] },
        { reason: 'task_1_failed', missing_signals: [] },
        { reason: 'generated_plan_missing_after_worktree_prepare', missing_signals: [] },
        { reason: 'plan_quality_gate_rejected_after_intrabatch_retries', missing_signals: [] },
      ];
      const current = { reason: 'plan_quality_gate_rejected_after_intrabatch_retries', missing_signals: [] };
      expect(detectSameShapeEscalation(history, current)).toBe(true);
    });
  });

  describe('escalation flow end-to-end', () => {
    function rejectN(workItem, n, reason) {
      const baseReason = reason || 'cannot_generate_plan: timeout';
      let current = workItem;
      for (let i = 0; i < n; i++) {
        current = routeWorkItemToNeedsReplan(current, { reason: `${baseReason} attempt ${i + 1}` });
        current = factoryIntake.getWorkItem(current.id);
      }
      return current;
    }

    it('first 2 same-shape rejections route to needs_replan with no escalation', () => {
      makeProject(db, ['ollama', 'codex', 'claude-cli']);
      const item = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'X' });
      const after = rejectN(item, 2);
      expect(after.status).toBe('needs_replan');
      expect(after.origin?.last_escalation).toBeUndefined();
    });

    it(`${SAME_SHAPE_THRESHOLD}rd same-shape rejection triggers provider_switch escalation`, () => {
      makeProject(db, ['ollama', 'codex', 'claude-cli']);
      const item = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'X' });
      const after = rejectN(item, SAME_SHAPE_THRESHOLD);
      expect(after.status).toBe('needs_replan');
      expect(after.origin?.last_escalation).toMatchObject({
        kind: 'provider_switch',
        from: null,
        to: 'codex',
      });
      const constraints = JSON.parse(after.constraints_json || '{}');
      expect(constraints.architect_provider_override).toBe('codex');
    });

    it('escalation chain advances on each subsequent threshold cross', () => {
      makeProject(db, ['ollama', 'codex', 'claude-cli']);
      const item = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'X' });
      let after = rejectN(item, SAME_SHAPE_THRESHOLD);
      expect(after.origin?.last_escalation?.to).toBe('codex');
      after = rejectN(after, SAME_SHAPE_THRESHOLD);
      expect(after.origin?.last_escalation).toMatchObject({
        kind: 'provider_switch',
        from: 'codex',
        to: 'claude-cli',
      });
    });

    it('after chain exhausted, status becomes terminal escalation_exhausted', () => {
      makeProject(db, ['ollama', 'codex']);
      const item = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'X' });
      let after = rejectN(item, SAME_SHAPE_THRESHOLD);
      expect(after.status).toBe('needs_replan');
      expect(after.origin?.last_escalation?.to).toBe('codex');
      after = rejectN(after, SAME_SHAPE_THRESHOLD);
      expect(after.status).toBe('escalation_exhausted');
      expect(after.origin?.last_escalation).toMatchObject({
        kind: 'chain_exhausted',
        from: 'codex',
      });
      expect(after.reject_reason).toMatch(/escalation_exhausted: chain_exhausted/);
    });

    it('does not resurrect an item whose origin still records terminal escalation', () => {
      makeProject(db, ['ollama', 'codex']);
      const item = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'X' });
      let after = rejectN(item, SAME_SHAPE_THRESHOLD);
      after = rejectN(after, SAME_SHAPE_THRESHOLD);
      expect(after.status).toBe('escalation_exhausted');

      const resurrected = factoryIntake.updateWorkItem(after.id, {
        status: 'needs_replan',
        reject_reason: 'empty_branch_after_execute',
      });

      const rerouted = routeWorkItemToNeedsReplan(resurrected, {
        reason: 'empty_branch_after_execute',
      });

      expect(rerouted.status).toBe('escalation_exhausted');
      expect(rerouted.reject_reason).toMatch(/escalation_exhausted: chain_exhausted/);
      expect(rerouted.origin?.last_escalation).toMatchObject({
        kind: 'chain_exhausted',
        reason_shape: 'cannot_generate_plan',
      });
    });

    it('with no provider chain configured, first triggered escalation goes terminal', () => {
      makeProject(db, []);
      const item = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'X' });
      const after = rejectN(item, SAME_SHAPE_THRESHOLD);
      expect(after.status).toBe('escalation_exhausted');
      expect(after.origin?.last_escalation).toMatchObject({ kind: 'no_provider_chain' });
    });

    it('uses enabled provider_config rows when no project chain or lane policy is configured', () => {
      makeProjectWithConfig(db, {});
      seedProviderConfig(db, [
        { provider: 'ollama', priority: 3, quality_band: 'C' },
        { provider: 'codex', priority: 1, quality_band: 'A' },
        { provider: 'claude-cli', priority: 2, quality_band: 'A' },
        { provider: 'groq', priority: 1, quality_band: 'D' },
      ]);
      const item = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'X' });
      const after = routeWorkItemToNeedsReplan(item, {
        reason: 'plan_quality_gate_rejected_after_intrabatch_retries',
        attempt: SAME_SHAPE_THRESHOLD,
      });

      expect(after.status).toBe('needs_replan');
      expect(after.origin?.last_escalation).toMatchObject({
        kind: 'provider_switch',
        from: null,
        to: 'claude-cli',
        basis: 'plan_quality_attempt_window',
      });
      const constraints = JSON.parse(after.constraints_json || '{}');
      expect(constraints.architect_provider_override).toBe('claude-cli');
    });

    it('starts provider_config escalation from the provider that generated the rejected plan', () => {
      makeProjectWithConfig(db, {});
      seedProviderConfig(db, [
        { provider: 'codex', priority: 1, quality_band: 'A' },
        { provider: 'claude-cli', priority: 2, quality_band: 'A' },
        { provider: 'codex-spark', priority: 3, quality_band: 'A' },
      ]);
      const item = factoryIntake.createWorkItem({
        project_id: 'p1',
        source: 'scout',
        title: 'X',
        origin: { plan_generator_provider: 'claude-cli' },
      });
      const after = routeWorkItemToNeedsReplan(item, {
        reason: 'plan_quality_gate_rejected_after_intrabatch_retries',
        attempt: SAME_SHAPE_THRESHOLD,
      });

      expect(after.status).toBe('needs_replan');
      expect(after.origin?.last_escalation).toMatchObject({
        kind: 'provider_switch',
        from: 'claude-cli',
        to: 'codex',
        basis: 'plan_quality_attempt_window',
      });
      const constraints = JSON.parse(after.constraints_json || '{}');
      expect(constraints.architect_provider_override).toBe('codex');
    });

    it('escalates exhausted plan-quality attempt windows even before history has enough batch entries', () => {
      makeProject(db, []);
      const item = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'X' });
      const after = routeWorkItemToNeedsReplan(item, {
        reason: 'plan_quality_gate_rejected_after_intrabatch_retries',
        attempt: SAME_SHAPE_THRESHOLD,
      });

      expect(after.status).toBe('escalation_exhausted');
      expect(after.origin?.last_escalation).toMatchObject({
        kind: 'no_provider_chain',
        reason_shape: 'plan_quality_gate_rejected_after_intrabatch_retries',
        basis: 'plan_quality_attempt_window',
      });
    });

    it('uses exhausted plan-quality attempt windows for one provider switch without burning the chain', () => {
      makeProject(db, ['ollama', 'codex', 'claude-cli']);
      const item = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'X' });
      const switched = routeWorkItemToNeedsReplan(item, {
        reason: 'plan_quality_gate_rejected_after_intrabatch_retries',
        attempt: SAME_SHAPE_THRESHOLD,
      });

      expect(switched.status).toBe('needs_replan');
      expect(switched.origin?.last_escalation).toMatchObject({
        kind: 'provider_switch',
        from: null,
        to: 'codex',
        basis: 'plan_quality_attempt_window',
      });

      const afterProviderAttempt = routeWorkItemToNeedsReplan(factoryIntake.getWorkItem(switched.id), {
        reason: 'plan_quality_gate_rejected_after_intrabatch_retries',
        attempt: SAME_SHAPE_THRESHOLD + 1,
      });

      expect(afterProviderAttempt.status).toBe('needs_replan');
      expect(afterProviderAttempt.origin?.last_escalation).toMatchObject({
        kind: 'provider_switch',
        to: 'codex',
      });
      expect(afterProviderAttempt.origin?.last_escalation?.to).not.toBe('claude-cli');
    });

    it('does not terminally escalate stale plan pointer cleanup cycles', () => {
      makeProject(db, []);
      const item = factoryIntake.createWorkItem({
        project_id: 'p1',
        source: 'plan_file',
        title: 'X',
        origin: { plan_path: '/tmp/source-plan.md' },
      });

      let current = item;
      for (let i = 0; i < SAME_SHAPE_THRESHOLD + 1; i += 1) {
        current = routeWorkItemToNeedsReplan(current, {
          reason: 'stale_source_plan_before_replan',
          details: { plan_path: '/tmp/source-plan.md' },
        });
        current = factoryIntake.getWorkItem(current.id);
      }

      expect(current.status).toBe('needs_replan');
      expect(current.reject_reason).toBe('stale_source_plan_before_replan');
      expect(current.origin?.last_escalation).toBeUndefined();
      expect(current.origin?.escalation_history || []).toEqual([]);
    });

    it('uses modern provider_lane_policy config as the architect escalation chain', () => {
      makeProjectWithConfig(db, {
        provider_lane_policy: {
          expected_provider: 'ollama',
          allowed_providers: ['ollama'],
          allowed_fallback_providers: [],
          enforce_handoffs: true,
          by_kind: {
            architect_cycle: 'codex',
            plan_generation: 'codex',
            verify_review: 'codex',
          },
        },
      });
      const item = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'X' });
      let after = item;
      for (let i = 0; i < SAME_SHAPE_THRESHOLD; i++) {
        after = routeWorkItemToNeedsReplan(after, { reason: 'empty_branch_after_execute' });
        after = factoryIntake.getWorkItem(after.id);
      }
      expect(after.status).toBe('needs_replan');
      expect(after.origin?.last_escalation).toMatchObject({
        kind: 'provider_switch',
        from: null,
        to: 'ollama',
        reason_shape: 'empty_branch_after_execute',
      });
      const constraints = JSON.parse(after.constraints_json || '{}');
      expect(constraints.architect_provider_override).toBe('ollama');
    });

    it('different-shape rejections do NOT accumulate toward escalation', () => {
      makeProject(db, ['ollama', 'codex']);
      const item = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'X' });
      let current = item;
      current = routeWorkItemToNeedsReplan(current, { reason: 'cannot_generate_plan: a' });
      current = factoryIntake.getWorkItem(current.id);
      current = routeWorkItemToNeedsReplan(current, { reason: 'empty_branch_after_execute' });
      current = factoryIntake.getWorkItem(current.id);
      current = routeWorkItemToNeedsReplan(current, { reason: 'plan_quality_gate_rejected_after_intrabatch_retries' });
      current = factoryIntake.getWorkItem(current.id);
      expect(current.status).toBe('needs_replan');
      expect(current.origin?.last_escalation).toBeUndefined();
    });
  });

  describe('escalation_exhausted is in CLOSED_STATUSES (not picked up by PRIORITIZE)', () => {
    it('is excluded from listOpenWorkItems', () => {
      makeProject(db, []);
      const item = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'X' });
      let current = item;
      for (let i = 0; i < SAME_SHAPE_THRESHOLD; i++) {
        current = routeWorkItemToNeedsReplan(current, { reason: 'cannot_generate_plan: x' });
        current = factoryIntake.getWorkItem(current.id);
      }
      expect(current.status).toBe('escalation_exhausted');
      const open = factoryIntake.listOpenWorkItems({ project_id: 'p1' });
      expect(open.map((w) => w.id)).not.toContain(item.id);
    });
  });
});
