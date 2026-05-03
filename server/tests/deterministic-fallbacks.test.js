import { describe, it, expect } from 'vitest';

const { fallbackDecompose, fallbackDiagnose, fallbackReview } = require('../orchestrator/deterministic-fallbacks');

describe('deterministic-fallbacks', () => {
  describe('fallbackDecompose', () => {
    it('generates standard 6-step feature decomposition', () => {
      const result = fallbackDecompose({ feature_name: 'UserProfile', working_directory: '/project' });
      expect(result.tasks).toHaveLength(6);
      expect(result.tasks[0].step).toBe('types');
      expect(result.tasks[1].step).toBe('data');
      expect(result.tasks[2].step).toBe('events');
      expect(result.tasks[3].step).toBe('system');
      expect(result.tasks[4].step).toBe('tests');
      expect(result.tasks[5].step).toBe('wire');
      expect(result.source).toBe('deterministic');
    });

    it('includes feature name in task descriptions', () => {
      const result = fallbackDecompose({ feature_name: 'InventorySlot', working_directory: '/project' });
      for (const task of result.tasks) {
        expect(task.description).toContain('InventorySlot');
      }
    });

    it('sets correct dependencies', () => {
      const result = fallbackDecompose({ feature_name: 'X', working_directory: '/p' });
      expect(result.tasks[0].depends_on).toEqual([]);
      expect(result.tasks[1].depends_on).toEqual(['types']);
      expect(result.tasks[3].depends_on).toContain('events');
      expect(result.tasks[4].depends_on).toContain('system');
      expect(result.tasks[5].depends_on).toContain('tests');
    });
  });

  describe('fallbackDiagnose', () => {
    it('recommends retry for timeout errors', () => {
      const result = fallbackDiagnose({ error_output: 'Task timed out after 600s', provider: 'ollama', exit_code: 1 });
      expect(result.action).toBe('retry');
      expect(result.reason).toMatch(/timeout/i);
      expect(result.source).toBe('deterministic');
    });

    it('recommends provider switch for OOM errors', () => {
      const result = fallbackDiagnose({ error_output: 'CUDA out of memory', provider: 'ollama', exit_code: 1 });
      expect(result.action).toBe('switch_provider');
      expect(result.suggested_provider).toBeDefined();
    });

    it('recommends fix task for TypeScript errors', () => {
      const result = fallbackDiagnose({ error_output: "error TS2304: Cannot find name 'Foo'", provider: 'codex', exit_code: 1 });
      expect(result.action).toBe('fix_task');
    });

    it('recommends escalate for unknown errors', () => {
      const result = fallbackDiagnose({ error_output: 'something completely unexpected happened', provider: 'codex', exit_code: 1 });
      expect(result.action).toBe('escalate');
    });

    it('recommends provider switch for Windows native process crashes', () => {
      const result = fallbackDiagnose({ error_output: '', provider: 'claude-cli', exit_code: 3221226505 });
      expect(result.action).toBe('switch_provider');
      expect(result.reason).toContain('0xC0000409');
      expect(result.suggested_provider).toBe('deepinfra');
    });
  });

  describe('fallbackReview', () => {
    it('approves when no validation failures', () => {
      const result = fallbackReview({ validation_failures: [], file_size_delta_pct: 5 });
      expect(result.decision).toBe('approve');
      expect(result.source).toBe('deterministic');
    });

    it('rejects when file size decreased >50%', () => {
      const result = fallbackReview({ validation_failures: [], file_size_delta_pct: -55 });
      expect(result.decision).toBe('reject');
      expect(result.reason).toMatch(/size decrease/i);
    });

    it('rejects when critical validation failures exist', () => {
      const result = fallbackReview({ validation_failures: [{ severity: 'critical', rule: 'stub_detection' }], file_size_delta_pct: 0 });
      expect(result.decision).toBe('reject');
    });

    it('flags warnings but approves', () => {
      const result = fallbackReview({ validation_failures: [{ severity: 'warning', rule: 'large_file' }], file_size_delta_pct: 10 });
      expect(result.decision).toBe('approve');
      expect(result.warnings).toHaveLength(1);
    });
  });
});
