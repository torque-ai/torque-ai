import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockDiagnose,
  mockReview,
  StrategicBrainMock,
  mockDb,
  mockLogger,
} = vi.hoisted(() => ({
  mockDiagnose: vi.fn(),
  mockReview: vi.fn(),
  StrategicBrainMock: vi.fn(),
  mockDb: {
    getConfig: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
  },
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let hooks;

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

function loadHooks() {
  delete require.cache[require.resolve('../execution/strategic-hooks')];
  installCjsModuleMock('../orchestrator/strategic-brain', StrategicBrainMock);
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../config', createConfigMock(mockDb));
  installCjsModuleMock('../logger', {
    child: vi.fn(() => mockLogger),
  });
  return require('../execution/strategic-hooks');
}

function createCtx(overrides = {}) {
  const task = {
    id: 'task-001',
    task_description: 'Investigate failing test',
    provider: 'codex',
    retry_count: 2,
    output: 'task output',
    error_output: 'task error output',
    tags: [],
    metadata: { existing: true },
    ...overrides.task,
  };

  return {
    taskId: task.id,
    code: 1,
    output: 'final output',
    errorOutput: 'final error output',
    proc: { provider: 'codex' },
    ...overrides,
    task,
  };
}

function setConfigValues(values = {}) {
  mockDb.getConfig.mockImplementation((key) => values[key] ?? null);
}

describe('strategic-hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    StrategicBrainMock.mockImplementation(function StrategicBrainCtor() {
      this.diagnose = mockDiagnose;
      this.review = mockReview;
    });
    mockDb.updateTask.mockImplementation((taskId, fields) => ({
      id: taskId,
      ...fields,
    }));
    hooks = loadHooks();
  });

  describe('onTaskFailed', () => {
    it('calls diagnose when strategic_auto_diagnose is enabled', async () => {
      const ctx = createCtx();
      const diagnosis = { action: 'fix_task', confidence: 0.85, reason: 'Add missing import' };
      setConfigValues({
        strategic_auto_diagnose: '1',
        strategic_provider: 'ollama',
        strategic_model: 'qwen2.5-coder:32b',
      });
      mockDb.getTask.mockReturnValue(ctx.task);
      mockDiagnose.mockResolvedValue(diagnosis);

      const result = await hooks.onTaskFailed(ctx);

      expect(StrategicBrainMock).toHaveBeenCalledWith({
        provider: 'ollama',
        model: 'qwen2.5-coder:32b',
      });
      expect(mockDiagnose).toHaveBeenCalledWith({
        task_description: 'Investigate failing test',
        error_output: 'final error output',
        provider: 'codex',
        exit_code: 1,
        retry_count: 2,
      });
      expect(result).toEqual(diagnosis);
    });

    it('skips when disabled', async () => {
      const ctx = createCtx();
      setConfigValues({ strategic_auto_diagnose: '0' });

      const result = await hooks.onTaskFailed(ctx);

      expect(result).toBeNull();
      expect(StrategicBrainMock).not.toHaveBeenCalled();
      expect(mockDiagnose).not.toHaveBeenCalled();
      expect(mockDb.updateTask).not.toHaveBeenCalled();
    });

    it('skips for tasks tagged strategic', async () => {
      const ctx = createCtx({ task: { tags: ['strategic'] } });
      setConfigValues({ strategic_auto_diagnose: '1' });
      mockDb.getTask.mockReturnValue(ctx.task);

      const result = await hooks.onTaskFailed(ctx);

      expect(result).toBeNull();
      expect(StrategicBrainMock).not.toHaveBeenCalled();
      expect(mockDiagnose).not.toHaveBeenCalled();
      expect(mockDb.updateTask).not.toHaveBeenCalled();
    });

    it('stores diagnosis in task metadata', async () => {
      const ctx = createCtx({ task: { metadata: { existing: true, keep: 'value' } } });
      const diagnosis = { action: 'fix_task', confidence: 0.9, reason: 'Retry with fix' };
      setConfigValues({ strategic_auto_diagnose: '1' });
      mockDb.getTask.mockReturnValue(ctx.task);
      mockDiagnose.mockResolvedValue(diagnosis);

      await hooks.onTaskFailed(ctx);

      expect(mockDb.updateTask).toHaveBeenCalledWith('task-001', {
        metadata: {
          existing: true,
          keep: 'value',
          strategic_diagnosis: diagnosis,
        },
      });
    });

    it('does not throw even when brain.diagnose fails', async () => {
      const ctx = createCtx();
      setConfigValues({ strategic_auto_diagnose: '1' });
      mockDb.getTask.mockReturnValue(ctx.task);
      mockDiagnose.mockRejectedValue(new Error('diagnose failed'));

      await expect(hooks.onTaskFailed(ctx)).resolves.toBeNull();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('onTaskCompleted', () => {
    it('calls review when strategic_auto_review is enabled', async () => {
      const ctx = createCtx({
        code: 0,
        task: {
          output: 'stored output',
        },
      });
      const review = { decision: 'approve', quality_score: 88, reason: 'Looks good' };
      setConfigValues({
        strategic_auto_review: '1',
        strategic_provider: 'ollama',
        strategic_model: 'qwen2.5-coder:32b',
      });
      mockDb.getTask.mockReturnValue(ctx.task);
      mockReview.mockResolvedValue(review);

      const result = await hooks.onTaskCompleted(ctx);

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
      expect(result).toEqual(review);
    });

    it('skips when disabled', async () => {
      const ctx = createCtx({ code: 0 });
      setConfigValues({ strategic_auto_review: '0' });

      const result = await hooks.onTaskCompleted(ctx);

      expect(result).toBeNull();
      expect(StrategicBrainMock).not.toHaveBeenCalled();
      expect(mockReview).not.toHaveBeenCalled();
      expect(mockDb.updateTask).not.toHaveBeenCalled();
    });

    it('skips for tasks tagged strategic', async () => {
      const ctx = createCtx({ code: 0, task: { tags: ['strategic'] } });
      setConfigValues({ strategic_auto_review: '1' });
      mockDb.getTask.mockReturnValue(ctx.task);

      const result = await hooks.onTaskCompleted(ctx);

      expect(result).toBeNull();
      expect(StrategicBrainMock).not.toHaveBeenCalled();
      expect(mockReview).not.toHaveBeenCalled();
      expect(mockDb.updateTask).not.toHaveBeenCalled();
    });

    it('stores review in task metadata', async () => {
      const ctx = createCtx({ code: 0, task: { metadata: { existing: true, keep: 'value' } } });
      const review = { decision: 'approve', quality_score: 91, reason: 'Solid change' };
      setConfigValues({ strategic_auto_review: '1' });
      mockDb.getTask.mockReturnValue(ctx.task);
      mockReview.mockResolvedValue(review);

      await hooks.onTaskCompleted(ctx);

      expect(mockDb.updateTask).toHaveBeenCalledWith('task-001', {
        metadata: {
          existing: true,
          keep: 'value',
          strategic_review: review,
        },
      });
    });

    it('does not throw even when brain.review fails', async () => {
      const ctx = createCtx({ code: 0 });
      setConfigValues({ strategic_auto_review: '1' });
      mockDb.getTask.mockReturnValue(ctx.task);
      mockReview.mockRejectedValue(new Error('review failed'));

      await expect(hooks.onTaskCompleted(ctx)).resolves.toBeNull();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});
