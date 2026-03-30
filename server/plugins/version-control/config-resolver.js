'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILT_IN_DEFAULTS = Object.freeze({
  branch_policy: {
    protected_branches: ['main', 'master'],
    branch_prefix: ['feat/', 'fix/', 'chore/', 'refactor/', 'test/', 'docs/'],
    policy_modes: {
      protected_branches: 'block',
      branch_naming: 'warn',
    },
  },
  commit_policy: {
    format: 'conventional',
  },
  worktree: {
    dir: '.worktrees',
    stale_threshold_days: 7,
  },
  merge: {
    strategy: 'merge',
    require_before_merge: [],
    policy_modes: {
      required_checks: 'block',
      merge_strategy: 'warn',
    },
  },
});

const FLAT_ALIAS_KEYS = new Set([
  'protected_branches',
  'branch_prefix',
  'merge_strategy',
  'require_before_merge',
  'stale_threshold_days',
  'commit_format',
  'worktree_dir',
  'policy_modes',
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(target, source) {
  if (!isPlainObject(source)) {
    return isPlainObject(target) ? { ...target } : {};
  }

  const result = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }

    if (value === null || value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      result[key] = cloneJson(value);
      continue;
    }

    if (isPlainObject(value)) {
      result[key] = deepMerge(result[key], value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

function setNestedValue(target, pathParts, value) {
  if (value === null || value === undefined) {
    return;
  }

  let cursor = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const part = pathParts[index];
    if (!isPlainObject(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }

  const finalKey = pathParts[pathParts.length - 1];
  cursor[finalKey] = Array.isArray(value) ? cloneJson(value) : value;
}

function normalizeConfigShape(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    return {};
  }

  const normalized = {};

  for (const [key, value] of Object.entries(rawConfig)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }

    if (FLAT_ALIAS_KEYS.has(key)) {
      continue;
    }

    normalized[key] = Array.isArray(value) || isPlainObject(value)
      ? cloneJson(value)
      : value;
  }

  setNestedValue(normalized, ['branch_policy', 'protected_branches'], rawConfig.protected_branches);
  setNestedValue(normalized, ['branch_policy', 'branch_prefix'], rawConfig.branch_prefix);
  setNestedValue(normalized, ['merge', 'strategy'], rawConfig.merge_strategy);
  setNestedValue(normalized, ['merge', 'require_before_merge'], rawConfig.require_before_merge);
  setNestedValue(normalized, ['worktree', 'stale_threshold_days'], rawConfig.stale_threshold_days);
  setNestedValue(normalized, ['commit_policy', 'format'], rawConfig.commit_format);
  setNestedValue(normalized, ['worktree', 'dir'], rawConfig.worktree_dir);

  if (isPlainObject(rawConfig.policy_modes)) {
    setNestedValue(
      normalized,
      ['branch_policy', 'policy_modes', 'protected_branches'],
      rawConfig.policy_modes.protected_branches,
    );
    setNestedValue(
      normalized,
      ['branch_policy', 'policy_modes', 'branch_naming'],
      rawConfig.policy_modes.branch_naming,
    );
    setNestedValue(
      normalized,
      ['merge', 'policy_modes', 'required_checks'],
      rawConfig.policy_modes.required_checks,
    );
    setNestedValue(
      normalized,
      ['merge', 'policy_modes', 'merge_strategy'],
      rawConfig.policy_modes.merge_strategy,
    );
  }

  return normalized;
}

function buildPublicConfig(sectionConfig) {
  const config = cloneJson(sectionConfig);
  const branchPolicy = deepMerge(BUILT_IN_DEFAULTS.branch_policy, isPlainObject(config.branch_policy) ? config.branch_policy : {});
  const commitPolicy = deepMerge(BUILT_IN_DEFAULTS.commit_policy, isPlainObject(config.commit_policy) ? config.commit_policy : {});
  const worktree = deepMerge(BUILT_IN_DEFAULTS.worktree, isPlainObject(config.worktree) ? config.worktree : {});
  const merge = deepMerge(BUILT_IN_DEFAULTS.merge, isPlainObject(config.merge) ? config.merge : {});

  config.branch_policy = branchPolicy;
  config.commit_policy = commitPolicy;
  config.worktree = worktree;
  config.merge = merge;

  config.protected_branches = Array.isArray(branchPolicy.protected_branches)
    ? cloneJson(branchPolicy.protected_branches)
    : [];
  config.branch_prefix = Array.isArray(branchPolicy.branch_prefix)
    ? cloneJson(branchPolicy.branch_prefix)
    : [];
  config.merge_strategy = typeof merge.strategy === 'string' ? merge.strategy : 'merge';
  config.require_before_merge = Array.isArray(merge.require_before_merge)
    ? cloneJson(merge.require_before_merge)
    : [];
  config.stale_threshold_days = Number.isFinite(Number(worktree.stale_threshold_days))
    ? Number(worktree.stale_threshold_days)
    : 7;
  config.commit_format = typeof commitPolicy.format === 'string'
    ? commitPolicy.format
    : 'conventional';
  config.worktree_dir = typeof worktree.dir === 'string' && worktree.dir.trim()
    ? worktree.dir
    : '.worktrees';
  config.policy_modes = {
    protected_branches: branchPolicy.policy_modes?.protected_branches || 'block',
    branch_naming: branchPolicy.policy_modes?.branch_naming || 'warn',
    required_checks: merge.policy_modes?.required_checks || 'block',
    merge_strategy: merge.policy_modes?.merge_strategy || 'warn',
  };

  return config;
}

function loadJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function createConfigResolver(options = {}) {
  const cache = new Map();
  const globalConfigPath = typeof options.globalConfigPath === 'string' && options.globalConfigPath.trim()
    ? options.globalConfigPath
    : path.join(options.homeDir || os.homedir(), '.torque', 'vc-defaults.json');

  function getBuiltInDefaults() {
    return buildPublicConfig(BUILT_IN_DEFAULTS);
  }

  function getGlobalDefaults() {
    const builtIns = getBuiltInDefaults();
    const globalConfig = loadJsonFile(globalConfigPath);
    if (!isPlainObject(globalConfig)) {
      return builtIns;
    }

    const merged = deepMerge(BUILT_IN_DEFAULTS, normalizeConfigShape(globalConfig));
    return buildPublicConfig(merged);
  }

  function getEffectiveConfig(repoPath) {
    const cacheKey = typeof repoPath === 'string' && repoPath.trim()
      ? path.resolve(repoPath)
      : '';

    if (cacheKey && cache.has(cacheKey)) {
      return cloneJson(cache.get(cacheKey));
    }

    const globalDefaults = getGlobalDefaults();
    let effectiveConfig = globalDefaults;

    if (cacheKey) {
      const repoConfigPath = path.join(cacheKey, '.torque-vc.json');
      const repoConfig = loadJsonFile(repoConfigPath);
      if (isPlainObject(repoConfig)) {
        const merged = deepMerge(globalDefaults, normalizeConfigShape(repoConfig));
        effectiveConfig = buildPublicConfig(merged);
      }
    }

    if (cacheKey) {
      cache.set(cacheKey, cloneJson(effectiveConfig));
    }

    return cloneJson(effectiveConfig);
  }

  function invalidateCache(repoPath) {
    if (typeof repoPath !== 'string' || !repoPath.trim()) {
      return false;
    }

    return cache.delete(path.resolve(repoPath));
  }

  return {
    cache,
    getBuiltInDefaults,
    getGlobalDefaults,
    getEffectiveConfig,
    invalidateCache,
  };
}

module.exports = { createConfigResolver };
