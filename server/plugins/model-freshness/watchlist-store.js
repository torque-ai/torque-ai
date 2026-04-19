'use strict';

const WATCHLIST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS model_watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    family TEXT NOT NULL,
    tag TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL,
    added_at TEXT NOT NULL,
    last_local_digest TEXT,
    last_scanned_at TEXT,
    UNIQUE(family, tag)
  )
`;

function createWatchlistStore(db) {
  return {
    add({ family, tag, source }) {
      const existing = db.prepare(
        'SELECT id FROM model_watchlist WHERE family = ? AND tag = ?',
      ).get(family, tag);
      if (existing) return existing.id;
      const res = db.prepare(
        'INSERT INTO model_watchlist (family, tag, active, source, added_at) VALUES (?, ?, 1, ?, ?)',
      ).run(family, tag, source, new Date().toISOString());
      return res.lastInsertRowid;
    },

    getByFamilyTag(family, tag) {
      return db.prepare(
        'SELECT * FROM model_watchlist WHERE family = ? AND tag = ?',
      ).get(family, tag);
    },

    listActive() {
      return db.prepare(
        'SELECT * FROM model_watchlist WHERE active = 1 ORDER BY family, tag',
      ).all();
    },

    listAll() {
      return db.prepare(
        'SELECT * FROM model_watchlist ORDER BY family, tag',
      ).all();
    },

    deactivate(family, tag) {
      db.prepare(
        'UPDATE model_watchlist SET active = 0 WHERE family = ? AND tag = ?',
      ).run(family, tag);
    },

    recordScan(family, tag, localDigest) {
      db.prepare(
        'UPDATE model_watchlist SET last_local_digest = ?, last_scanned_at = ? WHERE family = ? AND tag = ?',
      ).run(localDigest, new Date().toISOString(), family, tag);
    },
  };
}

module.exports = { createWatchlistStore, WATCHLIST_SCHEMA };
