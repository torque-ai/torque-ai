'use strict';

const SNAPSHOT_PLANNED_RESPONSE = Object.freeze({
  success: false,
  error: 'Snapshot requires platform accessibility API — coming in a future release',
  phase: 'planned',
});

function createSnapshotHandler() {
  return async function handleSnapshot(ctx) {
    return ctx.json(501, { ...SNAPSHOT_PLANNED_RESPONSE });
  };
}

module.exports = {
  SNAPSHOT_PLANNED_RESPONSE,
  createSnapshotHandler,
};
