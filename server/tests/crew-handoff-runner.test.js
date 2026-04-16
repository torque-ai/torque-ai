'use strict';

import { describe, it, expect } from 'vitest';

const { runCrewTurn } = require('../crew/crew-runner');
const { createContextVariables } = require('../crew/context-variables');
const { createHandoff } = require('../crew/handoff');

describe('crew-runner handoff', () => {
  it('swaps active agent when a tool returns a handoff', async () => {
    const agents = {
      triage: {
        tools: {
          route: async () => createHandoff('billing', { contextPatch: { issue: 'refund' } }),
        },
      },
      billing: {
        tools: {
          respond: async (_, ctx) => `billing saw issue=${ctx.get('issue')}`,
        },
      },
    };
    const state = {
      activeAgent: 'triage',
      contextVariables: createContextVariables(),
    };

    const turn1 = await runCrewTurn({
      agents,
      state,
      toolCall: { name: 'route', args: {} },
    });

    expect(turn1.activeAgent).toBe('billing');
    expect(turn1.handedOff).toBe(true);
    expect(state.contextVariables.get('issue')).toBe('refund');

    const turn2 = await runCrewTurn({
      agents,
      state,
      toolCall: { name: 'respond', args: {} },
    });

    expect(turn2.result).toMatch(/billing.*refund/);
  });

  it('loop guard aborts after > maxHandoffs in one turn chain', async () => {
    const agents = {
      a: { tools: { bounce: async () => createHandoff('b') } },
      b: { tools: { bounce: async () => createHandoff('a') } },
    };
    const state = {
      activeAgent: 'a',
      contextVariables: createContextVariables(),
    };
    const run = () => runCrewTurn({
      agents,
      state,
      toolCall: { name: 'bounce', args: {} },
      chainAutomatically: true,
      maxHandoffs: 5,
    });

    await expect(run()).rejects.toThrow(/handoff/i);
  });
});
