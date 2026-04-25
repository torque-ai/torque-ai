'use strict';

const {
  collectConcreteWorkItems,
  collectPatterns,
  createScoutOutputIntake,
  isStarvationRecoveryScoutTask,
  promoteScoutSignalToIntake,
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

    expect(isStarvationRecoveryScoutTask({
      metadata: {
        mode: 'scout',
        scope: 'Factory starvation recovery scout. The project reached STARVED.',
      },
    })).toBe(true);
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

  it('promotes live patterns_ready scout signals into scout-sourced factory work items', () => {
    const factoryIntake = {
      findDuplicates: vi.fn().mockReturnValue([]),
      createWorkItem: vi.fn((item) => ({ id: 1, ...item })),
    };

    const result = promoteScoutSignalToIntake({
      id: 'task-live',
      metadata: {
        mode: 'scout',
        reason: 'factory_starvation_recovery',
        project_id: 'project-1',
      },
    }, 'patterns_ready', {
      patterns: [{
        id: 'live-seed',
        description: 'Seed intake from live scout signals',
        transformation: 'Promote patterns_ready before task completion',
        exemplar_files: ['server/factory/scout-output-intake.js'],
        file_count: 3,
      }],
    }, { factoryIntake });

    expect(result.created).toHaveLength(1);
    expect(factoryIntake.createWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      title: 'Scout pattern: Seed intake from live scout signals',
      origin: expect.objectContaining({
        type: 'starvation_recovery_scout_pattern',
        task_id: 'task-live',
        pattern_id: 'live-seed',
      }),
    }));
  });

  it('extracts concrete factory work items from scout_complete signals', () => {
    const workItems = collectConcreteWorkItems([
      '__SCOUT_COMPLETE__',
      JSON.stringify({
        concrete_factory_work_items: [{
          priority: 1,
          title: 'Align CI mypy command with the scoped pyproject typing contract',
          why: 'The CI workflow uses the broad mypy target.',
          allowed_files: ['.github/workflows/ci.yml'],
          verification: 'python -m mypy',
        }],
      }),
      '__SCOUT_COMPLETE_END__',
    ].join('\n'));

    expect(workItems).toEqual([expect.objectContaining({
      priority: 1,
      title: 'Align CI mypy command with the scoped pyproject typing contract',
      allowed_files: ['.github/workflows/ci.yml'],
    })]);
  });

  it('normalizes legacy string scout_complete work item references', () => {
    const workItems = collectConcreteWorkItems([
      '__SCOUT_COMPLETE__',
      JSON.stringify({
        concrete_factory_work_items: [
          'docs/superpowers/plans/auto-generated/765-add-ci-gates-for-ledger-invariants-and-security-contract-tests.md',
        ],
      }),
      '__SCOUT_COMPLETE_END__',
    ].join('\n'));

    expect(workItems).toEqual([expect.objectContaining({
      title: 'Add ci gates for ledger invariants and security contract tests',
      source: 'docs/superpowers/plans/auto-generated/765-add-ci-gates-for-ledger-invariants-and-security-contract-tests.md',
      sources: ['docs/superpowers/plans/auto-generated/765-add-ci-gates-for-ledger-invariants-and-security-contract-tests.md'],
    })]);
  });

  it('normalizes scout work item objects with id, reason, source_files, validation, and string priority', () => {
    const workItems = collectConcreteWorkItems([
      '__SCOUT_COMPLETE__',
      JSON.stringify({
        concrete_factory_work_items: [{
          id: 'dlphone-typed-lan-startup-failure-reasons',
          priority: 'high',
          source_files: [
            'docs/superpowers/plans/auto-generated/754-add-typed-lanstartupcoordinator-failure-reasons.md',
          ],
          reason: 'Plan docs are checked, but current code has no typed failure reason surface.',
          validation: ['dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter LanStartupCoordinator'],
        }],
      }),
      '__SCOUT_COMPLETE_END__',
    ].join('\n'));

    expect(workItems).toEqual([expect.objectContaining({
      title: 'Dlphone typed lan startup failure reasons',
      priority: 'high',
      why: 'Plan docs are checked, but current code has no typed failure reason surface.',
      allowed_files: [
        'docs/superpowers/plans/auto-generated/754-add-typed-lanstartupcoordinator-failure-reasons.md',
      ],
      verification: 'dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter LanStartupCoordinator',
    })]);
  });

  it('promotes concrete scout_complete work items and resolves legacy project metadata by path', () => {
    const factoryIntake = {
      findDuplicates: vi.fn().mockReturnValue([]),
      createWorkItem: vi.fn((item) => ({ id: 1, ...item })),
    };
    const intake = createScoutOutputIntake({
      factoryIntake,
      resolveProjectId: vi.fn().mockReturnValue('project-1'),
    });

    const result = intake.promoteTask({
      id: 'task-legacy',
      working_directory: 'C:\\repo',
      metadata: {
        mode: 'scout',
        scope: 'Factory starvation recovery scout. The project reached STARVED.',
      },
      output: [
        '__SCOUT_COMPLETE__',
        JSON.stringify({
          concrete_factory_work_items: [{
            priority: 1,
            title: 'Align CI mypy command with the scoped pyproject typing contract',
            why: 'The CI workflow uses the broad mypy target.',
            allowed_files: ['.github/workflows/ci.yml', 'tests/test_ci_parity.py'],
            verification: 'python -m mypy; pytest tests/test_ci_parity.py -q',
          }],
        }),
        '__SCOUT_COMPLETE_END__',
      ].join('\n'),
    });

    expect(result.created).toHaveLength(1);
    expect(result.work_items_seen).toBe(1);
    expect(factoryIntake.createWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      source: 'scout',
      title: 'Align CI mypy command with the scoped pyproject typing contract',
      priority: 'high',
      origin: expect.objectContaining({
        type: 'starvation_recovery_scout_work_item',
        task_id: 'task-legacy',
        allowed_files: ['.github/workflows/ci.yml', 'tests/test_ci_parity.py'],
        verification: 'python -m mypy; pytest tests/test_ci_parity.py -q',
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
