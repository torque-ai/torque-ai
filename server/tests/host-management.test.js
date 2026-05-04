const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const configCore = require('../db/config-core');
const taskCore = require('../db/task-core');

let testDir, db, mod;
const { setupTestDbOnly, teardownTestDb, rawDb: _rawDb } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');

function setup() {
  ({ db, testDir } = setupTestDbOnly('host-mgmt-'));
  mod = require('../db/host/management');
  mod.setDb(db.getDbInstance());
  mod.setGetTask((id) => taskCore.getTask(id));
  mod.setGetProjectRoot((dir) => dir); // identity for tests
}

function teardown() {
  teardownTestDb();
}

function rawDb() {
  return _rawDb();
}

function resetTables() {
  const conn = rawDb();
  for (const table of [
    'ollama_hosts', 'project_tuning', 'benchmark_results',
    'complexity_routing', 'routing_rules', 'tasks', 'workstations'
  ]) {
    try { conn.prepare(`DELETE FROM ${table}`).run(); } catch {}
  }
}

let hostSeq = 0;
function makeHost(overrides = {}) {
  hostSeq++;
  const payload = {
    id: overrides.id || `synth-host-${hostSeq}`,
    name: overrides.name || `SynthHost-${hostSeq}`,
    url: overrides.url || `http://synth-host-${hostSeq}.local:11434`,
    max_concurrent: overrides.max_concurrent != null ? overrides.max_concurrent : 4,
    memory_limit_mb: overrides.memory_limit_mb || 8192,
  };
  return mod.addOllamaHost(payload);
}

function setHostModels(hostId, models, status = 'healthy') {
  mod.updateOllamaHost(hostId, {
    models_cache: JSON.stringify(models.map(m => typeof m === 'string' ? { name: m } : m)),
    models_updated_at: new Date().toISOString(),
    status,
    consecutive_failures: 0,
  });
}

function makeTask(overrides = {}) {
  const payload = {
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'host-mgmt test task',
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    priority: overrides.priority || 0,
  };
  taskCore.createTask(payload);
  return taskCore.getTask(payload.id);
}

describe('host-management module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetTables(); });

  // ================================================================
  // 1. Basic CRUD
  // ================================================================
  describe('host CRUD', () => {
    it('addOllamaHost creates a host and returns it with parsed fields', () => {
      const host = makeHost({ id: 'crud-add', name: 'CRUD-Add' });
      expect(host.id).toBe('crud-add');
      expect(host.name).toBe('CRUD-Add');
      expect(host.enabled).toBe(1);
      expect(host.status).toBe('unknown');
      expect(host.running_tasks).toBe(0);
      expect(host.models).toEqual([]);
      expect(host.memory_limit_mb).toBe(8192);
    });

    it('addOllamaHost defaults memory_limit_mb to 8192 when not specified', () => {
      const host = mod.addOllamaHost({
        id: 'no-mem', name: 'NoMem', url: 'http://no-mem:11434',
      });
      expect(host.memory_limit_mb).toBe(8192);
    });

    it('getOllamaHost returns null for missing host', () => {
      expect(mod.getOllamaHost('missing-host')).toBeUndefined();
    });

    it('getOllamaHost parses models_cache JSON', () => {
      const _host = makeHost({ id: 'cache-parse' });
      mod.updateOllamaHost('cache-parse', {
        models_cache: JSON.stringify([{ name: 'synth-model:7b' }])
      });
      const fetched = mod.getOllamaHost('cache-parse');
      expect(fetched.models).toEqual([{ name: 'synth-model:7b' }]);
    });

    it('getOllamaHost returns empty models for invalid JSON in models_cache', () => {
      const _host = makeHost({ id: 'bad-json' });
      rawDb().prepare('UPDATE ollama_hosts SET models_cache = ? WHERE id = ?')
        .run('not-valid-json', 'bad-json');
      const fetched = mod.getOllamaHost('bad-json');
      expect(fetched.models).toEqual([]);
    });

    it('getOllamaHostByUrl retrieves host by URL', () => {
      makeHost({ id: 'url-lookup', url: 'http://url-lookup.local:11434' });
      const found = mod.getOllamaHostByUrl('http://url-lookup.local:11434');
      expect(found).toBeTruthy();
      expect(found.id).toBe('url-lookup');
    });

    it('getOllamaHostByUrl returns undefined for unknown URL', () => {
      expect(mod.getOllamaHostByUrl('http://unknown.local:11434')).toBeUndefined();
    });

    it('listOllamaHosts returns all hosts sorted by running_tasks', () => {
      const _h1 = makeHost({ id: 'list-a', name: 'A' });
      const _h2 = makeHost({ id: 'list-b', name: 'B' });
      mod.updateOllamaHost('list-a', { running_tasks: 3 });
      mod.updateOllamaHost('list-b', { running_tasks: 1 });

      const hosts = mod.listOllamaHosts();
      expect(hosts.length).toBe(2);
      expect(hosts[0].id).toBe('list-b'); // fewer running tasks first
    });

    it('listOllamaHosts filters by enabled and status', () => {
      makeHost({ id: 'en-1' });
      makeHost({ id: 'en-2' });
      mod.updateOllamaHost('en-1', { enabled: 0, status: 'down' });
      mod.updateOllamaHost('en-2', { status: 'healthy' });

      const enabledOnly = mod.listOllamaHosts({ enabled: true });
      expect(enabledOnly.length).toBe(1);
      expect(enabledOnly[0].id).toBe('en-2');

      const healthyOnly = mod.listOllamaHosts({ status: 'healthy' });
      expect(healthyOnly.length).toBe(1);
      expect(healthyOnly[0].id).toBe('en-2');
    });

    it('updateOllamaHost updates allowed fields and ignores others', () => {
      makeHost({ id: 'upd-host' });
      const updated = mod.updateOllamaHost('upd-host', {
        name: 'Updated',
        status: 'healthy',
        running_tasks: 2,
        bad_field: 'ignored',
      });
      expect(updated.name).toBe('Updated');
      expect(updated.status).toBe('healthy');
      expect(updated.running_tasks).toBe(2);
    });

    it('updateOllamaHost returns unchanged host when no allowed fields given', () => {
      makeHost({ id: 'noop-upd' });
      const result = mod.updateOllamaHost('noop-upd', { unknown_field: 42 });
      expect(result.id).toBe('noop-upd');
    });

    it('removeOllamaHost deletes host and returns the removed record', () => {
      makeHost({ id: 'remove-me' });
      const removed = mod.removeOllamaHost('remove-me');
      expect(removed).toBeTruthy();
      expect(removed.id).toBe('remove-me');
      expect(mod.getOllamaHost('remove-me')).toBeUndefined();
    });

    it('removeOllamaHost returns null for missing host', () => {
      expect(mod.removeOllamaHost('nonexistent')).toBeNull();
    });
  });

  // ================================================================
  // 2. State transitions: enable, disable, recover
  // ================================================================
  describe('state transitions', () => {
    it('disableOllamaHost sets enabled to 0', () => {
      makeHost({ id: 'dis-host' });
      const result = mod.disableOllamaHost('dis-host');
      expect(result.enabled).toBe(0);
    });

    it('enableOllamaHost sets enabled to 1', () => {
      makeHost({ id: 'enable-host' });
      mod.disableOllamaHost('enable-host');
      const result = mod.enableOllamaHost('enable-host');
      expect(result.enabled).toBe(1);
    });

    it('recoverOllamaHost resets status and failures', () => {
      makeHost({ id: 'recover-host' });
      mod.updateOllamaHost('recover-host', { status: 'down', consecutive_failures: 5 });
      const result = mod.recoverOllamaHost('recover-host');
      expect(result.status).toBe('unknown');
      expect(result.consecutive_failures).toBe(0);
    });
  });

  // ================================================================
  // 3. cleanupNullIdHosts
  // ================================================================
  describe('cleanupNullIdHosts', () => {
    it('removes hosts with null or empty IDs', () => {
      // Insert corrupt rows directly
      rawDb().prepare(
        "INSERT INTO ollama_hosts (id, name, url, enabled, status, created_at) VALUES (NULL, 'bad1', 'http://bad1:1', 1, 'unknown', ?)"
      ).run(new Date().toISOString());
      rawDb().prepare(
        "INSERT INTO ollama_hosts (id, name, url, enabled, status, created_at) VALUES ('', 'bad2', 'http://bad2:1', 1, 'unknown', ?)"
      ).run(new Date().toISOString());
      makeHost({ id: 'good-host' });

      const deleted = mod.cleanupNullIdHosts();
      expect(deleted).toBe(2);
      // Good host still present
      expect(mod.getOllamaHost('good-host')).toBeTruthy();
    });

    it('returns 0 when no corrupt hosts exist', () => {
      makeHost({ id: 'clean-host' });
      expect(mod.cleanupNullIdHosts()).toBe(0);
    });
  });

  // ================================================================
  // 4. Host settings
  // ================================================================
  describe('host settings', () => {
    it('getHostSettings returns merged global + host-specific settings', () => {
      makeHost({ id: 'settings-host' });
      mod.setHostSettings('settings-host', { num_gpu: 2, keep_alive: '10m' });
      const settings = mod.getHostSettings('settings-host');
      expect(settings.num_gpu).toBe(2);
      expect(settings.keep_alive).toBe('10m');
      expect(settings.hostId).toBe('settings-host');
      expect(settings.hostName).toBeTruthy();
      // Global defaults should still be present
      expect(typeof settings.temperature).toBe('number');
    });

    it('getHostSettings returns null for missing host', () => {
      expect(mod.getHostSettings('nonexistent')).toBeNull();
    });

    it('setHostSettings merges with existing settings', () => {
      makeHost({ id: 'merge-settings' });
      mod.setHostSettings('merge-settings', { num_gpu: 1 });
      mod.setHostSettings('merge-settings', { num_ctx: 4096 });
      const host = mod.getOllamaHost('merge-settings');
      const parsed = JSON.parse(host.settings);
      expect(parsed.num_gpu).toBe(1);
      expect(parsed.num_ctx).toBe(4096);
    });

    it('setHostSettings removes null values', () => {
      makeHost({ id: 'null-settings' });
      mod.setHostSettings('null-settings', { num_gpu: 1, keep_alive: '5m' });
      mod.setHostSettings('null-settings', { num_gpu: null });
      const host = mod.getOllamaHost('null-settings');
      const parsed = JSON.parse(host.settings);
      expect(parsed.num_gpu).toBeUndefined();
      expect(parsed.keep_alive).toBe('5m');
    });

    it('setHostSettings returns null for missing host', () => {
      expect(mod.setHostSettings('nonexistent', { num_gpu: 1 })).toBeNull();
    });
  });

  // ================================================================
  // 5. Project tuning CRUD
  // ================================================================
  describe('project tuning', () => {
    it('setProjectTuning creates and getProjectTuning retrieves settings', () => {
      mod.setProjectTuning('/proj/alpha', { temperature: 0.5, num_ctx: 4096 }, 'Alpha project');
      const result = mod.getProjectTuning('/proj/alpha');
      expect(result).toBeTruthy();
      expect(result.projectPath).toBe('/proj/alpha');
      expect(result.settings.temperature).toBe(0.5);
      expect(result.settings.num_ctx).toBe(4096);
      expect(result.description).toBe('Alpha project');
    });

    it('setProjectTuning merges with existing settings', () => {
      mod.setProjectTuning('/proj/merge', { temperature: 0.3 });
      mod.setProjectTuning('/proj/merge', { num_ctx: 16384 }, 'Updated');
      const result = mod.getProjectTuning('/proj/merge');
      expect(result.settings.temperature).toBe(0.3);
      expect(result.settings.num_ctx).toBe(16384);
      expect(result.description).toBe('Updated');
    });

    it('getProjectTuning returns null for missing path', () => {
      expect(mod.getProjectTuning('/nonexistent/path')).toBeNull();
    });

    it('deleteProjectTuning removes tuning settings', () => {
      mod.setProjectTuning('/proj/delete-me', { temperature: 0.1 });
      mod.deleteProjectTuning('/proj/delete-me');
      expect(mod.getProjectTuning('/proj/delete-me')).toBeNull();
    });

    it('listProjectTuning returns all configurations sorted by updated_at DESC', () => {
      mod.setProjectTuning('/proj/first', { temperature: 0.2 });
      // Manually backdate the first entry so /proj/second is strictly newer
      rawDb().prepare("UPDATE project_tuning SET updated_at = '2020-01-01T00:00:00.000Z' WHERE project_path = ?")
        .run('/proj/first');
      mod.setProjectTuning('/proj/second', { temperature: 0.4 });
      const list = mod.listProjectTuning();
      expect(list.length).toBe(2);
      // Most recently updated first
      expect(list[0].projectPath).toBe('/proj/second');
    });

    it('getMergedProjectTuning merges global defaults with project overrides', () => {
      mod.setProjectTuning(testDir, { temperature: 0.7, num_ctx: 32768 });
      const merged = mod.getMergedProjectTuning(testDir);
      expect(merged.temperature).toBe(0.7);
      expect(merged.num_ctx).toBe(32768);
      // Globals still present for non-overridden fields
      expect(typeof merged.top_p).toBe('number');
      expect(typeof merged.top_k).toBe('number');
    });

    it('getMergedProjectTuning returns only globals when no project tuning exists', () => {
      const merged = mod.getMergedProjectTuning('/no/project/tuning');
      expect(typeof merged.temperature).toBe('number');
      expect(typeof merged.num_ctx).toBe('number');
    });
  });

  // ================================================================
  // 6. Slot reservation
  // ================================================================
  describe('tryReserveHostSlot / releaseHostSlot', () => {
    it('tryReserveHostSlot acquires slot when under capacity', () => {
      makeHost({ id: 'slot-ok', max_concurrent: 3 });
      mod.updateOllamaHost('slot-ok', { running_tasks: 1 });
      const result = mod.tryReserveHostSlot('slot-ok');
      expect(result.acquired).toBe(true);
      expect(result.currentLoad).toBe(2);
      expect(result.maxCapacity).toBe(3);
    });

    it('tryReserveHostSlot fails when at capacity', () => {
      makeHost({ id: 'slot-full', max_concurrent: 2 });
      mod.updateOllamaHost('slot-full', { running_tasks: 2 });
      const result = mod.tryReserveHostSlot('slot-full');
      expect(result.acquired).toBe(false);
      expect(result.currentLoad).toBe(2);
      expect(result.maxCapacity).toBe(2);
    });

    it('tryReserveHostSlot returns error for missing host', () => {
      const result = mod.tryReserveHostSlot('nonexistent');
      expect(result.acquired).toBe(false);
      expect(result.error).toBe('Host not found');
    });

    it('tryReserveHostSlot always allows when max_concurrent is 0', () => {
      makeHost({ id: 'slot-unlimited', max_concurrent: 0 });
      mod.updateOllamaHost('slot-unlimited', { running_tasks: 100, max_concurrent: 0 });
      const result = mod.tryReserveHostSlot('slot-unlimited');
      expect(result.acquired).toBe(true);
    });

    it('releaseHostSlot decrements running_tasks and clamps to 0', () => {
      makeHost({ id: 'release-slot' });
      mod.updateOllamaHost('release-slot', { running_tasks: 2 });
      mod.releaseHostSlot('release-slot');
      let host = mod.getOllamaHost('release-slot');
      expect(host.running_tasks).toBe(1);

      mod.releaseHostSlot('release-slot');
      mod.releaseHostSlot('release-slot'); // below 0 should clamp
      host = mod.getOllamaHost('release-slot');
      expect(host.running_tasks).toBe(0);
    });
  });

  // ================================================================
  // 7. Warm model tracking
  // ================================================================
  describe('recordHostModelUsage / isHostModelWarm', () => {
    it('recordHostModelUsage stores last_model_used and model_loaded_at', () => {
      makeHost({ id: 'warm-host' });
      mod.recordHostModelUsage('warm-host', 'synth-model:7b');
      const host = mod.getOllamaHost('warm-host');
      expect(host.last_model_used).toBe('synth-model:7b');
      expect(host.model_loaded_at).toBeTruthy();
    });

    it('isHostModelWarm returns true for recently used model', () => {
      makeHost({ id: 'warm-check' });
      mod.recordHostModelUsage('warm-check', 'synth-model:7b');
      const result = mod.isHostModelWarm('warm-check', 'synth-model:7b');
      expect(result.isWarm).toBe(true);
      expect(typeof result.lastUsedSeconds).toBe('number');
      expect(result.lastUsedSeconds).toBeLessThan(5);
    });

    it('isHostModelWarm returns false for different model', () => {
      makeHost({ id: 'warm-diff' });
      mod.recordHostModelUsage('warm-diff', 'synth-model:7b');
      const result = mod.isHostModelWarm('warm-diff', 'other-model:14b');
      expect(result.isWarm).toBe(false);
      expect(result.lastUsedSeconds).toBeNull();
    });

    it('isHostModelWarm returns false for expired warm window', () => {
      makeHost({ id: 'warm-old' });
      mod.recordHostModelUsage('warm-old', 'synth-model:7b');
      // Backdate model_loaded_at by 10 minutes
      rawDb().prepare('UPDATE ollama_hosts SET model_loaded_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 10 * 60 * 1000).toISOString(), 'warm-old');
      const result = mod.isHostModelWarm('warm-old', 'synth-model:7b');
      expect(result.isWarm).toBe(false);
      expect(result.lastUsedSeconds).toBeGreaterThan(500);
    });

    it('isHostModelWarm is case-insensitive', () => {
      makeHost({ id: 'warm-case' });
      mod.recordHostModelUsage('warm-case', 'Synth-Model:7B');
      const result = mod.isHostModelWarm('warm-case', 'synth-model:7b');
      expect(result.isWarm).toBe(true);
    });

    it('isHostModelWarm returns false for missing host', () => {
      const result = mod.isHostModelWarm('nonexistent', 'any-model');
      expect(result.isWarm).toBe(false);
      expect(result.lastUsedSeconds).toBeNull();
    });
  });

  // ================================================================
  // 8. Health check recording
  // ================================================================
  describe('recordHostHealthCheck', () => {
    it('records healthy check with models', () => {
      makeHost({ id: 'health-ok' });
      const result = mod.recordHostHealthCheck('health-ok', true, [{ name: 'synth:7b' }]);
      expect(result.status).toBe('healthy');
      expect(result.consecutive_failures).toBe(0);
      expect(result.models).toEqual([{ name: 'synth:7b' }]);
    });

    it('records unhealthy check and increments failures', () => {
      makeHost({ id: 'health-fail' });
      mod.recordHostHealthCheck('health-fail', false);
      let host = mod.getOllamaHost('health-fail');
      expect(host.consecutive_failures).toBe(1);
      expect(host.status).toBe('degraded');

      mod.recordHostHealthCheck('health-fail', false);
      mod.recordHostHealthCheck('health-fail', false);
      host = mod.getOllamaHost('health-fail');
      expect(host.consecutive_failures).toBe(3);
      expect(host.status).toBe('down');
    });

    it('returns null for missing host', () => {
      expect(mod.recordHostHealthCheck('nonexistent', true)).toBeNull();
    });
  });

  // ================================================================
  // 9. fetchHostModelsSync (with mocked spawnSync)
  // ================================================================
  describe('fetchHostModelsSync', () => {
    it('returns null for invalid URL', async () => {
      expect(await mod.fetchHostModelsSync('not-a-valid-url')).toBeNull();
    });

    it('returns null when curl fails (connection refused)', async () => {
      // Use a non-routable address to trigger failure
      const result = await mod.fetchHostModelsSync('http://192.0.2.254:11434', 1000);
      expect(result).toBeNull();
    });
  });

  // ================================================================
  // 10. selectOllamaHostForModel
  // ================================================================
  describe('selectOllamaHostForModel', () => {
    it('returns no-hosts error when no enabled hosts exist', () => {
      const result = mod.selectOllamaHostForModel('synth-model:7b');
      expect(result.host).toBeNull();
      expect(result.reason).toContain('No healthy');
    });

    it('selects least-loaded host with the requested model', () => {
      const _h1 = makeHost({ id: 'sel-a', max_concurrent: 4 });
      const _h2 = makeHost({ id: 'sel-b', max_concurrent: 4 });
      setHostModels('sel-a', ['synth-test-model:7b']);
      setHostModels('sel-b', ['synth-test-model:7b']);
      mod.updateOllamaHost('sel-a', { running_tasks: 3 });
      mod.updateOllamaHost('sel-b', { running_tasks: 1 });

      const result = mod.selectOllamaHostForModel('synth-test-model:7b');
      expect(result.host).toBeTruthy();
      expect(result.host.id).toBe('sel-b');
    });

    it('returns at-capacity error when all hosts are at capacity', () => {
      makeHost({ id: 'cap-a', max_concurrent: 1 });
      setHostModels('cap-a', ['synth-test-model:7b']);
      mod.updateOllamaHost('cap-a', { running_tasks: 1 });

      const result = mod.selectOllamaHostForModel('synth-test-model:7b');
      expect(result.host).toBeNull();
      expect(result.atCapacity).toBe(true);
    });

    it('returns model-not-found error with available models list', () => {
      makeHost({ id: 'no-model' });
      setHostModels('no-model', ['other-model:14b']);

      const result = mod.selectOllamaHostForModel('synth-missing-model:7b');
      expect(result.host).toBeNull();
      expect(result.reason).toContain('No host has model');
      expect(Array.isArray(result.availableModels)).toBe(true);
    });

    it('skips down hosts', () => {
      makeHost({ id: 'down-host' });
      setHostModels('down-host', ['synth-test-model:7b'], 'down');

      const result = mod.selectOllamaHostForModel('synth-test-model:7b');
      expect(result.host).toBeNull();
    });

    it('falls back to base model matching when no explicit tag', () => {
      makeHost({ id: 'base-match' });
      setHostModels('base-match', ['synth-base:14b']);

      const result = mod.selectOllamaHostForModel('synth-base');
      expect(result.host).toBeTruthy();
      expect(result.host.id).toBe('base-match');
    });

    it('does NOT fall back to base model matching with explicit tag', () => {
      makeHost({ id: 'tag-strict' });
      setHostModels('tag-strict', ['synth-base:14b']);

      const result = mod.selectOllamaHostForModel('synth-base:7b');
      expect(result.host).toBeNull();
    });

    it('returns least-loaded host with models when no model specified', () => {
      makeHost({ id: 'any-a', max_concurrent: 4 });
      makeHost({ id: 'any-b', max_concurrent: 4 });
      setHostModels('any-a', ['some-model:7b']);
      setHostModels('any-b', ['some-model:7b']);
      mod.updateOllamaHost('any-a', { running_tasks: 2 });
      mod.updateOllamaHost('any-b', { running_tasks: 0 });

      const result = mod.selectOllamaHostForModel(null);
      expect(result.host).toBeTruthy();
      expect(result.host.id).toBe('any-b');
    });

    it('reports at-capacity when explicit-tag model only exists on full hosts', () => {
      makeHost({ id: 'full-tag', max_concurrent: 1 });
      setHostModels('full-tag', ['synth-model:32b']);
      mod.updateOllamaHost('full-tag', { running_tasks: 1 });

      makeHost({ id: 'avail-other', max_concurrent: 4 });
      setHostModels('avail-other', ['synth-model:7b']);

      const result = mod.selectOllamaHostForModel('synth-model:32b');
      expect(result.host).toBeNull();
      expect(result.atCapacity).toBe(true);
    });
  });

  // ================================================================
  // 11. selectHostWithModelVariant
  // ================================================================
  describe('selectHostWithModelVariant', () => {
    it('returns no-hosts error when no hosts available', () => {
      const result = mod.selectHostWithModelVariant('synth-model');
      expect(result.host).toBeNull();
      expect(result.reason).toContain('No healthy');
    });

    it('selects a host with a matching base model variant', () => {
      makeHost({ id: 'variant-a', max_concurrent: 4 });
      setHostModels('variant-a', ['synth-model:32b']);

      const result = mod.selectHostWithModelVariant('synth-model');
      expect(result.host).toBeTruthy();
      expect(result.model).toBe('synth-model:32b');
    });

    it('returns available models when no host has the base model', () => {
      makeHost({ id: 'var-miss' });
      setHostModels('var-miss', ['other-model:7b']);

      const result = mod.selectHostWithModelVariant('synth-nonexistent');
      expect(result.host).toBeNull();
      expect(Array.isArray(result.availableModels)).toBe(true);
      expect(result.availableModels).toContain('other-model');
    });

    it('skips hosts at capacity', () => {
      makeHost({ id: 'var-full', max_concurrent: 1 });
      setHostModels('var-full', ['synth-model:7b']);
      mod.updateOllamaHost('var-full', { running_tasks: 1 });

      makeHost({ id: 'var-avail', max_concurrent: 4 });
      setHostModels('var-avail', ['synth-model:14b']);

      const result = mod.selectHostWithModelVariant('synth-model');
      expect(result.host.id).toBe('var-avail');
      expect(result.model).toBe('synth-model:14b');
    });
  });

  // ================================================================
  // 12. Benchmark results
  // ================================================================
  describe('benchmark results', () => {
    it('recordBenchmarkResult and getBenchmarkResults round-trip data', () => {
      makeHost({ id: 'bench-host' });
      mod.recordBenchmarkResult({
        hostId: 'bench-host',
        model: 'synth-model:7b',
        testType: 'basic',
        promptType: 'code',
        tokensPerSecond: 45.67,
        promptTokens: 100,
        outputTokens: 200,
        evalDurationSeconds: 4.38,
        numGpu: 1,
        numCtx: 4096,
        temperature: 0.3,
        success: true,
      });

      const results = mod.getBenchmarkResults('bench-host');
      expect(results.length).toBe(1);
      expect(results[0].model).toBe('synth-model:7b');
      expect(results[0].tokens_per_second).toBeCloseTo(45.67);
      expect(results[0].success).toBe(true);
    });

    it('getBenchmarkResults respects limit', () => {
      makeHost({ id: 'bench-limit' });
      for (let i = 0; i < 5; i++) {
        mod.recordBenchmarkResult({
          hostId: 'bench-limit',
          model: 'synth-model:7b',
          testType: 'basic',
          tokensPerSecond: 10 + i,
          success: true,
        });
      }
      const results = mod.getBenchmarkResults('bench-limit', 3);
      expect(results.length).toBe(3);
    });

    it('getOptimalSettingsFromBenchmarks returns best config', () => {
      makeHost({ id: 'bench-opt' });
      mod.recordBenchmarkResult({
        hostId: 'bench-opt', model: 'synth:7b', testType: 'basic',
        tokensPerSecond: 30, numGpu: 1, numCtx: 4096, success: true,
      });
      mod.recordBenchmarkResult({
        hostId: 'bench-opt', model: 'synth:7b', testType: 'basic',
        tokensPerSecond: 50, numGpu: 2, numCtx: 8192, success: true,
      });

      const optimal = mod.getOptimalSettingsFromBenchmarks('bench-opt', 'synth:7b');
      expect(optimal).toBeTruthy();
      expect(optimal.tokensPerSecond).toBe(50);
      expect(optimal.numGpu).toBe(2);
    });

    it('getOptimalSettingsFromBenchmarks returns null when no results', () => {
      expect(mod.getOptimalSettingsFromBenchmarks('nonexistent')).toBeNull();
    });

    it('applyBenchmarkResults applies and reports settings', () => {
      makeHost({ id: 'bench-apply' });
      mod.recordBenchmarkResult({
        hostId: 'bench-apply', model: 'synth:7b', testType: 'basic',
        tokensPerSecond: 40, numGpu: 1, numCtx: 4096, success: true,
      });

      const result = mod.applyBenchmarkResults('bench-apply', 'synth:7b');
      expect(result.applied).toBe(true);
      expect(result.settings.num_gpu).toBe(1);
    });

    it('applyBenchmarkResults returns not-applied when no benchmarks', () => {
      makeHost({ id: 'bench-no-data' });
      const result = mod.applyBenchmarkResults('bench-no-data');
      expect(result.applied).toBe(false);
      expect(result.reason).toContain('No benchmark results');
    });

    it('getBenchmarkStats returns summary statistics', () => {
      makeHost({ id: 'bench-stats' });
      mod.recordBenchmarkResult({
        hostId: 'bench-stats', model: 'fast:4b', testType: 'basic',
        tokensPerSecond: 20, success: true,
      });
      mod.recordBenchmarkResult({
        hostId: 'bench-stats', model: 'fast:4b', testType: 'basic',
        tokensPerSecond: 30, success: true,
      });
      mod.recordBenchmarkResult({
        hostId: 'bench-stats', model: 'slow:32b', testType: 'basic',
        tokensPerSecond: 10, success: true,
      });

      const stats = mod.getBenchmarkStats('bench-stats');
      expect(stats.totalRuns).toBe(3);
      expect(stats.avgTps).toBeGreaterThan(0);
      expect(stats.maxTps).toBe(30);
      expect(stats.bestModel).toBe('fast:4b');
    });

    it('getBenchmarkStats returns zeros for no data', () => {
      const stats = mod.getBenchmarkStats('no-bench-host');
      expect(stats.totalRuns).toBe(0);
      expect(stats.avgTps).toBeNull();
    });
  });

  // ================================================================
  // 13. incrementHostTasks / decrementHostTasks (deprecated but still exported)
  // ================================================================
  describe('incrementHostTasks / decrementHostTasks', () => {
    it('incrementHostTasks increases running_tasks', () => {
      makeHost({ id: 'inc-host' });
      mod.incrementHostTasks('inc-host');
      mod.incrementHostTasks('inc-host');
      const host = mod.getOllamaHost('inc-host');
      expect(host.running_tasks).toBe(2);
    });

    it('decrementHostTasks decreases running_tasks, clamped to 0', () => {
      makeHost({ id: 'dec-host' });
      mod.incrementHostTasks('dec-host');
      mod.decrementHostTasks('dec-host');
      mod.decrementHostTasks('dec-host'); // should not go below 0
      const host = mod.getOllamaHost('dec-host');
      expect(host.running_tasks).toBe(0);
    });
  });

  // ================================================================
  // 14. getAggregatedModels
  // ================================================================
  describe('getAggregatedModels', () => {
    it('aggregates models from all healthy hosts', () => {
      makeHost({ id: 'agg-a' });
      makeHost({ id: 'agg-b' });
      setHostModels('agg-a', ['synth-model:7b', 'synth-model:14b']);
      setHostModels('agg-b', ['synth-model:7b', 'another:3b']);

      const models = mod.getAggregatedModels();
      expect(models.length).toBe(3); // synth-model:7b, synth-model:14b, another:3b
      const shared = models.find(m => m.name === 'synth-model:7b');
      expect(shared.hosts.length).toBe(2);
    });

    it('excludes non-healthy hosts', () => {
      makeHost({ id: 'agg-down' });
      setHostModels('agg-down', ['synth-model:7b'], 'down');

      const models = mod.getAggregatedModels();
      expect(models.length).toBe(0);
    });
  });

  // ================================================================
  // 15. Routing rules
  // ================================================================
  describe('routing rules', () => {
    it('addRoutingRule inserts into complexity_routing', () => {
      const rule = mod.addRoutingRule({
        name: 'test-rule',
        complexity: 'normal',
        target_provider: 'ollama',
        target_host: 'host-1',
        model: 'synth:7b',
        priority: 5,
      });
      expect(rule.name).toBe('test-rule');
      expect(rule.complexity).toBe('normal');
    });

    it('routeTask returns matching rule for a complexity level', () => {
      rawDb().prepare('DELETE FROM complexity_routing').run();
      // Insert directly into complexity_routing (routeTask queries this table, not routing_rules)
      rawDb().prepare(`
        INSERT INTO complexity_routing (name, complexity, target_provider, model, priority, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run('simple-route', 'simple', 'ollama', 'fast:4b', 10, new Date().toISOString());

      const routed = mod.routeTask('simple');
      expect(routed).toBeTruthy();
      expect(routed.provider).toBe('ollama');
      expect(routed.model).toBe('fast:4b');
    });

    it('routeTask returns null when no rule matches', () => {
      rawDb().prepare('DELETE FROM complexity_routing').run();
      expect(mod.routeTask('nonexistent-complexity')).toBeNull();
    });

    it('routeTask applies dynamic fallback when target host is unavailable', () => {
      rawDb().prepare('DELETE FROM complexity_routing').run();
      makeHost({ id: 'route-fallback' });
      setHostModels('route-fallback', [TEST_MODELS.SMALL]);

      // Insert directly into complexity_routing with a dead target_host
      rawDb().prepare(`
        INSERT INTO complexity_routing (name, complexity, target_provider, target_host, model, priority, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `).run('fallback-route', 'normal', 'ollama', 'dead-host-id', TEST_MODELS.SMALL, 10, new Date().toISOString());

      const routed = mod.routeTask('normal');
      expect(routed).toBeTruthy();
      expect(routed.fallbackApplied).toBe(true);
      expect(routed.hostId).toBe('route-fallback');
    });
  });

  // ================================================================
  // 16. Host priority
  // ================================================================
  describe('setHostPriority', () => {
    it('updates host priority', () => {
      makeHost({ id: 'prio-host' });
      mod.setHostPriority('prio-host', 5);
      const host = mod.getOllamaHost('prio-host');
      expect(host.priority).toBe(5);
    });
  });

  // ================================================================
  // 17. Task review
  // ================================================================
  describe('task review', () => {
    it('setTaskReviewStatus updates review fields on a task', () => {
      const task = makeTask({ status: 'completed' });
      rawDb().prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(task.id);
      mod.setTaskReviewStatus(task.id, 'approved', 'looks good');
      const updated = taskCore.getTask(task.id);
      expect(updated.review_status).toBe('approved');
      expect(updated.review_notes).toBe('looks good');
      expect(updated.reviewed_at).toBeTruthy();
    });

    it('getTasksPendingReview returns completed tasks without review', () => {
      const t1 = makeTask();
      const t2 = makeTask();
      rawDb().prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), t1.id);
      rawDb().prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), t2.id);
      mod.setTaskReviewStatus(t2.id, 'approved');

      const pending = mod.getTasksPendingReview();
      const ids = pending.map(t => t.id);
      expect(ids).toContain(t1.id);
      expect(ids).not.toContain(t2.id);
    });

    it('getTasksNeedingCorrection returns tasks with needs_correction status', () => {
      const task = makeTask();
      rawDb().prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(task.id);
      mod.setTaskReviewStatus(task.id, 'needs_correction', 'fix the tests');

      const corrections = mod.getTasksNeedingCorrection();
      expect(corrections.length).toBe(1);
      expect(corrections[0].review_status).toBe('needs_correction');
    });
  });

  // ================================================================
  // 18. determineTaskComplexity
  // ================================================================
  describe('determineTaskComplexity', () => {
    it('classifies documentation tasks as simple', () => {
      expect(mod.determineTaskComplexity('write a README for the project')).toBe('simple');
      expect(mod.determineTaskComplexity('update the documentation')).toBe('simple');
      expect(mod.determineTaskComplexity('write a changelog')).toBe('simple');
    });

    it('classifies test-writing tasks as normal', () => {
      expect(mod.determineTaskComplexity('write tests for the auth module')).toBe('normal');
      expect(mod.determineTaskComplexity('add xunit tests for UserService')).toBe('normal');
    });

    it('classifies stub-fill tasks as normal', () => {
      expect(mod.determineTaskComplexity('fill in the method bodies')).toBe('normal');
      expect(mod.determineTaskComplexity('replace throw not implemented in all methods')).toBe('normal');
    });

    it('classifies multi-step/wiring tasks as complex', () => {
      expect(mod.determineTaskComplexity('create a service and wire it to DI')).toBe('complex');
      expect(mod.determineTaskComplexity('implement the notification system')).toBe('complex');
    });

    it('classifies single-entity creation as normal', () => {
      expect(mod.determineTaskComplexity('create a class UserHelper')).toBe('normal');
      expect(mod.determineTaskComplexity('add a method to the repository')).toBe('normal');
    });

    it('classifies security/refactoring tasks as complex', () => {
      expect(mod.determineTaskComplexity('refactor the authentication module')).toBe('complex');
      expect(mod.determineTaskComplexity('fix the security vulnerability')).toBe('complex');
    });

    it('classifies simple patterns (rename, typo) as simple', () => {
      expect(mod.determineTaskComplexity('rename the variable')).toBe('simple');
      expect(mod.determineTaskComplexity('fix typo in config')).toBe('simple');
    });

    it('uses file count heuristics', () => {
      expect(mod.determineTaskComplexity('do this', Array(6).fill('f.ts'))).toBe('complex');
      expect(mod.determineTaskComplexity('short', ['f.ts'])).toBe('simple');
    });

    it('uses description length heuristics', () => {
      expect(mod.determineTaskComplexity('x')).toBe('simple'); // very short
      expect(mod.determineTaskComplexity('a'.repeat(600))).toBe('complex'); // very long
    });

    it('defaults to normal for medium descriptions', () => {
      expect(mod.determineTaskComplexity('do something moderately described task here please')).toBe('normal');
    });

    it('classifies tasks with 5+ bullet points as complex (P82)', () => {
      const desc = `Do the following:
- step one
- step two
- step three
- step four
- step five`;
      expect(mod.determineTaskComplexity(desc)).toBe('complex');
    });
  });

  // ================================================================
  // 19. getModelTierForComplexity
  // ================================================================
  describe('getModelTierForComplexity', () => {
    it('returns fast tier for simple', () => {
      const result = mod.getModelTierForComplexity('simple');
      expect(result.tier).toBe('fast');
    });

    it('returns balanced tier for normal', () => {
      const result = mod.getModelTierForComplexity('normal');
      expect(result.tier).toBe('balanced');
    });

    it('returns quality tier for complex', () => {
      const result = mod.getModelTierForComplexity('complex');
      expect(result.tier).toBe('quality');
    });

    it('returns quality tier as default', () => {
      const result = mod.getModelTierForComplexity('unknown');
      expect(result.tier).toBe('quality');
    });
  });

  // ================================================================
  // 20. decomposeTask
  // ================================================================
  describe('decomposeTask', () => {
    it('returns null for non-decomposable task', () => {
      expect(mod.decomposeTask('write a unit test', testDir)).toBeNull();
    });

    it('returns null for null/empty input', () => {
      expect(mod.decomposeTask(null, testDir)).toBeNull();
      expect(mod.decomposeTask('', testDir)).toBeNull();
    });

    it('decomposes "implement X service" into subtasks', () => {
      const subtasks = mod.decomposeTask('implement a Notification service', testDir);
      expect(subtasks).toBeTruthy();
      expect(subtasks.length).toBeGreaterThanOrEqual(2);
      expect(subtasks.some(s => s.includes('Notification'))).toBe(true);
    });

    it('decomposes "build X with Y" into subtasks', () => {
      const subtasks = mod.decomposeTask('build a UserManager with validation and logging', testDir);
      expect(subtasks).toBeTruthy();
      expect(subtasks.length).toBeGreaterThanOrEqual(2);
    });

    it('decomposes "create X and wire" into subtasks', () => {
      const subtasks = mod.decomposeTask('create a PaymentService and wire it', testDir);
      expect(subtasks).toBeTruthy();
      expect(subtasks.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ================================================================
  // 21. migrateToMultiHost
  // ================================================================
  describe('migrateToMultiHost', () => {
    it('returns already-migrated when hosts exist', () => {
      makeHost({ id: 'existing' });
      const result = mod.migrateToMultiHost();
      expect(result.migrated).toBe(false);
      expect(result.reason).toContain('Hosts already exist');
    });

    it('returns no-config when ollama_host config is missing', () => {
      configCore.setConfig('ollama_host', '');
      const result = mod.migrateToMultiHost();
      expect(result.migrated).toBe(false);
      expect(result.reason).toContain('No existing ollama_host config');
    });

    it('migrates from single-host config', () => {
      configCore.setConfig('ollama_host', 'http://localhost:11434');
      const result = mod.migrateToMultiHost();
      expect(result.migrated).toBe(true);
      expect(result.hostId).toBe('default');
      expect(result.url).toBe('http://localhost:11434');
      const host = mod.getOllamaHost('default');
      expect(host).toBeTruthy();
    });
  });

  // ================================================================
  // 22. reconcileHostTaskCounts
  // ================================================================
  describe('reconcileHostTaskCounts', () => {
    it('corrects drifted running_tasks counts', () => {
      makeHost({ id: 'recon-host' });
      mod.updateOllamaHost('recon-host', { running_tasks: 5 }); // drifted value

      // No tasks are actually running on this host
      const result = mod.reconcileHostTaskCounts();
      expect(result.reconciled).toBeGreaterThan(0);

      const host = mod.getOllamaHost('recon-host');
      expect(host.running_tasks).toBe(0);
    });

    it('sets correct count when tasks are running', () => {
      makeHost({ id: 'recon-run' });
      const t1 = makeTask();
      const t2 = makeTask();
      rawDb().prepare("UPDATE tasks SET status = 'running', ollama_host_id = ? WHERE id = ?")
        .run('recon-run', t1.id);
      rawDb().prepare("UPDATE tasks SET status = 'running', ollama_host_id = ? WHERE id = ?")
        .run('recon-run', t2.id);

      mod.reconcileHostTaskCounts();
      const host = mod.getOllamaHost('recon-run');
      expect(host.running_tasks).toBe(2);
    });

    it('also reconciles mapped workstation running_tasks counts', () => {
      const wsModel = require('../workstation/model');
      wsModel.createWorkstation({
        id: 'ws-recon',
        name: 'ReconWS',
        host: 'recon-ws.local',
        secret: 'test-secret',
        max_concurrent: 1,
      });

      makeHost({ id: 'recon-ws-host', url: 'http://recon-ws.local:11434' });
      wsModel.updateWorkstation('ws-recon', { running_tasks: 7 });

      const result = mod.reconcileHostTaskCounts();
      expect(result.workstations_reconciled).toBeGreaterThan(0);
      expect(wsModel.getWorkstation('ws-recon').running_tasks).toBe(0);

      const runningTask = makeTask();
      rawDb().prepare("UPDATE tasks SET status = 'running', ollama_host_id = ? WHERE id = ?")
        .run('recon-ws-host', runningTask.id);

      mod.reconcileHostTaskCounts();
      expect(wsModel.getWorkstation('ws-recon').running_tasks).toBe(1);
    });
  });

  // ================================================================
  // 23. getRunningTasksForHost
  // ================================================================
  describe('getRunningTasksForHost', () => {
    it('returns tasks running on a specific host', () => {
      makeHost({ id: 'running-host' });
      const t1 = makeTask();
      const t2 = makeTask();
      rawDb().prepare("UPDATE tasks SET status = 'running', ollama_host_id = ? WHERE id = ?")
        .run('running-host', t1.id);
      rawDb().prepare("UPDATE tasks SET status = 'completed', ollama_host_id = ? WHERE id = ?")
        .run('running-host', t2.id);

      const running = mod.getRunningTasksForHost('running-host');
      expect(running.length).toBe(1);
      expect(running[0].id).toBe(t1.id);
    });

    it('returns empty array when no tasks are running', () => {
      makeHost({ id: 'idle-host' });
      expect(mod.getRunningTasksForHost('idle-host')).toEqual([]);
    });
  });

  // ================================================================
  // 24. ensureModelsLoaded (mocked fetchHostModelsSync)
  // ================================================================
  describe('ensureModelsLoaded', () => {
    it('skips hosts that already have models cached', () => {
      makeHost({ id: 'loaded-host' });
      setHostModels('loaded-host', ['synth:7b']);

      // Should not try to fetch since models are already loaded
      const count = mod.ensureModelsLoaded();
      expect(count).toBe(0);
    });

    it('skips down hosts', () => {
      makeHost({ id: 'down-ensure' });
      mod.updateOllamaHost('down-ensure', { status: 'down' });

      const count = mod.ensureModelsLoaded();
      expect(count).toBe(0);
    });
  });

  // ================================================================
  // 25. Memory safeguard in selectOllamaHostForModel
  // ================================================================
  describe('memory safeguard', () => {
    it('rejects model that exceeds host memory limit', () => {
      makeHost({ id: 'mem-host', memory_limit_mb: 4096 });
      // Model size: 8GB = 8 * 1024 * 1024 * 1024 bytes
      setHostModels('mem-host', [{ name: 'synth-big:32b', size: 8 * 1024 * 1024 * 1024 }]);

      const result = mod.selectOllamaHostForModel('synth-big:32b');
      expect(result.host).toBeNull();
      expect(result.memoryError).toBe(true);
    });

    it('allows model that fits within memory limit', () => {
      makeHost({ id: 'mem-ok-host', memory_limit_mb: 16384 });
      // Model size: 4GB = 4 * 1024 * 1024 * 1024 bytes (with 15% overhead = 4.6GB < 16GB)
      setHostModels('mem-ok-host', [{ name: 'synth-small:7b', size: 4 * 1024 * 1024 * 1024 }]);

      const result = mod.selectOllamaHostForModel('synth-small:7b');
      expect(result.host).toBeTruthy();
      expect(result.host.id).toBe('mem-ok-host');
    });
  });

  // ================================================================
  // 26. default_model field on hosts
  // ================================================================
  describe('default_model field', () => {
    it('updateOllamaHost accepts default_model', () => {
      makeHost({ id: 'dm-host' });
      mod.updateOllamaHost('dm-host', { default_model: TEST_MODELS.DEFAULT });
      const updated = mod.getOllamaHost('dm-host');
      expect(updated.default_model).toBe(TEST_MODELS.DEFAULT);
    });

    it('default_model is null by default', () => {
      makeHost({ id: 'dm-null' });
      const fetched = mod.getOllamaHost('dm-null');
      expect(fetched.default_model).toBeNull();
    });

    it('default_model can be cleared by setting to null', () => {
      makeHost({ id: 'dm-clear' });
      mod.updateOllamaHost('dm-clear', { default_model: 'some-model:7b' });
      let host = mod.getOllamaHost('dm-clear');
      expect(host.default_model).toBe('some-model:7b');

      mod.updateOllamaHost('dm-clear', { default_model: null });
      host = mod.getOllamaHost('dm-clear');
      expect(host.default_model).toBeNull();
    });
  });
});

// ================================================================
// ensureLocalHostEnabled
// ================================================================
describe('ensureLocalHostEnabled', () => {
  let testDir2, origDataDir2, db2, mod2;

  beforeAll(() => {
    testDir2 = path.join(os.tmpdir(), `torque-vtest-ensure-local-${Date.now()}`);
    fs.mkdirSync(testDir2, { recursive: true });
    origDataDir2 = process.env.TORQUE_DATA_DIR;
    process.env.TORQUE_DATA_DIR = testDir2;

    // This section needs a separate DB instance (not the shared singleton),
    // so clear the cache to get a fresh require of the database module.
    try { delete require.cache[require.resolve('../database')]; } catch {}
    db2 = require('../database');
    db2.init();
    mod2 = require('../db/host/management');
    mod2.setDb(db2.getDb ? db2.getDb() : db2.getDbInstance());
    mod2.setGetTask((id) => db2.getTask(id));
    mod2.setGetProjectRoot((dir) => dir);
  });

  afterAll(() => {
    if (db2) try { db2.close(); } catch {}
    if (testDir2) {
      try { fs.rmSync(testDir2, { recursive: true, force: true }); } catch {}
      if (origDataDir2 !== undefined) process.env.TORQUE_DATA_DIR = origDataDir2;
      else delete process.env.TORQUE_DATA_DIR;
    }
  });

  function rawDb2() {
    return db2.getDb ? db2.getDb() : db2.getDbInstance();
  }

  function resetHosts() {
    try { rawDb2().prepare('DELETE FROM ollama_hosts').run(); } catch {}
  }

  it('returns zero fixes when no hosts exist', () => {
    resetHosts();
    const result = mod2.ensureLocalHostEnabled();
    expect(result.fixed).toBe(0);
    expect(result.details).toEqual([]);
  });

  it('enables disabled local host matching localhost', () => {
    resetHosts();
    mod2.addOllamaHost({
      id: 'local-disabled',
      name: 'LocalDisabled',
      url: 'http://localhost:11434',
      max_concurrent: 3,
      memory_limit_mb: 24576,
    });
    mod2.disableOllamaHost('local-disabled');

    // Verify it is disabled before the call
    const before = mod2.getOllamaHost('local-disabled');
    expect(before.enabled).toBe(0);

    // ensureLocalHostEnabled should NOT force-enable disabled hosts — respect user's choice
    const result = mod2.ensureLocalHostEnabled();
    expect(result.fixed).toBe(0);

    const after = mod2.getOllamaHost('local-disabled');
    expect(after.enabled).toBe(0);
  });

  it('respects disabled state for 127.0.0.1 hosts', () => {
    resetHosts();
    mod2.addOllamaHost({
      id: 'loopback-disabled',
      name: 'LoopbackDisabled',
      url: 'http://127.0.0.1:11434',
      max_concurrent: 3,
      memory_limit_mb: 24576,
    });
    mod2.disableOllamaHost('loopback-disabled');

    const before = mod2.getOllamaHost('loopback-disabled');
    expect(before.enabled).toBe(0);

    // ensureLocalHostEnabled should NOT force-enable disabled hosts
    const result = mod2.ensureLocalHostEnabled();
    expect(result.fixed).toBe(0);

    const after = mod2.getOllamaHost('loopback-disabled');
    expect(after.enabled).toBe(0);
  });

  it('does not modify non-local hosts', () => {
    resetHosts();
    mod2.addOllamaHost({
      id: 'remote-host',
      name: 'RemoteHost',
      url: 'http://192.0.2.100:11434',
      max_concurrent: 2,
      memory_limit_mb: 24576,
    });
    mod2.disableOllamaHost('remote-host');

    const before = mod2.getOllamaHost('remote-host');
    expect(before.enabled).toBe(0);

    const result = mod2.ensureLocalHostEnabled();
    expect(result.fixed).toBe(0);
    expect(result.details).toEqual([]);

    const after = mod2.getOllamaHost('remote-host');
    expect(after.enabled).toBe(0);
  });

  it('bumps memory_limit_mb when under 16384', () => {
    resetHosts();
    mod2.addOllamaHost({
      id: 'low-mem-local',
      name: 'LowMemLocal',
      url: 'http://localhost:11434',
      max_concurrent: 3,
      memory_limit_mb: 8192,
    });

    const before = mod2.getOllamaHost('low-mem-local');
    expect(before.memory_limit_mb).toBe(8192);

    const result = mod2.ensureLocalHostEnabled();
    expect(result.fixed).toBeGreaterThanOrEqual(1);
    expect(result.details.some(d => d.includes('memory limit'))).toBe(true);

    const after = mod2.getOllamaHost('low-mem-local');
    expect(after.memory_limit_mb).toBe(24576);
  });

  it('does not fix already-enabled local host with sufficient memory', () => {
    resetHosts();
    mod2.addOllamaHost({
      id: 'good-local',
      name: 'GoodLocal',
      url: 'http://localhost:11434',
      max_concurrent: 3,
      memory_limit_mb: 24576,
    });

    // Host is enabled by default from addOllamaHost and has sufficient memory
    const before = mod2.getOllamaHost('good-local');
    expect(before.enabled).toBe(1);
    expect(before.memory_limit_mb).toBe(24576);

    const result = mod2.ensureLocalHostEnabled();
    expect(result.fixed).toBe(0);
    expect(result.details).toEqual([]);
  });
});
