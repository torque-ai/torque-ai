'use strict';

/**
 * Boot-integration helpers for plugin loading. Extracted from server/index.js
 * so the small piece of glue (env-var parsing, eventHandlers wiring,
 * plugin-vs-plugin tool dedup) can be unit-tested without booting the whole
 * server. Used by:
 *
 *   - mergeExtraPluginNames(defaultNames, env)  — plugin-contract.md #12
 *   - wirePluginEventHandlers(plugins, eventBus, logger)  — #1
 *   - dedupPluginTools(plugins, builtInNames, logger, decorateFn)  — #5
 *
 * Each helper is self-contained and accepts its dependencies explicitly so
 * tests can stub them with plain objects.
 */

/**
 * plugin-contract.md #12 — parse TORQUE_EXTRA_PLUGINS into an array of
 * plugin names that should be appended to DEFAULT_PLUGIN_NAMES.
 * Comma-separated; trimmed; deduped against the default list (so an
 * operator can list one already-present built-in without breaking).
 *
 * @param {string[]} defaultNames - DEFAULT_PLUGIN_NAMES (frozen array)
 * @param {object} env - typically process.env (passed in for testability)
 * @returns {string[]} extras to append (may be empty)
 */
function mergeExtraPluginNames(defaultNames, env = process.env) {
  const raw = env && env.TORQUE_EXTRA_PLUGINS;
  if (!raw || typeof raw !== 'string') return [];
  const defaultSet = new Set(defaultNames);
  const seen = new Set();
  const extras = [];
  for (const name of raw.split(',')) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    if (defaultSet.has(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    extras.push(trimmed);
  }
  return extras;
}

/**
 * plugin-contract.md #1 — subscribe each plugin's eventHandlers() return
 * map to the eventBus. Pre-this-batch, every plugin shipped an empty
 * eventHandlers() stub solely to pass validation; subscriptions had to be
 * registered manually inside install(). Now plugins can declare
 * `eventHandlers() { return { 'event-name': handler } }` and this helper
 * subscribes each entry.
 *
 * Defensive: missing/throwing eventHandlers, non-object returns, and
 * non-function values are all logged + skipped (best-effort).
 *
 * @param {object[]} plugins - loadedPlugins array
 * @param {object} eventBus - object with `on(eventName, fn)`
 * @param {object} logger - object with info/warn methods
 * @returns {Array<{plugin: string, events: string[]}>} per-plugin subscription summary
 */
function wirePluginEventHandlers(plugins, eventBus, logger) {
  const summary = [];
  for (const plugin of plugins) {
    let handlers = null;
    try {
      handlers = typeof plugin.eventHandlers === 'function'
        ? plugin.eventHandlers()
        : null;
    } catch (handlersErr) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[plugin-loader] ${plugin.name}: eventHandlers() threw: ${handlersErr.message}`);
      }
      continue;
    }
    if (!handlers || typeof handlers !== 'object') continue;
    const subscribed = [];
    for (const [eventName, handlerFn] of Object.entries(handlers)) {
      if (typeof handlerFn !== 'function') {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`[plugin-loader] ${plugin.name}: eventHandlers()['${eventName}'] is not a function — skipping`);
        }
        continue;
      }
      try {
        eventBus.on(eventName, handlerFn);
        subscribed.push(eventName);
      } catch (subErr) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`[plugin-loader] ${plugin.name}: failed to subscribe to '${eventName}': ${subErr.message}`);
        }
      }
    }
    if (subscribed.length > 0) {
      if (logger && typeof logger.info === 'function') {
        logger.info(`[plugin-loader] ${plugin.name}: subscribed to events: ${subscribed.join(', ')}`);
      }
      summary.push({ plugin: plugin.name, events: subscribed });
    }
  }
  return summary;
}

/**
 * plugin-contract.md #5 — collect plugin-contributed mcpTools with two-tier
 * dedup:
 *   1. Skip tools whose name shadows a built-in (built-ins always win)
 *   2. Skip tools whose name was already claimed by an earlier plugin
 *      (first-plugin-wins; second plugin gets a warn log naming both)
 *
 * @param {object[]} plugins - loadedPlugins array
 * @param {Set<string>} builtInNames - built-in tool names (built-ins win)
 * @param {object} logger - object with info/warn/error methods
 * @param {Function} [decorateFn] - optional toolsModule.decorateToolDefinition
 * @returns {{ tools: object[], ownership: Map<string, string> }}
 */
function dedupPluginTools(plugins, builtInNames, logger, decorateFn) {
  const tools = [];
  const ownership = new Map();
  const decorate = typeof decorateFn === 'function' ? decorateFn : (t) => t;
  for (const plugin of plugins) {
    let pluginTools;
    try {
      pluginTools = plugin.mcpTools();
      if (logger && typeof logger.info === 'function') {
        logger.info(`[plugin-tools] ${plugin.name}: mcpTools() returned ${Array.isArray(pluginTools) ? pluginTools.length : typeof pluginTools} tools`);
      }
    } catch (mcpErr) {
      if (logger && typeof logger.error === 'function') {
        logger.error(`[plugin-tools] ${plugin.name}: mcpTools() threw: ${mcpErr.message}`);
      }
      continue;
    }
    if (!Array.isArray(pluginTools)) continue;
    for (const tool of pluginTools) {
      if (!tool || typeof tool.name !== 'string') continue;
      if (builtInNames && builtInNames.has(tool.name)) {
        // Built-in shadowing — debug-level (not an operator concern;
        // happens by design when a plugin's name overlaps a core tool).
        continue;
      }
      const priorOwner = ownership.get(tool.name);
      if (priorOwner) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`[plugin-tools] DUPLICATE: tool "${tool.name}" from plugin "${plugin.name}" already registered by plugin "${priorOwner}" — skipping`);
        }
        continue;
      }
      ownership.set(tool.name, plugin.name);
      tools.push(decorate(tool));
    }
  }
  return { tools, ownership };
}

/**
 * plugin-contract.md #3 — install plugins and splice out any that throw.
 * Mutates the input `plugins` array in place (removes failures) so
 * subsequent boot passes (eventHandlers wiring, mcpTools collection)
 * skip broken plugins. Pre-this-batch, a plugin whose install() threw
 * still contributed tools and middleware that had no working backing
 * services.
 *
 * @param {object[]} plugins - loadedPlugins array (MUTATED — failures spliced out)
 * @param {object} container - DI container passed to plugin.install()
 * @param {object} logger - object with info/error methods
 * @returns {{ failures: Array<{name: string, error: string}> }}
 */
function installPluginsWithUnloadOnError(plugins, container, logger) {
  const failures = [];
  // Install in forward order so plugin-load order is preserved (matches
  // DEFAULT_PLUGIN_NAMES). Collect failed indices, then splice in
  // reverse so index shifting doesn't skip any element. Two-pass keeps
  // install order correct and unload safe.
  const failedIndices = [];
  for (let i = 0; i < plugins.length; i++) {
    const plugin = plugins[i];
    try {
      plugin.install(container);
      if (logger && typeof logger.info === 'function') {
        logger.info(`[plugin-loader] Plugin installed: ${plugin.name} v${plugin.version}`);
      }
    } catch (pluginErr) {
      failures.push({ name: plugin.name, error: pluginErr.message });
      failedIndices.push(i);
      if (logger && typeof logger.error === 'function') {
        logger.error(`[plugin-loader] Plugin install FAILED: ${plugin.name} — ${pluginErr.message} — REMOVING from loaded set so its tools/middleware/events do not register`);
      }
    }
  }
  // Splice in reverse so each removal doesn't shift the indices of the
  // remaining failed positions.
  for (let i = failedIndices.length - 1; i >= 0; i--) {
    plugins.splice(failedIndices[i], 1);
  }
  return { failures };
}

/**
 * plugin-contract.md #4 — central registry helpers for classifierRules
 * and recoveryStrategies. Pre-this-batch, consumers iterated loadedPlugins
 * directly looking for these properties with no priority/conflict
 * handling. These helpers expose the merge contract: stable-merge in
 * plugin-load order, first-plugin-wins on dedup keyed by `name`/`id`.
 * Rules without a stable identifier just get appended (no dedup).
 */
function getAllClassifierRules(plugins) {
  const merged = [];
  const seen = new Set();
  for (const plugin of plugins) {
    const rules = plugin && plugin.classifierRules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      const key = rule && (rule.name || rule.id);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      merged.push(rule);
    }
  }
  return merged;
}

function getAllRecoveryStrategies(plugins) {
  const merged = [];
  const seen = new Set();
  for (const plugin of plugins) {
    const strategies = plugin && plugin.recoveryStrategies;
    if (!Array.isArray(strategies)) continue;
    for (const strategy of strategies) {
      const key = strategy && (strategy.name || strategy.id);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      merged.push(strategy);
    }
  }
  return merged;
}

/**
 * plugin-contract.md #6 — runtime configSchema validation. At boot, each
 * plugin's configSchema() return is checked against the actual config
 * table. Today this is lightweight: warn when a schema declares
 * `required` fields that are not present in the config db.
 * Pre-this-batch, configSchema returns were documentation surface only
 * with no validator running anywhere.
 *
 * @param {object[]} plugins
 * @param {object} configReader - object with `get(key)` returning value/null
 * @param {object} logger - object with info/warn methods
 * @returns {{ warnings: Array<{plugin: string, missing: string[]}> }}
 */
function validatePluginConfigSchemas(plugins, configReader, logger) {
  const warnings = [];
  for (const plugin of plugins) {
    let schema;
    try {
      schema = typeof plugin.configSchema === 'function' ? plugin.configSchema() : null;
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[plugin-loader] ${plugin.name}: configSchema() threw: ${err.message}`);
      }
      continue;
    }
    if (!schema || typeof schema !== 'object') continue;
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.length === 0) continue;
    const missing = [];
    for (const fieldName of required) {
      if (typeof fieldName !== 'string') continue;
      let value = null;
      try {
        value = configReader && typeof configReader.get === 'function'
          ? configReader.get(fieldName)
          : null;
      } catch { /* config read can't really fail but stay defensive */ }
      if (value === null || value === undefined || value === '') {
        missing.push(fieldName);
      }
    }
    if (missing.length > 0) {
      warnings.push({ plugin: plugin.name, missing });
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[plugin-loader] ${plugin.name}: configSchema requires fields not set in config: ${missing.join(', ')}`);
      }
    }
  }
  return { warnings };
}

module.exports = {
  mergeExtraPluginNames,
  wirePluginEventHandlers,
  dedupPluginTools,
  installPluginsWithUnloadOnError,
  getAllClassifierRules,
  getAllRecoveryStrategies,
  validatePluginConfigSchemas,
};
