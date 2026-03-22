'use strict';

const { safeJsonParse } = require('../utils/json');
const matchers = require('./matchers');

let db;
let getProjectMetadata = null;

const POLICY_MODES = new Set(['off', 'shadow', 'advisory', 'warn', 'block']);

function setDb(dbInstance) {
  db = dbInstance;
}

function setGetProjectMetadata(fn) {
  getProjectMetadata = typeof fn === 'function' ? fn : null;
}

// Keep the local wrapper because this store persists undefined as null.
function safeJsonStringify(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value, fallback) {
  if (value === undefined) return fallback;
  return safeJsonParse(safeJsonStringify(value), fallback);
}

function mergePlainObjects(baseValue, overrideValue) {
  const base = isPlainObject(baseValue) ? cloneJson(baseValue, {}) : {};
  const override = isPlainObject(overrideValue) ? overrideValue : {};
  const merged = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = mergePlainObjects(base[key], value);
    } else {
      merged[key] = cloneJson(value, value);
    }
  }

  return merged;
}

function normalizeEnabled(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'object' && value !== null) return false;
  if (typeof value === 'string') {
    return !['0', 'false', 'off', 'disabled'].includes(value.trim().toLowerCase());
  }
  return value !== false;
}

function normalizeMode(value, fallback = 'advisory') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return POLICY_MODES.has(normalized) ? normalized : fallback;
}

function hydratePolicyProfile(row) {
  if (!row) return null;

  const profileJson = safeJsonParse(row.profile_json, {});
  const defaults = safeJsonParse(row.defaults_json, profileJson.defaults || {});
  const policyOverrides = cloneJson(
    profileJson.policy_overrides || profileJson.policyOverrides || {},
    {},
  );
  const projectMatch = cloneJson(
    profileJson.project_match || profileJson.projectMatch || {},
    {},
  );

  return {
    ...row,
    enabled: Boolean(row.enabled),
    defaults,
    profile_json: profileJson,
    policy_overrides: policyOverrides,
    project_match: projectMatch,
  };
}

function hydratePolicyRule(row) {
  if (!row) return null;

  return {
    ...row,
    enabled: Boolean(row.enabled),
    mode: normalizeMode(row.mode),
    priority: Number.isFinite(row.priority) ? row.priority : Number(row.priority || 100),
    matcher: safeJsonParse(row.matcher_json, {}),
    required_evidence: safeJsonParse(row.required_evidence_json, []),
    actions: safeJsonParse(row.actions_json, []),
    override_policy: safeJsonParse(row.override_policy_json, {}),
    tags: safeJsonParse(row.tags_json, []),
  };
}

function hydratePolicyBinding(row) {
  if (!row) return null;

  return {
    ...row,
    enabled: Boolean(row.enabled),
    binding_json: safeJsonParse(row.binding_json, {}),
  };
}

function listPolicyProfiles(options = {}) {
  if (!db) throw new Error('Policy profile store is not initialized');

  const clauses = [];
  const params = [];

  if (options.project) {
    clauses.push('project = ?');
    params.push(options.project);
  }
  if (options.enabled_only) {
    clauses.push('enabled = 1');
  } else if (options.enabled !== undefined) {
    clauses.push('enabled = ?');
    params.push(options.enabled ? 1 : 0);
  }

  let sql = 'SELECT * FROM policy_profiles';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ' ORDER BY updated_at DESC, created_at DESC, id ASC';

  return db.prepare(sql).all(...params).map(hydratePolicyProfile);
}

function getPolicyProfile(profileId) {
  if (!db) throw new Error('Policy profile store is not initialized');
  return hydratePolicyProfile(
    db.prepare('SELECT * FROM policy_profiles WHERE id = ?').get(profileId),
  );
}

function savePolicyProfile(profile) {
  if (!db) throw new Error('Policy profile store is not initialized');
  if (!profile || typeof profile !== 'object') {
    throw new Error('profile must be an object');
  }
  if (!profile.id || typeof profile.id !== 'string') {
    throw new Error('profile.id is required');
  }
  if (!profile.name || typeof profile.name !== 'string') {
    throw new Error('profile.name is required');
  }

  const now = new Date().toISOString();
  const current = getPolicyProfile(profile.id);
  const baseProfileJson = isPlainObject(profile.profile_json) ? cloneJson(profile.profile_json, {}) : {};
  const mergedProfileJson = mergePlainObjects(baseProfileJson, {
    profile_id: profile.id,
    name: profile.name,
    project_match: profile.project_match,
    defaults: profile.defaults,
    policy_overrides: profile.policy_overrides,
  });

  db.prepare(`
    INSERT INTO policy_profiles (
      id, name, project, description, defaults_json, profile_json, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      project = excluded.project,
      description = excluded.description,
      defaults_json = excluded.defaults_json,
      profile_json = excluded.profile_json,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(
    profile.id,
    profile.name,
    profile.project || null,
    profile.description || null,
    safeJsonStringify(profile.defaults || mergedProfileJson.defaults || {}),
    safeJsonStringify(mergedProfileJson || {}),
    normalizeEnabled(profile.enabled) ? 1 : 0,
    current?.created_at || now,
    now,
  );

  return getPolicyProfile(profile.id);
}

function listPolicyRules(options = {}) {
  if (!db) throw new Error('Policy profile store is not initialized');

  const clauses = [];
  const params = [];

  if (options.stage) {
    clauses.push('stage = ?');
    params.push(String(options.stage).trim());
  }
  if (options.category) {
    clauses.push('category = ?');
    params.push(String(options.category).trim());
  }
  if (options.policy_id) {
    clauses.push('id = ?');
    params.push(String(options.policy_id).trim());
  }
  if (options.enabled_only) {
    clauses.push('enabled = 1');
  } else if (options.enabled !== undefined) {
    clauses.push('enabled = ?');
    params.push(options.enabled ? 1 : 0);
  }

  let sql = 'SELECT * FROM policy_rules';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ' ORDER BY priority ASC, updated_at DESC, id ASC';

  return db.prepare(sql).all(...params).map(hydratePolicyRule);
}

function getPolicyRule(policyId) {
  if (!db) throw new Error('Policy profile store is not initialized');
  return hydratePolicyRule(
    db.prepare('SELECT * FROM policy_rules WHERE id = ?').get(policyId),
  );
}

function savePolicyRule(rule) {
  if (!db) throw new Error('Policy profile store is not initialized');
  if (!rule || typeof rule !== 'object') {
    throw new Error('rule must be an object');
  }
  if (!rule.id || typeof rule.id !== 'string') {
    throw new Error('rule.id is required');
  }
  if (!rule.name || typeof rule.name !== 'string') {
    throw new Error('rule.name is required');
  }
  if (!rule.category || typeof rule.category !== 'string') {
    throw new Error('rule.category is required');
  }
  if (!rule.stage || typeof rule.stage !== 'string') {
    throw new Error('rule.stage is required');
  }

  const now = new Date().toISOString();
  const current = getPolicyRule(rule.id);

  db.prepare(`
    INSERT INTO policy_rules (
      id, name, category, stage, mode, priority, enabled, matcher_json,
      required_evidence_json, actions_json, override_policy_json, tags_json, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      stage = excluded.stage,
      mode = excluded.mode,
      priority = excluded.priority,
      enabled = excluded.enabled,
      matcher_json = excluded.matcher_json,
      required_evidence_json = excluded.required_evidence_json,
      actions_json = excluded.actions_json,
      override_policy_json = excluded.override_policy_json,
      tags_json = excluded.tags_json,
      version = excluded.version,
      updated_at = excluded.updated_at
  `).run(
    rule.id,
    rule.name,
    rule.category,
    String(rule.stage).trim(),
    normalizeMode(rule.mode),
    Number.isFinite(rule.priority) ? rule.priority : Number(rule.priority || 100),
    normalizeEnabled(rule.enabled) ? 1 : 0,
    safeJsonStringify(rule.matcher || {}),
    safeJsonStringify(rule.required_evidence || []),
    safeJsonStringify(rule.actions || []),
    safeJsonStringify(rule.override_policy || {}),
    safeJsonStringify(rule.tags || []),
    rule.version || null,
    current?.created_at || now,
    now,
  );

  return getPolicyRule(rule.id);
}

function listPolicyBindings(options = {}) {
  if (!db) throw new Error('Policy profile store is not initialized');

  const clauses = [];
  const params = [];

  if (options.profile_id) {
    clauses.push('profile_id = ?');
    params.push(String(options.profile_id).trim());
  }
  if (options.policy_id) {
    clauses.push('policy_id = ?');
    params.push(String(options.policy_id).trim());
  }
  if (options.enabled_only) {
    clauses.push('enabled = 1');
  } else if (options.enabled !== undefined) {
    clauses.push('enabled = ?');
    params.push(options.enabled ? 1 : 0);
  }

  let sql = 'SELECT * FROM policy_bindings';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ' ORDER BY updated_at DESC, created_at DESC, id ASC';

  return db.prepare(sql).all(...params).map(hydratePolicyBinding);
}

function getPolicyBinding(profileId, policyId) {
  if (!db) throw new Error('Policy profile store is not initialized');
  return hydratePolicyBinding(
    db.prepare('SELECT * FROM policy_bindings WHERE profile_id = ? AND policy_id = ?').get(profileId, policyId),
  );
}

function savePolicyBinding(binding) {
  if (!db) throw new Error('Policy profile store is not initialized');
  if (!binding || typeof binding !== 'object') {
    throw new Error('binding must be an object');
  }
  if (!binding.id || typeof binding.id !== 'string') {
    throw new Error('binding.id is required');
  }
  if (!binding.profile_id || typeof binding.profile_id !== 'string') {
    throw new Error('binding.profile_id is required');
  }
  if (!binding.policy_id || typeof binding.policy_id !== 'string') {
    throw new Error('binding.policy_id is required');
  }

  const now = new Date().toISOString();
  const current = getPolicyBinding(binding.profile_id, binding.policy_id);

  db.prepare(`
    INSERT INTO policy_bindings (
      id, profile_id, policy_id, mode_override, binding_json, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, policy_id) DO UPDATE SET
      id = excluded.id,
      mode_override = excluded.mode_override,
      binding_json = excluded.binding_json,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(
    binding.id,
    binding.profile_id,
    binding.policy_id,
    binding.mode_override ? normalizeMode(binding.mode_override, binding.mode_override) : null,
    safeJsonStringify(binding.binding_json || binding.binding || {}),
    normalizeEnabled(binding.enabled) ? 1 : 0,
    current?.created_at || now,
    now,
  );

  return getPolicyBinding(binding.profile_id, binding.policy_id);
}

function normalizeProjectKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
}

function isGlobalProfile(profile) {
  return !profile?.project
    && (!profile?.project_match || Object.keys(profile.project_match).length === 0);
}

function resolveBoundProfileId(projectId) {
  if (!projectId) return null;

  if (typeof getProjectMetadata === 'function') {
    const value = getProjectMetadata(projectId, 'policy_profile_id');
    if (value) {
      return String(value).trim();
    }

    const normalizedProjectId = normalizeProjectKey(projectId);
    if (normalizedProjectId && normalizedProjectId !== projectId) {
      const normalizedValue = getProjectMetadata(normalizedProjectId, 'policy_profile_id');
      return normalizedValue ? String(normalizedValue).trim() : null;
    }
    return null;
  }

  const row = db.prepare(
    'SELECT value FROM project_metadata WHERE project = ? COLLATE NOCASE AND key = ?',
  ).get(projectId, 'policy_profile_id');
  return row?.value ? String(row.value).trim() : null;
}

function matchesProfile(profile, context) {
  if (!profile?.enabled) return false;

  if (
    profile.project
    && normalizeProjectKey(profile.project)
    && normalizeProjectKey(context.project_id)
    && normalizeProjectKey(profile.project) === normalizeProjectKey(context.project_id)
  ) {
    return true;
  }

  const projectMatch = profile.project_match || {};
  if (Object.keys(projectMatch).length > 0) {
    return matchers.evaluateMatcher(projectMatch, {
      project_path: context.project_path,
      provider: context.provider,
      changed_files: context.changed_files,
      target_type: context.target_type,
    }).state === 'match';
  }

  return !profile.project;
}

function resolveApplicableProfiles(options = {}) {
  const explicitProfileId = options.profile_id || options.profileId || null;
  if (explicitProfileId) {
    const profile = getPolicyProfile(explicitProfileId);
    if (profile && (options.include_disabled || profile.enabled)) {
      return [profile];
    }
    return [];
  }

  const projectId = options.project_id || options.projectId || null;
  const projectPath = options.project_path || options.projectPath || null;
  const candidates = listPolicyProfiles({ enabled_only: options.include_disabled ? false : true });
  const context = {
    project_id: projectId,
    project_path: projectPath,
    provider: options.provider || null,
    changed_files: options.changed_files || options.changedFiles || null,
    target_type: options.target_type || options.targetType || null,
  };

  const applicableProfiles = [];
  const globalProfile = candidates.find((profile) => isGlobalProfile(profile));
  if (globalProfile) {
    applicableProfiles.push(globalProfile);
  }

  let projectProfile = null;
  const boundProfileId = resolveBoundProfileId(projectId);
  if (boundProfileId) {
    const boundProfile = getPolicyProfile(boundProfileId);
    if (boundProfile && (options.include_disabled || boundProfile.enabled)) {
      projectProfile = boundProfile;
    }
  }

  if (!projectProfile) {
    projectProfile = candidates.find(
      (profile) => profile.project && projectId && normalizeProjectKey(profile.project) === normalizeProjectKey(projectId),
    ) || null;
  }

  if (!projectProfile) {
    projectProfile = candidates.find(
      (profile) => matchesProfile(profile, context) && profile.project_match && Object.keys(profile.project_match).length > 0,
    ) || null;
  }

  if (projectProfile && !applicableProfiles.some((profile) => profile.id === projectProfile.id)) {
    applicableProfiles.push(projectProfile);
  }

  return applicableProfiles;
}

function resolvePolicyProfile(options = {}) {
  const applicableProfiles = resolveApplicableProfiles(options);
  return applicableProfiles[applicableProfiles.length - 1] || null;
}

function buildEffectiveRule(rule, binding, profile) {
  const profileOverride = cloneJson(profile?.policy_overrides?.[rule.id], {});
  const bindingOverride = cloneJson(binding?.binding_json, {});
  const defaults = isPlainObject(profile?.defaults) ? profile.defaults : {};

  const effectiveMatcher = mergePlainObjects(
    mergePlainObjects(rule.matcher, profileOverride.matcher),
    bindingOverride.matcher,
  );
  const effectiveOverridePolicy = mergePlainObjects(
    mergePlainObjects(rule.override_policy, profileOverride.override_policy),
    bindingOverride.override_policy,
  );
  const requiredEvidence = bindingOverride.required_evidence
    ?? profileOverride.required_evidence
    ?? rule.required_evidence
    ?? [];
  const actions = bindingOverride.actions
    ?? profileOverride.actions
    ?? rule.actions
    ?? [];
  const tags = bindingOverride.tags
    ?? profileOverride.tags
    ?? rule.tags
    ?? [];

  return {
    ...rule,
    policy_id: rule.id,
    profile_id: profile?.id || null,
    binding_id: binding?.id || null,
    mode: normalizeMode(
      binding?.mode_override
        || profileOverride.mode
        || rule.mode
        || defaults.mode
        || 'advisory',
    ),
    enabled: normalizeEnabled(
      bindingOverride.enabled ?? profileOverride.enabled ?? rule.enabled,
    ),
    matcher: effectiveMatcher,
    required_evidence: cloneJson(requiredEvidence, []),
    actions: cloneJson(actions, []),
    override_policy: effectiveOverridePolicy,
    tags: cloneJson(tags, []),
  };
}

function resolvePoliciesForStage(options = {}) {
  const stage = String(options.stage || '').trim();
  if (!stage) {
    throw new Error('stage is required to resolve bound policies');
  }

  const profiles = options.profile
    ? [options.profile]
    : resolveApplicableProfiles(options);
  if (!profiles.length) return [];

  const allRules = new Map(
    listPolicyRules({ stage, enabled_only: false }).map((rule) => [rule.id, rule]),
  );
  const effectiveRules = new Map();

  for (const profile of profiles) {
    const bindings = listPolicyBindings({ profile_id: profile.id, enabled_only: true });
    for (const binding of bindings) {
      const rule = allRules.get(binding.policy_id);
      if (!rule) continue;

      const effectiveRule = buildEffectiveRule(rule, binding, profile);
      if (!effectiveRule.enabled) continue;
      effectiveRules.set(effectiveRule.id, effectiveRule);
    }
  }

  return [...effectiveRules.values()].sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    return left.id.localeCompare(right.id);
  });
}

// ============================================================
// Factory function (dependency injection without singletons)
// ============================================================

function createPolicyProfileStore({ db: dbInstance, getProjectMetadata: getMetaFn } = {}) {
  if (dbInstance) setDb(dbInstance);
  if (getMetaFn) setGetProjectMetadata(getMetaFn);
  return module.exports;
}

module.exports = {
  setDb,
  setGetProjectMetadata,
  createPolicyProfileStore,
  listPolicyProfiles,
  getPolicyProfile,
  savePolicyProfile,
  listPolicyRules,
  getPolicyRule,
  savePolicyRule,
  listPolicyBindings,
  getPolicyBinding,
  savePolicyBinding,
  resolveApplicableProfiles,
  resolvePolicyProfile,
  resolvePoliciesForStage,
  buildEffectiveRule,
};
