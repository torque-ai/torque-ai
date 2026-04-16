'use strict';

const { beforeEach, afterEach, describe, expect, it } = require('vitest');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { createConstructionCache } = require('../dispatch/construction-cache');

describe('constructionCache', () => {
  let db;
  let cache;

  beforeEach(() => {
    const setup = setupTestDbOnly('construction-cache');
    db = setup.db.getDbInstance();
    cache = createConstructionCache({ db });
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('learn stores a pattern to action template mapping', () => {
    cache.learn({
      utterance: 'cancel wf-1',
      normalizedTemplate: 'cancel wf-{id}',
      actionTemplate: { actionName: 'cancel', workflow_id: '{id}' },
      surface: 'workflow',
    });

    const row = db.prepare('SELECT COUNT(*) AS count FROM construction_cache').get();
    expect(row.count).toBe(1);
  });

  it('lookup finds a cached template match', () => {
    cache.learn({
      utterance: 'cancel wf-1',
      normalizedTemplate: 'cancel wf-{id}',
      actionTemplate: { actionName: 'cancel', workflow_id: '{id}' },
      surface: 'workflow',
    });

    const match = cache.lookup({ utterance: 'cancel wf-42', surface: 'workflow' });

    expect(match).toEqual({
      actionName: 'cancel',
      workflow_id: '42',
    });
  });

  it('lookup returns null when no pattern matches', () => {
    cache.learn({
      utterance: 'a',
      normalizedTemplate: 'foo',
      actionTemplate: {},
      surface: 'x',
    });

    expect(cache.lookup({ utterance: 'bar', surface: 'x' })).toBeNull();
  });

  it('lookup increments hit_count on cache hits', () => {
    cache.learn({
      utterance: 'x',
      normalizedTemplate: 'cancel wf-{id}',
      actionTemplate: { actionName: 'cancel', workflow_id: '{id}' },
      surface: 'workflow',
    });

    cache.lookup({ utterance: 'cancel wf-5', surface: 'workflow' });
    cache.lookup({ utterance: 'cancel wf-6', surface: 'workflow' });

    const row = db.prepare('SELECT hit_count FROM construction_cache').get();
    expect(row.hit_count).toBe(2);
  });
});
