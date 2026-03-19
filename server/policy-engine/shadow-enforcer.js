'use strict';

let getConfig = null;

function setConfigReader(fn) {
  getConfig = fn;
}

function isEngineEnabled() {
  if (!getConfig) return false;
  return String(getConfig('policy_engine_enabled') || '0') === '1';
}

function isShadowOnly() {
  if (!getConfig) return true;
  return String(getConfig('policy_engine_shadow_only') || '1') === '1';
}

function isBlockModeEnabled() {
  if (!getConfig) return false;
  return String(getConfig('policy_block_mode_enabled') || '0') === '1';
}

function enforceMode(requestedMode) {
  if (!isEngineEnabled()) return 'off';
  if (isShadowOnly()) return 'shadow';
  if (requestedMode === 'block' && !isBlockModeEnabled()) return 'warn';
  return requestedMode;
}

module.exports = {
  setConfigReader,
  isEngineEnabled,
  isShadowOnly,
  isBlockModeEnabled,
  enforceMode,
};
