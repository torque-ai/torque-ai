'use strict';

const { smartDiagnosisStage } = require('../execution/smart-diagnosis-stage');

function parseMeta(metadata) {
  if (typeof metadata === 'string') return JSON.parse(metadata);
  return metadata;
}

function makeCtx(overrides = {}) {
  return {
    taskId: 'test-task-001',
    status: 'failed',
    code: 1,
    output: '',
    errorOutput: 'Some error occurred',
    task: {
      id: 'test-task-001',
      metadata: JSON.stringify({}),
      task_description: 'Fix the login bug',
      provider: 'ollama',
    },
    validationStages: {},
    proc: { provider: 'ollama' },
    ...overrides,
  };
}

describe('smartDiagnosisStage (Experiment 5)', () => {
  describe('skip conditions', () => {
    it('skips when task status is completed', () => {
      const ctx = makeCtx({ status: 'completed' });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.strategic_diagnosis).toBeUndefined();
    });

    it('skips when task status is cancelled', () => {
      const ctx = makeCtx({ status: 'cancelled' });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.strategic_diagnosis).toBeUndefined();
    });
  });

  describe('timeout detection', () => {
    it('diagnoses timeout errors → retry action', () => {
      const ctx = makeCtx({
        errorOutput: 'Process timed out after 300s',
      });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.strategic_diagnosis.action).toBe('retry');
      expect(metadata.strategic_diagnosis.reason).toContain('timed out');
    });

    it('diagnoses ETIMEDOUT → retry action', () => {
      const ctx = makeCtx({
        errorOutput: 'Error: connect ETIMEDOUT 192.0.2.100:11434',
      });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.strategic_diagnosis.action).toBe('retry');
    });
  });

  describe('OOM detection', () => {
    it('diagnoses CUDA OOM → switch_provider to deepinfra', () => {
      const ctx = makeCtx({
        errorOutput: 'CUDA out of memory. Tried to allocate 4GB',
      });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.strategic_diagnosis.action).toBe('switch_provider');
      expect(metadata.strategic_diagnosis.suggested_provider).toBe('deepinfra');
      expect(metadata.suggested_provider).toBe('deepinfra');
    });
  });

  describe('rate limit detection', () => {
    it('diagnoses 429 → retry action', () => {
      const ctx = makeCtx({
        errorOutput: 'Error 429: too many requests',
      });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.strategic_diagnosis.action).toBe('retry');
    });
  });

  describe('connection failure detection', () => {
    it('diagnoses ECONNREFUSED → switch_provider', () => {
      const ctx = makeCtx({
        errorOutput: 'Error: connect ECONNREFUSED 192.0.2.100:11434',
      });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.strategic_diagnosis.action).toBe('switch_provider');
      expect(metadata.suggested_provider).toBe('deepinfra');
    });
  });

  describe('code error detection', () => {
    it('diagnoses invalid configuration before timeout text → fix_task', () => {
      const ctx = makeCtx({
        errorOutput: 'Invalid configuration: invalid tick rate. Previous attempt also timed out after 600s.',
      });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.strategic_diagnosis.action).toBe('fix_task');
      expect(metadata.fix_suggestion).toContain('Invalid configuration');
    });

    it('diagnoses TypeScript errors → fix_task', () => {
      const ctx = makeCtx({
        errorOutput: "error TS2304: Cannot find name 'Observable'.",
      });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.strategic_diagnosis.action).toBe('fix_task');
      expect(metadata.fix_suggestion).toContain('TypeScript');
    });

    it('diagnoses SyntaxError → fix_task', () => {
      const ctx = makeCtx({
        errorOutput: 'SyntaxError: Unexpected token }',
      });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.strategic_diagnosis.action).toBe('fix_task');
    });

    it('diagnoses test failures → fix_task', () => {
      const ctx = makeCtx({
        errorOutput: 'FAILED tests/auth.test.js > login > should validate email\nAssertionError: expected true to be false',
      });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.strategic_diagnosis.action).toBe('fix_task');
    });
  });

  describe('unknown errors', () => {
    it('diagnoses unrecognized errors → escalate', () => {
      const ctx = makeCtx({
        errorOutput: 'Something completely unexpected happened in the quantum flux capacitor',
      });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.strategic_diagnosis.action).toBe('escalate');
      expect(metadata.needs_escalation).toBe(true);
    });
  });

  describe('metadata handling', () => {
    it('handles null metadata', () => {
      const ctx = makeCtx({
        task: { metadata: null, provider: 'ollama' },
        errorOutput: 'timeout',
      });
      smartDiagnosisStage(ctx);
      // null metadata is not a string, so stage stores as object
      const metadata = typeof ctx.task.metadata === 'string'
        ? parseMeta(ctx.task.metadata)
        : ctx.task.metadata;
      expect(metadata.strategic_diagnosis.action).toBe('retry');
    });

    it('preserves existing metadata fields', () => {
      const ctx = makeCtx({
        task: {
          metadata: JSON.stringify({ existing: 'value' }),
          provider: 'ollama',
        },
        errorOutput: 'timeout',
      });
      smartDiagnosisStage(ctx);
      const metadata = parseMeta(ctx.task.metadata);
      expect(metadata.existing).toBe('value');
      expect(metadata.strategic_diagnosis).toBeDefined();
    });

    it('handles already-parsed object metadata', () => {
      const ctx = makeCtx({
        task: { metadata: { existing: 'value' }, provider: 'codex' },
        errorOutput: 'SyntaxError: bad token',
      });
      smartDiagnosisStage(ctx);
      // When metadata is an object, it should be serialized back
      const metadata = typeof ctx.task.metadata === 'string'
        ? parseMeta(ctx.task.metadata)
        : ctx.task.metadata;
      expect(metadata.strategic_diagnosis.action).toBe('fix_task');
    });
  });
});
