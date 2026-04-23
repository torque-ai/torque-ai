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

function hydrate(row) {
  return {
    app_id: row.app_id,
    partition_key: row.partition_key,
    sequence_id: row.sequence_id,
    action_name: row.action_name,
    state: JSON.parse(row.state_json),
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    created_at: row.created_at,
  };
}

module.exports = { createStatePersister };
