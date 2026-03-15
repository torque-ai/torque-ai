import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tasks, providers, stats, planProjects, hosts, budget, taskLogs, system, instances, projectTuning, workflows, benchmarks, request } from './api.js';

// --- Test helpers ---

function mockFetch(response = {}) {
  const { status = 200, body = {}, headers = {}, contentType = 'application/json' } = response;
  const headerMap = new Map(Object.entries({
    'content-type': contentType,
    'content-length': body === null ? '0' : undefined,
    ...headers,
  }));

  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key) => headerMap.get(key.toLowerCase()) ?? null,
    },
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

// --- Tests ---

describe('api.js', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ========== request() behavior ==========

  describe('request()', () => {
    it('performs successful GET request', async () => {
      globalThis.fetch = mockFetch({ body: { success: true } });
      const result = await request('/health');
      expect(result).toEqual({ success: true });
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/health', expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }));
    });

    it('performs successful POST request with caller-supplied headers', async () => {
      globalThis.fetch = mockFetch({ body: { id: 'new-task' } });
      const result = await request('/tasks', {
        method: 'POST',
        body: JSON.stringify({ name: 'sample' }),
        headers: { 'X-Trace-Id': 'abc-123' },
      });
      expect(result).toEqual({ id: 'new-task' });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/tasks',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'sample' }),
          headers: { 'X-Trace-Id': 'abc-123' },
        })
      );
    });

    it('performs successful PUT request', async () => {
      globalThis.fetch = mockFetch({ body: { status: 'updated' } });
      const result = await request('/tasks/7', {
        method: 'PUT',
        body: JSON.stringify({ status: 'done' }),
      });
      expect(result).toEqual({ status: 'updated' });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/tasks/7',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ status: 'done' }),
        })
      );
    });

    it('performs successful DELETE request', async () => {
      globalThis.fetch = mockFetch({ body: { removed: true } });
      const result = await request('/tasks/7', {
        method: 'DELETE',
      });
      expect(result).toEqual({ removed: true });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/tasks/7',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });

    it('sends JSON content-type header by default', async () => {
      globalThis.fetch = mockFetch({ body: { ok: true } });
      await request('/headers');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        })
      );
    });

    it('constructs URL with API_BASE prefix', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      await request('/tasks');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/tasks', expect.any(Object));
    });

    it('returns parsed JSON for JSON responses', async () => {
      globalThis.fetch = mockFetch({ body: { id: '123', status: 'running' } });
      const result = await request('/tasks/123');
      expect(result).toEqual({ id: '123', status: 'running' });
    });

    it('returns empty object for 204 No Content', async () => {
      const headerMap = new Map([
        ['content-type', 'application/json'],
        ['content-length', null],
      ]);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        headers: { get: (k) => headerMap.get(k.toLowerCase()) ?? null },
        json: vi.fn(),
        text: vi.fn(),
      });
      const result = await request('/empty');
      expect(result).toEqual({});
    });

    it('returns empty object for content-length: 0', async () => {
      const headerMap = new Map([
        ['content-type', 'application/json'],
        ['content-length', '0'],
      ]);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (k) => headerMap.get(k.toLowerCase()) ?? null },
        json: vi.fn(),
        text: vi.fn(),
      });
      const result = await request('/empty');
      expect(result).toEqual({});
    });

    it('returns text wrapper for non-JSON responses', async () => {
      globalThis.fetch = mockFetch({ body: 'plain text', contentType: 'text/plain' });
      const result = await request('/status');
      expect(result).toEqual({ text: 'plain text' });
    });

    it('throws on HTTP error with JSON error body', async () => {
      globalThis.fetch = mockFetch({ status: 404, body: { error: 'Not found' } });
      await expect(request('/bad')).rejects.toThrow('Not found');
    });

    it('throws on 401 with JSON error body', async () => {
      globalThis.fetch = mockFetch({ status: 401, body: { error: 'Unauthorized' } });
      await expect(request('/secure')).rejects.toThrow('Unauthorized');
    });

    it('throws on 403 with text error body', async () => {
      globalThis.fetch = mockFetch({ status: 403, body: 'Forbidden', contentType: 'text/plain' });
      await expect(request('/secure')).rejects.toThrow('Forbidden');
    });

    it('throws on 500 server error with JSON error body', async () => {
      globalThis.fetch = mockFetch({ status: 500, body: { error: 'Server broken' } });
      await expect(request('/server')).rejects.toThrow('Server broken');
    });

    it('throws on HTTP error with text body', async () => {
      globalThis.fetch = mockFetch({ status: 500, body: 'Internal Server Error', contentType: 'text/plain' });
      await expect(request('/broken')).rejects.toThrow('Internal Server Error');
    });

    it('throws on invalid JSON response', async () => {
      const headerMap = new Map([['content-type', 'application/json']]);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (k) => headerMap.get(k.toLowerCase()) ?? null },
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
        text: vi.fn().mockResolvedValue('not json'),
      });
      await expect(request('/broken-json')).rejects.toThrow('Invalid JSON response (HTTP 200)');
    });

    it('uses caller-provided headers as-is when custom headers are supplied', async () => {
      globalThis.fetch = mockFetch({ body: { ok: true } });
      await request('/tasks', {
        method: 'POST',
        headers: {
          'X-Feature-Flag': 'enabled',
          Authorization: 'Bearer token',
        },
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/tasks',
        expect.objectContaining({
          headers: {
            'X-Feature-Flag': 'enabled',
            Authorization: 'Bearer token',
          },
        })
      );
    });

    it('allows overriding request Content-Type', async () => {
      globalThis.fetch = mockFetch({ body: { ok: true }, contentType: 'text/plain' });
      await request('/raw', {
        method: 'POST',
        body: 'raw',
        headers: {
          'Content-Type': 'text/plain',
        },
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/raw',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'text/plain',
          }),
        })
      );
    });

    it('converts AbortError to timeout message', async () => {
      const abortErr = new DOMException('The operation was aborted.', 'AbortError');
      globalThis.fetch = vi.fn().mockRejectedValue(abortErr);
      await expect(request('/timeout')).rejects.toThrow('Request timed out');
    });

    it('rethrows non-abort errors unchanged', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Network error'));
      await expect(request('/network')).rejects.toThrow('Network error');
    });

    it('passes AbortController signal to fetch', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await request('/signal');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('throws for 204 when response is not ok', async () => {
      const headerMap = new Map([['content-type', 'application/json']]);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 204,
        headers: { get: (k) => headerMap.get(k.toLowerCase()) ?? null },
        json: vi.fn(),
        text: vi.fn(),
      });
      await expect(request('/empty')).rejects.toThrow('HTTP 204');
    });
  });


  // ========== tasks endpoints ==========

  describe('tasks', () => {
    it('list() sends GET to /api/v2/tasks', async () => {
      globalThis.fetch = mockFetch({ body: { items: [], total: 0 } });
      const result = await tasks.list();
      expect(result).toEqual({
        tasks: [],
        total: 0,
        pagination: {
          page: 1,
          limit: 50,
          total: 0,
        },
      });
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/tasks', expect.any(Object));
    });

    it('list() appends query params', async () => {
      globalThis.fetch = mockFetch({ body: { items: [], total: 0 } });
      const result = await tasks.list({ status: 'running', limit: '10' });
      expect(result).toEqual({
        tasks: [],
        total: 0,
        pagination: {
          page: 1,
          limit: 10,
          total: 0,
        },
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/tasks?status=running&limit=10',
        expect.any(Object)
      );
    });

    it('get() sends GET to /api/v2/tasks/:id', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await tasks.get('abc-123');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/tasks/abc-123', expect.any(Object));
    });

    it('diff() sends GET to /api/v2/tasks/:id/diff', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await tasks.diff('abc-123');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/tasks/abc-123/diff', expect.any(Object));
    });

    it('retry() sends POST to /api/v2/tasks/:id/retry', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await tasks.retry('abc-123');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/tasks/abc-123/retry',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('reassignProvider() sends PATCH to /api/v2/tasks/:id/provider', async () => {
      globalThis.fetch = mockFetch({ body: { id: 'abc-123', provider: 'ollama' } });
      await tasks.reassignProvider('abc-123', 'ollama');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/tasks/abc-123/provider',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ provider: 'ollama' }),
        })
      );
    });

    it('cancel() sends POST to /api/tasks/:id/cancel', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await tasks.cancel('abc-123');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/tasks/abc-123/cancel',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('approveSwitch() sends POST to /api/v2/tasks/:id/approve-switch', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await tasks.approveSwitch('abc-123');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/tasks/abc-123/approve-switch',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('rejectSwitch() sends POST to /api/v2/tasks/:id/reject-switch', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await tasks.rejectSwitch('abc-123');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/tasks/abc-123/reject-switch',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });


  // ========== providers endpoints ==========

  describe('providers', () => {
    it('list() sends GET to /api/v2/providers', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      const result = await providers.list();
      expect(result).toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/providers', expect.any(Object));
    });

    it('stats() includes days param', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await providers.stats('ollama', 14);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/providers/ollama/stats?days=14', expect.any(Object));
    });

    it('stats() defaults to 7 days', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await providers.stats('codex');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/providers/codex/stats?days=7', expect.any(Object));
    });

    it('toggle() sends POST with enabled body', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await providers.toggle('deepinfra', true);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/providers/deepinfra/toggle',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ enabled: true }),
        })
      );
    });
  });


  // ========== stats endpoints ==========

  describe('stats', () => {
    it('overview() sends GET to /api/v2/stats/overview', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await stats.overview();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/stats/overview', expect.any(Object));
    });

    it('timeseries() appends query params', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      const result = await stats.timeseries({ hours: '24' });
      expect(result).toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/stats/timeseries?hours=24', expect.any(Object));
    });

    it('quality() includes hours param', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await stats.quality(48);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/stats/quality?hours=48', expect.any(Object));
    });

    it('stuck() sends GET to /api/v2/stats/stuck', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      await stats.stuck();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/stats/stuck', expect.any(Object));
    });
  });


  // ========== planProjects endpoints ==========

  describe('planProjects', () => {
    it('list() appends query params', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      const result = await planProjects.list({ status: 'active' });
      expect(result).toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/plan-projects?status=active', expect.any(Object));
    });

    it('get() sends GET to /api/v2/plan-projects/:id', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await planProjects.get('proj-1');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/plan-projects/proj-1', expect.any(Object));
    });

    it('import() sends POST with data body', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      const data = { name: 'test' };
      await planProjects.import(data);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/plan-projects/import',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(data),
        })
      );
    });

    it('pause() sends POST', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await planProjects.pause('proj-1');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/plan-projects/proj-1/pause',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('resume() sends POST', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await planProjects.resume('proj-1');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/plan-projects/proj-1/resume',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('delete() sends DELETE', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await planProjects.delete('proj-1');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/plan-projects/proj-1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });


  // ========== hosts endpoints ==========

  describe('hosts', () => {
    it('list() sends GET to /api/v2/hosts', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      const result = await hosts.list();
      expect(result).toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/hosts', expect.any(Object));
    });

    it('get() sends GET to /api/v2/hosts/:id', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await hosts.get('host-1');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/hosts/host-1', expect.any(Object));
    });

    it('activity() sends GET to /api/hosts/activity', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      await hosts.activity();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/hosts/activity', expect.any(Object));
    });

    it('toggle() sends POST with enabled body', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await hosts.toggle('host-1', false);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/hosts/host-1/toggle',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ enabled: false }),
        })
      );
    });

    it('scan() sends POST with 30s timeout', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await hosts.scan();
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/hosts/scan',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });


  // ========== budget endpoints ==========

  describe('budget', () => {
    it('summary() defaults to 30 days', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await budget.summary();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/budget/summary?days=30', expect.any(Object));
    });

    it('summary() accepts custom days', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await budget.summary(7);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/budget/summary?days=7', expect.any(Object));
    });

    it('status() sends GET to /api/v2/budget/status', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await budget.status();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/budget/status', expect.any(Object));
    });
  });


  // ========== other endpoint groups ==========

  describe('taskLogs', () => {
    it('get() sends GET to /api/v2/tasks/:id/logs', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await taskLogs.get('task-1');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/tasks/task-1/logs', expect.any(Object));
    });
  });

  describe('system', () => {
    it('status() sends GET to /api/v2/system/status', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await system.status();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/system/status', expect.any(Object));
    });
  });

  describe('instances', () => {
    it('list() sends GET to /api/instances', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      await instances.list();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/instances', expect.any(Object));
    });
  });

  describe('projectTuning', () => {
    it('list() sends GET to /api/v2/tuning', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      const result = await projectTuning.list();
      expect(result).toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/tuning', expect.any(Object));
    });

    it('get() encodes project path', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await projectTuning.get('C:/Users/test/project');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `/api/project-tuning/${encodeURIComponent('C:/Users/test/project')}`,
        expect.any(Object)
      );
    });

    it('set() sends POST with settings body', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      const settings = { temperature: 0.3 };
      await projectTuning.set('/path', settings, 'test desc');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/tuning',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ projectPath: '/path', settings, description: 'test desc' }),
        })
      );
    });

    it('delete() sends DELETE with encoded path', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await projectTuning.delete('C:/test');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `/api/v2/tuning/${encodeURIComponent('C:/test')}`,
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('workflows', () => {
    it('list() appends query params', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      const result = await workflows.list({ status: 'completed' });
      expect(result).toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/workflows?status=completed', expect.any(Object));
    });

    it('list() sends empty GET without params', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      const result = await workflows.list();
      expect(result).toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/workflows', expect.any(Object));
    });

    it('get() sends GET to /api/v2/workflows/:id', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await workflows.get('wf-1');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/workflows/wf-1', expect.any(Object));
    });

    it('tasks() sends GET to /api/workflows/:id/tasks', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      await workflows.tasks('wf-1');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/workflows/wf-1/tasks', expect.any(Object));
    });

    it('history() sends GET to /api/v2/workflows/:id/history', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      await workflows.history('wf-1');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/workflows/wf-1/history', expect.any(Object));
    });
  });

  describe('benchmarks', () => {
    it('get() includes hostId and limit', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      const result = await benchmarks.get('host-1', 5);
      expect(result).toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/benchmarks?hostId=host-1&limit=5', expect.any(Object));
    });

    it('get() defaults to limit 10', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      const result = await benchmarks.get('host-1');
      expect(result).toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/benchmarks?hostId=host-1&limit=10', expect.any(Object));
    });

    it('apply() sends POST with hostId and model', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await benchmarks.apply('host-1', 'qwen3:8b');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/benchmarks/apply',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ hostId: 'host-1', model: 'qwen3:8b' }),
        })
      );
    });
  });
});
