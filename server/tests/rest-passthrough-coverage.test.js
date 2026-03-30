'use strict';

const fs = require('fs');
const path = require('path');

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

// Mock dependencies needed for routes.js / v2-dispatch.js.
installCjsModuleMock('../database', { getDefaultProvider: () => null, onClose: () => {} });
installCjsModuleMock('../api/v2-schemas', {
  validateInferenceRequest: vi.fn(() => ({ valid: true, errors: [], value: {} })),
});
installCjsModuleMock('../api/v2-middleware', {
  normalizeError: vi.fn(() => ({ status: 500, body: {} })),
  requestId: vi.fn((_req, _res, next) => next()),
  validateRequest: () => vi.fn((_req, _res, next) => next()),
});
installCjsModuleMock('../api/middleware', { parseBody: vi.fn(), sendJson: vi.fn() });

const stubHandler = vi.fn();
const handlerModule = (names) => {
  const moduleExports = { init: vi.fn() };
  names.forEach((name) => {
    moduleExports[name] = stubHandler;
  });
  return moduleExports;
};

installCjsModuleMock('../api/v2-task-handlers', handlerModule([
  'handleSubmitTask', 'handleListTasks', 'handleGetTask', 'handleCancelTask',
  'handleTaskDiff', 'handleTaskLogs', 'handleTaskProgress', 'handleRetryTask',
  'handleCommitTask', 'handleDeleteTask', 'handleApproveSwitch', 'handleRejectSwitch',
]));
installCjsModuleMock('../api/v2-workflow-handlers', handlerModule([
  'handleCreateWorkflow', 'handleListWorkflows', 'handleGetWorkflow',
  'handleRunWorkflow', 'handleCancelWorkflow', 'handleAddWorkflowTask',
  'handleWorkflowHistory', 'handleCreateFeatureWorkflow',
  'handlePauseWorkflow', 'handleResumeWorkflow', 'handleGetWorkflowTasks',
]));
installCjsModuleMock('../api/v2-governance-handlers', handlerModule([
  'handleListApprovals', 'handleApprovalDecision', 'handleListSchedules',
  'handleCreateSchedule', 'handleGetSchedule', 'handleToggleSchedule',
  'handleDeleteSchedule', 'handleListPolicies', 'handleGetPolicy',
  'handleSetPolicyMode', 'handleEvaluatePolicies', 'handleListPolicyEvaluations',
  'handleGetPolicyEvaluation', 'handleOverridePolicyDecision', 'handlePeekAttestationExport',
  'handleListPlanProjects', 'handleGetPlanProject',
  'handlePlanProjectAction', 'handleDeletePlanProject', 'handleImportPlan',
  'handleListBenchmarks', 'handleApplyBenchmark', 'handleListProjectTuning',
  'handleCreateProjectTuning', 'handleDeleteProjectTuning',
  'handleListProviders', 'handleProviderStats', 'handleProviderToggle', 'handleProviderTrends',
  'handleConfigureProvider', 'handleSetDefaultProvider',
  'handleSystemStatus',
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
  'handleHostScan', 'handleListPeekHosts', 'handleCreatePeekHost',
  'handleDeletePeekHost', 'handleTogglePeekHost', 'handleListCredentials',
  'handleSaveCredential', 'handleDeleteCredential', 'handleListAgents',
  'handleCreateAgent', 'handleGetAgent', 'handleAgentHealth', 'handleDeleteAgent',
  'handleAddHost', 'handleRefreshModels',
  'handleHostActivity', 'handleProviderPercentiles', 'handleCoordinationDashboard',
]));

const passthroughRoutes = require('../api/routes-passthrough');
const mainRoutes = require('../api/routes');
const { v2CpRoutes } = require('../api/v2-dispatch');

const EXPECTED_DOMAINS = [
  'advanced',
  'approvals',
  'audit',
  'automation',
  'baselines',
  'ci',
  'conflicts',
  'experiments',
  'integration',
  'intelligence',
  'notifications',
  'peek',
  'providers',
  'routing',
  'strategic',
  'system',
  'tasks',
  'tsserver',
  'validation',
  'webhooks',
  'workflows',
];

// Passthrough tools that are built-in MCP-SSE handlers or aliased tool names, not registered in tool-defs files
const BUILTIN_PASSTHROUGH_TOOLS = new Set([
  'check_notifications', 'subscribe_task_events',
  'register_peek_host', 'unregister_peek_host', // Aliased to create_peek_host / delete_peek_host in tool-defs
]);

// Passthrough routes intentionally duplicated in v2CpRoutes (routing layer handles priority)
const KNOWN_PASSTHROUGH_CP_OVERLAPS = new Set(['GET string:/api/v2/routing/categories']);

function serializePath(routePath) {
  if (typeof routePath === 'string') {
    return `string:${routePath}`;
  }
  return `regex:${routePath.source}/${routePath.flags}`;
}

function routeSignature(route) {
  return `${route.method} ${serializePath(route.path)}`;
}

function normalizePath(routePath) {
  if (typeof routePath === 'string') {
    return routePath;
  }
  return routePath.source
    .replace(/\\\//g, '/')
    .replace(/^\^/, '')
    .replace(/\$$/, '');
}

function extractDomain(route) {
  const match = normalizePath(route.path).match(/^\/api\/v2\/([^/]+)/);
  return match ? match[1] : null;
}

function findDuplicates(values) {
  const counts = new Map();
  values.forEach((value) => {
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value, count]) => ({ value, count }));
}

function loadToolDefNames() {
  const toolDefsDir = path.join(__dirname, '..', 'tool-defs');
  const files = fs.readdirSync(toolDefsDir)
    .filter((file) => file.endsWith('-defs.js'))
    .sort();

  const toolNames = new Set();
  files.forEach((file) => {
    const defs = require(path.join(toolDefsDir, file));
    expect(Array.isArray(defs)).toBe(true);
    defs.forEach((def) => {
      if (def && typeof def.name === 'string') {
        toolNames.add(def.name);
      }
    });
  });

  return toolNames;
}

const toolDefNames = loadToolDefNames();

describe('REST passthrough route coverage', () => {
  describe('route export contract', () => {
    it('exports 397+ route objects', () => {
      expect(Array.isArray(passthroughRoutes)).toBe(true);
      expect(passthroughRoutes.length).toBeGreaterThanOrEqual(397);
    });
  });

  describe('route shape and dispatch metadata', () => {
    it('every route has the required fields and method-specific mapping flags', () => {
      const allowedMethods = new Set(['GET', 'POST', 'DELETE', 'PATCH']);

      passthroughRoutes.forEach((route) => {
        expect(allowedMethods.has(route.method)).toBe(true);
        expect(typeof route.tool).toBe('string');
        expect(route.tool.length).toBeGreaterThan(0);

        const isPathString = typeof route.path === 'string';
        const isPathRegex = route.path instanceof RegExp;
        expect(isPathString || isPathRegex).toBe(true);

        if (route.method === 'GET') {
          expect(route.mapQuery).toBe(true);
        }

        if (route.method === 'POST') {
          expect(route.mapBody).toBe(true);
        }

        if (route.method === 'DELETE') {
          expect(route.mapQuery).toBe(true);
        }

        if (isPathRegex) {
          expect(Array.isArray(route.mapParams)).toBe(true);
          expect(route.mapParams.length).toBeGreaterThan(0);
        }
      });
    });

    it('has no duplicate method+path combinations', () => {
      const duplicates = findDuplicates(passthroughRoutes.map(routeSignature));
      expect(duplicates).toEqual([]);
    });
  });

  describe('tool naming and definition coverage', () => {
    it('uses lowercase underscore tool names with no spaces', () => {
      const invalid = passthroughRoutes
        .map((route) => route.tool)
        .filter((tool) => !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(tool));

      expect(invalid).toEqual([]);
    });

    it('cross-references every passthrough tool against exported tool-defs', () => {
      expect(toolDefNames.size).toBeGreaterThanOrEqual(400);

      const missing = passthroughRoutes
        .map((route) => route.tool)
        .filter((tool) => !toolDefNames.has(tool) && !BUILTIN_PASSTHROUGH_TOOLS.has(tool));

      expect(missing).toEqual([]);
    });
  });

  describe('domain coverage', () => {
    it('covers all 21 expected passthrough domains', () => {
      const coveredDomains = [...new Set(
        passthroughRoutes
          .map(extractDomain)
          .filter(Boolean)
      )].sort();

      expect(coveredDomains).toEqual([...EXPECTED_DOMAINS].sort());
    });
  });

  describe('integration with v2 routing tables', () => {
    it('does not shadow any v2 control-plane routes', () => {
      expect(v2CpRoutes.length).toBeGreaterThanOrEqual(100);

      const passthroughSignatures = new Set(passthroughRoutes.map(routeSignature));
      const overlaps = v2CpRoutes
        .filter((route) => passthroughSignatures.has(routeSignature(route)))
        .map(routeSignature)
        .filter((sig) => !KNOWN_PASSTHROUGH_CP_OVERLAPS.has(sig));

      expect(overlaps).toEqual([]);
    });

    it('is spread into the main routes.js array', () => {
      const mainRouteSignatures = new Set(mainRoutes.map(routeSignature));
      const missing = passthroughRoutes
        .map(routeSignature)
        .filter((signature) => !mainRouteSignatures.has(signature));

      expect(missing).toEqual([]);
      expect(mainRoutes.length).toBeGreaterThanOrEqual(passthroughRoutes.length + 100);
    });
  });
});
