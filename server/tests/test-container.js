'use strict';

/**
 * Test container helper — provides a fresh DI container with in-memory SQLite
 * for test isolation. New tests should use this instead of require('../database').
 *
 * Usage:
 *   const { createTestContainer } = require('./test-container');
 *
 *   let container, db;
 *   beforeEach(() => {
 *     ({ container, db } = createTestContainer());
 *   });
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { createContainer } = require('../container');
const { ensureTestSchema } = require('./vitest-setup');

const TEMPLATE_DIR = path.join(os.tmpdir(), 'torque-vitest-template');
const TEMPLATE_BUF = path.join(TEMPLATE_DIR, 'template.db.buf');

let templateBuffer = null; // Loaded once per worker process

/**
 * Create a fresh test container with in-memory SQLite database.
 * Each call returns an independent container — no shared state between tests.
 *
 * Relies on the template buffer created by global-setup.js (same as vitest-setup.js).
 *
 * @returns {{ container: object, db: object }}
 *   container — DI container with boot/get/has/list/resetForTest
 *   db — database module (for legacy compat / direct queries in tests)
 */
function createTestContainer() {
  if (!templateBuffer) {
    templateBuffer = fs.readFileSync(TEMPLATE_BUF);
  }

  // Use the existing database module's resetForTest to get a clean in-memory DB
  const db = require('../database');
  db.resetForTest(templateBuffer);
  ensureTestSchema(db.getDbInstance());

  // Create a fresh container and register the test DB
  const container = createContainer();
  container.registerValue('db', db);
  container.registerValue('dbInstance', db.getDbInstance());

  // Register all db sub-modules — they're already wired via resetForTest's
  // _injectDbAll() and _wireCrossModuleDI() calls
  const dbModules = {
    configCore: require('../db/config-core'),
    taskCore: require('../db/task-core'),
    costTracking: require('../db/cost-tracking'),
    hostManagement: require('../db/host-management'),
    workflowEngine: require('../db/workflow-engine'),
    coordination: require('../db/coordination'),
    eventTracking: require('../db/event-tracking'),
    analytics: require('../db/analytics'),
    schedulingAutomation: require('../db/scheduling-automation'),
    taskMetadata: require('../db/task-metadata'),
    projectConfigCore: require('../db/project-config-core'),
    providerRoutingCore: require('../db/provider-routing-core'),
    fileTracking: require('../db/file-tracking'),
    webhooksStreaming: require('../db/webhooks-streaming'),
    inboundWebhooks: require('../db/inbound-webhooks'),
    backupCore: require('../db/backup-core'),
    auditStore: require('../db/audit-store'),
    emailPeek: require('../db/email-peek'),
    peekFixtureCatalog: require('../db/peek-fixture-catalog'),
    packRegistry: require('../db/pack-registry'),
    peekPolicyAudit: require('../db/peek-policy-audit'),
    peekRecoveryApprovals: require('../db/peek-recovery-approvals'),
    recoveryMetrics: require('../db/recovery-metrics'),
    validationRules: require('../db/validation-rules'),
    codeAnalysis: require('../db/code-analysis'),
    ciCache: require('../db/ci-cache'),
    budgetWatcher: require('../db/budget-watcher'),
    hostBenchmarking: require('../db/host-benchmarking'),
    hostComplexity: require('../db/host-complexity'),
    hostSelection: require('../db/host-selection'),
    projectCache: require('../db/project-cache'),
    providerCapabilities: require('../db/provider-capabilities'),
    providerPerformance: require('../db/provider-performance'),
    providerQuotas: require('../db/provider-quotas'),
    providerScoring: require('../db/provider-scoring'),
    modelCapabilities: require('../db/model-capabilities'),
    fileBaselines: require('../db/file-baselines'),
    fileQuality: require('../db/file-quality'),
    policyProfileStore: require('../policy-engine/profile-store'),
    policyEvaluationStore: require('../policy-engine/evaluation-store'),
  };

  // Stateless db utilities
  const statelessModules = {
    configKeys: require('../db/config-keys'),
    queryFilters: require('../db/query-filters'),
    schemaSeeds: require('../db/schema-seeds'),
    schemaMigrations: require('../db/schema-migrations'),
    analyticsMetrics: require('../db/analytics-metrics'),
  };

  for (const [name, mod] of Object.entries(dbModules)) {
    container.registerValue(name, mod);
  }
  for (const [name, mod] of Object.entries(statelessModules)) {
    container.registerValue(name, mod);
  }

  container.boot();
  return { container, db };
}

module.exports = { createTestContainer };
