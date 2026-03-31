'use strict';
const path = require('path');
const { validatePlugin } = require('./plugin-contract');

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

function createPluginInstance(mod) {
  if (typeof mod.createPlugin === 'function') return mod.createPlugin();
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
        safeLog(logger, 'warn', `[plugin-loader] Plugin "${name}" failed validation: ${validation.errors.join(', ')}`);
        continue;
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
