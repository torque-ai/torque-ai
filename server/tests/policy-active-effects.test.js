'use strict';

const { applyRewriteDescription, applyCompressOutput, applyActiveEffects } = require('../policy-engine/active-effects');

describe('applyRewriteDescription', () => {
  it('prepends text to description', () => {
    const result = applyRewriteDescription('original task', { prepend: 'IMPORTANT: Use strict TypeScript.' });
    expect(result).toBe('IMPORTANT: Use strict TypeScript.\noriginal task');
  });

  it('appends text to description', () => {
    const result = applyRewriteDescription('original task', { append: 'Run tsc --noEmit before marking complete.' });
    expect(result).toBe('original task\nRun tsc --noEmit before marking complete.');
  });

  it('prepends and appends simultaneously', () => {
    const result = applyRewriteDescription('do the thing', { prepend: 'PREFIX', append: 'SUFFIX' });
    expect(result).toBe('PREFIX\ndo the thing\nSUFFIX');
  });

  it('returns original when effect is null', () => {
    expect(applyRewriteDescription('hello', null)).toBe('hello');
  });
});

describe('applyCompressOutput', () => {
  function makeLines(n) {
    return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
  }

  it('truncates to max_lines keeping last lines by default', () => {
    const output = makeLines(1000);
    const result = applyCompressOutput(output, { max_lines: 100 });
    const lines = result.split('\n');
    expect(lines.length).toBe(101); // 100 kept + 1 header
    expect(lines[0]).toBe('[Output truncated]');
    expect(lines[lines.length - 1]).toBe('line 1000');
  });

  it('truncates keeping first lines', () => {
    const output = makeLines(1000);
    const result = applyCompressOutput(output, { max_lines: 100, keep: 'first' });
    const lines = result.split('\n');
    expect(lines.length).toBe(101); // 100 kept + 1 header
    expect(lines[0]).toBe('[Output truncated]');
    expect(lines[1]).toBe('line 1');
  });

  it('adds custom summary header', () => {
    const output = makeLines(200);
    const result = applyCompressOutput(output, { max_lines: 50, summary_header: '--- TRUNCATED ---' });
    expect(result.startsWith('--- TRUNCATED ---')).toBe(true);
  });

  it('no-ops when under max_lines', () => {
    const output = makeLines(50);
    const result = applyCompressOutput(output, { max_lines: 500 });
    expect(result).toBe(output);
  });

  it('handles empty output', () => {
    expect(applyCompressOutput('', { max_lines: 100 })).toBe('');
    expect(applyCompressOutput(null, { max_lines: 100 })).toBe('');
  });
});

describe('applyActiveEffects', () => {
  it('applies rewrite_description from matching evaluation', () => {
    const policyResult = {
      evaluations: [{
        outcome: 'pass',
        active_effects: [{ type: 'rewrite_description', prepend: 'STRICT MODE' }],
      }],
    };
    const taskData = { id: 'test-1', task_description: 'fix bug' };
    const { applied, taskData: modified } = applyActiveEffects(policyResult, taskData);
    expect(applied).toContain('rewrite_description');
    expect(modified.task_description).toBe('STRICT MODE\nfix bug');
  });

  it('skips effects from skipped evaluations', () => {
    const policyResult = {
      evaluations: [{
        outcome: 'skipped',
        active_effects: [{ type: 'rewrite_description', prepend: 'SHOULD NOT APPEAR' }],
      }],
    };
    const taskData = { id: 'test-2', task_description: 'original' };
    const { applied } = applyActiveEffects(policyResult, taskData);
    expect(applied).toHaveLength(0);
    expect(taskData.task_description).toBe('original');
  });

  it('applies compress_output from matching evaluation', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `out ${i}`).join('\n');
    const policyResult = {
      evaluations: [{
        outcome: 'fail',
        active_effects: [{ type: 'compress_output', max_lines: 50 }],
      }],
    };
    const taskData = { id: 'test-3', output: lines };
    const { applied } = applyActiveEffects(policyResult, taskData);
    expect(applied).toContain('compress_output');
    expect(taskData.output.split('\n').length).toBe(51); // 50 + header
  });

  it('handles null policyResult gracefully', () => {
    const { applied } = applyActiveEffects(null, { id: 'x' });
    expect(applied).toHaveLength(0);
  });

  it('trigger_tool is applied from matching evaluation', () => {
    const policyResult = {
      evaluations: [{
        outcome: 'pass',
        active_effects: [{
          type: 'trigger_tool',
          tool_name: 'validate_event_consistency',
          tool_args: { working_directory: '{{working_directory}}' },
        }],
      }],
    };
    const taskData = { id: 'test-trigger', working_directory: '/proj' };
    const { applied } = applyActiveEffects(policyResult, taskData);
    // trigger_tool is applied regardless of whether tools.js is available in test env
    expect(applied).toContain('trigger_tool');
  });
});
