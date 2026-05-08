'use strict';
const path = require('path');
const { validatePlugin, formatValidationErrors } = require('./plugin-contract');

const DEFAULT_PLUGIN_DIR = __dirname;
const AUTH_MODE_PLUGIN_MAP = { enterprise: 'auth' };

function safeLog(logger, level, message) {
  try {
    if (logger && typeof logger[level] === 'function') {
      logger[level](message);
      return;
    }
  } catch (_) { /* logger method failed */ }
  // Fallback to console
  if (level === 'warn') console.warn(message);
  else console.log(message);
}

// plugin-contract.md #2 — `createPlugin` is the canonical factory name.
// `createSnapScopePlugin` and `createAuthPlugin` are legacy fallbacks that
// the original two plugins shipped before the convention was settled. Both
// of those plugins now ALSO export `createPlugin` (aliased to their original
// factory), so the canonical path always wins. The legacy fallbacks remain
// for one deprecation cycle in case any external consumer relies on them.
function createPluginInstance(mod) {
  if (typeof mod.createPlugin === 'function') return mod.createPlugin();
  // Legacy fallbacks — to be removed after the deprecation cycle.
  if (typeof mod.createSnapScopePlugin === 'function') return mod.createSnapScopePlugin();
  if (typeof mod.createAuthPlugin === 'function') return mod.createAuthPlugin();
  return mod;
}

function loadPlugins(options = {}) {
  const {
    plugins = [],
    authMode = 'local',
    pluginDir = DEFAULT_PLUGIN_DIR,
    logger,
  } = options;

  const toLoad = [...plugins];

  // Legacy: auth plugin based on authMode
  const authPlugin = AUTH_MODE_PLUGIN_MAP[authMode];
  if (authPlugin && !toLoad.includes(authPlugin)) {
    toLoad.push(authPlugin);
  }

  const loaded = [];
  for (const name of toLoad) {
    const pluginPath = path.resolve(pluginDir, name, 'index.js');
    try {
      const mod = require(pluginPath);
      const instance = createPluginInstance(mod);
      const validation = validatePlugin(instance);
      if (!validation.valid) {
        // plugin-contract.md #10 — validation.errors is now a structured
        // object array; format for log via formatValidationErrors. Legacy
        // string-array consumers (none today, but keep robust) still work
        // since the formatter accepts either.
        safeLog(logger, 'warn', `[plugin-loader] Plugin "${name}" failed validation: ${formatValidationErrors(validation.errors)}`);
        continue;
      }

      // plugin-contract.md #7 — opt-in disable gate. Plugins can declare
      // an `enabled()` method that returns false to skip themselves
      // entirely (no install/middleware/mcpTools/tierTools registration).
      // Replaces the older "factory returns a no-op stub" pattern, which
      // left disabled plugins in the loaded list contributing nothing
      // and made operator visibility worse (the plugin appeared loaded
      // but no tools surfaced anywhere). Missing enabled() means
      // "always enabled" (back-compat with all 6 default plugins).
      if (typeof instance.enabled === 'function') {
        let isEnabled = true;
        try {
          isEnabled = instance.enabled() !== false;
        } catch (gateErr) {
          safeLog(logger, 'warn', `[plugin-loader] Plugin "${name}" enabled() threw: ${gateErr.message} — treating as disabled`);
          isEnabled = false;
        }
        if (!isEnabled) {
          safeLog(logger, 'info', `[plugin-loader] Plugin "${name}" disabled by enabled() gate — skipping`);
          continue;
        }
      }

      safeLog(logger, 'info', `[plugin-loader] Loaded plugin: ${instance.name} v${instance.version}`);
      loaded.push(instance);
    } catch (err) {
      safeLog(logger, 'warn', `[plugin-loader] Failed to load plugin "${name}" from ${pluginPath}: ${err.message}`);
    }
  }
  return loaded;
}

module.exports = { loadPlugins };
