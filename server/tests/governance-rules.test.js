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
    expect(BUILTIN_RULES).toHaveLength(12);
    expect(VALID_MODES).toEqual(['block', 'warn', 'shadow', 'off']);

    const inserted = rules.seedBuiltinRules();

    expect(inserted).toBe(12);
    expect(rules.getAllRules()).toHaveLength(12);
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
    expect(rules.seedBuiltinRules()).toBe(12);
    expect(rules.seedBuiltinRules()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM governance_rules').get().count).toBe(12);
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

    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      id: 'require-push-before-remote',
      stage: 'task_pre_execute',
      enabled: true,
    });
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

    expect(rules.getAllRules().map((rule) => [rule.stage, rule.name])).toEqual([
      ['task_cancel', 'inspect-before-cancel'],
      ['task_complete', 'verify-diff-after-codex'],
      ['task_pre_execute', 'no-local-tests'],
      ['task_pre_execute', 'require-push-before-remote'],
      ['task_submit', 'block-visible-providers'],
    ]);
  });
});
