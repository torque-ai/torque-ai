'use strict';

/**
 * Provider Quota Store — in-memory rate limit tracking.
 *
 * Updated from two sources:
 * 1. Response headers (groq, cerebras, openrouter) — real-time, zero cost
 * 2. Task history inference (google-ai, deepinfra, etc.) — periodic estimate
 *
 * Consumed by: dashboard (GET /api/provider-quotas) and routing (isExhausted check).
 */

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseResetValue(value) {
  if (value === null || value === undefined) return null;

  const trimmed = String(value).trim();
  if (!trimmed) return null;

  if (/[a-z]/i.test(trimmed)) {
    const durationRegex = /(\d+)([hms])/gi;
    let totalMs = 0;
    let match;
    let consumed = 0;

    while ((match = durationRegex.exec(trimmed)) !== null) {
      const amount = Number.parseInt(match[1], 10);
      const unit = match[2].toLowerCase();
      consumed += match[0].length;

      if (!Number.isFinite(amount)) return null;
      if (unit === 'h') totalMs += amount * 60 * 60 * 1000;
      if (unit === 'm') totalMs += amount * 60 * 1000;
      if (unit === 's') totalMs += amount * 1000;
    }

    if (totalMs > 0 && consumed === trimmed.length) {
      return new Date(Date.now() + totalMs).toISOString();
    }
  }

  if ((trimmed.includes('T') || trimmed.includes('-')) && !Number.isNaN(Date.parse(trimmed))) {
    return trimmed;
  }

  if (/^\d{10,13}$/.test(trimmed)) {
    const epoch = Number.parseInt(trimmed, 10);
    const ms = trimmed.length === 13 ? epoch : epoch * 1000;
    return new Date(ms).toISOString();
  }

  return null;
}

function computeStatus(limits) {
  let worstPct = 100;
  let hasComputedLimit = false;

  for (const key of Object.keys(limits || {})) {
    const current = limits[key];
    if (!current) continue;

    const limit = parseNumber(current.limit);
    const remaining = parseNumber(current.remaining);

    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) {
      continue;
    }

    const pct = (remaining / limit) * 100;
    if (pct < worstPct) worstPct = pct;
    hasComputedLimit = true;
  }

  if (!hasComputedLimit) return 'green';
  if (worstPct < 10) return 'red';
  if (worstPct <= 50) return 'yellow';
  return 'green';
}

function createHeaderGetter(headers) {
  if (!headers) return () => null;

  if (typeof headers.get === 'function') {
    return (key) => headers.get(key);
  }

  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[String(key).toLowerCase()] = value;
  }

  return (key) => normalized[String(key).toLowerCase()];
}

function createQuotaStore() {
  const quotas = {};

  function ensureEntry(provider) {
    if (!quotas[provider]) {
      quotas[provider] = {
        provider,
        limits: {},
        status: 'green',
        cooldownUntil: null,
        lastUpdated: null,
        source: null,
      };
    }
    return quotas[provider];
  }

  function updateFromHeaders(provider, headers) {
    if (!provider || !headers) return;

    const get = createHeaderGetter(headers);
    const entry = ensureEntry(provider);

    const limitReq = parseNumber(get('x-ratelimit-limit-requests'));
    const remainReq = parseNumber(get('x-ratelimit-remaining-requests'));
    const resetReq = get('x-ratelimit-reset-requests') || get('x-ratelimit-reset');

    if (remainReq !== null) {
      if (!entry.limits.rpm) entry.limits.rpm = {};
      entry.limits.rpm.remaining = remainReq;
      if (limitReq !== null) entry.limits.rpm.limit = limitReq;

      const parsedReset = parseResetValue(resetReq);
      if (parsedReset) entry.limits.rpm.resetsAt = parsedReset;
    }

    const limitTok = parseNumber(get('x-ratelimit-limit-tokens'));
    const remainTok = parseNumber(get('x-ratelimit-remaining-tokens'));
    const resetTok = get('x-ratelimit-reset-tokens');

    if (remainTok !== null) {
      if (!entry.limits.tpm) entry.limits.tpm = {};
      entry.limits.tpm.remaining = remainTok;
      if (limitTok !== null) entry.limits.tpm.limit = limitTok;

      const parsedReset = parseResetValue(resetTok);
      if (parsedReset) entry.limits.tpm.resetsAt = parsedReset;
    }

    entry.lastUpdated = new Date().toISOString();
    entry.source = 'headers';
    entry.status = computeStatus(entry.limits);
  }

  function updateFromInference(provider, usage = {}, knownLimits = {}) {
    if (!provider) return;

    const entry = ensureEntry(provider);

    if (knownLimits.rpm != null && usage.tasksLastHour != null) {
      if (!entry.limits.rpm) entry.limits.rpm = {};
      entry.limits.rpm.limit = knownLimits.rpm;
      entry.limits.rpm.remaining = Math.max(0, knownLimits.rpm - usage.tasksLastHour);
    }

    if (knownLimits.tpd != null && usage.tokensLastHour != null) {
      if (!entry.limits.daily) entry.limits.daily = {};
      entry.limits.daily.limit = knownLimits.tpd;
      entry.limits.daily.remaining = Math.max(0, knownLimits.tpd - (usage.tokensLastHour * 24));
    }

    entry.lastUpdated = new Date().toISOString();
    entry.source = 'inference';
    entry.status = computeStatus(entry.limits);
  }

  // Default 429 cooldown. Long enough that a routing pass won't immediately
  // re-pick the same provider in a hot loop (which is what produced the
  // 21 ollama-cloud session-limit failures observed 2026-04-25/26), short
  // enough that a brief burst-rate trip recovers within a single retry
  // cadence. Callers (e.g., session-limit detection) can pass a longer
  // cooldownMs when the failure shape implies a longer wall-clock outage.
  const DEFAULT_COOLDOWN_MS = 60_000;

  function record429(provider, opts = {}) {
    if (!provider) return;

    const cooldownMs = Number.isFinite(opts.cooldownMs) && opts.cooldownMs > 0
      ? opts.cooldownMs
      : DEFAULT_COOLDOWN_MS;

    const entry = ensureEntry(provider);
    entry.status = 'red';
    entry.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
    entry.lastUpdated = new Date().toISOString();
    if (opts.reason) entry.cooldownReason = String(opts.reason);
  }

  function getQuota(provider) {
    return quotas[provider] || null;
  }

  function getAllQuotas() {
    return { ...quotas };
  }

  function isExhausted(provider) {
    const quota = quotas[provider];
    if (!quota) return false;

    // A live cooldown counts as exhausted for routing — a provider that
    // just returned 429 should be skipped until the window clears, even if
    // its `limits.remaining` counters look fine. Routing previously checked
    // only `limits.remaining`, so `record429` quietly did nothing useful
    // for selection (only the dashboard saw `status: 'red'`). Folding
    // cooldown into `isExhausted` makes one source of truth for "skip me."
    if (quota.cooldownUntil) {
      const cooldownUntil = new Date(quota.cooldownUntil).getTime();
      if (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) return true;
    }

    if (!quota.limits) return false;
    return Object.values(quota.limits).some((limit) => {
      const remaining = parseNumber(limit && limit.remaining);
      return remaining !== null && remaining <= 0;
    });
  }

  function isOnCooldown(provider) {
    const quota = quotas[provider];
    if (!quota || !quota.cooldownUntil) return false;

    const cooldownUntil = new Date(quota.cooldownUntil).getTime();
    return Number.isFinite(cooldownUntil) && cooldownUntil > Date.now();
  }

  return {
    updateFromHeaders,
    updateFromInference,
    record429,
    getQuota,
    getAllQuotas,
    isExhausted,
    isOnCooldown,
    _parseResetValue: parseResetValue,
    _computeStatus: computeStatus,
  };
}

let instance = null;

function getQuotaStore() {
  if (!instance) instance = createQuotaStore();
  return instance;
}

// ============================================================
// Factory function (dependency injection without singletons)
// ============================================================

function createProviderQuotas({ db: _dbInstance } = {}) {
  // provider-quotas is an in-memory store with no DB dependency;
  // the factory accepts { db } for interface consistency but ignores it.
  return module.exports;
}

module.exports = {
  createQuotaStore,
  getQuotaStore,
  createProviderQuotas,
};
