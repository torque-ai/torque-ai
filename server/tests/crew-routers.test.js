'use strict';

const { describe, it, expect, vi } = require('vitest');
const { codeRouter, llmRouter, hybridRouter, roundRobinRouter } = require('../crew/routers');

describe('routers', () => {
  const roles = [{ name: 'planner' }, { name: 'critic' }, { name: 'writer' }];

  describe('codeRouter', () => {
    it('picks next agent from user-supplied function', async () => {
      const router = codeRouter((state, turn) => (turn.turn_count === 0 ? 'planner' : 'writer'));
      const first = await router.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } });
      const second = await router.pick({ roles, state: {}, turn: { turn_count: 1, history: [] } });
      expect(first).toBe('planner');
      expect(second).toBe('writer');
    });

    it('returning null stops the crew', async () => {
      const router = codeRouter(() => null);
      expect(await router.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } })).toBeNull();
    });

    it('returning unknown agent name throws', async () => {
      const router = codeRouter(() => 'bogus');
      await expect(router.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } })).rejects.toThrow(/bogus/);
    });
  });

  describe('roundRobinRouter', () => {
    it('cycles through roles in order', async () => {
      const router = roundRobinRouter();
      const sequence = [];
      for (let index = 0; index < 5; index += 1) {
        sequence.push(await router.pick({ roles, state: {}, turn: { turn_count: index, history: [] } }));
      }
      expect(sequence).toEqual(['planner', 'critic', 'writer', 'planner', 'critic']);
    });
  });

  describe('llmRouter', () => {
    it('asks the routing agent and returns its choice', async () => {
      const callAgent = vi.fn(async () => ({ content: '{"next_agent":"critic"}' }));
      const router = llmRouter({ name: 'router', callAgent });
      const choice = await router.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } });
      expect(choice).toBe('critic');
    });

    it('returns null when routing agent says stop', async () => {
      const callAgent = vi.fn(async () => ({ content: '{"next_agent":null, "reason":"done"}' }));
      const router = llmRouter({ name: 'router', callAgent });
      const choice = await router.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } });
      expect(choice).toBeNull();
    });

    it('malformed router response returns null + logs warning', async () => {
      const callAgent = vi.fn(async () => ({ content: 'not json' }));
      const logger = { warn: vi.fn() };
      const router = llmRouter({ name: 'router', callAgent, logger });
      const choice = await router.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } });
      expect(choice).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('hybridRouter', () => {
    it('shortlist narrows to 1 -> returns that agent without consulting LLM', async () => {
      const chooser = vi.fn(async () => ({ content: '{"next_agent":"writer"}' }));
      const router = hybridRouter({
        shortlist: () => ['planner'],
        chooser: { callAgent: chooser },
      });
      const choice = await router.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } });
      expect(choice).toBe('planner');
      expect(chooser).not.toHaveBeenCalled();
    });

    it('shortlist has multiple -> chooser picks among them', async () => {
      const chooser = vi.fn(async () => ({ content: '{"next_agent":"critic"}' }));
      const router = hybridRouter({
        shortlist: () => ['critic', 'writer'],
        chooser: { callAgent: chooser },
      });
      const choice = await router.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } });
      expect(choice).toBe('critic');
      expect(chooser).toHaveBeenCalled();
    });

    it('shortlist empty -> stop', async () => {
      const router = hybridRouter({ shortlist: () => [], chooser: { callAgent: vi.fn() } });
      expect(await router.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } })).toBeNull();
    });
  });
});
