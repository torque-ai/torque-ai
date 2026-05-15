'use strict';

/**
 * Compute the effective global concurrency limit.
 *
 * This is shared between provider-router and queue-scheduler so both paths
 * use the same fallback and DB-assisted resolution logic. The configured
 * global cap remains authoritative; provider sums are advisory.
 *
 * The advisory warning is intentionally process-scoped and emitted once per
 * distinct message. The scheduler asks for this value frequently; repeating the
 * same valid-cap warning hides new operational signals in torque.log.
 *
 * @param {object} options
 * @param {object} [options.preRead]
 * @param {Function} options.safeConfigInt
 * @param {object} [options.serverConfig]
 * @param {object} [options.db]
 * @param {object} options.logger
 * @param {Set<string>} [options.warningCache]
 * @returns {number}
 */
const warnedConcurrencyCapMessages = new Set();

function warnOnce(logger, message, warningCache = warnedConcurrencyCapMessages) {
  if (!logger || typeof logger.warn !== 'function') return;
  if (!warningCache || typeof warningCache.has !== 'function' || typeof warningCache.add !== 'function') {
    logger.warn(message);
    return;
  }
  if (warningCache.has(message)) return;
  warningCache.add(message);
  logger.warn(message);
}

function getEffectiveGlobalMaxConcurrent(options = {}) {
  const {
    preRead = {},
    safeConfigInt,
    serverConfig,
    db,
    logger,
    warningCache = warnedConcurrencyCapMessages,
  } = options;

  const maxOllamaConcurrent = preRead.maxOllamaConcurrent ?? safeConfigInt('max_ollama_concurrent', 8);
  const maxCodexConcurrent = preRead.maxCodexConcurrent ?? safeConfigInt('max_codex_concurrent', 6);
  const maxApiConcurrent = preRead.maxApiConcurrent ?? safeConfigInt('max_api_concurrent', 4);
  const fallbackProviderSum = maxOllamaConcurrent + maxCodexConcurrent + maxApiConcurrent;
  const configuredMaxConcurrent = safeConfigInt('max_concurrent', 20);
  const autoComputeMaxConcurrent = serverConfig && typeof serverConfig.getBool === 'function'
    ? serverConfig.getBool('auto_compute_max_concurrent')
    : false;

  if (db && typeof db.getEffectiveMaxConcurrent === 'function') {
    const details = db.getEffectiveMaxConcurrent({
      configuredMaxConcurrent,
      autoComputeMaxConcurrent,
      logger,
    });
    const effectiveMaxConcurrent = Number(details?.effectiveMaxConcurrent);
    if (Number.isFinite(effectiveMaxConcurrent) && effectiveMaxConcurrent > 0) {
      return effectiveMaxConcurrent;
    }
  }

  if (
    autoComputeMaxConcurrent
    && fallbackProviderSum > configuredMaxConcurrent
    && logger
    && typeof logger.warn === 'function'
  ) {
    warnOnce(
      logger,
      `[Concurrency] Enabled provider limits sum to ${fallbackProviderSum}, but configured max_concurrent=${configuredMaxConcurrent} is enforced as the global cap.`,
      warningCache,
    );
  }

  return configuredMaxConcurrent;
}

module.exports = {
  getEffectiveGlobalMaxConcurrent,
};
