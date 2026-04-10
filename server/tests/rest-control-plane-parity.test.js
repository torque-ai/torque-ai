'use strict';

/**
 * REST Control-Plane Parity Tests (Phase 9 Phase 5)
 *
 * Verifies that every non-exempt dashboard route has a v2 equivalent,
 * and that the v2 dispatch bridge covers all v2 CP routes from routes.js.
 * Prevents parity drift as new features are added.
 */

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

// Mock dependencies needed for routes.js
installCjsModuleMock('../database', { getDefaultProvider: () => null, onClose: () => {} });
installCjsModuleMock('../api/v2-schemas', {
  validateInferenceRequest: vi.fn(() => ({ valid: true, errors: [], value: {} })),
});
installCjsModuleMock('../api/v2-middleware', {
  normalizeError: vi.fn(),
  requestId: vi.fn((_req, _res, next) => next()),
  validateRequest: () => vi.fn((_req, _res, next) => next()),
});
installCjsModuleMock('../api/middleware', { parseBody: vi.fn(), sendJson: vi.fn() });

// Mock handler modules for v2-dispatch
const stubHandler = vi.fn();
const handlerModule = (names) => {
  const m = { init: vi.fn() };
  names.forEach(n => { m[n] = stubHandler; });
  return m;
};

installCjsModuleMock('../api/v2-task-handlers', handlerModule([
  'handleSubmitTask', 'handleListTasks', 'handleGetTask', 'handleCancelTask',
  'handleTaskDiff', 'handleTaskLogs', 'handleTaskProgress', 'handleRetryTask',
  'handleCommitTask', 'handleDeleteTask', 'handleApproveSwitch', 'handleRejectSwitch',
  'handleReassignTaskProvider',
]));
installCjsModuleMock('../api/v2-workflow-handlers', handlerModule([
  'handleCreateWorkflow', 'handleListWorkflows', 'handleGetWorkflow',
  'handleRunWorkflow', 'handleCancelWorkflow', 'handleAddWorkflowTask',
  'handleWorkflowHistory', 'handleCreateFeatureWorkflow',
  'handlePauseWorkflow', 'handleResumeWorkflow', 'handleGetWorkflowTasks',
]));
installCjsModuleMock('../api/v2-governance-handlers', handlerModule([
  'handleListApprovals', 'handleApprovalDecision', 'handleListSchedules',
  'handleCreateSchedule', 'handleGetSchedule', 'handleRunSchedule', 'handleToggleSchedule',
  'handleUpdateSchedule', 'handleGetScheduleRun', 'handleDeleteSchedule', 'handleListPolicies', 'handleGetPolicy',
  'handleSetPolicyMode', 'handleEvaluatePolicies', 'handleListPolicyEvaluations',
  'handleGetPolicyEvaluation', 'handleOverridePolicyDecision', 'handlePeekAttestationExport',
  'handleListPlanProjects', 'handleGetPlanProject',
  'handlePlanProjectAction', 'handleDeletePlanProject', 'handleImportPlan',
  'handleListBenchmarks', 'handleApplyBenchmark', 'handleListProjectTuning',
  'handleCreateProjectTuning', 'handleDeleteProjectTuning',
  'handleListProviders', 'handleProviderStats', 'handleProviderToggle', 'handleProviderTrends',
  'handleConfigureProvider', 'handleSetDefaultProvider',
  'handleSystemStatus',
  'handleListProjects',
  'handleScanProject', 'handleGetProjectDefaults', 'handleSetProjectDefaults',
  'handleGetConfig', 'handleSetConfig',
  'handleConfigureStallDetection', 'handleListWebhooks', 'handleAddWebhook',
  'handleRemoveWebhook', 'handleTestWebhook', 'handleAutoVerifyAndFix',
  'handleDetectFileConflicts',
]));
installCjsModuleMock('../api/v2-analytics-handlers', handlerModule([
  'handleStatsOverview', 'handleTimeSeries', 'handleQualityStats',
  'handleStuckTasks', 'handleModelStats', 'handleFormatSuccess',
  'handleEventHistory', 'handleWebhookStats', 'handleNotificationStats',
  'handleThroughputMetrics',
  'handleBudgetSummary', 'handleBudgetStatus', 'handleSetBudget',
  'handleStrategicStatus', 'handleRoutingDecisions', 'handleProviderHealth',
  'handleQuotaStatus', 'handleQuotaHistory', 'handleQuotaAutoScale',
  'handlePrometheusMetrics', 'handleStrategicOperations',
]));
installCjsModuleMock('../api/v2-infrastructure-handlers', handlerModule([
  'handleListWorkstations', 'handleCreateWorkstation', 'handleToggleWorkstation', 'handleProbeWorkstation', 'handleDeleteWorkstation',
  'handleListHosts', 'handleGetHost', 'handleToggleHost', 'handleDeleteHost',
  'handleUpdateHost',
  'handleHostScan', 'handleListPeekHosts', 'handleCreatePeekHost',
  'handleDeletePeekHost', 'handleTogglePeekHost', 'handleListCredentials',
  'handleSaveCredential', 'handleDeleteCredential', 'handleListAgents',
  'handleCreateAgent', 'handleGetAgent', 'handleAgentHealth', 'handleDeleteAgent',
  'handleAddHost', 'handleRefreshModels',
  'handleHostActivity', 'handleProviderPercentiles', 'handleCoordinationDashboard',
]));
installCjsModuleMock('../plugins/remote-agents/handlers', handlerModule([
  'handleRunRemoteCommand',
  'handleRunTests',
]));

// ─── Load modules ───────────────────────────────────────────────────────────

const routes = require('../api/routes');
const { V2_CP_HANDLER_LOOKUP, v2CpRoutes } = require('../api/v2-dispatch');

const fs = require('fs');
const path = require('path');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('REST control-plane parity', () => {
  describe('v2 dispatch bridge completeness', () => {
    it('all handleV2Cp routes in routes.js have entries in V2_CP_HANDLER_LOOKUP', () => {
      const v2CpHandlerNames = routes
        .filter(r => r.handlerName && r.handlerName.startsWith('handleV2Cp'))
        .map(r => r.handlerName);

      expect(v2CpHandlerNames.length).toBeGreaterThan(50);

      const lookupKeys = new Set(Object.keys(V2_CP_HANDLER_LOOKUP));
      const missing = v2CpHandlerNames.filter(n => !lookupKeys.has(n));

      expect(missing).toEqual([]);
    });

    it('all resolved v2 CP routes have handler functions', () => {
      for (const route of v2CpRoutes) {
        expect(typeof route.handler).toBe('function');
      }
    });

    it('v2 CP route count matches routes.js definitions', () => {
      // Compare unique handler names — some handlers serve multiple routes (e.g., GET /config and GET /config/:key)
      const routeHandlerNames = new Set(
        routes.filter(r => r.handlerName && r.handlerName.startsWith('handleV2Cp')).map(r => r.handlerName)
      );
      const dispatchHandlerNames = new Set(v2CpRoutes.map(r => r.handlerName));

      // Find any gaps for diagnostic purposes
      const missingFromDispatch = [...routeHandlerNames].filter(n => !dispatchHandlerNames.has(n));
      if (missingFromDispatch.length > 0) {
        console.warn('Handlers in routes but not dispatch:', missingFromDispatch);
      }

      expect(dispatchHandlerNames.size).toBe(routeHandlerNames.size);
    });
  });

  describe('v2 domain coverage', () => {
    it('has task CP routes', () => {
      const count = v2CpRoutes.filter(r =>
        r.handlerName.includes('Task') || r.handlerName.includes('Commit') ||
        r.handlerName === 'handleV2CpSubmitTask'
      ).length;
      expect(count).toBeGreaterThanOrEqual(7);
    });

    it('has workflow CP routes', () => {
      const count = v2CpRoutes.filter(r =>
        r.handlerName.includes('Workflow') || r.handlerName.includes('FeatureWorkflow')
      ).length;
      expect(count).toBeGreaterThanOrEqual(8);
    });

    it('has governance CP routes', () => {
      const count = v2CpRoutes.filter(r =>
        r.handlerName.includes('Approval') || r.handlerName.includes('Schedule') ||
        r.handlerName.includes('PlanProject') || r.handlerName.includes('ImportPlan') ||
        r.handlerName.includes('Benchmark') || r.handlerName.includes('Tuning') ||
        r.handlerName.includes('ProviderStats') || r.handlerName.includes('ProviderToggle') ||
        r.handlerName.includes('ProviderTrends') || r.handlerName.includes('SystemStatus')
      ).length;
      expect(count).toBeGreaterThanOrEqual(20);
    });

    it('has analytics CP routes', () => {
      const count = v2CpRoutes.filter(r =>
        r.handlerName.includes('Stats') || r.handlerName.includes('Budget') ||
        r.handlerName.includes('Strategic') || r.handlerName.includes('TimeSeries') ||
        r.handlerName.includes('Quality') || r.handlerName.includes('Stuck') ||
        r.handlerName.includes('Model') || r.handlerName.includes('Format') ||
        r.handlerName.includes('Event') || r.handlerName.includes('Webhook') ||
        r.handlerName.includes('Notification') || r.handlerName.includes('Routing') ||
        r.handlerName.includes('HealthCards')
      ).length;
      expect(count).toBeGreaterThanOrEqual(15);
    });

    it('has infrastructure CP routes', () => {
      const count = v2CpRoutes.filter(r =>
        r.handlerName.includes('Host') || r.handlerName.includes('PeekHost') ||
        r.handlerName.includes('Credential') || r.handlerName.includes('Agent')
      ).length;
      expect(count).toBeGreaterThanOrEqual(17);
    });
  });

  describe('v2 response contract', () => {
    it('all v2 CP routes use v2 middleware', () => {
      const v2CpDefs = routes.filter(r =>
        r.handlerName && r.handlerName.startsWith('handleV2Cp')
      );

      for (const route of v2CpDefs) {
        expect(route.middleware).toBeDefined();
        expect(Array.isArray(route.middleware)).toBe(true);
        expect(route.middleware.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('dashboard convergence', () => {
    it('dashboard-server.js imports v2-dispatch', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '..', 'dashboard-server.js'),
        'utf8'
      );
      expect(source).toContain("require('./api/v2-dispatch')");
    });

    it('dashboard-server.js intercepts /api/v2/ before legacy router', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '..', 'dashboard-server.js'),
        'utf8'
      );
      const handlerSection = source.slice(source.indexOf('http.createServer'));
      const v2Pos = handlerSection.indexOf("startsWith('/api/v2/')");
      // Use the dispatch pattern (} else if) to distinguish the routing check
      // from the auth middleware check that also uses startsWith('/api/')
      const legacyDispatchPos = handlerSection.indexOf("} else if (urlPath.startsWith('/api/'))");
      // Fall back to the simpler pattern if the else-if pattern isn't found
      const legacyPos = legacyDispatchPos > -1 ? legacyDispatchPos : handlerSection.indexOf("startsWith('/api/')");
      expect(v2Pos).toBeLessThan(legacyPos);
    });

    it('React api.js uses v2 endpoints for migrated domains', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'dashboard', 'src', 'api.js'),
        'utf8'
      );
      expect(source).toContain('requestV2');
      expect(source).toContain("V2_BASE = '/api/v2'");

      const v2Calls = (source.match(/requestV2/g) || []).length;
      expect(v2Calls).toBeGreaterThanOrEqual(30);
    });
  });

  describe('dashboard compat markers', () => {
    let routerSource;
    beforeAll(() => {
      routerSource = fs.readFileSync(
        path.join(__dirname, '..', 'dashboard', 'router.js'),
        'utf8'
      );
    });

    it('has compat markers on routes with v2 equivalents', () => {
      const compatCount = (routerSource.match(/compat:\s*true/g) || []).length;
      // 59 fully-covered routes as of Phase 9 Phase 5
      expect(compatCount).toBeGreaterThanOrEqual(55);
    });

    it('does not mark exempt routes as compat', () => {
      // These routes have no v2 equivalent — verify they lack compat: true
      const exemptPatterns = [
        'handleHostActivity',      // no v2 equiv
        'handleInstances',         // no v2 equiv
        'handleGetDashboard',      // coordination — no v2
        'handleListRoutingRules',  // coordination — no v2
        'handleListClaims',        // coordination — no v2
        'handleQuotaStatus',    // provider quota — no v2
        'handleQuotaHistory',   // provider quota — no v2
        'handleQuotaAutoScale', // provider quota — no v2
      ];
      for (const handler of exemptPatterns) {
        // Find the line with this handler — it should NOT have compat: true
        const lineRegex = new RegExp(`handler:\\s*\\w+\\.${handler}\\s*,\\s*compat:\\s*true`);
        expect(routerSource).not.toMatch(lineRegex);
      }
    });

    it('non-compat routes are documented as exempt', () => {
      // Count total routes vs compat routes
      const totalRouteLines = (routerSource.match(/handler:\s*\w+\.\w+/g) || []).length;
      const compatLines = (routerSource.match(/compat:\s*true/g) || []).length;
      const exemptCount = totalRouteLines - compatLines;
      // 28 routes have no v2 equivalent: activity, percentiles, task-actions (partial),
      // instances, get-tuning, workflow-tasks, operations, peek-test, peek-update,
      // credential-test, coordination(4), quota(3), coordination-agents
      expect(exemptCount).toBeLessThanOrEqual(28);
    });
  });

  describe('no parity regression', () => {
    it('v2 CP handler count has not decreased from baseline', () => {
      // Baseline: 145 handlers currently registered; keep a lower guardrail to catch regressions.
      expect(Object.keys(V2_CP_HANDLER_LOOKUP).length).toBeGreaterThanOrEqual(140);
    });

    it('v2 CP route count has not decreased from baseline', () => {
      // Baseline: 145 routes currently registered; keep a lower guardrail to catch regressions.
      expect(v2CpRoutes.length).toBeGreaterThanOrEqual(140);
    });
  });
});
