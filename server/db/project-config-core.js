/**
 * db/project-config.js — Project management, config, health, budget, dependencies,
 * plan projects, integrations, reports, email, export
 *
 * Extracted from database.js Phase 3 decomposition.
 * Sub-modules: project-cache.js, validation-rules.js, resource-health.js, pipeline-crud.js
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { safeJsonParse } = require('../utils/json');

// Cache and validation sub-modules
const projectCache = require('./project-cache');
const validationRules = require('./validation-rules');

// Extracted sub-modules
const resourceHealth = require('./resource-health');
const pipelineCrud = require('./pipeline-crud');
const planProjects = require('./plan-projects');

// ============================================================
// Dependency injection (set by database.js init)
// ============================================================

let db = null;
let _getTask = null;
let _recordEvent = null;
const _dbFunctions = {};

function setDb(dbInstance) {
  db = dbInstance;
  // Forward to cache + validation sub-modules
  projectCache.setDb(dbInstance);
  validationRules.setDb(dbInstance);
  // Forward to extracted sub-modules
  resourceHealth.setDb(dbInstance);
  pipelineCrud.setDb(dbInstance);
  planProjects.setDb(dbInstance);
}

function setGetTask(fn) {
  _getTask = fn;
  // Forward to sub-modules that need it
  projectCache.setGetTask(fn);
  validationRules.setGetTask(fn);
  planProjects.setGetTask(fn);
}

function setRecordEvent(fn) {
  _recordEvent = fn;
  pipelineCrud.setRecordEvent(fn);
}

function setDbFunctions(fns) {
  Object.assign(_dbFunctions, fns);
  // Forward to project-cache sub-module
  projectCache.setDbFunctions(fns);
  // Initialize resource-health with deps from _dbFunctions
  _initResourceHealth();
}

function _initResourceHealth() {
  resourceHealth.init({
    getConfig: (...args) => _dbFunctions.getConfig ? _dbFunctions.getConfig(...args) : null,
    cleanupWebhookLogs: (...args) => _dbFunctions.cleanupWebhookLogs ? _dbFunctions.cleanupWebhookLogs(...args) : 0,
    cleanupStreamData: (...args) => _dbFunctions.cleanupStreamData ? _dbFunctions.cleanupStreamData(...args) : 0,
    cleanupCoordinationEvents: (...args) => _dbFunctions.cleanupCoordinationEvents ? _dbFunctions.cleanupCoordinationEvents(...args) : 0,
    getSlowQueries: (n) => projectCache.getSlowQueries ? projectCache.getSlowQueries(n) : [],
  });
}

function getDbInstance() { return db; }

// Proxy helpers for injected functions
function getTask(...args) { if (!_getTask) return null; return _getTask(...args); }
function getConfig(...args) { return _dbFunctions.getConfig ? _dbFunctions.getConfig(...args) : null; }
function getAllConfig(...args) { return _dbFunctions.getAllConfig ? _dbFunctions.getAllConfig(...args) : {}; }
function escapeLikePattern(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[%_\\]/g, '\\$&');
}
function getRunningCount() { return _dbFunctions.getRunningCount ? _dbFunctions.getRunningCount() : 0; }
function getTokenUsageSummary(...args) { return _dbFunctions.getTokenUsageSummary ? _dbFunctions.getTokenUsageSummary(...args) : {}; }
function getScheduledTask(...args) { return _dbFunctions.getScheduledTask ? _dbFunctions.getScheduledTask(...args) : null; }


// Project root detection constants
const PROJECT_MARKERS = [
  'package.json', '.git', 'Cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'CMakeLists.txt', 'Makefile', '.sln', '.csproj',
  'pyproject.toml', 'setup.py', 'requirements.txt', 'Gemfile',
  'composer.json', 'mix.exs', 'build.sbt', 'stack.yaml',
  'deno.json', 'dune-project', 'flake.nix', '.project',
];

// ============================================================
// Project root detection
// ============================================================

/**
 * Find the project root directory by looking for project markers
 * Walks up the directory tree until it finds a marker or reaches root
 */
function findProjectRoot(startDir) {
  if (!startDir) return null;

  let currentDir = path.normalize(startDir);
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    // Check for any project marker
    for (const marker of PROJECT_MARKERS) {
      const markerPath = path.join(currentDir, marker);
      if (fs.existsSync(markerPath)) {
        return currentDir;
      }
    }

    // Move up one directory
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break; // Reached root
    currentDir = parentDir;
  }

  // No marker found, return the original directory
  return startDir;
}

/**
 * Extract project identifier from working directory
 * Uses smart detection to find project root first
 */
function getProjectFromPath(workingDirectory) {
  if (!workingDirectory) return null;

  // Find the project root (smart detection)
  const projectRoot = findProjectRoot(workingDirectory);

  // Get the project name from the root directory
  const projectName = path.basename(projectRoot);

  return projectName || null;
}

/**
 * Get the full project root path
 */
function getProjectRoot(workingDirectory) {
  if (!workingDirectory) return null;
  return findProjectRoot(workingDirectory);
}

// ============================================================
// Budget alerts
// ============================================================

/**
 * Create a budget alert
 */
function createBudgetAlert(alert) {
  const stmt = db.prepare(`
    INSERT INTO budget_alerts (id, project, alert_type, threshold_percent, threshold_value, webhook_id, cooldown_minutes, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    alert.id,
    alert.project || null,
    alert.alert_type,
    alert.threshold_percent,
    alert.threshold_value || null,
    alert.webhook_id || null,
    alert.cooldown_minutes || 60,
    alert.enabled !== false ? 1 : 0,
    new Date().toISOString()
  );

  return getBudgetAlert(alert.id);
}

/**
 * Get a budget alert by ID
 */
function getBudgetAlert(id) {
  const stmt = db.prepare('SELECT * FROM budget_alerts WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.enabled = Boolean(row.enabled);
  }
  return row;
}

/**
 * List budget alerts
 */
function listBudgetAlerts(options = {}) {
  let query = 'SELECT * FROM budget_alerts';
  const conditions = [];
  const values = [];

  if (options.project) {
    conditions.push('(project = ? OR project IS NULL)');
    values.push(options.project);
  }
  if (options.alert_type) {
    conditions.push('alert_type = ?');
    values.push(options.alert_type);
  }
  if (options.enabled !== undefined) {
    conditions.push('enabled = ?');
    values.push(options.enabled ? 1 : 0);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  return db.prepare(query).all(...values).map(row => ({
    ...row,
    enabled: Boolean(row.enabled)
  }));
}

/**
 * Update budget alert (e.g., last triggered time)
 */
const ALLOWED_BUDGET_ALERT_COLUMNS = new Set([
  'project', 'alert_type', 'threshold_percent', 'threshold_value',
  'webhook_id', 'cooldown_minutes', 'last_triggered_at', 'enabled'
]);

function updateBudgetAlert(id, updates) {
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_BUDGET_ALERT_COLUMNS.has(key)) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }

  if (fields.length === 0) return getBudgetAlert(id);

  values.push(id);
  db.prepare(`UPDATE budget_alerts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getBudgetAlert(id);
}

/**
 * Delete a budget alert
 */
function deleteBudgetAlert(id) {
  const result = db.prepare('DELETE FROM budget_alerts WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Check budget alerts against current usage
 * @param {string|null} [project=null] - Optional project filter.
 * @returns {Array<object>} Triggered alerts.
 */
function checkBudgetAlerts(project = null) {
  const alerts = listBudgetAlerts({ project, enabled: true });
  const triggered = [];

  for (const alert of alerts) {
    const cooldownOk = !alert.last_triggered_at ||
      (Date.now() - new Date(alert.last_triggered_at).getTime()) > (alert.cooldown_minutes * 60 * 1000);

    if (!cooldownOk) continue;

    let currentValue = 0;
    const thresholdValue = alert.threshold_value;

    // Compute 'since' from the alert type (daily vs monthly)
    const now = new Date();
    let since;
    if (alert.alert_type === 'daily_cost' || alert.alert_type === 'daily_tokens') {
      since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    } else {
      since = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    }

    if (alert.alert_type === 'daily_cost') {
      const usage = getTokenUsageSummary({ project: alert.project, since });
      currentValue = usage.total_cost_usd || 0;
    } else if (alert.alert_type === 'daily_tokens') {
      const usage = getTokenUsageSummary({ project: alert.project, since });
      currentValue = usage.total_tokens || 0;
    } else if (alert.alert_type === 'monthly_cost') {
      const usage = getTokenUsageSummary({ project: alert.project, since });
      currentValue = usage.total_cost_usd || 0;
    }

    // Resolve effective threshold: use explicit threshold_value, or compute from
    // global budget config when only threshold_percent is provided.
    let effectiveThreshold = thresholdValue;
    if (!effectiveThreshold && alert.threshold_percent) {
      const globalBudget = parseFloat(getConfig('budget_usd')) || 0;
      if (globalBudget > 0) {
        effectiveThreshold = globalBudget;
      }
    }

    if (effectiveThreshold && currentValue >= effectiveThreshold * (alert.threshold_percent / 100)) {
      triggered.push({
        alert,
        currentValue,
        thresholdValue: effectiveThreshold,
        percentUsed: effectiveThreshold > 0 ? Math.round((currentValue / effectiveThreshold) * 100) : 0
      });
    }
  }

  return triggered;
}

// ============================================================
// Task dependencies
// ============================================================

/**
 * Check if task dependencies are satisfied
 * @param {string} taskId - Task identifier.
 * @returns {object} Dependency status.
 */
function checkDependencies(taskId) {
  const task = getTask(taskId);
  if (!task || !task.depends_on) return { satisfied: true, pending: [] };

  // depends_on is already parsed by getTask
  const dependsOn = Array.isArray(task.depends_on) ? task.depends_on : [];
  const pending = [];

  for (const depId of dependsOn) {
    const depTask = getTask(depId);
    if (!depTask || depTask.status !== 'completed') {
      pending.push(depId);
    }
  }

  return {
    satisfied: pending.length === 0,
    pending
  };
}

/**
 * Get tasks waiting on a specific task
 */
function getDependentTasks(taskId) {
  // Security: Escape LIKE wildcards to prevent injection using shared helper
  const escapedTaskId = escapeLikePattern(taskId);
  const stmt = db.prepare(`
    SELECT * FROM tasks
    WHERE depends_on LIKE ? ESCAPE '\\'
    AND status IN ('pending', 'queued', 'blocked')
  `);
  return stmt.all(`%${escapedTaskId}%`);
}

// Health checks, Resource metrics, Memory pressure — extracted to resource-health.js


// ============================================================
// Scheduled tasks
// ============================================================

/**
 * Create a scheduled task
 */
function createScheduledTask(schedule) {
  const stmt = db.prepare(`
    INSERT INTO scheduled_tasks (
      id, name, task_description, working_directory, timeout_minutes,
      auto_approve, priority, tags, schedule_type, cron_expression,
      scheduled_time, repeat_interval_minutes, next_run_at, max_runs,
      status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    schedule.id,
    schedule.name,
    schedule.task_description,
    schedule.working_directory || null,
    schedule.timeout_minutes ?? 30,
    schedule.auto_approve ? 1 : 0,
    schedule.priority || 0,
    schedule.tags ? JSON.stringify(schedule.tags) : null,
    schedule.schedule_type,
    schedule.cron_expression || null,
    schedule.scheduled_time || null,
    schedule.repeat_interval_minutes || null,
    schedule.next_run_at,
    schedule.max_runs || null,
    'active',
    new Date().toISOString()
  );

  return getScheduledTask(schedule.id);
}

// ============================================================
// Project management
// ============================================================

/**
 * List all projects with task counts and stats
 */
function listProjects() {
  const stmt = db.prepare(`
    SELECT
      project,
      COUNT(*) as task_count,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN status IN ('pending', 'queued', 'running') THEN 1 ELSE 0 END) as active_count,
      MIN(created_at) as first_task_at,
      MAX(created_at) as last_task_at
    FROM tasks
    WHERE project IS NOT NULL
    GROUP BY project
    ORDER BY last_task_at DESC
  `);

  const projects = stmt.all();

  // Also get cost data per project
  const costStmt = db.prepare(`
    SELECT
      project,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(estimated_cost_usd), 0) as total_cost
    FROM token_usage
    WHERE project IS NOT NULL
    GROUP BY project
  `);

  const costData = {};
  for (const row of costStmt.all()) {
    costData[row.project] = {
      total_tokens: row.total_tokens,
      total_cost: row.total_cost
    };
  }

  return projects.map(p => ({
    ...p,
    total_tokens: costData[p.project]?.total_tokens || 0,
    total_cost: costData[p.project]?.total_cost || 0
  }));
}

/**
 * Get detailed stats for a specific project
 */
function getProjectStats(project) {
  // Task counts by status
  const taskStmt = db.prepare(`
    SELECT
      status,
      COUNT(*) as count
    FROM tasks
    WHERE project = ?
    GROUP BY status
  `);

  const tasksByStatus = {};
  for (const row of taskStmt.all(project)) {
    tasksByStatus[row.status] = row.count;
  }

  // Total tasks
  const totalTasks = Object.values(tasksByStatus).reduce((a, b) => a + b, 0);

  // Recent tasks
  const recentStmt = db.prepare(`
    SELECT id, status, task_description, created_at, completed_at
    FROM tasks
    WHERE project = ?
    ORDER BY created_at DESC
    LIMIT 10
  `);
  const recentTasks = recentStmt.all(project);

  // Cost summary
  const costStmt = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(estimated_cost_usd), 0) as total_cost
    FROM token_usage
    WHERE project = ?
  `);
  const costSummary = costStmt.get(project);

  // Pipelines count
  const pipelineStmt = db.prepare(`
    SELECT COUNT(*) as count FROM pipelines WHERE project = ?
  `);
  const pipelineCount = pipelineStmt.get(project)?.count || 0;

  // Scheduled tasks count
  const scheduledStmt = db.prepare(`
    SELECT COUNT(*) as count FROM scheduled_tasks WHERE project = ?
  `);
  const scheduledCount = scheduledStmt.get(project)?.count || 0;

  // Templates used
  const templateStmt = db.prepare(`
    SELECT template_name, COUNT(*) as count
    FROM tasks
    WHERE project = ? AND template_name IS NOT NULL
    GROUP BY template_name
    ORDER BY count DESC
    LIMIT 5
  `);
  const topTemplates = templateStmt.all(project);

  // Tags used
  const tagStmt = db.prepare(`
    SELECT tags FROM tasks WHERE project = ? AND tags IS NOT NULL
  `);
  const tagCounts = {};
  for (const row of tagStmt.all(project)) {
    try {
      const tags = JSON.parse(row.tags);
      for (const tag of tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    } catch { /* ignore */ }
  }

  return {
    project,
    total_tasks: totalTasks,
    tasks_by_status: tasksByStatus,
    pipelines: pipelineCount,
    scheduled_tasks: scheduledCount,
    cost: costSummary,
    top_templates: topTemplates,
    top_tags: Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count })),
    recent_tasks: recentTasks
  };
}

/**
 * Get current project from a working directory
 */
function getCurrentProject(workingDirectory) {
  return getProjectFromPath(workingDirectory);
}

/**
 * Resolve project defaults from either a project name or working directory.
 * Returns table-backed project configuration plus parsed project metadata.
 * @param {string} projectOrWorkingDirectory
 * @returns {object|null}
 */
function getProjectDefaults(projectOrWorkingDirectory) {
  if (typeof projectOrWorkingDirectory !== 'string') {
    return null;
  }

  const input = projectOrWorkingDirectory.trim();
  if (!input) {
    return null;
  }

  const inputLooksLikePath = input.includes(path.sep) || input.includes('/') || input.includes('\\');
  const project = inputLooksLikePath ? getProjectFromPath(input) : input;
  if (!project) {
    return null;
  }

  const config = getProjectConfig(project);
  if (!config) {
    return null;
  }

  const stepProviders = safeJsonParse(getProjectMetadata(project, 'step_providers'), null);
  const piiGuard = safeJsonParse(getProjectMetadata(project, 'pii_guard'), null);
  const workingDirectory = inputLooksLikePath
    ? input
    : path.join(process.env.TORQUE_PROJECTS_BASE || process.cwd(), project);

  return {
    ...config,
    project,
    working_directory: workingDirectory,
    step_providers: stepProviders,
    pii_guard: piiGuard,
  };
}

// ============================================================
// Project configuration
// ============================================================

/**
 * Get project configuration
 */
function getProjectConfig(project) {
  const stmt = db.prepare('SELECT * FROM project_config WHERE project = ?');
  const config = stmt.get(project);

  if (config) {
    config.auto_approve = Boolean(config.auto_approve);
    config.enabled = Boolean(config.enabled);
    config.build_verification_enabled = Boolean(config.build_verification_enabled);
    config.rollback_on_build_failure = Boolean(config.rollback_on_build_failure);
    config.llm_safeguards_enabled = config.llm_safeguards_enabled !== 0;
    config.test_verification_enabled = Boolean(config.test_verification_enabled);
    config.rollback_on_test_failure = Boolean(config.rollback_on_test_failure);
    config.style_check_enabled = Boolean(config.style_check_enabled);
    config.auto_pr_enabled = Boolean(config.auto_pr_enabled);
  }

  return config;
}

/**
 * Set project configuration (creates or updates)
 */
function setProjectConfig(project, config) {
  const now = new Date().toISOString();

  const existing = getProjectConfig(project);

  if (existing) {
    // Update existing config
    const updates = [];
    const values = [];

    if (config.max_concurrent !== undefined) {
      updates.push('max_concurrent = ?');
      values.push(config.max_concurrent);
    }
    if (config.max_daily_cost !== undefined) {
      updates.push('max_daily_cost = ?');
      values.push(config.max_daily_cost);
    }
    if (config.max_daily_tokens !== undefined) {
      updates.push('max_daily_tokens = ?');
      values.push(config.max_daily_tokens);
    }
    if (config.default_timeout !== undefined) {
      updates.push('default_timeout = ?');
      values.push(config.default_timeout);
    }
    if (config.default_priority !== undefined) {
      updates.push('default_priority = ?');
      values.push(config.default_priority);
    }
    if (config.auto_approve !== undefined) {
      updates.push('auto_approve = ?');
      values.push(config.auto_approve ? 1 : 0);
    }
    if (config.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(config.enabled ? 1 : 0);
    }
    if (config.build_verification_enabled !== undefined) {
      updates.push('build_verification_enabled = ?');
      values.push(config.build_verification_enabled ? 1 : 0);
    }
    if (config.build_command !== undefined) {
      updates.push('build_command = ?');
      values.push(config.build_command);
    }
    if (config.build_timeout !== undefined) {
      updates.push('build_timeout = ?');
      values.push(config.build_timeout);
    }
    if (config.rollback_on_build_failure !== undefined) {
      updates.push('rollback_on_build_failure = ?');
      values.push(config.rollback_on_build_failure ? 1 : 0);
    }
    if (config.llm_safeguards_enabled !== undefined) {
      updates.push('llm_safeguards_enabled = ?');
      values.push(config.llm_safeguards_enabled ? 1 : 0);
    }
    if (config.test_verification_enabled !== undefined) {
      updates.push('test_verification_enabled = ?');
      values.push(config.test_verification_enabled ? 1 : 0);
    }
    if (config.test_command !== undefined) {
      updates.push('test_command = ?');
      values.push(config.test_command);
    }
    if (config.test_timeout !== undefined) {
      updates.push('test_timeout = ?');
      values.push(config.test_timeout);
    }
    if (config.rollback_on_test_failure !== undefined) {
      updates.push('rollback_on_test_failure = ?');
      values.push(config.rollback_on_test_failure ? 1 : 0);
    }
    if (config.style_check_enabled !== undefined) {
      updates.push('style_check_enabled = ?');
      values.push(config.style_check_enabled ? 1 : 0);
    }
    if (config.style_check_command !== undefined) {
      updates.push('style_check_command = ?');
      values.push(config.style_check_command);
    }
    if (config.style_check_timeout !== undefined) {
      updates.push('style_check_timeout = ?');
      values.push(config.style_check_timeout);
    }
    if (config.auto_pr_enabled !== undefined) {
      updates.push('auto_pr_enabled = ?');
      values.push(config.auto_pr_enabled ? 1 : 0);
    }
    if (config.auto_pr_base_branch !== undefined) {
      updates.push('auto_pr_base_branch = ?');
      values.push(config.auto_pr_base_branch);
    }
    if (config.default_provider !== undefined) {
      updates.push('default_provider = ?');
      values.push(config.default_provider);
    }
    if (config.default_model !== undefined) {
      updates.push('default_model = ?');
      values.push(config.default_model);
    }
    if (config.verify_command !== undefined) {
      updates.push('verify_command = ?');
      values.push(config.verify_command);
    }
    if (config.auto_fix_enabled !== undefined) {
      updates.push('auto_fix_enabled = ?');
      values.push(config.auto_fix_enabled ? 1 : 0);
    }
    if (config.test_pattern !== undefined) {
      updates.push('test_pattern = ?');
      values.push(config.test_pattern);
    }
    if (config.auto_verify_on_completion !== undefined) {
      updates.push('auto_verify_on_completion = ?');
      values.push(config.auto_verify_on_completion);
    }
    if (config.remote_agent_id !== undefined) {
      updates.push('remote_agent_id = ?');
      values.push(config.remote_agent_id);
    }
    if (config.remote_project_path !== undefined) {
      updates.push('remote_project_path = ?');
      values.push(config.remote_project_path);
    }
    if (config.prefer_remote_tests !== undefined) {
      updates.push('prefer_remote_tests = ?');
      values.push(config.prefer_remote_tests);
    }
    if (config.economy_policy !== undefined) {
      updates.push('economy_policy = ?');
      values.push(config.economy_policy);
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(project);

    if (updates.length > 1) {
      const stmt = db.prepare(`UPDATE project_config SET ${updates.join(', ')} WHERE project = ?`);
      stmt.run(...values);
    }
  } else {
    // Create new config
    const stmt = db.prepare(`
      INSERT INTO project_config (
        project, max_concurrent, max_daily_cost, max_daily_tokens,
        default_timeout, default_priority, auto_approve, enabled,
        build_verification_enabled, build_command, build_timeout, rollback_on_build_failure,
        llm_safeguards_enabled,
        test_verification_enabled, test_command, test_timeout, rollback_on_test_failure,
        style_check_enabled, style_check_command, style_check_timeout,
        auto_pr_enabled, auto_pr_base_branch,
        default_provider, default_model, verify_command, auto_fix_enabled, test_pattern,
        auto_verify_on_completion, remote_agent_id, remote_project_path, prefer_remote_tests,
        economy_policy, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      project,
      config.max_concurrent || 0,
      config.max_daily_cost || 0,
      config.max_daily_tokens || 0,
      config.default_timeout ?? 30,
      config.default_priority || 0,
      config.auto_approve ? 1 : 0,
      config.enabled !== false ? 1 : 0,
      config.build_verification_enabled ? 1 : 0,
      config.build_command || null,
      config.build_timeout ?? 120,
      config.rollback_on_build_failure !== false ? 1 : 0,
      config.llm_safeguards_enabled !== false ? 1 : 0,
      config.test_verification_enabled ? 1 : 0,
      config.test_command || null,
      config.test_timeout ?? 300,
      config.rollback_on_test_failure ? 1 : 0,
      config.style_check_enabled ? 1 : 0,
      config.style_check_command || null,
      config.style_check_timeout ?? 60,
      config.auto_pr_enabled ? 1 : 0,
      config.auto_pr_base_branch || 'main',
      config.default_provider || null,
      config.default_model || null,
      config.verify_command || null,
      config.auto_fix_enabled ? 1 : 0,
      config.test_pattern || null,
      config.auto_verify_on_completion !== undefined ? (config.auto_verify_on_completion ? 1 : 0) : null,
      config.remote_agent_id || null,
      config.remote_project_path || null,
      config.prefer_remote_tests !== undefined ? (config.prefer_remote_tests ? 1 : 0) : 0,
      config.economy_policy || null,
      now,
      now
    );
  }

  return getProjectConfig(project);
}

// ============================================================
// Project metadata
// ============================================================

/**
 * Set project metadata (key-value storage for project-specific settings)
 */
function setProjectMetadata(project, key, value) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO project_metadata (project, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  stmt.run(project, key, value, now);
  return { project, key, value };
}

/**
 * Get project metadata by key
 */
function getProjectMetadata(project, key) {
  const stmt = db.prepare('SELECT value FROM project_metadata WHERE project = ? AND key = ?');
  const row = stmt.get(project, key);
  return row?.value || null;
}

/**
 * Get all metadata for a project
 */
function getAllProjectMetadata(project) {
  const stmt = db.prepare('SELECT key, value FROM project_metadata WHERE project = ?');
  const rows = stmt.all(project);
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// ============================================================
// Project quotas and concurrency
// ============================================================

/**
 * Get count of running tasks for a project
 */
function getProjectRunningCount(project) {
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM tasks
    WHERE project = ? AND status = 'running'
  `);
  return stmt.get(project)?.count || 0;
}

/**
 * Get today's usage for a project (for quota checking)
 */
function getProjectDailyUsage(project) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const stmt = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(estimated_cost_usd), 0) as cost
    FROM token_usage
    WHERE project = ? AND date(recorded_at) = ?
  `);

  return stmt.get(project, today) || { tokens: 0, cost: 0 };
}

/**
 * Check if a project can start a new task (quota and concurrency check)
 * @param {string} project - Project identifier.
 * @returns {object} Eligibility result.
 */
function canProjectStartTask(project) {
  const config = getProjectConfig(project);
  const globalConfig = getAllConfig();
  const globalMax = parseInt(globalConfig.max_concurrent, 10) || 10;
  const defaultProjectMax = parseInt(globalConfig.default_project_max_concurrent, 10) || 3;

  // Check if project is enabled
  if (config && !config.enabled) {
    return { allowed: false, reason: 'Project is disabled' };
  }

  // Check project-specific concurrency limit (use default if not explicitly set)
  const projectMax = (config && config.max_concurrent > 0) ? config.max_concurrent : defaultProjectMax;
  const running = getProjectRunningCount(project);
  if (running >= projectMax) {
    return {
      allowed: false,
      reason: `Project concurrency limit reached (${running}/${projectMax})`
    };
  }

  // Check global concurrency limit
  const globalRunning = getRunningCount();
  if (globalRunning >= globalMax) {
    return {
      allowed: false,
      reason: `Global concurrency limit reached (${globalRunning}/${globalMax})`
    };
  }

  // Check daily quotas
  if (config && (config.max_daily_cost > 0 || config.max_daily_tokens > 0)) {
    const usage = getProjectDailyUsage(project);

    if (config.max_daily_cost > 0 && usage.cost >= config.max_daily_cost) {
      return {
        allowed: false,
        reason: `Daily cost limit reached ($${usage.cost.toFixed(2)}/$${config.max_daily_cost.toFixed(2)})`
      };
    }

    if (config.max_daily_tokens > 0 && usage.tokens >= config.max_daily_tokens) {
      return {
        allowed: false,
        reason: `Daily token limit reached (${usage.tokens}/${config.max_daily_tokens})`
      };
    }
  }

  return { allowed: true };
}

/**
 * List all project configurations
 */
function listProjectConfigs() {
  const stmt = db.prepare('SELECT * FROM project_config ORDER BY project');
  const configs = stmt.all();

  return configs.map(c => ({
    ...c,
    auto_approve: Boolean(c.auto_approve),
    enabled: Boolean(c.enabled)
  }));
}

/**
 * Delete project configuration
 */
function deleteProjectConfig(project) {
  const stmt = db.prepare('DELETE FROM project_config WHERE project = ?');
  const result = stmt.run(project);
  return result.changes > 0;
}

/**
 * Get effective config for a project (merges project config with defaults)
 */
function getEffectiveProjectConfig(project) {
  const projConfig = getProjectConfig(project);
  const globalConfig = getAllConfig();
  const defaultProjectMax = parseInt(globalConfig.default_project_max_concurrent, 10) || 3;

  return {
    project,
    max_concurrent: projConfig?.max_concurrent || defaultProjectMax, // Use default if not set
    max_daily_cost: projConfig?.max_daily_cost || 0, // 0 means unlimited
    max_daily_tokens: projConfig?.max_daily_tokens || 0, // 0 means unlimited
    default_timeout: projConfig?.default_timeout ?? (parseInt(globalConfig.default_timeout, 10) || 30),
    default_priority: projConfig?.default_priority || 0,
    auto_approve: projConfig?.auto_approve || false,
    enabled: projConfig?.enabled !== false,
    global_max_concurrent: parseInt(globalConfig.max_concurrent, 10) || 10,
    default_project_max_concurrent: defaultProjectMax
  };
}

// ============================================================
// Reports and integrations
// ============================================================

/**
 * Create a report export record
 */
function createReportExport(reportType, format, filters = null) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO report_exports (id, report_type, format, filters, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, reportType, format, filters ? JSON.stringify(filters) : null, now);

  return { id, report_type: reportType, format, status: 'pending', created_at: now };
}

/**
 * Update report export status
 */
function updateReportExport(id, status, filePath = null, fileSize = null, rowCount = null, error = null) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE report_exports SET
      status = ?,
      file_path = COALESCE(?, file_path),
      file_size_bytes = COALESCE(?, file_size_bytes),
      row_count = COALESCE(?, row_count),
      error = ?,
      completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END
    WHERE id = ?
  `).run(status, filePath, fileSize, rowCount, error, status, now, id);
}

/**
 * Get report export
 */
function getReportExport(id) {
  return db.prepare('SELECT * FROM report_exports WHERE id = ?').get(id);
}

/**
 * List report exports
 */
function listReportExports(limit = 50) {
  return db.prepare(`
    SELECT * FROM report_exports ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

/**
 * Record integration health check
 */
function recordIntegrationHealth(integrationType, integrationId, status, latencyMs = null, errorMessage = null) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO integration_health (integration_type, integration_id, status, latency_ms, error_message, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(integrationType, integrationId, status, latencyMs, errorMessage, now);
}

/**
 * Get integration health history
 */
function getIntegrationHealthHistory(integrationType = null, limit = 50) {
  if (integrationType) {
    return db.prepare(`
      SELECT * FROM integration_health WHERE integration_type = ? ORDER BY checked_at DESC LIMIT ?
    `).all(integrationType, limit);
  }
  return db.prepare(`
    SELECT * FROM integration_health ORDER BY checked_at DESC LIMIT ?
  `).all(limit);
}

/**
 * Get latest health status for each integration
 */
function getLatestIntegrationHealth() {
  return db.prepare(`
    SELECT ih.*
    FROM integration_health ih
    INNER JOIN (
      SELECT integration_type, integration_id, MAX(checked_at) as max_checked
      FROM integration_health
      GROUP BY integration_type, integration_id
    ) latest ON ih.integration_type = latest.integration_type
      AND ih.integration_id = latest.integration_id
      AND ih.checked_at = latest.max_checked
  `).all();
}

/**
 * Record integration test
 */
function recordIntegrationTest(integrationType, integrationId, testType, status, requestPayload = null, responseData = null, error = null, latencyMs = null) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO integration_tests (id, integration_type, integration_id, test_type, status, request_payload, response_data, error, latency_ms, tested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, integrationType, integrationId, testType, status, requestPayload, responseData, error, latencyMs, now);

  return { id, status, latency_ms: latencyMs };
}

/**
 * Get integration tests
 */
function getIntegrationTests(integrationType = null, limit = 50) {
  if (integrationType) {
    return db.prepare(`
      SELECT * FROM integration_tests WHERE integration_type = ? ORDER BY tested_at DESC LIMIT ?
    `).all(integrationType, limit);
  }
  return db.prepare(`
    SELECT * FROM integration_tests ORDER BY tested_at DESC LIMIT ?
  `).all(limit);
}

// ============================================================
// GitHub issues
// ============================================================

/**
 * Create GitHub issue link
 */
function createGitHubIssue(taskId, repo, issueNumber, issueUrl, title) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO github_issues (id, task_id, repo, issue_number, issue_url, title, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, taskId, repo, issueNumber, issueUrl, title, now);

  return { id, task_id: taskId, repo, issue_number: issueNumber, issue_url: issueUrl };
}

/**
 * Get GitHub issues for task
 */
function getGitHubIssuesForTask(taskId) {
  return db.prepare('SELECT * FROM github_issues WHERE task_id = ?').all(taskId);
}

/**
 * List GitHub issues
 */
function listGitHubIssues(repo = null, limit = 50) {
  if (repo) {
    return db.prepare(`
      SELECT * FROM github_issues WHERE repo = ? ORDER BY created_at DESC LIMIT ?
    `).all(repo, limit);
  }
  return db.prepare(`
    SELECT * FROM github_issues ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

// ============================================================
// Export
// ============================================================

/**
 * Export tasks to CSV format
 */
function exportTasksToCSV(filters = {}) {
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.project) {
    query += ' AND project = ?';
    params.push(filters.project);
  }
  if (filters.from_date) {
    query += ' AND created_at >= ?';
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    query += ' AND created_at <= ?';
    params.push(filters.to_date);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(filters.limit || 10000);

  const tasks = db.prepare(query).all(...params);

  // Convert to CSV
  if (tasks.length === 0) {
    return { csv: '', row_count: 0 };
  }

  const headers = Object.keys(tasks[0]);
  const csvLines = [headers.join(',')];

  for (const task of tasks) {
    const values = headers.map(h => {
      const val = task[h];
      if (val === null || val === undefined) return '';
      const str = String(val).replace(/"/g, '""');
      return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
    });
    csvLines.push(values.join(','));
  }

  return { csv: csvLines.join('\n'), row_count: tasks.length };
}

/**
 * Export tasks to JSON format
 */
function exportTasksToJSON(filters = {}) {
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.project) {
    query += ' AND project = ?';
    params.push(filters.project);
  }
  if (filters.from_date) {
    query += ' AND created_at >= ?';
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    query += ' AND created_at <= ?';
    params.push(filters.to_date);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(filters.limit || 10000);

  const tasks = db.prepare(query).all(...params);
  return { json: JSON.stringify(tasks, null, 2), row_count: tasks.length };
}

// Plan projects — extracted to plan-projects.js

// ============================================================
// Retry management (merged from project-config-cache.js)
// ============================================================

function incrementRetry(taskId) {
  const result = db.prepare('UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?').run(taskId);
  if (result.changes === 0) {
    return null;
  }

  const task = getTask(taskId);
  if (!task) return null;

  return {
    retryCount: task.retry_count,
    maxRetries: task.max_retries,
    shouldRetry: task.retry_count <= task.max_retries
  };
}

function configureTaskRetry(taskId, config) {
  const updates = [];
  const values = [];

  if (config.max_retries !== undefined) {
    updates.push('max_retries = ?');
    values.push(config.max_retries);
  }
  if (config.retry_strategy) {
    updates.push('retry_strategy = ?');
    values.push(config.retry_strategy);
  }
  if (config.retry_delay_seconds !== undefined) {
    updates.push('retry_delay_seconds = ?');
    values.push(config.retry_delay_seconds);
  }

  if (updates.length === 0) return getTask(taskId);

  values.push(taskId);
  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getTask(taskId);
}

function recordRetryAttempt(taskId, attempt) {
  const stmt = db.prepare(`
    INSERT INTO retry_history (task_id, attempt_number, delay_used, error_message, prompt_modification, retried_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    taskId,
    attempt.attempt_number,
    attempt.delay_used || 0,
    attempt.error_message || null,
    attempt.prompt_modification || null,
    new Date().toISOString()
  );

  db.prepare('UPDATE tasks SET last_retry_at = ? WHERE id = ?').run(new Date().toISOString(), taskId);
}

function getRetryHistory(taskId) {
  const stmt = db.prepare(`
    SELECT * FROM retry_history WHERE task_id = ? ORDER BY attempt_number ASC
  `);
  return stmt.all(taskId);
}

function calculateRetryDelay(task) {
  const baseDelay = task.retry_delay_seconds || 30;
  const retryCount = task.retry_count || 0;
  const strategy = task.retry_strategy || 'exponential';

  const MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;
  const MAX_EXPONENT = 20;

  let delay;
  switch (strategy) {
    case 'exponential': {
      const boundedExponent = Math.min(retryCount, MAX_EXPONENT);
      delay = baseDelay * Math.pow(2, boundedExponent);
      break;
    }
    case 'linear':
      delay = baseDelay * (retryCount + 1);
      break;
    case 'fixed':
    default:
      delay = baseDelay;
      break;
  }

  return Math.min(delay, MAX_DELAY_SECONDS);
}

// Pipeline CRUD — extracted to pipeline-crud.js

// ============================================================
// Module exports — own functions + core-specific DI helpers
// ============================================================
const ownExports = {
  ...projectCache, // Re-export project-cache functions (own DI setters override below)
  ...resourceHealth, // Re-export health checks, resource metrics, memory pressure (own DI setters override below)
  ...pipelineCrud, // Re-export pipeline CRUD (own DI setters override below)
  ...planProjects, // Re-export plan project CRUD (own DI setters override below)
  setDb,
  setGetTask,
  setRecordEvent,
  setDbFunctions,
  getDbInstance,
  safeJsonParse,
  findProjectRoot,
  getProjectFromPath,
  getProjectRoot,
  createBudgetAlert,
  getBudgetAlert,
  listBudgetAlerts,
  updateBudgetAlert,
  deleteBudgetAlert,
  checkBudgetAlerts,
  checkDependencies,
  getDependentTasks,
  createScheduledTask,
  listProjects,
  getProjectStats,
  getCurrentProject,
  getProjectDefaults,
  getProjectConfig,
  setProjectConfig,
  setProjectMetadata,
  getProjectMetadata,
  getAllProjectMetadata,
  getProjectRunningCount,
  getProjectDailyUsage,
  canProjectStartTask,
  listProjectConfigs,
  deleteProjectConfig,
  getEffectiveProjectConfig,
  createReportExport,
  updateReportExport,
  getReportExport,
  listReportExports,
  recordIntegrationHealth,
  getIntegrationHealthHistory,
  getLatestIntegrationHealth,
  recordIntegrationTest,
  getIntegrationTests,
  createGitHubIssue,
  getGitHubIssuesForTask,
  listGitHubIssues,
  exportTasksToCSV,
  exportTasksToJSON,
  // Retry management (merged from project-config-cache.js)
  incrementRetry,
  configureTaskRetry,
  recordRetryAttempt,
  getRetryHistory,
  calculateRetryDelay,
};

// ============================================================
// Factory function (dependency injection without singletons)
// ============================================================

function createProjectConfigCore({ db: dbInstance, taskCore, recordEvent, dbFunctions } = {}) {
  if (dbInstance) setDb(dbInstance);
  if (taskCore) setGetTask(taskCore);
  if (recordEvent) setRecordEvent(recordEvent);
  if (dbFunctions) setDbFunctions(dbFunctions);
  return ownExports;
}

ownExports.createProjectConfigCore = createProjectConfigCore;

module.exports = ownExports;
