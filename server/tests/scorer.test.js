'use strict';

const { describe, it, expect } = require('vitest');
const { createScorer } = require('../evals/scorer');
const { composeScorers } = require('../evals/compose-scorers');

describe('Scorer + compose', () => {
  it('match() returns 1 for equality', async () => {
    const s = createScorer({ kind: 'match', target: (sample) => sample.expected });
    const r = await s.score({ expected: 'yes' }, { output: 'yes' });
    expect(r.value).toBe(1);
  });

  it('choice() scores 0/1 against target option', async () => {
    const s = createScorer({ kind: 'choice', target: () => 'B' });
    expect((await s.score({}, { output: 'B' })).value).toBe(1);
    expect((await s.score({}, { output: 'C' })).value).toBe(0);
  });

  it('composeScorers averages numeric values', async () => {
    const a = createScorer({ kind: 'match', target: () => 'x' });
    const b = createScorer({ kind: 'choice', target: () => 'y' });
    const composed = composeScorers([a, b], { reduce: 'mean' });
    const r = await composed.score({}, { output: 'x' });
    expect(r.value).toBeCloseTo(0.5);
    expect(r.components).toHaveLength(2);
  });

  it('composeScorers with reduce=min returns worst score', async () => {
    const a = createScorer({ kind: 'match', target: () => 'x' });
    const b = createScorer({ kind: 'match', target: () => 'y' });
    const composed = composeScorers([a, b], { reduce: 'min' });
    expect((await composed.score({}, { output: 'x' })).value).toBe(0);
  });
});
