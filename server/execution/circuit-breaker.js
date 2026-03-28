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
  constructor({ eventBus, config }) {
    this._eventBus = eventBus || createNoopEventBus();
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._providers = new Map();
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
    }

    return this.getState(normalizedProvider);
  }

  recordFailure(provider, errorOutput) {
    const normalizedProvider = normalizeProvider(provider);
    const entry = this._getStateEntry(normalizedProvider);
    this._maybeTransitionToHalfOpen(normalizedProvider, entry);

    const category = classifyFailure(errorOutput);
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
}

function createCircuitBreaker({ eventBus, config } = {}) {
  return new CircuitBreaker({ eventBus, config });
}

module.exports = { createCircuitBreaker, classifyFailure, STATES };
