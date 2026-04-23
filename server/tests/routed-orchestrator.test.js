'use strict';

const { setupTestDbOnly, teardownTestDb, resetTables } = require('./vitest-setup');
const { createSpecialistStorage } = require('../routing/specialist-storage');
const { createTurnClassifier } = require('../routing/turn-classifier');
const { createRoutedOrchestrator } = require('../routing/routed-orchestrator');

describe('routed-orchestrator', () => {
  let dbModule;
  let db;
  let storage;
  let classifier;
  let agents;
  let orch;

  beforeAll(() => {
    ({ db: dbModule } = setupTestDbOnly('routed-orchestrator'));
  });

  beforeEach(() => {
    resetTables('specialist_chat_history');
    db = dbModule.getDbInstance();
    storage = createSpecialistStorage({ db });
    classifier = createTurnClassifier({ adapter: 'heuristic' });
    agents = {
      billing: { id: 'billing', description: 'refunds', respond: async () => 'billing responded' },
      support: { id: 'support', description: 'support', respond: async () => 'support responded' },
      fallback: { id: 'fallback', description: 'default', respond: async () => 'fallback responded' },
    };
    orch = createRoutedOrchestrator({ classifier, storage, agents, defaultAgent: 'fallback' });
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('routes a refund turn to billing and persists transcripts', async () => {
    const result = await orch.routeTurn({ user_id: 'u1', session_id: 's1', userInput: 'refund please' });

    expect(result.agent_id).toBe('billing');
    expect(result.response).toBe('billing responded');
    expect(storage.readSpecialist({ user_id: 'u1', session_id: 's1', agent_id: 'billing' })).toHaveLength(2);
    expect(storage.readGlobal({ user_id: 'u1', session_id: 's1' })).toHaveLength(2);
  });

  it('falls back to defaultAgent when classifier returns null', async () => {
    const result = await orch.routeTurn({ user_id: 'u1', session_id: 's1', userInput: 'qqq unrelated' });

    expect(result.agent_id).toBe('fallback');
    expect(result.response).toBe('fallback responded');
    expect(result.routed).toBe(false);
  });

  it('surfaces error from the selected specialist without breaking persistence', async () => {
    agents.billing.respond = async () => {
      throw new Error('boom');
    };

    await expect(orch.routeTurn({ user_id: 'u1', session_id: 's1', userInput: 'refund' })).rejects.toThrow('boom');
    expect(storage.readGlobal({ user_id: 'u1', session_id: 's1' }).length).toBeGreaterThanOrEqual(1);
  });
});
