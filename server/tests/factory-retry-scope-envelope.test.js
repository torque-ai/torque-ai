import { describe, expect, it, vi } from 'vitest';

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));

const loopController = require('../factory/loop-controller');

const {
  extractScopeEnvelopeFiles,
  computeScopeEnvelope,
  isOutOfScope,
  getVerifyRetryDiffFiles,
  enforceVerifyRetryScopeEnvelope,
} = loopController.__testing__;

describe('verify retry scope envelope — pure helpers', () => {
  it('extractScopeEnvelopeFiles pulls file paths from plan-style text', () => {
    const text = [
      'Touches server/factory/loop-controller.js and',
      'tests/loop-controller.test.js. Also see docs/factory.md.',
    ].join('\n');
    const files = extractScopeEnvelopeFiles(text);
    expect(files).toEqual(expect.arrayContaining([
      'server/factory/loop-controller.js',
      'tests/loop-controller.test.js',
      'docs/factory.md',
    ]));
  });

  it('extractScopeEnvelopeFiles includes WPF and .NET project paths from SpudgetBooks-style plans', () => {
    const text = [
      'Edit `src/SpudgetBooks.App/Navigation/Shell/SidebarTreeControl.xaml`,',
      '`src/SpudgetBooks.App/Navigation/Shell/BreadcrumbBar.xaml`, and',
      '`src/SpudgetBooks.App/MainWindow.xaml`.',
      'Validate with `dotnet test tests/SpudgetBooks.App.Tests/SpudgetBooks.App.Tests.csproj -c Release`.',
      'Use `pwsh scripts/e2e.ps1 -Configuration Release` for the visual smoke.',
    ].join('\n');

    const files = extractScopeEnvelopeFiles(text);
    expect(files).toEqual(expect.arrayContaining([
      'src/SpudgetBooks.App/Navigation/Shell/SidebarTreeControl.xaml',
      'src/SpudgetBooks.App/Navigation/Shell/BreadcrumbBar.xaml',
      'src/SpudgetBooks.App/MainWindow.xaml',
      'tests/SpudgetBooks.App.Tests/SpudgetBooks.App.Tests.csproj',
      'scripts/e2e.ps1',
    ]));
  });

  it('extractScopeEnvelopeFiles returns empty array on empty input', () => {
    expect(extractScopeEnvelopeFiles('')).toEqual([]);
    expect(extractScopeEnvelopeFiles(null)).toEqual([]);
    expect(extractScopeEnvelopeFiles(undefined)).toEqual([]);
  });

  it('computeScopeEnvelope unions plan and verify-output files', () => {
    const envelope = computeScopeEnvelope(
      'Edit server/a.js and tests/a.test.js',
      'FAIL: tests/b.test.js line 12\n  at server/b.js:45',
    );
    expect(envelope).toBeInstanceOf(Set);
    expect(envelope.has('server/a.js')).toBe(true);
    expect(envelope.has('tests/a.test.js')).toBe(true);
    expect(envelope.has('tests/b.test.js')).toBe(true);
    expect(envelope.has('server/b.js')).toBe(true);
  });

  it('isOutOfScope returns [] when every diff file is in the envelope', () => {
    const envelope = new Set(['server/a.js', 'tests/a.test.js']);
    expect(isOutOfScope(['server/a.js', 'tests/a.test.js'], envelope)).toEqual([]);
  });

  it('isOutOfScope returns [] when diff files match envelope suffixes (subpath match)', () => {
    const envelope = new Set(['server/a.js']);
    expect(isOutOfScope(['server/a.js'], envelope)).toEqual([]);
  });

  it('isOutOfScope surfaces files not covered by the envelope', () => {
    const envelope = new Set(['server/a.js', 'tests/a.test.js']);
    const off = isOutOfScope(
      ['server/a.js', 'server/unrelated/huge-refactor.js', 'docs/notes.md'],
      envelope,
    );
    expect(off).toEqual(expect.arrayContaining([
      'server/unrelated/huge-refactor.js',
      'docs/notes.md',
    ]));
    expect(off).not.toContain('server/a.js');
  });

  it('treats plan-listed WPF XAML shell edits as in-scope during verify retries', () => {
    const envelope = computeScopeEnvelope([
      'Edit `src/SpudgetBooks.App/Navigation/Shell/SidebarTreeControl.xaml`,',
      '`src/SpudgetBooks.App/Navigation/Shell/ActionTrayControl.xaml`,',
      '`src/SpudgetBooks.App/Navigation/Shell/BreadcrumbBar.xaml`,',
      '`src/SpudgetBooks.App/Navigation/Shell/StatusBarControl.xaml`,',
      'and `src/SpudgetBooks.App/MainWindow.xaml`.',
    ].join('\n'), '');

    const off = isOutOfScope([
      'src/SpudgetBooks.App/MainWindow.xaml',
      'src/SpudgetBooks.App/Navigation/Shell/ActionTrayControl.xaml',
      'src/SpudgetBooks.App/Navigation/Shell/BreadcrumbBar.xaml',
      'src/SpudgetBooks.App/Navigation/Shell/SidebarTreeControl.xaml',
      'src/SpudgetBooks.App/Navigation/Shell/StatusBarControl.xaml',
    ], envelope);

    expect(off).toEqual([]);
  });
});

describe('enforceVerifyRetryScopeEnvelope — envelope pass path', () => {
  it('returns ok:true and does NOT log a decision or reject the work item when the retry diff stays in envelope', async () => {
    const planText = 'Touches server/factory/loop-controller.js and tests/loop-controller.test.js.';
    const verifyOutput = 'FAIL tests/loop-controller.test.js';

    const getDiffFiles = vi.fn(async () => ['server/factory/loop-controller.js']);
    const logDecisionFn = vi.fn();
    const rejectWorkItemUnactionableFn = vi.fn();

    const readFileShim = {
      readFileSync: () => planText,
    };
    const origRead = require('fs').readFileSync;
    require('fs').readFileSync = readFileShim.readFileSync;

    try {
      const result = await enforceVerifyRetryScopeEnvelope({
        project_id: 'proj-1',
        batch_id: 'batch-1',
        workItemId: 42,
        planPath: '/virtual/plan.md',
        verifyOutput,
        worktreePath: '/virtual/worktree',
        attempt: 1,
        branch: 'feat/test',
        getDiffFiles,
        logDecisionFn,
        rejectWorkItemUnactionableFn,
      });

      expect(result.ok).toBe(true);
      expect(result.diffFiles).toEqual(['server/factory/loop-controller.js']);
      expect(result.scopeEnvelope).toBeInstanceOf(Set);
      expect(result.scopeEnvelope.has('server/factory/loop-controller.js')).toBe(true);

      expect(getDiffFiles).toHaveBeenCalledWith('/virtual/worktree');
      expect(logDecisionFn).not.toHaveBeenCalled();
      expect(rejectWorkItemUnactionableFn).not.toHaveBeenCalled();
    } finally {
      require('fs').readFileSync = origRead;
    }
  });
});

describe('enforceVerifyRetryScopeEnvelope — envelope fail path', () => {
  it('returns ok:false with reason retry_off_scope, logs decision, and rejects work item when diff is off envelope', async () => {
    const planText = 'Edit server/factory/retry.js and tests/retry.test.js.';
    const verifyOutput = 'FAIL tests/retry.test.js line 7';

    const getDiffFiles = vi.fn(async () => [
      'server/factory/retry.js',
      'server/unrelated/broad-refactor.js',
      'docs/manifesto.md',
    ]);
    const logDecisionFn = vi.fn();
    const rejectWorkItemUnactionableFn = vi.fn();

    const origRead = require('fs').readFileSync;
    require('fs').readFileSync = () => planText;

    try {
      const result = await enforceVerifyRetryScopeEnvelope({
        project_id: 'proj-2',
        batch_id: 'batch-2',
        workItemId: 99,
        planPath: '/virtual/plan-off.md',
        verifyOutput,
        worktreePath: '/virtual/wt-off',
        attempt: 2,
        branch: 'feat/off',
        getDiffFiles,
        logDecisionFn,
        rejectWorkItemUnactionableFn,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('retry_off_scope');
      expect(result.offScopeFiles).toEqual(expect.arrayContaining([
        'server/unrelated/broad-refactor.js',
        'docs/manifesto.md',
      ]));
      expect(result.offScopeFiles).not.toContain('server/factory/retry.js');

      expect(logDecisionFn).toHaveBeenCalledTimes(1);
      const decisionArg = logDecisionFn.mock.calls[0][0];
      expect(decisionArg).toMatchObject({
        project_id: 'proj-2',
        batch_id: 'batch-2',
        action: 'retry_off_scope',
      });
      expect(decisionArg.outcome.off_scope_files).toEqual(expect.arrayContaining([
        'server/unrelated/broad-refactor.js',
      ]));

      expect(rejectWorkItemUnactionableFn).toHaveBeenCalledTimes(1);
      expect(rejectWorkItemUnactionableFn).toHaveBeenCalledWith(99, 'retry_off_scope');
    } finally {
      require('fs').readFileSync = origRead;
    }
  });

  it('survives a rejectWorkItemUnactionableFn that throws (best-effort rejection)', async () => {
    const planText = 'Edit a.js only.';
    const getDiffFiles = vi.fn(async () => ['b.js']);
    const logDecisionFn = vi.fn();
    const rejectWorkItemUnactionableFn = vi.fn(() => {
      throw new Error('db write failed');
    });

    const origRead = require('fs').readFileSync;
    require('fs').readFileSync = () => planText;

    try {
      const result = await enforceVerifyRetryScopeEnvelope({
        project_id: 'proj-3',
        batch_id: 'batch-3',
        workItemId: 7,
        planPath: '/virtual/plan.md',
        verifyOutput: '',
        worktreePath: '/virtual/wt',
        attempt: 1,
        branch: 'feat/throwy',
        getDiffFiles,
        logDecisionFn,
        rejectWorkItemUnactionableFn,
        scopedLogger: { debug: () => {}, warn: () => {} },
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('retry_off_scope');
      expect(rejectWorkItemUnactionableFn).toHaveBeenCalledTimes(1);
    } finally {
      require('fs').readFileSync = origRead;
    }
  });

  it('reads an empty plan envelope when planPath is null and still evaluates against verify-output files only', async () => {
    const getDiffFiles = vi.fn(async () => ['server/unseen.js']);
    const logDecisionFn = vi.fn();
    const rejectWorkItemUnactionableFn = vi.fn();

    const result = await enforceVerifyRetryScopeEnvelope({
      project_id: 'proj-4',
      batch_id: 'batch-4',
      workItemId: 1,
      planPath: null,
      verifyOutput: '',
      worktreePath: '/virtual/wt',
      attempt: 1,
      branch: 'feat/no-plan',
      getDiffFiles,
      logDecisionFn,
      rejectWorkItemUnactionableFn,
      scopedLogger: { debug: () => {}, warn: () => {} },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('retry_off_scope');
    expect(result.offScopeFiles).toContain('server/unseen.js');
  });
});

describe('loop-controller exports the retry-scope-envelope helpers via __testing__', () => {
  it('exposes all five helpers as callable functions', () => {
    expect(typeof extractScopeEnvelopeFiles).toBe('function');
    expect(typeof computeScopeEnvelope).toBe('function');
    expect(typeof isOutOfScope).toBe('function');
    expect(typeof getVerifyRetryDiffFiles).toBe('function');
    expect(typeof enforceVerifyRetryScopeEnvelope).toBe('function');
  });
});
