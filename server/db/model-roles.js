'use strict';

/**
 * server/db/model-roles.js — Maps provider+role pairs to model names.
 *
 * Replaces hardcoded model name references with a single DB-backed lookup.
 * Each provider can assign models to named roles (default, fallback, fast,
 * balanced, quality). getModelForRole walks a fallback chain so that, e.g.,
 * a 'fast' lookup falls through to 'default' when no fast-specific model
 * has been assigned.
 *
 * Usage:
 *   const { getModelForRole, setModelRole } = require('./db/model-roles');
 *   setModelRole('ollama', 'default', 'qwen2.5-coder:32b');
 *   getModelForRole('ollama', 'fast');  // → 'qwen2.5-coder:32b' (falls back to default)
 */

const logger = require('../logger').child({ component: 'model-roles' });

let db;

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_ROLES = ['default', 'fallback', 'fast', 'balanced', 'quality'];

/**
 * Fallback chains: when looking up a role, try each entry in order.
 * E.g. 'fast' → try 'fast', then 'default'.
 */
const ROLE_FALLBACK_CHAINS = {
  fast:     ['fast', 'default'],
  balanced: ['balanced', 'default'],
  quality:  ['quality', 'default'],
  default:  ['default'],
  fallback: ['fallback', 'default'],
};

// ── Internal ─────────────────────────────────────────────────────────────────

function setDb(instance) {
  db = instance;
}

function _validateRole(role) {
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`Invalid role '${role}'. Valid roles: ${VALID_ROLES.join(', ')}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up the model assigned to a provider+role, walking the fallback chain.
 *
 * @param {string} provider - Provider name (e.g. 'ollama', 'codex')
 * @param {string} role - Role name (e.g. 'fast', 'default')
 * @returns {string|null} Model name, or null if no assignment found
 */
function getModelForRole(provider, role) {
  _validateRole(role);
  const chain = ROLE_FALLBACK_CHAINS[role];
  const stmt = db.prepare(
    'SELECT model_name FROM model_roles WHERE provider = ? AND role = ?'
  );
  for (const candidate of chain) {
    const row = stmt.get(provider, candidate);
    if (row) {
      if (candidate !== role) {
        logger.debug(`model-roles: ${provider}/${role} fell back to ${candidate} → ${row.model_name}`);
      }
      return row.model_name;
    }
  }
  return null;
}

/**
 * Assign a model to a provider+role pair. Replaces any existing assignment.
 *
 * @param {string} provider - Provider name
 * @param {string} role - Role name
 * @param {string} modelName - Model name to assign
 */
function setModelRole(provider, role, modelName) {
  _validateRole(role);
  db.prepare(
    `INSERT OR REPLACE INTO model_roles (provider, role, model_name, updated_at)
     VALUES (?, ?, ?, datetime('now'))`
  ).run(provider, role, modelName);
  logger.info(`model-roles: set ${provider}/${role} → ${modelName}`);
}

/**
 * Remove a model assignment for a provider+role pair.
 *
 * @param {string} provider - Provider name
 * @param {string} role - Role name
 */
function clearModelRole(provider, role) {
  _validateRole(role);
  db.prepare(
    'DELETE FROM model_roles WHERE provider = ? AND role = ?'
  ).run(provider, role);
  logger.info(`model-roles: cleared ${provider}/${role}`);
}

/**
 * List all model role assignments, optionally filtered by provider.
 *
 * @param {string} [provider] - Optional provider to filter by
 * @returns {Array<{provider: string, role: string, model_name: string, updated_at: string}>}
 */
function listModelRoles(provider) {
  if (provider) {
    return db.prepare(
      'SELECT provider, role, model_name, updated_at FROM model_roles WHERE provider = ? ORDER BY role'
    ).all(provider);
  }
  return db.prepare(
    'SELECT provider, role, model_name, updated_at FROM model_roles ORDER BY provider, role'
  ).all();
}

// ── Factory (DI container) ───────────────────────────────────────────────────

function createModelRoles(deps) {
  if (deps?.db) db = deps.db;
  return { getModelForRole, setModelRole, clearModelRole, listModelRoles, VALID_ROLES };
}

module.exports = {
  setDb,
  getModelForRole,
  setModelRole,
  clearModelRole,
  listModelRoles,
  VALID_ROLES,
  ROLE_FALLBACK_CHAINS,
  createModelRoles,
};
