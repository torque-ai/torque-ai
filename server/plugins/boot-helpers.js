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

module.exports = {
  mergeExtraPluginNames,
  wirePluginEventHandlers,
  dedupPluginTools,
};
