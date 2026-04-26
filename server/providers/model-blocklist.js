'use strict';

/**
 * In-memory blocklist for (provider, model) pairs that have failed in a way
 * that suggests the model is not callable on the current key/tier — e.g.
 * `model_not_found`, `does not exist`, repeated 5xx with model name in the
 * error. Entries auto-expire so the model can be retried later (auto-discovery
 * may re-add it after a tier change, or the provider's transient error may
 * have cleared).
 *
 * Why in-memory:
 * - Auto-discovery already re-populates the model_registry on next probe, so
 *   persisting blocks across restarts could lock out models the user has
 *   genuinely fixed.
 * - The blocklist is a soft routing hint, not a permanent ban — the
 *   provider-quota patterns table is the persistent source of truth.
 * - Process restart is a natural reset: any operator concerned about
 *   stale blocks can `restart_server`.
 *
 * Public API:
 *   - recordFailure(provider, model, reason, ttlMs?)
 *   - isBlocked(provider, model)
 *   - clear()  // for tests
 *   - listBlocked()  // for diagnostics
 */

const logger = require('../logger');

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const FAILURE_THRESHOLD = 2; // mark unreachable after N failures within window

/** @type {Map<string, { firstFailureAt: number, count: number, blockedUntil: number, reason: string }>} */
const _state = new Map();

function _key(provider, model) {
  return `${String(provider || '').toLowerCase()}::${String(model || '').toLowerCase()}`;
}

function _now() { return Date.now(); }

function _purgeExpired() {
  const now = _now();
  for (const [k, v] of _state) {
    if (v.blockedUntil && v.blockedUntil < now) {
      _state.delete(k);
    }
  }
}

/**
 * Record a model-related failure for (provider, model). Increments the
 * counter; once FAILURE_THRESHOLD is reached the entry is marked blocked
 * for ttlMs milliseconds.
 *
 * @param {string} provider
 * @param {string} model
 * @param {string} [reason] - error message or classification for logs
 * @param {number} [ttlMs=DEFAULT_TTL_MS]
 * @returns {boolean} true if this call caused the entry to become blocked
 */
function recordFailure(provider, model, reason, ttlMs = DEFAULT_TTL_MS) {
  if (!provider || !model) return false;
  _purgeExpired();
  const k = _key(provider, model);
  const now = _now();
  const existing = _state.get(k);
  const entry = existing || { firstFailureAt: now, count: 0, blockedUntil: 0, reason: '' };
  entry.count += 1;
  entry.reason = reason ? String(reason).slice(0, 200) : (entry.reason || '');
  let newlyBlocked = false;
  if (entry.count >= FAILURE_THRESHOLD && !entry.blockedUntil) {
    entry.blockedUntil = now + ttlMs;
    newlyBlocked = true;
    logger.warn(`[ModelBlocklist] ${provider}/${model} marked unreachable for ${Math.round(ttlMs / 60000)}min after ${entry.count} failures: ${entry.reason}`);
  }
  _state.set(k, entry);
  return newlyBlocked;
}

/**
 * Returns true if (provider, model) is currently blocked.
 * @param {string} provider
 * @param {string} model
 * @returns {boolean}
 */
function isBlocked(provider, model) {
  if (!provider || !model) return false;
  _purgeExpired();
  const entry = _state.get(_key(provider, model));
  return !!(entry && entry.blockedUntil && entry.blockedUntil > _now());
}

/**
 * Clear all blocklist state. Test helper.
 */
function clear() {
  _state.clear();
}

/**
 * Snapshot of currently blocked entries — for diagnostics endpoints.
 * @returns {Array<{provider:string, model:string, blockedUntil:number, reason:string, count:number}>}
 */
function listBlocked() {
  _purgeExpired();
  const out = [];
  for (const [k, v] of _state) {
    if (v.blockedUntil > _now()) {
      const [provider, model] = k.split('::');
      out.push({ provider, model, blockedUntil: v.blockedUntil, reason: v.reason, count: v.count });
    }
  }
  return out;
}

module.exports = {
  recordFailure,
  isBlocked,
  clear,
  listBlocked,
  // Exported for tests/tuning:
  DEFAULT_TTL_MS,
  FAILURE_THRESHOLD,
};
