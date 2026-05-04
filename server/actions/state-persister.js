'use strict';

function createStatePersister({ db }) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('statePersister: db with prepare() required');
  }

  const saveSnapshot = db.prepare(`
    INSERT INTO action_state_snapshots (
      app_id,
      partition_key,
      sequence_id,
      action_name,
      state_json,
      result_json,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const loadLatestSnapshot = db.prepare(`
    SELECT *
    FROM action_state_snapshots
    WHERE app_id = ? AND partition_key = ?
    ORDER BY sequence_id DESC
    LIMIT 1
  `);
  const loadSnapshotAt = db.prepare(`
    SELECT *
    FROM action_state_snapshots
    WHERE app_id = ? AND partition_key = ? AND sequence_id = ?
  `);
  const loadHistory = db.prepare(`
    SELECT *
    FROM action_state_snapshots
    WHERE app_id = ? AND partition_key = ?
    ORDER BY sequence_id ASC
  `);

  return {
    save({ app_id, partition_key = '', sequence_id, action_name, state, result = null }) {
      validateSnapshotInput({ app_id, partition_key, sequence_id, action_name, state });
      saveSnapshot.run(
        app_id,
        partition_key,
        sequence_id,
        action_name,
        JSON.stringify(state),
        result === null ? null : JSON.stringify(result),
        Date.now(),
      );
    },

    loadLatest({ app_id, partition_key = '' }) {
      validateAppLookup({ app_id, partition_key });
      const row = loadLatestSnapshot.get(app_id, partition_key);
      return row ? hydrate(row) : undefined;
    },

    loadAt({ app_id, partition_key = '', sequence_id }) {
      validateAppLookup({ app_id, partition_key });
      if (!Number.isInteger(sequence_id)) {
        throw new Error('statePersister: sequence_id integer required');
      }
      const row = loadSnapshotAt.get(app_id, partition_key, sequence_id);
      return row ? hydrate(row) : undefined;
    },

    history({ app_id, partition_key = '' }) {
      validateAppLookup({ app_id, partition_key });
      return loadHistory.all(app_id, partition_key).map(hydrate);
    },
  };
}

function validateSnapshotInput({ app_id, partition_key, sequence_id, action_name, state }) {
  validateAppLookup({ app_id, partition_key });
  if (!Number.isInteger(sequence_id)) {
    throw new Error('statePersister: sequence_id integer required');
  }
  if (!action_name || typeof action_name !== 'string') {
    throw new Error('statePersister: action_name string required');
  }
  if (state === undefined) {
    throw new Error('statePersister: state required');
  }
}

function validateAppLookup({ app_id, partition_key }) {
  if (!app_id || typeof app_id !== 'string') {
    throw new Error('statePersister: app_id string required');
  }
  if (typeof partition_key !== 'string') {
    throw new Error('statePersister: partition_key string required');
  }
}

function safeParseJson(value, fieldName, row) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    const e = new Error(
      `statePersister: corrupt ${fieldName} for app_id=${row.app_id} `
      + `partition_key=${row.partition_key} sequence_id=${row.sequence_id}: ${err.message}`,
    );
    e.code = 'CORRUPT_SNAPSHOT';
    e.app_id = row.app_id;
    e.partition_key = row.partition_key;
    e.sequence_id = row.sequence_id;
    throw e;
  }
}

// hydrate may throw CORRUPT_SNAPSHOT if a snapshot row's state_json or
// result_json is malformed (storage corruption, partial write before a
// crash, or a buggy writer landing pre-validation). The thrown error is
// labelled so callers can distinguish it from a generic JSON SyntaxError
// and surface a useful message ("snapshot corrupted") rather than the
// raw `Unexpected token … in JSON at position …`. Untrapped, the bare
// SyntaxError bubbles up through MCP handlers as INVALID_PARAM, which
// is misleading — there is no parameter problem; the row on disk is bad.
function hydrate(row) {
  return {
    app_id: row.app_id,
    partition_key: row.partition_key,
    sequence_id: row.sequence_id,
    action_name: row.action_name,
    state: safeParseJson(row.state_json, 'state_json', row),
    result: safeParseJson(row.result_json, 'result_json', row),
    created_at: row.created_at,
  };
}

module.exports = { createStatePersister };
