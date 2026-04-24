'use strict';

import { beforeEach, describe, it, expect, vi } from 'vitest';

const { runCrew, runCrewTurn } = require('../crew/crew-runner');
const { runCrew: runCrewRuntime } = require('../crew/crew-runtime');
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

describe('crew-runtime runCrew', () => {
  it('round_robin: each role takes a turn until objective met or rounds exhausted', async () => {
    const calls = [];
    const callRole = vi.fn(async ({ role, history }) => {
      calls.push({ role: role.name, round: history.length });
      if (role.name === 'planner' && calls.filter((entry) => entry.role === 'planner').length === 2) {
        return { output: { plan: 'final', done: true } };
      }
      return { output: { partial: `${role.name} round` } };
    });

    const result = await runCrewRuntime({
      objective: 'Plan a feature',
      roles: [{ name: 'planner', description: 'Plans' }, { name: 'critic', description: 'Critiques' }],
      mode: 'round_robin',
      max_rounds: 5,
      output_schema: {
        type: 'object',
        required: ['done'],
        properties: { done: { type: 'boolean' } },
      },
      callRole,
    });

    expect(result.terminated_by).toBe('output_matched_schema');
    expect(result.final_output.done).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('terminates at max_rounds even if no role declares done', async () => {
    const callRole = vi.fn(async () => ({ output: { partial: 'still working' } }));

    const result = await runCrewRuntime({
      objective: 'never finish',
      roles: [{ name: 'r1', description: '' }],
      mode: 'round_robin',
      max_rounds: 3,
      output_schema: { type: 'object', required: ['done'] },
      callRole,
    });

    expect(result.terminated_by).toBe('max_rounds');
    expect(callRole).toHaveBeenCalledTimes(3);
  });

  it('parallel mode runs all roles concurrently in each round', async () => {
    const startTimes = [];
    const callRole = vi.fn(async ({ role }) => {
      startTimes.push({ role: role.name, t: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { output: { from: role.name } };
    });

    await runCrewRuntime({
      objective: 'race',
      roles: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      mode: 'parallel',
      max_rounds: 1,
      callRole,
    });

    const spread = Math.max(...startTimes.map((entry) => entry.t)) - Math.min(...startTimes.map((entry) => entry.t));
    expect(spread).toBeLessThan(40);
  });

  it('returns aggregated history for downstream observability', async () => {
    const callRole = vi.fn(async ({ role }) => ({ output: { from: role.name } }));

    const result = await runCrewRuntime({
      objective: 'log',
      roles: [{ name: 'r1' }],
      mode: 'round_robin',
      max_rounds: 2,
      callRole,
    });

    expect(result.history).toHaveLength(2);
    expect(result.history[0].role).toBe('r1');
  });
});
