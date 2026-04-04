const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');

const model = require('../workstation/model');
const adapters = require('../workstation/adapters');
const certs = require('../workstation/certs');
const probe = require('../workstation/probe');
const routing = require('../workstation/routing');
const failover = require('../workstation/failover');

let seq = 0;

function bindModules() {
  const handle = rawDb();
  model.setDb(handle);
  adapters.setDb(handle);
  routing.setDb(handle);
  failover.setDb(handle);
}

function clearWorkstations() {
  rawDb().prepare('DELETE FROM workstations').run();
  seq = 0;
}

function createWs(overrides = {}) {
  const ws = model.createWorkstation({
    name: overrides.name || `ws-${++seq}`,
    host: overrides.host || `127.0.${seq}.1`,
    agent_port: overrides.agent_port || 3460,
    platform: overrides.platform || null,
    arch: overrides.arch || null,
    tls_cert: overrides.tls_cert || null,
    tls_fingerprint: overrides.tls_fingerprint || null,
    secret: overrides.secret !== undefined ? overrides.secret : `secret-${seq}`,
    capabilities: overrides.capabilities !== undefined ? JSON.stringify(overrides.capabilities) : null,
    ollama_port: overrides.ollama_port || 11434,
    models_cache: overrides.models_cache || null,
    memory_limit_mb: overrides.memory_limit_mb || null,
    settings: overrides.settings || null,
    gpu_name: overrides.gpu_name || null,
    gpu_vram_mb: overrides.gpu_vram_mb || null,
    gpu_metrics_port: overrides.gpu_metrics_port || null,
    max_concurrent: overrides.max_concurrent !== undefined ? overrides.max_concurrent : 3,
    priority: overrides.priority !== undefined ? overrides.priority : 10,
    enabled: overrides.enabled !== undefined ? overrides.enabled : true,
    is_default: overrides.is_default ? 1 : 0,
    status: overrides.status || null,
  });

  if (overrides.status !== undefined) {
    model.updateWorkstation(ws.id, { status: overrides.status });
  }

  if (overrides.running_tasks !== undefined) {
    model.updateWorkstation(ws.id, { running_tasks: overrides.running_tasks });
  }

  // Re-fetch to get updated state
  return model.getWorkstation(ws.id);
}

describe('workstation/model', () => {
  beforeAll(() => {
    setupTestDbOnly('workstation-model');
    bindModules();
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    bindModules();
    clearWorkstations();
  });

  describe('schema', () => {
    it('exposes all expected workstations columns via PRAGMA table_info', () => {
      const rows = rawDb().prepare("PRAGMA table_info('workstations')").all();
      const names = rows.map((row) => row.name);
      const expected = [
        'id',
        'name',
        'host',
        'agent_port',
        'platform',
        'arch',
        'tls_cert',
        'tls_fingerprint',
        'secret',
        'capabilities',
        'ollama_port',
        'models_cache',
        'memory_limit_mb',
        'settings',
        'last_model_used',
        'model_loaded_at',
        'gpu_metrics_port',
        'models_updated_at',
        'gpu_name',
        'gpu_vram_mb',
        'status',
        'consecutive_failures',
        'last_health_check',
        'last_healthy',
        'max_concurrent',
        'running_tasks',
        'priority',
        'enabled',
        'is_default',
        'created_at',
        'updated_at',
      ];

      for (const name of expected) {
        expect(names).toContain(name);
      }

      expect(rows.find((row) => row.pk === 1).name).toBe('id');
      expect(expected.length).toBeLessThanOrEqual(rows.length);
    });

    it('defaults important workstation columns to expected values on create', () => {
      const ws = createWs({
        name: 'defaults-workstation',
      });

      expect(ws.enabled).toBe(1);
      expect(ws.is_default).toBe(0);
      expect(ws.max_concurrent).toBe(3);
      expect(ws.priority).toBe(10);
      expect(ws.running_tasks).toBe(0);
      expect(ws.agent_port).toBe(3460);
      expect(ws.ollama_port).toBe(11434);
      expect(ws.status).toBe('unknown');
      expect(ws._capabilities).toEqual({});
    });
  });

  describe('CRUD', () => {
    it('creates a workstation with required security identity', () => {
      const ws = createWs({
        name: 'create-workstation',
        secret: 'secret-alpha',
        capabilities: { command_exec: true },
      });

      expect(ws).toBeTruthy();
      expect(ws.id).toBeTruthy();
      expect(ws.name).toBe('create-workstation');
      expect(ws.host).toMatch(/^127\.0\.\d+\.1$/);
      expect(ws.secret).toBe('secret-alpha');
      expect(ws._capabilities).toEqual({ command_exec: true });
    });

    it('rejects workstation creation without secret or tls certificate', () => {
      expect(() => createWs({ name: 'bad-workstation', secret: null, tls_cert: null })).toThrow(
        'Security validation failed: workstation must have tls_cert or secret'
      );
    });

    it('returns null when a workstation is missing by id', () => {
      const ws = model.getWorkstation('missing-workstation-id');
      expect(ws).toBe(null);
    });

    it('returns null when a workstation is missing by name', () => {
      const ws = model.getWorkstationByName('missing-workstation-name');
      expect(ws).toBe(null);
    });

    it('lists by capability using json_extract(JSON.stringify(capabilities))', () => {
      const wsA = createWs({ name: 'cap-ollama', capabilities: { ollama: { detected: true } } });
      createWs({ name: 'cap-remote', capabilities: { command_exec: true } });
      createWs({ name: 'cap-none', capabilities: null });

      const result = model.listWorkstations({ capability: 'ollama' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(wsA.id);
    });

    it('lists enabled workstations and sorts by priority/running_tasks', () => {
      createWs({ name: 'low', enabled: true, priority: 1, running_tasks: 0 });
      createWs({ name: 'high-full', enabled: true, priority: 10, running_tasks: 10 });
      createWs({ name: 'high-empty', enabled: false, priority: 999, running_tasks: 0 });

      const enabled = model.listWorkstations({ enabled: true });
      expect(enabled.map((ws) => ws.name)).toEqual(['high-full', 'low']);
      expect(enabled.every((ws) => ws.enabled === 1)).toBe(true);
    });

    it('updates allowed fields and persists values', () => {
      const ws = createWs({ name: 'updatable' });
      const updated = model.updateWorkstation(ws.id, {
        name: 'updated-name',
        running_tasks: 2,
        status: 'healthy',
        enabled: 0,
        priority: 77,
      });

      expect(updated).toMatchObject({
        id: ws.id,
        name: 'updated-name',
        running_tasks: 2,
        status: 'healthy',
        enabled: 0,
        priority: 77,
      });
    });

    it('ignores unknown update fields and returns persisted record', () => {
      const ws = createWs({ name: 'update-ignored' });
      const updated = model.updateWorkstation(ws.id, { unknown_field: 'nope', max_concurrent: 9 });

      expect(updated.unknown_field).toBeUndefined();
      expect(updated.max_concurrent).toBe(9);
    });

    it('removes by id and returns removed row', () => {
      const ws = createWs({ name: 'to-remove' });
      const removed = model.removeWorkstation(ws.id);
      const found = model.getWorkstation(ws.id);

      expect(removed).toMatchObject({ id: ws.id });
      expect(found).toBeNull();
    });

    it('returns null when remove target is missing', () => {
      const removed = model.removeWorkstation('missing-id');
      expect(removed).toBe(null);
    });

    it('acquires slot while under capacity', () => {
      const ws = createWs({ name: 'capacity', max_concurrent: 2 });
      const first = model.tryReserveSlot(ws.id);
      const second = model.tryReserveSlot(ws.id);
      const reloaded = model.getWorkstation(ws.id);

      expect(first).toMatchObject({ acquired: true, currentLoad: 1, maxCapacity: 2 });
      expect(second).toMatchObject({ acquired: true, currentLoad: 2, maxCapacity: 2 });
      expect(reloaded.running_tasks).toBe(2);
    });

    it('rejects reserve when capacity is exhausted', () => {
      const ws = createWs({ name: 'capacity-full', max_concurrent: 1 });
      const first = model.tryReserveSlot(ws.id);
      const second = model.tryReserveSlot(ws.id);
      const reloaded = model.getWorkstation(ws.id);

      expect(first).toMatchObject({ acquired: true, currentLoad: 1, maxCapacity: 1 });
      expect(second).toEqual({ acquired: false, currentLoad: 1, maxCapacity: 1 });
      expect(reloaded.running_tasks).toBe(1);
    });

    it('returns false when reserving slot for missing workstation', () => {
      const result = model.tryReserveSlot('no-such-workstation');
      expect(result).toEqual({ acquired: false, currentLoad: 0, maxCapacity: 0 });
    });

    it('releases slot and clamps at zero', () => {
      const ws = createWs({ name: 'release-test', max_concurrent: 2, running_tasks: 2 });
      model.releaseSlot(ws.id);
      model.releaseSlot(ws.id);
      model.releaseSlot(ws.id);
      const reloaded = model.getWorkstation(ws.id);

      expect(reloaded.running_tasks).toBe(0);
    });
  });

  describe('adapters', () => {
    it('returns ollama hosts in legacy URL-based shape', () => {
      createWs({
        name: 'ollama-old',
        host: '10.0.0.1',
        ollama_port: 11438,
        capabilities: { ollama: { detected: true, version: 'v1' } },
        models_cache: JSON.stringify(['gpt4:alpha', 'gpt4:mini']),
      });

      const hosts = adapters.listOllamaHosts({ enabled: true });
      expect(Array.isArray(hosts)).toBe(true);
      expect(hosts.length).toBe(1);
      expect(hosts[0]).toEqual(expect.objectContaining({
        name: 'ollama-old',
        url: 'http://10.0.0.1:11438',
        models: ['gpt4:alpha', 'gpt4:mini'],
      }));
    });

    it('resolves peek host by default workstation, then healthy, then first candidate', () => {
      createWs({
        name: 'peek-default',
        capabilities: { ui_capture: { detected: true, has_display: true } },
        is_default: true,
      });
      createWs({
        name: 'peek-other',
        capabilities: { ui_capture: { detected: true, has_display: true } },
      });

      const selected = adapters.resolvePeekHost();
      expect(selected).toBeTruthy();
      expect(selected.name).toBe('peek-default');

      // Make default down + not-default, make other healthy
      const other = model.getWorkstationByName('peek-other');
      model.updateWorkstation(selected.id, { is_default: 0, status: 'down' });
      model.updateWorkstation(other.id, { status: 'healthy' });
      const selectedAfterDown = adapters.resolvePeekHost();
      expect(selectedAfterDown.name).toBe('peek-other');
    });

    it('returns null for peek host when none exists', () => {
      expect(adapters.resolvePeekHost()).toBe(null);
    });

    it('filters available agents by command_exec capability and capacity', () => {
      createWs({
        name: 'agent-busy',
        status: 'healthy',
        enabled: true,
        capabilities: { command_exec: { detected: true }, git_sync: true },
        running_tasks: 3,
        max_concurrent: 3,
      });
      createWs({
        name: 'agent-down',
        status: 'down',
        capabilities: { command_exec: { detected: true }, git_sync: true },
      });
      createWs({
        name: 'agent-ok',
        status: 'healthy',
        enabled: true,
        capabilities: { command_exec: { detected: true }, git_sync: true },
        running_tasks: 1,
        max_concurrent: 3,
      });

      const available = adapters.getAvailableAgents();
      expect(available.map((ws) => ws.name)).toEqual(['agent-ok']);
      expect(available[0].status).toBe('healthy');
    });

    it('adds an ollama host from a URL and persists parsed fields', () => {
      const record = adapters.addOllamaHost({
        name: 'host-from-url',
        url: '192.0.2.15:11436',
        agent_port: 3450,
        secret: 'agent-secret',
        models: ['m1', 'm2'],
        priority: 20,
        enabled: true,
      });

      const reloaded = model.getWorkstation(record.id);
      expect(reloaded).toMatchObject({
        name: 'host-from-url',
        host: '192.0.2.15',
        ollama_port: 11436,
        agent_port: 3450,
      });
      expect(reloaded._capabilities).toMatchObject({
        ollama: { detected: true, port: 11436 },
      });
      expect(Array.isArray(JSON.parse(reloaded.models_cache))).toBe(true);
    });

    it('adds ollama host with fallback port when omitted', () => {
      const record = adapters.addOllamaHost({
        name: 'host-without-port',
        url: '192.0.2.99',
        secret: 'agent-secret-2',
      });

      const reloaded = model.getWorkstation(record.id);
      expect(reloaded.ollama_port).toBe(11434);
    });

    it('throws for invalid addOllamaHost URL values', () => {
      expect(() => adapters.addOllamaHost({
        name: 'host-invalid-url',
        url: '::::bad::::',
        secret: 'secret',
      })).toThrow(/Invalid host URL/);
    });
  });

  describe('certs', () => {
    it('returns a hex colon fingerprint', () => {
      const fp = certs.getCertFingerprint('-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');
      expect(fp).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2})+$/);
      expect(fp.split(':').length).toBe(32);
    });

    it('uses deterministic fallback fingerprinting for unknown payloads', () => {
      const fp1 = certs.getCertFingerprint('not-a-real-cert');
      const fp2 = certs.getCertFingerprint('not-a-real-cert');
      expect(fp1).toBe(fp2);
      expect(fp1.split(':')[0].length).toBe(2);
    });

    it('detects cert expiry using default warning window', () => {
      const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
      const far = new Date(Date.now() + 120 * 24 * 3600 * 1000).toISOString();

      expect(certs.isCertExpiringSoon(soon)).toBe(true);
      expect(certs.isCertExpiringSoon(far)).toBe(false);
    });

    it('respects custom warning day window', () => {
      const soon = new Date(Date.now() + 45 * 24 * 3600 * 1000).toISOString();
      expect(certs.isCertExpiringSoon(soon, 60)).toBe(true);
      expect(certs.isCertExpiringSoon(soon, 30)).toBe(false);
    });
  });

  describe('probe', () => {
    it('parses probe responses into normalized workstation values', () => {
      const parsed = probe.parseProbeResponse({
        platform: 'linux',
        arch: 'x64',
        capabilities: {
          gpu: {
            detected: true,
            name: 'RTX-4090',
            vram_mb: 24576,
          },
          ollama: {
            detected: true,
            port: 11450,
            models: [TEST_MODELS.SMALL],
          },
        },
      });

      expect(parsed).toMatchObject({
        platform: 'linux',
        arch: 'x64',
        gpuName: 'RTX-4090',
        gpuVramMb: 24576,
        ollamaPort: 11450,
        models: [TEST_MODELS.SMALL],
      });
      expect(parsed.capabilitiesJson).toBeTruthy();
    });

    it('falls back to nulls when probe capabilities are minimal', () => {
      const parsed = probe.parseProbeResponse({
        capabilities: {},
      });
      expect(parsed.platform).toBe(null);
      expect(parsed.arch).toBe(null);
      expect(parsed.gpuName).toBe(null);
      expect(parsed.ollamaPort).toBe(null);
      expect(parsed.models).toEqual([]);
    });

    it('maps probe values into workstation update payloads', () => {
      const parsed = {
        platform: 'linux',
        arch: 'arm64',
        capabilitiesJson: JSON.stringify({ gpu: { detected: true, name: 'M3', vram_mb: 8192 } }),
        gpuName: 'M3',
        gpuVramMb: 8192,
        ollamaPort: 11456,
        models: ['model-a', 'model-b'],
      };

      const updates = probe.probeToWorkstationUpdates(parsed);
      expect(updates).toMatchObject({
        platform: 'linux',
        arch: 'arm64',
        gpu_name: 'M3',
        gpu_vram_mb: 8192,
        ollama_port: 11456,
      });
      expect(updates.models_cache).toBe(JSON.stringify(['model-a', 'model-b']));
      expect(updates.models_updated_at).toBeTruthy();
    });

    it('omits ollama model updates when probe has no ollama port', () => {
      const parsed = probe.parseProbeResponse({
        platform: 'linux',
        arch: 'arm64',
        capabilities: { gpu: { detected: false } },
      });
      const updates = probe.probeToWorkstationUpdates(parsed);
      expect(updates.ollama_port).toBeUndefined();
      expect(updates.models_cache).toBeUndefined();
    });
  });

  describe('routing', () => {
    it('routes test workloads to test-runners capability', () => {
      createWs({
        name: 'runner-1',
        status: 'healthy',
        capabilities: { test_runners: { detected: true }, command_exec: true },
      });
      createWs({
        name: 'runner-2',
        status: 'healthy',
        capabilities: { command_exec: true },
      });

      const selection = routing.findWorkstationForTask({
        provider: 'codex',
        verify_command: 'vitest run tests',
        tool: null,
      });

      expect(selection.name).toBe('runner-1');
    });

    it('routes ollama workloads by model when possible', () => {
      createWs({
        name: 'ollama-a',
        status: 'healthy',
        capabilities: { ollama: { detected: true } },
        models_cache: JSON.stringify([TEST_MODELS.SMALL, 'llama3']),
      });
      createWs({
        name: 'ollama-b',
        status: 'healthy',
        capabilities: { ollama: { detected: true } },
        models_cache: JSON.stringify(['codellama']),
      });

      const selection = routing.findWorkstationForTask({
        provider: 'ollama',
        model: 'codellama',
        verify_command: 'run',
      });
      expect(selection.name).toBe('ollama-b');
    });

    it('falls back to the default workstation when no signal matches', () => {
      createWs({
        name: 'fallback-default',
        is_default: true,
        status: 'healthy',
        capabilities: { command_exec: true },
      });

      const selection = routing.findWorkstationForTask({
        provider: 'provider-x',
        verify_command: 'some-command',
      });
      expect(selection.name).toBe('fallback-default');
    });

    it('returns null when no enabled workstation is selectable', () => {
      createWs({
        name: 'unavailable',
        enabled: false,
        capabilities: { command_exec: true },
      });
      const selection = routing.findWorkstationForTask({ provider: 'codex', verify_command: 'noop' });
      expect(selection).toBe(null);
    });

    it('skips workstations that are at capacity', () => {
      createWs({
        name: 'full-default',
        is_default: true,
        enabled: true,
        status: 'healthy',
        max_concurrent: 1,
        running_tasks: 1,
        capabilities: { command_exec: true },
      });

      const selection = routing.findWorkstationForTask({
        provider: 'codex',
        verify_command: 'noop',
      });
      expect(selection).toBe(null);
    });
  });

  describe('failover helpers', () => {
    it('findFailoverWorkstation excludes downed workstations and respects exclude id', () => {
      const primary = createWs({
        name: 'primary-failover',
        capabilities: { command_exec: { detected: true } },
      });
      createWs({
        name: 'downed-failover',
        status: 'down',
        capabilities: { command_exec: { detected: true } },
      });
      const candidate = createWs({
        name: 'candidate-failover',
        status: 'healthy',
        capabilities: { command_exec: { detected: true } },
        running_tasks: 1,
      });

      const found = failover.findFailoverWorkstation('command_exec', primary.id);
      expect(found).toBeTruthy();
      expect(found.id).toBe(candidate.id);
    });

    it('findFailoverWorkstation picks least loaded by running_tasks', () => {
      const candidateA = createWs({
        name: 'candidate-heavy',
        running_tasks: 5,
        max_concurrent: 10,
        status: 'healthy',
        capabilities: { command_exec: { detected: true } },
      });
      const candidateB = createWs({
        name: 'candidate-light',
        running_tasks: 1,
        max_concurrent: 10,
        status: 'healthy',
        capabilities: { command_exec: { detected: true } },
      });
      createWs({
        name: 'candidate-medium',
        running_tasks: 2,
        max_concurrent: 10,
        status: 'healthy',
        capabilities: { command_exec: { detected: true } },
      });

      const found = failover.findFailoverWorkstation('command_exec', 'some-downed-id');
      expect(found.id).toBe(candidateB.id);
      expect(found.running_tasks).toBeLessThan(candidateA.running_tasks);
    });

    it('findFailoverWorkstation returns null when none qualifies', () => {
      createWs({
        name: 'only-down',
        status: 'down',
        capabilities: { command_exec: { detected: true } },
      });

      const found = failover.findFailoverWorkstation('command_exec', 'other-id');
      expect(found).toBe(null);
    });
  });
});