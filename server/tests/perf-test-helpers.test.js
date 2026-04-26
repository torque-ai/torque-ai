'use strict';

/**
 * perf-test-helpers.test.js
 *
 * Shared helpers for performance regression tests.
 * Contains self-tests to verify the helpers work correctly.
 */

const Database = require('better-sqlite3');

/**
 * Wraps db.prepare with a counter, calls fn(), asserts the prepare count
 * is <= max, then restores the original. Returns the actual count.
 */
async function assertMaxPrepares(db, max, fn) {
  let count = 0;
  const original = db.prepare;
  db.prepare = function(...args) {
    count++;
    return original.apply(db, args);
  };
  try {
    await fn();
  } finally {
    db.prepare = original;
  }
  expect(count).toBeLessThanOrEqual(max);
  return count;
}

module.exports = { assertMaxPrepares };

// Self-tests
describe('assertMaxPrepares (self-test)', () => {
  it('counts prepare calls and passes when under limit', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const count = await assertMaxPrepares(db, 5, () => {
      db.prepare('SELECT 1').get();
      db.prepare('SELECT 2').get();
    });
    expect(count).toBe(2);
    db.close();
  });

  it('fails when prepare calls exceed limit', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await expect(
      assertMaxPrepares(db, 1, () => {
        db.prepare('SELECT 1').get();
        db.prepare('SELECT 2').get();
      })
    ).rejects.toThrow();
    db.close();
  });

  it('restores db.prepare even when fn throws', async () => {
    const db = new Database(':memory:');
    const originalPrepare = db.prepare;
    try {
      await assertMaxPrepares(db, 10, () => { throw new Error('boom'); });
    } catch (_e) {
      // expected
    }
    expect(db.prepare).toBe(originalPrepare);
    db.close();
  });
});
