'use strict';

/**
 * Scout-lane provider resolution for starvation recovery and other
 * factory paths that need to choose a provider for a fresh scout task.
 *
 * Priority order:
 *   1. Provider lane policy `by_kind.scout` (Phase I, 2026-04-30) —
 *      lets a project route scouts to a different provider than its
 *      worker EXECUTE lane. Used by the "Codex as manager, ollama as
 *      worker" pattern where scouting/architecting/reviewing all go
 *      to codex while the actual code edit stays on local ollama.
 *   2. Provider lane policy `expected_provider` set on the project's
 *      config (legacy contract — projects pinning a specific provider
 *      via `provider_lane_policy`).
 *   3. project_defaults.provider — the project's declared routing
 *      intent (e.g. preset-all-local pinning `ollama`). Added
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

    // Priority 1 (Phase I): provider lane policy `by_kind.scout`.
    //
    // When a project pins different providers for different factory
    // task kinds, scouts are routed by the by_kind.scout entry. This
    // is the "Codex manages, ollama works" pattern where scouting is
    // a manager activity (deciding what's worth doing) and the EXECUTE
    // lane stays on the local worker.
    //
    // Priority 2: legacy `expected_provider`.
    //
    // An explicit `expected_provider` is authoritative even when ineligible
    // for scout: returning null lets the caller fall through to its own
    // default rather than silently substituting a different provider that
    // the operator never selected. This preserves user intent — see the
    // dispatch-spirit principle in CLAUDE.md ("If a user chose a provider,
    // that choice matters").
    let policyProvider = null;
    let policyProviderPresent = false;
    let scoutByKind = null;
    try {
      const policy = getProviderLanePolicyFromProject(safeProject);
      // by_kind.scout takes precedence over expected_provider.
      const byKindRaw = policy?.by_kind?.scout;
      scoutByKind = normalizeProvider(byKindRaw);
      const raw = policy?.expected_provider;
      policyProviderPresent = typeof raw === 'string' && raw.trim().length > 0;
      policyProvider = normalizeProvider(raw);
    } catch (err) {
      logger?.warn?.('resolveScoutProvider: lane policy lookup failed', {
        project_id: safeProject.id,
        err: err.message,
      });
    }
    if (scoutByKind) {
      return eligibleProviders.has(scoutByKind) ? scoutByKind : null;
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
