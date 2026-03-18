'use strict';

const path = require('path');
const { FILE_SIZE_TRUNCATION_THRESHOLD } = require('../constants');
const logger = require('../logger').child({ component: 'schema' });
const { safeAddColumn } = require('../database');
const { createTables } = require('./schema-tables');
const { seedDefaults } = require('./schema-seeds');
const { runMigrations } = require('./schema-migrations');

function applyPolicyOverrideTrackingSchema(db, safeAddColumn) {
  safeAddColumn('policy_overrides', 'task_id TEXT');
  safeAddColumn('policy_overrides', 'reason TEXT');
  safeAddColumn('policy_overrides', "overridden_by TEXT DEFAULT 'operator'");

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_policy_overrides_policy_id ON policy_overrides(policy_id)');
  } catch (e) {
    logger.debug(`Schema migration (policy_overrides policy_id index): ${e.message}`);
  }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_policy_overrides_created ON policy_overrides(created_at)');
  } catch (e) {
    logger.debug(`Schema migration (policy_overrides created_at index): ${e.message}`);
  }
}

function resolveSafeAddColumn(db, injectedSafeAddColumn) {
  if (typeof injectedSafeAddColumn === 'function') {
    return injectedSafeAddColumn;
  }

  return (tableName, columnDef) => safeAddColumn(tableName, columnDef);
}

function applySchema(db, helpers = {}) {
  const {
    safeAddColumn: injectedSafeAddColumn,
    getConfig,
    setConfig,
    setConfigDefault,
    DATA_DIR = path.join(process.cwd(), '.local', 'share', 'torque'),
  } = helpers;

  const resolvedSafeAddColumn = resolveSafeAddColumn(db, injectedSafeAddColumn);
  createTables(db, logger);
  applyPolicyOverrideTrackingSchema(db, resolvedSafeAddColumn);
  runMigrations(db, logger, resolvedSafeAddColumn, {
    getConfig,
    setConfig,
    setConfigDefault,
  });
  seedDefaults(db, logger, resolvedSafeAddColumn, {
    DATA_DIR,
    truncationThreshold: Math.abs(FILE_SIZE_TRUNCATION_THRESHOLD),
    setConfigDefault,
    getConfig,
    setConfig,
  });
}

module.exports = { applySchema };
