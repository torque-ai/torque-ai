'use strict';

import { beforeEach, describe, it, expect } from 'vitest';

const { runCrew, runCrewTurn } = require('../crew/crew-runner');
const { codeRouter } = require('../crew/routers');
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

describe('runCrew() — handoff integration', () => {
  beforeEach(() => {
    resetHandoffState();
  });

  it('handoff switches active agent mid-loop', async () => {
    const callLog = [];
    const agents = {
      alpha: {
        tools: {
          delegate: async () => createHandoff('beta'),
        },
      },
      beta: {
        tools: {
          finish: async () => 'beta-done',
        },
      },
    };
    const state = {
      activeAgent: 'alpha',
      contextVariables: createContextVariables(),
    };

    // Turn 1: alpha delegates to beta via handoff
    const turn1 = await runCrewTurn({
      agents,
      state,
      toolCall: { name: 'delegate', args: {} },
    });

    expect(turn1.handedOff).toBe(true);
    expect(turn1.activeAgent).toBe('beta');
    expect(state.activeAgent).toBe('beta');
    callLog.push('alpha:delegate');

    // Turn 2: beta finishes — confirm the handoff stuck
    const turn2 = await runCrewTurn({
      agents,
      state,
      toolCall: { name: 'finish', args: {} },
    });

    callLog.push('beta:finish');
    expect(turn2.activeAgent).toBe('beta');
    expect(turn2.result).toBe('beta-done');
    expect(callLog).toEqual(['alpha:delegate', 'beta:finish']);
  });

  it('context variables survive handoff and are visible to target agent', async () => {
    const agents = {
      alpha: {
        tools: {
          delegate: async () =>
            createHandoff('beta', { contextPatch: { key: 'val', extra: 42 } }),
        },
      },
      beta: {
        tools: {
          read_ctx: async (_args, ctx) =>
            `key=${ctx.get('key')},extra=${ctx.get('extra')}`,
        },
      },
    };
    const state = {
      activeAgent: 'alpha',
      contextVariables: createContextVariables({ preexisting: true }),
    };

    await runCrewTurn({
      agents,
      state,
      toolCall: { name: 'delegate', args: {} },
    });

    // Context variables must have the handoff patch merged
    expect(state.contextVariables.get('key')).toBe('val');
    expect(state.contextVariables.get('extra')).toBe(42);
    // Pre-existing variables must survive the merge
    expect(state.contextVariables.get('preexisting')).toBe(true);

    // Target agent sees the merged context
    const turn2 = await runCrewTurn({
      agents,
      state,
      toolCall: { name: 'read_ctx', args: {} },
    });

    expect(turn2.result).toBe('key=val,extra=42');
  });

  it('handoff context patch is recorded in handoff history', async () => {
    const agents = {
      alpha: {
        tools: {
          delegate: async () =>
            createHandoff('beta', { contextPatch: { reason: 'escalation' } }),
        },
      },
      beta: {
        tools: {
          ack: async () => 'ok',
        },
      },
    };
    const state = {
      activeAgent: 'alpha',
      contextVariables: createContextVariables(),
    };

    await runCrewTurn({
      agents,
      state,
      taskId: 'task-int-1',
      workflowId: 'wf-int-1',
      toolCall: { name: 'delegate', args: {} },
    });

    const history = getHandoffHistory('task-int-1');
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(
      expect.objectContaining({
        from: 'alpha',
        to: 'beta',
        patch: { reason: 'escalation' },
        workflow_id: 'wf-int-1',
      })
    );
  });

  it('handoff to unknown agent throws', async () => {
    const agents = {
      alpha: {
        tools: {
          delegate: async () => createHandoff('nonexistent'),
        },
      },
    };
    const state = {
      activeAgent: 'alpha',
      contextVariables: createContextVariables(),
    };

    await expect(
      runCrewTurn({
        agents,
        state,
        toolCall: { name: 'delegate', args: {} },
      })
    ).rejects.toThrow(/unknown active agent "nonexistent"/i);
  });

  it('chained handoffs A→B→C complete in order', async () => {
    const invocationOrder = [];
    const agents = {
      a: {
        tools: {
          hop: async () => {
            invocationOrder.push('a');
            return createHandoff('b');
          },
        },
      },
      b: {
        tools: {
          hop: async () => {
            invocationOrder.push('b');
            return createHandoff('c');
          },
        },
      },
      c: {
        tools: {
          hop: async () => {
            invocationOrder.push('c');
            return 'final-result';
          },
        },
      },
    };
    const state = {
      activeAgent: 'a',
      contextVariables: createContextVariables(),
    };

    // chainAutomatically causes runCrewTurn to follow the handoff chain
    // since all agents share the same tool name "hop"
    const result = await runCrewTurn({
      agents,
      state,
      toolCall: { name: 'hop', args: {} },
      chainAutomatically: true,
      maxHandoffs: 10,
    });

    expect(invocationOrder).toEqual(['a', 'b', 'c']);
    expect(state.activeAgent).toBe('c');
    expect(result.activeAgent).toBe('c');
    expect(result.result).toBe('final-result');
  });
});

describe('runCrew', () => {
  it('defaults to round-robin routing and exits when output matches schema', async () => {
    const roles = [{ name: 'planner' }, { name: 'critic' }];
    const result = await runCrew({
      objective: 'Ship a recommendation',
      roles,
      max_rounds: 3,
      output_schema: {
        type: 'object',
        required: ['done', 'recommendation'],
        properties: {
          done: { const: true },
          recommendation: { type: 'string' },
        },
      },
      callRole: async ({ role, history }) => {
        if (role.name === 'planner') {
          return { output: { done: false, draft: history.length + 1 } };
        }
        return { output: { done: true, recommendation: 'merge it' } };
      },
    });

    expect(result.terminated_by).toBe('output_matched_schema');
    expect(result.rounds).toBe(2);
    expect(result.history.map((entry) => entry.role)).toEqual(['planner', 'critic']);
    expect(result.final_output).toEqual({ done: true, recommendation: 'merge it' });
  });

  it('stops early when the injected router returns null', async () => {
    const roles = [{ name: 'planner' }, { name: 'critic' }];
    const router = codeRouter((_state, turn) => (turn.turn_count === 0 ? 'critic' : null));
    const result = await runCrew({
      objective: 'Stop after one turn',
      roles,
      router,
      callRole: async ({ role }) => ({ output: { speaker: role.name } }),
    });

    expect(result.terminated_by).toBe('router_stopped');
    expect(result.rounds).toBe(1);
    expect(result.history).toEqual([
      expect.objectContaining({
        role: 'critic',
        agent: 'critic',
        turn_count: 0,
        output: { speaker: 'critic' },
      }),
    ]);
    expect(result.final_output).toEqual({ speaker: 'critic' });
  });
});
