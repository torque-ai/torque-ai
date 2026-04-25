import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tasks, providers, stats, planProjects, hosts, concurrency, workstations, budget, taskLogs, system, instances, projectTuning, workflows, benchmarks, study } from './api.js';

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

    it('cancel() sends POST to /api/v2/tasks/:id/cancel', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await tasks.cancel('abc-123');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/tasks/abc-123/cancel',
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

    it('previewStudyContext() sends POST to /api/v2/tasks/preview-study-context', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await tasks.previewStudyContext({ working_directory: 'C:/repo', task: 'Inspect scheduler' });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/tasks/preview-study-context',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ working_directory: 'C:/repo', task: 'Inspect scheduler' }),
        })
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

    it('activity() sends GET to /api/v2/hosts/activity', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      await hosts.activity();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/hosts/activity', expect.any(Object));
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

  describe('concurrency', () => {
    it('get() sends GET to /api/v2/concurrency', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await concurrency.get();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/concurrency', expect.any(Object));
    });

    it('set() sends POST to /api/v2/concurrency/set', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await concurrency.set({ scope: 'workstation', target: 'builder-01', max_concurrent: 4 });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/concurrency/set',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ scope: 'workstation', target: 'builder-01', max_concurrent: 4 }),
        })
      );
    });

    it('setLimit() sends POST to /api/v2/concurrency/limit', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await concurrency.setLimit({ key_pattern: 'tenant:*', max_concurrent: 2 });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/concurrency/limit',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ key_pattern: 'tenant:*', max_concurrent: 2 }),
        })
      );
    });

    it('removeLimit() sends DELETE to encoded /api/v2/concurrency/limit/:pattern', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await concurrency.removeLimit('tenant:test');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/concurrency/limit/tenant%3Atest',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('workstations', () => {
    it('list() sends GET to /api/v2/workstations', async () => {
      globalThis.fetch = mockFetch({ body: { data: { items: [{ name: 'builder-01' }], total: 1 } } });
      const result = await workstations.list();
      expect(result).toEqual([{ name: 'builder-01' }]);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/workstations', expect.any(Object));
    });

    it('add() sends POST to /api/v2/workstations', async () => {
      globalThis.fetch = mockFetch({ body: { data: { name: 'builder-01' } } });
      const payload = { name: 'builder-01', host: '10.0.0.12', agent_port: 3460, secret: 'shh' };
      await workstations.add(payload);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/workstations',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(payload),
        })
      );
    });

    it('remove() sends DELETE with encoded name', async () => {
      globalThis.fetch = mockFetch({ body: { data: { removed: true } } });
      await workstations.remove('builder/01');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `/api/v2/workstations/${encodeURIComponent('builder/01')}`,
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('toggle() sends POST to /api/v2/workstations/:name/toggle with enabled body', async () => {
      globalThis.fetch = mockFetch({ body: { data: { name: 'builder-01', enabled: 0 } } });
      await workstations.toggle('builder-01', false);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/workstations/builder-01/toggle',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ enabled: false }),
        })
      );
    });

    it('probe() sends POST to /api/v2/workstations/:name/probe', async () => {
      globalThis.fetch = mockFetch({ body: { data: { name: 'builder-01' } } });
      await workstations.probe('builder-01');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/workstations/builder-01/probe',
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
    it('list() sends GET to /api/v2/instances', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      await instances.list();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/instances', expect.any(Object));
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
      await projectTuning.get('C:/Users/<user>/project');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `/api/v2/project-tuning/${encodeURIComponent('C:/Users/<user>/project')}`,
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

    it('tasks() sends GET to /api/v2/workflows/:id/tasks', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      await workflows.tasks('wf-1');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/workflows/wf-1/tasks', expect.any(Object));
    });

    it('history() sends GET to /api/v2/workflows/:id/history', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      await workflows.history('wf-1');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/workflows/wf-1/history', expect.any(Object));
    });

    it('checkpoints() sends GET to /api/v2/workflows/:id/checkpoints', async () => {
      globalThis.fetch = mockFetch({ body: [] });
      await workflows.checkpoints('wf-1');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/workflows/wf-1/checkpoints', expect.any(Object));
    });

    it('fork() sends POST to /api/v2/workflows/:id/fork', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await workflows.fork('wf-1', { checkpoint_id: 'cp-1', state_overrides: { debug: true } });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/workflows/wf-1/fork',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ checkpoint_id: 'cp-1', state_overrides: { debug: true } }),
        })
      );
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

  describe('study', () => {
    it('getProfileOverride() sends GET to /api/v2/study/profile-override with query params', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await study.getProfileOverride({ working_directory: 'C:/repo' });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/study/profile-override?working_directory=C%3A%2Frepo',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('saveProfileOverride() sends PATCH to /api/v2/study/profile-override', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await study.saveProfileOverride({ working_directory: 'C:/repo', override: { subsystem_priority: { runtime: 10 } } });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/study/profile-override',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ working_directory: 'C:/repo', override: { subsystem_priority: { runtime: 10 } } }),
        })
      );
    });

    it('deleteProfileOverride() sends PATCH to /api/v2/study/profile-override with clear flag', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await study.deleteProfileOverride({ working_directory: 'C:/repo' });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/study/profile-override',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ working_directory: 'C:/repo', clear: true }),
        })
      );
    });

    it('benchmark() sends POST to /api/v2/study/benchmark', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await study.benchmark({ working_directory: 'C:/repo' });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/study/benchmark',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ working_directory: 'C:/repo' }),
        })
      );
    });

    it('preview() sends POST to /api/v2/study/preview', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await study.preview({ working_directory: 'C:/repo' });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/study/preview',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ working_directory: 'C:/repo' }),
        })
      );
    });

    it('bootstrap() sends POST to /api/v2/study/bootstrap', async () => {
      globalThis.fetch = mockFetch({ body: {} });
      await study.bootstrap({ working_directory: 'C:/repo', create_schedule: true });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v2/study/bootstrap',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ working_directory: 'C:/repo', create_schedule: true }),
        })
      );
    });
  });
});
