'use strict';

const { afterEach, beforeEach, describe, expect, it } = require('vitest');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { createAction } = require('../actions/action');
const { createApplication, fork } = require('../actions/application');
const { createStatePersister } = require('../actions/state-persister');

describe('application + fork', () => {
  let db;
  let persister;

  beforeEach(() => {
    ({ db } = setupTestDbOnly('application-fork'));
    persister = createStatePersister({ db: db.getDbInstance() });
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('persists + resumes from a sequence_id', async () => {
    const inc = createAction({
      name: 'inc',
      reads: ['n'],
      writes: ['n'],
      run: async (s) => ({ result: s.n + 1, patch: { n: (s.n || 0) + 1 } }),
    });
    const app = createApplication({
      actions: [inc],
      transitions: {},
      initialState: { n: 0 },
      persister,
      app_id: 'a1',
    });

    await app.step('inc');
    await app.step('inc');
    await app.step('inc');

    expect(app.getState().n).toBe(3);

    const branch = fork({
      app_id: 'a1',
      sequence_id: 0,
      persister,
      actions: [inc],
      transitions: {},
      new_app_id: 'b1',
    });
    await branch.step('inc');

    expect(branch.getState().n).toBe(2);
    expect(persister.loadLatest({ app_id: 'a1' }).state.n).toBe(3);
  });
});
