'use strict';

const path = require('path');

// Focused unit tests for server/execution/agentic-orphan-rollback.js — the
// helper that reverts an agentic task's git-tracked changes when the task is
// orphaned (process exit before close handler ran, restart casualty, etc).
// Used by orphan-cleanup, the close-handler exception path, and queue
// cancellation flows. The module had no direct unit tests — a regression
// in the metadata parser or the rollback short-circuits would leak
// agentic side-effects into a "supposed to be reverted" workspace.

// installMock pattern: replace agentic-git-safety so we don't depend on
// real git state. We intercept hydrateSnapshot + revertChangesSinceSnapshot
// to drive each branch deterministically.
function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const mockGitSafety = {
  hydrateSnapshot: vi.fn(),
  revertChangesSinceSnapshot: vi.fn(),
};
installMock(
  path.join(__dirname, '..', 'providers', 'agentic-git-safety.js'),
  mockGitSafety,
);

const {
  rollbackAgenticTaskChanges,
  appendRollbackReport,
} = require('../execution/agentic-orphan-rollback');

beforeEach(() => {
  mockGitSafety.hydrateSnapshot.mockReset();
  mockGitSafety.revertChangesSinceSnapshot.mockReset();
});

describe('appendRollbackReport', () => {
  it('returns the original message unchanged when rollbackResult has no report', () => {
    expect(appendRollbackReport('error happened', { reverted: [] })).toBe('error happened');
  });

  it('returns the original message unchanged when rollbackResult is null', () => {
    expect(appendRollbackReport('error happened', null)).toBe('error happened');
  });

  it('returns the original message unchanged when rollbackResult has empty-string report', () => {
    expect(appendRollbackReport('error', { report: '' })).toBe('error');
  });

  it('appends the report after a newline when both message and report are present', () => {
    expect(appendRollbackReport('error', { report: 'reverted 2 files' }))
      .toBe('error\nreverted 2 files');
  });

  it('returns just the report when message is empty', () => {
    expect(appendRollbackReport('', { report: 'reverted 1 file' }))
      .toBe('reverted 1 file');
  });

  it('returns just the report when message is null', () => {
    expect(appendRollbackReport(null, { report: 'reverted 1 file' }))
      .toBe('reverted 1 file');
  });
});

describe('rollbackAgenticTaskChanges', () => {
  describe('skip cases (attempted=false)', () => {
    it('skips when task has no working_directory and no snapshot working_directory', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue({ isGitRepo: true });
      const result = rollbackAgenticTaskChanges({ id: 't1', metadata: {} });
      expect(result).toEqual({ attempted: false, reverted: [], kept: [], report: '' });
      expect(mockGitSafety.revertChangesSinceSnapshot).not.toHaveBeenCalled();
    });

    it('skips when snapshot is not a git repo', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue({ isGitRepo: false });
      const result = rollbackAgenticTaskChanges({
        id: 't2',
        working_directory: '/tmp/x',
        metadata: { agentic_git_snapshot: { isGitRepo: false } },
      });
      expect(result.attempted).toBe(false);
      expect(mockGitSafety.revertChangesSinceSnapshot).not.toHaveBeenCalled();
    });

    it('skips when hydrateSnapshot returns null', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue(null);
      const result = rollbackAgenticTaskChanges({
        id: 't3',
        working_directory: '/tmp/x',
        metadata: { agentic_git_snapshot: {} },
      });
      expect(result.attempted).toBe(false);
    });

    it('falls back to snapshot working_directory when task has none', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue({ isGitRepo: true });
      mockGitSafety.revertChangesSinceSnapshot.mockReturnValue({
        reverted: ['a.js'],
        kept: [],
        report: 'reverted 1',
      });
      const result = rollbackAgenticTaskChanges({
        id: 't4',
        metadata: { agentic_git_snapshot: { working_directory: '/snap/dir', isGitRepo: true } },
      });
      expect(result.attempted).toBe(true);
      expect(mockGitSafety.revertChangesSinceSnapshot).toHaveBeenCalledWith('/snap/dir', { isGitRepo: true });
    });
  });

  describe('successful rollback', () => {
    it('returns the revertChangesSinceSnapshot result with attempted=true', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue({ isGitRepo: true });
      mockGitSafety.revertChangesSinceSnapshot.mockReturnValue({
        reverted: ['src/foo.js'],
        kept: ['untracked.tmp'],
        report: 'reverted 1, kept 1',
      });

      const result = rollbackAgenticTaskChanges({
        id: 't5',
        working_directory: '/proj',
        metadata: { agentic_git_snapshot: { isGitRepo: true } },
      });

      expect(result).toEqual({
        attempted: true,
        reverted: ['src/foo.js'],
        kept: ['untracked.tmp'],
        report: 'reverted 1, kept 1',
      });
    });

    it('logs the report via the supplied logger when present', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue({ isGitRepo: true });
      mockGitSafety.revertChangesSinceSnapshot.mockReturnValue({
        reverted: ['a'], kept: [], report: 'reverted 1',
      });
      const info = vi.fn();
      rollbackAgenticTaskChanges(
        { id: 'task-id-1', working_directory: '/proj', metadata: { agentic_git_snapshot: { isGitRepo: true } } },
        { logger: { info } },
      );
      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0][0]).toContain('task-id-1');
      expect(info.mock.calls[0][0]).toContain('reverted 1');
    });

    it('does not log when revertChangesSinceSnapshot returns no report', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue({ isGitRepo: true });
      mockGitSafety.revertChangesSinceSnapshot.mockReturnValue({
        reverted: [], kept: [], report: '',
      });
      const info = vi.fn();
      rollbackAgenticTaskChanges(
        { id: 't6', working_directory: '/proj', metadata: { agentic_git_snapshot: { isGitRepo: true } } },
        { logger: { info } },
      );
      expect(info).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('catches an exception from revertChangesSinceSnapshot and reports it', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue({ isGitRepo: true });
      mockGitSafety.revertChangesSinceSnapshot.mockImplementation(() => {
        throw new Error('git checkout failed');
      });

      const warn = vi.fn();
      const result = rollbackAgenticTaskChanges(
        { id: 't7', working_directory: '/proj', metadata: { agentic_git_snapshot: { isGitRepo: true } } },
        { logger: { warn } },
      );

      expect(result).toEqual({
        attempted: true,
        reverted: [],
        kept: [],
        report: 'Agentic orphan rollback failed: git checkout failed',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('t7');
      expect(warn.mock.calls[0][0]).toContain('git checkout failed');
    });

    it('includes "unknown" in warn log when task has no id', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue({ isGitRepo: true });
      mockGitSafety.revertChangesSinceSnapshot.mockImplementation(() => { throw new Error('boom'); });
      const warn = vi.fn();
      rollbackAgenticTaskChanges(
        { working_directory: '/proj', metadata: { agentic_git_snapshot: { isGitRepo: true } } },
        { logger: { warn } },
      );
      expect(warn.mock.calls[0][0]).toContain('unknown');
    });
  });

  describe('metadata parsing', () => {
    it('handles JSON-string metadata', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue({ isGitRepo: true });
      mockGitSafety.revertChangesSinceSnapshot.mockReturnValue({
        reverted: [], kept: [], report: '',
      });
      rollbackAgenticTaskChanges({
        id: 't8',
        working_directory: '/proj',
        metadata: JSON.stringify({ agentic_git_snapshot: { isGitRepo: true, branch: 'main' } }),
      });
      expect(mockGitSafety.hydrateSnapshot).toHaveBeenCalledWith({ isGitRepo: true, branch: 'main' });
    });

    it('handles malformed JSON metadata by treating as empty', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue(null);
      const result = rollbackAgenticTaskChanges({
        id: 't9',
        working_directory: '/proj',
        metadata: '{not valid json',
      });
      expect(result.attempted).toBe(false);
      expect(mockGitSafety.hydrateSnapshot).toHaveBeenCalledWith(undefined);
    });

    it('treats array metadata as empty', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue(null);
      const result = rollbackAgenticTaskChanges({
        id: 't10',
        working_directory: '/proj',
        metadata: [{ agentic_git_snapshot: { isGitRepo: true } }],
      });
      expect(result.attempted).toBe(false);
      expect(mockGitSafety.hydrateSnapshot).toHaveBeenCalledWith(undefined);
    });

    it('handles missing metadata gracefully', () => {
      mockGitSafety.hydrateSnapshot.mockReturnValue(null);
      const result = rollbackAgenticTaskChanges({ id: 't11', working_directory: '/proj' });
      expect(result.attempted).toBe(false);
    });
  });
});
