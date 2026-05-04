const Module = require('module');

const TASK_MANAGER_PATH = require.resolve('../task-manager');
const DASHBOARD_SERVER_PATH = require.resolve('../dashboard/server');
const V2_DISPATCH_PATH = require.resolve('../api/v2-dispatch');
const DASHBOARD_ROUTER_PATH = require.resolve('../dashboard/router');
const WS_PATH = require.resolve('ws');

const DASHBOARD_STACK_PATHS = [
  DASHBOARD_SERVER_PATH,
  V2_DISPATCH_PATH,
  DASHBOARD_ROUTER_PATH,
  WS_PATH,
];

function isCached(modulePath) {
  return Object.prototype.hasOwnProperty.call(require.cache, modulePath);
}

function clearSubjectCache() {
  delete require.cache[TASK_MANAGER_PATH];
  for (const modulePath of DASHBOARD_STACK_PATHS) {
    delete require.cache[modulePath];
  }
}

function stopTaskManagerIfLoaded() {
  const taskManager = require.cache[TASK_MANAGER_PATH]?.exports;
  if (taskManager && typeof taskManager.shutdown === 'function') {
    try {
      taskManager.shutdown({ cancelTasks: false });
    } catch {
      // Best-effort cleanup for import-only tests.
    }
  }
}

describe('task-manager dashboard lazy load', () => {
  beforeEach(() => {
    clearSubjectCache();
  });

  afterEach(() => {
    stopTaskManagerIfLoaded();
    vi.restoreAllMocks();
    clearSubjectCache();
  });

  it('does not load the dashboard server stack on import', () => {
    require('../task-manager');

    expect(isCached(DASHBOARD_SERVER_PATH)).toBe(false);
    expect(isCached(V2_DISPATCH_PATH)).toBe(false);
    expect(isCached(DASHBOARD_ROUTER_PATH)).toBe(false);
    expect(isCached(WS_PATH)).toBe(false);
  });

  it('loads dashboard-server only when the broadcaster emits an update', () => {
    const realLoad = Module._load;
    const realResolveFilename = Module._resolveFilename;
    const dashboardMock = {
      notifyTaskUpdated: vi.fn(),
      notifyTaskOutput: vi.fn(),
    };
    const dashboardLoads = [];

    vi.spyOn(Module, '_load').mockImplementation(function loadWithDashboardStub(request, parent, isMain, ...rest) {
      let resolved;
      try {
        resolved = realResolveFilename.call(Module, request, parent, isMain, ...rest);
      } catch {
        return realLoad.call(Module, request, parent, isMain, ...rest);
      }

      if (resolved === DASHBOARD_SERVER_PATH) {
        dashboardLoads.push(request);
        return dashboardMock;
      }

      return realLoad.call(Module, request, parent, isMain, ...rest);
    });

    const taskManager = require('../task-manager');

    expect(dashboardLoads).toHaveLength(0);
    const broadcaster = taskManager._testing.getDashboardBroadcaster();
    broadcaster.notifyTaskUpdated('task-lazy');
    broadcaster.notifyTaskOutput('task-lazy', 'chunk');

    expect(dashboardLoads).toHaveLength(1);
    expect(dashboardMock.notifyTaskUpdated).toHaveBeenCalledWith('task-lazy');
    expect(dashboardMock.notifyTaskOutput).toHaveBeenCalledWith('task-lazy', 'chunk');
  });
});
