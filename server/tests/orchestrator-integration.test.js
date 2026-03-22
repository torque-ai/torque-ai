import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../logger', () => ({
  child: vi.fn(() => mockLogger),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const originalOllamaHost = process.env.OLLAMA_STRATEGIC_HOST;
const originalOllamaBaseHost = process.env.OLLAMA_HOST;

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Ignore modules that have not been loaded yet.
  }
}

function loadFresh(modulePath) {
  clearModule(modulePath);
  return require(modulePath);
}

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function createConfigMock(dbRef) {
  return {
    init: vi.fn(),
    get: vi.fn((key, fallback) => {
      const val = dbRef.getConfig(key);
      return val !== null && val !== undefined ? val : (fallback !== undefined ? fallback : null);
    }),
    getInt: vi.fn((key, fallback) => {
      const val = dbRef.getConfig(key);
      if (val === null || val === undefined) return fallback !== undefined ? fallback : 0;
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? (fallback !== undefined ? fallback : 0) : parsed;
    }),
    getBool: vi.fn((key) => {
      const val = dbRef.getConfig(key);
      if (val === null || val === undefined) return true;
      return val !== '0' && val !== 'false';
    }),
    isOptIn: vi.fn((key) => {
      const val = dbRef.getConfig(key);
      return val === '1' || val === 'true';
    }),
    getFloat: vi.fn(),
    getJson: vi.fn(),
    getApiKey: vi.fn(),
    hasApiKey: vi.fn(),
    getPort: vi.fn(),
  };
}

function createOllamaResponse(payload, usage = { prompt_tokens: 64, completion_tokens: 32, total_tokens: 96 }) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage,
    }),
  };
}

function createApiResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function createTask(overrides = {}) {
  return {
    id: 'task-001',
    task_description: 'Investigate failing test',
    provider: 'codex',
    retry_count: 2,
    output: 'stored output',
    error_output: 'stored error output',
    tags: [],
    metadata: { existing: true },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();

  if (originalOllamaHost === undefined) {
    delete process.env.OLLAMA_STRATEGIC_HOST;
  } else {
    process.env.OLLAMA_STRATEGIC_HOST = originalOllamaHost;
  }
  if (originalOllamaBaseHost === undefined) {
    delete process.env.OLLAMA_HOST;
  } else {
    process.env.OLLAMA_HOST = originalOllamaBaseHost;
  }

  delete global.fetch;

  for (const modulePath of [
    '../providers/ollama-strategic',
    '../orchestrator/strategic-brain',
    '../execution/strategic-hooks',
    '../database',
    '../config',
    '../logger',
    '../tools',
    '../tool-defs/orchestrator-defs',
    '../handlers/orchestrator-handlers',
    '../../cli/api-client',
    '../../cli/commands',
    '../../cli/formatter',
  ]) {
    clearModule(modulePath);
  }

  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
});

describe('orchestrator integration', () => {
  describe('StrategicBrain with Ollama provider', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
      delete process.env.OLLAMA_STRATEGIC_HOST;
      delete process.env.OLLAMA_HOST;
    });

    it('creates correctly and routes decompose, diagnose, and review through Ollama', async () => {
      const StrategicBrain = loadFresh('../orchestrator/strategic-brain');
      const brain = new StrategicBrain({
        provider: 'ollama',
        model: 'qwen2.5-coder:32b',
      });

      global.fetch
        .mockResolvedValueOnce(createOllamaResponse({
          tasks: [
            { step: 'types', description: 'Create types', depends_on: [] },
            { step: 'system', description: 'Build the system', depends_on: ['types'] },
          ],
          reasoning: 'Use the standard sequence',
          confidence: 0.92,
        }))
        .mockResolvedValueOnce(createOllamaResponse({
          action: 'fix_task',
          reason: 'Add the missing import',
          fix_description: 'Import the missing symbol before rerunning',
          confidence: 0.88,
        }))
        .mockResolvedValueOnce(createOllamaResponse({
          decision: 'approve',
          reason: 'Validation is clean',
          quality_score: 91,
          issues: [],
          confidence: 0.95,
        }));

      expect(brain.provider).toBe('ollama');
      expect(brain._getProvider().name).toMatch(/^ollama/);

      const decomposition = await brain.decompose({
        feature_name: 'OrchestratorIntegration',
        feature_description: 'Verify the orchestrator features work together',
        working_directory: 'C:\\repo',
      });
      const diagnosis = await brain.diagnose({
        task_description: 'Fix the orchestrator hooks',
        error_output: 'error TS2304: Cannot find name StrategicBrain',
        provider: 'ollama',
        exit_code: 1,
      });
      const review = await brain.review({
        task_description: 'Add integration coverage',
        task_output: 'Created orchestrator-integration.test.js',
        validation_failures: [],
        file_size_delta_pct: 12,
        file_changes: 'server/tests/orchestrator-integration.test.js',
        build_output: 'vitest passed',
      });

      expect(decomposition.source).toBe('llm');
      expect(decomposition.tasks).toHaveLength(2);
      expect(diagnosis).toMatchObject({
        action: 'fix_task',
        source: 'llm',
      });
      expect(review).toMatchObject({
        decision: 'approve',
        source: 'llm',
        quality_score: 91,
      });

      expect(global.fetch).toHaveBeenCalledTimes(3);
      for (const [url, options] of global.fetch.mock.calls) {
        expect(url).toBe('http://localhost:11434/v1/chat/completions');
        expect(options.method).toBe('POST');
        expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(options.signal).toBeInstanceOf(AbortSignal);
      }

      const firstRequest = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(firstRequest.model).toBe('qwen2.5-coder:32b');
      expect(firstRequest.max_tokens).toBe(4096);
      expect(firstRequest.temperature).toBe(0.3);
      expect(firstRequest.messages[0].content).toContain('OrchestratorIntegration');

      expect(brain.getUsage()).toMatchObject({
        total_calls: 3,
        total_tokens: 288,
        total_cost: 0,
        fallback_calls: 0,
      });
    });

    it('falls back to deterministic when Ollama is down', async () => {
      const StrategicBrain = loadFresh('../orchestrator/strategic-brain');
      const brain = new StrategicBrain({
        provider: 'ollama',
        model: 'qwen2.5-coder:32b',
      });

      global.fetch.mockRejectedValue(new Error('connect ECONNREFUSED 192.0.2.100:11434'));

      const result = await brain.decompose({
        feature_name: 'FallbackFeature',
        working_directory: 'C:\\repo',
      });

      expect(result.source).toBe('deterministic');
      expect(result.tasks).toHaveLength(6);
      expect(result.fallback_reason).toMatch(/ECONNREFUSED/);
      expect(brain.getUsage()).toMatchObject({
        total_calls: 0,
        fallback_calls: 1,
      });
    });
  });

  describe('lifecycle hooks integration', () => {
    const mockDiagnose = vi.fn();
    const mockReview = vi.fn();
    const StrategicBrainMock = vi.fn();
    const mockDb = {
      getConfig: vi.fn(),
      getTask: vi.fn(),
      updateTask: vi.fn(),
    };

    function loadHooks(tasks, configValues) {
      mockDb.getConfig.mockImplementation((key) => configValues[key] ?? null);
      mockDb.getTask.mockImplementation((taskId) => tasks.get(taskId) || null);
      mockDb.updateTask.mockImplementation((taskId, fields) => {
        const current = tasks.get(taskId) || { id: taskId };
        const updated = { ...current, ...fields };
        tasks.set(taskId, updated);
        return updated;
      });
      StrategicBrainMock.mockImplementation(function StrategicBrainCtor() {
        this.diagnose = mockDiagnose;
        this.review = mockReview;
      });

      clearModule('../execution/strategic-hooks');
      installCjsModuleMock('../orchestrator/strategic-brain', StrategicBrainMock);
      installCjsModuleMock('../database', mockDb);
      installCjsModuleMock('../config', createConfigMock(mockDb));
      installCjsModuleMock('../logger', {
        child: vi.fn(() => mockLogger),
      });
      return require('../execution/strategic-hooks');
    }

    beforeEach(() => {
      mockDiagnose.mockReset();
      mockReview.mockReset();
      StrategicBrainMock.mockReset();
      mockDb.getConfig.mockReset();
      mockDb.getTask.mockReset();
      mockDb.updateTask.mockReset();
    });

    it('diagnoses failed tasks and stores strategic_diagnosis when auto diagnose is enabled', async () => {
      const tasks = new Map([
        ['task-failed', createTask({ id: 'task-failed', metadata: { existing: true } })],
      ]);
      const diagnosis = { action: 'fix_task', reason: 'Add import', confidence: 0.84 };
      const hooks = loadHooks(tasks, {
        strategic_auto_diagnose: '1',
        strategic_provider: 'ollama',
        strategic_model: 'qwen2.5-coder:32b',
      });

      mockDiagnose.mockResolvedValue(diagnosis);

      const result = await hooks.onTaskFailed({
        taskId: 'task-failed',
        code: 1,
        errorOutput: 'error TS2304',
        proc: { provider: 'ollama' },
        task: tasks.get('task-failed'),
      });

      expect(result).toEqual(diagnosis);
      expect(StrategicBrainMock).toHaveBeenCalledWith({
        provider: 'ollama',
        model: 'qwen2.5-coder:32b',
      });
      expect(mockDiagnose).toHaveBeenCalledWith({
        task_description: 'Investigate failing test',
        error_output: 'error TS2304',
        provider: 'ollama',
        exit_code: 1,
        retry_count: 2,
      });
      expect(tasks.get('task-failed').metadata.strategic_diagnosis).toEqual(diagnosis);
    });

    it('reviews completed tasks and stores strategic_review when auto review is enabled', async () => {
      const tasks = new Map([
        ['task-complete', createTask({ id: 'task-complete', metadata: { existing: true, keep: 'value' } })],
      ]);
      const review = { decision: 'approve', reason: 'Looks good', quality_score: 89 };
      const hooks = loadHooks(tasks, {
        strategic_auto_review: '1',
        strategic_provider: 'ollama',
        strategic_model: 'qwen2.5-coder:32b',
      });

      mockReview.mockResolvedValue(review);

      const result = await hooks.onTaskCompleted({
        taskId: 'task-complete',
        code: 0,
        output: 'final output',
        task: tasks.get('task-complete'),
      });

      expect(result).toEqual(review);
      expect(StrategicBrainMock).toHaveBeenCalledWith({
        provider: 'ollama',
        model: 'qwen2.5-coder:32b',
      });
      expect(mockReview).toHaveBeenCalledWith({
        task_description: 'Investigate failing test',
        task_output: 'final output',
        validation_failures: [],
        file_size_delta_pct: 0,
      });
      expect(tasks.get('task-complete').metadata).toEqual({
        existing: true,
        keep: 'value',
        strategic_review: review,
      });
    });

    it('never throws even when strategic providers are broken', async () => {
      const tasks = new Map([
        ['task-failed', createTask({ id: 'task-failed' })],
        ['task-complete', createTask({ id: 'task-complete' })],
      ]);
      const hooks = loadHooks(tasks, {
        strategic_auto_diagnose: '1',
        strategic_auto_review: '1',
      });

      mockDiagnose.mockRejectedValue(new Error('provider down'));
      mockReview.mockRejectedValue(new Error('provider down'));

      await expect(hooks.onTaskFailed({
        taskId: 'task-failed',
        code: 1,
        errorOutput: 'connect ECONNREFUSED',
        proc: { provider: 'ollama' },
        task: tasks.get('task-failed'),
      })).resolves.toBeNull();

      await expect(hooks.onTaskCompleted({
        taskId: 'task-complete',
        code: 0,
        output: 'final output',
        task: tasks.get('task-complete'),
      })).resolves.toBeNull();

      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
      expect(tasks.get('task-failed').metadata).toEqual({ existing: true });
      expect(tasks.get('task-complete').metadata).toEqual({ existing: true });
    });
  });

  describe('CLI commands', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it('calls the status endpoints directly and formats the output', async () => {
      const { handleStatus } = loadFresh('../../cli/commands');
      const { formatCommandResult } = loadFresh('../../cli/formatter');

      global.fetch
        .mockResolvedValueOnce(createApiResponse({
          status: 'healthy',
          database: 'connected',
          ollama: 'healthy',
          queue_depth: 2,
          running_tasks: 1,
          uptime_seconds: 45,
        }))
        .mockResolvedValueOnce(createApiResponse({
          tool: 'list_tasks',
          result: [
            '## Tasks (running)',
            '',
            '| ID | Status | Model | Host | Description | Created |',
            '|----|--------|-------|------|-------------|--------|',
            '| task-123 | running | qwen2.5-coder:32b | omen | Ship orchestrator integration | 2026-03-08 10:00 |',
          ].join('\n'),
        }));

      const result = await handleStatus({}, {});
      const formatted = formatCommandResult(result);

      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        'http://127.0.0.1:3457/healthz',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        'http://127.0.0.1:3457/api/tasks?status=running&limit=5',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(formatted).toContain('Server Health');
      expect(formatted).toContain('Running Tasks');
      expect(formatted).toContain('task-123');
    });

    it('calls the strategic REST handlers directly and formats their output', async () => {
      const {
        handleDecompose,
        handleDiagnose,
        handleReview,
      } = loadFresh('../../cli/commands');
      const { formatCommandResult } = loadFresh('../../cli/formatter');

      global.fetch
        .mockResolvedValueOnce(createApiResponse({
          content: [{
            type: 'text',
            text: '## Strategic Decomposition: OrchestratorIntegration\n\n**Source:** llm\n\n### Tasks\n1. **[types]** Create types',
          }],
        }))
        .mockResolvedValueOnce(createApiResponse({
          content: [{
            type: 'text',
            text: '## Strategic Diagnosis\n\n**Action:** fix_task\n**Reason:** Missing import',
          }],
        }))
        .mockResolvedValueOnce(createApiResponse({
          content: [{
            type: 'text',
            text: '## Strategic Review\n\n**Decision:** approve\n**Reason:** Validation clean',
          }],
        }));

      const decomposeResult = await handleDecompose({
        feature: 'OrchestratorIntegration',
        directory: 'C:\\repo',
        provider: 'ollama',
        model: 'qwen2.5-coder:32b',
      }, {});
      const diagnoseResult = await handleDiagnose({
        taskId: 'task-failed',
        provider: 'ollama',
      });
      const reviewResult = await handleReview({
        taskId: 'task-complete',
        provider: 'ollama',
      });

      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        'http://127.0.0.1:3457/api/tools/strategic_decompose',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feature: 'OrchestratorIntegration',
            working_directory: 'C:\\repo',
            provider: 'ollama',
            model: 'qwen2.5-coder:32b',
          }),
        }),
      );
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        'http://127.0.0.1:3457/api/tools/strategic_diagnose',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task_id: 'task-failed',
            strategic_provider: 'ollama',
          }),
        }),
      );
      expect(global.fetch).toHaveBeenNthCalledWith(
        3,
        'http://127.0.0.1:3457/api/tools/strategic_review',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task_id: 'task-complete',
            strategic_provider: 'ollama',
          }),
        }),
      );

      expect(decomposeResult.command).toBe('decompose');
      expect(diagnoseResult.command).toBe('diagnose');
      expect(reviewResult.command).toBe('review');
      expect(formatCommandResult(decomposeResult)).toContain('Strategic Decomposition: OrchestratorIntegration');
      expect(formatCommandResult(diagnoseResult)).toContain('Strategic Diagnosis');
      expect(formatCommandResult(reviewResult)).toContain('Strategic Review');
    });
  });

  describe('tool registration', () => {
    it('registers all strategic tools and exports five orchestrator definitions', () => {
      const { routeMap } = loadFresh('../tools');
      const defs = loadFresh('../tool-defs/orchestrator-defs');
      const expectedToolNames = [
        'strategic_decompose',
        'strategic_diagnose',
        'strategic_review',
        'strategic_usage',
        'strategic_benchmark',
      ];

      expect(defs).toHaveLength(5);
      expect(defs.map((definition) => definition.name).sort()).toEqual(expectedToolNames.slice().sort());

      for (const toolName of expectedToolNames) {
        expect(routeMap.has(toolName)).toBe(true);
        expect(routeMap.get(toolName)).toEqual(expect.any(Function));
      }
    });
  });
});
