"use strict";

const STATES = {
  CLOSED: "CLOSED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF_OPEN",
};

const DEFAULT_CONFIG = {
  threshold: 3,
  baseRecoveryTimeoutMs: 60000,
  maxRecoveryTimeoutMs: 600000,
  backoffMultiplier: 2,
};

const FAILURE_PATTERNS = {
  connectivity: /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|DNS|connection refused|connect ECONNREFUSED)\b/i,
  rate_limit: /\b(429|too many requests|rate limit|overloaded|capacity)\b/i,
  auth: /\b(401|403|unauthorized|forbidden|invalid.*key|authentication)\b/i,
  resource: /(out of memory|OOM|disk full|GPU|CUDA|no space)/i,
};

const ERROR_CODE_TO_CATEGORY = {
  quota_exceeded: 'rate_limit',
  rate_limit: 'rate_limit',
  auth_failed: 'auth',
};

const SENTINEL_EXIT_CODES = new Set([-101, -102, -103]);

function createNoopEventBus() {
  return { emit() {} };
}

function normalizeProvider(provider) {
  if (typeof provider !== "string") {
    throw new TypeError("provider must be a non-empty string");
  }

  const normalized = provider.trim();
  if (!normalized) {
    throw new TypeError("provider must be a non-empty string");
  }

  return normalized;
}

function classifyFailure(errorOutput) {
  const message = typeof errorOutput === "string"
    ? errorOutput
    : errorOutput == null
      ? ""
      : String(errorOutput);

  for (const [category, pattern] of Object.entries(FAILURE_PATTERNS)) {
    if (pattern.test(message)) {
      return category;
    }
  }

  return "unknown";
}

function createProviderState(baseRecoveryTimeoutMs) {
  return {
    state: STATES.CLOSED,
    consecutiveFailures: 0,
    lastFailureCategory: null,
    trippedAt: null,
    recoveryTimeoutMs: baseRecoveryTimeoutMs,
    currentProbeAllowed: false,
  };
}

class CircuitBreaker {
  constructor({ eventBus, config, store }) {
    this._eventBus = eventBus || createNoopEventBus();
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._providers = new Map();
    this._store = store || null;

    if (this._store && typeof this._store.listAll === 'function') {
      for (const row of this._store.listAll()) {
        const entry = createProviderState(this._config.baseRecoveryTimeoutMs);
        entry.state = row.state;
        entry.trippedAt = row.tripped_at ? new Date(row.tripped_at).getTime() : null;
        // consecutiveFailures intentionally not persisted — counter resets on restart.
        this._providers.set(row.provider_id, entry);
      }
    }
  }

  _getStateEntry(provider) {
    const normalizedProvider = normalizeProvider(provider);
    if (!this._providers.has(normalizedProvider)) {
      this._providers.set(normalizedProvider, createProviderState(this._config.baseRecoveryTimeoutMs));
    }

    return this._providers.get(normalizedProvider);
  }

  _emit(event, payload) {
    if (typeof this._eventBus?.emit === "function") {
      this._eventBus.emit(event, payload);
    }
  }

  _persist(provider, patch) {
    if (!this._store) return;
    try {
      this._store.persist(provider, patch);
    } catch (err) {
      // Persistence errors must not break the breaker, but they should be visible.
      console.error('[circuit-breaker] persist failed for', provider, err.message);
    }
  }

  _maybeTransitionToHalfOpen(provider, entry) {
    if (entry.state !== STATES.OPEN) {
      return;
    }

    const now = Date.now();
    const elapsedMs = now - entry.trippedAt;
    if (elapsedMs >= entry.recoveryTimeoutMs) {
      entry.state = STATES.HALF_OPEN;
      entry.currentProbeAllowed = false;
      this._emit("circuit:recovered", { provider });
    }
  }

  _tripCircuit(provider, entry, category) {
    const { baseRecoveryTimeoutMs, maxRecoveryTimeoutMs, backoffMultiplier } = this._config;
    const shouldBackoff = entry.state === STATES.HALF_OPEN;
    const nextTimeout = shouldBackoff
      ? Math.min(entry.recoveryTimeoutMs * backoffMultiplier, maxRecoveryTimeoutMs)
      : baseRecoveryTimeoutMs;

    entry.state = STATES.OPEN;
    entry.recoveryTimeoutMs = nextTimeout;
    entry.trippedAt = Date.now();
    entry.currentProbeAllowed = false;

    this._emit("circuit:tripped", {
      provider,
      category,
      consecutiveFailures: entry.consecutiveFailures,
      recoveryTimeoutMs: entry.recoveryTimeoutMs,
    });

    this._persist(provider, {
      state: 'OPEN',
      trippedAt: new Date(entry.trippedAt).toISOString(),
    });
  }

  recordSuccess(provider) {
    const normalizedProvider = normalizeProvider(provider);
    const entry = this._getStateEntry(normalizedProvider);
    const wasHalfOpen = entry.state === STATES.HALF_OPEN;

    entry.state = STATES.CLOSED;
    entry.consecutiveFailures = 0;
    entry.lastFailureCategory = null;
    entry.trippedAt = null;
    entry.currentProbeAllowed = false;
    if (wasHalfOpen) {
      entry.recoveryTimeoutMs = this._config.baseRecoveryTimeoutMs;
      this._persist(normalizedProvider, {
        state: 'CLOSED',
        untrippedAt: new Date().toISOString(),
      });
    }

    return this.getState(normalizedProvider);
  }

  recordFailure(provider, errorOutput) {
    const category = classifyFailure(errorOutput);
    return this._recordFailureWithCategory(provider, category);
  }

  recordFailureByCode(provider, { errorCode, exitCode } = {}) {
    let category = 'unknown';
    if (errorCode && ERROR_CODE_TO_CATEGORY[errorCode]) {
      category = ERROR_CODE_TO_CATEGORY[errorCode];
    } else if (typeof exitCode === 'number' && SENTINEL_EXIT_CODES.has(exitCode)) {
      category = 'resource';
    }
    return this._recordFailureWithCategory(provider, category);
  }

  _recordFailureWithCategory(provider, category) {
    const normalizedProvider = normalizeProvider(provider);
    const entry = this._getStateEntry(normalizedProvider);
    this._maybeTransitionToHalfOpen(normalizedProvider, entry);

    entry.consecutiveFailures = entry.lastFailureCategory === category
      ? entry.consecutiveFailures + 1
      : 1;
    entry.lastFailureCategory = category;

    const shouldTrip = entry.state === STATES.HALF_OPEN || entry.consecutiveFailures >= this._config.threshold;
    if (shouldTrip) {
      this._tripCircuit(normalizedProvider, entry, category);
    }

    return this.getState(normalizedProvider);
  }

  isOpen(provider) {
    const normalizedProvider = normalizeProvider(provider);
    const entry = this._getStateEntry(normalizedProvider);
    this._maybeTransitionToHalfOpen(normalizedProvider, entry);

    return entry.state === STATES.OPEN;
  }

  isHalfOpen(provider) {
    const normalizedProvider = normalizeProvider(provider);
    const entry = this._getStateEntry(normalizedProvider);
    this._maybeTransitionToHalfOpen(normalizedProvider, entry);

    return entry.state === STATES.HALF_OPEN;
  }

  allowRequest(provider) {
    const normalizedProvider = normalizeProvider(provider);
    const entry = this._getStateEntry(normalizedProvider);

    if (entry.state === STATES.CLOSED) {
      return true;
    }

    this._maybeTransitionToHalfOpen(normalizedProvider, entry);

    if (entry.state !== STATES.HALF_OPEN) {
      return false;
    }

    if (entry.currentProbeAllowed) {
      return false;
    }

    entry.currentProbeAllowed = true;
    return true;
  }

  getState(provider) {
    const normalizedProvider = normalizeProvider(provider);
    const entry = this._getStateEntry(normalizedProvider);
    this._maybeTransitionToHalfOpen(normalizedProvider, entry);

    return {
      state: entry.state,
      consecutiveFailures: entry.consecutiveFailures,
      lastFailureCategory: entry.lastFailureCategory,
      trippedAt: entry.trippedAt,
      recoveryTimeoutMs: entry.recoveryTimeoutMs,
      currentProbeAllowed: entry.currentProbeAllowed,
    };
  }

  getAllStates() {
    const result = {};
    for (const [provider, entry] of this._providers.entries()) {
      if (entry.state === STATES.CLOSED) {
        continue;
      }

      this._maybeTransitionToHalfOpen(provider, entry);
      if (entry.state === STATES.CLOSED) {
        continue;
      }

      result[provider] = {
        state: entry.state,
        consecutiveFailures: entry.consecutiveFailures,
        lastFailureCategory: entry.lastFailureCategory,
        trippedAt: entry.trippedAt,
        recoveryTimeoutMs: entry.recoveryTimeoutMs,
        currentProbeAllowed: entry.currentProbeAllowed,
      };
    }

    return result;
  }

  trip(provider, reason) {
    const normalizedProvider = normalizeProvider(provider);
    const entry = this._getStateEntry(normalizedProvider);
    entry.state = STATES.OPEN;
    entry.trippedAt = Date.now();
    entry.lastFailureCategory = entry.lastFailureCategory || 'manual';
    this._emit('circuit:tripped', {
      provider: normalizedProvider,
      category: entry.lastFailureCategory,
      consecutiveFailures: entry.consecutiveFailures,
      recoveryTimeoutMs: entry.recoveryTimeoutMs,
      reason: reason || 'manual',
    });
    this._persist(normalizedProvider, {
      state: 'OPEN',
      trippedAt: new Date(entry.trippedAt).toISOString(),
      tripReason: reason || 'manual',
    });
  }

  untrip(provider, reason) {
    const normalizedProvider = normalizeProvider(provider);
    const entry = this._getStateEntry(normalizedProvider);
    entry.state = STATES.CLOSED;
    entry.consecutiveFailures = 0;
    entry.lastFailureCategory = null;
    entry.recoveryTimeoutMs = this._config.baseRecoveryTimeoutMs;
    entry.currentProbeAllowed = false;
    entry.trippedAt = null;
    this._emit('circuit:recovered', {
      provider: normalizedProvider,
      reason: reason || 'manual',
    });
    this._persist(normalizedProvider, {
      state: 'CLOSED',
      untrippedAt: new Date().toISOString(),
    });
  }
}

function createCircuitBreaker({ eventBus, config, store } = {}) {
  return new CircuitBreaker({ eventBus, config, store });
}

module.exports = { createCircuitBreaker, classifyFailure, STATES };
