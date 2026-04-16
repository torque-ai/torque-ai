'use strict';

import { beforeEach, describe, it, expect } from 'vitest';

const { runCrewTurn } = require('../crew/crew-runner');
const { createContextVariables } = require('../crew/context-variables');
const { createHandoff, getHandoffHistory, resetHandoffState } = require('../crew/handoff');

describe('crew-runner handoff', () => {
  beforeEach(() => {
    resetHandoffState();
  });

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

  it('records handoff history for a task-scoped lookup when task context is provided', async () => {
    const agents = {
      triage: {
        tools: {
          route: async () => createHandoff('billing', { contextPatch: { issue: 'refund' } }),
        },
      },
      billing: {
        tools: {
          respond: async () => 'ok',
        },
      },
    };
    const state = {
      activeAgent: 'triage',
      contextVariables: createContextVariables(),
    };

    await runCrewTurn({
      agents,
      state,
      taskId: 'task-123',
      workflowId: 'wf-123',
      toolCall: { name: 'route', args: {} },
    });

    expect(getHandoffHistory('task-123')).toEqual([
      expect.objectContaining({
        from: 'triage',
        to: 'billing',
        patch: { issue: 'refund' },
        workflow_id: 'wf-123',
      }),
    ]);
  });
});
