'use strict';
const { describe, it, expect } = require('vitest');
const { createPromptOptimizer } = require('../memory/prompt-optimizer');

describe('promptOptimizer', () => {
  it('metaprompt strategy returns a rewritten prompt from an LLM adapter', async () => {
    const llm = { propose: async ({ current, feedback }) => `${current}\n\n[revised] ${feedback[0]}` };
    const opt = createPromptOptimizer({ strategy: 'metaprompt', llm });
    const out = await opt.optimize({ current: 'Be concise.', trajectory: [], feedback: ['add examples'] });
    expect(out.prompt).toContain('[revised] add examples');
    expect(out.strategy).toBe('metaprompt');
  });

  it('prompt_memory strategy appends successful trajectories as examples', async () => {
    const opt = createPromptOptimizer({ strategy: 'prompt_memory', llm: null });
    const out = await opt.optimize({
      current: 'Answer the user.',
      trajectory: [{ input: 'hi', output: 'hello', score: 1 }],
      feedback: [],
    });
    expect(out.prompt).toContain('hi');
    expect(out.prompt).toContain('hello');
  });

  it('gradient strategy increments a version + feedback delta', async () => {
    const llm = { propose: async ({ current, feedback }) => `${current} / revised: ${feedback.length} signals` };
    const opt = createPromptOptimizer({ strategy: 'gradient', llm });
    const out = await opt.optimize({ current: 'P0', trajectory: [], feedback: ['too verbose', 'missed step 3'] });
    expect(out.prompt).toMatch(/revised: 2 signals/);
  });

  it('returns unchanged prompt when no feedback and no successful trajectories', async () => {
    const opt = createPromptOptimizer({ strategy: 'prompt_memory', llm: null });
    const out = await opt.optimize({ current: 'P', trajectory: [], feedback: [] });
    expect(out.prompt).toBe('P');
    expect(out.changed).toBe(false);
  });
});
