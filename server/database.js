/**
 * Database module for TORQUE task persistence — LEGACY FACADE
 *
 * STATUS: This module is a compatibility layer. All 47 sub-modules now have
 * factory exports (createXxx) and are registered in the DI container
 * (server/container.js). New code should use the container:
 *
 *   const { defaultContainer } = require('./container');
 *   const hostMgmt = defaultContainer.get('hostManagement');
 *
 * This facade still merges all sub-module exports into a flat namespace
 * for backward compatibility with ~87 source files and ~161 test files
 * that import it directly. It will be removed incrementally as consumers
 * migrate to the container.
 *
 * Migration guide:
 *   1. Instead of: const db = require('./database'); db.getTask(id)
 *      Use:        const taskCore = container.get('taskCore'); taskCore.getTask(id)
 *   2. Instead of: const db = require('../database'); db.getConfig('key')
 *      Use:        const configCore = container.get('configCore'); configCore.getConfig('key')
 *
 * Uses better-sqlite3 for synchronous SQLite operations.
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('./logger').child({ component: 'database' });
const { safeJsonParse } = require('./utils/json');
const { runMigrations } = require('./db/migrations');
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
const modelRoles = require('./db/model-roles');
const taskCore = require('./db/task-core');
const configCore = require('./db/config-core');



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
  'cost_tracking', 'cost_budgets', 'quota_daily_usage',
  // Resources & usage
  'resource_usage', 'resource_limits', 'resource_estimates',
  // Providers
  'provider_config', 'provider_usage', 'provider_task_stats',
  'ollama_hosts', 'remote_agents', 'peek_hosts', 'peek_fixture_catalog', 'pack_registry', 'recovery_metrics',
  // Auth
  'api_keys',
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
const taskStatusTransitionListeners = new Set();

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
 * Wire all sub-modules via their createXxx factory functions.
 * Each factory internally calls setDb() plus all cross-module setters,
 * replacing both _injectDbAll() and _wireCrossModuleDI() in a single pass.
 *
 * Modules are wired in topological order (dependency-first):
 *   Phase 1 — No cross-module deps (just db)
 *   Phase 2 — Single cross-module dep
 *   Phase 3 — Multiple cross-module deps
 *   Phase 4 — Bidirectional deps (use lambdas for forward refs)
 *   Phase 5 — Special cases (backup-core self-reference, task-core re-wire)
 *
 * Called by: init(), resetForTest(), and backupCore.restoreDatabase() (via setInternals).
 * The DI container (container.js) now provides an alternative access path.
 */
function _wireAllModules() {
  // === Phase 1 — No cross-module deps (just db) ===
  configCore.createConfigCore({ db });
  taskCore.createTaskCore({ db });  // externalFns wired in Phase 5
  webhooksStreaming.createWebhooksStreaming({ db });
  codeAnalysis.createCodeAnalysis({ db });
  auditStore.createAuditStore({ db });
  emailPeek.createEmailPeek({ db });
  peekFixtureCatalog.createPeekFixtureCatalog({ db });
  packRegistry.createPackRegistry({ db });
  peekPolicyAudit.createPeekPolicyAudit({ db });
  peekRecoveryApprovals.createPeekRecoveryApprovals({ db });
  recoveryMetrics.createRecoveryMetrics({ db });
  inboundWebhooks.createInboundWebhooks({ db });
  ciCache.createCiCache({ db });
  modelRoles.createModelRoles({ db });
  workflowEngine.createWorkflowEngine({ db });
  validationRules.createValidationRules({ db, taskCore: { getTask } });

  // === Phase 2 — Single cross-module dep ===
  costTracking.createCostTracking({ db, taskCore: { getTask } });
  coordination.createCoordination({ db, taskCore: { getTask } });
  fileTracking.createFileTracking({
    db,
    taskCore: { getTask },
    dataDir: process.env.TORQUE_DATA_DIR || DATA_DIR,
  });
  hostManagement.createHostManagement({
    db,
    taskCore: { getTask },
    projectConfigCore: { getProjectRoot: (...a) => projectConfigCore.getProjectRoot(...a) },
  });

  // === Phase 3 — Multiple cross-module deps ===
  schedulingAutomation.createSchedulingAutomation({
    db,
    taskCore: { getTask },
    recordTaskEvent: (...a) => webhooksStreaming.recordTaskEvent(...a),
    getPipeline: (...a) => projectConfigCore.getPipeline(...a),
    createPipeline: (...a) => projectConfigCore.createPipeline(...a),
  });

  taskMetadata.createTaskMetadata({
    db,
    taskCore: { getTask },
    getTaskEvents: (...a) => webhooksStreaming.getTaskEvents(...a),
    getRetryHistory: (...a) => projectConfigCore.getRetryHistory(...a),
    recordAuditLog: (...a) => schedulingAutomation.recordAuditLog(...a),
    getApprovalHistory: (...a) => schedulingAutomation.getApprovalHistory(...a),
    createTaskFn: createTask,
  });

  // providerRoutingCore expects taskCore as the getTask function directly
  providerRoutingCore.createProviderRoutingCore({
    db,
    taskCore: getTask,
    hostManagement,
  });

  // === Phase 4 — Bidirectional deps (use lambdas for forward refs) ===
  eventTracking.createEventTracking({
    db,
    taskCore: { getTask },
    dbFunctions: {
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
    },
  });

  analytics.createAnalytics({
    db,
    taskCore: { getTask },
    dbFunctions: {
      getConfig, getAllConfig,
      getTemplate: (...a) => schedulingAutomation.getTemplate(...a),
      setCacheConfig: (...a) => projectConfigCore.setCacheConfig(...a),
      getCacheStats: (...a) => projectConfigCore.getCacheStats(...a),
    },
    findSimilarTasks: taskMetadata.findSimilarTasks,
    setPriorityWeights: analytics.setPriorityWeights,
  });

  // projectConfigCore expects taskCore as the getTask function directly
  projectConfigCore.createProjectConfigCore({
    db,
    taskCore: getTask,
    recordEvent: (...a) => eventTracking.recordEvent(...a),
    dbFunctions: {
      getConfig, getAllConfig,
      recordTaskEvent: (...a) => webhooksStreaming.recordTaskEvent(...a),
      cleanupWebhookLogs: (...a) => webhooksStreaming.cleanupWebhookLogs(...a),
      cleanupStreamData: (...a) => webhooksStreaming.cleanupStreamData(...a),
      cleanupCoordinationEvents: (...a) => webhooksStreaming.cleanupCoordinationEvents(...a),
      getRunningCount,
      getTokenUsageSummary: (...a) => costTracking.getTokenUsageSummary(...a),
      getScheduledTask: (...a) => schedulingAutomation.getScheduledTask(...a),
    },
  });

  // === Phase 5 — Special cases ===

  // Backup-core needs access to internal helpers for restore
  backupCore.createBackupCore({
    db,
    internals: {
      getConfig,
      setConfig,
      setConfigDefault,
      safeAddColumn,
      wireAllModules: _wireAllModules,  // self-reference for restore
      getDbPath: () => DB_PATH,
      getDataDir: () => DATA_DIR,
      setDbRef: (newDb) => { db = newDb; taskCore.setDb(newDb); configCore.setDb(newDb); },
      isDbClosed: () => dbClosed,
    },
  });

  policyProfileStore.createPolicyProfileStore({
    db,
    getProjectMetadata: projectConfigCore.getProjectMetadata,
  });

  policyEvaluationStore.createPolicyEvaluationStore({ db });

  // Re-wire task-core with cross-module dependencies (externalFns)
  taskCore.createTaskCore({
    db,
    externalFns: {
      getProjectFromPath: (...a) => projectConfigCore.getProjectFromPath(...a),
      recordEvent: (...a) => eventTracking.recordEvent(...a),
      escapeLikePattern: (...a) => eventTracking.escapeLikePattern(...a),
      recordTaskFileWrite: (...a) => fileTracking.recordTaskFileWrite(...a),
      notifyTaskStatusTransition,
      getConfig,
    },
  });
}

// _injectDbAll and _wireCrossModuleDI removed — replaced by _wireAllModules() above


/**
 * Initialize database and create tables
 * @returns {any}
 */
function init() {
  const attemptInit = () => {
    configCore.clearConfigCache();
    dbClosed = false;
    db = new Database(DB_PATH);

    // SECURITY (M2): Restrict database file permissions on Unix systems.
    // Prevents other users from reading/modifying the task database.
    try {
      fs.chmodSync(DB_PATH, 0o600);
      const dbDir = path.dirname(DB_PATH);
      fs.chmodSync(dbDir, 0o700);
    } catch { /* Windows doesn't support chmod, ignore */ }

    // SECURITY (M2-Win): Restrict DB file permissions on Windows using icacls.
    if (process.platform === 'win32' && DB_PATH !== ':memory:') {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('icacls', [DB_PATH, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(F)`], { stdio: 'pipe' });
      } catch (err) {
        logger.warn('Could not restrict DB file permissions: ' + err.message);
      }
    }

    // Enable WAL mode for better concurrent access
    db.pragma('journal_mode = WAL');

    // Allow concurrent writers to wait up to 30s instead of immediately failing with SQLITE_BUSY
    // Increased from 5s to handle burst scenarios (26+ concurrent task submissions)
    db.pragma('busy_timeout = 30000');

    // Enforce foreign key constraints (off by default in SQLite)
    db.pragma('foreign_keys = ON');

    // Inject DB into config-core early (before applySchema/seedDefaults needs setConfigDefault)
    configCore.setDb(db);

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

    // Wire all sub-modules via factory functions (hostManagement.setDb already called above for migrateToMultiHost)
    _wireAllModules();

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

// ============================================================
// Config delegation (facade over config-core)
// ============================================================

function getConfig(key) { return configCore.getConfig(key); }
function setConfig(key, value) { return configCore.setConfig(key, value); }
function setConfigDefault(key, value) { return configCore.setConfigDefault(key, value); }
function getAllConfig() { return configCore.getAllConfig(); }

// ============================================================
// Task delegation (facade over task-core)
// Only functions referenced internally by _wireAllModules / init.
// All other task-core functions are re-exported via the merge loop.
// ============================================================

function createTask(task) { return taskCore.createTask(task); }
function getTask(id) { return taskCore.getTask(id); }
function getRunningCount() { return taskCore.getRunningCount(); }

// ============================================================
// Other utility
// ============================================================

function getDbInstance() { return db; }

function validateColumnName(column, allowedSet) {
  return taskCore.validateColumnName(column, allowedSet);
}

/**
 * Close database connection.
 * Sets dbClosed flag to prevent operations after close from pending callbacks.
 */
function close() {
  dbClosed = true;
  taskCore.setDb(null); // propagates dbClosed to task-core
  configCore.setDb(null); // propagates dbClosed to config-core
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
  configCore.clearConfigCache();

  // Create fresh in-memory DB from serialized buffer
  db = new Database(buffer);
  // WAL pragma is not supported on in-memory databases — skip it
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Wire all sub-modules via factory functions
  _wireAllModules();

  return db;
}

// Backup/restore, failover tracking, email notifications, and peek host operations
// are now in db/backup-core.js and db/email-peek.js (Phase 5.2 / D1)

// ============================================================
// Exports: Connection lifecycle + core utilities ONLY
// ============================================================
//
// The facade merge loop that re-exported 800+ functions from 47 sub-modules
// has been REMOVED. All consumers now import sub-modules directly:
//
//   const taskCore = require('./db/task-core');
//   const configCore = require('./db/config-core');
//   const workflowEngine = require('./db/workflow-engine');
//
// This module re-exports sub-module functions as a flat namespace for backward
// compatibility. The execution/ layer passes this facade as `db` via init({ db }).
// New code should use the DI container: container.get('taskCore')
//
// Sub-module spreads are ordered to match import order at top of file.
// Later spreads win on name collisions (same behavior as the original merge loop).

const _SUB_MODULES = [
  codeAnalysis,
  costTracking,
  hostManagement,
  workflowEngine,
  fileTracking,
  schedulingAutomation,
  taskMetadata,
  coordination,
  providerRoutingCore,
  eventTracking,
  analytics,
  webhooksStreaming,
  inboundWebhooks,
  projectConfigCore,
  validationRules,
  backupCore,
  emailPeek,
  peekFixtureCatalog,
  packRegistry,
  peekPolicyAudit,
  peekRecoveryApprovals,
  recoveryMetrics,
  policyProfileStore,
  policyEvaluationStore,
  auditStore,
  ciCache,
  modelRoles,
  taskCore,
  configCore,
];

// DI wiring internals and factory functions — excluded from the facade
const _DI_INTERNALS = new Set([
  'setDb', 'setGetTask', 'setDbFunctions', 'setRecordEvent',
  'setRecordTaskEvent', 'setGetPipeline', 'setCreatePipeline',
  'setGetTaskEvents', 'setGetRetryHistory', 'setRecordAuditLog',
  'setGetApprovalHistory', 'setCreateTask', 'setHostManagement',
  'setGetProjectRoot', 'setDataDir', 'setInternals', 'setGetProjectMetadata',
  'setExternalFns', 'setDbClosed',
]);

// IMPORTANT: Do NOT replace _DI_FACTORIES with a pattern like `key.startsWith('create')`.
// Runtime functions (createTask, createWorkflow, createWebhook, etc.) MUST be exported.
// Only DI factory functions (createTaskCore, createConfigCore, etc.) are excluded.
// DI factory functions — return module instances, not data. Excluded from facade.
const _DI_FACTORIES = new Set([
  'createTaskCore', 'createConfigCore', 'createWorkflowEngine', 'createCostTracking',
  'createWebhooksStreaming', 'createCoordination', 'createEventTracking', 'createAnalytics',
  'createHostManagement', 'createSchedulingAutomation', 'createTaskMetadata',
  'createProviderRoutingCore', 'createFileTracking', 'createProjectConfigCore',
  'createBackupCore', 'createValidationRules', 'createCodeAnalysis',
  'createAuditStore', 'createEmailPeek', 'createPeekFixtureCatalog',
  'createPackRegistry', 'createPeekPolicyAudit', 'createPeekRecoveryApprovals',
  'createRecoveryMetrics', 'createInboundWebhooks', 'createCiCache',
  'createPolicyProfileStore', 'createPolicyEvaluationStore', 'createModelRoles',
]);

// Merge all sub-module exports into a flat namespace, skipping DI internals
// and DI factory functions. Runtime createXxx (createTask, createWorkflow, etc.) included.
const merged = {};
for (const mod of _SUB_MODULES) {
  for (const [key, value] of Object.entries(mod)) {
    if (typeof value !== 'function') continue;
    if (_DI_INTERNALS.has(key)) continue;
    if (_DI_FACTORIES.has(key)) continue;
    merged[key] = value;
  }
}

module.exports = {
  // Sub-module functions (flat namespace for backward compat)
  ...merged,

  // Connection lifecycle (override any sub-module collisions)
  init,
  close,
  onClose,
  resetForTest,
  getDbInstance,
  isDbClosed: () => dbClosed,
  isReady: () => !!db && !dbClosed,
  getDataDir: () => DATA_DIR,
  getDbPath: () => DB_PATH,

  // Core utilities (no sub-module equivalent)
  safeJsonParse,
  safeAddColumn,
  validateColumnName,

  // DI wiring (internal)
  _wireAllModules,

  // Listeners
  addTaskStatusTransitionListener,
  removeTaskStatusTransitionListener,
};
