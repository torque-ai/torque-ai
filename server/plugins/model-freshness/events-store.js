'use strict';

const EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS model_freshness_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    family TEXT NOT NULL,
    tag TEXT NOT NULL,
    old_digest TEXT,
    new_digest TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    acknowledged_at TEXT,
    acknowledged_by TEXT
  )
`;

function createEventsStore(db) {
  return {
    insert({ family, tag, oldDigest, newDigest }) {
      const res = db.prepare(
        'INSERT INTO model_freshness_events (family, tag, old_digest, new_digest, detected_at) VALUES (?, ?, ?, ?, ?)',
      ).run(family, tag, oldDigest, newDigest, new Date().toISOString());
      return res.lastInsertRowid;
    },

    getById(id) {
      return db.prepare('SELECT * FROM model_freshness_events WHERE id = ?').get(id);
    },

    listPending() {
      return db.prepare(
        'SELECT * FROM model_freshness_events WHERE acknowledged_at IS NULL ORDER BY detected_at DESC',
      ).all();
    },

    listAll() {
      return db.prepare('SELECT * FROM model_freshness_events ORDER BY detected_at DESC').all();
    },

    acknowledge(id, who) {
      db.prepare(
        'UPDATE model_freshness_events SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?',
      ).run(new Date().toISOString(), who, id);
    },
  };
}

module.exports = { createEventsStore, EVENTS_SCHEMA };
