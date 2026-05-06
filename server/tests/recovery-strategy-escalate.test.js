'use strict';

const strategy = require('../factory/recovery-strategies/escalate-architect');

const noopLogger = { warn() {}, error() {}, info() {} };

const baseWorkItem = (rejectReason = 'zero_diff_across_retries', constraintsJson = null) => ({
  id: 1,
  title: 't',
  description: 'd',
  reject_reason: rejectReason,
  constraints_json: constraintsJson,
  project_id: 'proj-1',
});

const projectChain = ['ollama', 'codex-spark', 'codex', 'claude-cli'];

const stubFactoryHealth = (chain = projectChain) => ({
  getProject(projectId) {
    return {
      id: projectId,
      provider_chain_json: JSON.stringify(chain),
    };
  },
});

describe('escalate-architect strategy', () => {
  it('owns the expected reject reasons', () => {
    expect(strategy.reasonPatterns.some((p) => p.test('zero_diff_across_retries'))).toBe(true);
    expect(strategy.reasonPatterns.some((p) => p.test('retry_off_scope'))).toBe(true);
  });

  // First-escalation case: no override set yet → project defaults to chain[0]
  // (ollama) → bump to chain[1] (codex-spark). Mirrors loop-controller Phase X5.
  it('first escalation bumps from chain[0] to chain[1] when no override set', async () => {
    const workItem = baseWorkItem('zero_diff_across_retries', null);
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('escalated');
    expect(result.updates.constraints.architect_provider_override).toBe('codex-spark');
    expect(result.updates.constraints.execution_provider_override).toBe('codex-spark');
  });

  // Second-escalation regression test (recovery-decisions.md conflict #2):
  // override is set to chain[1] from the prior escalation → must bump PAST it
  // to chain[2], not back to chain[1]. Earlier B1 read a never-written
  // `last_used_provider` field, so this case bumped chain[0] → chain[1] every
  // time and the recovery looped on the same provider.
  it('second escalation bumps from chain[1] override to chain[2]', async () => {
    const workItem = baseWorkItem(
      'zero_diff_across_retries',
      JSON.stringify({ architect_provider_override: 'codex-spark' })
    );
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('escalated');
    expect(result.updates.constraints.architect_provider_override).toBe('codex');
  });

  it('third escalation bumps from chain[2] override to chain[3]', async () => {
    const workItem = baseWorkItem(
      'retry_off_scope',
      JSON.stringify({ architect_provider_override: 'codex' })
    );
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('escalated');
    expect(result.updates.constraints.architect_provider_override).toBe('claude-cli');
  });

  it('returns unrecoverable when already at the top of the chain', async () => {
    const workItem = baseWorkItem(
      'zero_diff_across_retries',
      JSON.stringify({ architect_provider_override: 'claude-cli' })
    );
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('unrecoverable');
    expect(result.reason).toMatch(/top of chain/i);
  });

  it('treats unknown override (not in chain) as start-from-chain[0]', async () => {
    // Defensive: if some other path wrote an override that is not in the
    // current chain (e.g., chain config was edited), fall back to bumping
    // from chain[0] rather than refusing or wrapping around.
    const workItem = baseWorkItem(
      'retry_off_scope',
      JSON.stringify({ architect_provider_override: 'mystery-provider' })
    );
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('escalated');
    expect(result.updates.constraints.architect_provider_override).toBe('codex-spark');
  });

  it('returns unrecoverable when project chain is empty/missing', async () => {
    const workItem = baseWorkItem('zero_diff_across_retries', null);
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth([]) },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  // The legacy `last_used_provider` field is no longer read. If a work item
  // happens to have it (e.g., from older state), it must be ignored — the
  // strategy treats the absence of architect_provider_override as
  // "start at chain[0]", which is the correct default.
  it('ignores legacy last_used_provider field (no-op)', async () => {
    const workItem = baseWorkItem(
      'zero_diff_across_retries',
      JSON.stringify({ last_used_provider: 'codex-spark' })
    );
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('escalated');
    // No architect_provider_override → treated as "first escalation" → chain[1]
    expect(result.updates.constraints.architect_provider_override).toBe('codex-spark');
  });
});
