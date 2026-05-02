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

  it('architect-runner has no wall-clock inner deadline (2026-05-02 policy)', () => {
    // Phase R originally required the outer strategy timeout to exceed the
    // architect-runner inner deadline so strategies couldn't be cut off
    // mid-poll. The architect-runner now polls without a wall-clock cap
    // (see phasew-architect-cycle-deadline.test.js) — stall detection is
    // the bound on hung architect tasks. The outer strategy timeout
    // remains the only wall-clock bound on replan recovery, sized to give
    // codex room to land on busy days.
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
