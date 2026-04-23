'use strict';

const { BATCH_TEST_FIXES_RULE } = require('../governance/rules/batch-test-fixes');

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
  Object.freeze({
    id: 'no-process-kill',
    name: 'no-process-kill',
    description: 'Block kill/taskkill/Stop-Process commands without explicit user approval. Use cancel_task or cancel_workflow instead.',
    stage: 'command_execute',
    default_mode: 'block',
    checker_id: 'checkNoProcessKill',
    config: { commands: ['kill', 'taskkill', 'Stop-Process', 'pkill', 'killall'] },
  }),
  Object.freeze({
    id: 'no-direct-db-access',
    name: 'no-direct-db-access',
    description: 'Block direct database access (sqlite3, raw file reads). Use MCP tools or REST API instead.',
    stage: 'command_execute',
    default_mode: 'block',
    checker_id: 'checkNoDirectDbAccess',
    config: { patterns: ['sqlite3', '.torque/torque.db', 'better-sqlite3'] },
  }),
  Object.freeze({
    id: 'no-foreground-bash',
    name: 'no-foreground-bash',
    description: 'Warn when foreground bash/cmd windows are opened. Use MCP tools or run_in_background instead.',
    stage: 'command_execute',
    default_mode: 'warn',
    checker_id: 'checkNoForegroundBash',
    config: null,
  }),
  Object.freeze({
    id: 'require-worktree-for-features',
    name: 'require-worktree-for-features',
    description: 'Warn when committing feature work directly to main. Use a git worktree for feature development.',
    stage: 'task_submit',
    default_mode: 'warn',
    checker_id: 'checkRequireWorktree',
    config: null,
  }),
  Object.freeze({
    id: 'update-annotations-on-tool-change',
    name: 'update-annotations-on-tool-change',
    description: 'Warn when MCP tools are added or removed without updating tool-annotations.js.',
    stage: 'task_complete',
    default_mode: 'warn',
    checker_id: 'checkAnnotationsUpdated',
    config: null,
  }),
  Object.freeze({
    id: 'require-remote-for-builds',
    name: 'require-remote-for-builds',
    description: 'Block local build/test/compile commands when a remote workstation is configured. Route via torque-remote.',
    stage: 'command_execute',
    default_mode: 'block',
    checker_id: 'checkRequireRemoteForBuilds',
    config: { commands: ['npm test', 'npx vitest', 'dotnet build', 'dotnet test', 'pwsh scripts/build.ps1', 'pwsh -file scripts/build.ps1', 'powershell scripts/build.ps1', 'powershell -file scripts/build.ps1', 'bash scripts/build.sh', 'sh scripts/build.sh', './scripts/build.sh', 'cargo build', 'go build', 'make'] },
  }),
  Object.freeze({
    id: 'push-before-subagent-tests',
    name: 'push-before-subagent-tests',
    description: 'Warn when dispatching subagents for testing without pushing to origin first.',
    stage: 'task_pre_execute',
    default_mode: 'warn',
    checker_id: 'checkPushBeforeSubagentTests',
    config: null,
  }),
  Object.freeze({
    id: 'no-force-restart',
    name: 'no-force-restart',
    description: 'Block force-restart/shutdown when tasks are running. Use await_restart to drain the pipeline first.',
    stage: 'server_restart',
    default_mode: 'block',
    checker_id: 'checkNoForceRestart',
    config: null,
  }),
  Object.freeze({
    id: 'reject-temp-files',
    name: 'reject-temp-files',
    description: 'Detect temp/debug files in task output. Shadow mode logs warnings; enforce mode flags for review.',
    stage: 'task_post_complete',
    default_mode: 'warn',
    checker_id: 'checkRejectTempFiles',
    config: null,
  }),
  Object.freeze(BATCH_TEST_FIXES_RULE),
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

function buildInsertBuiltinStmt(db) {
  return db.prepare(`
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
}

function createSeedBuiltinRulesTx(db) {
  const insertBuiltinStmt = buildInsertBuiltinStmt(db);
  return db.transaction(() => {
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
}

function seedBuiltinGovernanceRules(db) {
  validateDb(db);
  return createSeedBuiltinRulesTx(db)();
}

function createGovernanceRules({ db }) {
  validateDb(db);

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

  const seedBuiltinRulesTx = createSeedBuiltinRulesTx(db);

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
  seedBuiltinGovernanceRules,
};
