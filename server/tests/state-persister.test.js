'use strict';

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

  it('throws CORRUPT_SNAPSHOT with snapshot identifiers when state_json is malformed', () => {
    // Bypass the persister and inject a row with corrupted state_json,
    // simulating partial-write or storage-corruption scenarios. Without
    // the safeParseJson wrapper, JSON.parse throws a bare SyntaxError
    // that surfaces through MCP handlers as INVALID_PARAM — the wrong
    // error class for "snapshot on disk is bad".
    const dbHandle = db.getDbInstance();
    dbHandle.prepare(`
      INSERT INTO action_state_snapshots
        (app_id, partition_key, sequence_id, action_name, state_json, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('corrupt-app', '', 0, 'init', '{not valid json', null, Date.now());

    let caught = null;
    try {
      p.loadLatest({ app_id: 'corrupt-app' });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('CORRUPT_SNAPSHOT');
    expect(caught.app_id).toBe('corrupt-app');
    expect(caught.sequence_id).toBe(0);
    expect(caught.message).toMatch(/state_json/);
  });

  it('throws CORRUPT_SNAPSHOT when result_json is malformed but state_json is fine', () => {
    const dbHandle = db.getDbInstance();
    dbHandle.prepare(`
      INSERT INTO action_state_snapshots
        (app_id, partition_key, sequence_id, action_name, state_json, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('half-corrupt', '', 0, 'init', '{}', '{also broken', Date.now());

    let caught = null;
    try {
      p.loadAt({ app_id: 'half-corrupt', sequence_id: 0 });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('CORRUPT_SNAPSHOT');
    expect(caught.message).toMatch(/result_json/);
  });
});
