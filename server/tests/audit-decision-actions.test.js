'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  discoverEmitSites,
  discoverClassifierRules,
  discoverBenignPatterns,
  runDecisionActionsAudit,
} = require('../factory/scripts/audit-decision-actions');

function makeFixtureDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-decisions-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

describe('discoverEmitSites', () => {
  it('extracts literal action from single-arg logDecision({ ... })', () => {
    const dir = makeFixtureDir({
      'foo.js': `logDecision({ project_id: 1, stage: 'PLAN', action: 'generated_plan', outcome: {} });`,
    });
    const { literal_emissions, dynamic_action_sites } = discoverEmitSites(dir);
    expect([...literal_emissions.keys()]).toEqual(['generated_plan']);
    expect(dynamic_action_sites).toEqual([]);
  });

  it('extracts literal action from db-prefix logDecision(db, { ... })', () => {
    const dir = makeFixtureDir({
      'foo.js': `logDecision(db, { project_id, stage: 'verify', action: 'auto_recovery_classified', outcome: {} });`,
    });
    const { literal_emissions } = discoverEmitSites(dir);
    expect([...literal_emissions.keys()]).toEqual(['auto_recovery_classified']);
  });

  it('records dynamic-action sites where action is not a literal', () => {
    const dir = makeFixtureDir({
      'foo.js': `logDecision({ project_id: 1, action: \`prefix_\${stage}\`, outcome: {} });`,
    });
    const { literal_emissions, dynamic_action_sites } = discoverEmitSites(dir);
    expect([...literal_emissions.keys()]).toEqual([]);
    expect(dynamic_action_sites.length).toBe(1);
    expect(dynamic_action_sites[0].snippet).toContain('prefix_');
  });

  it('records the same action multiple times when emitted from multiple sites', () => {
    const dir = makeFixtureDir({
      'a.js': `logDecision({ action: 'verified_batch', outcome: {} });`,
      'b.js': `logDecision({ action: 'verified_batch', outcome: {} });`,
    });
    const { literal_emissions } = discoverEmitSites(dir);
    expect(literal_emissions.get('verified_batch').length).toBe(2);
  });
});

describe('discoverClassifierRules', () => {
  it('extracts rule ids and function-style action matchers (decision.action === ...)', () => {
    const dir = makeFixtureDir({
      'server/plugins/auto-recovery-core/rules.js': `
        module.exports = [
          {
            id: 'execute_zero_diff_short_circuit',
            match: (decision) => decision.action === 'execute_zero_diff_short_circuit',
            classify: () => ({ category: 'transient' }),
          },
          {
            id: 'phantom_completion_detected',
            match: (decision) => decision.action === 'phantom_completion_detected',
            classify: () => ({ category: 'phantom' }),
          },
        ];
      `,
    });
    const { rule_ids, action_matchers } = discoverClassifierRules(dir);
    expect(rule_ids.has('execute_zero_diff_short_circuit')).toBe(true);
    expect(rule_ids.has('phantom_completion_detected')).toBe(true);
    expect(action_matchers.get('execute_zero_diff_short_circuit')).toContain('execute_zero_diff_short_circuit');
    expect(action_matchers.get('phantom_completion_detected')).toContain('phantom_completion_detected');
  });

  it('extracts real-codebase shape: name + object-style match: { action: ... }', () => {
    // Mirror the shape in server/plugins/auto-recovery-core/rules.js where
    // most rules use `name:` instead of `id:` and object-form match blocks.
    const dir = makeFixtureDir({
      'server/plugins/auto-recovery-core/rules.js': `
        module.exports = [
          {
            name: 'verify_fail_unclassified',
            priority: 50,
            match: { stage: 'verify', action: 'verify_failed' },
            classify: () => ({ category: 'unknown' }),
          },
          {
            name: 'execute_exception_unclassified',
            priority: 60,
            match: { stage: 'execute', action: 'execute_exception' },
            classify: () => ({ category: 'unknown' }),
          },
        ];
      `,
    });
    const { rule_ids, action_matchers } = discoverClassifierRules(dir);
    expect(rule_ids.has('verify_fail_unclassified')).toBe(true);
    expect(rule_ids.has('execute_exception_unclassified')).toBe(true);
    expect(action_matchers.get('verify_failed')).toContain('verify_fail_unclassified');
    expect(action_matchers.get('execute_exception')).toContain('execute_exception_unclassified');
  });

  it('records all rule_ids when multiple rules match the same action (collision surfacing)', () => {
    const dir = makeFixtureDir({
      'server/plugins/auto-recovery-core/rules.js': `
        module.exports = [
          {
            name: 'first_rule_for_collision',
            match: { action: 'collision_action' },
          },
          {
            name: 'second_rule_for_collision',
            match: { action: 'collision_action' },
          },
        ];
      `,
    });
    const { action_matchers } = discoverClassifierRules(dir);
    const matchers = action_matchers.get('collision_action');
    expect(matchers).toContain('first_rule_for_collision');
    expect(matchers).toContain('second_rule_for_collision');
    expect(matchers.length).toBe(2);
  });
});

describe('discoverBenignPatterns', () => {
  it('extracts exact action names and prefixes from isBenignFlowDecision', () => {
    const dir = makeFixtureDir({
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([
          'scanned_plans',
          'verified_batch',
          'gate_approved',
        ]);
        const BENIGN_FLOW_ACTION_PREFIXES = ['started_', 'completed_'];
        function isBenignFlowDecision(decision) { /* ... */ }
      `,
    });
    const { exact, prefixes } = discoverBenignPatterns(dir);
    expect(exact.has('scanned_plans')).toBe(true);
    expect(exact.has('verified_batch')).toBe(true);
    expect(exact.has('gate_approved')).toBe(true);
    expect(prefixes.has('started_')).toBe(true);
    expect(prefixes.has('completed_')).toBe(true);
  });
});

describe('runDecisionActionsAudit', () => {
  it('reports emitted_not_in_catalog when emit site uses an action not in the catalog', () => {
    const dir = makeFixtureDir({
      'server/factory/foo.js': `logDecision({ action: 'undocumented_action', outcome: {} });`,
      'server/plugins/auto-recovery-core/rules.js': `module.exports = [];`,
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([]);
        const BENIGN_FLOW_ACTION_PREFIXES = [];
      `,
    });
    const catalog = {};
    const report = runDecisionActionsAudit({ rootDir: dir, catalog });
    expect(report.emitted_not_in_catalog).toContain('undocumented_action');
    expect(report.hasGaps).toBe(true);
  });

  it('reports emitted_no_classifier when emit site is in catalog but lacks classifier wiring', () => {
    const dir = makeFixtureDir({
      'server/factory/foo.js': `logDecision({ action: 'orphan_in_catalog', outcome: {} });`,
      'server/plugins/auto-recovery-core/rules.js': `module.exports = [];`,
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([]);
        const BENIGN_FLOW_ACTION_PREFIXES = [];
      `,
    });
    const catalog = { orphan_in_catalog: { stage: 'EXECUTE', classifier: 'recovery-rule', rule_id: 'missing_rule' } };
    const report = runDecisionActionsAudit({ rootDir: dir, catalog });
    expect(report.emitted_no_classifier).toContain('orphan_in_catalog');
    expect(report.hasGaps).toBe(true);
  });

  it('reports rule_id_mismatch when catalog references a rule_id not in rules.js', () => {
    const dir = makeFixtureDir({
      'server/factory/foo.js': `logDecision({ action: 'foo_failed', outcome: {} });`,
      'server/plugins/auto-recovery-core/rules.js': `module.exports = [{ id: 'real_rule', match: () => false }];`,
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([]);
        const BENIGN_FLOW_ACTION_PREFIXES = [];
      `,
    });
    const catalog = { foo_failed: { stage: 'EXECUTE', classifier: 'recovery-rule', rule_id: 'phantom_rule' } };
    const report = runDecisionActionsAudit({ rootDir: dir, catalog });
    expect(report.rule_id_mismatch).toEqual([
      expect.objectContaining({ action: 'foo_failed', catalog_rule_id: 'phantom_rule' }),
    ]);
  });

  it('reports catalog_not_emitted when catalog has an entry with no emit site', () => {
    const dir = makeFixtureDir({
      'server/factory/foo.js': `// no logDecision calls`,
      'server/plugins/auto-recovery-core/rules.js': `module.exports = [];`,
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([]);
        const BENIGN_FLOW_ACTION_PREFIXES = [];
      `,
    });
    const catalog = { dead_doc: { stage: 'EXECUTE', classifier: 'benign' } };
    const report = runDecisionActionsAudit({ rootDir: dir, catalog });
    expect(report.catalog_not_emitted).toContain('dead_doc');
  });

  it('hasGaps is false when all four categories are empty', () => {
    const dir = makeFixtureDir({
      'server/factory/foo.js': `logDecision({ action: 'good_action', outcome: {} });`,
      'server/plugins/auto-recovery-core/rules.js': `module.exports = [{ id: 'good_rule', match: (d) => d.action === 'good_action' }];`,
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([]);
        const BENIGN_FLOW_ACTION_PREFIXES = [];
      `,
    });
    const catalog = { good_action: { stage: 'EXECUTE', classifier: 'recovery-rule', rule_id: 'good_rule' } };
    const report = runDecisionActionsAudit({ rootDir: dir, catalog });
    expect(report.emitted_not_in_catalog).toEqual([]);
    expect(report.emitted_no_classifier).toEqual([]);
    expect(report.rule_id_mismatch).toEqual([]);
    expect(report.catalog_not_emitted).toEqual([]);
    expect(report.hasGaps).toBe(false);
  });

  it('reports rule_id_mismatch with null when recovery-rule catalog entry has no rule_id (catalog malformation)', () => {
    const dir = makeFixtureDir({
      'server/factory/foo.js': `logDecision({ action: 'malformed', outcome: {} });`,
      'server/plugins/auto-recovery-core/rules.js': `module.exports = [];`,
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([]);
        const BENIGN_FLOW_ACTION_PREFIXES = [];
      `,
    });
    // recovery-rule classifier without rule_id is a catalog typo/omission;
    // surface it explicitly rather than skipping silently.
    const catalog = { malformed: { stage: 'EXECUTE', classifier: 'recovery-rule' } };
    const report = runDecisionActionsAudit({ rootDir: dir, catalog });
    expect(report.rule_id_mismatch).toEqual([
      expect.objectContaining({ action: 'malformed', catalog_rule_id: null }),
    ]);
    expect(report.hasGaps).toBe(true);
  });

  it('flags emitted_no_classifier when classifier kind is unknown (typo / future kind)', () => {
    const dir = makeFixtureDir({
      'server/factory/foo.js': `logDecision({ action: 'typo_kind_action', outcome: {} });`,
      'server/plugins/auto-recovery-core/rules.js': `module.exports = [];`,
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([]);
        const BENIGN_FLOW_ACTION_PREFIXES = [];
      `,
    });
    const catalog = { typo_kind_action: { stage: 'EXECUTE', classifier: 'foobar' } };
    const report = runDecisionActionsAudit({ rootDir: dir, catalog });
    expect(report.emitted_no_classifier).toContain('typo_kind_action');
    expect(report.hasGaps).toBe(true);
  });
});
