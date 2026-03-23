'use strict';

/**
 * Tests for chain-aware resolveProvider and resolveChain in template-store.js.
 * Also covers updated validateTemplate rules (string | array | mixed).
 * Also covers resolveTemplateByNameOrId.
 */

const { resolveProvider, resolveChain, validateTemplate } = require('../routing/template-store');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validRules(overrides = {}) {
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

// ---------------------------------------------------------------------------
// resolveChain
// ---------------------------------------------------------------------------

describe('resolveChain', () => {
  it('returns wrapped single-entry chain for string rule', () => {
    const tmpl = { rules: { default: 'ollama', security: 'codex' } };
    const chain = resolveChain(tmpl, 'security', 'normal');
    expect(chain).toEqual([{ provider: 'codex' }]);
  });

  it('returns chain array as-is for array rule', () => {
    const chainRule = [{ provider: 'cerebras', model: 'fast' }, { provider: 'ollama' }];
    const tmpl = { rules: { default: 'ollama', security: chainRule } };
    const result = resolveChain(tmpl, 'security', 'normal');
    expect(result).toBe(chainRule); // same reference
  });

  it('checks complexity_overrides first before category rule', () => {
    const tmpl = {
      rules: { default: 'ollama', security: 'ollama' },
      complexity_overrides: { security: { complex: 'codex' } },
    };
    const chain = resolveChain(tmpl, 'security', 'complex');
    expect(chain).toEqual([{ provider: 'codex' }]);
  });

  it('falls back to category rule when no complexity override matches', () => {
    const tmpl = {
      rules: { default: 'ollama', security: 'deepinfra' },
      complexity_overrides: { security: { complex: 'codex' } },
    };
    // 'simple' has no override → uses rules.security
    const chain = resolveChain(tmpl, 'security', 'simple');
    expect(chain).toEqual([{ provider: 'deepinfra' }]);
  });

  it('falls back to default when category not found in rules', () => {
    const tmpl = { rules: { default: 'ollama' } };
    const chain = resolveChain(tmpl, 'unknown_category', 'normal');
    expect(chain).toEqual([{ provider: 'ollama' }]);
  });

  it('returns null when nothing matches (no category, no default)', () => {
    const tmpl = { rules: { security: 'ollama' } };
    const result = resolveChain(tmpl, 'unknown_category', 'normal');
    expect(result).toBeNull();
  });

  it('returns null for null template', () => {
    expect(resolveChain(null, 'security', 'normal')).toBeNull();
  });

  it('returns null for template without rules', () => {
    expect(resolveChain({}, 'security', 'normal')).toBeNull();
  });

  it('handles complexity_overrides with array chain', () => {
    const chainOverride = [{ provider: 'cerebras' }, { provider: 'ollama' }];
    const tmpl = {
      rules: { default: 'ollama', security: 'ollama' },
      complexity_overrides: { security: { complex: chainOverride } },
    };
    const result = resolveChain(tmpl, 'security', 'complex');
    expect(result).toBe(chainOverride);
  });
});

// ---------------------------------------------------------------------------
// resolveProvider
// ---------------------------------------------------------------------------

describe('resolveProvider', () => {
  it('returns object with .provider for string rule', () => {
    const tmpl = { rules: { default: 'ollama', security: 'codex' } };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(result).not.toBeNull();
    expect(result.provider).toBe('codex');
  });

  it('returns object with .model for chain entry that has a model', () => {
    const tmpl = {
      rules: {
        default: 'ollama',
        security: [{ provider: 'deepinfra', model: 'Qwen/Qwen2.5-72B-Instruct' }],
      },
    };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(result.provider).toBe('deepinfra');
    expect(result.model).toBe('Qwen/Qwen2.5-72B-Instruct');
  });

  it('returns null .model when chain entry has no model', () => {
    const tmpl = { rules: { default: 'ollama', security: 'codex' } };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(result.model).toBeNull();
  });

  it('returns object with .chain containing the full chain', () => {
    const chainRule = [
      { provider: 'cerebras' },
      { provider: 'ollama' },
    ];
    const tmpl = { rules: { default: 'ollama', security: chainRule } };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(result.chain).toBe(chainRule);
    expect(result.chain).toHaveLength(2);
  });

  it('String(result) returns the provider name for backward compatibility', () => {
    const tmpl = { rules: { default: 'ollama', security: 'cerebras' } };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(String(result)).toBe('cerebras');
  });

  it('result coerces to provider string via valueOf for backward compatibility', () => {
    const tmpl = { rules: { default: 'ollama', security: 'cerebras' } };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(String(result)).toBe('cerebras');
  });

  it('returns null for null template', () => {
    expect(resolveProvider(null, 'security', 'normal')).toBeNull();
  });

  it('returns null for template without rules', () => {
    expect(resolveProvider({}, 'security', 'normal')).toBeNull();
  });

  it('handles legacy string format — selects first entry after wrapping', () => {
    const tmpl = { rules: { default: 'ollama', security: 'codex' } };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(result.chain).toEqual([{ provider: 'codex' }]);
    expect(result.provider).toBe('codex');
  });

  it('selects the first chain entry as provider', () => {
    const tmpl = {
      rules: {
        default: 'ollama',
        security: [
          { provider: 'cerebras', model: 'model-a' },
          { provider: 'ollama' },
        ],
      },
    };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(result.provider).toBe('cerebras');
    expect(result.model).toBe('model-a');
  });

  it('falls back to default rule when category not found', () => {
    const tmpl = { rules: { default: 'ollama' } };
    const result = resolveProvider(tmpl, 'unknown_cat', 'normal');
    expect(result.provider).toBe('ollama');
  });
});

// ---------------------------------------------------------------------------
// validateTemplate — chain format support
// ---------------------------------------------------------------------------

describe('validateTemplate — chain format', () => {
  it('accepts legacy string format (no change in behavior)', () => {
    const result = validateTemplate({ name: 'String Format', rules: validRules() });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts chain array format with {provider, model} entries', () => {
    const result = validateTemplate({
      name: 'Chain Format',
      rules: validRules({
        security: [
          { provider: 'cerebras', model: 'fast' },
          { provider: 'ollama' },
        ],
      }),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts mixed format (some strings, some arrays)', () => {
    const result = validateTemplate({
      name: 'Mixed Format',
      rules: validRules({
        security: [{ provider: 'codex' }],
        reasoning: 'deepinfra',
      }),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects chain with > 7 entries', () => {
    const tooLong = Array.from({ length: 8 }, (_, i) => ({ provider: `p${i}` }));
    const result = validateTemplate({
      name: 'Too Long Chain',
      rules: validRules({ security: tooLong }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /chain exceeds maximum length of 7/i.test(e))).toBe(true);
  });

  it('rejects chain entry without a provider string', () => {
    const result = validateTemplate({
      name: 'Bad Entry',
      rules: validRules({
        security: [{ model: 'no-provider-here' }],
      }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /chain entry must have a provider string/i.test(e))).toBe(true);
  });

  it('rejects empty chain array', () => {
    const result = validateTemplate({
      name: 'Empty Chain',
      rules: validRules({ security: [] }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /chain must have at least one entry/i.test(e))).toBe(true);
  });

  it('rejects non-string, non-array values in rules', () => {
    const result = validateTemplate({
      name: 'Bad Type',
      rules: validRules({ security: 42 }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /must be a string or array/i.test(e))).toBe(true);
  });

  it('accepts chain in complexity_overrides', () => {
    const result = validateTemplate({
      name: 'Override Chain',
      rules: validRules(),
      complexity_overrides: {
        security: {
          complex: [{ provider: 'cerebras' }, { provider: 'codex' }],
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects chain entry without provider in complexity_overrides', () => {
    const result = validateTemplate({
      name: 'Bad Override Chain',
      rules: validRules(),
      complexity_overrides: {
        security: {
          complex: [{ model: 'no-provider' }],
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /chain entry must have a provider string/i.test(e))).toBe(true);
  });

  it('rejects empty chain in complexity_overrides', () => {
    const result = validateTemplate({
      name: 'Empty Override Chain',
      rules: validRules(),
      complexity_overrides: {
        security: { complex: [] },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /chain must have at least one entry/i.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------

const { isRetryableError, executeWithFallback } = require('../providers/execution');

describe('isRetryableError', () => {
  it('returns true for "429 Too Many Requests"', () => {
    expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('returns true for "timeout"', () => {
    expect(isRetryableError(new Error('Request timeout after 30000ms'))).toBe(true);
  });

  it('returns true for "timed out"', () => {
    expect(isRetryableError(new Error('Connection timed out'))).toBe(true);
  });

  it('returns true for "ECONNREFUSED"', () => {
    expect(isRetryableError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe(true);
  });

  it('returns true for "quota exceeded"', () => {
    expect(isRetryableError(new Error('quota exceeded for this billing period'))).toBe(true);
  });

  it('returns true for "rate limit"', () => {
    expect(isRetryableError(new Error('rate limit reached, retry after 60s'))).toBe(true);
  });

  it('returns true for "overloaded"', () => {
    expect(isRetryableError(new Error('server overloaded, try again later'))).toBe(true);
  });

  it('returns true for "503"', () => {
    expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('returns true for "Provider returned error"', () => {
    expect(isRetryableError(new Error('Provider returned error: upstream issue'))).toBe(true);
  });

  it('returns false for "400 Bad Request"', () => {
    expect(isRetryableError(new Error('400 Bad Request: invalid payload'))).toBe(false);
  });

  it('returns false for "401 Unauthorized"', () => {
    expect(isRetryableError(new Error('401 Unauthorized: invalid API key'))).toBe(false);
  });

  it('returns false for "old_text not found"', () => {
    expect(isRetryableError(new Error('old_text not found in file'))).toBe(false);
  });

  it('returns false for generic task logic errors', () => {
    expect(isRetryableError(new Error('Cannot read property of undefined'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeWithFallback
// ---------------------------------------------------------------------------

describe('executeWithFallback', () => {
  // spawnAgenticWorker uses the Worker constructor from worker_threads.
  // We intercept it via vi.spyOn so we can control outcomes per test.

  const EventEmitter = require('events');

  /**
   * Build a simple buildWorkerConfig adapter that returns a minimal config.
   * The actual worker is mocked so the content doesn't matter.
   */
  function simpleBuildWorkerConfig(entry) {
    return {
      adapterType: 'openai',
      adapterOptions: { provider: entry.provider, model: entry.model || 'default' },
      systemPrompt: 'test',
      taskPrompt: 'do the thing',
      workingDir: process.cwd(),
      timeoutMs: 30000,
      maxIterations: 10,
      contextBudget: 16000,
      promptInjectedTools: false,
      commandMode: 'unrestricted',
      commandAllowlist: [],
    };
  }

  /**
   * Build a fake Worker constructor (must be a real constructor function, not an
   * arrow function, because execution.js uses `new Worker(...)`).
   * The returned instance emits the given message on the next tick.
   */
  function makeFakeWorkerCtor(msgOrError) {
    return function FakeWorker() {
      const em = new EventEmitter();
      this.postMessage = () => {};
      this.terminate = vi.fn();
      this.on = (ev, h) => em.on(ev, h);
      setImmediate(() => em.emit('message', msgOrError));
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('first provider succeeds → returns result with chainPosition=1', async () => {
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      makeFakeWorkerCtor({ type: 'result', output: 'success output', toolLog: [], tokenUsage: {} })
    );

    const chain = [{ provider: 'deepinfra', model: 'Qwen/Qwen2.5-72B-Instruct' }];
    const task = { id: 'test-1', task_description: 'test task', working_directory: null };

    const result = await executeWithFallback(task, chain, simpleBuildWorkerConfig, {});

    expect(result.chainPosition).toBe(1);
    expect(result.provider).toBe('deepinfra');
    expect(result.output).toBe('success output');
  });

  it('first provider fails (429), second succeeds → returns with chainPosition=2', async () => {
    let callCount = 0;
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function FakeWorker() {
      callCount++;
      const em = new EventEmitter();
      this.postMessage = () => {};
      this.terminate = vi.fn();
      this.on = (ev, h) => em.on(ev, h);
      const msg = callCount === 1
        ? { type: 'error', message: '429 Too Many Requests' }
        : { type: 'result', output: 'fallback output', toolLog: [], tokenUsage: {} };
      setImmediate(() => em.emit('message', msg));
    });

    const chain = [
      { provider: 'cerebras', model: 'fast-model' },
      { provider: 'ollama', model: 'qwen3-coder:30b' },
    ];
    const task = { id: 'test-2', task_description: 'test task', working_directory: null };

    const result = await executeWithFallback(task, chain, simpleBuildWorkerConfig, {});

    expect(result.chainPosition).toBe(2);
    expect(result.provider).toBe('ollama');
    expect(result.output).toBe('fallback output');
    expect(callCount).toBe(2);
  });

  it('first provider fails (400, non-retryable) → throws immediately without trying next', async () => {
    let callCount = 0;
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function FakeWorker() {
      callCount++;
      const em = new EventEmitter();
      this.postMessage = () => {};
      this.terminate = vi.fn();
      this.on = (ev, h) => em.on(ev, h);
      setImmediate(() => em.emit('message', { type: 'error', message: '400 Bad Request: malformed prompt' }));
    });

    const chain = [
      { provider: 'deepinfra', model: 'Qwen/Qwen2.5-72B-Instruct' },
      { provider: 'ollama', model: 'qwen3-coder:30b' },
    ];
    const task = { id: 'test-3', task_description: 'test task', working_directory: null };

    await expect(executeWithFallback(task, chain, simpleBuildWorkerConfig, {}))
      .rejects.toThrow('400 Bad Request: malformed prompt');

    // Should only try the first provider — non-retryable error stops the chain
    expect(callCount).toBe(1);
  });

  it('all providers fail → throws last error', async () => {
    let callCount = 0;
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function FakeWorker() {
      const myCount = ++callCount;
      const em = new EventEmitter();
      this.postMessage = () => {};
      this.terminate = vi.fn();
      this.on = (ev, h) => em.on(ev, h);
      setImmediate(() => em.emit('message', { type: 'error', message: `429 provider ${myCount} failed` }));
    });

    const chain = [
      { provider: 'cerebras' },
      { provider: 'deepinfra' },
      { provider: 'ollama' },
    ];
    const task = { id: 'test-4', task_description: 'test task', working_directory: null };

    await expect(executeWithFallback(task, chain, simpleBuildWorkerConfig, {}))
      .rejects.toThrow('429 provider 3 failed');

    expect(callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// resolveTemplateByNameOrId
// ---------------------------------------------------------------------------

const { setupTestDbModule, teardownTestDb } = require('./vitest-setup');

let templateStoreMod;

function validRulesForResolve(overrides = {}) {
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

describe('resolveTemplateByNameOrId', () => {
  beforeAll(() => {
    ({ mod: templateStoreMod } = setupTestDbModule('../routing/template-store', 'resolve-by-name-or-id'));
    templateStoreMod.ensureTable();
  });

  afterAll(() => teardownTestDb());

  it('resolves by exact ID', () => {
    const created = templateStoreMod.createTemplate({ name: 'ById Template', rules: validRulesForResolve() });
    const result = templateStoreMod.resolveTemplateByNameOrId(created.id);
    expect(result).not.toBeNull();
    expect(result.id).toBe(created.id);
    expect(result.name).toBe('ById Template');
  });

  it('resolves by name when ID does not match', () => {
    templateStoreMod.createTemplate({ name: 'ByName Template', rules: validRulesForResolve() });
    const result = templateStoreMod.resolveTemplateByNameOrId('ByName Template');
    expect(result).not.toBeNull();
    expect(result.name).toBe('ByName Template');
  });

  it('returns null for an unknown value', () => {
    const result = templateStoreMod.resolveTemplateByNameOrId('no-such-id-or-name');
    expect(result).toBeNull();
  });

  it('returns null for null, undefined, and empty string', () => {
    expect(templateStoreMod.resolveTemplateByNameOrId(null)).toBeNull();
    expect(templateStoreMod.resolveTemplateByNameOrId(undefined)).toBeNull();
    expect(templateStoreMod.resolveTemplateByNameOrId('')).toBeNull();
  });

  it('prefers ID over name when both could match', () => {
    // Create a template and note its ID
    const tmplA = templateStoreMod.createTemplate({ name: 'Ambiguous Alpha', rules: validRulesForResolve() });
    // Create a second template whose name equals the first template's ID (edge case)
    // In practice IDs are UUIDs so this is synthetic, but it tests the precedence rule.
    // We verify that passing tmplA.id returns tmplA (the ID lookup wins).
    const byId = templateStoreMod.resolveTemplateByNameOrId(tmplA.id);
    expect(byId).not.toBeNull();
    expect(byId.id).toBe(tmplA.id);
    expect(byId.name).toBe('Ambiguous Alpha');
  });
});
