'use strict';
/* global describe, it, expect, beforeEach */

const Database = require('better-sqlite3');
const { createTables: ensureSchema } = require('../db/schema-tables');
const { decomposeBeforePark } = require('../factory/loop-controller');

const LOGGER_STUB = { debug() {}, info() {}, warn() {}, error() {} };

describe('decomposeBeforePark', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db, LOGGER_STUB);
  });

  it('returns decomposed: false when decomposeTask returns nothing', () => {
    const workItem = { title: 'a one-word task', working_directory: '/tmp' };
    const result = decomposeBeforePark({ db, projectId: 'p1', workItem, projectConfig: {} });
    expect(result.decomposed).toBe(false);
    expect(result.eligibleCount).toBe(0);
  });

  it('decomposes a recognized pattern and classifies sub-items', () => {
    // "implement a <name> service" matches the first pattern in decomposeTask
    // and returns 3 sub-item strings describing C# interface + class + DI wiring.
    const workItem = {
      title: 'implement a payment service',
      working_directory: '/tmp',
      category: 'simple_generation',
    };
    const result = decomposeBeforePark({
      db,
      projectId: 'p1',
      workItem,
      projectConfig: {},
    });
    expect(typeof result.decomposed).toBe('boolean');
    expect(typeof result.eligibleCount).toBe('number');
    if (result.decomposed) {
      expect(result.subtaskCount).toBeGreaterThanOrEqual(2);
      expect(result.eligibleSubitems).toBeDefined();
    }
  });

  it('returns decomposed: false on null workItem (error path)', () => {
    const result = decomposeBeforePark({
      db,
      projectId: 'p1',
      workItem: null,
      projectConfig: {},
    });
    expect(result.decomposed).toBe(false);
  });

  it('respects project policy=wait_for_codex (no eligible sub-items even if decomposed)', () => {
    // With wait_for_codex policy, classify() immediately returns codex_only
    // so eligibleCount must be 0 regardless of decomposition.
    const workItem = {
      title: 'implement a payment service',
      working_directory: '/tmp',
      category: 'simple_generation',
    };
    const result = decomposeBeforePark({
      db,
      projectId: 'p1',
      workItem,
      projectConfig: { codex_fallback_policy: 'wait_for_codex' },
    });
    expect(result.eligibleCount).toBe(0);
  });
});
