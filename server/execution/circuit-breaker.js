'use strict';

const FAILURE_THRESHOLD = 3;
const BASE_RECOVERY_MS = 60_000;
const MAX_RECOVERY_MS = 600_000;
const BACKOFF_MULTIPLIER = 2;

const STATES = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

const FAILURE_PATTERNS = Object.freeze({
  connectivity: /(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connection refused|DNS resolution)/i,
  rate_limit: /\b(429|too many requests|rate limit|overloaded|capacity)\b/i,
  auth: /\b(401|403|unauthorized|forbidden)\b/i,
  resource: /(out of memory|\bOOM\b|disk full|no space left)/i,
});

function normalizeProvider(provider) {
  if (typeof provider !== 'string') {
    throw new TypeError('provider must be a non-empty string');
  }

  const normalized = provider.trim();
  if (!normalized) {
    throw new TypeError('provider must be a non-empty string');
  }

  return normalized;
}

function classifyFailure(errorOutput) {
  const message = typeof errorOutput === 'string'
    ? errorOutput
    : errorOutput == null
      ? ''
      : String(errorOutput);

  for (const [category, pattern] of Object.entries(FAILURE_PATTERNS)) {
    if (pattern.test(message)) {
      return category;
    }
  }

  return 'unknown';
}

function createProviderState() {
  return {
    state: STATES.CLOSED,
    consecutiveFailures: 0,
    lastCategory: null,
    trippedAt: null,
    recoveryTimeoutMs: BASE_RECOVERY_MS,
    totalTrips: 0,
  };
}

class CircuitBreaker {
  constructor() {
    this._providers = new Map();
  }

  _getOrCreateProviderState(provider) {
    const normalizedProvider = normalizeProvider(provider);

    if (!this._providers.has(normalizedProvider)) {
      this._providers.set(normalizedProvider, createProviderState());
    }

    return {
      provider: normalizedProvider,
      entry: this._providers.get(normalizedProvider),
    };
  }

  _tripOpen(entry) {
    entry.recoveryTimeoutMs = entry.totalTrips === 0
      ? BASE_RECOVERY_MS
      : Math.min(entry.recoveryTimeoutMs * BACKOFF_MULTIPLIER, MAX_RECOVERY_MS);
    entry.totalTrips += 1;
    entry.state = STATES.OPEN;
    entry.trippedAt = Date.now();
  }

  recordSuccess(provider) {
    const { entry } = this._getOrCreateProviderState(provider);

    entry.state = STATES.CLOSED;
    entry.consecutiveFailures = 0;
    entry.lastCategory = null;
    entry.trippedAt = null;

    return this.getState(provider);
  }

  recordFailure(provider, errorOutput) {
    const { entry } = this._getOrCreateProviderState(provider);
    const category = classifyFailure(errorOutput);
    const isHalfOpenProbeFailure = entry.state === STATES.HALF_OPEN;

    entry.consecutiveFailures = entry.lastCategory === category
      ? entry.consecutiveFailures + 1
      : 1;
    entry.lastCategory = category;

    if (isHalfOpenProbeFailure || entry.consecutiveFailures >= FAILURE_THRESHOLD) {
      this._tripOpen(entry);
    }

    return this.getState(provider);
  }

  allowRequest(provider) {
    const { entry } = this._getOrCreateProviderState(provider);

    if (entry.state === STATES.CLOSED) {
      return true;
    }

    if (entry.state === STATES.HALF_OPEN) {
      return false;
    }

    const trippedAt = typeof entry.trippedAt === 'number' ? entry.trippedAt : Date.now();
    const elapsedMs = Date.now() - trippedAt;

    if (elapsedMs >= entry.recoveryTimeoutMs) {
      entry.state = STATES.HALF_OPEN;
      return true;
    }

    return false;
  }

  getState(provider) {
    const { entry } = this._getOrCreateProviderState(provider);

    return {
      state: entry.state,
      consecutiveFailures: entry.consecutiveFailures,
      lastFailureCategory: entry.lastCategory,
      trippedAt: entry.trippedAt,
      recoveryTimeoutMs: entry.recoveryTimeoutMs,
    };
  }

  getAllOpenCircuits() {
    return Array.from(this._providers.entries())
      .filter(([, entry]) => entry.state !== STATES.CLOSED)
      .map(([provider]) => provider);
  }

  _reset() {
    this._providers.clear();
  }
}

const circuitBreaker = new CircuitBreaker();

module.exports = circuitBreaker;
module.exports.CircuitBreaker = CircuitBreaker;
module.exports.classifyFailure = classifyFailure;
module.exports.STATES = STATES;
module.exports.FAILURE_THRESHOLD = FAILURE_THRESHOLD;
module.exports.BASE_RECOVERY_MS = BASE_RECOVERY_MS;
module.exports.MAX_RECOVERY_MS = MAX_RECOVERY_MS;
module.exports.BACKOFF_MULTIPLIER = BACKOFF_MULTIPLIER;
module.exports._testing = {
  createProviderState,
  normalizeProvider,
};
