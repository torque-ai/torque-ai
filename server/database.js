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
const { getDataDir: _resolveDataDir, ensureWritableDir: ensureWritableDataDir } = require('./data-dir');
const logger = require('./logger').child({ component: 'database' });
const { safeJsonParse } = require('./utils/json');

const _LAZY_MODULE_DEFINITIONS = [
  { name: 'migrations', path: './db/migrations' },
  { name: 'codeAnalysis', path: './db/code-analysis' },
  { name: 'costTracking', path: './db/cost-tracking' },
  { name: 'hostManagement', path: './db/host-management' },
  { name: 'workflowEngine', path: './db/workflow-engine' },
  { name: 'fileTracking', path: './db/file-tracking' },
  { name: 'schedulingAutomation', path: './db/scheduling-automation' },
  { name: 'taskMetadata', path: './db/task-metadata' },
  { name: 'coordination', path: './db/coordination' },
  { name: 'providerRoutingCore', path: './db/provider-routing-core' },
  { name: 'eventTracking', path: './db/event-tracking' },
  { name: 'analytics', path: './db/analytics' },
  { name: 'webhooksStreaming', path: './db/webhooks-streaming' },
  { name: 'inboundWebhooks', path: './db/inbound-webhooks' },
  { name: 'projectConfigCore', path: './db/project-config-core' },
  { name: 'validationRules', path: './db/validation-rules' },
  { name: 'backupCore', path: './db/backup-core' },
  { name: 'emailPeek', path: './db/email-peek' },
  { name: 'peekFixtureCatalog', path: './db/peek-fixture-catalog' },
  { name: 'packRegistry', path: './db/pack-registry' },
  { name: 'peekPolicyAudit', path: './db/peek-policy-audit' },
  { name: 'peekRecoveryApprovals', path: './db/peek-recovery-approvals' },
  { name: 'recoveryMetrics', path: './db/recovery-metrics' },
  { name: 'policyProfileStore', path: './policy-engine/profile-store' },
  { name: 'policyEvaluationStore', path: './policy-engine/evaluation-store' },
  { name: 'auditStore', path: './db/audit-store' },
  { name: 'ciCache', path: './db/ci-cache' },
  { name: 'modelRoles', path: './db/model-roles' },
  { name: 'taskCore', path: './db/task-core' },
  { name: 'configCore', path: './db/config-core' },
  { name: 'factoryHealth', path: './db/factory-health' },
  { name: 'factoryIntake', path: './db/factory-intake' },
  { name: 'factoryArchitect', path: './db/factory-architect' },
  { name: 'factoryFeedback', path: './db/factory-feedback' },
  { name: 'factoryAudit', path: './db/factory-audit' },
  { name: 'factoryLoopInstances', path: './db/factory-loop-instances' },
  { name: 'factoryWorktrees', path: './db/factory-worktrees' },
];

const _LAZY_MODULES_BY_NAME = new Map(_LAZY_MODULE_DEFINITIONS.map((definition) => [definition.name, definition]));
const _loadedModules = new Map();
const _lazyModuleRefs = new Map();

function _loadModule(name) {
  if (_loadedModules.has(name)) {
    return _loadedModules.get(name);
  }
  const definition = _LAZY_MODULES_BY_NAME.get(name);
  if (!definition) {
    throw new Error(`Unknown database sub-module: ${name}`);
  }
  const loaded = require(definition.path);
  _loadedModules.set(name, loaded);
  return loaded;
}

function _lazyModule(name) {
  if (_lazyModuleRefs.has(name)) {
    return _lazyModuleRefs.get(name);
  }
  const ref = new Proxy({}, {
    get(_target, property) {
      if (property === Symbol.toStringTag) return `LazyDatabaseModule:${name}`;
      return _loadModule(name)[property];
    },
    has(_target, property) {
      return property in _loadModule(name);
    },
    ownKeys() {
      return Reflect.ownKeys(_loadModule(name));
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Object.getOwnPropertyDescriptor(_loadModule(name), property);
      if (!descriptor) return undefined;
      return { ...descriptor, configurable: true };
    },
  });
  _lazyModuleRefs.set(name, ref);
  return ref;
}

const codeAnalysis = _lazyModule('codeAnalysis');
const costTracking = _lazyModule('costTracking');
const hostManagement = _lazyModule('hostManagement');
const workflowEngine = _lazyModule('workflowEngine');
const fileTracking = _lazyModule('fileTracking');
const schedulingAutomation = _lazyModule('schedulingAutomation');
const taskMetadata = _lazyModule('taskMetadata');
const coordination = _lazyModule('coordination');
const providerRoutingCore = _lazyModule('providerRoutingCore');
const eventTracking = _lazyModule('eventTracking');
const analytics = _lazyModule('analytics');
const webhooksStreaming = _lazyModule('webhooksStreaming');
const inboundWebhooks = _lazyModule('inboundWebhooks');
const projectConfigCore = _lazyModule('projectConfigCore');
const validationRules = _lazyModule('validationRules');
const backupCore = _lazyModule('backupCore');
const emailPeek = _lazyModule('emailPeek');
const peekFixtureCatalog = _lazyModule('peekFixtureCatalog');
const packRegistry = _lazyModule('packRegistry');
const peekPolicyAudit = _lazyModule('peekPolicyAudit');
const peekRecoveryApprovals = _lazyModule('peekRecoveryApprovals');
const recoveryMetrics = _lazyModule('recoveryMetrics');
const policyProfileStore = _lazyModule('policyProfileStore');
const policyEvaluationStore = _lazyModule('policyEvaluationStore');
const auditStore = _lazyModule('auditStore');
const ciCache = _lazyModule('ciCache');
const modelRoles = _lazyModule('modelRoles');
const taskCore = _lazyModule('taskCore');
const configCore = _lazyModule('configCore');
const factoryHealth = _lazyModule('factoryHealth');
const factoryIntake = _lazyModule('factoryIntake');
const factoryArchitect = _lazyModule('factoryArchitect');
const factoryFeedback = _lazyModule('factoryFeedback');
const factoryAudit = _lazyModule('factoryAudit');
const factoryLoopInstances = _lazyModule('factoryLoopInstances');
const factoryWorktrees = _lazyModule('factoryWorktrees');



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
  'construction_cache', 'task_cache', 'cache_config', 'cache_stats',
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
  'provider_config', 'provider_usage', 'provider_scores', 'provider_task_stats',
  'ollama_hosts', 'remote_agents', 'peek_hosts', 'peek_fixture_catalog', 'pack_registry', 'recovery_metrics',
  // Auth
  'api_keys', 'auth_configs', 'connected_accounts',
  // Security
  'security_scans', 'security_rules', 'vulnerability_scans',
  'task_fingerprints',
  // Policy engine
  'policy_profiles', 'policy_rules', 'policy_bindings', 'policy_evaluations', 'policy_overrides',
  // Integration & reporting
  'integration_config', 'integration_health', 'integration_tests',
  'github_issues', 'report_exports',
  // Repo graph
  'registered_repos', 'repo_symbols',
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
  'query_stats', 'optimization_history',
  // Factory
  'factory_projects', 'factory_health_snapshots', 'factory_health_findings',
  'factory_work_items', 'factory_architect_cycles', 'factory_worktrees',
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

let DATA_DIR = _resolveDataDir();
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

function refreshDataPaths() {
  DATA_DIR = _resolveDataDir();
  DB_PATH = path.join(DATA_DIR, 'tasks.db');
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
  factoryHealth.setDb(db);
  factoryIntake.setDb(db);
  factoryArchitect.setDb(db);
  factoryFeedback.setDb(db);
  factoryAudit.setDb(db);
  factoryLoopInstances.setDb(db);
  factoryWorktrees.setDb(db);
  workflowEngine.createWorkflowEngine({ db });
  validationRules.createValidationRules({ db, taskCore: { getTask } });

  // === Phase 2 — Single cross-module dep ===
  costTracking.createCostTracking({ db, taskCore: { getTask } });
  coordination.createCoordination({ db, taskCore: { getTask } });
  fileTracking.createFileTracking({
    db,
    taskCore: { getTask },
    dataDir: DATA_DIR,
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
  refreshDataPaths();
  // Pre-startup safety backup — capture existing DB before schema migrations.
  // Uses db.serialize() to include WAL data (copyFileSync misses WAL content,
  // which can hold the majority of data if wal_checkpoint failed at last shutdown).
  if (fs.existsSync(DB_PATH)) {
    try {
      const backupDir = path.join(DATA_DIR, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `torque-pre-startup-${timestamp}.db`);

      // Open temporarily in readonly mode to serialize (includes WAL replay)
      const tempDb = new Database(DB_PATH, { readonly: true });
      const buffer = tempDb.serialize();
      tempDb.close();

      if (buffer.length > 100000) { // Only keep if DB has meaningful data (>100KB)
        fs.writeFileSync(backupPath, buffer);
        logger.info(`[backup] Pre-startup backup: ${backupPath} (${buffer.length} bytes, includes WAL)`);

        // Keep only last 3 pre-startup backups
        const preStartupFiles = fs.readdirSync(backupDir)
          .filter(f => f.startsWith('torque-pre-startup-') && f.endsWith('.db'))
          .sort()
          .reverse();
        for (let i = 3; i < preStartupFiles.length; i++) {
          try { fs.unlinkSync(path.join(backupDir, preStartupFiles[i])); } catch {}
        }
      }
    } catch (err) {
      logger.warn(`[backup] Pre-startup backup failed (non-fatal): ${err.message}`);
    }
  }

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
        execFileSync('icacls', [DB_PATH, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(F)`], { stdio: 'pipe', windowsHide: true });
      } catch (err) {
        logger.warn('Could not set DB file permissions: ' + err.message);
      }
    }

    // Enable WAL mode for better concurrent access
    db.pragma('journal_mode = WAL');

    // Allow concurrent writers to wait up to 30s instead of immediately failing with SQLITE_BUSY
    // Increased from 5s to handle burst scenarios (26+ concurrent task submissions)
    db.pragma('busy_timeout = 30000');

    // Checkpoint any stale WAL data from a previous unclean shutdown.
    // If the last shutdown's wal_checkpoint(TRUNCATE) failed, data is stuck in the WAL.
    // This ensures it's consolidated into the main DB file before we proceed.
    try {
      const walResult = db.pragma('wal_checkpoint(TRUNCATE)');
      const walInfo = walResult && walResult[0];
      if (walInfo && walInfo.log > 0) {
        logger.info(`[DB] Startup WAL checkpoint: ${walInfo.checkpointed}/${walInfo.log} pages flushed`);
      }
    } catch (_e) {
      // Non-fatal at startup — WAL will be replayed automatically by SQLite
    }

    // Enforce foreign key constraints (off by default in SQLite)
    db.pragma('foreign_keys = ON');

    // Inject DB into config-core early (before applySchema/seedDefaults needs setConfigDefault)
    configCore.setDb(db);

    // Schema definitions (extracted to db/schema.js)
    const { applySchema } = require('./db/schema');
    applySchema(db, { safeAddColumn, getConfig, setConfig, setConfigDefault, DATA_DIR });
    configCore.ensureApiKey();

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
    const migrationCount = _loadModule('migrations').runMigrations(db);
    if (migrationCount > 0) {
      logger.info('Applied ' + migrationCount + ' database migration(s)');
    }

    // Wire all sub-modules via factory functions (hostManagement.setDb already called above for migrateToMultiHost)
    _wireAllModules();
    registerFacadeWithContainer();

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
    // Flush WAL into main DB file before closing. Switching from WAL to DELETE
    // journal mode forces SQLite to checkpoint all WAL data into the main file
    // and delete the WAL, which is atomic and doesn't require exclusive access
    // the way wal_checkpoint(TRUNCATE) does. This prevents the data loss bug
    // where a new TORQUE instance opens the DB before the old one checkpoints,
    // causing the TRUNCATE to fail with "database table is locked".
    try {
      db.pragma('journal_mode = DELETE');
      logger.info('[DB] Shutdown: switched to DELETE journal mode (WAL flushed to main DB)');
    } catch (checkpointErr) {
      // If journal_mode switch fails, try explicit checkpoint as fallback
      logger.warn(`[DB] journal_mode switch failed (${checkpointErr.message}), trying wal_checkpoint...`);
      try {
        const result = db.pragma('wal_checkpoint(TRUNCATE)');
        const info = result && result[0];
        if (info && info.busy > 0) {
          logger.error(`[DB] WAL checkpoint TRUNCATE incomplete (${info.busy} busy pages). Data may be at risk.`);
        }
      } catch (cpErr) {
        logger.error(`[DB] WAL checkpoint also failed: ${cpErr.message}. Data in WAL file may be lost.`);
      }
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
  refreshDataPaths();
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
  registerFacadeWithContainer();

  return db;
}

// Backup/restore, failover tracking, email notifications, and peek host operations
// are now in db/backup-core.js and db/email-peek.js (Phase 5.2 / D1)

// ============================================================
// Exports: lazy legacy facade + connection lifecycle utilities
// ============================================================
//
// This module still exposes the historical flat database namespace for backward
// compatibility. The legacy export manifest below preserves the previous
// collision behavior: each function is assigned to the module that won the old
// eager spread order. Each wrapper defers require() until the function is called.

const _LEGACY_EXPORT_MODULES = [
  { name: 'costTracking', exports: [
    'deleteBudget', 'estimateCost', 'getCostByPeriod', 'getCostForecast', 'getModelPricing', 'getProviderHistory',
    'getTaskTokenUsage', 'getTokenUsageSummary', 'getUsageHistory', 'getWorkflowCostSummary', 'recordDailySnapshot', 'recordTokenUsage',
    'resetExpiredBudgets',
  ] },
  { name: 'hostManagement', exports: [
    'addOllamaHost', 'addRoutingRule', 'applyBenchmarkResults', 'cleanupNullIdHosts', 'computeAdaptiveScores', 'decomposeTask',
    'decrementHostTasks', 'deleteAllHostCredentials', 'deleteCredential', 'deleteProjectTuning', 'detectTaskLanguage', 'determineTaskComplexity',
    'disableOllamaHost', 'disableStaleHosts', 'enableOllamaHost', 'ensureLocalHostEnabled', 'ensureModelsLoaded', 'fetchHostModelsSync',
    'getAggregatedModels', 'getBenchmarkResults', 'getBenchmarkStats', 'getCredential', 'getHostSettings', 'getMergedProjectTuning',
    'getModelCapabilities', 'getModelFormatFailures', 'getModelLeaderboard', 'getModelTierForComplexity', 'getOllamaHost', 'getOllamaHostByUrl',
    'getOptimalSettingsFromBenchmarks', 'getProjectTuning', 'getRunningTasksForHost', 'getSplitAdvisory', 'getTasksNeedingCorrection', 'getTasksPendingReview',
    'getVramOverheadFactor', 'incrementHostTasks', 'isHostModelWarm', 'listCredentials', 'listModelCapabilities', 'listOllamaHosts',
    'listProjectTuning', 'migrateToMultiHost', 'reconcileHostTaskCounts', 'recordBenchmarkResult', 'recordHostHealthCheck', 'recordHostModelUsage',
    'recordModelOutcome', 'recordTaskOutcome', 'recoverOllamaHost', 'releaseHostSlot', 'removeOllamaHost', 'routeTask',
    'saveCredential', 'selectBestModel', 'selectHostWithModelVariant', 'selectOllamaHostForModel', 'setHostPriority', 'setHostSettings',
    'setHostTierHint', 'setProjectTuning', 'setTaskReviewStatus', 'tryReserveHostSlot', 'updateOllamaHost', 'upsertModelCapabilities',
  ] },
  { name: 'workflowEngine', exports: [
    'addTaskDependency', 'areTaskDependenciesSatisfied', 'cleanupOldWorkflows', 'createWorkflow', 'createWorkflowTemplate', 'deleteTaskDependency',
    'deleteWorkflow', 'deleteWorkflowTemplate', 'evaluateAST', 'evaluateCondition', 'findEmptyWorkflowPlaceholder', 'getBlockedTasks',
    'getTaskDependencies', 'getTaskDependents', 'getWorkflow', 'getWorkflowDependencies', 'getWorkflowHistory', 'getWorkflowStatus',
    'getWorkflowTaskCount', 'getWorkflowTasks', 'getWorkflowTemplate', 'getWorkflowTemplateByName', 'injectReviewDependency', 'listWorkflowTemplates',
    'listWorkflows', 'parseExpression', 'reconcileStaleWorkflows', 'tokenizeExpression', 'transitionWorkflowStatus', 'updateWorkflow',
    'updateWorkflowCounts', 'wouldCreateCycle',
  ] },
  { name: 'fileTracking', exports: [
    'acquireFileLock', 'analyzeBuildOutput', 'analyzeChangeImpact', 'analyzeCodeComplexity', 'calculateTaskComplexityScore', 'captureConfigBaselines',
    'captureDirectoryBaselines', 'captureFileBaseline', 'captureTestBaseline', 'checkAccessibility', 'checkBudgetBeforeSubmission', 'checkDocCoverage',
    'checkDuplicateFiles', 'checkDuplicateTask', 'checkFileLocationAnomalies', 'checkI18n', 'checkOutputSizeLimits', 'checkTaskTimeout',
    'checkTestCoverage', 'checkXamlCodeBehindConsistency', 'classifyTaskType', 'compareFileToBaseline', 'completeRollback', 'createDiffPreview',
    'createFileBackup', 'createRollback', 'detectConfigDrift', 'detectDeadCode', 'detectProviderDegradation', 'detectRegressions',
    'estimateResourceUsage', 'generateTaskFingerprint', 'getAccessibilityResults', 'getActiveFileLocks', 'getAllFileLocationIssues', 'getApiContractResults',
    'getAuditTrail', 'getAutoRollbackHistory', 'getBestProviderForTaskType', 'getBudgetStatus', 'getBuildCheck', 'getBuildErrorAnalysis',
    'getChangeImpacts', 'getComplexityMetrics', 'getConfigDriftResults', 'getConflictedFiles', 'getCostSummary', 'getDeadCodeResults',
    'getDiffPreview', 'getDocCoverageResults', 'getDuplicateFileDetections', 'getExpectedOutputPaths', 'getFileBaseline', 'getFileLocationAnomalies',
    'getI18nResults', 'getOutputViolations', 'getOverallQualityStats', 'getProviderQualityStats', 'getQualityScore', 'getQualityStatsByProvider',
    'getRateLimits', 'getRegressionResults', 'getResourceEstimates', 'getRollback', 'getSafeguardToolConfigs', 'getSecurityRules',
    'getSecurityScanResults', 'getSimilarFileSearchResults', 'getSmokeTestResults', 'getStyleCheckResults', 'getSyntaxValidators', 'getTaskBackups',
    'getTaskComplexityScore', 'getTaskFileSnapshot', 'getTestCoverageResults', 'getTimeoutAlerts', 'getTypeVerificationResults', 'getValidationFailureRate',
    'getVulnerabilityScanResults', 'getWorkflowFileWrites', 'getXamlConsistencyResults', 'getXamlValidationResults', 'isBudgetExceeded', 'isDiffReviewRequired',
    'listAllSyntaxValidators', 'listRollbacks', 'markDiffReviewed', 'markTimeoutAlertNotified', 'performAutoRollback', 'recordAuditEvent',
    'recordAutoRollback', 'recordCost', 'recordDuplicateFile', 'recordFileLocationAnomaly', 'recordQualityScore', 'recordRateLimitEvent',
    'recordTaskFileWrite', 'recordTaskFingerprint', 'releaseAllFileLocks', 'releaseFileLock', 'resolveDuplicateFile', 'resolveFileLocationAnomaly',
    'restoreFileBackup', 'runAppSmokeTest', 'runAppSmokeTestSync', 'runBuildCheck', 'runSecurityScan', 'runStyleCheck',
    'runSyntaxValidation', 'runVulnerabilityScan', 'saveBuildResult', 'searchSimilarFiles', 'setBudget', 'setExpectedOutputPath',
    'setOutputLimit', 'updateBudgetSpend', 'updateProviderStats', 'validateApiContract', 'validateXamlSemantics', 'verifyTypeReferences',
  ] },
  { name: 'schedulingAutomation', exports: [
    'approveTask', 'calculateNextMaintenanceRun', 'calculateNextRun', 'checkApprovalRequired', 'cleanupAuditLog', 'createApprovalRequest',
    'createApprovalRule', 'createCronScheduledTask', 'createOneTimeSchedule', 'deleteApprovalRule', 'deleteMaintenanceSchedule', 'deleteResourceLimits',
    'deleteScheduledTask', 'deleteTemplate', 'detectScheduleOverlaps', 'duplicatePipeline', 'exportAuditLog', 'exportTasksReport',
    'getAllAuditConfig', 'getAllResourceLimits', 'getApprovalHistory', 'getApprovalRequest', 'getApprovalRequestById', 'getAuditConfig',
    'getAuditLog', 'getAuditLogCount', 'getAuditStats', 'getDueMaintenanceTasks', 'getDueScheduledTasks', 'getMaintenanceSchedule',
    'getResourceLimits', 'getResourceReport', 'getResourceUsage', 'getResourceUsageByProject', 'getScheduledTask', 'getScheduledTaskRun',
    'getTemplate', 'incrementTemplateUsage', 'listApprovalHistory', 'listApprovalRules', 'listMaintenanceSchedules', 'listPendingApprovals',
    'listScheduledTaskRuns', 'listScheduledTasks', 'listTemplates', 'markMaintenanceRun', 'markScheduledTaskRun', 'matchesApprovalRule',
    'matchesCronField', 'parseCronExpression', 'parseDelay', 'processAutoApprovals', 'recordAuditLog', 'recordResourceUsage',
    'rejectApproval', 'runScheduledTaskNow', 'saveTemplate', 'setAuditConfig', 'setMaintenanceSchedule', 'setResourceLimits',
    'toggleScheduledTask', 'updateApprovalRule', 'updateScheduledTask', 'validateCronField', 'validateCronFieldValue',
  ] },
  { name: 'taskMetadata', exports: [
    'addTaskComment', 'addTaskSuggestion', 'addTaskTags', 'addTaskToGroup', 'archiveTask', 'archiveTasks',
    'batchAddTags', 'batchAddTagsByFilter', 'batchCancelTasks', 'calculateTextSimilarity', 'checkBreakpoints', 'cleanupExpiredArtifacts',
    'createBreakpoint', 'createBulkOperation', 'createDebugSession', 'createTaskGroup', 'deleteArchivedTask', 'deleteArtifact',
    'deleteBreakpoint', 'deleteTaskComment', 'deleteTaskGroup', 'dryRunBulkOperation', 'findSimilarTasks', 'generateTaskSuggestions',
    'getAllTags', 'getArchiveStats', 'getArchivedTask', 'getArtifact', 'getArtifactConfig', 'getBreakpoint',
    'getBulkOperation', 'getCachedSimilarTasks', 'getDebugCaptures', 'getDebugSession', 'getDebugSessionByTask', 'getDebugState',
    'getExpiredArtifacts', 'getGroupStats', 'getGroupTasks', 'getRetryableTasks', 'getRollbackPoints', 'getSmartDefaults',
    'getTagStats', 'getTaskComments', 'getTaskFileChanges', 'getTaskGroup', 'getTaskPatterns', 'getTaskSuggestions',
    'getTaskTimeline', 'getTasksMatchingFilter', 'getTasksWithCommits', 'learnFromRecentTasks', 'learnFromTask', 'listArchivedTasks',
    'listArtifacts', 'listBreakpoints', 'listBulkOperations', 'listTaskGroups', 'markSuggestionApplied', 'recordDebugCapture',
    'recordFileChange', 'removeTaskTags', 'restoreTask', 'setArtifactConfig', 'storeArtifact', 'transitionDebugSessionStatus',
    'updateBreakpoint', 'updateBulkOperation', 'updateDebugSession', 'updateTaskGitState',
  ] },
  { name: 'coordination', exports: [
    'acquireLock', 'addAgentToGroup', 'checkLock', 'checkOfflineAgents', 'claimTask', 'cleanupExpiredLocks',
    'createAgentGroup', 'expireStaleLeases', 'forceReleaseStaleLock', 'getActiveInstances', 'getAgent', 'getAgentGroup',
    'getAgentsByTarget', 'getAgentsWithCapabilities', 'getClaim', 'getClaimableTasksForAgent', 'getCoordinationDashboard', 'getFailoverConfig',
    'getStealingHistory', 'isLockHeartbeatStale', 'listAgentGroups', 'listAgents', 'listClaims', 'listRoutingRules',
    'matchRoutingRule', 'recordAgentMetric', 'recordCoordinationEvent', 'registerAgent', 'releaseLock', 'releaseTaskClaim',
    'removeAgentFromGroup', 'renewLease', 'routeTaskToAgent', 'selectAgentByStrategy', 'stealTask', 'triggerFailover',
    'unregisterAgent', 'updateAgent', 'updateAgentHeartbeat', 'updateFailoverConfig', 'updateLockHeartbeat',
  ] },
  { name: 'providerRoutingCore', exports: [
    'analyzeTaskForRouting', 'approveProviderSwitch', 'attemptOllamaStart', 'autoConfigureWSL2Host', 'checkOllamaHealth', 'checkRateLimit',
    'checkTaskQuota', 'cleanupStaleTasks', 'createRoutingRule', 'createTaskReplay', 'createTemplateCondition', 'createWorkflowFork',
    'deleteIntegrationConfig', 'deleteRateLimit', 'deleteRoutingRule', 'deleteTaskQuota', 'deleteTemplateCondition', 'detectWSL2HostIP',
    'enrichProviderRow', 'findOllamaBinary', 'getDefaultProvider', 'getEffectiveMaxConcurrent', 'getEnabledIntegration', 'getEnabledProviderMaxConcurrentSum',
    'getHealthTrend', 'getIntegrationConfig', 'getNextFallbackProvider', 'getProjectQuotas', 'getProjectRateLimits', 'getPrometheusMetrics',
    'getProvider', 'getProviderFallbackChain', 'getProviderHealth', 'getProviderHealthScore', 'getProviderStats', 'getRateLimit',
    'getRoutingRule', 'getRoutingRules', 'getTaskQuota', 'getTaskReplay', 'getTemplateCondition', 'getWorkflowFork',
    'hasHealthyOllamaHost', 'invalidateOllamaHealth', 'isCodexExhausted', 'isOllamaHealthy', 'isProviderHealthy', 'isProviderQuotaError',
    'listIntegrationConfigs', 'listProviders', 'listTaskReplays', 'listTemplateConditions', 'listWorkflowForks', 'markTaskPendingProviderSwitch',
    'normalizeProviderTransport', 'persistHealthWindow', 'pruneHealthHistory', 'pruneOldTasks', 'recordProviderOutcome', 'recordProviderUsage',
    'rejectProviderSwitch', 'resetProviderHealth', 'saveIntegrationConfig', 'setCircuitBreaker', 'setCodexExhausted', 'setDefaultProvider',
    'setOllamaHealthy', 'setProviderFallbackChain', 'setProviderScoring', 'setRateLimit', 'setTaskQuota', 'updateProvider',
    'updateRoutingRule', 'updateWorkflowForkStatus', 'waitForOllamaReady',
  ] },
  { name: 'eventTracking', exports: [
    'aggregateSuccessMetrics', 'comparePerformance', 'escapeLikePattern', 'escapeRegex', 'exportData', 'getAnalytics',
    'getBestFormatForModel', 'getFormatSuccessRate', 'getFormatSuccessRatesSummary', 'getOutputStats', 'getSuccessRates', 'importData',
    'recordEvent', 'recordFormatSuccess', 'recordSuccessMetrics', 'searchTaskOutputs',
  ] },
  { name: 'analytics', exports: [
    'analyzeRetryPatterns', 'assignExperimentVariant', 'boostPriority', 'calibratePredictionModels', 'computeDependencyScore', 'computeExperimentSignificance',
    'computePriorityScore', 'computeResourceScore', 'computeSuccessScore', 'concludeExperiment', 'createAdaptiveRetryRule', 'createExperiment',
    'deleteFailurePattern', 'estimateFromKeywords', 'extractKeywords', 'extractPatternKey', 'getAdaptiveRetryRules', 'getDurationInsights',
    'getExperiment', 'getHighestPriorityQueuedTask', 'getIntelligenceDashboard', 'getPatternCondition', 'getPredictionModel', 'getPriorityQueue',
    'getPriorityWeights', 'getRetryRecommendation', 'learnFailurePattern', 'listExperiments', 'listFailurePatterns', 'logIntelligenceAction',
    'matchPatterns', 'predictDuration', 'predictFailureForTask', 'purgeOldAnalytics', 'recordDurationPrediction', 'recordExperimentOutcome',
    'setFindSimilarTasks', 'setPriorityWeights', 'setSetPriorityWeights', 'suggestIntervention', 'updateIntelligenceOutcome', 'updatePredictionActual',
    'updatePredictionModel', 'updateRetryRuleStats',
  ] },
  { name: 'webhooksStreaming', exports: [
    'addStreamChunk', 'cleanupAnalytics', 'cleanupCoordinationEvents', 'cleanupEventData', 'cleanupStaleWebhookRetries', 'cleanupStreamData',
    'cleanupWebhookLogs', 'clearPartialOutputBuffer', 'clearPauseState', 'createEventSubscription', 'createTaskStream', 'createWebhook',
    'deleteEventSubscription', 'deleteTaskCheckpoints', 'deleteWebhook', 'enforceEventTableLimits', 'enforceWebhookLogLimits', 'getLatestStreamChunks',
    'getOrCreateTaskStream', 'getPartialOutputBuffer', 'getStreamChunks', 'getStreamTaskId', 'getTaskCheckpoint', 'getTaskCheckpoints',
    'getTaskEvents', 'getTaskLogs', 'getWebhook', 'getWebhookLogs', 'getWebhookStats', 'getWebhooksForEvent',
    'listPausedTasks', 'listWebhooks', 'logWebhookDelivery', 'pauseTask', 'pollSubscription', 'pollSubscriptionAfterCursor',
    'recordTaskEvent', 'saveTaskCheckpoint', 'setWebhookDeliveryExecutor', 'updateWebhook',
  ] },
  { name: 'inboundWebhooks', exports: [
    'checkDeliveryExists', 'cleanupOldDeliveries', 'createInboundWebhook', 'deleteInboundWebhook', 'getInboundWebhook', 'listInboundWebhooks',
    'recordDelivery', 'recordWebhookTrigger',
  ] },
  { name: 'projectConfigCore', exports: [
    'acknowledgePerformanceAlert', 'addParallelPipelineStep', 'addPipelineStep', 'addTaskToPlanProject', 'analyzeDatabase', 'areAllPlanDependenciesComplete',
    'cacheTaskResult', 'calculateRetryDelay', 'canProjectStartTask', 'checkBudgetAlerts', 'checkDependencies', 'checkMemoryPressure',
    'cleanupHealthHistory', 'clearCacheStats', 'clearQueryStats', 'computeContentHash', 'computeEmbedding', 'configureTaskRetry',
    'cosineSimilarity', 'createBudgetAlert', 'createGitHubIssue', 'createPerformanceAlert', 'createPipeline', 'createPlanProject',
    'createProjectCache', 'createReportExport', 'createScheduledTask', 'deleteBudgetAlert', 'deletePlanProject', 'deleteProjectConfig',
    'explainQueryPlan', 'exportTasksToCSV', 'exportTasksToJSON', 'findProjectRoot', 'getAllProjectMetadata', 'getBudgetAlert',
    'getCacheConfig', 'getCacheStats', 'getCurrentProject', 'getDatabaseHealth', 'getDatabaseSize', 'getDatabaseStats',
    'getDependentPlanTasks', 'getDependentTasks', 'getEffectiveProjectConfig', 'getFrequentQueries', 'getGitHubIssuesForTask', 'getHealthHistory',
    'getHealthSummary', 'getIndexStats', 'getIntegrationHealthHistory', 'getIntegrationTests', 'getLatestHealthCheck', 'getLatestIntegrationHealth',
    'getNextPipelineStep', 'getNextPipelineSteps', 'getOptimizationHistory', 'getParallelGroupSteps', 'getPerformanceAlerts', 'getPipeline',
    'getPipelineSteps', 'getPlanProject', 'getPlanProjectTask', 'getPlanProjectTasks', 'getProjectConfig', 'getProjectDailyUsage',
    'getProjectDefaults', 'getProjectFromPath', 'getProjectMetadata', 'getProjectRoot', 'getProjectRunningCount', 'getProjectStats',
    'getReportExport', 'getResourceMetrics', 'getRetryHistory', 'getSlowQueries', 'hasFailedPlanDependency', 'incrementRetry',
    'init', 'integrityCheck', 'invalidateCache', 'isParallelGroupComplete', 'listBudgetAlerts', 'listGitHubIssues',
    'listPipelines', 'listPlanProjects', 'listProjectConfigs', 'listReportExports', 'lookupCache', 'purgeGrowthTables',
    'reconcilePipelineStepStatus', 'recordHealthCheck', 'recordIntegrationHealth', 'recordIntegrationTest', 'recordOptimization', 'recordQueryStat',
    'recordRetryAttempt', 'runEmergencyCleanup', 'setCacheConfig', 'setProjectConfig', 'setProjectMetadata', 'timedQuery',
    'transitionPipelineStepStatus', 'updateBudgetAlert', 'updateCacheEntryCount', 'updateCacheStats', 'updatePipelineStatus', 'updatePipelineStep',
    'updatePlanProject', 'updateReportExport', 'vacuum', 'vacuumDatabase', 'warmCache',
  ] },
  { name: 'validationRules', exports: [
    'decideApproval', 'getApprovalRule', 'getApprovalRules', 'getFailureMatches', 'getFailurePatterns', 'getPendingApprovals',
    'getRetryAttempts', 'getRetryRules', 'getValidationResults', 'getValidationRule', 'getValidationRules', 'hasAllApprovals',
    'hasValidationFailures', 'matchFailurePatterns', 'recordValidationResult', 'saveApprovalRule', 'saveFailurePattern', 'saveRetryRule',
    'saveValidationRule', 'shouldRetryWithCloud', 'updateRetryOutcome', 'validateTaskOutput',
  ] },
  { name: 'backupCore', exports: [
    'backupDatabase', 'cleanupOldBackups', 'getBackupsDir', 'getDbInstance', 'listBackups', 'restoreDatabase',
    'startBackupScheduler', 'stopBackupScheduler', 'takePreShutdownBackup',
  ] },
  { name: 'emailPeek', exports: [
    'getDefaultPeekHost', 'getEmailNotification', 'getFailoverEvents', 'getPeekHost', 'listEmailNotifications', 'listPeekHosts',
    'recordEmailNotification', 'recordFailoverEvent', 'registerPeekHost', 'unregisterPeekHost', 'updateEmailNotificationStatus', 'updatePeekHost',
  ] },
  { name: 'peekFixtureCatalog', exports: [
    'cloneValue', 'computeChecksum', 'createNewVersion', 'deepMerge', 'deleteFixture', 'freezeFixture',
    'getFixture', 'getFixtureByName', 'hasCatalogTable', 'isPlainObject', 'listFixtures', 'mapFixtureRow',
    'registerFixture', 'resolveFixtureWithInheritance', 'seedDefaultFixtures', 'updateFixture',
  ] },
  { name: 'packRegistry', exports: [
    'deletePack', 'deprecatePack', 'getPack', 'getPackByName', 'getPackVersionHistory', 'listDeprecatedPacks',
    'listPacks', 'mapPackRow', 'queryByAppType', 'recordVersionHistory', 'registerPack', 'safeJsonParse',
    'setMaintainer', 'setSuccessorPack', 'setSunsetDate', 'transferOwnership',
  ] },
  { name: 'peekPolicyAudit', exports: [
    'formatPolicyProof', 'getPolicyProofAudit', 'listPolicyProofAudits', 'recordPolicyProofAudit',
  ] },
  { name: 'peekRecoveryApprovals', exports: [
    'denyApproval', 'getApprovalForAction', 'getApprovalStatus', 'grantApproval', 'requestApproval',
  ] },
  { name: 'recoveryMetrics', exports: [
    'getActionStats', 'getExecutionCount', 'getOverallStats', 'getRecentMetrics', 'getStatsByRiskLevel', 'isReadyForClosedLoop',
    'recordRecoveryMetric',
  ] },
  { name: 'policyProfileStore', exports: [
    'buildEffectiveRule', 'getPolicyBinding', 'getPolicyProfile', 'getPolicyRule', 'listPolicyBindings', 'listPolicyProfiles',
    'listPolicyRules', 'resolveApplicableProfiles', 'resolvePoliciesForStage', 'resolvePolicyProfile', 'savePolicyBinding', 'savePolicyProfile',
    'savePolicyRule',
  ] },
  { name: 'policyEvaluationStore', exports: [
    'createPolicyEvaluation', 'createPolicyOverride', 'getLatestPolicyEvaluationForScope', 'getOverrideRate', 'getPolicyEvaluation', 'getPolicyOverride',
    'listPolicyEvaluations', 'listPolicyOverrides', 'recordOverride', 'updatePolicyEvaluation',
  ] },
  { name: 'auditStore', exports: [
    'createAuditRun', 'getAuditRun', 'getAuditSummary', 'getFalsePositives', 'incrementAuditRunCounters', 'insertFindings',
    'listAuditRuns', 'updateAuditRun', 'updateFinding',
  ] },
  { name: 'ciCache', exports: [
    'deactivateCiWatch', 'getCiRunCache', 'getCiWatch', 'hasRunBeenDiagnosed', 'listActiveCiWatches', 'listCiRunCache',
    'pruneCiRunCache', 'updateWatchLastCheckedAt', 'upsertCiRunCache', 'upsertCiWatch',
  ] },
  { name: 'modelRoles', exports: [
    'clearModelRole', 'getModelForRole', 'listModelRoles', 'setModelRole',
  ] },
  { name: 'taskCore', exports: [
    'archiveOldTasks', 'claimSlotAtomic', 'clearProviderIfNotRunning', 'countTasks', 'countTasksByStatus', 'createTask',
    'deleteTask', 'deleteTasks', 'ensureProjectRegistered', 'getExpiredQueuedTasks', 'getNextQueuedTask', 'getRecentSuccessfulTasks',
    'getRunningCount', 'getRunningCountByProvider', 'getRunningTasksLightweight', 'getTask', 'getTaskStatus', 'listKnownProjects',
    'listQueuedTasksLightweight', 'listTasks', 'normalizeProviderValue', 'patchTaskMetadata', 'patchTaskSlotBinding', 'purgeOldTaskOutput',
    'requeueAfterSlotFailure', 'requeueTaskAfterAttemptedStart', 'resolveTaskId', 'tryClaimTaskSlot', 'updateTask', 'updateTaskProgress',
    'updateTaskStatus', 'validateColumnName',
  ] },
  { name: 'configCore', exports: [
    'clearConfigCache', 'ensureApiKey', 'getAllConfig', 'getConfig', 'getProviderRateLimits', 'setConfig',
    'setConfigDefault', 'getRejectRecoveryConfig',
  ] },
  { name: 'factoryHealth', exports: [
    'getBalanceScore', 'getFindings', 'getFindingsForSnapshots', 'getLatestScores', 'getLatestSnapshotIds', 'getProject',
    'getProjectByPath', 'getProjectHealthSummary', 'getProjectPolicy', 'getScoreHistory', 'listProjects', 'recordFindings',
    'recordSnapshot', 'registerProject', 'setProjectPolicy', 'updateProject',
  ] },
  { name: 'factoryIntake', exports: [
    'claimWorkItem', 'createFromFindings', 'createWorkItem', 'findDuplicates', 'getIntakeStats', 'getWorkItem',
    'getWorkItemForProject', 'linkItems', 'listOpenWorkItems', 'listWorkItems', 'normalizePriority', 'parseWorkItem',
    'rejectWorkItem', 'releaseClaimForInstance', 'updateWorkItem',
  ] },
  { name: 'factoryArchitect', exports: [
    'createCycle', 'getBacklog', 'getCycle', 'getLatestCycle', 'getReasoningLog', 'listCycles',
    'updateCycle',
  ] },
  { name: 'factoryLoopInstances', exports: [
    'claimStageForInstance', 'createFactoryLoopInstances', 'createInstance', 'getDb', 'getInstance', 'getStageOccupant',
    'isStageOccupancyConflict', 'listByStage', 'listInstances', 'parseInstance', 'resolveDbHandle', 'terminateInstance',
    'updateInstance',
  ] },
  { name: 'factoryWorktrees', exports: [
    'clearOwningTask', 'getActiveWorktree', 'getActiveWorktreeByBatch', 'getActiveWorktreeByBranch', 'getLatestWorktreeForWorkItem', 'getWorktreeByBranch',
    'listActiveWorktrees', 'markAbandoned', 'markMerged', 'recordWorktree', 'setOwningTask',
  ] },
];

function _makeLazyLegacyExport(moduleName, key) {
  return function lazyLegacyFacadeExport(...args) {
    const fn = _loadModule(moduleName)[key];
    if (typeof fn !== 'function') {
      throw new TypeError(`Legacy database export ${key} is not a function on ${moduleName}`);
    }
    return Reflect.apply(fn, this, args);
  };
}

function _defineFacadeValue(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function registerFacadeWithContainer() {
  try {
    const { defaultContainer } = require('./container');
    if (
      defaultContainer
      && typeof defaultContainer.has === 'function'
      && typeof defaultContainer.registerValue === 'function'
      && !defaultContainer.has('db')
    ) {
      defaultContainer.registerValue('db', facade);
    }
  } catch {
    // Container wiring is best-effort for legacy callers.
  }
}

const facade = {};

for (const definition of _LEGACY_EXPORT_MODULES) {
  for (const key of definition.exports) {
    const name = definition.name;
    _defineFacadeValue(facade, key, _makeLazyLegacyExport(name, key));
  }
}

for (const [key, value] of Object.entries({
  // Connection lifecycle and local facade overrides.
  init,
  close,
  onClose,
  resetForTest,
  getDbInstance,
  isDbClosed: () => dbClosed,
  isReady: () => !!db && !dbClosed,
  getDataDir: () => DATA_DIR,
  getDbPath: () => DB_PATH,

  // Core facade wrappers.
  getConfig,
  setConfig,
  setConfigDefault,
  getAllConfig,
  createTask,
  getTask,
  getRunningCount,

  // Core utilities.
  safeJsonParse,
  safeAddColumn,
  validateColumnName,

  // DI wiring (internal).
  _wireAllModules,

  // Listeners.
  addTaskStatusTransitionListener,
  removeTaskStatusTransitionListener,
})) {
  _defineFacadeValue(facade, key, value);
}

module.exports = facade;
