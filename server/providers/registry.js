'use strict';

/**
 * Provider Registry — single source of truth for provider categories,
 * instance management, and dispatch routing.
 *
 * Replaces:
 * - 8 lazy-init provider getters in task-manager.js
 * - 11-branch dispatch switch in task-manager.js:2110
 * - 3× ad-hoc provider categorization in task-manager.js + queue-scheduler.js
 */

const logger = require('../logger').child({ component: 'provider-registry' });
const serverConfig = require('../config');

// ── Provider Category Constants ────────────────────────────────────────────

/**
 * Provider category assignments. Every provider must appear in exactly one category.
 * Used by: categorizeQueuedTasks, getProviderSlotLimits, dispatch routing.
 */
const PROVIDER_CATEGORIES = {
  ollama: ['ollama', 'aider-ollama', 'hashline-ollama'],
  codex:  ['codex', 'codex-spark', 'claude-cli'],
  api:    ['anthropic', 'groq', 'hyperbolic', 'deepinfra',
           'ollama-cloud', 'cerebras', 'google-ai', 'openrouter'],
};

/** Flat set of all known provider names */
const ALL_PROVIDERS = new Set([
  ...PROVIDER_CATEGORIES.ollama,
  ...PROVIDER_CATEGORIES.codex,
  ...PROVIDER_CATEGORIES.api,
]);

/** Pre-built lookup: provider name → category */
const CATEGORY_BY_PROVIDER = new Map();
for (const [category, providers] of Object.entries(PROVIDER_CATEGORIES)) {
  for (const p of providers) {
    CATEGORY_BY_PROVIDER.set(p, category);
  }
}

// ── Category Helpers ───────────────────────────────────────────────────────

function getCategory(provider) {
  return CATEGORY_BY_PROVIDER.get(provider) || null;
}

function isOllamaProvider(provider) {
  return CATEGORY_BY_PROVIDER.get(provider) === 'ollama';
}

function isCodexProvider(provider) {
  return CATEGORY_BY_PROVIDER.get(provider) === 'codex';
}

function isApiProvider(provider) {
  return CATEGORY_BY_PROVIDER.get(provider) === 'api';
}

function isKnownProvider(provider) {
  return ALL_PROVIDERS.has(provider);
}

function getProvidersInCategory(category) {
  return PROVIDER_CATEGORIES[category] || [];
}

// ── API Provider Instances (lazy-initialized) ──────────────────────────────

const _instances = {};
const _constructors = {};

/**
 * Register a provider class constructor for lazy initialization.
 * Called during module load from task-manager.js or equivalent.
 */
function registerProviderClass(name, ProviderClass) {
  _constructors[name] = ProviderClass;
}

/**
 * Get or create a provider instance. Lazy-initializes on first access.
 * Config key convention: `{provider_name}_api_key` in DB, `{PROVIDER_NAME}_API_KEY` in env.
 */
function getProviderInstance(name) {
  if (_instances[name]) return _instances[name];

  const Constructor = _constructors[name];
  if (!Constructor) {
    logger.warn(`[registry] No constructor registered for provider "${name}"`);
    return null;
  }

  // Resolve key via getApiKey (env var → encrypted DB → legacy config table)
  const apiKey = serverConfig.getApiKey(name);

  _instances[name] = new Constructor({ apiKey });
  return _instances[name];
}

/**
 * Reset all cached instances. Used in tests or when config changes.
 */
function resetInstances() {
  for (const key of Object.keys(_instances)) {
    delete _instances[key];
  }
}

// ── Init ────────────────────────────────────────────────────────────────────

function init(deps) {
  serverConfig.init({ db: deps.db });
}

module.exports = {
  // Category constants
  PROVIDER_CATEGORIES,
  ALL_PROVIDERS,
  CATEGORY_BY_PROVIDER,

  // Category helpers
  getCategory,
  isOllamaProvider,
  isCodexProvider,
  isApiProvider,
  isKnownProvider,
  getProvidersInCategory,

  // Instance management
  registerProviderClass,
  getProviderInstance,
  resetInstances,

  // Init
  init,
};
