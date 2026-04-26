'use strict';

const {
  detectPhantomSuccess,
  detectCodexBannerOnly,
  runCodexBannerOnlyDetection,
  isBannerOnlyOutput,
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

describe('detectCodexBannerOnly', () => {
  // Real banner shape observed live 2026-04-25/26 on 3 failed codex tasks.
  const REAL_BANNER = `OpenAI Codex v0.125.0 (research preview)
--------
workdir: C:\\Users\\test-user\\Projects\\TestProject
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, C:\\Users\\test-user\\.codex\\memories]
reasoning effort: xhigh
reasoning summaries: none
session id: 019dc58e-058e-7884-9b21-...`;

  it('flags failed codex task with banner-only stderr', () => {
    const result = detectCodexBannerOnly({
      provider: 'codex',
      status: 'failed',
      output: '',
      errorOutput: REAL_BANNER,
      filesModified: [],
    });

    expect(result.isBannerOnly).toBe(true);
    expect(result.reason).toMatch(/killed before producing/i);
  });

  it('flags cancelled codex task with banner-only stderr', () => {
    const result = detectCodexBannerOnly({
      provider: 'codex-spark',
      status: 'cancelled',
      output: null,
      errorOutput: REAL_BANNER,
      filesModified: [],
    });

    expect(result.isBannerOnly).toBe(true);
  });

  it('does NOT flag a successful task even if stderr matches the banner', () => {
    const result = detectCodexBannerOnly({
      provider: 'codex',
      status: 'completed',
      output: 'Wrote tools/foo.py',
      errorOutput: REAL_BANNER,
      filesModified: ['tools/foo.py'],
    });

    expect(result.isBannerOnly).toBe(false);
  });

  it('does NOT flag when stderr has real codex output beyond the banner', () => {
    const stderrWithRealOutput = REAL_BANNER + `\nthinking: I need to read the source file...\nrunning: read_file(...)`;
    const result = detectCodexBannerOnly({
      provider: 'codex',
      status: 'failed',
      output: '',
      errorOutput: stderrWithRealOutput,
      filesModified: [],
    });

    expect(result.isBannerOnly).toBe(false);
  });

  it('does NOT flag non-codex providers', () => {
    const result = detectCodexBannerOnly({
      provider: 'ollama',
      status: 'failed',
      output: '',
      errorOutput: REAL_BANNER,
      filesModified: [],
    });

    expect(result.isBannerOnly).toBe(false);
  });

  it('does NOT flag when files were actually modified (output product exists)', () => {
    const result = detectCodexBannerOnly({
      provider: 'codex',
      status: 'failed',
      output: '',
      errorOutput: REAL_BANNER,
      filesModified: ['server/foo.js'],
    });

    expect(result.isBannerOnly).toBe(false);
  });

  it('isBannerOnlyOutput returns false on empty / non-string input', () => {
    expect(isBannerOnlyOutput('')).toBe(false);
    expect(isBannerOnlyOutput(null)).toBe(false);
    expect(isBannerOnlyOutput(undefined)).toBe(false);
    expect(isBannerOnlyOutput(42)).toBe(false);
  });
});

describe('runCodexBannerOnlyDetection', () => {
  const REAL_BANNER = `OpenAI Codex v0.125.0 (research preview)
--------
workdir: C:\\test
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write [workdir]
reasoning effort: high
reasoning summaries: none
session id: 019dc58e`;

  it('rewrites errorOutput to a clearer message + preserves the original banner', () => {
    const ctx = {
      task: { provider: 'codex' },
      status: 'failed',
      output: '',
      errorOutput: REAL_BANNER,
      filesModified: [],
    };

    const detection = runCodexBannerOnlyDetection(ctx);

    expect(detection.isBannerOnly).toBe(true);
    expect(ctx.errorOutput).toMatch(/killed before producing/i);
    expect(ctx.errorOutput).toContain('--- Original Codex stderr (banner only) ---');
    expect(ctx.errorOutput).toContain('OpenAI Codex v0.125.0');
    expect(ctx.codexBannerOnly).toBeDefined();
  });

  it('does not modify ctx for completed tasks', () => {
    const ctx = {
      task: { provider: 'codex' },
      status: 'completed',
      output: 'real work output',
      errorOutput: REAL_BANNER,
    };
    const before = ctx.errorOutput;
    runCodexBannerOnlyDetection(ctx);
    expect(ctx.errorOutput).toBe(before);
  });

  it('does not modify ctx for non-codex providers', () => {
    const ctx = {
      task: { provider: 'ollama' },
      status: 'failed',
      output: '',
      errorOutput: REAL_BANNER,
    };
    const before = ctx.errorOutput;
    runCodexBannerOnlyDetection(ctx);
    expect(ctx.errorOutput).toBe(before);
  });
});
