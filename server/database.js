/**
 * Database module for TORQUE task persistence
 * Uses better-sqlite3 for synchronous SQLite operations
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('./logger').child({ component: 'database' });
const { isSensitiveKey } = require('./utils/sensitive-keys');
const { safeJsonParse } = require('./utils/json');
const { runMigrations } = require('./db/migrations');
const { MAX_METADATA_SIZE } = require('./constants');
const codeAnalysis = require('./db/code-analysis');
const costTracking = require('./db/cost-tracking');
const hostManagement = require('./db/host-management');
const workflowEngine = require('./db/workflow-engine');
const fileTracking = require('./db/file-tracking');

const schedulingAutomation = require('./db/scheduling-automation');
const taskMetadata = require('./db/task-metadata');
const coordination = require('./db/coordination');
const providerRoutingCore = require('./db/provider-routing-core');
const eventTracking = require('./db/event-tracking');
const analytics = require('./db/analytics');
const webhooksStreaming = require('./db/webhooks-streaming');
const inboundWebhooks = require('./db/inbound-webhooks');
const projectConfigCore = require('./db/project-config-core');
const validationRules = require('./db/validation-rules');
const { buildTaskFilterConditions, appendWhereClause } = require('./db/query-filters');
const backupCore = require('./db/backup-core');
const emailPeek = require('./db/email-peek');
const peekFixtureCatalog = require('./db/peek-fixture-catalog');
const packRegistry = require('./db/pack-registry');
const peekPolicyAudit = require('./db/peek-policy-audit');
const peekRecoveryApprovals = require('./db/peek-recovery-approvals');
const recoveryMetrics = require('./db/recovery-metrics');
const policyProfileStore = require('./policy-engine/profile-store');
const policyEvaluationStore = require('./policy-engine/evaluation-store');
const auditStore = require('./db/audit-store');
const ciCache = require('./db/ci-cache');
const { ErrorCodes } = require('./handlers/error-codes');

// === SECURITY: Column whitelist for dynamic SQL queries (M1) ===
// This prevents SQL injection via dynamic column names.
// All dynamic UPDATE ... SET ${column} patterns in this module validate
// column names against this whitelist via validateColumnName() before interpolation.
const ALLOWED_TASK_COLUMNS = new Set([
  'id', 'status', 'task_description', 'working_directory', 'timeout_minutes',
  'auto_approve', 'priority', 'context', 'output', 'error_output', 'exit_code',
  'pid', 'progress_percent', 'files_modified', 'created_at', 'started_at',
  'completed_at', 'retry_count', 'max_retries', 'depends_on', 'template_name',
  'isolated_workspace', 'git_before_sha', 'git_after_sha', 'git_stash_ref',
  'tags', 'project', 'retry_strategy', 'retry_delay_seconds', 'last_retry_at',
  'group_id', 'paused_at', 'pause_reason', 'approval_status', 'workflow_id',
  'workflow_node_id', 'claimed_by_agent', 'required_capabilities', 'ollama_host_id',
  'provider', 'model', 'original_provider', 'provider_switched_at',
  'mcp_instance_id', 'complexity', 'metadata', 'task_metadata'
]);

const { VALID_CONFIG_KEYS } = require('./db/config-keys');
const TRANSACTION_RESULT_SENTINEL = 'TORQUE_TRANSACTION_RESULT';

function createTransactionResultError(result) {
  const error = new Error(TRANSACTION_RESULT_SENTINEL);
  error.code = TRANSACTION_RESULT_SENTINEL;
  error.result = result;
  return error;
}

/**
 * Validate column name against whitelist
 * Throws if invalid column name detected
 */
function validateColumnName(column, allowedSet = ALLOWED_TASK_COLUMNS) {
  if (!allowedSet.has(column)) {
    throw new Error(`Invalid column name: ${column}`);
  }
  return column;
}

// === SECURITY: Whitelist of allowed tables for schema migration ===
// All tables defined in the database schema are allowed for column additions
const ALLOWED_MIGRATION_TABLES = new Set([
  // Core tables
  'tasks', 'templates', 'analytics', 'pipelines', 'pipeline_steps',
  'health_status', 'scheduled_tasks', 'config', 'distributed_locks',
  'archived_tasks', 'token_usage', 'project_config', 'project_metadata',
  // Webhooks & notifications
  'webhooks', 'webhook_logs', 'notification_templates', 'email_notifications',
  // Budget & alerts
  'budget_alerts', 'timeout_alerts', 'performance_alerts',
  // Approval & audit
  'approval_rules', 'approval_requests', 'pending_approvals', 'peek_recovery_approvals',
  'task_comments', 'audit_log', 'audit_config', 'audit_trail',
  // Scheduling
  'cron_schedules', 'maintenance_schedule',
  // Validation & quality
  'validation_rules', 'validation_results', 'quality_scores',
  'failure_patterns', 'failure_matches', 'failure_predictions',
  // Files & baselines
  'file_baselines', 'file_locks', 'file_backups', 'file_location_anomalies',
  'duplicate_file_detections', 'task_file_changes', 'task_file_writes', 'expected_output_paths',
  // Rollback & build
  'rollback_points', 'task_rollbacks', 'auto_rollbacks',
  'build_results', 'build_checks', 'build_error_analysis',
  // Artifacts & storage
  'artifacts', 'task_artifacts', 'artifact_config',
  // Debugging
  'breakpoints', 'task_breakpoints', 'debug_sessions', 'debug_captures',
  // Workflows & templates
  'workflows', 'workflow_steps', 'workflow_templates', 'workflow_forks',
  'template_conditions', 'task_dependencies',
  // Caching & priorities
  'task_cache', 'cache_config', 'cache_stats',
  'task_priority_scores', 'priority_config',
  // Intelligence & experiments
  'experiments', 'strategy_experiments', 'intelligence_log',
  'task_suggestions', 'similar_tasks', 'task_patterns',
  // Agents & coordination
  'agents', 'agent_groups', 'agent_group_members', 'agent_metrics',
  'task_claims', 'routing_rules', 'task_routing_rules',
  'work_stealing_log', 'task_stealing_history', 'coordination_events', 'failover_config',
  // Plans & projects
  'plan_projects', 'plan_project_tasks',
  // Syntax & code quality
  'syntax_validators', 'style_checks', 'linter_configs',
  'complexity_metrics', 'complexity_routing', 'task_complexity_scores',
  'dead_code_results', 'api_contract_results', 'doc_coverage_results',
  // Retry & history
  'retry_rules', 'retry_attempts', 'retry_history', 'adaptive_retry_rules',
  'task_replays', 'regression_results',
  // Rate limiting & costs
  'rate_limits', 'provider_rate_limits', 'rate_limit_events', 'task_quotas',
  'cost_tracking', 'cost_budgets', 'free_tier_daily_usage',
  // Resources & usage
  'resource_usage', 'resource_limits', 'resource_estimates',
  // Providers
  'provider_config', 'provider_usage', 'provider_task_stats',
  'ollama_hosts', 'remote_agents', 'peek_hosts', 'peek_fixture_catalog', 'pack_registry', 'recovery_metrics',
  // Security
  'security_scans', 'security_rules', 'vulnerability_scans',
  'task_fingerprints',
  // Policy engine
  'policy_profiles', 'policy_rules', 'policy_bindings', 'policy_evaluations', 'policy_overrides',
  // Integration & reporting
  'integration_config', 'integration_health', 'integration_tests',
  'github_issues', 'report_exports',
  // Test coverage & diff
  'test_coverage', 'diff_previews',
  // Impact analysis
  'change_impacts', 'output_limits', 'output_violations',
  // Config drift & i18n/a11y
  'config_drift_results', 'config_baselines',
  'i18n_results', 'a11y_results',
  // Type verification & search
  'type_verification_results', 'similar_file_search',
  // XAML/WPF
  'xaml_validation_results', 'xaml_consistency_results', 'smoke_test_results',
  // Safeguards
  'safeguard_tool_config',
  // Task streaming & events
  'task_groups', 'task_streams', 'stream_chunks',
  'task_checkpoints', 'task_event_subscriptions', 'task_events',
  // Misc
  'success_metrics', 'bulk_operations', 'duration_predictions', 'prediction_models',
  'query_stats', 'optimization_history'
]);

// === SECURITY: Pattern for valid column definitions (name TYPE [constraints]) ===
// Only allows alphanumeric column names and standard SQLite types
// Supports only: name TYPE [NOT NULL] [DEFAULT value]
const VALID_COLUMN_DEF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)(?:\s+NOT\s+NULL)?(?:\s+DEFAULT\s+(?:[+-]?\d+(?:\.\d+)?|NULL|[A-Za-z_][A-Za-z0-9_]*|'[^']*'|"[^"]*"))?$/i;

/**
 * Safely add a column to a table, ignoring "column already exists" errors
 * Logs actual errors for debugging
 * SECURITY: Validates table name against whitelist and column definition against pattern
 * @param {any} tableName
 * @param {any} columnDef
 * @returns {any}
 */
function safeAddColumn(tableName, columnDef) {
  if (typeof tableName !== 'string' || typeof columnDef !== 'string') {
    logger.error('[Security] Blocked non-string table name or column definition in safeAddColumn');
    return false;
  }

  const normalizedColumnDef = columnDef.trim();
  // SECURITY: Validate table name against whitelist to prevent SQL injection
  if (!ALLOWED_MIGRATION_TABLES.has(tableName)) {
    logger.error(`[Security] Blocked attempt to add column to non-whitelisted table: ${tableName}`);
    return false;
  }

  // SECURITY: Validate column definition pattern to prevent SQL injection
  if (!VALID_COLUMN_DEF_PATTERN.test(normalizedColumnDef)) {
    logger.error(`[Security] Blocked invalid column definition: ${columnDef}`);
    return false;
  }

  try {
    // NOTE: db.exec is used here because ALTER TABLE doesn't support parameters
    // Security is ensured by the whitelist and pattern validation above
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${normalizedColumnDef}`);
  } catch (e) {
    // SQLite error for duplicate column contains "duplicate column name"
    if (e.message && e.message.includes('duplicate column')) {
      // Column already exists - this is expected, no need to log
      return false;
    }
    // Log unexpected errors
    logger.error(`Error adding column to ${tableName}: ${e.message}`);
    return false;
  }
  return true;
}

// Database path - prefer Linux filesystem for WSL2 compatibility.
// Fall back to a writable temp dir when home is read-only.
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'torque');

function ensureWritableDataDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.accessSync(dirPath, fs.constants.W_OK);
    const dbPath = path.join(dirPath, 'tasks.db');
    if (fs.existsSync(dbPath)) {
      fs.accessSync(dbPath, fs.constants.W_OK);
    }
    return true;
  } catch (_err) {
    void _err;
    return false;
  }
}

function resolveDataDir() {
  const envDir = process.env.TORQUE_DATA_DIR;
  const candidates = [
    envDir,
    DEFAULT_DATA_DIR,
    path.join(os.tmpdir(), 'torque')
  ].filter(Boolean);

  for (const dir of candidates) {
    if (ensureWritableDataDir(dir)) {
      return dir;
    }
  }

  return DEFAULT_DATA_DIR;
}

let DATA_DIR = resolveDataDir();
let DB_PATH = path.join(DATA_DIR, 'tasks.db');

let db = null;
let dbClosed = false;
// _backupTimer moved to db/backup-core.js
const taskStatusTransitionListeners = new Set();
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);

// Close callbacks — modules register cleanup functions (e.g., clearing timers)
const _closeCallbacks = [];
function onClose(fn) { _closeCallbacks.push(fn); }

/**
 * Register a task status transition listener.
 * Listener receives (taskId, status, previousStatus, updatedTask).
 * @param {Function} listener
 */
function addTaskStatusTransitionListener(listener) {
  if (typeof listener !== 'function') return;
  taskStatusTransitionListeners.add(listener);
}

/**
 * Unregister a task status transition listener.
 * @param {Function} listener
 */
function removeTaskStatusTransitionListener(listener) {
  taskStatusTransitionListeners.delete(listener);
}

function notifyTaskStatusTransition(taskId, status, previousStatus, updatedTask) {
  if (!taskStatusTransitionListeners.size) return;
  for (const listener of [...taskStatusTransitionListeners]) {
    try {
      listener(taskId, status, previousStatus, updatedTask);
    } catch (err) {
      logger.warn(`[DB] Task status transition listener failed for ${taskId}: ${err.message}`);
    }
  }
}

// ============================================================
// DI Wiring Helpers (shared by init, resetForTest, restoreDatabase)
// ============================================================

/**
 * Inject the current `db` instance into all sub-modules.
 * Also wires fileTracking.setDataDir for conflict tracking.
 */
function _injectDbAll() {
  hostManagement.setDb(db);
  codeAnalysis.setDb(db);
  costTracking.setDb(db);
  workflowEngine.setDb(db);
  fileTracking.setDb(db);
  fileTracking.setDataDir(process.env.TORQUE_DATA_DIR || DATA_DIR);
  schedulingAutomation.setDb(db);
  taskMetadata.setDb(db);
  coordination.setDb(db);
  providerRoutingCore.setDb(db);
  eventTracking.setDb(db);
  analytics.setDb(db);
  webhooksStreaming.setDb(db);
  inboundWebhooks.setDb(db);
  projectConfigCore.setDb(db);
  backupCore.setDb(db);
  emailPeek.setDb(db);
  peekFixtureCatalog.setDb(db);
  packRegistry.setDb(db);
  peekPolicyAudit.setDb(db);
  peekRecoveryApprovals.setDb(db);
  recoveryMetrics.setDb(db);
  policyProfileStore.setDb(db);
  policyEvaluationStore.setDb(db);
  auditStore.setDb(db);
}

/**
 * Wire all cross-module DI dependencies (setGetTask, setDbFunctions, etc.).
 * Must be called after _injectDbAll() so that sub-modules have a DB handle.
 */
function _wireCrossModuleDI() {
  fileTracking.setGetTask(getTask);
  costTracking.setGetTask(getTask);
  hostManagement.setGetTask(getTask);
  hostManagement.setGetProjectRoot(projectConfigCore.getProjectRoot);

  schedulingAutomation.setGetTask(getTask);
  schedulingAutomation.setRecordTaskEvent((...a) => webhooksStreaming.recordTaskEvent(...a));
  schedulingAutomation.setGetPipeline((...a) => projectConfigCore.getPipeline(...a));
  schedulingAutomation.setCreatePipeline((...a) => projectConfigCore.createPipeline(...a));

  taskMetadata.setGetTask(getTask);
  taskMetadata.setGetTaskEvents((...a) => webhooksStreaming.getTaskEvents(...a));
  taskMetadata.setGetRetryHistory((...a) => projectConfigCore.getRetryHistory(...a));
  taskMetadata.setRecordAuditLog((...a) => schedulingAutomation.recordAuditLog(...a));
  taskMetadata.setGetApprovalHistory((...a) => schedulingAutomation.getApprovalHistory(...a));
  taskMetadata.setCreateTask(createTask);

  coordination.setGetTask(getTask);

  providerRoutingCore.setGetTask(getTask);
  providerRoutingCore.setHostManagement(hostManagement);

  // Analytics + event-tracking DI
  eventTracking.setGetTask(getTask);
  analytics.setGetTask(getTask);
  analytics.setDbFunctions({
    getConfig, getAllConfig,
    getTemplate: (...a) => schedulingAutomation.getTemplate(...a),
    setCacheConfig: (...a) => projectConfigCore.setCacheConfig(...a),
    getCacheStats: (...a) => projectConfigCore.getCacheStats(...a),
  });
  analytics.setFindSimilarTasks(taskMetadata.findSimilarTasks);
  analytics.setSetPriorityWeights(analytics.setPriorityWeights);
  eventTracking.setDbFunctions({
    getConfig, getAllConfig,
    getPipelineSteps: (...a) => projectConfigCore.getPipelineSteps(...a),
    createTask,
    getTemplate: (...a) => schedulingAutomation.getTemplate(...a),
    saveTemplate: (...a) => schedulingAutomation.saveTemplate(...a),
    deleteTemplate: (...a) => schedulingAutomation.deleteTemplate(...a),
    getPipeline: (...a) => projectConfigCore.getPipeline(...a),
    createPipeline: (...a) => projectConfigCore.createPipeline(...a),
    addPipelineStep: (...a) => projectConfigCore.addPipelineStep(...a),
    getScheduledTask: (...a) => schedulingAutomation.getScheduledTask(...a),
    deleteScheduledTask: (...a) => schedulingAutomation.deleteScheduledTask(...a),
    createScheduledTask: (...a) => schedulingAutomation.createScheduledTask(...a),
    setCacheConfig: (...a) => projectConfigCore.setCacheConfig(...a),
    getCacheStats: (...a) => projectConfigCore.getCacheStats(...a),
  });

  projectConfigCore.setGetTask(getTask);
  projectConfigCore.setRecordEvent((...a) => eventTracking.recordEvent(...a));
  projectConfigCore.setDbFunctions({
    getConfig, getAllConfig,
    recordTaskEvent: (...a) => webhooksStreaming.recordTaskEvent(...a),
    cleanupWebhookLogs: (...a) => webhooksStreaming.cleanupWebhookLogs(...a),
    cleanupStreamData: (...a) => webhooksStreaming.cleanupStreamData(...a),
    cleanupCoordinationEvents: (...a) => webhooksStreaming.cleanupCoordinationEvents(...a),
    getRunningCount,
    getTokenUsageSummary: (...a) => costTracking.getTokenUsageSummary(...a),
    getScheduledTask: (...a) => schedulingAutomation.getScheduledTask(...a),
  });

  // Backup-core needs access to internal helpers for restore
  backupCore.setInternals({
    getConfig,
    setConfig,
    setConfigDefault,
    safeAddColumn,
    injectDbAll: _injectDbAll,
    getDbPath: () => DB_PATH,
    getDataDir: () => DATA_DIR,
    setDbRef: (newDb) => { db = newDb; },
    isDbClosed: () => dbClosed,
  });

  policyProfileStore.setGetProjectMetadata(projectConfigCore.getProjectMetadata);
  ciCache.setDb(db);
}

/**
 * Initialize database and create tables
 * @returns {any}
 */
function init() {
  const attemptInit = () => {
    configCache.clear();
    dbClosed = false;
    db = new Database(DB_PATH);

    // SECURITY (M2): Restrict database file permissions on Unix systems.
    // Prevents other users from reading/modifying the task database.
    try {
      fs.chmodSync(DB_PATH, 0o600);
      const dbDir = path.dirname(DB_PATH);
      fs.chmodSync(dbDir, 0o700);
    } catch { /* Windows doesn't support chmod, ignore */ }

    // Enable WAL mode for better concurrent access
    db.pragma('journal_mode = WAL');

    // Allow concurrent writers to wait up to 30s instead of immediately failing with SQLITE_BUSY
    // Increased from 5s to handle burst scenarios (26+ concurrent task submissions)
    db.pragma('busy_timeout = 30000');

    // Enforce foreign key constraints (off by default in SQLite)
    db.pragma('foreign_keys = ON');

    // Schema definitions (extracted to db/schema.js)
    const { applySchema } = require('./db/schema');
    applySchema(db, { safeAddColumn, getConfig, setConfig, setConfigDefault, DATA_DIR });

    // Inject DB into host-management early (before migrateToMultiHost needs it)
    hostManagement.setDb(db);
    // Migration: Migrate single-host Ollama config to multi-host if needed
    const migrationResult = hostManagement.migrateToMultiHost();
    if (migrationResult.migrated) {
      logger.info(`[Multi-Host Migration] Created default host from existing config: ${migrationResult.url}`);
    }

    // Ensure any discovered local hosts (added by mDNS with LAN IPs) are enabled
    const localHostResult = hostManagement.ensureLocalHostEnabled();
    if (localHostResult.fixed > 0) {
      logger.info(`[Startup] Fixed ${localHostResult.fixed} local host(s): ${localHostResult.details.join('; ')}`);
    }

    // Run schema migrations (fail fast - don't operate on partially migrated schema)
    const migrationCount = runMigrations(db);
    if (migrationCount > 0) {
      logger.info('Applied ' + migrationCount + ' database migration(s)');
    }

    // Wire all sub-modules (hostManagement.setDb already called above for migrateToMultiHost)
    _injectDbAll();
    _wireCrossModuleDI();


    const backupInterval = parseInt(getConfig('backup_interval_minutes') || '60', 10);
    if (backupInterval > 0) {
      backupCore.startBackupScheduler(backupInterval * 60000);
    }

    return db;
  };

  try {
    return attemptInit();
  } catch (err) {
    if (err && err.code === 'SQLITE_READONLY') {
      try {
        if (db) {
          db.close();
        }
      } catch (_closeErr) {
        void _closeErr;
        // ignore close errors and continue fallback
      }

      const fallbackDir = path.join(os.tmpdir(), 'torque');
      if (DATA_DIR !== fallbackDir && ensureWritableDataDir(fallbackDir)) {
        DATA_DIR = fallbackDir;
        DB_PATH = path.join(DATA_DIR, 'tasks.db');
        return attemptInit();
      }
    }

    throw err;
  }
}

function createTask(task) {
  if (dbClosed || !db) throw new Error('Database is closed');
  const normalizedProvider = normalizeProviderValue(task.provider);
  const resolvedProvider = normalizedProvider || getConfig('default_provider') || 'codex';
  const originalProvider = task.original_provider || resolvedProvider;
  const metadataObject = normalizeMetadataObject(task.metadata);
  if (!metadataObject.requested_provider) {
    metadataObject.requested_provider = resolvedProvider;
  }
  // Mark tasks that were auto-routed to the default provider (no explicit provider given).
  // These are eligible for overflow to free-tier/local providers when the default is congested.
  if (!normalizedProvider && !metadataObject.user_provider_override) {
    metadataObject.auto_routed = true;
  }
  // Validate task.id is a non-empty string
  if (!task.id || typeof task.id !== 'string' || task.id.trim().length === 0) {
    throw new Error('task.id must be a non-empty string');
  }

  // Validate working_directory is a real path before storing.
  // Catches corrupted paths (e.g. backslashes stripped by bash/JSON escaping)
  // that would silently stall in the queue forever.
  if (task.working_directory) {
    const normalizedWd = path.resolve(task.working_directory);
    try {
      const stats = fs.statSync(normalizedWd);
      if (!stats.isDirectory()) {
        throw new Error(`working_directory is not a directory: ${task.working_directory}`);
      }
      // Use the resolved path to normalize separators
      task.working_directory = normalizedWd;
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`working_directory does not exist: ${task.working_directory} (resolved: ${normalizedWd}). If submitting via REST API, ensure backslashes are properly escaped in JSON.`);
      }
      throw err;
    }
  }

  // Auto-detect project from working directory
  const project = task.project || projectConfigCore.getProjectFromPath(task.working_directory);

  // RB-032: Bound metadata size to prevent overflow
  const metadataStr = task.metadata === null || task.metadata === undefined
    ? null
    : JSON.stringify(metadataObject);
  if (metadataStr && typeof metadataStr === 'string' && metadataStr.length > MAX_METADATA_SIZE) {
    throw new Error(`metadata exceeds maximum size (${metadataStr.length} > ${MAX_METADATA_SIZE} bytes)`);
  }
  const status = task.status || 'pending';

    const stmt = db.prepare(`
    INSERT INTO tasks (
      id, status, task_description, working_directory,
      timeout_minutes, auto_approve, priority, context, created_at,
      max_retries, depends_on, template_name, isolated_workspace, tags, project, provider, model,
      complexity, review_status, ollama_host_id, original_provider, provider_switched_at, metadata, workflow_id, workflow_node_id, stall_timeout_seconds
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    stmt.run(
      task.id,
      status,
      task.task_description,
      task.working_directory || null,
      task.timeout_minutes ?? 30,
      task.auto_approve ? 1 : 0,
      task.priority || 0,
      task.context ? JSON.stringify(task.context) : null,
      new Date().toISOString(),
      task.max_retries !== undefined ? task.max_retries : 2,  // Default to 2 retries for resilience
      task.depends_on ? JSON.stringify(task.depends_on) : null,
      task.template_name || null,
      task.isolated_workspace || null,
      task.tags ? JSON.stringify(task.tags) : null,
      project,
      normalizedProvider,  // null = deferred assignment (set by tryClaimTaskSlot)
      task.model || null,  // Model for ollama/aider-ollama providers
      task.complexity || 'normal',  // Task complexity: simple, normal, complex
      task.review_status || null,  // Review status: pending, approved, needs_correction
      task.ollama_host_id || null,  // Target Ollama host for task
      originalProvider, // Original provider for traceability
      null, // provider_switched_at
      metadataStr,  // Additional task metadata as JSON
      task.workflow_id || null,  // Parent workflow ID for decomposed tasks
      task.workflow_node_id || null,  // Node ID within the workflow
      task.stall_timeout_seconds ?? null
    );
  } catch (err) {
    // F5: Translate SQLITE_FULL to a user-friendly message
    if (err.code === 'SQLITE_FULL' || /database or disk is full/i.test(err.message)) {
      throw new Error('Database disk space exhausted — cannot create task. Free disk space or run vacuum_database maintenance task.');
    }
    throw err;
  }

  if (status === 'queued' || status === 'pending') {
    process.emit('torque:queue-changed');
  }

  // Record analytics event
  eventTracking.recordEvent('task_created', task.id, {
    template: task.template_name,
    has_dependencies: !!task.depends_on,
    tags: task.tags,
    project
  });

  return getTask(task.id);
}

function normalizeProviderValue(provider) {
  if (typeof provider !== 'string') return provider;
  const normalized = provider.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Resolve a partial task ID to full UUID
 * Returns the full ID if found, null otherwise
 * @param {any} id
 * @returns {any}
 */
function resolveTaskId(id) {
  if (!id || !db) return null;
  if (id.length === 36) return id; // Already full UUID
  const startsWith = db.prepare('SELECT id FROM tasks WHERE id LIKE ? ORDER BY created_at DESC').all(id + '%');
  if (startsWith.length > 1) {
    const err = new Error(`Ambiguous task ID prefix "${id}" matches ${startsWith.length} tasks`);
    err.code = ErrorCodes.INVALID_PARAM;
    err.error_code = ErrorCodes.INVALID_PARAM;
    throw err;
  }
  if (startsWith.length === 1) {
    return startsWith[0].id;
  }
  return null;
}

/**
 * Get a task by ID (supports partial ID prefix matching)
 * @param {any} id
 * @returns {any}
 */
function getTask(id) {
  if (!id || !db || dbClosed) return null;

  // Resolve partial ID to full ID
  const fullId = id.length < 36 ? resolveTaskId(id) : id;
  if (!fullId) return null;

  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const row = stmt.get(fullId);

  if (row) {
    row.auto_approve = Boolean(row.auto_approve);
    row.context = safeJsonParse(row.context, null);
    row.files_modified = safeJsonParse(row.files_modified, []);
    row.tags = safeJsonParse(row.tags, []);
    row.depends_on = safeJsonParse(row.depends_on, null);
    row.required_capabilities = safeJsonParse(row.required_capabilities, null);
    if (typeof row.metadata === 'string') {
      try {
        row.metadata = JSON.parse(row.metadata);
      } catch (_err) {
        void _err;
      }
    }
  }
  return row;
}

/**
 * Update non-status task fields without applying status transition rules.
 * Intended for post-completion metadata enrichment and similar in-place writes.
 * @param {string} id
 * @param {object} additionalFields
 * @returns {object|null}
 */
function updateTask(id, additionalFields = {}) {
  if (dbClosed || !db) {
    logger.warn(`[DB] Ignoring updateTask(${id}) — database is closed`);
    return null;
  }

  if (!additionalFields || typeof additionalFields !== 'object' || Array.isArray(additionalFields)) {
    throw new Error('updateTask additionalFields must be an object');
  }

  if (Object.prototype.hasOwnProperty.call(additionalFields, 'status')) {
    throw new Error('Use updateTaskStatus() to modify task status');
  }

  const entries = Object.entries(additionalFields);
  if (entries.length === 0) {
    return getTask(id);
  }

  if (Object.prototype.hasOwnProperty.call(additionalFields, 'provider')) {
    additionalFields.provider = normalizeProviderValue(additionalFields.provider);
  }

  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(additionalFields)) {
    validateColumnName(key, ALLOWED_TASK_COLUMNS);
    updates.push(`${key} = ?`);
    if (
      key === 'files_modified'
      || key === 'context'
      || key === 'tags'
      || key === 'metadata'
      || key === 'depends_on'
      || key === 'required_capabilities'
    ) {
      values.push(value === undefined || value === null ? null : (typeof value === 'string' ? value : JSON.stringify(value)));
    } else {
      values.push(value);
    }
  }

  values.push(id);
  const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`);
  stmt.run(...values);
  return getTask(id);
}

function normalizeMetadataObject(value) {
  if (value === null || value === undefined) {
    return {};
  }
  if (Array.isArray(value)) {
    return {};
  }
  if (typeof value === 'object') {
    return { ...value };
  }
  if (typeof value === 'string') {
    const parsed = safeJsonParse(value, null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...parsed };
    }
  }
  return {};
}

function applyProviderSwitchEnrichment(sourceTask, targetProvider, additionalFields = {}, providerSwitchReason = null) {
  const fromProvider = sourceTask?.provider || null;
  const normalizedTargetProvider = normalizeProviderValue(targetProvider);
  if (!fromProvider || !normalizedTargetProvider || normalizedTargetProvider === fromProvider) {
    return additionalFields;
  }

  const now = new Date().toISOString();
  if (!sourceTask.original_provider && !Object.prototype.hasOwnProperty.call(additionalFields, 'original_provider')) {
    additionalFields.original_provider = fromProvider;
  }
  if (!Object.prototype.hasOwnProperty.call(additionalFields, 'model')) {
    additionalFields.model = null;
  }
  // TDA-02: Clear host identity when moving away from an Ollama provider.
  // Stale ollama_host_id on a non-Ollama provider is a metadata ghost.
  const ollamaProviders = new Set(['ollama', 'aider-ollama', 'hashline-ollama']);
  if (!ollamaProviders.has(normalizedTargetProvider) && !Object.prototype.hasOwnProperty.call(additionalFields, 'ollama_host_id')) {
    additionalFields.ollama_host_id = null;
  }
  if (!Object.prototype.hasOwnProperty.call(additionalFields, 'provider_switched_at')) {
    additionalFields.provider_switched_at = now;
  }

  const providerMeta = normalizeMetadataObject(
    Object.prototype.hasOwnProperty.call(additionalFields, 'metadata')
      ? additionalFields.metadata
      : sourceTask?.metadata
  );
  if (!providerMeta.requested_provider) {
    providerMeta.requested_provider = sourceTask?.original_provider || fromProvider;
  }

  const switchEntry = {
    from: fromProvider,
    to: normalizedTargetProvider,
    at: now,
    reason: providerSwitchReason || 'runtime_provider_fallback',
  };
  const history = Array.isArray(providerMeta.provider_switch_history)
    ? providerMeta.provider_switch_history
    : [];
  history.push(switchEntry);
  providerMeta.provider_switch_history = history.slice(-20);
  providerMeta.last_provider_switch = { ...switchEntry };
  additionalFields.metadata = providerMeta;

  return additionalFields;
}

function normalizeFilesModifiedField(value) {
  const parsed = typeof value === 'string'
    ? safeJsonParse(value, [])
    : value;
  if (!Array.isArray(parsed)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const entry of parsed) {
    const filePath = typeof entry === 'string'
      ? entry
      : (entry && typeof entry.path === 'string' ? entry.path : '');
    const trimmed = String(filePath || '').trim();
    if (!trimmed) continue;

    const dedupeKey = trimmed.replace(/\\/g, '/');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(trimmed);
  }

  return normalized;
}

/**
 * Update task status with transaction for critical transitions
 * Critical transitions (running->completed/failed, any->cancelled) use transactions
 * to prevent race conditions in concurrent environments
 * @param {any} id
 * @param {any} status
 * @param {any} additionalFields
 * @returns {any}
 */
function updateTaskStatus(id, status, additionalFields = {}) {
  if (dbClosed || !db) {
    logger.warn(`[DB] Ignoring updateTaskStatus(${id}, ${status}) — database is closed`);
    return null;
  }
  // Clone to avoid mutating the caller's object
  additionalFields = { ...additionalFields };
  const providerSwitchReason = typeof additionalFields._provider_switch_reason === 'string'
    ? additionalFields._provider_switch_reason
    : null;
  delete additionalFields._provider_switch_reason;
  if (Object.prototype.hasOwnProperty.call(additionalFields, 'provider')) {
    additionalFields.provider = normalizeProviderValue(additionalFields.provider);
  }

  // When requeuing a task, clear the provider so routing can re-evaluate.
  // In slot-pull mode: the scheduler requires provider IS NULL to discover tasks.
  // In legacy mode: clear provider so smart routing can re-evaluate placement.
  // Callers that need to preserve provider should set _preserveProvider flag.
  if (status === 'queued' && !Object.prototype.hasOwnProperty.call(additionalFields, 'provider') && !additionalFields._preserveProvider) {
    additionalFields.provider = null;
  }
  delete additionalFields._preserveProvider;

  const updates = ['status = ?'];
  const values = [status];
  let previousStatus = null;
  let setCompletedAt = status === 'completed' || status === 'failed';

  if (status === 'running' && !additionalFields.started_at) {
    updates.push('started_at = ?');
    values.push(new Date().toISOString());
  }

  // Extract internal flags before processing columns
  const softFail = additionalFields._softFail;
  delete additionalFields._softFail;

  // Track provider switch metadata when a provider transition occurs.
  if (Object.prototype.hasOwnProperty.call(additionalFields, 'provider')) {
    try {
      const currentTask = db.prepare('SELECT provider, original_provider, metadata FROM tasks WHERE id = ?').get(id);
      applyProviderSwitchEnrichment(currentTask, additionalFields.provider, additionalFields, providerSwitchReason);
    } catch (err) {
      logger.info(`[DB] Provider switch metadata enrichment failed for ${id}: ${err.message}`);
    }
  }

  for (const [key, value] of Object.entries(additionalFields)) {
    // Validate column name to prevent SQL injection
    validateColumnName(key, ALLOWED_TASK_COLUMNS);
    updates.push(`${key} = ?`);
    if (key === 'files_modified' || key === 'context' || key === 'tags' || key === 'metadata') {
      values.push(value === undefined || value === null ? null : (typeof value === 'string' ? value : JSON.stringify(value)));
    } else {
      values.push(value);
    }
  }

  // Use transaction for critical status transitions to prevent race conditions
  const isCriticalTransition = ['completed', 'failed', 'cancelled', 'skipped', 'running'].includes(status);

  if (isCriticalTransition) {
    try {
      const criticalTransition = db.transaction(() => {
        // Verify task exists and hasn't already transitioned
        const current = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id);
        if (!current) {
          throw new Error(`Task not found: ${id}`);
        }

        // Prevent double-completion or invalid transitions
        // But still allow updating additional fields when status matches
        if (current.status === status && Object.keys(additionalFields).length === 0) {
          throw createTransactionResultError(getTask(id));
        }
        if (TERMINAL_TASK_STATUSES.has(current.status) && !['pending', 'queued', 'waiting'].includes(status)) {
          // If softFail is enabled, return current task state instead of throwing
          if (softFail) {
            logger.warn(`[DB] Soft-fail: task ${id} already in terminal state '${current.status}', skipping transition to '${status}'`);
            throw createTransactionResultError(getTask(id));
          }
          throw new Error(`Cannot transition task ${id} from ${current.status} to ${status}`);
        }

        previousStatus = current.status;

        if (status === 'cancelled' && previousStatus === 'running') setCompletedAt = true;
        if (status === 'skipped') setCompletedAt = true;
        if (setCompletedAt) {
          updates.push('completed_at = ?');
          values.push(new Date().toISOString());
        }
        values.push(id);
        values.push(previousStatus);

        const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND status = ?`);
        const result = stmt.run(...values);
        if (result.changes === 0) {
          logger.warn(`[DB] Double-completion race: task ${id} status changed by another process (expected '${previousStatus}')`);
          throw createTransactionResultError(getTask(id));
        }
      });
      criticalTransition.immediate();
    } catch (err) {
      if (err?.code === TRANSACTION_RESULT_SENTINEL) {
        return err.result;
      }
      throw err;
    }
  } else {
    // Non-critical updates don't need transaction overhead
    const current = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id);
    if (!current) {
      values.push(id);
      const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`);
      stmt.run(...values);
      return null;
    }

    if (TERMINAL_TASK_STATUSES.has(current.status) && !['pending', 'queued', 'waiting'].includes(status)) {
      if (softFail) {
        return getTask(id);
      }
      throw new Error(`Cannot transition task ${id} from ${current.status} to ${status}`);
    }

    previousStatus = current.status;
    values.push(id);
    values.push(previousStatus);
    const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND status = ?`);
    const result = stmt.run(...values);
    if (result.changes === 0) {
      // Concurrent update detected — re-read and return current state
      const refreshed = getTask(id);
      logger.warn(`[DB] Non-critical update race: task ${id} status changed concurrently (expected '${previousStatus}', now '${refreshed?.status}')`);
      return refreshed;
    }
  }

  if (status === 'queued' || status === 'pending' || TERMINAL_TASK_STATUSES.has(status)) {
    process.emit('torque:queue-changed');
  }

  if (TERMINAL_TASK_STATUSES.has(status) && Object.prototype.hasOwnProperty.call(additionalFields, 'files_modified')) {
    const modifiedFiles = normalizeFilesModifiedField(additionalFields.files_modified);
    for (const filePath of modifiedFiles) {
      try {
        fileTracking.recordTaskFileWrite(id, filePath, null);
      } catch (err) {
        logger.debug(`[DB] Failed to record task file snapshot for ${id} ${filePath}: ${err.message}`);
      }
    }
  }

  if (TERMINAL_TASK_STATUSES.has(status) && previousStatus && previousStatus !== status) {
    notifyTaskStatusTransition(id, status, previousStatus, getTask(id));
  }

  return getTask(id);
}

/**
 * Return a task to queue after it was treated as starting but never reached a
 * truthful execution start. Clears transient execution artifacts so queued
 * state cannot masquerade as partially running or completed work.
 *
 * IMPORTANT: Always clears the provider field to NULL so the slot-pull scheduler
 * can re-discover the task (it queries WHERE provider IS NULL). Callers that want
 * to target a specific provider on retry should set `intended_provider` in the
 * task metadata instead — resolveProviderRouting reads it on the next start attempt.
 *
 * If the caller passes `provider` in additionalFields, it is extracted and written
 * to metadata.intended_provider instead, preserving the routing hint without
 * blocking slot-pull discovery.
 *
 * @param {string} id
 * @param {Object} additionalFields
 * @returns {Object|null}
 */
function requeueTaskAfterAttemptedStart(id, additionalFields = {}) {
  // Extract provider from patch — route it to metadata instead of the column
  const { provider: patchProvider, metadata: patchMetadata, ...restFields } = additionalFields;

  let metadataUpdate = patchMetadata;
  if (patchProvider) {
    // Read existing metadata, merge the routing hint
    const task = getTask(id);
    const existingMeta = task?.metadata
      ? (typeof task.metadata === 'string' ? (() => { try { return JSON.parse(task.metadata); } catch { return {}; } })() : { ...task.metadata })
      : {};
    existingMeta.intended_provider = patchProvider;
    existingMeta.eligible_providers = [patchProvider];
    metadataUpdate = JSON.stringify(existingMeta);
  }

  return updateTaskStatus(id, 'queued', {
    started_at: null,
    completed_at: null,
    pid: null,
    progress_percent: null,
    exit_code: null,
    mcp_instance_id: null,
    ollama_host_id: null,
    provider: null,
    ...restFields,
    ...(metadataUpdate != null ? { metadata: metadataUpdate } : {}),
  });
}

/**
 * Update task progress
 * Progress is clamped to 0-100 range to handle edge cases
 * @param {any} id
 * @param {any} progress
 * @param {any} output
 * @returns {any}
 */
function updateTaskProgress(id, progress, output = null) {
  // Clamp progress to valid range (0-100) and handle edge cases
  let validProgress = 0;
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    validProgress = Math.max(0, Math.min(100, Math.round(progress)));
  } else if (typeof progress === 'string') {
    const parsed = parseInt(progress, 10);
    if (Number.isFinite(parsed)) {
      validProgress = Math.max(0, Math.min(100, parsed));
    }
  }

  const updates = ['progress_percent = ?'];
  const values = [validProgress];

  if (output !== null) {
    updates.push('output = COALESCE(output, \'\') || ?');
    values.push(output);
  }

  values.push(id);

  const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`);
  stmt.run(...values);
}

/**
 * List tasks with optional filtering
 * @param {any} options
 * @returns {any}
 */
function listTasks(options = {}) {
  let query = 'SELECT * FROM tasks';
  const { conditions, values } = buildTaskFilterConditions(options, eventTracking.escapeLikePattern);
  query = appendWhereClause(query, conditions);

  // Support custom ordering with whitelist validation
  const allowedOrderColumns = ['created_at', 'completed_at', 'started_at', 'priority', 'status', 'id'];
  const orderCol = allowedOrderColumns.includes(options.orderBy) ? options.orderBy : 'created_at';
  const orderDir = options.orderDir === 'desc' ? 'DESC' : 'ASC';
  const idDir = orderDir;
  query += ` ORDER BY ${orderCol} ${orderDir}, id ${idDir}`;

  // Apply limit with bounds validation to prevent excessive result sets
  const MAX_LIMIT = 10000;
  const DEFAULT_LIMIT = 1000;
  if (options.limit) {
    const boundedLimit = Math.max(1, Math.min(parseInt(options.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT));
    query += ' LIMIT ?';
    values.push(boundedLimit);
  } else {
    // Apply default limit to prevent unbounded queries
    query += ' LIMIT ?';
    values.push(DEFAULT_LIMIT);
  }

  // Apply offset for pagination
  if (options.offset && options.offset > 0) {
    query += ' OFFSET ?';
    values.push(parseInt(options.offset, 10));
  }

  // Validate query length to prevent DoS via pathologically large queries
  const MAX_QUERY_LENGTH = 10000;
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Query too complex: ${query.length} chars exceeds ${MAX_QUERY_LENGTH} limit`);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...values);

  return rows.map(row => ({
    ...row,
    auto_approve: Boolean(row.auto_approve),
    context: safeJsonParse(row.context, null),
    files_modified: safeJsonParse(row.files_modified, []),
    tags: safeJsonParse(row.tags, [])
  }));
}

/**
 * Fetch queued tasks with only the columns needed for queue processing.
 * Avoids fetching large TEXT blobs (output, error_output, context).
 * @param {number} limit - Maximum tasks to return (default 1000)
 * @returns {Array} Lightweight task rows
 */
function listQueuedTasksLightweight(limit = 1000) {
  if (!db || dbClosed) return [];
  return db.prepare(`
    SELECT t.id, t.status, t.provider, t.original_provider, t.model, t.priority,
           t.created_at, t.working_directory, t.timeout_minutes, t.auto_approve,
           t.retry_count, t.max_retries, t.depends_on, t.approval_status,
           t.ollama_host_id, t.stall_timeout_seconds, t.metadata, t.tags,
           COALESCE(w.priority, 0) as workflow_priority
    FROM tasks t
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.status = 'queued'
    ORDER BY COALESCE(w.priority, 0) DESC, t.priority DESC, t.created_at ASC
    LIMIT ?
  `).all(limit);
}

/**
 * Delete a task and all its child records (cascading).
 * Only tasks in terminal states (failed, completed, cancelled) can be deleted.
 */
function deleteTask(taskId) {
  const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status === 'running' || task.status === 'queued' || task.status === 'pending') {
    throw new Error(`Cannot delete task ${taskId} — status is '${task.status}'. Cancel it first.`);
  }
  const del = db.transaction(() => {
    _cleanOrphanedTaskChildren(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });
  del();
  return { deleted: true, id: taskId, status: task.status };
}

/**
 * Delete all tasks matching a status filter (e.g. 'failed') with cascading.
 * Only terminal states allowed. Returns count of deleted tasks.
 */
function deleteTasks(status) {
  const allowed = ['failed', 'completed', 'cancelled'];
  if (!allowed.includes(status)) {
    throw new Error(`Can only bulk-delete tasks with status: ${allowed.join(', ')}. Got: '${status}'`);
  }
  const del = db.transaction(() => {
    // Get IDs first for targeted child cleanup
    const taskIds = db.prepare('SELECT id FROM tasks WHERE status = ?').all(status).map(r => r.id);
    for (const id of taskIds) {
      _cleanOrphanedTaskChildren(id);
    }
    return db.prepare('DELETE FROM tasks WHERE status = ?').run(status);
  });
  const result = del();
  return { deleted: result.changes, status };
}

/**
 * Delete all child records for a specific task ID from all FK-linked tables.
 */
function _cleanOrphanedTaskChildren(taskId) {
  const childTables = Object.freeze([
    'pipeline_steps', 'token_usage', 'retry_history', 'task_file_changes', 'task_file_writes',
    'task_streams', 'task_checkpoints', 'task_event_subscriptions', 'task_events',
    'task_suggestions', 'approval_requests', 'peek_recovery_approvals', 'task_comments', 'resource_usage',
    'task_claims', 'work_stealing_log', 'validation_results',
    'pending_approvals', 'failure_matches', 'retry_attempts', 'diff_previews',
    'quality_scores', 'task_rollbacks', 'build_checks', 'cost_tracking',
    'task_fingerprints', 'file_backups', 'security_scans', 'test_coverage',
    'style_checks', 'change_impacts', 'timeout_alerts', 'output_violations',
    'expected_output_paths', 'file_location_anomalies', 'duplicate_file_detections',
    'type_verification_results', 'build_error_analysis', 'similar_file_search',
    'task_complexity_scores', 'auto_rollbacks', 'xaml_validation_results',
    'xaml_consistency_results', 'smoke_test_results'
  ]);
  for (const table of childTables) {
    try { db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(taskId); } catch (_e) { void _e; /* skip */ }
  }
  // Tables with non-standard FK columns
  try { db.prepare('DELETE FROM similar_tasks WHERE source_task_id = ? OR similar_task_id = ?').run(taskId, taskId); } catch (_e) { void _e; /* skip */ }
  try { db.prepare('DELETE FROM task_replays WHERE original_task_id = ? OR replay_task_id = ?').run(taskId, taskId); } catch (_e) { void _e; /* skip */ }
}

/**
 * Count tasks matching filter criteria (for pagination)
 */
function countTasks(options = {}) {
  let query = 'SELECT COUNT(*) as count FROM tasks';
  const { conditions, values } = buildTaskFilterConditions(options, eventTracking.escapeLikePattern);
  query = appendWhereClause(query, conditions);

  const stmt = db.prepare(query);
  return stmt.get(...values).count;
}

/**
 * Count all tasks grouped by status in a single query
 */
function countTasksByStatus() {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM tasks WHERE archived = 0 GROUP BY status').all();
  const counts = { running: 0, queued: 0, completed: 0, failed: 0, pending: 0, cancelled: 0, blocked: 0 };
  for (const row of rows) {
    if (row.status in counts) counts[row.status] = row.count;
  }
  return counts;
}

/**
 * Purge output/error_output from terminal tasks older than retentionDays.
 * Retains task metadata but frees potentially large TEXT columns.
 * @param {number} retentionDays - Tasks older than this have output cleared (default: 30)
 * @returns {number} Number of tasks purged
 */
function purgeOldTaskOutput(retentionDays = 30) {
  if (!db || dbClosed) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600000).toISOString();
  const result = db.prepare(`
    UPDATE tasks SET output = NULL, error_output = NULL
    WHERE status IN ('completed', 'failed', 'cancelled')
      AND created_at < ?
      AND (output IS NOT NULL OR error_output IS NOT NULL)
  `).run(cutoff);
  return result.changes;
}

/**
 * Archive terminal tasks (completed, failed, cancelled) older than the given age.
 * Archived tasks are excluded from dashboard listings by default.
 * @param {number} maxAgeHours - Tasks older than this are archived (default: 24)
 * @returns {number} Number of tasks archived
 */
function archiveOldTasks(maxAgeHours = 24) {
  if (!db || dbClosed) return 0;
  const cutoff = new Date(Date.now() - maxAgeHours * 3600000).toISOString();
  const result = db.prepare(`
    UPDATE tasks SET archived = 1
    WHERE archived = 0
      AND status IN ('completed', 'failed', 'cancelled')
      AND created_at < ?
  `).run(cutoff);
  return result.changes;
}

/**
 * Get count of running tasks
 * @returns {any}
 */
function getRunningCount() {
  if (!db || dbClosed) return 0;
  const stmt = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?');
  return stmt.get('running').count;
}

/**
 * Get count of running tasks for a single provider.
 * @param {string} provider
 * @returns {number}
 */
function getRunningCountByProvider(provider) {
  if (!db || dbClosed) return 0;
  const normalizedProvider = normalizeProviderValue(provider);
  if (!normalizedProvider) return 0;
  const stmt = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider = ?');
  return stmt.get('running', normalizedProvider).count;
}

/**
 * Get running tasks with only essential columns for stale check
 * This is much faster than listTasks() as it skips large TEXT columns (output, context, error_output)
 * @returns {any}
 */
function getRunningTasksLightweight() {
  const stmt = db.prepare(`
    SELECT id, status, started_at, timeout_minutes, working_directory, task_description
    FROM tasks
    WHERE status = 'running'
  `);
  return stmt.all();
}

/**
 * Get next queued task (highest priority, oldest first)
 * Uses Wave 5 intelligent priority scoring when available
 * Excludes 'codex-pending' tasks which are held for stronger models
 * @returns {any}
 */
function getNextQueuedTask() {
  // Try to get task using intelligent priority scores first
  // Exclude codex-pending tasks - they require stronger models (Claude/Codex with API keys)
  const priorityStmt = db.prepare(`
    SELECT t.* FROM tasks t
    LEFT JOIN task_priority_scores p ON t.id = p.task_id
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.status = 'queued'
      AND (t.provider IS NULL OR t.provider != 'codex-pending')
    ORDER BY
      COALESCE(w.priority, 0) DESC,
      COALESCE(p.combined_score, 0) DESC,
      t.priority DESC,
      t.created_at ASC
    LIMIT 1
  `);
  const row = priorityStmt.get();

  if (row) {
    row.auto_approve = Boolean(row.auto_approve);
    row.context = safeJsonParse(row.context, null);
  }
  return row;
}

/**
 * Atomically claim a task slot if under concurrency limits
 * Checks global concurrency and optional per-provider limits in one transaction
 * before marking the task as running.
 * Returns { success: true, task } if claimed, { success: false, reason } otherwise.
 *
 * @param {any} taskId
 * @param {any} maxConcurrent
 * @param {string|null} mcpInstanceId
 * @param {string|null} provider
 * @param {number|null} providerLimit
 * @param {string[]} [providerGroup]
 * @param {number|null} [secondaryProviderLimit]
 * @param {string[]} [secondaryProviderGroup]
 * @returns {{ success: boolean, task?: object, reason?: string, runningCount?: number, providerRunningCount?: number }}
 */
function tryClaimTaskSlot(
  taskId,
  maxConcurrent,
  mcpInstanceId = null,
  provider = null,
  providerLimit = null,
  providerGroup = [],
  secondaryProviderLimit = null,
  secondaryProviderGroup = [],
) {
  const finalProvider = typeof provider === 'string' && provider.trim() ? provider.trim() : null;
  const normalizedGroup = Array.isArray(providerGroup) && providerGroup.length > 0
    ? providerGroup.filter((p) => typeof p === 'string' && p.trim())
    : [];
  const normalizedSecondaryGroup = Array.isArray(secondaryProviderGroup) && secondaryProviderGroup.length > 0
    ? secondaryProviderGroup.filter((p) => typeof p === 'string' && p.trim())
    : [];
  const numericProviderLimit = (providerLimit != null && Number.isFinite(Number(providerLimit)))
    ? Number(providerLimit) : null;
  const numericSecondaryProviderLimit = (secondaryProviderLimit != null && Number.isFinite(Number(secondaryProviderLimit)))
    ? Number(secondaryProviderLimit) : null;
  const shouldCheckProviderLimit = Boolean(finalProvider && numericProviderLimit !== null);
  const shouldCheckSecondaryProviderLimit = Boolean(normalizedSecondaryGroup.length > 0 && numericSecondaryProviderLimit !== null);

  try {
    const claimTransaction = db.transaction(() => {
      // Get current running count
      const runningCount = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?').get('running').count;

      if (runningCount >= maxConcurrent) {
        throw createTransactionResultError({ success: false, reason: 'at_capacity', runningCount });
      }

      if (shouldCheckProviderLimit) {
        const providerRunning = normalizedGroup.length > 0
          ? db.prepare(
            `SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider IN (${normalizedGroup.map(() => '?').join(',')})`
          ).get('running', ...normalizedGroup).count
          : db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider = ?')
            .get('running', finalProvider).count;
        if (providerRunning >= numericProviderLimit) {
          throw createTransactionResultError({
            success: false,
            reason: 'provider_at_capacity',
            providerRunningCount: providerRunning,
            providerLimit: numericProviderLimit,
            limitScope: normalizedGroup.length > 0 ? 'provider_group' : 'provider',
          });
        }
      }

      if (shouldCheckSecondaryProviderLimit) {
        const secondaryProviderRunning = db.prepare(
          `SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider IN (${normalizedSecondaryGroup.map(() => '?').join(',')})`
        ).get('running', ...normalizedSecondaryGroup).count;
        if (secondaryProviderRunning >= numericSecondaryProviderLimit) {
          throw createTransactionResultError({
            success: false,
            reason: 'provider_at_capacity',
            providerRunningCount: secondaryProviderRunning,
            providerLimit: numericSecondaryProviderLimit,
            limitScope: 'category',
          });
        }
      }

      // Get the task to verify it exists and is in correct state
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (!task) {
        throw createTransactionResultError({ success: false, reason: 'not_found' });
      }

      if (task.status === 'running') {
        throw createTransactionResultError({ success: false, reason: 'already_running' });
      }

      if (task.status !== 'queued' && task.status !== 'pending') {
        throw createTransactionResultError({ success: false, reason: 'invalid_status', status: task.status });
      }

      if (task.approval_status && task.approval_status !== 'approved' && task.approval_status !== 'not_required') {
        throw createTransactionResultError({
          success: false,
          reason: 'approval_not_approved',
          approval_status: task.approval_status,
        });
      }

      const providerSwitchFields = {};
      if (finalProvider) {
        try {
          applyProviderSwitchEnrichment(task, finalProvider, providerSwitchFields);
        } catch (err) {
          logger.info(`[DB] Provider switch metadata enrichment failed during slot claim for ${taskId}: ${err.message}`);
        }
      }

      const updateClauses = ['status = ?', 'started_at = ?'];
      const updateValues = ['running', new Date().toISOString()];

      if (mcpInstanceId) {
        updateClauses.push('mcp_instance_id = ?');
        updateValues.push(mcpInstanceId);
      }
      if (finalProvider) {
        updateClauses.push('provider = ?');
        updateValues.push(finalProvider);
      }
      for (const [key, value] of Object.entries(providerSwitchFields)) {
        validateColumnName(key, ALLOWED_TASK_COLUMNS);
        updateClauses.push(`${key} = ?`);
        if (key === 'metadata') {
          updateValues.push(value === undefined || value === null ? null : (typeof value === 'string' ? value : JSON.stringify(value)));
        } else {
          updateValues.push(value);
        }
      }

      // Atomically update to running status and stamp owning MCP instance
      const claimUpdate = db.prepare(
        `UPDATE tasks SET ${updateClauses.join(', ')} WHERE id = ? AND status IN ('queued', 'pending')`
      ).run(...updateValues, taskId);
      if (claimUpdate.changes === 0) {
        const latestTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        if (!latestTask) {
          throw createTransactionResultError({ success: false, reason: 'not_found' });
        }
        if (latestTask.status === 'running') {
          throw createTransactionResultError({ success: false, reason: 'already_running' });
        }
        throw createTransactionResultError({ success: false, reason: 'invalid_status', status: latestTask.status });
      }

      // Return the updated task
      const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (updatedTask) {
        updatedTask.auto_approve = Boolean(updatedTask.auto_approve);
        updatedTask.context = safeJsonParse(updatedTask.context, null);
      }

      return { success: true, task: updatedTask };
    });
    return claimTransaction.immediate();
  } catch (error) {
    if (error?.code === TRANSACTION_RESULT_SENTINEL) {
      return error.result;
    }
    throw error;
  }
}

const configCache = new Map();
const CONFIG_CACHE_TTL = 30000;

/**
 * Get configuration value
 * @param {any} key
 * @returns {any}
 */
function getConfig(key) {
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) {
    return cached.value;
  }
  if (!db || dbClosed) return null;
  const stmt = db.prepare('SELECT value FROM config WHERE key = ?');
  const row = stmt.get(key);
  let value = row ? row.value : null;

  // SECURITY: decrypt sensitive values stored with ENC: prefix
  if (value && isSensitiveKey(key) && value.startsWith('ENC:')) {
    try {
      const credCrypto = require('./utils/credential-crypto');
      const encKey = credCrypto.loadOrCreateKey();
      const parts = value.slice(4).split(':');
      if (parts.length === 3) {
        value = credCrypto.decrypt(parts[0], parts[1], parts[2], encKey);
      }
    } catch (err) {
      logger.warn(`Failed to decrypt config key ${key}: ${err.message}`);
      // Return raw value as fallback (may be plaintext from before encryption was enabled)
    }
  }

  configCache.set(key, { value, ts: Date.now() });
  return value;
}

/**
 * Set configuration value
 * @param {any} key
 * @param {any} value
 * @returns {any}
 */
function setConfig(key, value) {
  if (!VALID_CONFIG_KEYS.has(key)) {
    logger.warn(`setConfig called with unknown key: ${key}`);
  }

  let storedValue = String(value);

  // SECURITY: encrypt sensitive values before storing
  if (isSensitiveKey(key) && storedValue && !storedValue.startsWith('ENC:')) {
    try {
      const credCrypto = require('./utils/credential-crypto');
      const encKey = credCrypto.loadOrCreateKey();
      const { encrypted_value, iv, auth_tag } = credCrypto.encrypt(storedValue, encKey);
      storedValue = `ENC:${encrypted_value}:${iv}:${auth_tag}`;
    } catch (err) {
      logger.warn(`Failed to encrypt config key ${key}: ${err.message}. Storing plaintext.`);
    }
  }

  const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  stmt.run(key, storedValue);
  configCache.delete(key);
}

/**
 * Set configuration default — only sets if key does not already exist.
 * Used by schema seeding to avoid overwriting user customizations on restart.
 * @param {string} key
 * @param {string} value
 */
function setConfigDefault(key, value) {
  const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  const result = stmt.run(key, String(value));
  // Clear cache if row was inserted (changes > 0) so reads pick up new value
  if (result.changes > 0) {
    configCache.delete(key);
  }
}

/**
 * Get all configuration
 */
function getAllConfig() {
  const stmt = db.prepare('SELECT key, value FROM config');
  const rows = stmt.all();
  const config = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

function getDbInstance() {
  return db;
}

function getProviderRateLimits() {
  const db = getDbInstance();
  try {
    return db.prepare('SELECT * FROM provider_rate_limits WHERE is_free_tier = 1').all();
  } catch {
    return [];
  }
}

/**
 * Close database connection.
 * Sets dbClosed flag to prevent operations after close from pending callbacks.
 */
function close() {
  dbClosed = true;
  backupCore.stopBackupScheduler();
  // Run registered cleanup callbacks (e.g., queue-scheduler timer cleanup)
  for (const fn of _closeCallbacks) {
    try { fn(); } catch { /* non-fatal */ }
  }
  if (db) {
    try {
      // Flush WAL file before closing to prevent unbounded growth
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (_e) {
      void _e;
      // Non-fatal — close will still work
    }
    db.close();
    db = null;
  }
}


// ============================================================
// Test-only: in-memory DB reset from serialized buffer
// ============================================================

/**
 * Replace the live DB handle with a fresh in-memory copy from a serialized buffer.
 * Used by tests to reset state in ~5-10ms without filesystem I/O or module cache clearing.
 *
 * @param {Buffer} buffer - Serialized SQLite database (from db.serialize())
 * @returns {object} The new better-sqlite3 Database instance
 */
function resetForTest(buffer) {
  // Run cleanup callbacks before swapping DB (clears queue-scheduler timers etc.)
  for (const fn of _closeCallbacks) {
    try { fn(); } catch { /* non-fatal */ }
  }
  // Close existing connection if any
  if (db) {
    try { db.close(); } catch { /* ok */ }
  }
  dbClosed = false;
  configCache.clear();

  // Create fresh in-memory DB from serialized buffer
  db = new Database(buffer);
  // WAL pragma is not supported on in-memory databases — skip it
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Wire all sub-modules
  _injectDbAll();
  _wireCrossModuleDI();

  return db;
}

// Backup/restore, failover tracking, email notifications, and peek host operations
// are now in db/backup-core.js and db/email-peek.js (Phase 5.2 / D1)

// ============================================================
// Exports: core functions + merged sub-module APIs
// ============================================================

// Dependency-injection wiring functions (internal, not part of public API)
const _DI_INTERNALS = new Set([
  'setDb', 'setGetTask', 'setDbFunctions', 'setRecordEvent',
  'setRecordTaskEvent', 'setGetPipeline', 'setCreatePipeline',
  'setGetTaskEvents', 'setGetRetryHistory', 'setRecordAuditLog',
  'setGetApprovalHistory', 'setCreateTask', 'setHostManagement',
  'setGetProjectRoot', 'setDataDir', 'setInternals', 'setGetProjectMetadata',
]);

const coreExports = {
  // Utility functions
  safeJsonParse,
  safeAddColumn,
  validateColumnName,
  getDataDir: () => DATA_DIR,
  getDbPath: () => DB_PATH,
  getDbInstance,
  isDbClosed: () => dbClosed,
  isReady: () => !!db && !dbClosed,
  // Core task operations
  init,
  createTask,
  getTask,
  updateTask,
  resolveTaskId,
  updateTaskStatus,
  requeueTaskAfterAttemptedStart,
  updateTaskProgress,
  listTasks,
  listQueuedTasksLightweight,
  checkApprovalRequired: schedulingAutomation.checkApprovalRequired,
  deleteTask,
  deleteTasks,
  countTasks,
  countTasksByStatus,
  archiveOldTasks,
  purgeOldTaskOutput,
  getRunningCount,
  getRunningCountByProvider,
  getRunningTasksLightweight,
  getNextQueuedTask,
  tryClaimTaskSlot,
  // Configuration
  getConfig,
  setConfig,
  setConfigDefault,
  getAllConfig,
  getProviderRateLimits,
  close,
  onClose,
  addTaskStatusTransitionListener,
  removeTaskStatusTransitionListener,
  // Test-only
  resetForTest,
  // Backup/restore (delegated to db/backup-core.js)
  backupDatabase: (...a) => backupCore.backupDatabase(...a),
  startBackupScheduler: (...a) => backupCore.startBackupScheduler(...a),
  stopBackupScheduler: () => backupCore.stopBackupScheduler(),
  restoreDatabase: (...a) => backupCore.restoreDatabase(...a),
  listBackups: (...a) => backupCore.listBackups(...a),
  cleanupOldBackups: (...a) => backupCore.cleanupOldBackups(...a),
  // Failover/email/peek (delegated to db/email-peek.js)
  recordFailoverEvent: (...a) => emailPeek.recordFailoverEvent(...a),
  getFailoverEvents: (...a) => emailPeek.getFailoverEvents(...a),
  recordEmailNotification: (...a) => emailPeek.recordEmailNotification(...a),
  listEmailNotifications: (...a) => emailPeek.listEmailNotifications(...a),
  getEmailNotification: (...a) => emailPeek.getEmailNotification(...a),
  updateEmailNotificationStatus: (...a) => emailPeek.updateEmailNotificationStatus(...a),
  registerPeekHost: (...a) => emailPeek.registerPeekHost(...a),
  unregisterPeekHost: (...a) => emailPeek.unregisterPeekHost(...a),
  listPeekHosts: () => emailPeek.listPeekHosts(),
  getDefaultPeekHost: () => emailPeek.getDefaultPeekHost(),
  getPeekHost: (...a) => emailPeek.getPeekHost(...a),
  updatePeekHost: (...a) => emailPeek.updatePeekHost(...a),
};

// Sub-modules whose exports are merged into the database API surface
const _subModules = [
  codeAnalysis, costTracking, hostManagement, workflowEngine, fileTracking,
  schedulingAutomation, taskMetadata, coordination,
  providerRoutingCore,
  eventTracking, analytics,
  webhooksStreaming, inboundWebhooks,
  projectConfigCore, validationRules,
  backupCore, emailPeek, peekFixtureCatalog, packRegistry,
  peekPolicyAudit, peekRecoveryApprovals, recoveryMetrics,
  policyProfileStore, policyEvaluationStore,
  auditStore,
  {
    mod: ciCache,
    fns: [
      'upsertCiRunCache',
      'getCiRunCache',
      'listCiRunCache',
      'pruneCiRunCache',
      'upsertCiWatch',
      'getCiWatch',
      'deactivateCiWatch',
      'listActiveCiWatches',
    ],
  },
];

// Build merged exports: core functions take precedence, DI wiring is excluded
const mergedExports = { ...coreExports };
for (const modOrSpec of _subModules) {
  const mod = modOrSpec.mod || modOrSpec;
  const onlyFns = Array.isArray(modOrSpec.fns) ? new Set(modOrSpec.fns) : null;
  for (const [key, value] of Object.entries(mod)) {
    if (onlyFns && !onlyFns.has(key)) {
      continue;
    }
    if (!_DI_INTERNALS.has(key) && !(key in mergedExports)) {
      mergedExports[key] = value;
    }
  }
}

module.exports = mergedExports;
