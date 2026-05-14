'use strict';

const {
  REPLAN_RECOVERY_CONFIG_DEFAULTS,
  getReplanRecoveryConfig,
} = require('../db/config-core');

describe('replan-recovery config defaults', () => {
  it('exposes all expected default keys', () => {
    expect(REPLAN_RECOVERY_CONFIG_DEFAULTS).toMatchObject({
      replan_recovery_enabled: '0',
      replan_recovery_sweep_interval_ms: '900000',
      replan_recovery_hard_cap: '3',
      replan_recovery_max_per_project_per_sweep: '1',
      replan_recovery_max_global_per_sweep: '5',
      replan_recovery_skip_if_open_count_gte: '3',
      replan_recovery_cooldown_ms_attempt_0: '3600000',
      replan_recovery_cooldown_ms_attempt_1: '86400000',
      replan_recovery_cooldown_ms_attempt_2: '259200000',
      replan_recovery_strategy_timeout_ms: '960000',
      replan_recovery_strategy_timeout_ms_escalate: '5000',
      replan_recovery_history_max_entries: '10',
      replan_recovery_split_max_children: '5',
      replan_recovery_split_max_depth: '2',
    });
  });

  it('returns parsed numeric config and disabled flag by default', () => {
    const cfg = getReplanRecoveryConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.sweepIntervalMs).toBe(900000);
    expect(cfg.hardCap).toBe(3);
    expect(cfg.maxPerProjectPerSweep).toBe(1);
    expect(cfg.maxGlobalPerSweep).toBe(5);
    expect(cfg.skipIfOpenCountGte).toBe(3);
    expect(cfg.cooldownMs).toEqual([3600000, 86400000, 259200000]);
    expect(cfg.strategyTimeoutMs).toBe(960000);
    expect(cfg.strategyTimeoutMsEscalate).toBe(5000);
    expect(cfg.historyMaxEntries).toBe(10);
    expect(cfg.splitMaxChildren).toBe(5);
    expect(cfg.splitMaxDepth).toBe(2);
  });

  it('architect-runner has no independent poll-loop deadline', () => {
    // The architect-runner polls terminal task state and relies on the
    // submitted task timeout for the provider bound. Replan recovery keeps
    // its own outer strategy timeout for the overall strategy budget.
    const fs = require('fs');
    const path = require('path');
    const archSrc = fs.readFileSync(
      path.join(__dirname, '..', 'factory', 'architect-runner.js'),
      'utf8',
    );
    expect(archSrc).not.toMatch(/deadlineMs\s*=/);
    const cfg = getReplanRecoveryConfig();
    expect(cfg.strategyTimeoutMs).toBeGreaterThan(0);
  });
});
