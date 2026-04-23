'use strict';

const { setupTestDbOnly, teardownTestDb, resetTables } = require('./vitest-setup');
const { createSpecialistStorage } = require('../routing/specialist-storage');

describe('specialist-storage', () => {
  let dbModule;
  let db;
  let storage;

  beforeAll(() => {
    ({ db: dbModule } = setupTestDbOnly('specialist-storage'));
  });

  beforeEach(() => {
    resetTables('specialist_chat_history');
    db = dbModule.getDbInstance();
    storage = createSpecialistStorage({ db });
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('append + readSpecialist isolates per-agent transcripts', () => {
    storage.append({ user_id: 'u1', session_id: 's1', agent_id: 'billing', role: 'user', content: 'refund' });
    storage.append({ user_id: 'u1', session_id: 's1', agent_id: 'support', role: 'user', content: 'login issue' });

    expect(storage.readSpecialist({ user_id: 'u1', session_id: 's1', agent_id: 'billing' })).toHaveLength(1);
    expect(storage.readSpecialist({ user_id: 'u1', session_id: 's1', agent_id: 'support' })[0].content).toBe('login issue');
  });

  it('readGlobal returns cross-agent history for a session in order', () => {
    storage.append({ user_id: 'u1', session_id: 's1', agent_id: 'billing', role: 'user', content: 'a' });
    storage.append({ user_id: 'u1', session_id: 's1', agent_id: 'support', role: 'user', content: 'b' });

    const global = storage.readGlobal({ user_id: 'u1', session_id: 's1' });

    expect(global.map((message) => message.content)).toEqual(['a', 'b']);
  });

  it('readGlobal is scoped to the session (does not leak other sessions)', () => {
    storage.append({ user_id: 'u1', session_id: 's1', agent_id: 'billing', role: 'user', content: 'here' });
    storage.append({ user_id: 'u1', session_id: 's2', agent_id: 'billing', role: 'user', content: 'there' });

    const global = storage.readGlobal({ user_id: 'u1', session_id: 's1' });

    expect(global.map((message) => message.content)).toEqual(['here']);
  });
});
