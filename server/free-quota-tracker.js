const logger = require('./logger').child({ component: 'free-quota-tracker' });

const MINUTE_WINDOW_MS = 60 * 1000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BACKOFF_SECONDS = [30, 60, 120, 300];

// Smart routing constants
const LATENCY_RING_SIZE = 10;
const DEFAULT_LATENCY_MS = 5000;

// Tokens per character heuristic (GPT-style tokenizers average ~4 chars/token)
// We add a multiplier for prompt scaffolding + system prompt overhead
const CHARS_PER_TOKEN = 4;
const TOKEN_OVERHEAD_MULTIPLIER = 2.5; // task description is ~40% of total prompt

// Provider traits for complexity-aware routing
// speed: relative speed tier (higher = faster), tokenCapacity: relative token headroom tier (higher = more)
const PROVIDER_TRAITS = {
  groq:        { speed: 10, tokenCapacity: 4 },
  cerebras:    { speed: 9,  tokenCapacity: 5 },
  'google-ai': { speed: 6,  tokenCapacity: 9 },
  openrouter:  { speed: 5,  tokenCapacity: 10 },
  deepinfra:   { speed: 7,  tokenCapacity: 8 },
  hyperbolic:  { speed: 6,  tokenCapacity: 7 },
  anthropic:   { speed: 5,  tokenCapacity: 8 },
  'ollama-cloud': { speed: 4, tokenCapacity: 6 },
};

// Free providers are scan-only: they can read context-stuffed files but cannot produce code.
// Only these task types are allowed to route to free-tier providers.
const FREE_PROVIDER_SCAN_ONLY_TYPES = new Set(['scan', 'reasoning', 'docs']);

// Complexity → trait weight preferences
// Simple tasks favor speed, complex tasks favor token capacity
const COMPLEXITY_WEIGHTS = {
  simple:  { speedWeight: 0.7, capacityWeight: 0.3 },
  normal:  { speedWeight: 0.5, capacityWeight: 0.5 },
  complex: { speedWeight: 0.2, capacityWeight: 0.8 },
};

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeLimit(value) {
  if (value == null) return null;
  if (isFiniteNumber(value)) return value;

  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function hasReachedLimit(used, limit) {
  return isFiniteNumber(limit) && limit > 0 && used >= limit;
}

/**
 * Estimate token need based on task description length.
 * Uses a heuristic: description chars / 4 (avg chars per token) * overhead multiplier.
 * Returns estimated total tokens (input + output) for the request.
 *
 * @param {number} descriptionLength - Character length of the task description
 * @returns {number} Estimated token need
 */
function estimateTokenNeed(descriptionLength) {
  if (!isFiniteNumber(descriptionLength) || descriptionLength <= 0) return 500;
  const inputTokens = Math.ceil(descriptionLength / CHARS_PER_TOKEN);
  // Output is typically 1-3x input for code tasks; use conservative 2x
  const estimatedOutput = inputTokens * 2;
  return Math.ceil((inputTokens + estimatedOutput) * TOKEN_OVERHEAD_MULTIPLIER);
}

class FreeQuotaTracker {
  constructor(limits = []) {
    this.providers = new Map();
    this._latencyRings = new Map(); // provider -> { ring: number[], index: number, count: number }
    this._db = null; // Optional DB module for persisting daily snapshots

    for (const limit of limits) {
      if (!limit || !limit.provider) continue;

      const now = Date.now();
      this.providers.set(limit.provider, {
        rpm_limit: normalizeLimit(limit.rpm_limit),
        rpd_limit: normalizeLimit(limit.rpd_limit),
        tpm_limit: limit.tpm_limit == null ? null : normalizeLimit(limit.tpm_limit),
        tpd_limit: limit.tpd_limit == null ? null : normalizeLimit(limit.tpd_limit),
        daily_reset_hour: normalizeLimit(limit.daily_reset_hour),
        daily_reset_tz: limit.daily_reset_tz ?? 'UTC',
        minute_requests: 0,
        minute_tokens: 0,
        minute_resets_at: now + MINUTE_WINDOW_MS,
        daily_requests: 0,
        daily_tokens: 0,
        daily_resets_at: now + DAILY_WINDOW_MS,
        cooldown_until: null,
        backoff_step: 0,
      });

      // Initialize latency ring buffer for each provider
      this._latencyRings.set(limit.provider, {
        ring: new Array(LATENCY_RING_SIZE).fill(0),
        index: 0,
        count: 0,
      });
    }
  }

  canSubmit(provider) {
    const state = this.providers.get(provider);
    if (!state) return false;

    this._maybeResetWindows(state);

    const now = Date.now();
    if (state.cooldown_until && now < state.cooldown_until) {
      return false;
    }

    if (state.cooldown_until && now >= state.cooldown_until) {
      state.cooldown_until = null;
    }

    if (hasReachedLimit(state.minute_requests, state.rpm_limit)) return false;
    if (hasReachedLimit(state.minute_tokens, state.tpm_limit)) return false;
    if (hasReachedLimit(state.daily_requests, state.rpd_limit)) return false;
    if (hasReachedLimit(state.daily_tokens, state.tpd_limit)) return false;

    return true;
  }

  recordUsage(provider, tokens = 0) {
    const state = this.providers.get(provider);
    if (!state) return;

    this._maybeResetWindows(state);

    const safeTokens = isFiniteNumber(tokens) ? tokens : 0;
    state.minute_requests += 1;
    state.daily_requests += 1;
    state.minute_tokens += safeTokens;
    state.daily_tokens += safeTokens;
    state.backoff_step = 0;
  }

  /**
   * Record a completed request latency for a provider.
   * Used as a tiebreaker in smart routing — faster providers get higher scores.
   *
   * @param {string} provider - Provider name
   * @param {number} latencyMs - Response time in milliseconds
   */
  recordLatency(provider, latencyMs) {
    const ringData = this._latencyRings.get(provider);
    if (!ringData) return;
    if (!isFiniteNumber(latencyMs) || latencyMs <= 0) return;

    ringData.ring[ringData.index] = latencyMs;
    ringData.index = (ringData.index + 1) % LATENCY_RING_SIZE;
    if (ringData.count < LATENCY_RING_SIZE) ringData.count++;
  }

  /**
   * Get rolling average latency for a provider.
   * Returns DEFAULT_LATENCY_MS if no data has been recorded.
   *
   * @param {string} provider - Provider name
   * @returns {number} Average latency in milliseconds
   */
  getAverageLatency(provider) {
    const ringData = this._latencyRings.get(provider);
    if (!ringData || ringData.count === 0) return DEFAULT_LATENCY_MS;

    let sum = 0;
    for (let i = 0; i < ringData.count; i++) {
      sum += ringData.ring[i];
    }
    return sum / ringData.count;
  }

  recordRateLimit(provider, retryAfterSeconds) {
    const state = this.providers.get(provider);
    if (!state) return;

    const now = Date.now();
    let cooldownSeconds;

    if (isFiniteNumber(retryAfterSeconds) && retryAfterSeconds > 0) {
      cooldownSeconds = retryAfterSeconds;
      state.cooldown_until = now + (retryAfterSeconds * 1000);
      state.backoff_step = 0;
    } else {
      const backoffIndex = Math.min(state.backoff_step, DEFAULT_BACKOFF_SECONDS.length - 1);
      cooldownSeconds = DEFAULT_BACKOFF_SECONDS[backoffIndex];
      state.cooldown_until = now + (cooldownSeconds * 1000);
      state.backoff_step += 1;
    }

    logger.info(`[FreeQuota] ${provider}: cooldown ${cooldownSeconds}s`);
  }

  /**
   * Get available providers sorted by daily quota remaining (original behavior).
   * Preserved for backward compatibility — callers that don't need smart routing
   * continue to use this method unchanged.
   *
   * @returns {{ provider: string, dailyRemainingPct: number }[]}
   */
  getAvailableProviders() {
    const available = [];

    for (const [provider, state] of this.providers.entries()) {
      if (!this.canSubmit(provider)) continue;

      const dailyRemainingPct = !isFiniteNumber(state.rpd_limit) || state.rpd_limit <= 0
        ? 1.0
        : (state.rpd_limit - state.daily_requests) / state.rpd_limit;

      available.push({ provider, dailyRemainingPct });
    }

    available.sort((a, b) => b.dailyRemainingPct - a.dailyRemainingPct);
    return available;
  }

  /**
   * Get available providers scored with task-awareness.
   *
   * Scoring formula:
   *   score = (0.4 * dailyRemainingPct) + (0.3 * tokenCapacityFit) + (0.3 * latencyScore)
   *
   * Where:
   *   - dailyRemainingPct: existing quota metric (0-1)
   *   - tokenCapacityFit: 1.0 if provider has enough daily tokens for estimated need, scaling down
   *   - latencyScore: normalized 1 / avgLatencyMs (faster = higher score)
   *
   * When complexity is provided, an additional trait bonus adjusts scoring to prefer
   * fast providers for simple tasks and high-capacity providers for complex tasks.
   *
   * @param {{ complexity?: string, descriptionLength?: number, taskType?: string }} [taskMeta={}] - Task metadata
   * @returns {{ provider: string, dailyRemainingPct: number, score: number, avgLatencyMs: number, estimatedTokens: number }[]}
   */
  getAvailableProvidersSmart(taskMeta = {}) {
    const { complexity = 'normal', descriptionLength = 0, taskType } = taskMeta;

    // Scan-only enforcement: free providers only accept scan/reasoning/docs tasks.
    // Coding tasks (code_gen, testing, refactoring) must stay on paid providers.
    if (taskType && !FREE_PROVIDER_SCAN_ONLY_TYPES.has(taskType)) {
      logger.info(`[free-quota] Blocked free-tier routing: taskType '${taskType}' is not scan-only`);
      return [];
    }
    const estimatedTokens = estimateTokenNeed(descriptionLength);

    const available = [];

    for (const [provider, state] of this.providers.entries()) {
      if (!this.canSubmit(provider)) continue;

      this._maybeResetWindows(state);

      // --- Daily remaining % (0 to 1) ---
      const dailyRemainingPct = !isFiniteNumber(state.rpd_limit) || state.rpd_limit <= 0
        ? 1.0
        : Math.max(0, (state.rpd_limit - state.daily_requests) / state.rpd_limit);

      // --- Token capacity fit (0 to 1) ---
      // If provider has a daily token limit, check if enough remains for this task
      let tokenCapacityFit = 1.0;
      if (isFiniteNumber(state.tpd_limit) && state.tpd_limit > 0) {
        const remainingTokens = state.tpd_limit - state.daily_tokens;
        if (remainingTokens <= 0) {
          tokenCapacityFit = 0.0;
        } else if (remainingTokens < estimatedTokens) {
          // Proportional fit — 0 to 1 based on how much of the need is covered
          tokenCapacityFit = remainingTokens / estimatedTokens;
        }
        // else: remainingTokens >= estimatedTokens → 1.0 (full fit)
      }
      // No tpd_limit means unlimited tokens → 1.0

      // --- Latency score (0 to 1, normalized) ---
      const avgLatencyMs = this.getAverageLatency(provider);
      // Normalize: 1000ms latency → score ~1.0, 10000ms → ~0.1
      // Using 1000 / avgLatencyMs capped at 1.0
      const latencyScore = Math.min(1.0, 1000 / avgLatencyMs);

      // --- Base score ---
      let score = (0.4 * dailyRemainingPct) + (0.3 * tokenCapacityFit) + (0.3 * latencyScore);

      // --- Complexity trait bonus (additive, small) ---
      const traits = PROVIDER_TRAITS[provider];
      if (traits) {
        const weights = COMPLEXITY_WEIGHTS[complexity] || COMPLEXITY_WEIGHTS.normal;
        // Normalize trait values (max speed=10, max capacity=10) to 0-1
        const speedNorm = traits.speed / 10;
        const capNorm = traits.tokenCapacity / 10;
        const traitBonus = (weights.speedWeight * speedNorm + weights.capacityWeight * capNorm) * 0.15;
        score += traitBonus;
      }

      available.push({
        provider,
        dailyRemainingPct,
        score,
        avgLatencyMs: Math.round(avgLatencyMs),
        estimatedTokens,
      });
    }

    // Sort by score descending, then by dailyRemainingPct as tiebreaker
    available.sort((a, b) => b.score - a.score || b.dailyRemainingPct - a.dailyRemainingPct);
    return available;
  }

  updateLimits(provider, updates = {}) {
    const state = this.providers.get(provider);
    if (!state || !updates || typeof updates !== 'object') return;

    for (const [key, value] of Object.entries(updates)) {
      if (!Object.prototype.hasOwnProperty.call(state, key)) continue;
      if (
        key === 'rpm_limit'
        || key === 'rpd_limit'
        || key === 'tpm_limit'
        || key === 'tpd_limit'
        || key === 'daily_reset_hour'
      ) {
        state[key] = normalizeLimit(value);
        continue;
      }

      state[key] = value;
    }
  }

  tick() {
    for (const state of this.providers.values()) {
      this._maybeResetWindows(state);
      if (state.cooldown_until && Date.now() >= state.cooldown_until) {
        state.cooldown_until = null;
      }
    }
  }

  getStatus() {
    const now = Date.now();
    const status = {};

    for (const [provider, state] of this.providers.entries()) {
      this._maybeResetWindows(state);

      if (state.cooldown_until && now >= state.cooldown_until) {
        state.cooldown_until = null;
      }

      status[provider] = {
        rpm_limit: state.rpm_limit,
        rpd_limit: state.rpd_limit,
        tpm_limit: state.tpm_limit,
        tpd_limit: state.tpd_limit,
        minute_requests: state.minute_requests,
        minute_tokens: state.minute_tokens,
        daily_requests: state.daily_requests,
        daily_tokens: state.daily_tokens,
        cooldown_remaining_seconds: state.cooldown_until
          ? Math.max(0, Math.ceil((state.cooldown_until - now) / 1000))
          : 0,
        minute_resets_in_seconds: Math.max(0, Math.ceil((state.minute_resets_at - now) / 1000)),
        daily_resets_in_seconds: Math.max(0, Math.ceil((state.daily_resets_at - now) / 1000)),
        avg_latency_ms: Math.round(this.getAverageLatency(provider)),
      };
    }

    return status;
  }

  /**
   * Set the DB module for persisting daily snapshots.
   * Expects an object with a `recordDailySnapshot(provider, stats)` method
   * (i.e., the free-tier-history db module).
   *
   * @param {object} dbModule
   */
  setDb(dbModule) {
    this._db = dbModule;
  }

  /**
   * Persist a daily snapshot for all tracked providers.
   * Reads current in-memory state and writes to the database.
   * Called automatically when a daily window resets, and can be called manually.
   *
   * @param {string} [dateOverride] - YYYY-MM-DD override (defaults to yesterday, since this runs at reset time)
   */
  snapshotDaily(dateOverride) {
    if (!this._db || typeof this._db.recordDailySnapshot !== 'function') {
      return;
    }

    // Default to yesterday since snapshots capture the window that just ended
    const date = dateOverride || new Date(Date.now() - DAILY_WINDOW_MS).toISOString().slice(0, 10);

    for (const [provider, state] of this.providers.entries()) {
      try {
        this._db.recordDailySnapshot(provider, {
          date,
          total_requests: state.daily_requests,
          total_tokens: state.daily_tokens,
          rate_limit_hits: 0, // Will be populated if we track this later
          avg_latency_ms: this.getAverageLatency(provider),
        });
      } catch (err) {
        logger.warn(`[FreeQuota] Failed to snapshot ${provider}: ${err.message}`);
      }
    }

    logger.info(`[FreeQuota] Daily snapshot persisted for ${this.providers.size} providers (${date})`);
  }

  _maybeResetWindows(state) {
    const now = Date.now();

    if (now >= state.minute_resets_at) {
      state.minute_requests = 0;
      state.minute_tokens = 0;
      state.minute_resets_at = now + MINUTE_WINDOW_MS;
    }

    if (now >= state.daily_resets_at) {
      // Snapshot before resetting daily counters
      this.snapshotDaily();

      state.daily_requests = 0;
      state.daily_tokens = 0;
      state.daily_resets_at = now + DAILY_WINDOW_MS;
    }
  }
}

// Export class and standalone helpers
FreeQuotaTracker.estimateTokenNeed = estimateTokenNeed;
FreeQuotaTracker.PROVIDER_TRAITS = PROVIDER_TRAITS;
FreeQuotaTracker.COMPLEXITY_WEIGHTS = COMPLEXITY_WEIGHTS;
FreeQuotaTracker.DEFAULT_LATENCY_MS = DEFAULT_LATENCY_MS;
FreeQuotaTracker.LATENCY_RING_SIZE = LATENCY_RING_SIZE;
FreeQuotaTracker.FREE_PROVIDER_SCAN_ONLY_TYPES = FREE_PROVIDER_SCAN_ONLY_TYPES;

// ── Factory (DI Phase 3) ─────────────────────────────────────────────────

function createFreeQuotaTracker(deps) {
  // deps reserved for Phase 5 when database.js facade is removed
  return FreeQuotaTracker;
}

FreeQuotaTracker.createFreeQuotaTracker = createFreeQuotaTracker;

module.exports = FreeQuotaTracker;
module.exports.createFreeQuotaTracker = createFreeQuotaTracker;
