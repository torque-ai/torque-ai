const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');

const failover = require('../workstation/failover');
const routing = require('../workstation/routing');
const model = require('../workstation/model');
const adapters = require('../workstation/adapters');

let seq = 0;

function bindModules() {
  const handle = rawDb();
  model.setDb(handle);
  routing.setDb(handle);
  failover.setDb(handle);
  adapters.setDb(handle);
}

function createWs(overrides = {}) {
  const ws = model.createWorkstation({
    name: overrides.name || `ws-int-${++seq}`,
    host: overrides.host || `127.0.${seq}.1`,
    agent_port: overrides.agent_port || 3460,
    platform: overrides.platform || null,
    arch: overrides.arch || null,
    tls_cert: overrides.tls_cert || null,
    tls_fingerprint: overrides.tls_fingerprint || null,
    secret: overrides.secret || `secret-${seq}`,
    capabilities: overrides.capabilities !== undefined ? JSON.stringify(overrides.capabilities) : null,
    ollama_port: overrides.ollama_port || 11434,
    models_cache: overrides.models_cache || null,
    memory_limit_mb: overrides.memory_limit_mb || null,
    settings: overrides.settings || null,
    gpu_name: overrides.gpu_name || null,
    gpu_vram_mb: overrides.gpu_vram_mb || null,
    gpu_metrics_port: overrides.gpu_metrics_port || null,
    status: overrides.status || null,
    max_concurrent: overrides.max_concurrent || 3,
    priority: overrides.priority || 10,
    enabled: overrides.enabled === false ? 0 : 1,
    is_default: overrides.is_default || false,
    last_health_check: overrides.last_health_check || null,
    last_healthy: overrides.last_healthy || null,
    running_tasks: overrides.running_tasks || 0,
  });

  if (overrides.status !== undefined) {
    model.updateWorkstation(ws.id, { status: overrides.status });
  }

  return model.getWorkstation(ws.id);
}

describe('workstation integration', () => {
  beforeAll(() => {
    setupTestDb('workstation-integration');
    bindModules();
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    bindModules();
    rawDb().prepare('DELETE FROM workstations').run();
  });

  describe('status summary', () => {
    it('returns null when no healthy workstations are enabled', () => {
      createWs({
        name: 'down-station',
        status: 'down',
        enabled: true,
        capabilities: { command_exec: { detected: true } },
      });

      const summary = model.buildWorkstationStatusNotification();
      expect(summary).toBeNull();
    });

    it('returns a summary with capabilities and normalized gpu size', () => {
      createWs({
        name: 'healthy-node',
        host: '10.1.1.1',
        status: 'healthy',
        enabled: true,
        capabilities: { ollama: { detected: true }, command_exec: { detected: true } },
        gpu_name: 'RTX 4090',
        gpu_vram_mb: 24576,
      });
      createWs({
        name: 'not-healthy',
        status: 'degraded',
        capabilities: { command_exec: { detected: true } },
      });

      const summary = model.buildWorkstationStatusNotification();

      expect(summary).toMatchObject({
        type: 'workstation_status',
        hint: 'Remote workstations available...',
      });
      expect(Array.isArray(summary.workstations)).toBe(true);
      expect(summary.workstations).toHaveLength(1);
      expect(summary.workstations[0]).toMatchObject({
        name: 'healthy-node',
        status: 'healthy',
        host: '10.1.1.1',
        is_default: false,
        gpu: 'RTX 4090 (24GB)',
      });
      expect(summary.workstations[0].capabilities).toEqual(expect.arrayContaining(['ollama', 'command_exec']));
    });
  });

  describe('health lifecycle', () => {
    it('transitions healthy to degraded to down and then recovers', () => {
      const ws = createWs({
        name: 'recoverable',
        status: 'unknown',
        enabled: true,
      });

      const healthy = model.recordHealthCheck(ws.id, true, ['m1']);
      expect(healthy.status).toBe('healthy');

      const fail1 = model.recordHealthCheck(ws.id, false);
      expect(fail1.status).toBe('degraded');
      expect(fail1.consecutive_failures).toBe(1);

      const fail2 = model.recordHealthCheck(ws.id, false);
      expect(fail2.status).toBe('degraded');
      expect(fail2.consecutive_failures).toBe(2);

      const fail3 = model.recordHealthCheck(ws.id, false);
      expect(fail3.status).toBe('down');
      expect(fail3.consecutive_failures).toBe(3);

      const recovered = model.recordHealthCheck(ws.id, true);
      expect(recovered.status).toBe('healthy');
      expect(recovered.consecutive_failures).toBe(0);
    });
  });

  describe('adapter compatibility', () => {
    it('addOllamaHost writes parseable fields to workstation table', () => {
      const created = adapters.addOllamaHost({
        name: 'compat-host',
        url: '192.168.55.66:11555',
        models: ['qwen3:8b', 'codellama'],
        secret: 'compat-secret',
      });

      const ws = model.getWorkstation(created.id);
      expect(ws).toBeTruthy();
      expect(ws.name).toBe('compat-host');
      expect(ws.host).toBe('192.168.55.66');
      expect(ws.ollama_port).toBe(11555);
      expect(ws.agent_port).toBe(3460);
      expect(ws._capabilities).toMatchObject({
        ollama: { detected: true, port: 11555 },
      });
      expect(ws.models_cache).toBe(JSON.stringify(['qwen3:8b', 'codellama']));
    });
  });

  describe('routing', () => {
    it('routes by provider-specific model selection', () => {
      createWs({
        name: 'ollama-b',
        status: 'healthy',
        capabilities: { ollama: { detected: true } },
        models_cache: JSON.stringify(['gemma', 'qwen3']),
      });
      createWs({
        name: 'ollama-a',
        status: 'healthy',
        capabilities: { ollama: { detected: true } },
        models_cache: JSON.stringify(['codellama', 'codegemma']),
      });

      const selection = routing.findWorkstationForTask({
        provider: 'aider-ollama',
        model: 'codellama',
      });

      expect(selection).toMatchObject({ name: 'ollama-a' });
    });
  });

  describe('failover', () => {
    it('handleWorkstationDown reroutes queued work and fails running work', () => {
      const primary = createWs({
        name: 'down-primary',
        status: 'healthy',
        capabilities: { command_exec: { detected: true } },
      });

      const replacement = createWs({
        name: 'standby',
        status: 'healthy',
        capabilities: { command_exec: { detected: true } },
        running_tasks: 0,
      });

      const updates = [];
      const tasksByPrimary = [
        { id: 'task-queued', status: 'queued', workstation_id: primary.id },
        { id: 'task-running', status: 'running', workstation_id: primary.id },
        { id: 'task-done', status: 'completed', workstation_id: primary.id },
      ];

      const result = failover.handleWorkstationDown(primary.id, () => tasksByPrimary, (taskId, patch) => {
        updates.push({ taskId, patch });
      });

      expect(result).toEqual({
        rerouted: 1,
        failed: 1,
      });
      expect(updates).toContainEqual({
        taskId: 'task-queued',
        patch: { workstation_id: replacement.id },
      });
      expect(updates).toContainEqual({
        taskId: 'task-running',
        patch: {
          status: 'failed',
          error: `workstation_down: ${primary.name}`,
        },
      });
      expect(updates.find((entry) => entry.taskId === 'task-done')).toBeUndefined();
    });

    it('handles no replacement and marks all active tasks as failed', () => {
      const primary = createWs({
        name: 'only-primary',
        status: 'healthy',
        capabilities: { command_exec: { detected: true } },
      });

      const updates = [];
      const tasksByPrimary = [
        { id: 'queued-no-failover', status: 'queued', workstation_id: primary.id },
        { id: 'running-no-failover', status: 'running', workstation_id: primary.id },
      ];

      const result = failover.handleWorkstationDown(primary.id, () => tasksByPrimary, (taskId, patch) => {
        updates.push({ taskId, patch });
      });

      expect(result).toEqual({
        rerouted: 0,
        failed: 2,
      });
      expect(updates).toHaveLength(2);
      expect(updates).toContainEqual({
        taskId: 'queued-no-failover',
        patch: {
          status: 'failed',
          error: `workstation_down: ${primary.name}`,
        },
      });
      expect(updates).toContainEqual({
        taskId: 'running-no-failover',
        patch: {
          status: 'failed',
          error: `workstation_down: ${primary.name}`,
        },
      });
    });
  });
});
