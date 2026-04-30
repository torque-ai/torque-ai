'use strict';

const { describe, it, expect } = require('vitest');
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

  it('escalates from ollama to codex-spark when last attempt was on ollama', async () => {
    const workItem = baseWorkItem('zero_diff_across_retries', JSON.stringify({ last_used_provider: 'ollama' }));
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('escalated');
    expect(result.updates.constraints.architect_provider_override).toBe('codex-spark');
    expect(result.updates.constraints.execution_provider_override).toBe('codex-spark');
  });

  it('escalates from codex-spark to codex', async () => {
    const workItem = baseWorkItem('zero_diff_across_retries', JSON.stringify({ last_used_provider: 'codex-spark' }));
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('escalated');
    expect(result.updates.constraints.architect_provider_override).toBe('codex');
  });

  it('returns unrecoverable when already at the top of the chain', async () => {
    const workItem = baseWorkItem('zero_diff_across_retries', JSON.stringify({ last_used_provider: 'claude-cli' }));
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('unrecoverable');
    expect(result.reason).toMatch(/top of chain/i);
  });

  it('falls back to first chain entry when last_used_provider unknown', async () => {
    const workItem = baseWorkItem('retry_off_scope', null);
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
});
