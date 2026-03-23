'use strict';

/**
 * providers/ollama-shared.js — Shared Ollama model discovery and host matching.
 *
 * Extracted from execute-ollama.js and execute-hashline.js where these
 * functions were duplicated identically. Single source of truth for:
 * - Model availability checking across hosts
 * - Host-model matching with version-tag safety
 * - Best available model ranking
 */

const logger = require('../logger').child({ component: 'ollama-shared' });
const serverConfig = require('../config');

let db = null;

function init(deps) {
  if (deps.db) db = deps.db;
}

/**
 * Check if any healthy host has the given model (exact or variant match).
 */
function hasModelOnAnyHost(model) {
  if (!model || !db || typeof db.selectOllamaHostForModel !== 'function') return false;
  const exact = db.selectOllamaHostForModel(model);
  if (exact && exact.host) return true;
  const base = model.split(':')[0];
  if (typeof db.selectHostWithModelVariant === 'function') {
    const variant = db.selectHostWithModelVariant(base);
    if (variant && variant.host) return true;
  }
  return false;
}

/**
 * Check whether a specific host advertises the requested model.
 * When the model includes an explicit version tag (e.g., :8b, :32b),
 * only exact matches are allowed to prevent cross-size misrouting.
 */
function hostHasModel(host, model) {
  if (!host || !host.models || host.models.length === 0 || !model) return false;
  const modelLower = model.toLowerCase();
  const hasExactVersion = /:[\d]+b$/i.test(model);
  return host.models.some(m => {
    const name = (typeof m === 'string' ? m : m.name || '').toLowerCase();
    if (name === modelLower) return true;
    // Only allow base-name fallback when no explicit version tag was requested
    if (!hasExactVersion) {
      return name.split(':')[0] === modelLower.split(':')[0];
    }
    return false;
  });
}

/**
 * Find the best available model on any healthy host.
 * Prefers larger models for better quality. Returns model name or null.
 * @param {Function} [filterFn] — optional filter (e.g., isHashlineCapableModel)
 */
function findBestAvailableModel(filterFn) {
  if (!db || typeof db.getAggregatedModels !== 'function') return null;
  try {
    let allModels = db.getAggregatedModels();
    if (filterFn) allModels = allModels.filter(m => {
      const name = typeof m === 'string' ? m : m?.name;
      return filterFn(name);
    });
    if (allModels.length === 0) return null;
    const ranked = allModels
      .map(m => {
        const name = typeof m === 'string' ? m : m?.name;
        const sizeMatch = (name || '').toLowerCase().match(/(\d+)b/);
        return { name, size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0 };
      })
      .sort((a, b) => b.size - a.size); // largest first
    return ranked[0].name;
  } catch (e) {
    logger.info(`[ollama-shared] Error finding available model: ${e.message}`);
    return null;
  }
}

/**
 * Resolve the Ollama model to use for a task, walking a priority chain:
 *   1. task.model          — explicit model from task submission
 *   2. host.default_model  — per-host default
 *   3. serverConfig 'ollama_model' — global config
 *   4. First model in host.models — dynamic fallback from what's loaded
 *   5. null                — caller handles the error
 *
 * Both parameters are optional (nullable).
 */
function resolveOllamaModel(task, host) {
  if (task?.model) return task.model;
  if (host?.default_model) return host.default_model;
  const globalDefault = serverConfig.get('ollama_model');
  if (globalDefault) return globalDefault;
  if (host?.models?.length) {
    const first = host.models[0];
    return typeof first === 'string' ? first : first?.name || null;
  }
  return null;
}

module.exports = {
  init,
  hasModelOnAnyHost,
  hostHasModel,
  findBestAvailableModel,
  resolveOllamaModel,
};
