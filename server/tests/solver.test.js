'use strict';

const { describe, it, expect } = require('vitest');
const { createSolver, chainSolvers } = require('../evals/solver');

describe('Solver', () => {
  it('run returns an output for a sample', async () => {
    const s = createSolver({ name: 'echo', run: async (sample) => ({ output: sample.input }) });
    expect(await s.run({ input: 'hi' })).toEqual({ output: 'hi' });
  });

  it('chainSolvers composes sequentially, passing output forward', async () => {
    const upper = createSolver({ name: 'upper', run: async (s) => ({ output: s.input.toUpperCase() }) });
    const bang = createSolver({ name: 'bang', run: async (s) => ({ output: s.input + '!' }) });
    const chained = chainSolvers([upper, bang]);
    const out = await chained.run({ input: 'hi' });
    expect(out.output).toBe('HI!');
  });
});
