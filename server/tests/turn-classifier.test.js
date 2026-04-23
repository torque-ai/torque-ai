'use strict';

const { createTurnClassifier } = require('../routing/turn-classifier');

const AGENTS = [
  { id: 'billing', description: 'Handles invoices, refunds, and billing disputes.' },
  { id: 'support', description: 'General technical support for account issues.' },
  { id: 'sales', description: 'Product questions, pricing, upgrades.' },
];

describe('turn-classifier', () => {
  it('routes refund phrasing to billing', async () => {
    const classifier = createTurnClassifier({ adapter: 'heuristic' });

    const result = await classifier.classify({
      userInput: 'I want a refund for my last invoice',
      history: [],
      agents: AGENTS,
    });

    expect(result.agent_id).toBe('billing');
  });

  it('routes login issues to support', async () => {
    const classifier = createTurnClassifier({ adapter: 'heuristic' });

    const result = await classifier.classify({
      userInput: 'I cannot log in to my account',
      history: [],
      agents: AGENTS,
    });

    expect(result.agent_id).toBe('support');
  });

  it('follow-up "again" prefers the previous specialist', async () => {
    const classifier = createTurnClassifier({ adapter: 'heuristic' });
    const history = [
      { role: 'user', content: 'refund please', agent_id: 'billing' },
      { role: 'assistant', content: 'ok, done', agent_id: 'billing' },
    ];

    const result = await classifier.classify({
      userInput: 'again',
      history,
      agents: AGENTS,
    });

    expect(result.agent_id).toBe('billing');
  });

  it('llm adapter delegates to provided classifier fn', async () => {
    const classifier = createTurnClassifier({
      adapter: 'llm',
      classifyFn: async () => ({ agent_id: 'sales', confidence: 0.9 }),
    });

    const result = await classifier.classify({
      userInput: 'pricing?',
      history: [],
      agents: AGENTS,
    });

    expect(result.agent_id).toBe('sales');
  });

  it('returns null agent_id when no heuristic matches', async () => {
    const classifier = createTurnClassifier({ adapter: 'heuristic' });

    const result = await classifier.classify({
      userInput: 'xyz unrelated phrase qqq',
      history: [],
      agents: AGENTS,
    });

    expect(result.agent_id).toBeNull();
  });
});
