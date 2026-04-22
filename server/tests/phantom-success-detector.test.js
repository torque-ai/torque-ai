'use strict';

const {
  detectPhantomSuccess,
  parseFactoryContext,
  hasMeaningfulFileProduct,
} = require('../validation/phantom-success-detector');

describe('detectPhantomSuccess', () => {
  it('flags Codex exit 0 with empty output, overload stderr, and no file product', () => {
    const result = detectPhantomSuccess({
      exitCode: 0,
      provider: 'codex',
      stdout: '(no output)',
      stderr: "ERROR: Reconnecting... 1/5\nERROR: We're currently experiencing high demand",
      filesModified: [],
    });

    expect(result.isPhantom).toBe(true);
    expect(result.reason).toMatch(/empty output/i);
    expect(result.signals).toContain('overload_stderr');
  });

  it('does not flag a real Codex completion that touched product files', () => {
    const result = detectPhantomSuccess({
      exitCode: 0,
      provider: 'codex',
      stdout: '(no output)',
      stderr: "ERROR: Reconnecting... 1/5\nERROR: We're currently experiencing high demand",
      filesModified: ['server/validation/post-task.js'],
    });

    expect(result.isPhantom).toBe(false);
  });

  it('treats run transcripts and plan checkbox churn as non-product files', () => {
    expect(hasMeaningfulFileProduct({
      filesModified: [
        'runs/abc/events.jsonl',
        'runs/abc/manifest.json',
        'docs/superpowers/plans/2026-04-21-codex-phantom-success-detector.md',
      ],
    })).toBe(false);
  });

  it('does not flag non-Codex providers or non-overload clean no-ops', () => {
    expect(detectPhantomSuccess({
      exitCode: 0,
      provider: 'ollama',
      stdout: '(no output)',
      stderr: 'ERROR: Reconnecting...',
      filesModified: [],
    }).isPhantom).toBe(false);

    expect(detectPhantomSuccess({
      exitCode: 0,
      provider: 'codex',
      stdout: 'No changes required.',
      stderr: '',
      filesModified: [],
    }).isPhantom).toBe(false);
  });

  it('extracts factory project context from batch tags', () => {
    const context = parseFactoryContext({
      tags: [
        'factory:batch_id=factory-a3df749a-7869-486f-9896-64d38d25d39b-663',
        'factory:work_item_id=663',
      ],
    });

    expect(context).toEqual({
      project_id: 'a3df749a-7869-486f-9896-64d38d25d39b',
      batch_id: 'factory-a3df749a-7869-486f-9896-64d38d25d39b-663',
      work_item_id: '663',
    });
  });
});
