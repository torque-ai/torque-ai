'use strict';

/**
 * Compute the effective global concurrency limit.
 *
 * This is shared between provider-router and queue-scheduler so both paths
 * use the same fallback and DB-assisted resolution logic.
 *
 * @param {object} options
 * @param {object} [options.preRead]
 * @param {Function} options.safeConfigInt
 * @param {object} [options.serverConfig]
 * @param {object} [options.db]
 * @param {object} options.logger
 * @returns {number}
 */
function getEffectiveGlobalMaxConcurrent(options = {}) {
  const {
    preRead = {},
    safeConfigInt,
    serverConfig,
    db,
    logger,
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

  return autoComputeMaxConcurrent
    ? Math.max(configuredMaxConcurrent, fallbackProviderSum)
    : configuredMaxConcurrent;
}

module.exports = {
  getEffectiveGlobalMaxConcurrent,
};
