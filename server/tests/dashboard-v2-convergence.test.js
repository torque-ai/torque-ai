'use strict';

/**
 * Tests that verify the dashboard server properly delegates to v2 dispatch.
 * These tests confirm that /api/v2/* requests on the dashboard port are
 * handled by the v2 control-plane handlers.
 */

const { PassThrough: _PassThrough } = require('stream');

// ─── Mock setup ─────────────────────────────────────────────────────────────

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

// Mock dependencies for routes.js (required by v2-dispatch.js)
installCjsModuleMock('../database', {
  getDefaultProvider: () => null,
  onClose: () => {},
});
installCjsModuleMock('../api/v2-schemas', {
  validateInferenceRequest: vi.fn(() => ({ valid: true, errors: [], value: {} })),
});
installCjsModuleMock('../api/v2-middleware', {
  normalizeError: vi.fn(),
  requestId: vi.fn((_req, _res, next) => next()),
  validateRequest: () => vi.fn((_req, _res, next) => next()),
});
installCjsModuleMock('../api/middleware', {
  parseBody: vi.fn(async () => ({})),
  sendJson: vi.fn(),
});

// Mock handler modules (required by v2-dispatch.js)
const stubHandler = vi.fn();
const handlerModule = (names) => {
  const m = { init: vi.fn() };
  names.forEach(n => { m[n] = stubHandler; });
  return m;
};
installCjsModuleMock('../api/v2-task-handlers', handlerModule([
  'handleSubmitTask', 'handleListTasks', 'handleTaskDiff', 'handleTaskLogs',
  'handleTaskProgress', 'handleRetryTask', 'handleCommitTask',
]));
installCjsModuleMock('../api/v2-workflow-handlers', handlerModule([
  'handleCreateWorkflow', 'handleListWorkflows', 'handleGetWorkflow',
  'handleRunWorkflow', 'handleCancelWorkflow', 'handleAddWorkflowTask',
  'handleWorkflowHistory', 'handleCreateFeatureWorkflow',
]));
installCjsModuleMock('../api/v2-governance-handlers', handlerModule([
  'handleListApprovals', 'handleApprovalDecision', 'handleListSchedules',
  'handleCreateSchedule', 'handleGetSchedule', 'handleToggleSchedule',
  'handleDeleteSchedule', 'handleListPolicies', 'handleGetPolicy',
  'handleSetPolicyMode', 'handleEvaluatePolicies', 'handleListPolicyEvaluations',
  'handleGetPolicyEvaluation', 'handleOverridePolicyDecision',
  'handleListPlanProjects', 'handleGetPlanProject',
  'handlePlanProjectAction', 'handleDeletePlanProject', 'handleImportPlan',
  'handleListBenchmarks', 'handleApplyBenchmark', 'handleListProjectTuning',
  'handleCreateProjectTuning', 'handleDeleteProjectTuning',
  'handleProviderStats', 'handleProviderToggle', 'handleProviderTrends',
  'handleSystemStatus',
]));
installCjsModuleMock('../api/v2-analytics-handlers', handlerModule([
  'handleStatsOverview', 'handleTimeSeries', 'handleQualityStats',
  'handleStuckTasks', 'handleModelStats', 'handleFormatSuccess',
  'handleEventHistory', 'handleWebhookStats', 'handleNotificationStats',
  'handleThroughputMetrics',
  'handleBudgetSummary', 'handleBudgetStatus', 'handleSetBudget',
  'handleStrategicStatus', 'handleRoutingDecisions', 'handleProviderHealth',
]));
installCjsModuleMock('../api/v2-infrastructure-handlers', handlerModule([
  'handleListWorkstations', 'handleCreateWorkstation', 'handleProbeWorkstation', 'handleDeleteWorkstation',
  'handleListHosts', 'handleGetHost', 'handleToggleHost', 'handleDeleteHost',
  'handleHostScan', 'handleListPeekHosts', 'handleCreatePeekHost',
  'handleDeletePeekHost', 'handleTogglePeekHost', 'handleListCredentials',
  'handleSaveCredential', 'handleDeleteCredential', 'handleListAgents',
  'handleCreateAgent', 'handleGetAgent', 'handleAgentHealth', 'handleDeleteAgent',
]));

// Mock dispatchV2 function
const mockDispatchV2 = vi.fn();
installCjsModuleMock('../api/v2-dispatch', {
  dispatchV2: mockDispatchV2,
  init: vi.fn(),
  v2CpRoutes: [],
  V2_CP_HANDLER_LOOKUP: {},
});

// Mock dashboard router dispatch
const mockLegacyDispatch = vi.fn();
installCjsModuleMock('../dashboard/router', {
  dispatch: mockLegacyDispatch,
  routes: [],
});

// Mock dashboard utils
installCjsModuleMock('../dashboard/utils', {
  parseQuery: vi.fn(() => ({})),
  parseBody: vi.fn(async () => ({})),
  sendJson: vi.fn(),
  sendError: vi.fn(),
  isLocalhostOrigin: vi.fn(() => true),
});

// Mock other dependencies
installCjsModuleMock('../constants', {
  WS_MSG_RATE_LIMIT: 100,
  WS_MSG_RATE_WINDOW_MS: 60000,
});
installCjsModuleMock('../config', {
  init: vi.fn(),
  get: vi.fn(() => null),
  getInt: vi.fn(() => 0),
  getBool: vi.fn(() => false),
});
installCjsModuleMock('ws', { WebSocketServer: vi.fn() });

// ─── Tests ──────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.clearAllMocks();
});

describe('dashboard-server v2 convergence', () => {
  it('imports v2-dispatch module', () => {
    // Verify the module is importable (the mock is installed)
    const dispatch = require('../api/v2-dispatch');
    expect(typeof dispatch.dispatchV2).toBe('function');
  });

  it('dashboard-server.js requires v2-dispatch', () => {
    // Read the actual source to verify the import exists
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'dashboard-server.js'),
      'utf8'
    );
    expect(source).toContain("require('./api/v2-dispatch')");
  });

  it('dashboard-server.js checks /api/v2/ before legacy dispatch in request handler', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'dashboard-server.js'),
      'utf8'
    );

    // Find the HTTP request handler section (createServer callback)
    const handlerStart = source.indexOf('http.createServer');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerSection = source.slice(handlerStart);

    // V2 check should come before legacy /api/ check within the handler
    // Source may use req.url or urlPath depending on refactoring
    const v2CheckPos = Math.max(
      handlerSection.indexOf("req.url.startsWith('/api/v2/')"),
      handlerSection.indexOf("urlPath.startsWith('/api/v2/')")
    );
    const legacyCheckPos = Math.max(
      handlerSection.indexOf("} else if (req.url.startsWith('/api/'))"),
      handlerSection.indexOf("} else if (urlPath.startsWith('/api/'))")
    );
    expect(v2CheckPos).toBeGreaterThan(-1);
    expect(legacyCheckPos).toBeGreaterThan(-1);
    expect(v2CheckPos).toBeLessThan(legacyCheckPos);
  });

  it('dashboard-server.js falls through to legacy dispatch when v2 does not match', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'dashboard-server.js'),
      'utf8'
    );

    // Should have fallthrough logic: if (!handled) → dispatch
    expect(source).toContain('if (!handled)');
    expect(source).toContain('dispatch(req, res, routeContext)');
  });
});

describe('api.js v2 client', () => {
  it('dashboard api.js exports requestV2 function', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'dashboard', 'src', 'api.js'),
      'utf8'
    );
    expect(source).toContain('export async function requestV2');
  });

  it('dashboard api.js defines V2_BASE constant', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'dashboard', 'src', 'api.js'),
      'utf8'
    );
    expect(source).toContain("V2_BASE = '/api/v2'");
  });

  it('v2 endpoints use requestV2 for migrated routes', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'dashboard', 'src', 'api.js'),
      'utf8'
    );

    // Stats should use v2 (template literals use backticks)
    expect(source).toContain("requestV2('/stats/overview')");
    expect(source).toContain("requestV2(`/stats/quality");
    expect(source).toContain("requestV2('/stats/stuck')");

    // Budget should use v2
    expect(source).toContain("requestV2(`/budget/summary");
    expect(source).toContain("requestV2('/budget/status')");

    // Hosts should use v2
    expect(source).toContain("requestV2('/hosts')");

    // Schedules should use v2
    expect(source).toContain("requestV2('/schedules')");

    // Tasks should use v2 for list
    expect(source).toContain("requestV2(`/tasks");
  });

  it('legacy-only endpoints still use request()', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'dashboard', 'src', 'api.js'),
      'utf8'
    );

    // Coordination has no v2 equivalent
    expect(source).toContain("request(`/coordination");

    // Instances has no v2 equivalent
    expect(source).toContain("request('/instances'");

    // Free-tier has no v2 equivalent
    expect(source).toContain("request(`${LEGACY_FREE_TIER_BASE}/status`)");
  });
});

describe('v2 route coverage mapping', () => {
  it('v2-dispatch covers all handleV2Cp routes from routes.js', () => {
    // Clear cached mocks so we get fresh copies with proper dependencies mocked
    delete require.cache[require.resolve('../api/routes')];
    delete require.cache[require.resolve('../api/v2-dispatch')];

    const routes = require('../api/routes');
    const v2CpHandlerNames = routes
      .filter(r => r.handlerName && r.handlerName.startsWith('handleV2Cp'))
      .map(r => r.handlerName);

    expect(v2CpHandlerNames.length).toBeGreaterThan(0);

    const { V2_CP_HANDLER_LOOKUP } = require('../api/v2-dispatch');
    const lookupKeys = Object.keys(V2_CP_HANDLER_LOOKUP);

    for (const name of v2CpHandlerNames) {
      expect(lookupKeys).toContain(name);
    }
  });
});
