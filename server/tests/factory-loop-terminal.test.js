'use strict';

const { describe, it, expect, beforeEach, vi } = require('vitest');

vi.mock('../db/factory-health', () => ({
  getProject: vi.fn(),
  updateProject: vi.fn(),
  getProjectHealthSummary: vi.fn(() => ({})),
}));
vi.mock('../factory/guardrail-runner', () => ({
  runPostBatchChecks: vi.fn(() => ({ status: 'ok' })),
}));
vi.mock('../factory/feedback', () => ({
  analyzeBatch: vi.fn(() => ({ status: 'ok' })),
}));

const factoryHealth = require('../db/factory-health');
const loopController = require('../factory/loop-controller');

describe('factory loop LEARN terminal state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('supervised project: LEARN advances to IDLE by default (no auto_continue)', async () => {
    factoryHealth.getProject.mockReturnValue({
      id: 'p1',
      loop_state: 'LEARN',
      trust_level: 'supervised',
      loop_batch_id: null,
      config_json: null,
    });
    const result = await loopController.advanceLoop('p1');
    expect(result.new_state).toBe('IDLE');
  });

  it('project with loop.auto_continue=true: LEARN advances to SENSE (legacy)', async () => {
    factoryHealth.getProject.mockReturnValue({
      id: 'p2',
      loop_state: 'LEARN',
      trust_level: 'autonomous',
      loop_batch_id: null,
      config_json: JSON.stringify({ loop: { auto_continue: true } }),
    });
    const result = await loopController.advanceLoop('p2');
    expect(result.new_state).toBe('SENSE');
  });
});
