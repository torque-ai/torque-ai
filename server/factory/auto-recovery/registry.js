'use strict';

function isValidRule(r) {
  return !!(r && typeof r === 'object'
    && typeof r.name === 'string' && r.name.length
    && typeof r.category === 'string' && r.category.length
    && (typeof r.match === 'object' || typeof r.match_fn === 'function'));
}

function isValidStrategy(s) {
  return !!(s && typeof s === 'object'
    && typeof s.name === 'string' && s.name.length
    && typeof s.run === 'function'
    && Array.isArray(s.applicable_categories));
}

function createRegistry({ logger = { warn: () => {} } } = {}) {
  const rules = [];
  const strategies = new Map();

  function registerFromPlugin(pluginName, plugin) {
    if (Array.isArray(plugin?.classifierRules)) {
      for (const rule of plugin.classifierRules) {
        if (isValidRule(rule)) rules.push({ ...rule, _plugin: pluginName });
        else logger.warn('auto-recovery: rejected invalid classifier rule', { plugin: pluginName, rule });
      }
    }
    if (Array.isArray(plugin?.recoveryStrategies)) {
      for (const strat of plugin.recoveryStrategies) {
        if (isValidStrategy(strat)) {
          if (strategies.has(strat.name)) {
            logger.warn('auto-recovery: duplicate strategy name; last registration wins', {
              name: strat.name, plugin: pluginName,
            });
          }
          strategies.set(strat.name, { ...strat, _plugin: pluginName });
        } else {
          logger.warn('auto-recovery: rejected invalid strategy', { plugin: pluginName, strat });
        }
      }
    }
  }

  function getRules() {
    return [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  function getStrategies() {
    return [...strategies.values()];
  }

  function getStrategyByName(name) {
    return strategies.get(name) || null;
  }

  function pick(classification) {
    if (!classification?.suggested_strategies?.length) return null;
    for (const name of classification.suggested_strategies) {
      const strat = strategies.get(name);
      if (!strat) continue;
      if (!strat.applicable_categories.includes(classification.category)
          && !strat.applicable_categories.includes('any')) continue;
      return strat;
    }
    return null;
  }

  // Budget-aware strategy selection: walks the chain in order, but skips any
  // strategy whose `max_attempts_per_project` budget has already been spent
  // (per `recentAttempts`, a Map<strategy_name, count>). Returns null when
  // every strategy in the chain is exhausted, signalling the engine to mark
  // the project `auto_recovery_exhausted = 1` with reason
  // `all_strategies_exhausted`.
  //
  // Strategies without `max_attempts_per_project` default to a budget of 1 —
  // the conservative interpretation, since an unspecified budget would
  // otherwise let the engine pick the same strategy forever after one
  // failed attempt and re-introduce the loop this function exists to break.
  function pickWithBudget(classification, recentAttempts) {
    if (!classification?.suggested_strategies?.length) return null;
    const counts = recentAttempts instanceof Map
      ? recentAttempts
      : new Map(Object.entries(recentAttempts || {}));
    for (const name of classification.suggested_strategies) {
      const strat = strategies.get(name);
      if (!strat) continue;
      if (!strat.applicable_categories.includes(classification.category)
          && !strat.applicable_categories.includes('any')) continue;
      const budget = Number.isFinite(strat.max_attempts_per_project) && strat.max_attempts_per_project > 0
        ? strat.max_attempts_per_project
        : 1;
      const used = Number(counts.get(name) || 0);
      if (used >= budget) continue;
      return strat;
    }
    return null;
  }

  return { registerFromPlugin, getRules, getStrategies, getStrategyByName, pick, pickWithBudget };
}

module.exports = { createRegistry };
