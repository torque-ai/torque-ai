'use strict';
const path = require('path');
const { validatePlugin } = require('./plugin-contract');

const DEFAULT_PLUGIN_DIR = path.join(__dirname);
const AUTH_MODE_PLUGIN_MAP = { enterprise: 'auth' };

function loadPlugins(options = {}) {
  const {
    authMode = 'local',
    pluginDir = DEFAULT_PLUGIN_DIR,
    logger = { warn: console.warn, info: console.log },
  } = options;

  const pluginName = AUTH_MODE_PLUGIN_MAP[authMode];
  if (!pluginName) return [];

  const pluginPath = path.join(pluginDir, pluginName, 'index.js');
  let plugin;
  try {
    plugin = require(pluginPath);
  } catch (err) {
    logger.warn(`[plugin-loader] Failed to load plugin "${pluginName}" from ${pluginPath}: ${err.message}`);
    return [];
  }

  const validation = validatePlugin(plugin);
  if (!validation.valid) {
    logger.warn(`[plugin-loader] Plugin "${pluginName}" failed validation: ${validation.errors.join(', ')}`);
    return [];
  }

  logger.info(`[plugin-loader] Loaded plugin: ${plugin.name} v${plugin.version}`);
  return [plugin];
}

module.exports = { loadPlugins };
