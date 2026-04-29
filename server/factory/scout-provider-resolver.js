'use strict';

/**
 * Scout-lane provider resolution for starvation recovery and other
 * factory paths that need to choose a provider for a fresh scout task.
 *
 * Priority order:
 *   1. Provider lane policy `expected_provider` set on the project's
 *      config (legacy contract — projects pinning a specific provider
 *      via `provider_lane_policy`).
 *   2. project_defaults.provider — the project's declared routing
 *      intent (e.g. preset-all-local pinning `ollama`). This was added
 *      2026-04-29: previously the resolver only honored explicit lane
 *      policy and silently fell through to the system default (codex)
 *      for projects that simply set a routing template.
 *
 * The resolved provider must be in the supplied `eligibleProviders`
 * set; otherwise null is returned and the caller falls through to its
 * own default. Currently `eligibleProviders` mirrors the
 * `FILESYSTEM_PROVIDERS` set in `handlers/diffusion-handlers.js` —
 * providers that can drive the agentic scout loop.
 */

function normalizeProvider(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

/**
 * Build a scout-provider resolver.
 *
 * @param {object} deps
 * @param {Set<string>} deps.eligibleProviders - allowlist of providers that may drive a scout
 * @param {(project: object) => object|null} deps.getProviderLanePolicyFromProject - lane policy lookup
 * @param {(pathOrProject: string) => object|null} [deps.getProjectDefaults] - project defaults lookup (optional but recommended)
 * @param {{warn?: Function}} [deps.logger] - logger for fallback failures
 * @returns {(project: object) => string|null}
 */
function createScoutProviderResolver({
  eligibleProviders,
  getProviderLanePolicyFromProject,
  getProjectDefaults,
  logger = null,
} = {}) {
  if (!(eligibleProviders instanceof Set)) {
    throw new Error('createScoutProviderResolver: eligibleProviders Set is required');
  }
  if (typeof getProviderLanePolicyFromProject !== 'function') {
    throw new Error('createScoutProviderResolver: getProviderLanePolicyFromProject is required');
  }

  return function resolveScoutProvider(project) {
    const safeProject = project || {};

    // Priority 1: explicit provider lane policy.
    //
    // An explicit `expected_provider` is authoritative even when ineligible
    // for scout: returning null lets the caller fall through to its own
    // default rather than silently substituting a different provider that
    // the operator never selected. This preserves user intent — see the
    // dispatch-spirit principle in CLAUDE.md ("If a user chose a provider,
    // that choice matters").
    let policyProvider = null;
    let policyProviderPresent = false;
    try {
      const policy = getProviderLanePolicyFromProject(safeProject);
      const raw = policy?.expected_provider;
      policyProviderPresent = typeof raw === 'string' && raw.trim().length > 0;
      policyProvider = normalizeProvider(raw);
    } catch (err) {
      logger?.warn?.('resolveScoutProvider: lane policy lookup failed', {
        project_id: safeProject.id,
        err: err.message,
      });
    }
    if (policyProviderPresent) {
      return (policyProvider && eligibleProviders.has(policyProvider))
        ? policyProvider
        : null;
    }

    // Priority 2: project_defaults.provider — only consulted when there is
    // no explicit lane policy expected_provider on the project.
    if (typeof getProjectDefaults === 'function' && safeProject.path) {
      try {
        const defaults = getProjectDefaults(safeProject.path);
        const defaultsProvider = normalizeProvider(defaults?.provider);
        if (defaultsProvider && eligibleProviders.has(defaultsProvider)) {
          return defaultsProvider;
        }
      } catch (err) {
        logger?.warn?.('resolveScoutProvider: project_defaults lookup failed', {
          project_id: safeProject.id,
          project_path: safeProject.path,
          err: err.message,
        });
      }
    }

    return null;
  };
}

module.exports = { createScoutProviderResolver };
