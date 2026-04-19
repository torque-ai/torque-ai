'use strict';

/**
 * server/container.js — DI container and composition root for TORQUE.
 *
 * Every module registers as a factory with declared dependencies.
 * boot() resolves the dependency graph via topological sort and
 * instantiates all services in the correct order.
 *
 * API:
 *   createContainer()   → new container instance
 *   .register(name, deps, factory)  — register a factory
 *   .registerValue(name, value)     — register a pre-built value
 *   .boot()             — resolve deps, run factories
 *   .get(name)          — retrieve an instantiated service
 *   .has(name)          — check if a service is registered
 *   .list()             — list all registered service names
 *   .resetForTest()     — reset to pre-boot state (keeps registrations)
 *   .freeze()           — explicit freeze (must be called after boot)
 */

const logger = require('./logger').child({ component: 'container' });
const path = require('path');

const { createFamilyTemplates } = require('./db/family-templates');
const { createActionRegistry } = require('./dispatch/action-registry');
const { createConstructionCache } = require('./dispatch/construction-cache');
const { createExecutor } = require('./dispatch/executor');
const { migrateConfigToRegistry } = require('./discovery/config-migrator');
const { createRunDirManager } = require('./runs/run-dir-manager');

/**
 * Topological sort using Kahn's algorithm.
 * @param {Map<string, string[]>} graph - service name → dependency names
 * @returns {string[]} Sorted service names (dependency-first order)
 */
function topoSort(graph) {
  // Validate all deps exist
  for (const [name, deps] of graph) {
    for (const dep of deps) {
      if (!graph.has(dep)) {
        throw new Error(
          `Container: service '${name}' depends on '${dep}' which is not registered`
        );
      }
    }
  }

  // In-degree = number of unresolved dependencies each node has
  const inDeg = new Map();
  for (const [name, deps] of graph) {
    inDeg.set(name, deps.length);
  }

  // Queue starts with nodes that have no dependencies
  const queue = [];
  for (const [name, deg] of inDeg) {
    if (deg === 0) queue.push(name);
  }

  // Reverse adjacency: for each dep, which services depend on it?
  const dependents = new Map();
  for (const name of graph.keys()) {
    dependents.set(name, []);
  }
  for (const [name, deps] of graph) {
    for (const dep of deps) {
      dependents.get(dep).push(name);
    }
  }

  const sorted = [];
  while (queue.length > 0) {
    const current = queue.shift();
    sorted.push(current);
    for (const dependent of (dependents.get(current) || [])) {
      const newDeg = inDeg.get(dependent) - 1;
      inDeg.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  if (sorted.length !== graph.size) {
    const remaining = [...graph.keys()].filter(n => !sorted.includes(n));
    throw new Error(
      `Container: circular dependency detected among: ${remaining.join(', ')}`
    );
  }

  return sorted;
}

/**
 * Create a new DI container.
 * @returns {object} Container instance
 */
function createContainer() {
  const _registry = new Map();
  const _instances = new Map();
  let _booted = false;
  let _frozen = false;

  function register(name, deps, factory) {
    if (_frozen) throw new Error('Container: cannot register after freeze()');
    if (_booted) {
      throw new Error(`Container is frozen after boot() — cannot register '${name}'`);
    }
    if (_registry.has(name)) {
      logger.warn(`Container: overwriting registration for '${name}'`);
    }
    _registry.set(name, { deps, factory, value: undefined });
  }

  function registerValue(name, value) {
    if (_frozen) throw new Error('Container: cannot registerValue after freeze()');
    if (_booted) {
      throw new Error(`Container is frozen after boot() — cannot register '${name}'`);
    }
    _registry.set(name, { deps: [], factory: null, value });
  }

  function boot() {
    if (_booted) {
      logger.warn('Container: boot() called multiple times — skipping');
      return;
    }

    const graph = new Map();
    for (const [name, entry] of _registry) {
      graph.set(name, entry.deps);
    }

    const order = topoSort(graph);

    for (const name of order) {
      const entry = _registry.get(name);
      if (entry.factory) {
        const deps = {};
        for (const depName of entry.deps) {
          deps[depName] = _instances.get(depName);
        }
        try {
          _instances.set(name, entry.factory(deps));
        } catch (err) {
          const depNames = entry.deps.join(', ') || 'none';
          logger.error(`Container: factory for '${name}' threw (deps: ${depNames}): ${err.message}`);
          throw err;
        }
      } else {
        _instances.set(name, entry.value);
      }
    }

    _booted = true;
    logger.info(`Container: booted ${_instances.size} services`);
  }

  function get(name) {
    if (!_booted) {
      throw new Error(
        `Container: get('${name}') called before boot() — ` +
        `ensure container.boot() is called during startup`
      );
    }
    if (!_instances.has(name)) {
      throw new Error(`Container: service '${name}' is not registered`);
    }
    return _instances.get(name);
  }

  function has(name) {
    return _registry.has(name);
  }

  function list() {
    return [..._instances.keys()];
  }

  function freeze() {
    if (!_booted) {
      throw new Error('Container: cannot freeze before boot() — call boot() first');
    }
    _frozen = true;
  }

  function resetForTest() {
    _instances.clear();
    _booted = false;
    _frozen = false;
  }

  return { register, registerValue, boot, get, has, list, freeze, resetForTest };
}

// ── Legacy compatibility ────────────────────────────────────────────────────
const _defaultContainer = createContainer();

// ── DI-factory registrations ─────────────────────────────────────────────────
// Register services that use the proper DI factory pattern (createXxx(deps)).
// These are resolved at boot() time, after all values (e.g. 'db') are registered.
_defaultContainer.register('familyTemplates', ['db'], createFamilyTemplates);
_defaultContainer.register('actionRegistry', [], () => createActionRegistry());
_defaultContainer.register('constructionCache', ['db'], ({ db }) => createConstructionCache({ db }));
_defaultContainer.register('executor', ['actionRegistry'], ({ actionRegistry }) => createExecutor({ registry: actionRegistry }));
_defaultContainer.register('runDirManager', ['db'], ({ db }) => {
  const dataDir = typeof db.getDataDir === 'function'
    ? db.getDataDir()
    : require('./data-dir').getDataDir();
  const rawDb = typeof db.getDbInstance === 'function' ? db.getDbInstance() : db;
  return createRunDirManager({
    db: rawDb,
    rootDir: path.join(dataDir, 'runs'),
    promotedDir: path.join(dataDir, 'promoted'),
  });
});

function initModules(db, serverConfig) {
  if (!_defaultContainer.has('db')) {
    _defaultContainer.registerValue('db', db);
  }
  if (!_defaultContainer.has('serverConfig')) {
    _defaultContainer.registerValue('serverConfig', serverConfig);
  }
  serverConfig.init({ db });
  logger.info('Container: config.js wired via init(deps)');

  const providerCfg = require('./providers/config');
  providerCfg.init({ db });
  if (!_defaultContainer.has('providerCfg')) {
    _defaultContainer.registerValue('providerCfg', providerCfg);
  }

  const providerRegistry = require('./providers/registry');
  providerRegistry.init({ db });
  providerRegistry.registerProviderClass('codex', require('./providers/v2-cli-providers').CodexCliProvider);
  providerRegistry.registerProviderClass('claude-code-sdk', require('./providers/claude-code-sdk'));
  if (!_defaultContainer.has('providerRegistry')) {
    _defaultContainer.registerValue('providerRegistry', providerRegistry);
  }

  const mcpProtocol = require('./mcp-protocol');
  if (!_defaultContainer.has('mcpProtocol')) {
    _defaultContainer.registerValue('mcpProtocol', mcpProtocol);
  }
  if (!_defaultContainer.has('sandboxManager')) {
    const { createSandboxManager } = require('./sandbox/sandbox-manager');
    const { createLocalProcessBackend } = require('./sandbox/backends/local-process');

    const sandboxManager = createSandboxManager();
    sandboxManager.registerBackend('local-process', createLocalProcessBackend({
      workDir: path.join('.torque', 'sandbox'),
    }));

    if (process.env.E2B_API_KEY) {
      try {
        const { createE2BBackend } = require('./sandbox/backends/e2b-backend');
        sandboxManager.registerBackend('e2b', createE2BBackend({
          apiKey: process.env.E2B_API_KEY,
        }));
      } catch (error) {
        logger.warn(`Container: unable to register e2b sandbox backend: ${error.message}`);
      }
    }

    _defaultContainer.registerValue('sandboxManager', sandboxManager);
  }

  // Stateless db utilities — pure functions, no DI needed
  if (!_defaultContainer.has('configKeys')) {
    _defaultContainer.registerValue('configKeys', require('./db/config-keys'));
    _defaultContainer.registerValue('queryFilters', require('./db/query-filters'));
    _defaultContainer.registerValue('schemaSeeds', require('./db/schema-seeds'));
    _defaultContainer.registerValue('schemaMigrations', require('./db/schema-migrations'));
    _defaultContainer.registerValue('analyticsMetrics', require('./db/analytics-metrics'));
  }

  // DB modules with factory exports — bridge pattern (factory calls setDb internally)
  if (!_defaultContainer.has('configCore')) {
    const configCore = require('./db/config-core');
    const taskCore = require('./db/task-core');
    const costTracking = require('./db/cost-tracking');
    const coordination = require('./db/coordination');
    const hostManagement = require('./db/host-management');
    const workflowEngine = require('./db/workflow-engine');
    const fileTracking = require('./db/file-tracking');
    const schedulingAutomation = require('./db/scheduling-automation');
    const taskMetadata = require('./db/task-metadata');
    const eventTracking = require('./db/event-tracking');
    const analytics = require('./db/analytics');
    const webhooksStreaming = require('./db/webhooks-streaming');
    const inboundWebhooks = require('./db/inbound-webhooks');
    const projectConfigCore = require('./db/project-config-core');
    const providerRoutingCore = require('./db/provider-routing-core');
    const backupCore = require('./db/backup-core');
    const auditStore = require('./db/audit-store');
    const emailPeek = require('./db/email-peek');
    const peekFixtureCatalog = require('./db/peek-fixture-catalog');
    const packRegistry = require('./db/pack-registry');
    const peekPolicyAudit = require('./db/peek-policy-audit');
    const peekRecoveryApprovals = require('./db/peek-recovery-approvals');
    const recoveryMetrics = require('./db/recovery-metrics');
    const validationRules = require('./db/validation-rules');
    const codeAnalysis = require('./db/code-analysis');
    const ciCache = require('./db/ci-cache');
    const hostBenchmarking = require('./db/host-benchmarking');
    const hostComplexity = require('./db/host-complexity');
    const hostSelection = require('./db/host-selection');
    const projectCache = require('./db/project-cache');
    const providerCapabilities = require('./db/provider-capabilities');
    const providerPerformance = require('./db/provider-performance');
    const providerQuotas = require('./db/provider-quotas');
    const modelCapabilities = require('./db/model-capabilities');
    const modelRoles = require('./db/model-roles');
    const fileBaselines = require('./db/file-baselines');
    const fileQuality = require('./db/file-quality');
    const policyProfileStore = require('./policy-engine/profile-store');
    const policyEvaluationStore = require('./policy-engine/evaluation-store');

    // Register as values — these modules are already initialized by database.js
    // via setDb() during init(). The container provides an alternative access path.
    _defaultContainer.registerValue('configCore', configCore);
    _defaultContainer.registerValue('taskCore', taskCore);
    _defaultContainer.registerValue('costTracking', costTracking);
    _defaultContainer.registerValue('coordination', coordination);
    _defaultContainer.registerValue('hostManagement', hostManagement);
    _defaultContainer.registerValue('workflowEngine', workflowEngine);
    _defaultContainer.registerValue('fileTracking', fileTracking);
    _defaultContainer.registerValue('schedulingAutomation', schedulingAutomation);
    _defaultContainer.registerValue('taskMetadata', taskMetadata);
    _defaultContainer.registerValue('eventTracking', eventTracking);
    _defaultContainer.registerValue('analytics', analytics);
    _defaultContainer.registerValue('webhooksStreaming', webhooksStreaming);
    _defaultContainer.registerValue('inboundWebhooks', inboundWebhooks);
    _defaultContainer.registerValue('projectConfigCore', projectConfigCore);
    _defaultContainer.registerValue('providerRoutingCore', providerRoutingCore);
    _defaultContainer.registerValue('backupCore', backupCore);
    _defaultContainer.registerValue('auditStore', auditStore);
    _defaultContainer.registerValue('emailPeek', emailPeek);
    _defaultContainer.registerValue('peekFixtureCatalog', peekFixtureCatalog);
    _defaultContainer.registerValue('packRegistry', packRegistry);
    _defaultContainer.registerValue('peekPolicyAudit', peekPolicyAudit);
    _defaultContainer.registerValue('peekRecoveryApprovals', peekRecoveryApprovals);
    _defaultContainer.registerValue('recoveryMetrics', recoveryMetrics);
    _defaultContainer.registerValue('validationRules', validationRules);
    _defaultContainer.registerValue('codeAnalysis', codeAnalysis);
    _defaultContainer.registerValue('ciCache', ciCache);
    _defaultContainer.registerValue('hostBenchmarking', hostBenchmarking);
    _defaultContainer.registerValue('hostComplexity', hostComplexity);
    _defaultContainer.registerValue('hostSelection', hostSelection);
    _defaultContainer.registerValue('projectCache', projectCache);
    _defaultContainer.registerValue('providerCapabilities', providerCapabilities);
    _defaultContainer.registerValue('providerPerformance', providerPerformance);
    _defaultContainer.registerValue('providerQuotas', providerQuotas);
    _defaultContainer.registerValue('modelCapabilities', modelCapabilities);
    _defaultContainer.registerValue('modelRoles', modelRoles);
    _defaultContainer.registerValue('fileBaselines', fileBaselines);
    _defaultContainer.registerValue('fileQuality', fileQuality);
    _defaultContainer.registerValue('policyProfileStore', policyProfileStore);
    _defaultContainer.registerValue('policyEvaluationStore', policyEvaluationStore);

    const factoryHealth = require('./db/factory-health');
    _defaultContainer.registerValue('factoryHealth', factoryHealth);

    const factoryIntake = require('./db/factory-intake');
    _defaultContainer.registerValue('factoryIntake', factoryIntake);

    const factoryArchitect = require('./db/factory-architect');
    _defaultContainer.registerValue('factoryArchitect', factoryArchitect);

    const factoryFeedback = require('./db/factory-feedback');
    _defaultContainer.registerValue('factoryFeedback', factoryFeedback);

    const factoryAudit = require('./db/factory-audit');
    _defaultContainer.registerValue('factoryAudit', factoryAudit);

    const factoryLoopInstances = require('./db/factory-loop-instances');
    _defaultContainer.registerValue('factoryLoopInstances', factoryLoopInstances);

    const factoryWorktrees = require('./db/factory-worktrees');
    _defaultContainer.registerValue('factoryWorktrees', factoryWorktrees);
  }
  if (!_defaultContainer.has('providerScoring')) {
    const { createProviderScoring } = require('./db/provider-scoring');
    const scoring = createProviderScoring({ db });
    _defaultContainer.registerValue('providerScoring', scoring);
    // Inject into provider-routing-core so scored fallback chains work
    const providerRoutingCore = require('./db/provider-routing-core');
    if (typeof providerRoutingCore.setProviderScoring === 'function') {
      providerRoutingCore.setProviderScoring(scoring);
    }
  }
  if (!_defaultContainer.has('budgetWatcher')) {
    const { createBudgetWatcher } = require('./db/budget-watcher');
    const eventBus = _defaultContainer.has('eventBus')
      ? _defaultContainer.get('eventBus')
      : null;
    _defaultContainer.registerValue('budgetWatcher', createBudgetWatcher({ db, eventBus }));
  }

  // Domain services
  if (!_defaultContainer.has('config')) {
    const { createTestRunnerRegistry } = require('./test-runner-registry');
    _defaultContainer.registerValue('config', require('./config'));
    _defaultContainer.registerValue('discovery', require('./discovery'));
    _defaultContainer.registerValue('tools', require('./tools'));
    _defaultContainer.registerValue('freeQuotaTracker', require('./free-quota-tracker'));
    _defaultContainer.registerValue('taskManager', require('./task-manager'));
    _defaultContainer.registerValue('testRunnerRegistry', createTestRunnerRegistry());
  }

  // Provider modules
  if (!_defaultContainer.has('v2LocalProviders')) {
    _defaultContainer.registerValue('v2LocalProviders', require('./providers/v2-local-providers'));
    _defaultContainer.registerValue('v2CliProviders', require('./providers/v2-cli-providers'));
  }

  // Execution modules
  if (!_defaultContainer.has('processLifecycle')) {
    _defaultContainer.registerValue('processLifecycle', require('./execution/process-lifecycle'));
    _defaultContainer.registerValue('taskFinalizer', require('./execution/task-finalizer'));
    _defaultContainer.registerValue('conflictResolver', require('./execution/conflict-resolver'));
    _defaultContainer.registerValue('debugLifecycle', require('./execution/debug-lifecycle'));
    _defaultContainer.registerValue('strategicHooks', require('./execution/strategic-hooks'));
    _defaultContainer.registerValue('workflowRuntime', require('./execution/workflow-runtime'));
    _defaultContainer.registerValue('queueScheduler', require('./execution/queue-scheduler'));
    _defaultContainer.registerValue('fallbackRetry', require('./execution/fallback-retry'));
    _defaultContainer.registerValue('providerRouter', require('./execution/provider-router'));
    _defaultContainer.registerValue('slotPullScheduler', require('./execution/slot-pull-scheduler'));
  }
  if (!_defaultContainer.has('taskDecomposition')) {
    _defaultContainer.registerValue('taskDecomposition', require('./execution/task-decomposition'));
  }
  if (!_defaultContainer.has('circuitBreaker')) {
    const { createCircuitBreaker } = require('./execution/circuit-breaker');
    const eventBus = _defaultContainer.has('eventBus')
      ? _defaultContainer.get('eventBus')
      : null;
    const cbInstance = createCircuitBreaker({ eventBus });
    _defaultContainer.registerValue('circuitBreaker', cbInstance);
    // Inject into provider-routing-core so smart-routing circuit breaker guard works
    const providerRoutingCore = require('./db/provider-routing-core');
    if (typeof providerRoutingCore.setCircuitBreaker === 'function') {
      providerRoutingCore.setCircuitBreaker(cbInstance);
    }
  }

  // API modules
  if (!_defaultContainer.has('apiMiddleware')) {
    _defaultContainer.registerValue('apiMiddleware', require('./api/middleware'));
    _defaultContainer.registerValue('apiRoutes', require('./api/routes'));
    _defaultContainer.registerValue('apiHealthProbes', require('./api/health-probes'));
    _defaultContainer.registerValue('apiWebhooks', require('./api/webhooks'));
    _defaultContainer.registerValue('v2AnalyticsHandlers', require('./api/v2-analytics-handlers'));
    _defaultContainer.registerValue('v2ControlPlane', require('./api/v2-control-plane'));
    _defaultContainer.registerValue('v2GovernanceHandlers', require('./api/v2-governance-handlers'));
    _defaultContainer.registerValue('v2InfrastructureHandlers', require('./api/v2-infrastructure-handlers'));
    _defaultContainer.registerValue('v2Router', require('./api/v2-router'));
    _defaultContainer.registerValue('v2TaskHandlers', require('./api/v2-task-handlers'));
    _defaultContainer.registerValue('v2WorkflowHandlers', require('./api/v2-workflow-handlers'));
  }

  // Dashboard modules
  if (!_defaultContainer.has('dashboardUtils')) {
    _defaultContainer.registerValue('dashboardUtils', require('./dashboard/utils'));
    _defaultContainer.registerValue('dashboardAdminRoutes', require('./dashboard/routes/admin'));
    _defaultContainer.registerValue('dashboardAnalyticsRoutes', require('./dashboard/routes/analytics'));
    _defaultContainer.registerValue('dashboardInfraRoutes', require('./dashboard/routes/infrastructure'));
    _defaultContainer.registerValue('dashboardTaskRoutes', require('./dashboard/routes/tasks'));
  }

  // Handler modules
  if (!_defaultContainer.has('taskCoreHandlers')) {
    // handlers/task/
    _defaultContainer.registerValue('taskCoreHandlers', require('./handlers/task/core'));
    _defaultContainer.registerValue('taskIntelligenceHandlers', require('./handlers/task/intelligence'));
    _defaultContainer.registerValue('taskOperationsHandlers', require('./handlers/task/operations'));
    _defaultContainer.registerValue('taskPipelineHandlers', require('./handlers/task/pipeline'));
    _defaultContainer.registerValue('taskProjectHandlers', require('./handlers/task/project'));
    // handlers/workflow/
    _defaultContainer.registerValue('workflowHandlers', require('./handlers/workflow/index'));
    _defaultContainer.registerValue('workflowAdvancedHandlers', require('./handlers/workflow/advanced'));
    _defaultContainer.registerValue('workflowAwaitHandlers', require('./handlers/workflow/await'));
    _defaultContainer.registerValue('workflowDagHandlers', require('./handlers/workflow/dag'));
    _defaultContainer.registerValue('workflowTemplatesHandlers', require('./handlers/workflow/templates'));
    // handlers/integration/
    _defaultContainer.registerValue('integrationHandlers', require('./handlers/integration/index'));
    _defaultContainer.registerValue('integrationRoutingHandlers', require('./handlers/integration/routing'));
    _defaultContainer.registerValue('integrationInfraHandlers', require('./handlers/integration/infra'));
    _defaultContainer.registerValue('integrationPlansHandlers', require('./handlers/integration/plans'));
    // handlers/advanced/
    _defaultContainer.registerValue('approvalHandlers', require('./handlers/advanced/approval'));
    _defaultContainer.registerValue('artifactsHandlers', require('./handlers/advanced/artifacts'));
    _defaultContainer.registerValue('coordinationHandlers', require('./handlers/advanced/coordination'));
    _defaultContainer.registerValue('debuggerHandlers', require('./handlers/advanced/debugger'));
    _defaultContainer.registerValue('intelligenceHandlers', require('./handlers/advanced/intelligence'));
    _defaultContainer.registerValue('performanceHandlers', require('./handlers/advanced/performance'));
    _defaultContainer.registerValue('schedulingHandlers', require('./handlers/advanced/scheduling'));
    // plugins/snapscope/handlers/
    _defaultContainer.registerValue('peekArtifactsHandlers', require('./plugins/snapscope/handlers/artifacts'));
    _defaultContainer.registerValue('peekCaptureHandlers', require('./plugins/snapscope/handlers/capture'));
    _defaultContainer.registerValue('peekComplianceHandlers', require('./plugins/snapscope/handlers/compliance'));
    _defaultContainer.registerValue('peekHostsHandlers', require('./plugins/snapscope/handlers/hosts'));
    _defaultContainer.registerValue('peekRecoveryHandlers', require('./plugins/snapscope/handlers/recovery'));
    _defaultContainer.registerValue('peekSharedHandlers', require('./plugins/snapscope/handlers/shared'));
    _defaultContainer.registerValue('peekWebhookOutboundHandlers', require('./plugins/snapscope/handlers/webhook-outbound'));
    // handlers/validation/
    _defaultContainer.registerValue('validationHandlers', require('./handlers/validation/index'));
    _defaultContainer.registerValue('validationAnalysisHandlers', require('./handlers/validation/analysis'));
    _defaultContainer.registerValue('validationFailureHandlers', require('./handlers/validation/failure'));
    _defaultContainer.registerValue('validationFileHandlers', require('./handlers/validation/file'));
    _defaultContainer.registerValue('validationSafeguardHandlers', require('./handlers/validation/safeguard'));
    _defaultContainer.registerValue('validationSecurityHandlers', require('./handlers/validation/security'));
    _defaultContainer.registerValue('validationXamlHandlers', require('./handlers/validation/xaml'));
    // handlers/ top-level
    _defaultContainer.registerValue('automationBatchOrchestration', require('./handlers/automation-batch-orchestration'));
    _defaultContainer.registerValue('automationHandlers', require('./handlers/automation-handlers'));
    _defaultContainer.registerValue('ciHandlers', require('./handlers/ci-handlers'));
    _defaultContainer.registerValue('comparisonHandler', require('./handlers/comparison-handler'));
    _defaultContainer.registerValue('competitiveFeatureHandlers', require('./handlers/competitive-feature-handlers'));
    _defaultContainer.registerValue('concurrencyHandlers', require('./handlers/concurrency-handlers'));
    _defaultContainer.registerValue('conflictResolutionHandlers', require('./handlers/conflict-resolution-handlers'));
    _defaultContainer.registerValue('contextHandler', require('./handlers/context-handler'));
    _defaultContainer.registerValue('experimentHandlers', require('./handlers/experiment-handlers'));
    _defaultContainer.registerValue('inboundWebhookHandlers', require('./handlers/inbound-webhook-handlers'));
    _defaultContainer.registerValue('mcpToolsHandlers', require('./handlers/mcp-tools'));
    _defaultContainer.registerValue('orchestratorHandlers', require('./handlers/orchestrator-handlers'));
    _defaultContainer.registerValue('providerCrudHandlers', require('./handlers/provider-crud-handlers'));
    _defaultContainer.registerValue('providerHandlers', require('./handlers/provider-handlers'));
    _defaultContainer.registerValue('providerOllamaHostsHandlers', require('./handlers/provider-ollama-hosts'));
    _defaultContainer.registerValue('providerTuningHandlers', require('./handlers/provider-tuning'));
    _defaultContainer.registerValue('reviewHandler', require('./handlers/review-handler'));
    _defaultContainer.registerValue('strategicConfigHandlers', require('./handlers/strategic-config-handlers'));
    _defaultContainer.registerValue('webhookHandlers', require('./handlers/webhook-handlers'));
  }

  // Hooks, CI, MCP, utils
  if (!_defaultContainer.has('approvalGate')) {
    _defaultContainer.registerValue('approvalGate', require('./hooks/approval-gate'));
    _defaultContainer.registerValue('eventDispatch', require('./hooks/event-dispatch'));
    _defaultContainer.registerValue('ciWatcher', require('./ci/watcher'));
    _defaultContainer.registerValue('agentDiscovery', require('./utils/agent-discovery'));
    _defaultContainer.registerValue('mcpGateway', require('./mcp'));
  }

  // Policy engine
  if (!_defaultContainer.has('policyEngine')) {
    _defaultContainer.registerValue('policyEngine', require('./policy-engine/engine'));
    _defaultContainer.registerValue('architectureAdapter', require('./policy-engine/adapters/architecture'));
    _defaultContainer.registerValue('featureFlagAdapter', require('./policy-engine/adapters/feature-flag'));
    _defaultContainer.registerValue('refactorDebtAdapter', require('./policy-engine/adapters/refactor-debt'));
    _defaultContainer.registerValue('releaseGateAdapter', require('./policy-engine/adapters/release-gate'));
  }
  // Governance — isolated try/catch so it initializes even if earlier registrations fail
  try {
    let governanceRules = null;
    if (!_defaultContainer.has('governanceRules')) {
      const { createGovernanceRules } = require('./db/governance-rules');
      governanceRules = createGovernanceRules({ db });
      governanceRules.seedBuiltinRules();
      _defaultContainer.registerValue('governanceRules', governanceRules);
    } else {
      governanceRules = _defaultContainer.get('governanceRules');
    }
    if (!_defaultContainer.has('governanceHooks')) {
      const { createGovernanceHooks } = require('./governance/hooks');
      _defaultContainer.registerValue('governanceHooks', createGovernanceHooks({ governanceRules, logger }));
    }
  } catch (e) {
    if (logger) logger.debug('Governance init: ' + e.message);
  }

  if (!_defaultContainer.has('fileRisk')) {
    const { createFileRisk } = require('./db/file-risk');
    _defaultContainer.registerValue('fileRisk', createFileRisk({ db }));
  }
  if (!_defaultContainer.has('fileRiskAdapter')) {
    const { createFileRiskAdapter } = require('./policy-engine/adapters/file-risk');
    const fileRisk = _defaultContainer.get('fileRisk');
    _defaultContainer.registerValue('fileRiskAdapter', createFileRiskAdapter({ db, fileRisk }));
  }
  if (!_defaultContainer.has('verificationLedger')) {
    const { createVerificationLedger } = require('./db/verification-ledger');
    _defaultContainer.registerValue('verificationLedger', createVerificationLedger({ db }));
  }
  // Adversarial Reviews — Evidence & Risk Engine
  if (!_defaultContainer.has('adversarialReviews')) {
    const { createAdversarialReviews } = require('./db/adversarial-reviews');
    _defaultContainer.registerValue('adversarialReviews', createAdversarialReviews({ db }));
  }
  if (!_defaultContainer.has('symbolIndexer')) {
    const { createSymbolIndexer } = require('./utils/symbol-indexer');
    const symbolIndexer = createSymbolIndexer({ db });
    if (typeof symbolIndexer.init === 'function') {
      symbolIndexer.init(db);
    }
    _defaultContainer.registerValue('symbolIndexer', symbolIndexer);
  }
  const { createRepoRegistry } = require('./repo-graph/repo-registry');
  const ensureRepoRegistry = () => createRepoRegistry({ db: rawDb });
  if (!_defaultContainer.has('repoRegistry')) {
    _defaultContainer.registerValue('repoRegistry', createRepoRegistry({ db: rawDb }));
  }
  if (!_defaultContainer.has('graphIndexer')) {
    const { createGraphIndexer } = require('./repo-graph/graph-indexer');
    _defaultContainer.registerValue('graphIndexer', createGraphIndexer({
      db: rawDb,
      repoRegistry: ensureRepoRegistry(),
      logger: logger.child({ component: 'graph-indexer' }),
    }));
  }
  if (!_defaultContainer.has('mentionResolver')) {
    const { createMentionResolver } = require('./repo-graph/mention-resolver');
    _defaultContainer.registerValue('mentionResolver', createMentionResolver({
      db: rawDb,
      repoRegistry: ensureRepoRegistry(),
      logger: logger.child({ component: 'mention-resolver' }),
    }));
  }
  if (!_defaultContainer.has('templateRegistry')) {
    const { createTemplateRegistry } = require('./templates/registry');
    const registry = createTemplateRegistry();
    registry.loadTemplates();
    _defaultContainer.registerValue('templateRegistry', registry);
  }
  if (!_defaultContainer.has('patternsStore')) {
    const { createPatternsStore } = require('./patterns/store');
    const patternsStore = createPatternsStore({
      cwd: process.cwd(),
      dir: path.join(process.cwd(), '.torque', 'patterns'),
    });
    if (typeof db.onClose === 'function') {
      db.onClose(() => {
        if (typeof patternsStore.shutdown === 'function') {
          patternsStore.shutdown();
        }
      });
    }
    _defaultContainer.registerValue('patternsStore', patternsStore);
  }
  if (!_defaultContainer.has('projectDetector')) {
    const { createProjectDetector } = require('./templates/detector');
    const templateRegistry = _defaultContainer.get('templateRegistry');
    _defaultContainer.registerValue('projectDetector', createProjectDetector({ templateRegistry }));
  }

  // Run config-to-registry migration now that DB is available and schema migrations
  // have already run (they complete during database.js initialization, before initModules).
  // All operations in migrateConfigToRegistry are idempotent — safe to call on every startup.
  try {
    migrateConfigToRegistry(db);
    logger.info('Container: config-to-registry migration complete');
  } catch (err) {
    logger.warn(`Container: config-to-registry migration failed (non-fatal): ${err.message}`);
  }

  logger.info('Container: core modules initialized (legacy path)');
}

function getModule(name) {
  try {
    return _defaultContainer.get(name);
  } catch {
    return undefined;
  }
}

module.exports = {
  createContainer,
  initModules,
  getModule,
  defaultContainer: _defaultContainer,
};
