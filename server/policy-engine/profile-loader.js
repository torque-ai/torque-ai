'use strict';

const fs = require('fs');
const path = require('path');
const profileStore = require('./profile-store');
const logger = require('../logger').child({ component: 'policy-profile-loader' });

const DEFAULT_PROFILES = [
  {
    id: 'strict-typescript',
    name: 'Strict TypeScript',
    description: 'Prepends strict TypeScript instructions to tasks in TypeScript projects',
    enabled: false,
    matchers: [
      { type: 'project_has_file', file: 'tsconfig.json' },
    ],
    effects: [
      {
        effect: 'rewrite_description',
        prepend: 'IMPORTANT: This project uses strict TypeScript with noImplicitAny and strictNullChecks. Always declare explicit types for function parameters and return values. Never use `any` type.',
        append: 'Before finishing, run: npx tsc --noEmit to verify type correctness.',
      },
    ],
  },
  {
    id: 'output-cap',
    name: 'Output Size Cap',
    description: 'Compresses task output to 500 lines for free providers to save storage',
    enabled: false,
    matchers: [
      { type: 'provider_in', providers: ['ollama', 'groq', 'cerebras'] },
    ],
    effects: [
      {
        effect: 'compress_output',
        max_lines: 500,
        keep: 'last',
        summary_header: '[Output truncated to last 500 lines by output-cap policy]',
      },
    ],
  },
  {
    id: 'security-review-trigger',
    name: 'Security Review Trigger',
    description: 'Triggers file risk assessment when task mentions security-sensitive keywords',
    enabled: false,
    matchers: [
      { type: 'description_matches', pattern: 'auth|security|permission|credential|token|password|encrypt|secret' },
    ],
    effects: [
      {
        effect: 'rewrite_description',
        append: 'SECURITY NOTE: This task involves security-sensitive code. Double-check for: hardcoded secrets, injection vulnerabilities, proper input validation, and secure defaults.',
      },
    ],
  },
];

function normalizeProfileMatchers(matchers = []) {
  const normalized = {
    project_has_file: [],
    provider_in: [],
    description_matches: [],
  };

  if (!Array.isArray(matchers)) {
    return normalized;
  }

  for (const matcher of matchers) {
    if (!matcher || typeof matcher !== 'object') {
      continue;
    }

    const matcherType = String(matcher.type || '').trim().toLowerCase();

    if (matcherType === 'project_has_file') {
      if (matcher.file) {
        normalized.project_has_file.push(String(matcher.file).trim());
      }
      continue;
    }

    if (matcherType === 'provider_in') {
      const providers = Array.isArray(matcher.providers) ? matcher.providers : [matcher.providers];
      for (const provider of providers) {
        if (provider !== undefined && provider !== null) {
          const normalizedProvider = String(provider).trim().toLowerCase();
          if (normalizedProvider) {
            normalized.provider_in.push(normalizedProvider);
          }
        }
      }
      continue;
    }

    if (matcherType === 'description_matches') {
      if (matcher.pattern) {
        normalized.description_matches.push(String(matcher.pattern).trim());
      }
      continue;
    }
  }

  return {
    project_has_file: normalized.project_has_file.filter(Boolean),
    provider_in: [...new Set(normalized.provider_in.map((provider) => String(provider).trim().toLowerCase()))],
    description_matches: normalized.description_matches.filter(Boolean),
  };
}

function normalizeProfileEffects(effects = []) {
  if (!Array.isArray(effects)) return [];

  return effects
    .map((effect) => {
      if (!effect || typeof effect !== 'object') return null;
      const effectType = effect.type || effect.effect;
      if (!effectType) return null;
      return {
        type: effectType,
        ...effect,
      };
    })
    .filter(Boolean);
}

function buildBuiltinProfileSeed(profile) {
  const ruleId = `${profile.id}:builtin-rule`;
  const matcher = {};
  const normalizedMatchers = normalizeProfileMatchers(profile.matchers);

  if (normalizedMatchers.project_has_file.length > 0) {
    matcher.project_has_file = normalizedMatchers.project_has_file;
  }

  if (normalizedMatchers.provider_in.length > 0) {
    matcher.provider_in = normalizedMatchers.provider_in;
  }

  if (normalizedMatchers.description_matches.length > 0) {
    matcher.description_matches = normalizedMatchers.description_matches;
  }

  return {
    profile: {
      id: profile.id,
      name: profile.name,
      description: profile.description || '',
      enabled: false,
      defaults: {},
    },
    exclusions: [],
    rules: [
      {
        id: ruleId,
        name: `${profile.name} effect`,
        category: 'policy',
        stage: profile.id === 'output-cap' ? 'task_complete' : 'task_submit',
        mode: 'advisory',
        priority: 100,
        enabled: true,
        matcher,
        required_evidence: [],
        actions: [],
        override_policy: {
          active_effects: normalizeProfileEffects(profile.effects),
        },
        tags: ['builtin'],
      },
    ],
    bindings: [
      {
        id: `${profile.id}:binding`,
        policy_id: ruleId,
      },
    ],
  };
}

function loadBuiltinProfiles() {
  const loaded = [];

  for (const profile of DEFAULT_PROFILES) {
    const seed = buildBuiltinProfileSeed(profile);
    loaded.push(applyProfileSeed(seed));
  }

  return loaded;
}

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

  try {
    const raw = fs.readFileSync(seedPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    logger.error('Failed to parse profile seed ' + seedPath + ': ' + err.message);
    return null;
  }
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
  loadBuiltinProfiles();

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
