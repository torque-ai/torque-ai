import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Skip if jsdom is not available (remote/CI environments without it)
let jsdomAvailable = true;
try { await import('jsdom'); } catch { jsdomAvailable = false; }
const describeIfJsdom = jsdomAvailable ? describe : describe.skip;

const dashboardPath = fileURLToPath(new URL('../dashboard/dashboard.js', import.meta.url));
const dashboardSource = readFileSync(dashboardPath, 'utf8');
const initBlockPattern = /  loadAll\(\);\s*  connectWs\(\);\s*  \/\/ Fallback polling when WebSocket is disconnected\s*  pollTimer = setInterval\(function \(\) \{\s*    if \(!ws \|\| ws\.readyState !== WebSocket\.OPEN\) \{\s*      loadAll\(\);\s*    \}\s*  \}, POLL_INTERVAL\);\s*\}\)\(\);\s*$/;

function instrumentDashboardSource() {
  const instrumented = dashboardSource.replace(
    initBlockPattern,
    `  globalThis.__dashboardTestHooks = {
    API_HEADERS,
    POLL_INTERVAL,
    el,
    clearNode,
    shortId,
    fmtDate,
    fetchJson,
    postAction,
    statusBadgeEl,
    emptyRow,
    loadStats,
    loadTasks,
    loadProviders,
    loadHosts,
    loadEventHistory,
    connectWs,
    loadAll
  };

  loadAll();
  connectWs();

  // Fallback polling when WebSocket is disconnected
  pollTimer = setInterval(function () {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      loadAll();
    }
  }, POLL_INTERVAL);
})();`
  );

  if (instrumented === dashboardSource) {
    throw new Error('Failed to instrument dashboard.js for tests');
  }

  return instrumented;
}

const instrumentedDashboardSource = instrumentDashboardSource();

function buildDashboardDom() {
  document.body.innerHTML = `
    <div id="runningCount"></div>
    <div id="queuedCount"></div>
    <div id="completedCount"></div>
    <div id="failedCount"></div>
    <div id="sseSubscribersCount"></div>
    <div id="pendingEventsCount"></div>
    <table><tbody id="tasksTableBody"></tbody></table>
    <div id="providersGrid"></div>
    <div id="hostsGrid"></div>
    <div id="formatsGrid"></div>
    <table><tbody id="eventHistoryBody"></tbody></table>
    <div id="statusDot"></div>
    <div id="statusText"></div>
    <div id="outputModal" style="display:none"></div>
    <button id="outputModalClose" type="button"></button>
    <div id="outputTaskId"></div>
    <pre id="outputContent"></pre>
    <table><tbody id="agentsTableBody"></tbody></table>
    <button id="agentsRefreshButton" type="button"></button>
    <form id="agentRegisterForm">
      <input name="id" value="agent-1" />
      <input name="name" value="Test Agent" />
      <input name="host" value="localhost" />
      <input name="port" value="3460" />
      <input name="secret" value="secret" />
    </form>
    <div id="agentRegisterMessage"></div>
    <button id="notificationToggle" type="button"></button>
    <button id="notificationPrefsBtn" type="button"></button>
    <div id="prefsModal" style="display:none"></div>
    <button id="prefsModalClose" type="button"></button>
  `;
}

function createFetchMock(overrides = {}) {
  const defaults = {
    '/api/stats/overview': {
      running: 0,
      queued: 0,
      completed: 0,
      failed: 0,
      sse_subscribers: 0,
      pending_events: 0,
    },
    '/api/providers': [],
    '/api/hosts': [],
    '/api/stats/format-success': [],
    '/api/stats/notifications': {},
    '/api/stats/event-history': [],
    '/api/agents': [],
  };

  return vi.fn((url) => {
    const requestUrl = String(url);
    let payload;

    if (Object.prototype.hasOwnProperty.call(overrides, requestUrl)) {
      payload = overrides[requestUrl];
    } else if (requestUrl.startsWith('/api/tasks?')) {
      payload = { tasks: [] };
    } else if (requestUrl.startsWith('/api/tasks/')) {
      payload = { output: 'task output' };
    } else {
      payload = defaults[requestUrl] ?? {};
    }

    return Promise.resolve({
      json: vi.fn().mockResolvedValue(payload),
    });
  });
}

function createWebSocketMock() {
  function MockWebSocket(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.send = vi.fn();
    this.close = vi.fn();
  }

  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;

  const WebSocketMock = vi.fn(MockWebSocket);
  WebSocketMock.CONNECTING = MockWebSocket.CONNECTING;
  WebSocketMock.OPEN = MockWebSocket.OPEN;
  WebSocketMock.CLOSING = MockWebSocket.CLOSING;
  WebSocketMock.CLOSED = MockWebSocket.CLOSED;
  return WebSocketMock;
}

function loadDashboardModule() {
  delete globalThis.__dashboardTestHooks;
  new Function(instrumentedDashboardSource)();

  if (!globalThis.__dashboardTestHooks) {
    throw new Error('Dashboard test hooks were not initialized');
  }

  return globalThis.__dashboardTestHooks;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describeIfJsdom('dashboard.js client helpers', () => {
  let hooks;
  let fetchMock;

  beforeEach(async () => {
    buildDashboardDom();

    fetchMock = createFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', createWebSocketMock());
    vi.stubGlobal('Notification', {
      requestPermission: vi.fn().mockResolvedValue('granted'),
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(1);

    hooks = loadDashboardModule();
    await flushPromises();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete globalThis.__dashboardTestHooks;
    document.body.innerHTML = '';
  });

  it('el() creates DOM nodes with attributes, text content, and click handlers', () => {
    const handleClick = vi.fn();
    const node = hooks.el('button', {
      className: 'action-button',
      title: 'Run action',
      onclick: handleClick,
      type: 'button',
      'data-role': 'primary',
    }, 'Run');

    expect(node.tagName).toBe('BUTTON');
    expect(node.className).toBe('action-button');
    expect(node.title).toBe('Run action');
    expect(node.type).toBe('button');
    expect(node.getAttribute('data-role')).toBe('primary');
    expect(node.textContent).toBe('Run');

    node.click();
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('clearNode() removes every child from a node', () => {
    const parent = document.createElement('div');
    parent.appendChild(document.createElement('span'));
    parent.appendChild(document.createElement('strong'));
    parent.appendChild(document.createTextNode('text'));

    hooks.clearNode(parent);

    expect(parent.childNodes).toHaveLength(0);
    expect(parent.textContent).toBe('');
  });

  it('shortId() truncates IDs and falls back to "-" for nullish values', () => {
    expect(hooks.shortId('12345678-1234-5678-9abc-def012345678')).toBe('12345678...');
    expect(hooks.shortId(null)).toBe('-');
    expect(hooks.shortId(undefined)).toBe('-');
  });

  it('fmtDate() formats ISO timestamps and returns "-" for null', () => {
    const toLocaleStringSpy = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('mock-locale-date');

    expect(hooks.fmtDate('2026-04-05T12:34:56.000Z')).toBe('mock-locale-date');
    expect(hooks.fmtDate(null)).toBe('-');
    expect(toLocaleStringSpy).toHaveBeenCalled();
  });

  it('statusBadgeEl() builds a status badge span with the expected class name', () => {
    const badge = hooks.statusBadgeEl('completed');

    expect(badge.tagName).toBe('SPAN');
    expect(badge.className).toBe('status-badge status-completed');
    expect(badge.textContent).toBe('completed');
  });

  it('fetchJson() resolves JSON and loadStats() updates dashboard counters', async () => {
    const stats = {
      running: 3,
      queued: 5,
      completed: 8,
      failed: 2,
      sse_subscribers: 9,
      pending_events: 4,
    };

    fetchMock.mockImplementation((url) => Promise.resolve({
      json: vi.fn().mockResolvedValue(
        String(url) === '/api/stats/overview'
          ? stats
          : String(url).startsWith('/api/tasks?')
            ? { tasks: [] }
            : []
      ),
    }));

    const json = await hooks.fetchJson('/api/stats/overview');
    expect(json).toEqual(stats);

    fetchMock.mockClear();
    document.getElementById('runningCount').textContent = '';
    document.getElementById('queuedCount').textContent = '';
    document.getElementById('completedCount').textContent = '';
    document.getElementById('failedCount').textContent = '';
    document.getElementById('sseSubscribersCount').textContent = '';
    document.getElementById('pendingEventsCount').textContent = '';

    hooks.loadStats();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith('/api/stats/overview');
    expect(document.getElementById('runningCount').textContent).toBe('3');
    expect(document.getElementById('queuedCount').textContent).toBe('5');
    expect(document.getElementById('completedCount').textContent).toBe('8');
    expect(document.getElementById('failedCount').textContent).toBe('2');
    expect(document.getElementById('sseSubscribersCount').textContent).toBe('9');
    expect(document.getElementById('pendingEventsCount').textContent).toBe('4');
  });
});
