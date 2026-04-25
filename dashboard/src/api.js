/**
 * API client for TORQUE dashboard
 *
 * Endpoints are gradually migrating from legacy /api/* to /api/v2/* control-plane routes.
 * The requestV2() helper transparently unwraps v2 envelope responses so components
 * continue to receive the same data shapes.
 */

const V2_BASE = '/api/v2';

const DEFAULT_TIMEOUT = 15000;

function buildQuery(params = {}) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        query.append(key, item);
      }
      continue;
    }

    query.append(key, value);
  }

  const qs = query.toString();
  return qs ? `?${qs}` : '';
}

export function getCsrfToken() {
  if (window.__torqueCsrf) return window.__torqueCsrf;
  // Fallback: read from the non-HttpOnly torque_csrf cookie
  const match = document.cookie.split(';').find(c => c.trim().startsWith('torque_csrf='));
  return match ? match.split('=')[1]?.trim() : '';
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
        ...(isMutatingMethod ? { 'X-Requested-With': 'XMLHttpRequest', ...(() => { const t = getCsrfToken(); return t ? { 'X-CSRF-Token': t } : {}; })() } : {}),
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
      if (externalSignal?.aborted) throw err; // re-throw as AbortError for external signals
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
  list: (params = {}, options = {}) => {
    const query = new URLSearchParams(params).toString();
    return requestV2(`/tasks${query ? `?${query}` : ''}`, options).then(d => ({
      tasks: d.items || [],
      total: d.total || 0,
      pagination: {
        page: Number(params.page) || 1,
        limit: Number(params.limit) || 50,
        total: d.total || 0,
      },
    }));
  },
  // Batched Kanban board data — one round-trip for all 7 status buckets.
  // Returns { <status>: { tasks: [...], total: N }, ... } shape so callers
  // can spread each bucket's tasks into state the same way they handle
  // individual list() responses.
  kanbanSummary: (options = {}) => {
    return requestV2('/tasks/kanban-summary', options).then(d => {
      const buckets = (d && d.buckets) || {};
      const pick = (key) => ({
        tasks: (buckets[key] && Array.isArray(buckets[key].items)) ? buckets[key].items : [],
        total: (buckets[key] && buckets[key].total) || 0,
      });
      return {
        pending_approval: pick('pending_approval'),
        queued: pick('queued'),
        running: pick('running'),
        pending_provider_switch: pick('pending_provider_switch'),
        completed: pick('completed'),
        failed: pick('failed'),
        cancelled: pick('cancelled'),
      };
    });
  },
  get: (id) => requestV2(`/tasks/${id}`),
  listArtifacts: (id) => requestV2(`/tasks/${id}/artifacts`),
  getArtifact: (artifactId) => requestV2(`/tasks/artifacts/${artifactId}`),
  promoteArtifact: (artifactId, destPath) => requestV2(`/tasks/artifacts/${artifactId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ dest_path: destPath }),
  }),
  getArtifactContentUrl: (artifactId) => `${V2_BASE}/tasks/artifacts/${encodeURIComponent(artifactId)}/content`,
  diff: (id) => requestV2(`/tasks/${id}/diff`),
  retry: (id) => requestV2(`/tasks/${id}/retry`, { method: 'POST' }),
  reassignProvider: (id, provider) => requestV2(`/tasks/${id}/provider`, {
    method: 'PATCH',
    body: JSON.stringify({ provider }),
  }),
  cancel: (id) => requestV2(`/tasks/${id}/cancel`, { method: 'POST' }),
  approve: (id) => requestV2(`/tasks/${id}/approve`, { method: 'POST' }),
  reject: (id) => requestV2(`/tasks/${id}/reject`, { method: 'POST' }),
  approveBatch: (batchIdOrData, taskIds = []) => requestV2('/tasks/approve-batch', {
    method: 'POST',
    body: JSON.stringify(
      typeof batchIdOrData === 'string'
        ? {
            batch_id: batchIdOrData,
            ...(Array.isArray(taskIds) && taskIds.length > 0 ? { task_ids: taskIds } : {}),
          }
        : batchIdOrData
    ),
  }),
  approveSwitch: (id) => requestV2(`/tasks/${id}/approve-switch`, { method: 'POST' }),
  rejectSwitch: (id) => requestV2(`/tasks/${id}/reject-switch`, { method: 'POST' }),
  previewStudyContext: (data, options = {}) => requestV2('/tasks/preview-study-context', {
    method: 'POST',
    body: JSON.stringify(data),
    ...options,
  }),
  submit: (data) => requestV2('/tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
};

// ─── Provider endpoints (v2 for list/stats/trends/toggle) ───────────────────

const setProviderApiKey = (provider, apiKey, opts = {}) =>
  requestV2(`/providers/${encodeURIComponent(provider)}/api-key`, {
    method: 'PUT',
    body: JSON.stringify({ api_key: apiKey }),
    ...opts,
  });

const clearProviderApiKey = (provider, opts = {}) =>
  requestV2(`/providers/${encodeURIComponent(provider)}/api-key`, {
    method: 'DELETE',
    ...opts,
  });

export const providers = {
  list: () => requestV2('/providers').then(d => d.items || d.providers || d),
  stats: (id, days = 7) => requestV2(`/providers/${id}/stats?days=${days}`),
  trends: (days = 7) => requestV2(`/providers/trends?days=${days}`),
  percentiles: (id, days = 7) => requestV2(`/providers/${id}/percentiles?days=${days}`),
  toggle: (id, enabled) => requestV2(`/providers/${id}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  }),
  setApiKey: setProviderApiKey,
  clearApiKey: clearProviderApiKey,
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
  activity: (options) => requestV2('/hosts/activity', options),
  toggle: (id, enabled) => requestV2(`/hosts/${id}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  }),
  update: (id, data) => requestV2(`/hosts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  }),
  scan: () => requestV2('/hosts/scan', { method: 'POST', timeout: 120000 }),
  remove: (id) => requestV2(`/hosts/${id}`, { method: 'DELETE' }),
};

// --- Concurrency endpoints (v2) ---

export const concurrency = {
  get: () => requestV2('/concurrency'),
  set: (data) => requestV2('/concurrency/set', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  setLimit: (data) => requestV2('/concurrency/limit', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  removeLimit: (pattern) => requestV2(`/concurrency/limit/${encodeURIComponent(pattern)}`, {
    method: 'DELETE',
  }),
};

export const workstations = {
  list: () => requestV2('/workstations').then(d => d.items || d),
  add: (data) => requestV2('/workstations', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  toggle: (name, enabled) => requestV2(`/workstations/${encodeURIComponent(name)}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
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
  setApiKey: setProviderApiKey,
  clearApiKey: clearProviderApiKey,
};

// ─── Peek host endpoints (v2 for list/create/delete/toggle) ─────────────────

export const peekHosts = {
  list: () => requestV2('/peek-hosts').then(d => d.items || d),
  create: (data) => requestV2('/peek-hosts', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  update: (name, data) => requestV2(`/peek-hosts/${encodeURIComponent(name)}`, {
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
  test: (name) => requestV2(`/peek-hosts/${encodeURIComponent(name)}/test`, {
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
  testCredential: (name, type) => requestV2(`/hosts/${encodeURIComponent(name)}/credentials/${type}/test`, {
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
  run: (id) => requestV2(`/schedules/${id}/run`, {
    method: 'POST',
  }),
  toggle: (id, enabled) => requestV2(`/schedules/${id}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  }),
  delete: (id) => requestV2(`/schedules/${id}`, { method: 'DELETE' }),
  get: (id) => requestV2(`/schedules/${id}`),
  getRun: (scheduleId, runId) => requestV2(`/schedules/${scheduleId}/runs/${runId}`),
  update: (id, data) => requestV2(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
};

export const study = {
  run: (data) => requestV2('/study/run', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  status: (params = {}) => requestV2(`/study/status${buildQuery(params)}`),
  getProfileOverride: (params = {}) => requestV2(`/study/profile-override${buildQuery(params)}`),
  saveProfileOverride: (data) => requestV2('/study/profile-override', {
    method: 'PATCH',
    body: JSON.stringify(data),
  }),
  deleteProfileOverride: (data) => requestV2('/study/profile-override', {
    method: 'PATCH',
    body: JSON.stringify({ ...data, clear: true }),
  }),
  evaluate: (data) => requestV2('/study/evaluate', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  benchmark: (data) => requestV2('/study/benchmark', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  preview: (data) => requestV2('/study/preview', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  bootstrap: (data) => requestV2('/study/bootstrap', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  reset: (data) => requestV2('/study/reset', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  schedule: (data) => requestV2('/study/schedule', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
};

// ─── Task logs (v2) ─────────────────────────────────────────────────────────

export const taskLogs = {
  get: (id) => requestV2(`/tasks/${id}/logs`),
};

// ─── System status (v2) ─────────────────────────────────────────────────────

export const system = {
  status: () => requestV2('/system/status'),
};

// ─── Instance discovery (v2 passthrough) ────────────────────────────────────

export const instances = {
  list: (options) => requestV2('/instances', options),
};

// ─── Project tuning (v2, with passthrough for get) ──────────────────────────

export const projectTuning = {
  list: () => requestV2('/tuning').then(d => d.items || d),
  get: (projectPath) => requestV2(`/project-tuning/${encodeURIComponent(projectPath)}`),
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
  tasks: (id) => requestV2(`/workflows/${id}/tasks`),
  history: (id) => requestV2(`/workflows/${id}/history`),
  checkpoints: (id, options = {}) => requestV2(`/workflows/${id}/checkpoints`, options),
  fork: (id, data, options = {}) => requestV2(`/workflows/${id}/fork`, {
    method: 'POST',
    body: JSON.stringify(data),
    ...options,
  }),
};

// ─── Workflow spec endpoints (v2) ──────────────────────────────────────────

export const workflowSpecs = {
  list: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return requestV2(`/workflow-specs${query ? `?${query}` : ''}`);
  },
  validate: (spec_path, working_directory) => requestV2('/workflow-specs/validate', {
    method: 'POST',
    body: JSON.stringify({ spec_path, working_directory }),
  }),
  run: (spec_path, opts = {}) => requestV2('/workflow-specs/run', {
    method: 'POST',
    body: JSON.stringify({ spec_path, ...opts }),
  }),
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
  getHistory: (limit = 50) => requestV2(`/approvals?status=history&limit=${limit}`).then(d => d.items || d),
  approve: (id) => requestV2(`/approvals/${id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved' }),
  }),
  reject: (id) => requestV2(`/approvals/${id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'rejected' }),
  }),
};

// ─── Governance (v2 passthrough) ────────────────────────────────────────────

export const governance = {
  getRules: (params) => requestV2('/governance/rules' + buildQuery(params)),
  updateRule: (id, body) => requestV2('/governance/rules/' + id, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),
  resetViolations: (id) => requestV2('/governance/rules/' + id + '/reset', {
    method: 'POST',
  }),
};

// ─── Coordination (v2 passthrough) ──────────────────────────────────────────

export const coordination = {
  getDashboard: (hours = 24) => requestV2(`/coordination?hours=${hours}`),
  listAgents: () => requestV2('/coordination/agents'),
  listRules: () => requestV2('/coordination/rules'),
  listClaims: () => requestV2('/coordination/claims'),
};

export const versionControl = {
  getWorktrees: () => requestV2('/version-control/worktrees'),
  getCommits: (days = 7) => requestV2('/version-control/commits?days=' + days),
  getReleases: (repoPath) => requestV2('/version-control/releases' + (repoPath ? '?repo_path=' + encodeURIComponent(repoPath) : '')),
  createRelease: (body) => requestV2('/version-control/releases', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  deleteWorktree: (id) => requestV2('/version-control/worktrees/' + id, { method: 'DELETE' }),
  mergeWorktree: (id, opts = {}) => requestV2('/version-control/worktrees/' + id + '/merge', {
    method: 'POST',
    body: JSON.stringify(opts),
  }),
};

// ─── Provider quota status (v2 passthrough) ─────────────────────────────────

export const quota = {
  status: () => requestV2('/provider-quotas/status'),
  history: (days = 7) => requestV2('/provider-quotas/history?days=' + days),
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
  operations: (limit = 20) => requestV2(`/strategic/operations?limit=${limit}`),
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

export async function getDecisionLog(projectId, params = {}, opts = {}) {
  return requestV2(`/factory/projects/${projectId}/decisions${buildQuery(params)}`, opts);
}

export async function getRecoveryHistory(projectId, params = {}, opts = {}) {
  return requestV2(`/factory/projects/${projectId}/recovery_history${buildQuery(params)}`, opts);
}

export async function getFactoryDigest(projectId, opts = {}) {
  return requestV2(`/factory/projects/${projectId}/digest`, opts);
}

export async function testFactoryNotification(projectId, opts = {}) {
  return requestV2(`/factory/projects/${projectId}/notifications/test`, { method: 'POST', ...opts });
}

function parseToolJsonResult(payload) {
  if (payload && typeof payload === 'object' && typeof payload.result === 'string') {
    try {
      return JSON.parse(payload.result);
    } catch {
      return payload;
    }
  }

  return payload;
}

export const factory = {
  status: (opts = {}) => requestV2('/factory/status', opts),
  projects: (opts = {}) => requestV2('/factory/projects', opts),
  health: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}`, opts),
  register: (data, opts = {}) => requestV2('/factory/projects', { method: 'POST', body: JSON.stringify(data), ...opts }),
  pause: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/pause`, { method: 'POST', ...opts }),
  resume: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/resume`, { method: 'POST', ...opts }),
  intake: (projectId, params = {}, opts = {}) => requestV2(`/factory/projects/${projectId}/intake${buildQuery(params)}`, opts),
  createWorkItem: (projectId, data, opts = {}) => requestV2(`/factory/projects/${projectId}/intake`, { method: 'POST', body: JSON.stringify(data), ...opts }),
  rejectWorkItem: (itemId, reason, opts = {}) => requestV2(`/factory/intake/${itemId}/reject`, { method: 'POST', body: JSON.stringify({ reason }), ...opts }),
  pauseAll: (opts = {}) => requestV2('/factory/pause-all', { method: 'POST', ...opts }),
  triggerArchitect: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/architect`, { method: 'POST', ...opts }),
  backlog: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/backlog`, opts),
  architectLog: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/architect/log`, opts),
  getPolicy: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/policy`, opts),
  setPolicy: (projectId, policy, opts = {}) => requestV2(`/factory/projects/${projectId}/policy`, { method: 'PUT', body: JSON.stringify({ policy }), ...opts }),
  guardrailStatus: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/guardrails`, opts),
  runGuardrailCheck: (projectId, data, opts = {}) => requestV2(`/factory/projects/${projectId}/guardrails/check`, { method: 'POST', body: JSON.stringify(data), ...opts }),
  guardrailEvents: (projectId, params = {}, opts = {}) => requestV2(`/factory/projects/${projectId}/guardrails/events${buildQuery(params)}`, opts),
  loopStatus: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/loop`, opts),
  listLoopInstances: (projectId, { activeOnly, ...params } = {}, opts = {}) => requestV2(
    `/factory/projects/${projectId}/loops${buildQuery({ ...params, active_only: activeOnly })}`,
    opts,
  ).then((d) => unwrapListPayload(d, 'instances')),
  cycleHistory: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/cycles`, opts)
    .then((d) => unwrapListPayload(d, 'cycles')),
  recoveryHistory: (projectId, params = {}, opts = {}) => requestV2(
    `/factory/projects/${projectId}/recovery_history${buildQuery(params)}`,
    opts,
  ).then((d) => unwrapListPayload(d, 'decisions')),
  clearAutoRecovery: (projectId, opts = {}) => requestV2(
    `/factory/projects/${projectId}/auto-recovery/clear`,
    { method: 'POST', ...opts },
  ),
  startLoopInstance: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/loops/start`, { method: 'POST', ...opts }),
  loopInstanceStatus: (instanceId, opts = {}) => requestV2(`/factory/loops/${instanceId}`, opts),
  advanceLoopInstance: (instanceId, opts = {}) => requestV2(`/factory/loops/${instanceId}/advance`, { method: 'POST', ...opts }),
  loopInstanceJobStatus: (instanceId, jobId, opts = {}) => requestV2(`/factory/loops/${instanceId}/advance/${jobId}`, opts),
  approveGateInstance: (instanceId, stage, opts = {}) => requestV2(`/factory/loops/${instanceId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ stage }),
    ...opts,
  }),
  rejectGateInstance: (instanceId, stage, opts = {}) => requestV2(`/factory/loops/${instanceId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ stage }),
    ...opts,
  }),
  retryVerifyInstance: (instanceId, opts = {}) => requestV2(`/factory/loops/${instanceId}/retry-verify`, { method: 'POST', ...opts }),
  startLoop: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/loop/start`, { method: 'POST', ...opts }),
  advanceLoop: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/loop/advance`, { method: 'POST', ...opts }),
  advanceLoopAsync: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/loop/advance`, { method: 'POST', ...opts }),
  loopJobStatus: (projectId, jobId, opts = {}) => requestV2(`/factory/projects/${projectId}/loop/advance/${jobId}`, opts),
  approveGate: (projectId, stage, opts = {}) => requestV2(`/factory/projects/${projectId}/loop/approve`, { method: 'POST', body: JSON.stringify({ stage }), ...opts }),
  analyzeBatch: (projectId, data, opts = {}) => requestV2(`/factory/projects/${projectId}/analyze`, { method: 'POST', body: JSON.stringify(data), ...opts }),
  driftStatus: (projectId, params = {}, opts = {}) => requestV2(`/factory/projects/${projectId}/drift${buildQuery(params)}`, opts),
  factoryCosts: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/costs`, opts).then(parseToolJsonResult),
  recordCorrection: (projectId, data, opts = {}) => requestV2(`/factory/projects/${projectId}/corrections`, { method: 'POST', body: JSON.stringify(data), ...opts }),
};

export default { tasks, providers, stats, planProjects, hosts, peekHosts, budget, schedules, study, taskLogs, system, instances, projectTuning, benchmarks, workflows, workflowSpecs, approvals, governance, coordination, versionControl, strategic, routingTemplates, factory };
