/**
 * Unit Tests: orchestrator/strategic-brain.js, prompt-templates.js,
 * response-parser.js, deterministic-fallbacks.js
 *
 * Tests the strategic brain auto-fallback chain, prompt templates,
 * JSON response extraction, and deterministic fallback logic.
 */

'use strict';

const { TEST_MODELS } = require('./test-helpers');

// ────────────────────────────────────────────────────────────────
// prompt-templates.js
// ────────────────────────────────────────────────────────────────
describe('prompt-templates', () => {
  const { buildPrompt, TEMPLATES } = require('../orchestrator/prompt-templates');

  it('exports TEMPLATES object with decompose, diagnose, review', () => {
    expect(TEMPLATES).toHaveProperty('decompose');
    expect(TEMPLATES).toHaveProperty('diagnose');
    expect(TEMPLATES).toHaveProperty('review');
  });

  it('each template has system, user, and schema properties', () => {
    for (const [_name, tpl] of Object.entries(TEMPLATES)) {
      expect(tpl).toHaveProperty('system');
      expect(tpl).toHaveProperty('user');
      expect(tpl).toHaveProperty('schema');
      expect(typeof tpl.system).toBe('string');
      expect(typeof tpl.user).toBe('string');
      expect(typeof tpl.schema).toBe('object');
    }
  });

  it('buildPrompt returns system, user, schema', () => {
    const result = buildPrompt('decompose', { feature_name: 'TestFeature', working_directory: '/test' });
    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('user');
    expect(result).toHaveProperty('schema');
    expect(typeof result.system).toBe('string');
    expect(typeof result.user).toBe('string');
  });

  it('buildPrompt substitutes variables into user prompt', () => {
    const result = buildPrompt('decompose', {
      feature_name: 'MyFeature',
      feature_description: 'A great feature',
      working_directory: '/project',
      project_structure: 'src/, tests/',
      existing_patterns: 'MVC pattern',
    });
    expect(result.user).toContain('MyFeature');
    expect(result.user).toContain('A great feature');
    expect(result.user).toContain('/project');
    expect(result.user).toContain('src/, tests/');
    expect(result.user).toContain('MVC pattern');
  });

  it('buildPrompt replaces missing variables with empty string', () => {
    const result = buildPrompt('decompose', { feature_name: 'X', working_directory: '/y' });
    // feature_description, project_structure, existing_patterns should be replaced with ''
    expect(result.user).not.toContain('{{');
  });

  it('buildPrompt throws on unknown template', () => {
    expect(() => buildPrompt('nonexistent', {})).toThrow('Unknown template');
  });

  it('diagnose template substitutes all variables', () => {
    const result = buildPrompt('diagnose', {
      task_description: 'Build X',
      error_output: 'Error: ENOENT',
      provider: 'codex',
      exit_code: '1',
      retry_count: '2',
    });
    expect(result.user).toContain('Build X');
    expect(result.user).toContain('Error: ENOENT');
    expect(result.user).toContain('codex');
  });

  it('review template substitutes all variables', () => {
    const result = buildPrompt('review', {
      task_description: 'Write tests',
      task_output: 'test output here',
      validation_results: 'all clean',
      file_changes: '+50 -10',
      build_output: 'BUILD SUCCESS',
    });
    expect(result.user).toContain('Write tests');
    expect(result.user).toContain('test output here');
    expect(result.user).toContain('BUILD SUCCESS');
  });
});


// ────────────────────────────────────────────────────────────────
// response-parser.js
// ────────────────────────────────────────────────────────────────
describe('response-parser', () => {
  const { extractJson, extractJsonArray } = require('../orchestrator/response-parser');

  describe('extractJson', () => {
    it('extracts JSON from fenced code block', () => {
      const text = 'Some preamble\n```json\n{"action": "retry", "confidence": 0.8}\n```\nSome epilogue';
      const result = extractJson(text);
      expect(result).toEqual({ action: 'retry', confidence: 0.8 });
    });

    it('extracts JSON from non-json fenced block', () => {
      const text = 'Here:\n```\n{"key": "value"}\n```';
      const result = extractJson(text);
      expect(result).toEqual({ key: 'value' });
    });

    it('extracts JSON by brace matching when no fence', () => {
      const text = 'The result is {"decision": "approve", "score": 95} and that is it.';
      const result = extractJson(text);
      expect(result).toEqual({ decision: 'approve', score: 95 });
    });

    it('handles nested objects', () => {
      const text = '{"outer": {"inner": {"deep": true}}, "flat": 1}';
      const result = extractJson(text);
      expect(result).toEqual({ outer: { inner: { deep: true } }, flat: 1 });
    });

    it('handles strings with braces inside', () => {
      const text = '{"msg": "hello {world}", "ok": true}';
      const result = extractJson(text);
      expect(result).toEqual({ msg: 'hello {world}', ok: true });
    });

    it('returns null for empty input', () => {
      expect(extractJson('')).toBeNull();
      expect(extractJson(null)).toBeNull();
      expect(extractJson(undefined)).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(extractJson(42)).toBeNull();
      expect(extractJson({})).toBeNull();
    });

    it('returns null for text with no JSON', () => {
      expect(extractJson('Just plain text with no JSON at all')).toBeNull();
    });

    it('returns null for invalid JSON in braces', () => {
      expect(extractJson('{not valid json}')).toBeNull();
    });

    it('returns null for arrays (extractJson only returns objects)', () => {
      const text = '```json\n[1, 2, 3]\n```';
      // extractJson skips arrays from fence, then tries brace matching with {
      expect(extractJson(text)).toBeNull();
    });
  });

  describe('extractJsonArray', () => {
    it('extracts array from fenced code block', () => {
      const text = '```json\n[{"id": 1}, {"id": 2}]\n```';
      const result = extractJsonArray(text);
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('extracts array by bracket matching', () => {
      const text = 'Results: [1, 2, 3] done.';
      const result = extractJsonArray(text);
      expect(result).toEqual([1, 2, 3]);
    });

    it('returns null for empty input', () => {
      expect(extractJsonArray('')).toBeNull();
      expect(extractJsonArray(null)).toBeNull();
    });

    it('returns null for objects (not arrays)', () => {
      const text = '```json\n{"not": "array"}\n```';
      expect(extractJsonArray(text)).toBeNull();
    });
  });
});


// ────────────────────────────────────────────────────────────────
// deterministic-fallbacks.js
// ────────────────────────────────────────────────────────────────
describe('deterministic-fallbacks', () => {
  const { fallbackDecompose, fallbackDiagnose, fallbackReview } = require('../orchestrator/deterministic-fallbacks');

  describe('fallbackDecompose', () => {
    it('returns 6 standard tasks (types, data, events, system, tests, wire)', () => {
      const result = fallbackDecompose({ feature_name: 'Inventory', working_directory: '/game' });
      expect(result.tasks).toHaveLength(6);
      const steps = result.tasks.map(t => t.step);
      expect(steps).toEqual(['types', 'data', 'events', 'system', 'tests', 'wire']);
    });

    it('sets source to deterministic', () => {
      const result = fallbackDecompose({ feature_name: 'X', working_directory: '/y' });
      expect(result.source).toBe('deterministic');
    });

    it('includes feature name in task descriptions', () => {
      const result = fallbackDecompose({ feature_name: 'CraftingSystem', working_directory: '/game' });
      for (const task of result.tasks) {
        expect(task.description).toContain('CraftingSystem');
      }
    });

    it('includes working directory in task descriptions', () => {
      const result = fallbackDecompose({ feature_name: 'X', working_directory: '/my/project' });
      for (const task of result.tasks) {
        expect(task.description).toContain('/my/project');
      }
    });

    it('has correct dependency chains', () => {
      const result = fallbackDecompose({ feature_name: 'X', working_directory: '/y' });
      const byStep = {};
      for (const t of result.tasks) byStep[t.step] = t;

      expect(byStep.types.depends_on).toEqual([]);
      expect(byStep.data.depends_on).toContain('types');
      expect(byStep.events.depends_on).toContain('types');
      expect(byStep.system.depends_on).toContain('types');
      expect(byStep.system.depends_on).toContain('data');
      expect(byStep.system.depends_on).toContain('events');
      expect(byStep.tests.depends_on).toContain('system');
      expect(byStep.wire.depends_on).toContain('system');
    });

    it('hints codex for tests step', () => {
      const result = fallbackDecompose({ feature_name: 'X', working_directory: '/y' });
      const testsTask = result.tasks.find(t => t.step === 'tests');
      expect(testsTask.provider_hint).toBe('codex');
    });

    it('returns confidence of 0.6', () => {
      const result = fallbackDecompose({ feature_name: 'X', working_directory: '/y' });
      expect(result.confidence).toBe(0.6);
    });
  });

  describe('fallbackDiagnose', () => {
    it('detects timeout errors', () => {
      const result = fallbackDiagnose({ error_output: 'Error: timed out after 300s', provider: 'codex', exit_code: 1 });
      expect(result.action).toBe('retry');
      expect(result.reason).toContain('timed out');
    });

    it('detects OOM errors and suggests deepinfra', () => {
      const result = fallbackDiagnose({ error_output: 'CUDA out of memory', provider: 'ollama', exit_code: 1 });
      expect(result.action).toBe('switch_provider');
      expect(result.suggested_provider).toBe('deepinfra');
    });

    it('detects rate limit errors', () => {
      const result = fallbackDiagnose({ error_output: 'Error 429: too many requests', provider: 'groq', exit_code: 1 });
      expect(result.action).toBe('retry');
    });

    it('detects connection errors', () => {
      const result = fallbackDiagnose({ error_output: 'ECONNREFUSED localhost:11434', provider: 'ollama', exit_code: 1 });
      expect(result.action).toBe('switch_provider');
    });

    it('detects TypeScript errors and suggests fix_task', () => {
      const result = fallbackDiagnose({ error_output: 'error TS2322: Type "string" is not assignable', provider: 'codex', exit_code: 1 });
      expect(result.action).toBe('fix_task');
    });

    it('detects syntax errors', () => {
      const result = fallbackDiagnose({ error_output: 'SyntaxError: Unexpected token }', provider: 'ollama', exit_code: 1 });
      expect(result.action).toBe('fix_task');
    });

    it('detects test failures', () => {
      const result = fallbackDiagnose({ error_output: 'FAILED Tests: 3 failed, 10 passed', provider: 'codex', exit_code: 1 });
      expect(result.action).toBe('fix_task');
    });

    it('escalates on unrecognized errors', () => {
      const result = fallbackDiagnose({ error_output: 'Something completely unknown happened', provider: 'codex', exit_code: 1 });
      expect(result.action).toBe('escalate');
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('handles empty error output', () => {
      const result = fallbackDiagnose({ error_output: '', provider: 'codex', exit_code: 1 });
      expect(result.action).toBe('escalate');
    });

    it('handles undefined error output', () => {
      const result = fallbackDiagnose({ provider: 'codex', exit_code: 1 });
      expect(result.action).toBe('escalate');
    });

    it('preserves original provider and exit code', () => {
      const result = fallbackDiagnose({ error_output: 'timeout', provider: 'ollama', exit_code: 137 });
      expect(result.original_provider).toBe('ollama');
      expect(result.exit_code).toBe(137);
    });

    it('always sets source to deterministic', () => {
      const result = fallbackDiagnose({ error_output: 'anything', provider: 'x', exit_code: 1 });
      expect(result.source).toBe('deterministic');
    });
  });

  describe('fallbackReview', () => {
    it('approves when no failures', () => {
      const result = fallbackReview({ validation_failures: [], file_size_delta_pct: 0 });
      expect(result.decision).toBe('approve');
      expect(result.confidence).toBe(0.9);
    });

    it('rejects on >50% file size decrease', () => {
      const result = fallbackReview({ validation_failures: [], file_size_delta_pct: -65 });
      expect(result.decision).toBe('reject');
      expect(result.reason).toContain('65%');
    });

    it('rejects on critical validation failures', () => {
      const result = fallbackReview({
        validation_failures: [
          { severity: 'critical', rule: 'empty_file' },
          { severity: 'warning', rule: 'large_diff' },
        ],
        file_size_delta_pct: 0,
      });
      expect(result.decision).toBe('reject');
      expect(result.reason).toContain('empty_file');
    });

    it('rejects on error-severity validation failures', () => {
      const result = fallbackReview({
        validation_failures: [{ severity: 'error', rule: 'stub_detected' }],
        file_size_delta_pct: 0,
      });
      expect(result.decision).toBe('reject');
    });

    it('approves with warnings (lower confidence)', () => {
      const result = fallbackReview({
        validation_failures: [{ severity: 'warning', rule: 'minor_issue' }],
        file_size_delta_pct: 0,
      });
      expect(result.decision).toBe('approve');
      expect(result.confidence).toBe(0.7);
      expect(result.warnings).toContain('minor_issue');
    });

    it('file size decrease takes priority over critical failures', () => {
      const result = fallbackReview({
        validation_failures: [{ severity: 'critical', rule: 'truncated' }],
        file_size_delta_pct: -80,
      });
      expect(result.decision).toBe('reject');
      expect(result.reason).toContain('80%');
    });

    it('handles undefined validation_failures', () => {
      const result = fallbackReview({ file_size_delta_pct: 0 });
      expect(result.decision).toBe('approve');
    });

    it('handles undefined file_size_delta_pct', () => {
      const result = fallbackReview({ validation_failures: [] });
      expect(result.decision).toBe('approve');
    });

    it('always sets source to deterministic', () => {
      const result = fallbackReview({ validation_failures: [], file_size_delta_pct: 0 });
      expect(result.source).toBe('deterministic');
    });
  });
});


// ────────────────────────────────────────────────────────────────
// strategic-brain.js
// ────────────────────────────────────────────────────────────────
describe('StrategicBrain', () => {
  const StrategicBrain = require('../orchestrator/strategic-brain');
  const { resolveOllamaModel } = require('../providers/ollama-shared');
  const { DEFAULT_FALLBACK_MODEL } = require('../constants');

  describe('constructor', () => {
    it('defaults to ollama provider when no env vars or config', () => {
      // Clear env vars for test
      const saved = { ...process.env };
      delete process.env.DEEPINFRA_API_KEY;
      delete process.env.HYPERBOLIC_API_KEY;

      const brain = new StrategicBrain({});
      expect(brain.provider).toBe('ollama');

      // Restore
      Object.assign(process.env, saved);
    });

    it('uses configured provider when apiKey is provided', () => {
      const brain = new StrategicBrain({ provider: 'deepinfra', apiKey: 'test-key' });
      expect(brain.provider).toBe('deepinfra');
    });

    it('defaults to deepinfra when apiKey provided without specific provider', () => {
      const brain = new StrategicBrain({ apiKey: 'test-key' });
      expect(brain.provider).toBe('deepinfra');
    });

    it('uses default model for selected provider', () => {
      const brain = new StrategicBrain({ provider: 'ollama' });
      expect(brain.model).toBe(resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL);
    });

    it('allows model override', () => {
      const brain = new StrategicBrain({ model: 'custom-model' });
      expect(brain.model).toBe('custom-model');
    });

    it('sets default confidence threshold', () => {
      const brain = new StrategicBrain({});
      expect(brain.confidenceThreshold).toBe(0.4);
    });

    it('allows confidence threshold override', () => {
      const brain = new StrategicBrain({ confidenceThreshold: 0.8 });
      expect(brain.confidenceThreshold).toBe(0.8);
    });

    it('initializes usage counters to zero', () => {
      const brain = new StrategicBrain({});
      const usage = brain.getUsage();
      expect(usage.total_calls).toBe(0);
      expect(usage.total_tokens).toBe(0);
      expect(usage.total_cost).toBe(0);
      expect(usage.fallback_calls).toBe(0);
    });
  });

  describe('getUsage / resetUsage', () => {
    it('getUsage returns a copy (not the internal object)', () => {
      const brain = new StrategicBrain({});
      const usage1 = brain.getUsage();
      usage1.total_calls = 999;
      const usage2 = brain.getUsage();
      expect(usage2.total_calls).toBe(0);
    });

    it('resetUsage zeros all counters', () => {
      const brain = new StrategicBrain({});
      brain._usage.total_calls = 5;
      brain._usage.total_tokens = 1000;
      brain._usage.fallback_calls = 2;
      brain.resetUsage();
      const usage = brain.getUsage();
      expect(usage.total_calls).toBe(0);
      expect(usage.total_tokens).toBe(0);
      expect(usage.fallback_calls).toBe(0);
    });
  });

  describe('_strategicCall fallback behavior', () => {
    it('falls back to deterministic when LLM throws', async () => {
      const brain = new StrategicBrain({
        providerInstance: {
          submit: vi.fn().mockRejectedValue(new Error('Network error')),
        },
      });

      const result = await brain.decompose({
        feature_name: 'TestFeature',
        working_directory: '/test',
      });

      expect(result.source).toBe('deterministic');
      expect(result.fallback_reason).toBe('Network error');
      expect(result.tasks).toHaveLength(6);
      expect(brain.getUsage().fallback_calls).toBe(1);
    });

    it('falls back when LLM returns unparseable output', async () => {
      const brain = new StrategicBrain({
        providerInstance: {
          submit: vi.fn().mockResolvedValue({
            output: 'This is not JSON at all!',
            usage: { tokens: 100 },
          }),
        },
      });

      const result = await brain.decompose({
        feature_name: 'TestFeature',
        working_directory: '/test',
      });

      expect(result.source).toBe('deterministic');
      expect(result.fallback_reason).toBe('unparseable_output');
      expect(brain.getUsage().fallback_calls).toBe(1);
    });

    it('falls back when LLM confidence is below threshold', async () => {
      const brain = new StrategicBrain({
        confidenceThreshold: 0.6,
        providerInstance: {
          submit: vi.fn().mockResolvedValue({
            output: '{"tasks": [], "confidence": 0.3}',
            usage: { tokens: 50 },
          }),
        },
      });

      const result = await brain.decompose({
        feature_name: 'TestFeature',
        working_directory: '/test',
      });

      expect(result.source).toBe('deterministic');
      expect(result.fallback_reason).toBe('low_confidence');
    });

    it('returns LLM result when confidence is above threshold', async () => {
      const brain = new StrategicBrain({
        confidenceThreshold: 0.4,
        providerInstance: {
          submit: vi.fn().mockResolvedValue({
            output: '{"tasks": [{"step": "types", "description": "Custom task", "depends_on": []}], "confidence": 0.9}',
            usage: { tokens: 200, cost: 0.01, duration_ms: 1500 },
          }),
        },
      });

      const result = await brain.decompose({
        feature_name: 'TestFeature',
        working_directory: '/test',
      });

      expect(result.source).toBe('llm');
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].description).toBe('Custom task');
      expect(brain.getUsage().total_calls).toBe(1);
      expect(brain.getUsage().total_tokens).toBe(200);
      expect(brain.getUsage().fallback_calls).toBe(0);
    });

    it('tracks usage from LLM calls', async () => {
      const brain = new StrategicBrain({
        providerInstance: {
          submit: vi.fn().mockResolvedValue({
            output: '{"action": "retry", "reason": "timeout", "confidence": 0.8}',
            usage: { tokens: 300, cost: 0.05, duration_ms: 2000 },
          }),
        },
      });

      await brain.diagnose({
        task_description: 'Build X',
        error_output: 'timeout',
        provider: 'codex',
        exit_code: 1,
        retry_count: 0,
      });

      const usage = brain.getUsage();
      expect(usage.total_calls).toBe(1);
      expect(usage.total_tokens).toBe(300);
      expect(usage.total_cost).toBe(0.05);
      expect(usage.total_duration_ms).toBe(2000);
    });
  });

  describe('diagnose', () => {
    it('truncates error_output to 5120 chars', async () => {
      const longError = 'x'.repeat(10000);
      let capturedPrompt = '';

      const brain = new StrategicBrain({
        providerInstance: {
          submit: vi.fn().mockImplementation((prompt) => {
            capturedPrompt = prompt;
            return { output: '{"action": "retry", "reason": "test", "confidence": 0.9}', usage: { tokens: 10 } };
          }),
        },
      });

      await brain.diagnose({
        task_description: 'Test',
        error_output: longError,
        provider: 'codex',
        exit_code: 1,
      });

      // The error_output in the prompt should be truncated
      const errorInPrompt = capturedPrompt.match(/```\n([\s\S]*?)\n```/)?.[1] || '';
      expect(errorInPrompt.length).toBeLessThanOrEqual(5120);
    });
  });

  describe('review', () => {
    it('formats validation_failures array into string', async () => {
      let capturedPrompt = '';

      const brain = new StrategicBrain({
        providerInstance: {
          submit: vi.fn().mockImplementation((prompt) => {
            capturedPrompt = prompt;
            return { output: '{"decision": "approve", "reason": "ok", "confidence": 0.9}', usage: { tokens: 10 } };
          }),
        },
      });

      await brain.review({
        task_description: 'Test task',
        task_output: 'output',
        validation_failures: [
          { severity: 'warning', rule: 'large_diff', details: 'big change' },
          { severity: 'error', rule: 'stub_found', details: 'TODO detected' },
        ],
      });

      expect(capturedPrompt).toContain('[warning] large_diff');
      expect(capturedPrompt).toContain('[error] stub_found');
    });
  });
});
