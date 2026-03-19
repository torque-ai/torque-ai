/**
 * API client for TORQUE dashboard
 *
 * Endpoints are gradually migrating from legacy /api/* to /api/v2/* control-plane routes.
 * The requestV2() helper transparently unwraps v2 envelope responses so components
 * continue to receive the same data shapes.
 */

const API_BASE = '/api';
const V2_BASE = '/api/v2';

const DEFAULT_TIMEOUT = 15000;

/**
 * Generic fetch wrapper with error handling and timeout
 */
export async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  return _fetch(url, options);
}

/**
 * V2 fetch wrapper — calls /api/v2 endpoints and unwraps the envelope.
 *
 * V2 success responses: { data: {...}, meta: {...} } → returns data
 * V2 list responses:    { data: { items: [...], total }, meta } → returns { items, total }
 * V2 error responses:   { error: { code, message }, meta } → throws with message
 */
export async function requestV2(endpoint, options = {}) {
  const url = `${V2_BASE}${endpoint}`;
  const raw = await _fetch(url, options);

  // Unwrap v2 envelope
  if (raw && typeof raw === 'object') {
    // Error envelope
    if (raw.error && raw.error.message) {
      throw new Error(raw.error.message);
    }
    // Success envelope — return the data payload
    if ('data' in raw) {
      return raw.data;
    }
  }

  return raw;
}

async function _fetch(url, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, signal: externalSignal, ...fetchOptions } = options;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const isMutatingMethod = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
  const hasFormDataBody = typeof FormData !== 'undefined' && fetchOptions.body instanceof FormData;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let removeExternalAbortListener = null;
  let composedSignal = controller.signal;

  if (externalSignal) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      composedSignal = AbortSignal.any([controller.signal, externalSignal]);
    } else if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else if (typeof externalSignal.addEventListener === 'function') {
      const forwardAbort = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
      removeExternalAbortListener = () => {
        externalSignal.removeEventListener?.('abort', forwardAbort);
      };
    }
  }

  try {
    const response = await fetch(url, {
      headers: {
        ...(hasFormDataBody ? {} : { 'Content-Type': 'application/json' }),
        ...(isMutatingMethod ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
        ...fetchOptions.headers,
      },
      signal: composedSignal,
      ...fetchOptions,
    });

    // Handle 204 No Content and empty responses
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {};
    }

    let data;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        data = await response.json();
      } catch {
        throw new Error(`Invalid JSON response (HTTP ${response.status})`);
      }
    } else {
      // Non-JSON response — read as text for error context
      const text = await response.text();
      if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
      return { text };
    }

    if (!response.ok) {
      // V2 error envelope
      if (data.error && typeof data.error === 'object') {
        throw new Error(data.error.message || `HTTP ${response.status}`);
      }
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    removeExternalAbortListener?.();
  }
}

// ─── Task endpoints (v2 for list/get/diff/logs/retry/submit) ────────────────

export const tasks = {
  list: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return requestV2(`/tasks${query ? `?${query}` : ''}`).then(d => ({
      tasks: d.items || [],
      total: d.total || 0,
      pagination: {
        page: Number(params.page) || 1,
        limit: Number(params.limit) || 50,
        total: d.total || 0,
      },
    }));
  },
  get: (id) => requestV2(`/tasks/${id}`),
  diff: (id) => requestV2(`/tasks/${id}/diff`),
  retry: (id) => requestV2(`/tasks/${id}/retry`, { method: 'POST' }),
  reassignProvider: (id, provider) => requestV2(`/tasks/${id}/provider`, {
    method: 'PATCH',
    body: JSON.stringify({ provider }),
  }),
  cancel: (id) => request(`/tasks/${id}/cancel`, { method: 'POST' }),
  approveSwitch: (id) => requestV2(`/tasks/${id}/approve-switch`, { method: 'POST' }),
  rejectSwitch: (id) => requestV2(`/tasks/${id}/reject-switch`, { method: 'POST' }),
  submit: (data) => requestV2('/tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
};

// ─── Provider endpoints (v2 for list/stats/trends/toggle) ───────────────────

export const providers = {
  list: () => requestV2('/providers').then(d => d.items || d),
  stats: (id, days = 7) => requestV2(`/providers/${id}/stats?days=${days}`),
  trends: (days = 7) => requestV2(`/providers/trends?days=${days}`),
  percentiles: (id, days = 7) => request(`/providers/${id}/percentiles?days=${days}`),
  toggle: (id, enabled) => requestV2(`/providers/${id}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  }),
  setApiKey: (provider, apiKey, opts = {}) =>
    requestV2(`/providers/${encodeURIComponent(provider)}/api-key`, { method: 'PUT', body: JSON.stringify({ api_key: apiKey }), ...opts }),
  clearApiKey: (provider, opts = {}) =>
    requestV2(`/providers/${encodeURIComponent(provider)}/api-key`, { method: 'DELETE', ...opts }),
};

// ─── Stats endpoints (all v2) ───────────────────────────────────────────────

export const stats = {
  overview: () => requestV2('/stats/overview'),
  timeseries: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return requestV2(`/stats/timeseries${query ? `?${query}` : ''}`).then(d => d.series || d);
  },
  quality: (hours = 24) => requestV2(`/stats/quality?hours=${hours}`),
  stuck: () => requestV2('/stats/stuck'),
  models: (days = 7) => requestV2(`/stats/models?days=${days}`),
  formatSuccess: () => requestV2(`/stats/format-success`),
};

// ─── Plan Project endpoints (all v2) ────────────────────────────────────────

export const planProjects = {
  list: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return requestV2(`/plan-projects${query ? `?${query}` : ''}`).then((d) =>
      unwrapListPayload(d, 'projects')
    );
  },
  get: (id) => requestV2(`/plan-projects/${id}`),
  import: (data) => requestV2('/plan-projects/import', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  pause: (id) => requestV2(`/plan-projects/${id}/pause`, { method: 'POST' }),
  resume: (id) => requestV2(`/plan-projects/${id}/resume`, { method: 'POST' }),
  retry: (id) => requestV2(`/plan-projects/${id}/retry`, { method: 'POST' }),
  delete: (id) => requestV2(`/plan-projects/${id}`, { method: 'DELETE' }),
};

// ─── Host endpoints (v2 for list/get/toggle/scan/remove) ────────────────────

export const hosts = {
  list: () => requestV2('/hosts').then(d => d.items || d),
  get: (id) => requestV2(`/hosts/${id}`),
  activity: (options) => request('/hosts/activity', options),
  toggle: (id, enabled) => requestV2(`/hosts/${id}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  }),
  scan: () => requestV2('/hosts/scan', { method: 'POST', timeout: 30000 }),
  remove: (id) => requestV2(`/hosts/${id}`, { method: 'DELETE' }),
};

// --- Concurrency endpoints (v2) ---

export const concurrency = {
  get: () => requestV2('/concurrency'),
  set: (data) => requestV2('/concurrency/set', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
};

export const workstations = {
  list: () => requestV2('/workstations').then(d => d.items || d),
  add: (data) => requestV2('/workstations', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  remove: (name) => requestV2(`/workstations/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  }),
  probe: (name) => requestV2(`/workstations/${encodeURIComponent(name)}/probe`, {
    method: 'POST',
  }),
};

// ─── Model registry endpoints (v2) ──────────────────────────────────────────

export const models = {
  list: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return requestV2(`/models${query ? '?' + query : ''}`);
  },
  pending: () => requestV2('/models/pending'),
  approve: (provider, modelName) => requestV2('/models/approve', {
    method: 'POST', body: JSON.stringify({ provider, model_name: modelName }),
  }),
  deny: (provider, modelName) => requestV2('/models/deny', {
    method: 'POST', body: JSON.stringify({ provider, model_name: modelName }),
  }),
  bulkApprove: (provider) => requestV2('/models/bulk-approve', {
    method: 'POST', body: JSON.stringify({ provider }),
  }),
  leaderboard: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return requestV2(`/providers/get-model-leaderboard${query ? '?' + query : ''}`);
  },
};

// ─── Provider CRUD endpoints (v2) ───────────────────────────────────────────

export const providerCrud = {
  add: (data) => requestV2('/providers/add', { method: 'POST', body: JSON.stringify(data) }),
  remove: (provider, confirm) => requestV2('/providers/remove', {
    method: 'POST', body: JSON.stringify({ provider, confirm }),
  }),
};

// ─── Peek host endpoints (v2 for list/create/delete/toggle) ─────────────────

export const peekHosts = {
  list: () => requestV2('/peek-hosts').then(d => d.items || d),
  create: (data) => requestV2('/peek-hosts', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  // TODO: migrate to requestV2 for consistency
  update: (name, data) => request(`/peek-hosts/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  toggle: (name, enabled) => requestV2(`/peek-hosts/${encodeURIComponent(name)}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  }),
  remove: (name) => requestV2(`/peek-hosts/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  }),
  // TODO: migrate to requestV2 for consistency
  test: (name) => request(`/peek-hosts/${encodeURIComponent(name)}/test`, {
    method: 'POST',
  }),
  credentials: (name) => requestV2(`/hosts/${encodeURIComponent(name)}/credentials`).then(d => d.items || d),
  saveCredential: (name, type, value, label) => requestV2(`/hosts/${encodeURIComponent(name)}/credentials/${type}`, {
    method: 'PUT',
    body: JSON.stringify({ value, label }),
  }),
  deleteCredential: (name, type) => requestV2(`/hosts/${encodeURIComponent(name)}/credentials/${type}`, {
    method: 'DELETE',
  }),
  // TODO: migrate to requestV2 for consistency
  testCredential: (name, type) => request(`/hosts/${encodeURIComponent(name)}/credentials/${type}/test`, {
    method: 'POST',
  }),
};

// ─── Budget endpoints (all v2) ──────────────────────────────────────────────

export const budget = {
  summary: (days = 30) => requestV2(`/budget/summary?days=${days}`),
  status: () => requestV2('/budget/status'),
  set: (data) => requestV2('/budget', { method: 'POST', body: JSON.stringify(data) }),
  forecast: (days = 30) => requestV2(`/validation/get-cost-forecast?days=${days}`),
};

// ─── Schedule endpoints (all v2) ────────────────────────────────────────────

export const schedules = {
  list: () => requestV2('/schedules').then((d) => {
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.items)) return d.items;
    if (Array.isArray(d?.schedules)) return d.schedules;
    return [];
  }),
  create: (data) => requestV2('/schedules', { method: 'POST', body: JSON.stringify(data) }),
  toggle: (id, enabled) => requestV2(`/schedules/${id}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  }),
  delete: (id) => requestV2(`/schedules/${id}`, { method: 'DELETE' }),
};

// ─── Task logs (v2) ─────────────────────────────────────────────────────────

export const taskLogs = {
  get: (id) => requestV2(`/tasks/${id}/logs`),
};

// ─── System status (v2) ─────────────────────────────────────────────────────

export const system = {
  status: () => requestV2('/system/status'),
};

// ─── Instance discovery (legacy — no v2 equivalent) ─────────────────────────

export const instances = {
  list: (options) => request('/instances', options),
};

// ─── Project tuning (v2 — note: v2 uses /tuning not /project-tuning) ───────

export const projectTuning = {
  list: () => requestV2('/tuning').then(d => d.items || d),
  get: (projectPath) => request(`/project-tuning/${encodeURIComponent(projectPath)}`),
  set: (projectPath, settings, description) => requestV2('/tuning', {
    method: 'POST',
    body: JSON.stringify({ projectPath, settings, description }),
  }),
  delete: (projectPath) => requestV2(`/tuning/${encodeURIComponent(projectPath)}`, {
    method: 'DELETE',
  }),
};

// ─── Workflow endpoints (v2 for list/get/history) ───────────────────────────

export const workflows = {
  list: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return requestV2(`/workflows${query ? `?${query}` : ''}`).then(d => d.items || d);
  },
  get: (id) => requestV2(`/workflows/${id}`),
  tasks: (id) => request(`/workflows/${id}/tasks`),
  history: (id) => requestV2(`/workflows/${id}/history`),
};

// ─── Benchmarks (v2) ────────────────────────────────────────────────────────

export const benchmarks = {
  get: (hostId, limit = 10) => requestV2(`/benchmarks?hostId=${hostId}&limit=${limit}`).then(d => d.items || d),
  apply: (hostId, model) => requestV2('/benchmarks/apply', {
    method: 'POST',
    body: JSON.stringify({ hostId, model }),
  }),
};

// ─── Approvals (v2 — consolidated approve/reject into decide) ───────────────

export const approvals = {
  listPending: () => requestV2('/approvals').then(d => d.items || d),
  getHistory: (limit = 50) => requestV2(`/approvals?status=all&limit=${limit}`).then(d => d.items || d),
  approve: (id) => requestV2(`/approvals/${id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved' }),
  }),
  reject: (id) => requestV2(`/approvals/${id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'rejected' }),
  }),
};

// ─── Coordination (legacy — no v2 equivalent) ──────────────────────────────

export const coordination = {
  getDashboard: (hours = 24) => request(`/coordination?hours=${hours}`),
  listAgents: () => request('/coordination/agents'),
  listRules: () => request('/coordination/rules'),
  listClaims: () => request('/coordination/claims'),
};

// ─── Free-tier quota status (legacy — no v2 equivalent yet) ─────────────────

const LEGACY_FREE_TIER_BASE = `/${['free', 'tier'].join('-')}`;

export const freeTier = {
  status: () => request(`${LEGACY_FREE_TIER_BASE}/status`),
  history: (days = 7) => request(`${LEGACY_FREE_TIER_BASE}/history?days=${days}`),
};

// ─── Strategic Brain (v2 for status/decisions/provider-health) ──────────────

function unwrapListPayload(data, ...keys) {
  if (Array.isArray(data)) return data;

  for (const key of keys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }

  return Array.isArray(data?.items) ? data.items : [];
}

export const strategic = {
  status: () => requestV2('/strategic/status'),
  operations: (limit = 20) => request(`/strategic/operations?limit=${limit}`),
  decisions: (limit = 50) => requestV2(`/strategic/decisions?limit=${limit}`).then(d => unwrapListPayload(d, 'decisions')),
  providerHealth: () => requestV2('/strategic/provider-health').then(d => unwrapListPayload(d, 'providers')),
  getConfig: (opts = {}) => requestV2('/strategic/config', opts),
  setConfig: (data, opts = {}) => requestV2('/strategic/config', { method: 'PUT', body: JSON.stringify(data), ...opts }),
  resetConfig: (opts = {}) => requestV2('/strategic/config/reset', { method: 'POST', ...opts }),
  listConfigTemplates: (opts = {}) => requestV2('/strategic/templates', opts),
  testCapability: (capability, data, opts = {}) => requestV2(`/strategic/test/${capability}`, { method: 'POST', body: JSON.stringify(data), ...opts }),
};

// ─── Routing Templates (v2) ──────────────────────────────────────────────────

export const routingTemplates = {
  list: (opts = {}) => requestV2('/routing/templates', opts),
  get: (id, opts = {}) => requestV2(`/routing/templates/${id}`, opts),
  create: (data, opts = {}) => requestV2('/routing/templates', { method: 'POST', body: JSON.stringify(data), ...opts }),
  update: (id, data, opts = {}) => requestV2(`/routing/templates/${id}`, { method: 'PUT', body: JSON.stringify(data), ...opts }),
  remove: (id, opts = {}) => requestV2(`/routing/templates/${id}`, { method: 'DELETE', ...opts }),
  getActive: (opts = {}) => requestV2('/routing/active', opts),
  setActive: (data, opts = {}) => requestV2('/routing/active', { method: 'PUT', body: JSON.stringify(data), ...opts }),
  categories: (opts = {}) => requestV2('/routing/categories', opts),
};

export default { tasks, providers, stats, planProjects, hosts, peekHosts, budget, schedules, taskLogs, system, instances, projectTuning, benchmarks, workflows, approvals, coordination, strategic, routingTemplates };
