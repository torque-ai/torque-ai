'use strict';

const VALID_MODES = ['block', 'warn', 'shadow', 'off'];

const BUILTIN_RULES = Object.freeze([
  Object.freeze({
    id: 'block-visible-providers',
    name: 'block-visible-providers',
    description: 'Prevent task submission from using visible providers that must remain blocked.',
    stage: 'task_submit',
    default_mode: 'block',
    checker_id: 'checkVisibleProvider',
    config: { providers: ['codex', 'claude-cli'] },
  }),
  Object.freeze({
    id: 'inspect-before-cancel',
    name: 'inspect-before-cancel',
    description: 'Require an inspection pass before a task can be cancelled.',
    stage: 'task_cancel',
    default_mode: 'block',
    checker_id: 'checkInspectedBeforeCancel',
    config: null,
  }),
  Object.freeze({
    id: 'require-push-before-remote',
    name: 'require-push-before-remote',
    description: 'Warn before remote execution when the local branch has not been pushed.',
    stage: 'task_pre_execute',
    default_mode: 'warn',
    checker_id: 'checkPushedBeforeRemote',
    config: null,
  }),
  Object.freeze({
    id: 'no-local-tests',
    name: 'no-local-tests',
    description: 'Warn when local test commands are attempted before remote execution.',
    stage: 'task_pre_execute',
    default_mode: 'warn',
    checker_id: 'checkNoLocalTests',
    config: { commands: ['vitest', 'jest', 'pytest', 'dotnet test'] },
  }),
  Object.freeze({
    id: 'verify-diff-after-codex',
    name: 'verify-diff-after-codex',
    description: 'Warn when Codex task completion is not followed by a diff verification step.',
    stage: 'task_complete',
    default_mode: 'warn',
    checker_id: 'checkDiffAfterCodex',
    config: null,
  }),
]);

function validateDb(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new Error('governance-rules requires a better-sqlite3 database instance');
  }
}

function parseConfig(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function serializeConfig(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizeMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (!VALID_MODES.includes(normalized)) {
    throw new Error(`Invalid governance rule mode: ${mode}`);
  }
  return normalized;
}

function hydrateRuleRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    enabled: Boolean(row.enabled),
    config: parseConfig(row.config),
  };
}

function createGovernanceRules({ db }) {
  validateDb(db);

  const insertBuiltinStmt = db.prepare(`
    INSERT OR IGNORE INTO governance_rules (
      id,
      name,
      description,
      stage,
      mode,
      default_mode,
      enabled,
      violation_count,
      checker_id,
      config,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectAllStmt = db.prepare('SELECT * FROM governance_rules ORDER BY stage ASC, name ASC');
  const selectByIdStmt = db.prepare('SELECT * FROM governance_rules WHERE id = ?');
  const selectActiveByStageStmt = db.prepare(`
    SELECT * FROM governance_rules
    WHERE stage = ? AND enabled = 1
    ORDER BY name ASC
  `);
  const updateModeStmt = db.prepare(`
    UPDATE governance_rules
    SET mode = ?, updated_at = ?
    WHERE id = ?
  `);
  const toggleRuleStmt = db.prepare(`
    UPDATE governance_rules
    SET enabled = ?, updated_at = ?
    WHERE id = ?
  `);
  const incrementViolationStmt = db.prepare(`
    UPDATE governance_rules
    SET violation_count = violation_count + 1, updated_at = ?
    WHERE id = ?
  `);
  const resetViolationsStmt = db.prepare(`
    UPDATE governance_rules
    SET violation_count = 0, updated_at = ?
  `);

  const seedBuiltinRulesTx = db.transaction(() => {
    let inserted = 0;

    for (const rule of BUILTIN_RULES) {
      const now = new Date().toISOString();
      const result = insertBuiltinStmt.run(
        rule.id,
        rule.name,
        rule.description,
        rule.stage,
        rule.mode || rule.default_mode || 'warn',
        rule.default_mode || 'warn',
        rule.enabled === false ? 0 : 1,
        rule.violation_count || 0,
        rule.checker_id,
        serializeConfig(rule.config),
        now,
        now,
      );
      inserted += result.changes;
    }

    return inserted;
  });

  function seedBuiltinRules() {
    return seedBuiltinRulesTx();
  }

  function getAllRules() {
    return selectAllStmt.all().map(hydrateRuleRow);
  }

  function getRule(id) {
    return hydrateRuleRow(selectByIdStmt.get(id) || null);
  }

  function getActiveRulesForStage(stage) {
    return selectActiveByStageStmt.all(stage).map(hydrateRuleRow);
  }

  function updateRuleMode(id, mode) {
    const normalizedMode = normalizeMode(mode);
    const now = new Date().toISOString();
    const result = updateModeStmt.run(normalizedMode, now, id);
    if (!result.changes) {
      return null;
    }
    return getRule(id);
  }

  function toggleRule(id, enabled) {
    const existing = getRule(id);
    if (!existing) {
      return null;
    }

    const nextEnabled = enabled === undefined ? !existing.enabled : Boolean(enabled);
    toggleRuleStmt.run(nextEnabled ? 1 : 0, new Date().toISOString(), id);
    return getRule(id);
  }

  function incrementViolation(id) {
    const result = incrementViolationStmt.run(new Date().toISOString(), id);
    if (!result.changes) {
      return null;
    }
    return getRule(id);
  }

  function resetViolationCounts() {
    return resetViolationsStmt.run(new Date().toISOString()).changes;
  }

  return {
    seedBuiltinRules,
    getAllRules,
    getRule,
    getActiveRulesForStage,
    updateRuleMode,
    toggleRule,
    incrementViolation,
    resetViolationCounts,
  };
}

module.exports = {
  createGovernanceRules,
  BUILTIN_RULES,
  VALID_MODES,
};
