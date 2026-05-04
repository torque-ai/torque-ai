'use strict';

/**
 * tasks/free-quota-tracker-singleton.js — lazy singleton for the
 * shared FreeQuotaTracker instance.
 *
 * The free-tier rate limits for each cloud provider live here in a
 * frozen default table; per-provider overrides from the database
 * (db.getProviderRateLimits) are merged on top at first use. The
 * singleton is wired to db.recordDailySnapshot so quota windows
 * persist across server restarts.
 *
 * Extracted from task-manager.js so the data table and the lazy
 * resolution path don't clutter the composition root.
 *
 * Concurrency note: Node.js is single-threaded, so the
 *   if (!_tracker) ...
 * check is race-free under the event loop. If this function were
 * ever called from worker threads, the check would not be atomic
 * and a mutex would be needed.
 */

const FreeQuotaTracker = require('../free-quota-tracker');

const DEFAULT_FREE_PROVIDER_RATE_LIMITS = Object.freeze([
  { provider: 'groq', rpm_limit: 30, rpd_limit: 14400, tpm_limit: 6000, tpd_limit: 500000, daily_reset_hour: 0, daily_reset_tz: 'UTC' },
  { provider: 'cerebras', rpm_limit: 30, rpd_limit: 14400, tpm_limit: 64000, tpd_limit: 1000000, daily_reset_hour: 0, daily_reset_tz: 'UTC' },
  { provider: 'google-ai', rpm_limit: 10, rpd_limit: 250, tpm_limit: 250000, tpd_limit: null, daily_reset_hour: 0, daily_reset_tz: 'America/Los_Angeles' },
  { provider: 'openrouter', rpm_limit: 20, rpd_limit: 50, tpm_limit: null, tpd_limit: null, daily_reset_hour: 0, daily_reset_tz: 'UTC' },
  { provider: 'ollama-cloud', rpm_limit: 10, rpd_limit: 500, tpm_limit: 100000, tpd_limit: null, daily_reset_hour: 0, daily_reset_tz: 'UTC' },
  { provider: 'ollama', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, daily_reset_hour: 0, daily_reset_tz: 'UTC' },
]);

function mergeDefaultFreeProviderRateLimits(limits = []) {
  const byProvider = new Map();
  for (const limit of DEFAULT_FREE_PROVIDER_RATE_LIMITS) {
    byProvider.set(limit.provider, { ...limit, is_free_tier: 1 });
  }
  for (const limit of Array.isArray(limits) ? limits : []) {
    if (!limit?.provider) continue;
    byProvider.set(limit.provider, { ...byProvider.get(limit.provider), ...limit, is_free_tier: 1 });
  }
  return Array.from(byProvider.values());
}

let _db = null;
let _tracker = null;

function init({ db }) {
  _db = db;
}

function getFreeQuotaTracker() {
  if (!_tracker) {
    if (!_db) {
      throw new Error('free-quota-tracker-singleton: init({ db }) must be called before getFreeQuotaTracker()');
    }
    const limits = mergeDefaultFreeProviderRateLimits(
      _db.getProviderRateLimits ? _db.getProviderRateLimits() : []
    );
    _tracker = new FreeQuotaTracker(limits);
    if (_db.recordDailySnapshot) {
      _tracker.setDb(_db);
    }
  }
  return _tracker;
}

// Test helper — release the cached tracker so the next call rebuilds it.
function _resetForTest() {
  _tracker = null;
}

module.exports = {
  init,
  getFreeQuotaTracker,
  mergeDefaultFreeProviderRateLimits,
  DEFAULT_FREE_PROVIDER_RATE_LIMITS,
  _resetForTest,
};
