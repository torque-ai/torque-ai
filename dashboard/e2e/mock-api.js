/**
 * Mock API server for TORQUE dashboard E2E tests.
 *
 * Serves deterministic JSON responses so tests are independent of a live
 * TORQUE backend. Uses Node's built-in http module (no Express dependency).
 *
 * Usage:
 *   import { startMockApi, stopMockApi, MOCK_TASKS } from './mock-api.js';
 *   await startMockApi();   // binds to 127.0.0.1:3456
 *   await stopMockApi();
 */

import http from 'node:http';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

export const MOCK_TASKS = [
  {
    id: 'aaaaaaaa-1111-1111-1111-111111111111',
    status: 'running',
    task_description: 'Generate unit tests for the authentication module',
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    ollama_host_name: null,
    ollama_host_id: null,
    created_at: new Date(Date.now() - 600_000).toISOString(),
    started_at: new Date(Date.now() - 300_000).toISOString(),
    completed_at: null,
    quality_score: null,
    error_output: null,
    retry_count: 0,
    tags: ['tests'],
    output_chunks: ['Running tests...'],
  },
  {
    id: 'bbbbbbbb-2222-2222-2222-222222222222',
    status: 'completed',
    task_description: 'Refactor database connection pooling logic',
    provider: 'ollama',
    model: 'qwen3:8b',
    ollama_host_name: 'local-gpu',
    ollama_host_id: 'host-1',
    created_at: new Date(Date.now() - 7200_000).toISOString(),
    started_at: new Date(Date.now() - 7000_000).toISOString(),
    completed_at: new Date(Date.now() - 6800_000).toISOString(),
    quality_score: 85,
    error_output: null,
    retry_count: 0,
    tags: ['refactor'],
    output_chunks: ['Refactoring complete. 3 files changed.'],
  },
  {
    id: 'cccccccc-3333-3333-3333-333333333333',
    status: 'failed',
    task_description: 'Add XAML data bindings for settings panel',
    provider: 'claude-cli',
    model: null,
    ollama_host_name: null,
    ollama_host_id: null,
    created_at: new Date(Date.now() - 3600_000).toISOString(),
    started_at: new Date(Date.now() - 3500_000).toISOString(),
    completed_at: new Date(Date.now() - 3400_000).toISOString(),
    quality_score: 22,
    error_output: 'TypeScript compilation failed: TS2304 Cannot find name SettingsViewModel',
    retry_count: 1,
    tags: ['xaml', 'ui'],
    output_chunks: ['Build failed with 2 errors.'],
  },
  {
    id: 'dddddddd-4444-4444-4444-444444444444',
    status: 'completed',
    task_description: 'Write documentation for the REST API endpoints',
    provider: 'ollama',
    model: 'gemma3:4b',
    ollama_host_name: 'local-gpu',
    ollama_host_id: 'host-1',
    created_at: new Date(Date.now() - 14400_000).toISOString(),
    started_at: new Date(Date.now() - 14300_000).toISOString(),
    completed_at: new Date(Date.now() - 14000_000).toISOString(),
    quality_score: 78,
    error_output: null,
    retry_count: 0,
    tags: ['docs'],
    output_chunks: ['Documentation generated for 12 endpoints.'],
  },
  {
    id: 'eeeeeeee-5555-5555-5555-555555555555',
    status: 'queued',
    task_description: 'Optimize webpack bundle size for production build',
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    ollama_host_name: null,
    ollama_host_id: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    started_at: null,
    completed_at: null,
    quality_score: null,
    error_output: null,
    retry_count: 0,
    tags: ['perf'],
    output_chunks: [],
  },
];

const MOCK_OVERVIEW = {
  today: { total: 23, completed: 18, failed: 3, successRate: 78 },
  yesterday: { total: 19, completed: 15, failed: 2 },
  active: { running: 1, queued: 1 },
};

const MOCK_PROVIDERS = [
  { id: 'codex', name: 'Codex', enabled: true, tasks_completed: 150, tasks_failed: 8, avg_duration: 45 },
  { id: 'ollama', name: 'Ollama', enabled: true, tasks_completed: 320, tasks_failed: 12, avg_duration: 62 },
  { id: 'claude-cli', name: 'Claude CLI', enabled: true, tasks_completed: 55, tasks_failed: 5, avg_duration: 90 },
  { id: 'deepinfra', name: 'DeepInfra', enabled: false, tasks_completed: 0, tasks_failed: 0, avg_duration: 0 },
];

const MOCK_HOSTS = [
  {
    id: 'host-1',
    name: 'local-gpu',
    url: 'http://localhost:11434',
    enabled: true,
    status: 'online',
    gpu: 'RTX 4060',
    vram_mb: 8192,
    running_tasks: 1,
    max_concurrent: 3,
    models: ['gemma3:4b', 'qwen3:8b'],
  },
  {
    id: 'host-2',
    name: 'remote-gpu-host',
    url: 'http://192.168.1.100:11434',
    enabled: true,
    status: 'online',
    gpu: 'RTX 3090',
    vram_mb: 24576,
    running_tasks: 0,
    max_concurrent: 2,
    models: ['qwen2.5-coder:32b', 'codestral:22b'],
  },
];

const MOCK_TIMESERIES = [
  { date: new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10), completed: 12, failed: 2 },
  { date: new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10), completed: 15, failed: 1 },
  { date: new Date(Date.now() - 4 * 86400_000).toISOString().slice(0, 10), completed: 8, failed: 3 },
  { date: new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10), completed: 20, failed: 0 },
  { date: new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10), completed: 18, failed: 2 },
  { date: new Date(Date.now() - 1 * 86400_000).toISOString().slice(0, 10), completed: 15, failed: 2 },
  { date: new Date().toISOString().slice(0, 10), completed: 18, failed: 3 },
];

const MOCK_QUALITY = {
  overall: { avgScore: 74, totalScored: 40 },
};

const MOCK_STUCK = {
  totalNeedsAttention: 0,
  longRunning: { tasks: [] },
  pendingApproval: { tasks: [] },
  pendingSwitch: { tasks: [] },
};

const MOCK_HOST_ACTIVITY = {
  hosts: {
    'host-1': { gpuMetrics: { vramUsedMb: 3200, vramTotalMb: 8192 } },
    'host-2': { gpuMetrics: { vramUsedMb: 6400, vramTotalMb: 24576 } },
  },
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

let cancelledTaskIds = new Set();

function route(method, pathname, query) {
  // V2 routes use /api/v2/* and return { data: ... } envelope
  // Legacy /api/* routes are kept for backward compatibility

  // -- Tasks (v2) --
  if (method === 'GET' && pathname === '/api/v2/tasks') {
    let filtered = [...MOCK_TASKS];
    if (query.status) {
      filtered = filtered.filter((t) => t.status === query.status);
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      filtered = filtered.filter((t) => (t.task_description || '').toLowerCase().includes(q));
    }
    return {
      data: {
        items: filtered,
        total: filtered.length,
      },
      meta: { page: 1, totalPages: 1 },
    };
  }

  const v2TaskMatch = pathname.match(/^\/api\/v2\/tasks\/([^/]+)$/);
  if (method === 'GET' && v2TaskMatch) {
    const id = v2TaskMatch[1];
    const task = MOCK_TASKS.find((t) => t.id === id);
    if (task) return { data: { ...task } };
    return { __status: 404, error: { code: 'NOT_FOUND', message: 'Task not found' } };
  }

  const v2TaskDiffMatch = pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/diff$/);
  if (method === 'GET' && v2TaskDiffMatch) {
    return { data: { diff_content: null, files_changed: 0, lines_added: 0, lines_removed: 0 } };
  }

  const v2TaskLogsMatch = pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/logs$/);
  if (method === 'GET' && v2TaskLogsMatch) {
    return { data: [] };
  }

  const v2TaskCancelMatch = pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/cancel$/);
  if (method === 'POST' && v2TaskCancelMatch) {
    cancelledTaskIds.add(v2TaskCancelMatch[1]);
    return { data: { success: true } };
  }

  const v2TaskRetryMatch = pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/retry$/);
  if (method === 'POST' && v2TaskRetryMatch) {
    return { data: { success: true } };
  }

  // -- Stats (v2) --
  if (method === 'GET' && pathname === '/api/v2/stats/overview') {
    return { data: MOCK_OVERVIEW };
  }
  if (method === 'GET' && pathname === '/api/v2/stats/timeseries') {
    return { data: { series: MOCK_TIMESERIES } };
  }
  if (method === 'GET' && pathname === '/api/v2/stats/quality') {
    return { data: MOCK_QUALITY };
  }
  if (method === 'GET' && pathname === '/api/v2/stats/stuck') {
    return { data: MOCK_STUCK };
  }
  if (method === 'GET' && pathname === '/api/v2/stats/models') {
    return { data: { items: [] } };
  }
  if (method === 'GET' && pathname === '/api/v2/stats/format-success') {
    return { data: { items: [] } };
  }

  // -- Providers (v2) --
  if (method === 'GET' && pathname === '/api/v2/providers') {
    return { data: { items: MOCK_PROVIDERS } };
  }
  const v2ProviderStatsMatch = pathname.match(/^\/api\/v2\/providers\/([^/]+)\/stats$/);
  if (method === 'GET' && v2ProviderStatsMatch) {
    return { data: { completed: 50, failed: 2, avg_duration: 45 } };
  }
  if (method === 'GET' && pathname === '/api/v2/providers/trends') {
    return { data: { items: [] } };
  }

  // -- Hosts (v2) --
  if (method === 'GET' && pathname === '/api/v2/hosts') {
    return { data: { items: MOCK_HOSTS } };
  }
  if (method === 'GET' && pathname === '/api/v2/hosts/activity') {
    return { data: MOCK_HOST_ACTIVITY };
  }

  // -- Budget (v2) --
  if (method === 'GET' && pathname === '/api/v2/budget/summary') {
    return { data: { totalCost: 4.52, providers: {} } };
  }
  if (method === 'GET' && pathname === '/api/v2/budget/status') {
    return { data: { budget: 50, spent: 4.52, remaining: 45.48 } };
  }

  // -- Workflows (v2) --
  if (method === 'GET' && pathname === '/api/v2/workflows') {
    return { data: { items: [], total: 0 } };
  }

  // -- Plan Projects (v2) --
  if (method === 'GET' && pathname === '/api/v2/plan-projects') {
    return { data: { items: [], total: 0 } };
  }

  // -- System (v2) --
  if (method === 'GET' && pathname === '/api/v2/system/status') {
    return { data: { status: 'ok', uptime: 3600 } };
  }

  // -- Tuning (v2) --
  if (method === 'GET' && pathname === '/api/v2/tuning') {
    return { data: { items: [] } };
  }

  // -- Schedules (v2) --
  if (method === 'GET' && pathname === '/api/v2/schedules') {
    return { data: { items: [] } };
  }

  // -- Approvals (v2) --
  if (method === 'GET' && pathname === '/api/v2/approvals') {
    return { data: { items: [] } };
  }

  // -- Peek Hosts (v2) --
  if (method === 'GET' && pathname === '/api/v2/peek-hosts') {
    return { data: { items: [] } };
  }

  // -- Instances (v2) --
  if (method === 'GET' && pathname === '/api/v2/instances') {
    return { data: { items: [] } };
  }

  // -- Benchmarks (v2) --
  if (method === 'GET' && pathname === '/api/v2/benchmarks') {
    return { data: { items: [] } };
  }

  // ======================================================================
  // Legacy /api/* routes (kept for backward compatibility)
  // ======================================================================

  // -- Tasks --
  if (method === 'GET' && pathname === '/api/tasks') {
    let filtered = [...MOCK_TASKS];
    if (query.status) {
      filtered = filtered.filter((t) => t.status === query.status);
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      filtered = filtered.filter((t) => (t.task_description || '').toLowerCase().includes(q));
    }
    return {
      tasks: filtered,
      pagination: { page: 1, totalPages: 1, total: filtered.length, limit: 25 },
    };
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (method === 'GET' && taskMatch) {
    const id = taskMatch[1];
    const task = MOCK_TASKS.find((t) => t.id === id);
    if (task) return { ...task };
    return { __status: 404, error: 'Task not found' };
  }

  const cancelMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancelMatch) {
    cancelledTaskIds.add(cancelMatch[1]);
    return { success: true };
  }

  const retryMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/);
  if (method === 'POST' && retryMatch) {
    return { success: true };
  }

  const logsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/logs$/);
  if (method === 'GET' && logsMatch) {
    return [];
  }

  const diffMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/diff$/);
  if (method === 'GET' && diffMatch) {
    return { diff_content: null, files_changed: 0, lines_added: 0, lines_removed: 0 };
  }

  // -- Stats --
  if (method === 'GET' && pathname === '/api/stats/overview') {
    return MOCK_OVERVIEW;
  }
  if (method === 'GET' && pathname === '/api/stats/timeseries') {
    return MOCK_TIMESERIES;
  }
  if (method === 'GET' && pathname === '/api/stats/quality') {
    return MOCK_QUALITY;
  }
  if (method === 'GET' && pathname === '/api/stats/stuck') {
    return MOCK_STUCK;
  }
  if (method === 'GET' && pathname === '/api/stats/models') {
    return [];
  }

  // -- Providers --
  if (method === 'GET' && pathname === '/api/providers') {
    return MOCK_PROVIDERS;
  }
  const providerStatsMatch = pathname.match(/^\/api\/providers\/([^/]+)\/stats$/);
  if (method === 'GET' && providerStatsMatch) {
    return { completed: 50, failed: 2, avg_duration: 45 };
  }
  if (method === 'GET' && pathname === '/api/providers/trends') {
    return [];
  }

  // -- Hosts --
  if (method === 'GET' && pathname === '/api/hosts') {
    return MOCK_HOSTS;
  }
  if (method === 'GET' && pathname === '/api/hosts/activity') {
    return MOCK_HOST_ACTIVITY;
  }

  // -- Budget --
  if (method === 'GET' && pathname === '/api/budget/summary') {
    return { totalCost: 4.52, providers: {} };
  }
  if (method === 'GET' && pathname === '/api/budget/status') {
    return { budget: 50, spent: 4.52, remaining: 45.48 };
  }

  // -- Workflows --
  if (method === 'GET' && pathname === '/api/workflows') {
    return { workflows: [], pagination: { page: 1, totalPages: 1, total: 0 } };
  }

  // -- Plan Projects --
  if (method === 'GET' && pathname === '/api/plan-projects') {
    return { projects: [], pagination: { page: 1, totalPages: 1, total: 0 } };
  }

  // -- Instances --
  if (method === 'GET' && pathname === '/api/instances') {
    return [];
  }

  // -- System --
  if (method === 'GET' && pathname === '/api/system/status') {
    return { status: 'ok', uptime: 3600 };
  }

  // -- Fallback --
  return { __status: 404, error: `Not found: ${method} ${pathname}` };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server = null;

export function startMockApi(port = 3456) {
  return new Promise((resolve, reject) => {
    cancelledTaskIds = new Set();

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const query = Object.fromEntries(url.searchParams.entries());

      // Collect body for POST
      let _body = '';
      req.on('data', (chunk) => { _body += chunk; });
      req.on('end', () => {
        const result = route(req.method, url.pathname, query);
        const status = result?.__status || 200;
        const payload = { ...result };
        delete payload.__status;

        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end(JSON.stringify(payload));
      });

      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log(`Mock API server listening on http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

export function stopMockApi() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => {
      server = null;
      resolve();
    });
  });
}

export { cancelledTaskIds };
