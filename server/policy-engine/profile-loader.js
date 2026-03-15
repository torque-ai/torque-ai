'use strict';

const fs = require('fs');
const path = require('path');
const profileStore = require('./profile-store');
const logger = require('../logger').child({ component: 'policy-profile-loader' });

function normalizeExclusions(exclusions) {
  if (!Array.isArray(exclusions)) return [];
  return exclusions
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function applySeedExclusions(matcher, exclusions) {
  const normalizedMatcher = matcher && typeof matcher === 'object'
    ? { ...matcher }
    : {};

  if (exclusions.length === 0) {
    return normalizedMatcher;
  }

  const existing = Array.isArray(normalizedMatcher.exclude_globs_any)
    ? normalizedMatcher.exclude_globs_any
    : [];

  return {
    ...normalizedMatcher,
    exclude_globs_any: [...new Set([...existing, ...exclusions])],
  };
}

function loadProfileSeed(seedPath) {
  if (!fs.existsSync(seedPath)) {
    logger.warn(`Profile seed not found: ${seedPath}`);
    return null;
  }

  const raw = fs.readFileSync(seedPath, 'utf8');
  return JSON.parse(raw);
}

function applyProfileSeed(seed) {
  if (!seed || !seed.profile) {
    throw new Error('Invalid profile seed: missing profile section');
  }

  const exclusions = normalizeExclusions(seed.exclusions);
  const profile = profileStore.savePolicyProfile({
    id: seed.profile.id,
    name: seed.profile.name,
    description: seed.profile.description || '',
    project: seed.profile.project || null,
    enabled: seed.profile.enabled !== false,
    defaults: seed.profile.defaults || {},
    profile_json: {
      ...seed.profile,
      exclusions,
    },
  });
  logger.info(`Loaded policy profile: ${profile.id} (${profile.name})`);

  const savedRules = [];
  for (const rule of seed.rules || []) {
    const saved = profileStore.savePolicyRule({
      id: rule.id,
      name: rule.name,
      category: rule.category,
      stage: rule.stage,
      mode: rule.mode || 'advisory',
      priority: rule.priority || 100,
      enabled: rule.enabled !== false,
      matcher: applySeedExclusions(rule.matcher, exclusions),
      required_evidence: rule.required_evidence || [],
      actions: rule.actions || [],
      override_policy: rule.override_policy || {},
      tags: rule.tags || [],
    });
    savedRules.push(saved);
  }
  logger.info(`Loaded ${savedRules.length} policy rules`);

  const savedBindings = [];
  for (const binding of seed.bindings || []) {
    const saved = profileStore.savePolicyBinding({
      id: binding.id || `${seed.profile.id}:${binding.policy_id}`,
      profile_id: seed.profile.id,
      policy_id: binding.policy_id,
      mode_override: binding.mode_override || null,
      enabled: binding.enabled !== false,
    });
    savedBindings.push(saved);
  }
  logger.info(`Loaded ${savedBindings.length} policy bindings`);

  return { profile, rules: savedRules, bindings: savedBindings };
}

function loadTorqueDefaults(projectRoot) {
  const seedPath = path.join(
    projectRoot || process.cwd(),
    'artifacts',
    'policy',
    'config',
    'torque-dev-policy.seed.json',
  );
  const seed = loadProfileSeed(seedPath);
  if (!seed) return null;
  return applyProfileSeed(seed);
}

module.exports = {
  loadProfileSeed,
  applyProfileSeed,
  loadTorqueDefaults,
};
