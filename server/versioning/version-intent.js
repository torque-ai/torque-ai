'use strict';

const VALID_INTENTS = new Set(['feature', 'fix', 'breaking', 'internal']);

const INTENT_PRIORITY = { breaking: 3, feature: 2, fix: 1, internal: 0 };

const INTENT_TO_BUMP = { breaking: 'major', feature: 'minor', fix: 'patch', internal: null };

const CONVENTIONAL_PREFIX_MAP = {
  feat: 'feature',
  fix: 'fix',
  refactor: 'internal',
  docs: 'internal',
  test: 'internal',
  chore: 'internal',
  style: 'internal',
  perf: 'fix',
  ci: 'internal',
  build: 'internal',
};

function isValidIntent(intent) {
  return VALID_INTENTS.has(intent);
}

function validateVersionIntent(intent) {
  if (!intent || typeof intent !== 'string') {
    return { valid: false, error: 'version_intent is required. Use: feature, fix, breaking, or internal' };
  }
  const normalized = intent.trim().toLowerCase();
  if (!VALID_INTENTS.has(normalized)) {
    return { valid: false, error: `Invalid version_intent "${intent}". Use: feature, fix, breaking, or internal` };
  }
  return { valid: true, intent: normalized };
}

function normalizePath(p) {
  return p ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
}

/**
 * Resolve a working directory to its registered project path.
 * Tries: exact match → normalized match → basename match.
 * Returns the registered project path or null.
 */
function resolveVersionedProject(db, workingDirectory) {
  if (!workingDirectory) return null;
  try {
    // 1. Exact match
    const exact = db.prepare(
      "SELECT project FROM project_metadata WHERE project = ? AND key = 'versioning_enabled' AND (value = '1' OR value = 'true')"
    ).get(workingDirectory);
    if (exact) return exact.project;

    // 2. Normalized path match (slash direction, trailing slash, case)
    const norm = normalizePath(workingDirectory);
    const all = db.prepare(
      "SELECT DISTINCT project FROM project_metadata WHERE key = 'versioning_enabled' AND (value = '1' OR value = 'true')"
    ).all();
    for (const row of all) {
      if (normalizePath(row.project) === norm) return row.project;
    }

    // 3. Basename match (Codex sandbox: different parent, same project dir name)
    const basename = norm.split('/').filter(Boolean).pop();
    if (basename) {
      for (const row of all) {
        const regBasename = normalizePath(row.project).split('/').filter(Boolean).pop();
        if (regBasename === basename) return row.project;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function isProjectVersioned(db, workingDirectory) {
  return !!resolveVersionedProject(db, workingDirectory);
}

function getVersioningConfig(db, workingDirectory) {
  if (!workingDirectory) return null;
  const resolved = resolveVersionedProject(db, workingDirectory);
  if (!resolved) return null;
  try {
    const rows = db.prepare(
      "SELECT key, value FROM project_metadata WHERE project = ? AND key LIKE 'versioning_%'"
    ).all(resolved);
    if (rows.length === 0) return null;
    const config = {};
    for (const row of rows) {
      const shortKey = row.key.replace('versioning_', '');
      config[shortKey] = row.value;
    }
    config.enabled = config.enabled === '1' || config.enabled === 'true';
    config.auto_push = config.auto_push === '1' || config.auto_push === 'true';
    config.start = config.start || '0.1.0';
    return config;
  } catch {
    return null;
  }
}

function inferIntentFromCommitMessage(message) {
  if (!message || typeof message !== 'string') return 'internal';
  if (/BREAKING CHANGE|BREAKING:/i.test(message)) return 'breaking';
  const match = /^([a-z]+)(?:\([^)]+\))?!?:/i.exec(message.trim());
  if (match) {
    const prefix = match[1].toLowerCase();
    if (match[0].includes('!')) return 'breaking';
    return CONVENTIONAL_PREFIX_MAP[prefix] || 'internal';
  }
  return 'internal';
}

function highestIntent(intents) {
  let max = 'internal';
  for (const intent of intents) {
    if ((INTENT_PRIORITY[intent] || 0) > (INTENT_PRIORITY[max] || 0)) {
      max = intent;
    }
  }
  return max;
}

function intentToBump(intent) {
  return INTENT_TO_BUMP[intent] || null;
}

module.exports = {
  VALID_INTENTS,
  INTENT_PRIORITY,
  isValidIntent,
  validateVersionIntent,
  isProjectVersioned,
  resolveVersionedProject,
  getVersioningConfig,
  inferIntentFromCommitMessage,
  highestIntent,
  intentToBump,
};
