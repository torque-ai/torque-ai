const path = require('path');
const os = require('os');
const fs = require('fs');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

const TEMPLATE_BUF = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

let templateBuffer;
let db;
let taskCore;
let configCore;
let core;
let seq = 0;

function rawDb() {
  return db.getDb ? db.getDb() : db.getDbInstance();
}

function nextId(prefix) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

function bindCore(hostManagement = null) {
  core.setDb(rawDb());
  core.setGetTask((id) => taskCore.getTask(id));
  core.setHostManagement(hostManagement);
}

function createTask(overrides = {}) {
  const id = overrides.id || nextId('task');
  taskCore.createTask({
    task_description: overrides.task_description || `Task ${id}`,
    working_directory: overrides.working_directory || os.tmpdir(),
    status: overrides.status || 'queued',
    project: overrides.project || 'core-tests',
    provider: overrides.provider || 'codex',
    model: overrides.model || null,
    original_provider: overrides.original_provider || null,
    error_output: overrides.error_output || null,
    ...overrides,
    id,
  });
  return id;
}

function insertRoutingRule(rule) {
  rawDb().prepare(`
    INSERT INTO routing_rules (name, description, rule_type, pattern, target_provider, priority, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.name,
    rule.description || null,
    rule.rule_type || 'keyword',
    rule.pattern,
    rule.target_provider,
    rule.priority !== undefined ? rule.priority : 50,
    rule.enabled !== undefined ? (rule.enabled ? 1 : 0) : 1,
    new Date().toISOString(),
  );
}

async function startMockOllama(statusCode = 200) {
  const http = require('http');

  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.statusCode = statusCode;
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    host: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

beforeAll(() => {
  templateBuffer = fs.readFileSync(TEMPLATE_BUF);
  ({ db } = setupTestDb('db-provider-routing-core'));
  taskCore = require('../db/task-core');
  configCore = require('../db/config-core');
  core = require('../db/provider-routing-core');
  const serverConfig = require('../config');
  serverConfig.init({ db });
  bindCore();
});

beforeEach(() => {
  db.resetForTest(templateBuffer);
  bindCore();
  core.setOllamaHealthy(true);
});

afterAll(() => {
  teardownTestDb();
});

describe('db/provider-routing-core', () => {
  describe('provider CRUD and normalization', () => {
    it('enrichProviderRow falls back to empty quota_error_patterns for invalid JSON', () => {
      const enriched = core.enrichProviderRow({
        provider: 'codex',
        enabled: 1,
        transport: 'hybrid',
        quota_error_patterns: 'not-json',
      });

      expect(enriched.quota_error_patterns).toEqual([]);
    });

    it('normalizeProviderTransport accepts valid values and applies provider defaults', () => {
      expect(core.normalizeProviderTransport(' Cli ', 'codex')).toBe('cli');
      expect(core.normalizeProviderTransport(undefined, 'codex')).toBe('hybrid');
      expect(core.normalizeProviderTransport(undefined, 'claude-cli')).toBe('cli');
      expect(core.normalizeProviderTransport(undefined, 'anthropic')).toBe('api');
    });

    it('enrichProviderRow converts booleans, transport, and quota_error_patterns', () => {
      const enriched = core.enrichProviderRow({
        provider: 'codex',
        enabled: 1,
        transport: null,
        quota_error_patterns: '["429","limit"]',
      });

      expect(enriched.enabled).toBe(true);
      expect(enriched.transport).toBe('hybrid');
      expect(enriched.quota_error_patterns).toEqual(['429', 'limit']);
    });

    it('getProvider returns seeded provider and listProviders keeps priority ordering', () => {
      const codex = core.getProvider('codex');
      expect(codex).toBeTruthy();
      expect(codex.provider).toBe('codex');
      expect(codex.transport).toBe('hybrid');
      expect(Array.isArray(codex.quota_error_patterns)).toBe(true);

      const providers = core.listProviders();
      expect(providers.length).toBeGreaterThan(0);
      for (let i = 1; i < providers.length; i += 1) {
        expect(providers[i - 1].priority).toBeLessThanOrEqual(providers[i].priority);
      }
    });

    it('updateProvider updates scalar fields and quota_error_patterns JSON', () => {
      const updated = core.updateProvider('codex', {
        enabled: 0,
        priority: 77,
        cli_path: '/tmp/codex-cli',
        cli_args: '--json',
        max_concurrent: 9,
        quota_error_patterns: ['rate limit', '429'],
        transport: 'api',
      });

      expect(updated.enabled).toBe(false);
      expect(updated.priority).toBe(77);
      expect(updated.cli_path).toBe('/tmp/codex-cli');
      expect(updated.cli_args).toBe('--json');
      expect(updated.max_concurrent).toBe(9);
      expect(updated.transport).toBe('api');
      expect(updated.quota_error_patterns).toEqual(['rate limit', '429']);
    });

    it('updateProvider rejects invalid transport values', () => {
      expect(() => core.updateProvider('codex', { transport: 'webrtc' })).toThrow(/invalid transport/i);
    });

    it('setDefaultProvider persists and getDefaultProvider reflects the change', () => {
      const previous = core.getDefaultProvider();
      const target = previous === 'codex' ? 'claude-cli' : 'codex';

      const applied = core.setDefaultProvider(target);
      expect(applied).toBe(target);
      // Verify the value was persisted to the raw database directly (bypasses config cache)
      const row = rawDb().prepare("SELECT value FROM config WHERE key = 'default_provider'").get();
      expect(row ? row.value : null).toBe(target);
    });

    it('setDefaultProvider rejects unknown and disabled providers', () => {
      expect(() => core.setDefaultProvider('no-such-provider')).toThrow(/unknown provider/i);
      core.updateProvider('codex', { enabled: 0 });
      expect(() => core.setDefaultProvider('codex')).toThrow(/disabled/i);
    });
  });

  describe('smart routing analysis', () => {
    it('returns default provider when smart routing is disabled', () => {
      configCore.setConfig('smart_routing_enabled', '0');
      configCore.setConfig('default_provider', 'claude-cli');

      const result = core.analyzeTaskForRouting('do something', os.tmpdir());
      expect(result.provider).toBe('claude-cli');
      expect(result.reason).toContain('Smart routing disabled');
    });

    it('matches keyword rules from routing_rules table', () => {
      const result = core.analyzeTaskForRouting('Update README documentation for setup', os.tmpdir(), []);
      expect(result.provider).toBe('ollama');
      expect(result.reason).toContain('Matched keyword rule');
    });

    it('matches extension rules using the files argument', () => {
      const result = core.analyzeTaskForRouting('Adjust C# model', os.tmpdir(), ['src/ViewModel.cs']);
      expect(result.provider).toBe('claude-cli');
      expect(result.reason).toContain('Matched extension rule');
    });

    it('evaluates regex rules and skips invalid regex patterns', () => {
      insertRoutingRule({
        name: nextId('bad-regex'),
        rule_type: 'regex',
        pattern: '[unterminated',
        target_provider: 'codex',
        priority: 1,
        enabled: true,
      });

      insertRoutingRule({
        name: nextId('good-regex'),
        rule_type: 'regex',
        pattern: 'foo\\d+',
        target_provider: 'claude-cli',
        priority: 2,
        enabled: true,
      });

      const result = core.analyzeTaskForRouting('Please inspect foo123 quickly', os.tmpdir(), []);
      expect(result.provider).toBe('claude-cli');
      expect(result.reason).toContain('Matched regex rule');
    });

    it('falls back when an Ollama provider is selected but health cache is false', () => {
      core.setOllamaHealthy(false);
      configCore.setConfig('ollama_fallback_provider', 'codex');

      const result = core.analyzeTaskForRouting('Update README docs', os.tmpdir(), []);
      expect(result.provider).toBe('codex');
      expect(result.fallbackApplied).toBe(true);
      expect(result.originalProvider).toBe('ollama');
    });

    it('skipHealthCheck bypasses Ollama fallback application', () => {
      core.setOllamaHealthy(false);
      configCore.setConfig('ollama_fallback_provider', 'codex');

      const result = core.analyzeTaskForRouting('Update README docs', os.tmpdir(), [], { skipHealthCheck: true });
      expect(result.provider).toBe('ollama');
      expect(result.fallbackApplied).toBeUndefined();
    });

    it('uses injected complexity routing when host management is present', () => {
      bindCore({
        determineTaskComplexity: () => 'normal',
        routeTask: () => ({
          provider: 'ollama',
          rule: { name: 'complexity' },
          hostId: 'host-alpha',
          model: 'qwen3:8b',
          fallbackApplied: false,
        }),
      });

      const result = core.analyzeTaskForRouting('Implement a service layer', os.tmpdir(), ['src/service.js']);
      expect(result.provider).toBe('ollama');
      expect(result.complexity).toBe('normal');
      expect(result.hostId).toBe('host-alpha');
      expect(result.model).toBe('qwen3:8b');
      expect(result.reason).toContain('Complexity-based routing');
    });

    it('upgrades simple targeted local edits to hashline-ollama', () => {
      bindCore({
        determineTaskComplexity: () => 'simple',
        routeTask: () => ({
          provider: 'ollama',
          hostId: 'host-local',
          model: 'qwen3:8b',
        }),
      });

      const result = core.analyzeTaskForRouting('Add jsdoc comments to src/app.js', os.tmpdir(), ['src/app.js']);
      expect(result.provider).toBe('hashline-ollama');
      expect(result.reason).toContain('upgraded to hashline-ollama');
    });

    it('keeps simple targeted codex edits on codex when no hashline cloud provider is configured', () => {
      bindCore({
        determineTaskComplexity: () => 'normal',
        routeTask: () => ({
          provider: 'codex',
          hostId: null,
          model: 'gpt-5',
        }),
      });

      const result = core.analyzeTaskForRouting('Fix validation in src/api.ts and add jsdoc', os.tmpdir(), ['src/api.ts']);
      expect(result.provider).toBe('codex');
      expect(result.reason).not.toContain('upgraded to');
    });

    it('routes reasoning tasks to deepinfra when configured', () => {
      core.updateProvider('deepinfra', { enabled: 1 });
      configCore.setConfig('deepinfra_api_key', 'deepinfra-key');

      const result = core.analyzeTaskForRouting('Need deep analysis for a root cause in architecture', os.tmpdir(), []);
      expect(result.provider).toBe('deepinfra');
    });

    it('routes reasoning tasks to hyperbolic when deepinfra is unavailable', () => {
      core.updateProvider('hyperbolic', { enabled: 1 });
      configCore.setConfig('deepinfra_api_key', '');
      configCore.setConfig('hyperbolic_api_key', 'hyperbolic-key');

      const result = core.analyzeTaskForRouting('Analyze a complex root cause in production behavior', os.tmpdir(), []);
      expect(result.provider).toBe('hyperbolic');
    });

    it('routes docs tasks to groq when configured', () => {
      core.updateProvider('groq', { enabled: 1 });
      configCore.setConfig('groq_api_key', 'groq-key');

      const result = core.analyzeTaskForRouting('Summarize module behavior for docs', os.tmpdir(), []);
      expect(result.provider).toBe('groq');
    });
  });

  describe('fallback and provider switching', () => {
    it('markTaskPendingProviderSwitch updates status and appends reason', () => {
      const taskId = createTask({ status: 'running', provider: 'codex' });
      const updated = core.markTaskPendingProviderSwitch(taskId, 'quota exhausted');

      expect(updated.status).toBe('pending_provider_switch');
      expect(updated.error_output).toContain('[Provider Switch Pending]');
      expect(updated.error_output).toContain('quota exhausted');
    });

    it('setProviderFallbackChain stores custom chains and validates invalid input', () => {
      const provider = 'codex';
      core.setProviderFallbackChain(provider, ['claude-cli', 'ollama']);
      expect(core.getProviderFallbackChain(provider)).toEqual(['claude-cli', 'ollama']);

      expect(() => core.setProviderFallbackChain(provider, ['codex'])).toThrow(/self-loop/i);
      expect(() => core.setProviderFallbackChain(provider, ['claude-cli', 'claude-cli'])).toThrow(/duplicate/i);
      expect(() => core.setProviderFallbackChain(provider, ['no-such-provider'])).toThrow(/unknown provider/i);
    });

    it('getNextFallbackProvider skips already tried providers from failover_events', () => {
      const taskId = createTask({ status: 'failed', provider: 'codex', original_provider: 'codex' });
      core.setProviderFallbackChain('codex', ['claude-cli', 'ollama']);

      db.recordFailoverEvent({
        task_id: taskId,
        from_provider: 'codex',
        to_provider: 'claude-cli',
        reason: 'quota',
        failover_type: 'provider',
      });

      expect(core.getNextFallbackProvider(taskId)).toBe('ollama');
    });

    it('getNextFallbackProvider skips raw ollama for greenfield tasks', () => {
      const taskId = createTask({
        status: 'failed',
        provider: 'codex',
        original_provider: 'codex',
        task_description: 'Create a new test file for the auth module'
      });
      // Chain: claude-cli → ollama. Since task is greenfield, ollama should be skipped.
      core.setProviderFallbackChain('codex', ['ollama', 'claude-cli']);

      const next = core.getNextFallbackProvider(taskId);
      expect(next).toBe('claude-cli');
    });

    it('getNextFallbackProvider allows raw ollama for non-greenfield tasks', () => {
      const taskId = createTask({
        status: 'failed',
        provider: 'codex',
        original_provider: 'codex',
        task_description: 'Fix the auth handler validation bug in auth.ts'
      });
      core.setProviderFallbackChain('codex', ['ollama', 'claude-cli']);

      const next = core.getNextFallbackProvider(taskId);
      expect(next).toBe('ollama');
    });

    it('approveProviderSwitch retries task with the new provider', () => {
      const taskId = createTask({ status: 'queued', provider: 'codex' });
      core.markTaskPendingProviderSwitch(taskId, 'quota');

      const updated = core.approveProviderSwitch(taskId, 'claude-cli');
      expect(updated.status).toBe('queued');
      expect(updated.provider).toBe('claude-cli');
      expect(updated.original_provider).toBe('codex');
      expect(updated.retry_count).toBe(1);
      expect(updated.provider_switched_at).toBeTruthy();
    });

    it('rejectProviderSwitch fails task and records the rejection reason', () => {
      const taskId = createTask({ status: 'queued', provider: 'codex' });
      core.markTaskPendingProviderSwitch(taskId, 'quota');

      const updated = core.rejectProviderSwitch(taskId, 'user denied');
      expect(updated.status).toBe('failed');
      expect(updated.completed_at).toBeTruthy();
      expect(updated.error_output).toContain('[Provider Switch Rejected]');
      expect(updated.error_output).toContain('user denied');
    });

    it('isProviderQuotaError performs case-insensitive pattern matching', () => {
      core.updateProvider('codex', { quota_error_patterns: ['Rate Limit', '429'] });
      expect(core.isProviderQuotaError('codex', 'HTTP 429 TOO MANY REQUESTS')).toBe(true);
      expect(core.isProviderQuotaError('codex', 'connection refused')).toBe(false);
      expect(core.isProviderQuotaError('no-such', '429')).toBe(false);
    });

    it('isCodexExhausted and setCodexExhausted toggle persisted state', () => {
      // setCodexExhausted writes directly to the raw db, bypassing the config cache.
      // Read directly via rawDb() to avoid stale cache reads.
      const getExhausted = () => {
        const row = rawDb().prepare("SELECT value FROM config WHERE key = 'codex_exhausted'").get();
        return row ? row.value : null;
      };
      expect(core.isCodexExhausted()).toBe(false);
      core.setCodexExhausted(true);
      expect(getExhausted()).toBe('1');
      expect(configCore.getConfig('codex_exhausted_at')).toBeTruthy();
      core.setCodexExhausted(false);
      expect(getExhausted()).toBe('0');
    });
  });

  describe('Ollama health and infrastructure helpers', () => {
    it('waitForOllamaReady and checkOllamaHealth use the configured host and cache', async () => {
      const mock = await startMockOllama(200);
      try {
        configCore.setConfig('ollama_host', mock.host);

        const ready = await core.waitForOllamaReady(2000);
        const first = await core.checkOllamaHealth(true);
        expect(ready).toBe(true);
        expect(first).toBe(true);
      } finally {
        await mock.close();
      }

      const cached = await core.checkOllamaHealth(false);
      expect(cached).toBe(true);

      const forced = await core.checkOllamaHealth(true);
      expect(forced).toBe(false);
    });

    it('attemptOllamaStart returns false when auto-start is disabled', async () => {
      configCore.setConfig('ollama_auto_start_enabled', '0');
      await expect(core.attemptOllamaStart()).resolves.toBe(false);
    });

    it('autoConfigureWSL2Host returns false when auto-detect is disabled', () => {
      configCore.setConfig('ollama_auto_detect_wsl_host', '0');
      expect(core.autoConfigureWSL2Host()).toBe(false);
    });

    it('detectWSL2HostIP returns null or a valid IPv4 address', () => {
      const value = core.detectWSL2HostIP();
      if (value === null) {
        expect(value).toBeNull();
      } else {
        expect(value).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      }
    });

    it('findOllamaBinary prefers configured real binaries and ignores tiny placeholders', () => {
      const validPath = path.join(os.tmpdir(), `${nextId('ollama-valid')}.bin`);
      const tinyPath = path.join(os.tmpdir(), `${nextId('ollama-tiny')}.bin`);
      fs.writeFileSync(validPath, Buffer.alloc(2048, 1));
      fs.writeFileSync(tinyPath, Buffer.alloc(10, 1));

      configCore.setConfig('ollama_binary_path', validPath);
      expect(core.findOllamaBinary()).toBe(validPath);

      configCore.setConfig('ollama_binary_path', tinyPath);
      expect(core.findOllamaBinary()).not.toBe(tinyPath);

      try { fs.rmSync(validPath, { force: true }); } catch {}
      try { fs.rmSync(tinyPath, { force: true }); } catch {}
    });

    it('hasHealthyOllamaHost delegates to injected host management API', () => {
      bindCore();
      expect(core.hasHealthyOllamaHost()).toBe(false);

      core.setHostManagement({
        hasHealthyOllamaHost: () => true,
      });
      expect(core.hasHealthyOllamaHost()).toBe(true);
    });
  });

  describe('per-task template routing (_routing_template in taskMetadata)', () => {
    const templateStore = require('../routing/template-store');

    // Unique suffix per describe-scope to avoid name collisions across test runs
    let testSuffix;

    function validTemplateRules(overrides = {}) {
      return {
        security: 'ollama',
        xaml_wpf: 'ollama',
        architectural: 'ollama',
        reasoning: 'ollama',
        large_code_gen: 'ollama',
        documentation: 'ollama',
        simple_generation: 'ollama',
        targeted_file_edit: 'hashline-ollama',
        default: 'ollama',
        ...overrides,
      };
    }

    beforeEach(() => {
      db.resetForTest(templateBuffer);
      bindCore();
      core.setOllamaHealthy(true);
      configCore.setConfig('smart_routing_enabled', '1');
      testSuffix = nextId('pt');
    });

    it('uses task-level template when _routing_template is a valid name', () => {
      const name = `Test Speed ${testSuffix}`;
      templateStore.createTemplate({
        name,
        rules: validTemplateRules({ default: 'codex' }),
      });

      const result = core.analyzeTaskForRouting(
        'Generate a utility function',
        os.tmpdir(),
        [],
        { taskMetadata: { _routing_template: name } },
      );

      expect(result.provider).toBe('codex');
      expect(result.reason).toContain(`Task template '${name}'`);
    });

    it('uses task-level template when _routing_template matches by name for a specific category', () => {
      const name = `Cloud Heavy ${testSuffix}`;
      templateStore.createTemplate({
        name,
        rules: validTemplateRules({ security: 'codex' }),
      });

      // 'auth' triggers the security category in the classifier
      const result = core.analyzeTaskForRouting(
        'Review auth token validation',
        os.tmpdir(),
        [],
        { taskMetadata: { _routing_template: name } },
      );

      expect(result.provider).toBe('codex');
      expect(result.reason).toContain(`Task template '${name}'`);
    });

    it('falls through to normal routing when _routing_template is not set', () => {
      const name = `All Codex ${testSuffix}`;
      templateStore.createTemplate({
        name,
        rules: validTemplateRules({ default: 'codex' }),
      });

      // No _routing_template in taskMetadata — should not use the template above
      const result = core.analyzeTaskForRouting(
        'Update README documentation for setup',
        os.tmpdir(),
        [],
        { taskMetadata: {} },
      );

      // Falls through to keyword-matched rule: 'documentation' → ollama
      expect(result.provider).toBe('ollama');
      expect(result.reason).not.toContain('Task template');
    });

    it('falls through to normal routing when _routing_template name is unknown', () => {
      const result = core.analyzeTaskForRouting(
        'Update README documentation for setup',
        os.tmpdir(),
        [],
        { taskMetadata: { _routing_template: `no-such-template-${testSuffix}` } },
      );

      // Falls through to keyword rule
      expect(result.reason).not.toContain('Task template');
    });

    it('falls through to normal routing when taskMetadata is absent entirely', () => {
      const name = `TaskMeta Absent ${testSuffix}`;
      templateStore.createTemplate({
        name,
        rules: validTemplateRules({ default: 'codex' }),
      });

      const result = core.analyzeTaskForRouting(
        'Update README documentation for setup',
        os.tmpdir(),
        [],
        {},
      );

      expect(result.reason).not.toContain('Task template');
    });

    it('uses task-level template resolved by ID (not just name)', () => {
      const name = `ById Routing ${testSuffix}`;
      const tmpl = templateStore.createTemplate({
        name,
        rules: validTemplateRules({ default: 'codex' }),
      });

      const result = core.analyzeTaskForRouting(
        'Generate a utility function',
        os.tmpdir(),
        [],
        { taskMetadata: { _routing_template: tmpl.id } },
      );

      expect(result.provider).toBe('codex');
      expect(result.reason).toContain(`Task template '${name}'`);
    });

    it('task template takes precedence over the globally active template', () => {
      const globalName = `Global Active ${testSuffix}`;
      const globalTemplate = templateStore.createTemplate({
        name: globalName,
        rules: validTemplateRules({ default: 'ollama' }),
      });
      templateStore.setActiveTemplate(globalTemplate.id);

      const overrideName = `Per-Task Override ${testSuffix}`;
      templateStore.createTemplate({
        name: overrideName,
        rules: validTemplateRules({ default: 'codex' }),
      });

      const result = core.analyzeTaskForRouting(
        'Generate a utility function',
        os.tmpdir(),
        [],
        { taskMetadata: { _routing_template: overrideName } },
      );

      expect(result.provider).toBe('codex');
      expect(result.reason).toContain(`Task template '${overrideName}'`);
    });

    it('falls back through chain when primary provider is disabled', () => {
      const name = `Chain Template ${testSuffix}`;
      templateStore.createTemplate({
        name,
        rules: validTemplateRules({
          default: [{ provider: 'deepinfra' }, { provider: 'codex' }],
        }),
      });

      // deepinfra is disabled by default; codex is enabled
      const result = core.analyzeTaskForRouting(
        'Generate a utility function',
        os.tmpdir(),
        [],
        { taskMetadata: { _routing_template: name } },
      );

      expect(result.provider).toBe('codex');
      expect(result.reason).toContain('chain to codex');
    });
  });
});
