'use strict';

/**
 * capability-resolver — runtime capability lookup for the universal-DI
 * migration's "lazy resolution" architecture.
 *
 * Background
 * ──────────
 * Earlier capability extractions (taskCanceller pilot, fc07d344) used
 * the eager pattern: at factory-construction time, peek the container
 * for the capability, fall back to the legacy `taskManager` handle.
 * This had a known fragility — factories constructed before
 * `container.boot()` runs (notably task-manager.js's inline
 * `createCancellationHandler` call at module-load time) miss the
 * registered service permanently and silently route through the
 * fallback. Two paths exist for the same call.
 *
 * Lazy resolution flips that: instead of binding deps once at
 * construction, resolve at each method invocation. Trade-offs:
 *
 *   + Always picks up the latest registered capability.
 *   + No construction-order timing bugs.
 *   + Tests can `container.registerValue('taskCanceller', mock)` and
 *     have the next call see the mock — no factory rebuild needed.
 *   + Eliminates the dual-path concern: there's only the runtime path.
 *
 *   – Each call does a container lookup (hash-table lookup; cheap).
 *   – If a capability is hot enough to matter, callers can cache the
 *     resolved function in a closure scoped to a single operation.
 *
 * Usage
 * ─────
 *   const { resolveMethod } = require('./capability-resolver');
 *
 *   function createWorkflowRuntime(localDeps = {}) {
 *     const cancelTask = resolveMethod(localDeps, {
 *       capability: 'taskCanceller',  // container.get(name)
 *       method: 'cancelTask',         // capability[method] is the function
 *       legacyHandle: 'taskManager',  // localDeps[legacyHandle][method]
 *       legacyKey: 'cancelTask',      // localDeps[legacyKey] direct override
 *     });
 *
 *     // cancelTask is a function. Each call resolves at runtime.
 *     function someInternal(taskId) { return cancelTask(taskId); }
 *   }
 *
 * The returned function honors this priority:
 *   1. `localDeps[legacyKey]` if it's a function (test override path)
 *   2. `defaultContainer.get(capability)[method]` (registered capability)
 *   3. `localDeps[legacyHandle][method]` (legacy handle, e.g. taskManager)
 *
 * Returning null from all three throws a descriptive error with the
 * resolution chain so the failure mode is legible.
 */

function resolveMethod(localDeps, spec) {
  const { capability, method, legacyHandle, legacyKey } = spec;
  if (typeof method !== 'string' || !method) {
    throw new Error('capability-resolver: spec.method (string) is required');
  }
  return function lazilyResolved(...args) {
    if (legacyKey && typeof localDeps[legacyKey] === 'function') {
      return localDeps[legacyKey](...args);
    }
    if (capability) {
      // Try get() first (post-boot, works for factory and value entries).
      // If that throws (pre-boot), fall back to peek() — it returns the
      // value for registerValue/override-style entries even before boot.
      // Test fixtures using container.override() rely on the peek path.
      let svc = null;
      try {
        const { defaultContainer } = require('../container');
        if (defaultContainer.has && defaultContainer.has(capability)) {
          try { svc = defaultContainer.get(capability); }
          catch (_err) {
            try { svc = defaultContainer.peek(capability); }
            catch (_err2) { svc = null; }
          }
        }
      } catch (_err) {
        // Container module not loadable — fall through to legacy handle.
      }
      if (svc && typeof svc[method] === 'function') {
        return svc[method](...args);
      }
    }
    if (legacyHandle) {
      const handle = localDeps[legacyHandle];
      if (handle && typeof handle[method] === 'function') {
        return handle[method](...args);
      }
    }
    const sources = [
      legacyKey ? `localDeps.${legacyKey}` : null,
      capability ? `container.get('${capability}').${method}` : null,
      legacyHandle ? `localDeps.${legacyHandle}.${method}` : null,
    ].filter(Boolean).join(' → ');
    throw new Error(
      `capability-resolver: could not resolve '${method}' (tried: ${sources})`
    );
  };
}

/**
 * Test helper: a non-throwing variant that returns undefined on
 * resolution failure. Use sparingly — most call sites should let
 * the throw surface a misconfiguration.
 */
function tryResolveMethod(localDeps, spec) {
  const fn = resolveMethod(localDeps, spec);
  return function tryLazy(...args) {
    try { return fn(...args); }
    catch { return undefined; }
  };
}

module.exports = { resolveMethod, tryResolveMethod };
