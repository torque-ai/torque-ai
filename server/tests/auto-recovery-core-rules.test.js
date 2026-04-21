'use strict';
const { createPlugin } = require('../plugins/auto-recovery-core');
const { createClassifier } = require('../factory/auto-recovery/classifier');

describe('auto-recovery-core day-one rules', () => {
  const plugin = createPlugin();
  const classifier = createClassifier({ rules: plugin.classifierRules });

  it('classifies the SpudgetBooks sourcelink file-lock as transient', () => {
    const decision = {
      stage: 'verify', action: 'worktree_verify_failed',
      reasoning: 'Worktree remote verify FAILED ... pausing loop at VERIFY_FAIL.',
      outcome: {
        output_preview: `error : Error writing to source link file 'obj\\Debug\\net8.0\\SpudgetBooks.Application.Tests.sourcelink.json' ... because it is being used by another process.`,
        retry_attempts: 1,
      },
    };
    const r = classifier.classify(decision);
    expect(r.category).toBe('transient');
    expect(r.matched_rule).toBe('dotnet_sourcelink_file_lock');
    expect(r.suggested_strategies[0]).toBe('clean_and_retry');
  });

  it('classifies a plan generation failure', () => {
    const r = classifier.classify({
      stage: 'execute', action: 'cannot_generate_plan',
      reasoning: 'Codex exited mid-task', outcome: { work_item_id: 659 },
    });
    expect(['plan_failure', 'sandbox_interrupt']).toContain(r.category);
  });

  it('classifies an unclassified VERIFY_FAIL as verify_fail_unclassified', () => {
    const r = classifier.classify({
      stage: 'verify', action: 'worktree_verify_failed',
      reasoning: 'something unusual',
      outcome: { output_preview: 'new failure kind' },
    });
    expect(r.matched_rule).toBe('verify_fail_unclassified');
  });

  it('every rule suggests strategies known to the plugin', () => {
    const strategyNames = new Set(plugin.recoveryStrategies.map(s => s.name));
    for (const rule of plugin.classifierRules) {
      for (const s of rule.suggested_strategies || []) {
        expect(strategyNames.has(s)).toBe(true);
      }
    }
  });

  it('plugin validates against plugin-contract', () => {
    const { validatePlugin } = require('../plugins/plugin-contract');
    expect(validatePlugin(plugin).valid).toBe(true);
  });
});
