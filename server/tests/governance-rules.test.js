const Database = require('better-sqlite3');
const { BUILTIN_RULES, VALID_MODES, createGovernanceRules } = require('../db/governance-rules');

describe('governance-rules', () => {
  let db;
  let rules;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS governance_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        stage TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'warn',
        default_mode TEXT NOT NULL DEFAULT 'warn',
        enabled INTEGER NOT NULL DEFAULT 1,
        violation_count INTEGER NOT NULL DEFAULT 0,
        checker_id TEXT NOT NULL,
        config TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_governance_rules_stage ON governance_rules(stage);
      CREATE INDEX IF NOT EXISTS idx_governance_rules_enabled ON governance_rules(enabled);
    `);

    rules = createGovernanceRules({ db });
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  it('seedBuiltinRules inserts all builtin rules', () => {
    expect(BUILTIN_RULES).toHaveLength(13);
    expect(VALID_MODES).toEqual(['block', 'warn', 'shadow', 'off']);

    const inserted = rules.seedBuiltinRules();

    expect(inserted).toBe(13);
    expect(rules.getAllRules()).toHaveLength(13);
    expect(rules.getRule('block-visible-providers')).toMatchObject({
      id: 'block-visible-providers',
      stage: 'task_submit',
      mode: 'block',
      default_mode: 'block',
      enabled: true,
      checker_id: 'checkVisibleProvider',
      config: { providers: ['codex', 'claude-cli'] },
    });
  });

  it('seedBuiltinRules is idempotent', () => {
    expect(rules.seedBuiltinRules()).toBe(13);
    expect(rules.seedBuiltinRules()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM governance_rules').get().count).toBe(13);
  });

  it('getRule returns single rule or null', () => {
    rules.seedBuiltinRules();

    expect(rules.getRule('inspect-before-cancel')).toMatchObject({
      id: 'inspect-before-cancel',
      stage: 'task_cancel',
      default_mode: 'block',
      checker_id: 'checkInspectedBeforeCancel',
    });
    expect(rules.getRule('missing-rule')).toBeNull();
  });

  it('getActiveRulesForStage returns enabled rules for stage', () => {
    rules.seedBuiltinRules();
    rules.toggleRule('no-local-tests', false);

    const active = rules.getActiveRulesForStage('task_pre_execute');

    // 3 task_pre_execute rules minus 1 disabled = 2 active
    expect(active).toHaveLength(2);
    expect(active.map(r => r.id)).toContain('require-push-before-remote');
    expect(active.map(r => r.id)).not.toContain('no-local-tests');
    expect(active.every(r => r.enabled === true || r.enabled === 1)).toBe(true);
  });

  it('updateRuleMode changes mode', () => {
    rules.seedBuiltinRules();

    const updated = rules.updateRuleMode('verify-diff-after-codex', 'shadow');

    expect(updated).toMatchObject({
      id: 'verify-diff-after-codex',
      mode: 'shadow',
    });
    expect(rules.getRule('verify-diff-after-codex').mode).toBe('shadow');
  });

  it('updateRuleMode rejects invalid mode', () => {
    rules.seedBuiltinRules();

    expect(() => rules.updateRuleMode('verify-diff-after-codex', 'invalid')).toThrow(/Invalid governance rule mode/);
  });

  it('toggleRule disables and enables', () => {
    rules.seedBuiltinRules();

    const disabled = rules.toggleRule('inspect-before-cancel', false);
    const enabled = rules.toggleRule('inspect-before-cancel', true);

    expect(disabled.enabled).toBe(false);
    expect(enabled.enabled).toBe(true);
  });

  it('incrementViolation bumps count', () => {
    rules.seedBuiltinRules();

    rules.incrementViolation('block-visible-providers');
    const updated = rules.incrementViolation('block-visible-providers');

    expect(updated.violation_count).toBe(2);
  });

  it('resetViolationCounts zeros all', () => {
    rules.seedBuiltinRules();
    rules.incrementViolation('block-visible-providers');
    rules.incrementViolation('verify-diff-after-codex');

    const changes = rules.resetViolationCounts();

    expect(changes).toBeGreaterThanOrEqual(2);
    expect(rules.getAllRules().every((rule) => rule.violation_count === 0)).toBe(true);
  });

  it('getAllRules sorted by stage then name', () => {
    rules.seedBuiltinRules();

    const all = rules.getAllRules();
    expect(all).toHaveLength(13);
    // Verify sorted by stage then name
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const curr = all[i];
      if (prev.stage === curr.stage) {
        expect(prev.name.localeCompare(curr.name)).toBeLessThanOrEqual(0);
      } else {
        expect(prev.stage.localeCompare(curr.stage)).toBeLessThanOrEqual(0);
      }
    }
  });
});
