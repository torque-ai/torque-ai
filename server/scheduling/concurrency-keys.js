'use strict';

const ACTIVE_STATES = ['running', 'queued'];

function assertDb(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createConcurrencyKeys requires a better-sqlite3 db handle');
  }
}

function normalizeKey(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeLimit(value) {
  const max = Number(value);
  if (!Number.isFinite(max) || !Number.isInteger(max) || max < 0) {
    throw new Error('max_concurrent must be a non-negative integer');
  }
  return max;
}

function createConcurrencyKeys({ db } = {}) {
  assertDb(db);

  function setLimit(pattern, maxConcurrent) {
    const keyPattern = normalizeKey(pattern);
    if (!keyPattern) {
      throw new Error('key_pattern is required');
    }
    const max = normalizeLimit(maxConcurrent);

    db.prepare(`
      INSERT INTO concurrency_limits (key_pattern, max_concurrent, updated_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(key_pattern) DO UPDATE SET
        max_concurrent = excluded.max_concurrent,
        updated_at = excluded.updated_at
    `).run(keyPattern, max);
  }

  function removeLimit(pattern) {
    const keyPattern = normalizeKey(pattern);
    if (!keyPattern) return;
    db.prepare('DELETE FROM concurrency_limits WHERE key_pattern = ?').run(keyPattern);
  }

  function listLimits() {
    return db.prepare('SELECT * FROM concurrency_limits ORDER BY key_pattern').all();
  }

  function resolveLimit(key) {
    const concurrencyKey = normalizeKey(key);
    if (!concurrencyKey) return null;

    const exact = db.prepare(
      'SELECT max_concurrent FROM concurrency_limits WHERE key_pattern = ?',
    ).get(concurrencyKey);
    if (exact) return exact.max_concurrent;

    const patterns = db.prepare(`
      SELECT key_pattern, max_concurrent
      FROM concurrency_limits
      WHERE key_pattern LIKE '%*'
      ORDER BY length(key_pattern) DESC, key_pattern ASC
    `).all();

    for (const pattern of patterns) {
      const prefix = pattern.key_pattern.slice(0, -1);
      if (concurrencyKey.startsWith(prefix)) {
        return pattern.max_concurrent;
      }
    }

    return null;
  }

  function countActive(key) {
    const concurrencyKey = normalizeKey(key);
    if (!concurrencyKey) return 0;

    const placeholders = ACTIVE_STATES.map(() => '?').join(',');
    const row = db.prepare(`
      SELECT COUNT(*) AS n
      FROM tasks
      WHERE concurrency_key = ?
        AND status IN (${placeholders})
    `).get(concurrencyKey, ...ACTIVE_STATES);

    return Number(row?.n || 0);
  }

  function canReserve(key) {
    const concurrencyKey = normalizeKey(key);
    if (!concurrencyKey) return true;

    const limit = resolveLimit(concurrencyKey);
    if (limit === null) return true;

    return countActive(concurrencyKey) < limit;
  }

  return { setLimit, removeLimit, listLimits, resolveLimit, countActive, canReserve };
}

module.exports = { createConcurrencyKeys };
