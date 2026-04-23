'use strict';

const { afterEach, beforeEach, describe, expect, it } = require('vitest');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { createStatePersister } = require('../actions/state-persister');

describe('statePersister', () => {
  let db;
  let p;

  beforeEach(() => {
    ({ db } = setupTestDbOnly('state-persister'));
    p = createStatePersister({ db: db.getDbInstance() });
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('save + load latest', () => {
    p.save({ app_id: 'app1', sequence_id: 0, action_name: 'init', state: { a: 1 } });
    p.save({ app_id: 'app1', sequence_id: 1, action_name: 'bump', state: { a: 2 } });

    const latest = p.loadLatest({ app_id: 'app1' });

    expect(latest.sequence_id).toBe(1);
    expect(latest.state).toEqual({ a: 2 });
  });

  it('loadAt retrieves a specific sequence', () => {
    p.save({ app_id: 'app1', sequence_id: 0, action_name: 'init', state: { a: 1 } });
    p.save({ app_id: 'app1', sequence_id: 1, action_name: 'bump', state: { a: 2 } });

    expect(p.loadAt({ app_id: 'app1', sequence_id: 0 }).state).toEqual({ a: 1 });
  });

  it('history returns ordered list', () => {
    p.save({ app_id: 'a', sequence_id: 0, action_name: 'x', state: {} });
    p.save({ app_id: 'a', sequence_id: 1, action_name: 'y', state: {} });

    expect(p.history({ app_id: 'a' }).map(h => h.action_name)).toEqual(['x', 'y']);
  });
});
