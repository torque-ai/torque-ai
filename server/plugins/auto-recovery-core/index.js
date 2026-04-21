'use strict';

const rules = require('./rules');
const retry = require('./strategies/retry');
const cleanAndRetry = require('./strategies/clean-and-retry');
const retryWithFreshSession = require('./strategies/retry-with-fresh-session');
const fallbackProvider = require('./strategies/fallback-provider');
const retryPlanGeneration = require('./strategies/retry-plan-generation');
const freshWorktree = require('./strategies/fresh-worktree');
const rejectAndAdvance = require('./strategies/reject-and-advance');
const escalate = require('./strategies/escalate');

const PLUGIN_NAME = 'auto-recovery-core';
const PLUGIN_VERSION = '1.0.0';

function createPlugin() {
  return {
    name: PLUGIN_NAME, version: PLUGIN_VERSION,
    install() {}, uninstall() {},
    middleware() { return null; },
    mcpTools() { return []; },
    eventHandlers() { return {}; },
    configSchema() { return null; },
    classifierRules: rules,
    recoveryStrategies: [
      retry, cleanAndRetry, retryWithFreshSession, fallbackProvider,
      retryPlanGeneration, freshWorktree, rejectAndAdvance, escalate,
    ],
  };
}

module.exports = { createPlugin, PLUGIN_NAME, PLUGIN_VERSION };
