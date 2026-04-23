'use strict';

const {
  collectPatterns,
  createScoutOutputIntake,
  isStarvationRecoveryScoutTask,
} = require('../factory/scout-output-intake');

describe('scout output intake', () => {
  it('recognizes only starvation recovery scout tasks', () => {
    expect(isStarvationRecoveryScoutTask({
      metadata: {
        mode: 'scout',
        reason: 'factory_starvation_recovery',
        project_id: 'project-1',
      },
    })).toBe(true);

    expect(isStarvationRecoveryScoutTask({
      metadata: { mode: 'scout', project_id: 'project-1' },
    })).toBe(false);
  });

  it('extracts patterns_ready signals from scout output', () => {
    const patterns = collectPatterns([
      '__PATTERNS_READY__',
      JSON.stringify({
        patterns: [{
          id: 'worktree-cleanup',
          description: 'Fix stale worktree cleanup',
          transformation: 'Harden deletion fallback',
          exemplar_files: ['server/factory/worktree-reconcile.js'],
          file_count: 2,
        }],
        shared_dependencies: [{ file: 'server/factory/worktree-reconcile.js' }],
      }),
      '__PATTERNS_READY_END__',
    ].join('\n'));

    expect(patterns).toEqual([expect.objectContaining({
      id: 'worktree-cleanup',
      description: 'Fix stale worktree cleanup',
      file_count: 2,
      shared_dependencies: [{ file: 'server/factory/worktree-reconcile.js' }],
    })]);
  });

  it('promotes starvation scout patterns into scout-sourced factory work items', () => {
    const createdItems = [];
    const factoryIntake = {
      findDuplicates: vi.fn().mockReturnValue([]),
      createWorkItem: vi.fn((item) => {
        const created = { id: createdItems.length + 1, ...item };
        createdItems.push(created);
        return created;
      }),
    };
    const intake = createScoutOutputIntake({ factoryIntake });

    const result = intake.promoteTask({
      id: 'task-1',
      status: 'completed',
      metadata: {
        mode: 'scout',
        reason: 'factory_starvation_recovery',
        project_id: 'project-1',
      },
      output: [
        '__PATTERNS_READY__',
        JSON.stringify({
          patterns: [{
            id: 'worktree-cleanup',
            description: 'Fix stale worktree cleanup',
            transformation: 'Harden deletion fallback',
            exemplar_files: ['server/factory/worktree-reconcile.js'],
            file_count: 12,
          }],
        }),
        '__PATTERNS_READY_END__',
      ].join('\n'),
    });

    expect(result.created).toHaveLength(1);
    expect(factoryIntake.createWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      source: 'scout',
      title: 'Scout pattern: Fix stale worktree cleanup',
      priority: 'medium',
      requestor: 'starvation-recovery-scout',
      origin: expect.objectContaining({
        type: 'starvation_recovery_scout_pattern',
        task_id: 'task-1',
        pattern_id: 'worktree-cleanup',
      }),
    }));
  });

  it('skips duplicate open items for repeated scout patterns', () => {
    const factoryIntake = {
      findDuplicates: vi.fn().mockReturnValue([{ item: { id: 7 } }]),
      createWorkItem: vi.fn(),
    };
    const intake = createScoutOutputIntake({ factoryIntake });

    const result = intake.promoteTask({
      id: 'task-1',
      metadata: {
        mode: 'scout',
        reason: 'factory_starvation_recovery',
        project_id: 'project-1',
      },
      output: [
        '__PATTERNS_READY__',
        '{"patterns":[{"id":"p1","description":"Fix stale worktree cleanup"}]}',
        '__PATTERNS_READY_END__',
      ].join('\n'),
    });

    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual([expect.objectContaining({
      reason: 'duplicate_open_item',
    })]);
    expect(factoryIntake.createWorkItem).not.toHaveBeenCalled();
  });
});
