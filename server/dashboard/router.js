/**
 * Dashboard API router.
 *
 * Maps HTTP method + URL pattern to route handler functions.
 * The dispatch function is called from dashboard-server.js for all /api/ requests.
 */
const { parseQuery, parseBody, isLocalhostOrigin, sendJson, sendError } = require('./utils');

const tasks = require('./routes/tasks');
const infrastructure = require('./routes/infrastructure');
const analytics = require('./routes/analytics');
const admin = require('./routes/admin');
const governanceHandlers = require('../handlers/governance-handlers');
const { createWorktreeManager } = require('../plugins/version-control/worktree-manager');

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLocalDashboardRequest(req) {
  const remoteIp = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return LOCALHOST_IPS.has(remoteIp);
}

function isAjaxRequest(req) {
  const headers = req.headers || {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerName === 'string' && headerName.toLowerCase() === 'x-requested-with') {
      return String(headerValue).toLowerCase() === 'xmlhttprequest';
    }
  }
  return false;
}

function extractGovernancePayload(result) {
  if (result && result.structuredData && typeof result.structuredData === 'object') {
    return result.structuredData;
  }

  const text = Array.isArray(result?.content)
    ? result.content.find((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')?.text
    : null;
  if (typeof text === 'string' && text.trim().length > 0) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return result?.isError ? { error: text } : { result: text };
    }
  }

  return {};
}

function parseGovernanceConfig(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function normalizeGovernanceRuleRow(row) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  return {
    ...row,
    enabled: Boolean(row.enabled),
    config: parseGovernanceConfig(row.config),
  };
}

function resolveDashboardGovernanceDb() {
  try {
    const { defaultContainer } = require('../container');
    if (!defaultContainer || typeof defaultContainer.get !== 'function') {
      throw new Error('Container unavailable');
    }
    const db = defaultContainer.get('db');
    if (!db || typeof db.prepare !== 'function') {
      throw new Error('Governance rules not initialized');
    }
    return { db };
  } catch (error) {
    return { error };
  }
}

function resolveDashboardVersionControlDb() {
  try {
    const { defaultContainer } = require('../container');
    if (!defaultContainer || typeof defaultContainer.get !== 'function') {
      throw new Error('Container unavailable');
    }

    const dbService = defaultContainer.get('db');
    const db = dbService && typeof dbService.getDbInstance === 'function'
      ? dbService.getDbInstance()
      : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);

    if (!db || typeof db.prepare !== 'function') {
      throw new Error('Version control tables not initialized');
    }

    return { db };
  } catch (error) {
    return { error };
  }
}

function getTableColumns(db, tableName) {
  try {
    return db.prepare(`PRAGMA table_info('${tableName}')`).all().map((column) => column.name);
  } catch {
    return [];
  }
}

function hasColumn(columns, columnName) {
  return columns.length > 0 && columns.includes(columnName);
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePositiveInteger(value, fallback, options = {}) {
  const numeric = Number.parseInt(value, 10);
  const min = Number.isFinite(options.min) ? options.min : 1;
  const max = Number.isFinite(options.max) ? options.max : Number.MAX_SAFE_INTEGER;

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, numeric));
}

function normalizeVersionControlFeatureName(row) {
  const explicitFeature = normalizeOptionalString(row?.feature_name);
  if (explicitFeature) {
    return explicitFeature;
  }

  const branch = normalizeOptionalString(row?.branch)?.replace(/^refs\/heads\//, '');
  if (!branch) {
    return null;
  }

  const suffix = branch.includes('/') ? branch.split('/').pop() : branch;
  return suffix.replace(/[-_]+/g, ' ');
}

function isStaleVersionControlWorktree(row, staleDays = 7) {
  if (!row || typeof row !== 'object') {
    return false;
  }

  const status = normalizeOptionalString(row.status)?.toLowerCase() || '';
  if (status === 'merged') {
    return false;
  }

  if (row.is_stale === true || row.isStale === true) {
    return true;
  }

  const timestamp = row.last_activity_at || row.created_at;
  if (!timestamp) {
    return false;
  }

  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  return Date.now() - parsed >= staleDays * 24 * 60 * 60 * 1000;
}

function normalizeVersionControlWorktreeRow(row) {
  const isStale = isStaleVersionControlWorktree(row);
  const status = normalizeOptionalString(row?.status)?.toLowerCase() || 'unknown';

  return {
    ...row,
    feature_name: normalizeVersionControlFeatureName(row),
    commit_count: Number(row?.commit_count || 0),
    is_stale: isStale,
    display_status: status === 'active' && isStale ? 'stale' : status,
  };
}

function getVersionControlTimestampColumn(columns) {
  if (hasColumn(columns, 'generated_at')) {
    return 'generated_at';
  }

  if (hasColumn(columns, 'created_at')) {
    return 'created_at';
  }

  return null;
}

async function handleGetGovernanceRulesRoute(req, res, query) {
  const args = {};
  if (typeof query.stage === 'string' && query.stage.trim()) {
    args.stage = query.stage.trim();
  }
  if (Object.prototype.hasOwnProperty.call(query, 'enabled_only')) {
    args.enabled_only = query.enabled_only;
  }

  const result = await governanceHandlers.handleGetGovernanceRules(args);
  return sendJson(
    res,
    extractGovernancePayload(result),
    Number.isInteger(result?.status) ? result.status : (result?.isError ? 400 : 200),
  );
}

async function handlePatchGovernanceRuleRoute(req, res, _query, ruleId) {
  const body = await parseBody(req);
  if (body.mode === undefined && body.enabled === undefined) {
    return sendError(res, 'mode or enabled is required', 400);
  }

  let result = null;

  if (body.mode !== undefined) {
    result = await governanceHandlers.handleSetGovernanceRuleMode({
      rule_id: ruleId,
      mode: body.mode,
    });
    if (result?.isError) {
      return sendJson(res, extractGovernancePayload(result), result.status || 400);
    }
  }

  if (body.enabled !== undefined) {
    result = await governanceHandlers.handleToggleGovernanceRule({
      rule_id: ruleId,
      enabled: body.enabled,
    });
    if (result?.isError) {
      return sendJson(res, extractGovernancePayload(result), result.status || 400);
    }
  }

  return sendJson(res, extractGovernancePayload(result), Number.isInteger(result?.status) ? result.status : 200);
}

async function handleResetGovernanceRuleRoute(_req, res, _query, ruleId) {
  const { db, error } = resolveDashboardGovernanceDb();
  if (error) {
    return sendJson(res, {
      error: 'Governance rules not initialized',
      details: error.message,
    }, 503);
  }

  try {
    const existing = db.prepare('SELECT * FROM governance_rules WHERE id = ?').get(ruleId);
    if (!existing) {
      return sendError(res, `Governance rule not found: ${ruleId}`, 404);
    }

    db.prepare(`
      UPDATE governance_rules
      SET violation_count = 0, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), ruleId);

    const updated = db.prepare('SELECT * FROM governance_rules WHERE id = ?').get(ruleId);
    return sendJson(res, {
      reset: true,
      rule: normalizeGovernanceRuleRow(updated),
    });
  } catch (err) {
    return sendJson(res, { error: err.message }, 500);
  }
}

async function handleGetVersionControlWorktreesRoute(_req, res, query) {
  const { db, error } = resolveDashboardVersionControlDb();
  if (error) {
    return sendJson(res, {
      error: 'Version control data unavailable',
      details: error.message,
    }, 503);
  }

  const columns = getTableColumns(db, 'vc_worktrees');
  if (columns.length === 0) {
    return sendJson(res, {
      worktrees: [],
      count: 0,
      summary: {
        active_worktrees: 0,
        stale_worktrees: 0,
        policy_violations: 0,
      },
    });
  }

  try {
    const repoPath = normalizeOptionalString(query.repo_path);
    const statusFilter = normalizeOptionalString(query.status)?.toLowerCase() || null;
    const whereClauses = [];
    const params = [];

    if (repoPath) {
      whereClauses.push('repo_path = ?');
      params.push(repoPath);
    }

    if (statusFilter && statusFilter !== 'stale') {
      whereClauses.push('status = ?');
      params.push(statusFilter);
    }

    const selectColumns = [
      'id',
      'repo_path',
      'worktree_path',
      'branch',
      hasColumn(columns, 'feature_name') ? 'feature_name' : 'NULL AS feature_name',
      hasColumn(columns, 'base_branch') ? 'base_branch' : "'main' AS base_branch",
      hasColumn(columns, 'status') ? 'status' : "'active' AS status",
      hasColumn(columns, 'commit_count') ? 'COALESCE(commit_count, 0) AS commit_count' : '0 AS commit_count',
      hasColumn(columns, 'created_at') ? 'created_at' : "datetime('now') AS created_at",
      hasColumn(columns, 'last_activity_at') ? 'last_activity_at' : 'NULL AS last_activity_at',
      hasColumn(columns, 'merged_at') ? 'merged_at' : 'NULL AS merged_at',
    ].join(', ');

    const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT ${selectColumns} FROM vc_worktrees${whereSql} ORDER BY datetime(COALESCE(last_activity_at, created_at)) DESC, datetime(created_at) DESC`)
      .all(...params);

    const worktrees = rows
      .map((row) => normalizeVersionControlWorktreeRow(row))
      .filter((row) => (statusFilter === 'stale' ? row.is_stale : true));

    const summary = {
      active_worktrees: worktrees.filter((row) => row.display_status === 'active').length,
      stale_worktrees: worktrees.filter((row) => row.is_stale).length,
      policy_violations: worktrees.reduce((total, row) => total + (Number(row.policy_violations || 0) || 0), 0),
    };

    return sendJson(res, {
      worktrees,
      count: worktrees.length,
      summary,
    });
  } catch (err) {
    return sendJson(res, { error: err.message }, 500);
  }
}

async function handleGetVersionControlCommitsRoute(_req, res, query) {
  const { db, error } = resolveDashboardVersionControlDb();
  if (error) {
    return sendJson(res, {
      error: 'Version control data unavailable',
      details: error.message,
    }, 503);
  }

  const columns = getTableColumns(db, 'vc_commits');
  const timestampColumn = getVersionControlTimestampColumn(columns);
  if (columns.length === 0 || !timestampColumn) {
    return sendJson(res, { commits: [], count: 0 });
  }

  try {
    const repoPath = normalizeOptionalString(query.repo_path);
    const days = parsePositiveInteger(query.days, 7, { min: 1, max: 365 });
    const limit = parsePositiveInteger(query.limit, 50, { min: 1, max: 500 });
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const whereClauses = [`datetime(${timestampColumn}) >= datetime(?)`];
    const params = [since];

    if (repoPath) {
      whereClauses.push('repo_path = ?');
      params.push(repoPath);
    }

    const selectColumns = [
      'id',
      'repo_path',
      hasColumn(columns, 'worktree_id') ? 'worktree_id' : 'NULL AS worktree_id',
      hasColumn(columns, 'branch') ? 'branch' : 'NULL AS branch',
      hasColumn(columns, 'commit_hash') ? 'commit_hash' : 'NULL AS commit_hash',
      hasColumn(columns, 'message') ? 'message' : "'' AS message",
      hasColumn(columns, 'commit_type') ? 'commit_type' : "'chore' AS commit_type",
      hasColumn(columns, 'scope') ? 'scope' : 'NULL AS scope',
      hasColumn(columns, 'files_changed') ? 'COALESCE(files_changed, 0) AS files_changed' : '0 AS files_changed',
      `${timestampColumn} AS created_at`,
    ].join(', ');

    const commits = db
      .prepare(`SELECT ${selectColumns} FROM vc_commits WHERE ${whereClauses.join(' AND ')} ORDER BY datetime(${timestampColumn}) DESC LIMIT ?`)
      .all(...params, limit);

    return sendJson(res, {
      commits,
      count: commits.length,
      days,
    });
  } catch (err) {
    return sendJson(res, { error: err.message }, 500);
  }
}

async function handleDeleteVersionControlWorktreeRoute(_req, res, _query, worktreeId) {
  const { db, error } = resolveDashboardVersionControlDb();
  if (error) {
    return sendJson(res, {
      error: 'Version control data unavailable',
      details: error.message,
    }, 503);
  }

  const columns = getTableColumns(db, 'vc_worktrees');
  if (columns.length === 0) {
    return sendError(res, 'Version control tables not initialized', 503);
  }

  try {
    const existing = db.prepare('SELECT id FROM vc_worktrees WHERE id = ?').get(worktreeId);
    if (!existing) {
      return sendError(res, `Version control worktree not found: ${worktreeId}`, 404);
    }

    const manager = createWorktreeManager({ db });
    const result = manager.cleanupWorktree(worktreeId);
    return sendJson(res, result || { removed: false }, 200);
  } catch (err) {
    return sendJson(res, { error: err.message }, 500);
  }
}

async function handleMergeVersionControlWorktreeRoute(req, res, _query, worktreeId) {
  const { db, error } = resolveDashboardVersionControlDb();
  if (error) {
    return sendJson(res, {
      error: 'Version control data unavailable',
      details: error.message,
    }, 503);
  }

  const columns = getTableColumns(db, 'vc_worktrees');
  if (columns.length === 0) {
    return sendError(res, 'Version control tables not initialized', 503);
  }

  try {
    const existing = db.prepare('SELECT id FROM vc_worktrees WHERE id = ?').get(worktreeId);
    if (!existing) {
      return sendError(res, `Version control worktree not found: ${worktreeId}`, 404);
    }

    const body = await parseBody(req);
    const manager = createWorktreeManager({ db });
    const result = manager.mergeWorktree(worktreeId, {
      strategy: body.strategy,
      targetBranch: body.targetBranch || body.target_branch,
      deleteAfter: body.deleteAfter,
      delete_after: body.delete_after,
    });

    return sendJson(res, result || { merged: false }, 200);
  } catch (err) {
    const status = /strategy must be one of/i.test(err.message) ? 400 : 500;
    return sendJson(res, { error: err.message }, status);
  }
}

/**
 * Route definitions: { method, pattern, handler }
 *
 * handler signature: (req, res, query, ...captureGroups, context) => void
 *   - query: parsed query parameters
 *   - captureGroups: regex match groups from the URL pattern
 *   - context: { broadcastTaskUpdate, clients, serverPort } — injected by dispatch
 *
 * Order matters for overlapping patterns — more specific patterns must come first.
 */
const routes = [
  // --- Tasks --- (compat: v2 equivalents at /api/v2/tasks)
  { method: 'GET',  pattern: /^\/api\/tasks$/,                                                       handler: tasks.handleListTasks, compat: true },
  { method: 'GET',  pattern: /^\/api\/tasks\/([^/]+)\/diff$/,                                        handler: tasks.handleTaskDiff, compat: true },
  { method: 'GET',  pattern: /^\/api\/tasks\/([^/]+)\/logs$/,                                        handler: tasks.handleTaskLogs, compat: true },
  { method: 'GET',  pattern: /^\/api\/tasks\/([^/]+)$/,                                              handler: tasks.handleGetTask, compat: true },
  { method: 'POST', pattern: /^\/api\/tasks\/submit$/,                                                      handler: tasks.handleSubmitTask, compat: true },
  { method: 'POST', pattern: /^\/api\/tasks\/([^/]+)\/(retry|cancel|approve-switch|reject-switch|remove)$/,  handler: tasks.handleTaskAction },

  // --- Providers --- (compat: v2 equivalents at /api/v2/providers)
  { method: 'GET',  pattern: /^\/api\/providers$/,                        handler: infrastructure.handleListProviders, compat: true },
  { method: 'GET',  pattern: /^\/api\/provider-quotas$/,                  handler: infrastructure.handleProviderQuotas },
  { method: 'GET',  pattern: /^\/api\/providers\/trends$/,                handler: infrastructure.handleProviderTrends, compat: true },
  { method: 'GET',  pattern: /^\/api\/providers\/([^/]+)\/percentiles$/,  handler: infrastructure.handleProviderPercentiles },
  { method: 'GET',  pattern: /^\/api\/providers\/([^/]+)\/stats$/,        handler: infrastructure.handleProviderStats, compat: true },
  { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/toggle$/,       handler: infrastructure.handleProviderToggle, compat: true },

  // --- Stats --- (compat: v2 equivalents at /api/v2/stats)
  { method: 'GET',  pattern: /^\/api\/stats\/overview$/,        handler: analytics.handleStatsOverview, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/timeseries$/,      handler: analytics.handleTimeSeries, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/quality$/,         handler: analytics.handleQualityStats, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/format-success$/,  handler: analytics.handleFormatSuccess, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/stuck$/,            handler: analytics.handleStuckTasks, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/models$/,           handler: analytics.handleModelStats, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/notifications$/,    handler: analytics.handleNotificationStats, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/event-history$/,    handler: analytics.handleEventHistory, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/webhooks$/,        handler: analytics.handleWebhookStats, compat: true },

  // --- Remote Agents --- (compat: v2 equivalents at /api/v2/agents)
  { method: 'GET',    pattern: /^\/api\/agents$/,                      handler: infrastructure.handleListAgents, compat: true },
  { method: 'POST',   pattern: /^\/api\/agents$/,                      handler: infrastructure.handleCreateAgent, compat: true },
  { method: 'GET',    pattern: /^\/api\/agents\/([^/]+)\/health$/,      handler: infrastructure.handleAgentHealth, compat: true },
  { method: 'GET',    pattern: /^\/api\/agents\/([^/]+)$/,              handler: infrastructure.handleGetAgent, compat: true },
  { method: 'DELETE', pattern: /^\/api\/agents\/([^/]+)$/,              handler: infrastructure.handleDeleteAgent, compat: true },

  // --- Plan Projects --- (compat: v2 equivalents at /api/v2/plan-projects)
  { method: 'POST',   pattern: /^\/api\/plan-projects\/import$/,                              handler: admin.handleImportPlanApi, compat: true },
  { method: 'GET',    pattern: /^\/api\/plan-projects$/,                                      handler: admin.handleListPlanProjects, compat: true },
  { method: 'GET',    pattern: /^\/api\/plan-projects\/([^/]+)$/,                              handler: admin.handleGetPlanProject, compat: true },
  { method: 'POST',   pattern: /^\/api\/plan-projects\/([^/]+)\/(pause|resume|retry)$/,        handler: admin.handlePlanProjectAction, compat: true },
  { method: 'DELETE', pattern: /^\/api\/plan-projects\/([^/]+)$/,                              handler: admin.handleDeletePlanProject, compat: true },

  // --- Hosts --- (compat: v2 equivalents at /api/v2/hosts)
  { method: 'GET',  pattern: /^\/api\/hosts$/,                   handler: infrastructure.handleListHosts, compat: true },
  { method: 'GET',  pattern: /^\/api\/hosts\/activity$/,         handler: infrastructure.handleHostActivity },
  { method: 'POST', pattern: /^\/api\/hosts\/scan$/,             handler: infrastructure.handleHostScan, compat: true },
  { method: 'POST',   pattern: /^\/api\/hosts\/([^/]+)\/toggle$/,  handler: infrastructure.handleHostToggle, compat: true },
  { method: 'GET',    pattern: /^\/api\/peek-hosts$/,                    handler: infrastructure.handleListPeekHosts, compat: true },
  { method: 'POST',   pattern: /^\/api\/peek-hosts$/,                    handler: infrastructure.handleCreatePeekHost, compat: true },
  { method: 'POST',   pattern: /^\/api\/peek-hosts\/([^/]+)\/test$/,     handler: infrastructure.handleTestPeekHost },
  { method: 'POST',   pattern: /^\/api\/peek-hosts\/([^/]+)\/toggle$/,   handler: infrastructure.handlePeekHostToggle, compat: true },
  { method: 'PUT',    pattern: /^\/api\/peek-hosts\/([^/]+)$/,           handler: infrastructure.handleUpdatePeekHost },
  { method: 'DELETE', pattern: /^\/api\/peek-hosts\/([^/]+)$/,           handler: infrastructure.handleDeletePeekHost, compat: true },
  { method: 'GET',    pattern: /^\/api\/hosts\/([^/]+)\/credentials$/,                                 handler: infrastructure.handleListCredentials, compat: true },
  { method: 'PUT',    pattern: /^\/api\/hosts\/([^/]+)\/credentials\/(ssh|http_auth|windows)$/,        handler: infrastructure.handleSaveCredential, compat: true },
  { method: 'DELETE', pattern: /^\/api\/hosts\/([^/]+)\/credentials\/(ssh|http_auth|windows)$/,        handler: infrastructure.handleDeleteCredential, compat: true },
  { method: 'POST',   pattern: /^\/api\/hosts\/([^/]+)\/credentials\/(ssh|http_auth|windows)\/test$/,  handler: infrastructure.handleTestCredential },
  { method: 'PATCH',  pattern: /^\/api\/hosts\/([^/]+)$/,          handler: infrastructure.handleUpdateHost, compat: true },
  { method: 'DELETE', pattern: /^\/api\/hosts\/([^/]+)$/,          handler: infrastructure.handleDeleteHost, compat: true },
  { method: 'GET',    pattern: /^\/api\/hosts\/([^/]+)$/,          handler: infrastructure.handleGetHost, compat: true },

  // --- Budget --- (compat: v2 equivalents at /api/v2/budget)
  { method: 'GET',  pattern: /^\/api\/budget\/summary$/,  handler: analytics.handleBudgetSummary, compat: true },
  { method: 'GET',  pattern: /^\/api\/budget\/status$/,   handler: analytics.handleBudgetStatus, compat: true },
  { method: 'POST', pattern: /^\/api\/budget\/set$/,      handler: analytics.handleSetBudget, compat: true },

  // --- System --- (compat: v2 system-status equivalent at /api/v2/system/status)
  { method: 'GET', pattern: /^\/api\/system\/status$/, handler: infrastructure.handleSystemStatus, compat: true },
  { method: 'GET', pattern: /^\/api\/instances$/,      handler: infrastructure.handleInstances },

  // --- Project Tuning --- (compat: v2 equivalents at /api/v2/tuning)
  { method: 'GET',    pattern: /^\/api\/project-tuning$/,         handler: admin.handleListProjectTuning, compat: true },
  { method: 'POST',   pattern: /^\/api\/project-tuning$/,         handler: admin.handleCreateProjectTuning, compat: true },
  { method: 'GET',    pattern: /^\/api\/project-tuning\/(.+)$/,   handler: admin.handleGetProjectTuning },
  { method: 'DELETE', pattern: /^\/api\/project-tuning\/(.+)$/,   handler: admin.handleDeleteProjectTuning, compat: true },

  // --- Benchmarks --- (compat: v2 equivalents at /api/v2/benchmarks)
  { method: 'GET',  pattern: /^\/api\/benchmarks$/,        handler: admin.handleListBenchmarks, compat: true },
  { method: 'POST', pattern: /^\/api\/benchmarks\/apply$/,  handler: admin.handleApplyBenchmark, compat: true },

  // --- Schedules --- (compat: v2 equivalents at /api/v2/schedules)
  { method: 'GET',    pattern: /^\/api\/schedules$/,                    handler: admin.handleListSchedules, compat: true },
  { method: 'POST',   pattern: /^\/api\/schedules$/,                    handler: admin.handleCreateSchedule, compat: true },
  { method: 'POST',   pattern: /^\/api\/schedules\/([^/]+)\/toggle$/,   handler: admin.handleToggleSchedule, compat: true },
  { method: 'DELETE', pattern: /^\/api\/schedules\/([^/]+)$/,           handler: admin.handleDeleteSchedule, compat: true },

  // --- Governance ---
  { method: 'GET',   pattern: /^\/api\/governance\/rules$/,               handler: handleGetGovernanceRulesRoute },
  { method: 'PATCH', pattern: /^\/api\/governance\/rules\/([^/]+)$/,      handler: handlePatchGovernanceRuleRoute },
  { method: 'POST',  pattern: /^\/api\/governance\/rules\/([^/]+)\/reset$/, handler: handleResetGovernanceRuleRoute },

  // --- Version Control ---
  { method: 'GET',    pattern: /^\/api\/version-control\/worktrees$/,                 handler: handleGetVersionControlWorktreesRoute },
  { method: 'GET',    pattern: /^\/api\/version-control\/commits$/,                   handler: handleGetVersionControlCommitsRoute },
  { method: 'DELETE', pattern: /^\/api\/version-control\/worktrees\/([^/]+)$/,        handler: handleDeleteVersionControlWorktreeRoute },
  { method: 'POST',   pattern: /^\/api\/version-control\/worktrees\/([^/]+)\/merge$/, handler: handleMergeVersionControlWorktreeRoute },

  // --- Workflows --- (compat: v2 equivalents at /api/v2/workflows)
  { method: 'GET', pattern: /^\/api\/workflows$/,                       handler: analytics.handleListWorkflows, compat: true },
  { method: 'GET', pattern: /^\/api\/workflows\/([^/]+)\/tasks$/,       handler: analytics.handleGetWorkflowTasks },
  { method: 'GET', pattern: /^\/api\/workflows\/([^/]+)\/history$/,     handler: analytics.handleGetWorkflowHistory, compat: true },
  { method: 'GET', pattern: /^\/api\/workflows\/([^/]+)$/,              handler: analytics.handleGetWorkflow, compat: true },

  // --- Approvals --- (compat: v2 equivalents at /api/v2/approvals)
  { method: 'GET',  pattern: /^\/api\/approvals$/,                          handler: admin.handleListPendingApprovals, compat: true },
  { method: 'GET',  pattern: /^\/api\/approvals\/history$/,                 handler: admin.handleGetApprovalHistory, compat: true },
  { method: 'POST', pattern: /^\/api\/approvals\/([^/]+)\/approve$/,        handler: admin.handleApproveTask, compat: true },
  { method: 'POST', pattern: /^\/api\/approvals\/([^/]+)\/reject$/,         handler: admin.handleRejectApproval, compat: true },

  // --- Coordination ---
  { method: 'GET',  pattern: /^\/api\/coordination$/,                       handler: admin.handleGetDashboard },
  { method: 'GET',  pattern: /^\/api\/coordination\/agents$/,               handler: admin.handleListAgents },
  { method: 'GET',  pattern: /^\/api\/coordination\/rules$/,                handler: admin.handleListRoutingRules },
  { method: 'GET',  pattern: /^\/api\/coordination\/claims$/,               handler: admin.handleListClaims },

  // --- Strategic Brain --- (compat: v2 partial — operations has no v2 equivalent)
  { method: 'GET',  pattern: /^\/api\/strategic\/status$/,             handler: analytics.handleGetStrategicStatus, compat: true },
  { method: 'GET',  pattern: /^\/api\/strategic\/operations$/,         handler: analytics.handleGetRecentOperations },
  { method: 'GET',  pattern: /^\/api\/strategic\/decisions$/,          handler: analytics.handleGetRoutingDecisions, compat: true },
  { method: 'GET',  pattern: /^\/api\/strategic\/provider-health$/,    handler: analytics.handleGetProviderHealth, compat: true },

  // --- Provider Quotas ---
  { method: 'GET',  pattern: /^\/api\/quota\/status$/,             handler: analytics.handleQuotaStatus },
  { method: 'GET',  pattern: /^\/api\/quota\/history$/,            handler: analytics.handleQuotaHistory },
  { method: 'GET',  pattern: /^\/api\/quota\/auto-scale$/,         handler: analytics.handleQuotaAutoScale },
];

/**
 * Dispatch an API request to the matching route handler.
 *
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 * @param {Object} context - Shared server state:
 *   { broadcastTaskUpdate: fn, clients: Set, serverPort: number }
 */
async function dispatch(req, res, context) {
  const url = req.url.split('?')[0];
  const method = req.method;

  try {
    const query = parseQuery(req.url);

    // Dashboard APIs are local-only control-plane endpoints.
    if (!isLocalDashboardRequest(req)) {
      sendError(res, 'Forbidden', 403);
      return;
    }

    // Validate CORS origin — only allow localhost
    const origin = req.headers.origin;
    const allowedOrigin = isLocalhostOrigin(origin) ? origin : null;
    res._corsOrigin = allowedOrigin;

    // CORS preflight
    if (method === 'OPTIONS') {
      const headers = {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };
      if (allowedOrigin) {
        headers['Access-Control-Allow-Origin'] = allowedOrigin;
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && !isAjaxRequest(req)) {
      sendError(res, 'Forbidden', 403);
      return;
    }

    for (const route of routes) {
      if (method !== route.method) continue;
      const match = url.match(route.pattern);
      if (!match) continue;

      const captures = match.slice(1);
      // Determine handler arity to decide how to call it.
      // Handlers that need context receive it as the last argument.
      // Task actions need broadcastTaskUpdate; system/instances need clients/port.
      return await route.handler(req, res, query, ...captures, context);
    }

    // No route matched
    sendError(res, 'Not found', 404);

  } catch (err) {
    process.stderr.write(`Dashboard API error: ${err.message}\n`);
    // Return 400 for client errors (bad JSON, body too large), 500 for server errors
    const status = (err.message === 'Invalid JSON body' || err.message === 'Request body too large') ? 400 : 500;
    sendError(res, err.message, status);
  }
}

module.exports = { isLocalDashboardRequest, isAjaxRequest, dispatch, routes };
