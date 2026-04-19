'use strict';

describe('plan-quality-gate module exports', () => {
  it('exports evaluatePlan, runDeterministicRules, runLlmSemanticCheck, buildFeedbackPrompt, RULES', () => {
    const mod = require('../factory/plan-quality-gate');
    expect(typeof mod.evaluatePlan).toBe('function');
    expect(typeof mod.runDeterministicRules).toBe('function');
    expect(typeof mod.runLlmSemanticCheck).toBe('function');
    expect(typeof mod.buildFeedbackPrompt).toBe('function');
    expect(typeof mod.RULES).toBe('object');
    expect(mod.MAX_REPLAN_ATTEMPTS).toBe(1);
    expect(mod.LLM_TIMEOUT_MS).toBe(60_000);
  });
});
