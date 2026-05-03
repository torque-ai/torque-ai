'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  collectConcreteWorkItems,
  collectPatterns,
  createScoutOutputIntake,
  filterExistingFiles,
  isStarvationRecoveryScoutTask,
  promoteScoutSignalToIntake,
  resolveScoutWorkingDir,
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

    expect(isStarvationRecoveryScoutTask({
      metadata: JSON.stringify({
        mode: 'scout',
        reason: 'factory_starvation_recovery',
        project_id: 'project-1',
      }),
    })).toBe(true);

    expect(() => isStarvationRecoveryScoutTask({ metadata: '{not valid json' })).not.toThrow();
    expect(isStarvationRecoveryScoutTask({ metadata: '{not valid json' })).toBe(false);

    const arrayMetadata = [];
    arrayMetadata.mode = 'scout';
    arrayMetadata.reason = 'factory_starvation_recovery';
    expect(() => isStarvationRecoveryScoutTask({ metadata: arrayMetadata })).not.toThrow();
    expect(isStarvationRecoveryScoutTask({ metadata: arrayMetadata })).toBe(false);
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
      metadata: JSON.stringify({
        mode: 'scout',
        reason: 'factory_starvation_recovery',
        project_id: 'project-1',
      }),
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
      // No working_directory — resolveProjectId is mocked, so this test
      // doesn't exercise path resolution. Omitting working_directory also
      // makes the existence-guard fail-open (unchecked), preserving the
      // original test intent of "concrete_factory_work_items get promoted."
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

  it('skips recently terminal scout duplicates from starvation recovery output', () => {
    const factoryIntake = {
      findDuplicates: vi.fn().mockReturnValue([]),
      findRecentDuplicateWorkItems: vi.fn().mockReturnValue([{ id: 9, status: 'rejected' }]),
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
        '__SCOUT_COMPLETE__',
        JSON.stringify({
          concrete_factory_work_items: [{
            title: 'DLPhone startup failure reasons',
            reason: 'Repeated scout finding.',
          }],
        }),
        '__SCOUT_COMPLETE_END__',
      ].join('\n'),
    });

    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual([expect.objectContaining({
      reason: 'duplicate_recent_terminal_item',
      work_item_id: 9,
    })]);
    expect(factoryIntake.findRecentDuplicateWorkItems).toHaveBeenCalledWith(
      'project-1',
      'DLPhone startup failure reasons',
      expect.objectContaining({
        source: 'scout',
        statuses: expect.arrayContaining(['rejected', 'shipped_stale']),
      }),
    );
    expect(factoryIntake.createWorkItem).not.toHaveBeenCalled();
  });
});

describe('scout output intake — exemplar_files existence guard', () => {
  // The guard catches small-LLM scouts (qwen3-coder:30b on DLPhone, scout
  // task e50cfe25 on 2026-04-29) that hallucinate plausible-looking file
  // paths instead of reading the real codebase. Without it, a hallucinated
  // pattern reaches the architect, gets re-planned 5 times until the
  // deterministic plan-quality cap kicks in, then moves to the next bad
  // pattern — burning a full STARVED recovery cycle on garbage.

  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-existence-guard-'));
    fs.mkdirSync(path.join(tmpRoot, 'server', 'factory'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'server', 'factory', 'real-file.js'), '// real');
    fs.writeFileSync(path.join(tmpRoot, 'server', 'factory', 'another-real.js'), '// real');
  });

  afterEach(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  describe('filterExistingFiles', () => {
    it('keeps files that exist relative to baseDir', () => {
      const r = filterExistingFiles(['server/factory/real-file.js'], tmpRoot);
      expect(r.kept).toEqual(['server/factory/real-file.js']);
      expect(r.dropped).toEqual([]);
      expect(r.unchecked).toBe(false);
    });

    it('drops files that do not exist', () => {
      const r = filterExistingFiles(['server/factory/imaginary.js'], tmpRoot);
      expect(r.kept).toEqual([]);
      expect(r.dropped).toEqual(['server/factory/imaginary.js']);
      expect(r.unchecked).toBe(false);
    });

    it('partitions a mixed list', () => {
      const r = filterExistingFiles([
        'server/factory/real-file.js',
        'docs/superpowers/plans/factory-starvation-recovery.md',
        'server/factory/another-real.js',
        'docs/superpowers/plans/queue-monitoring.md',
      ], tmpRoot);
      expect(r.kept).toEqual([
        'server/factory/real-file.js',
        'server/factory/another-real.js',
      ]);
      expect(r.dropped).toEqual([
        'docs/superpowers/plans/factory-starvation-recovery.md',
        'docs/superpowers/plans/queue-monitoring.md',
      ]);
      expect(r.unchecked).toBe(false);
    });

    it('handles backslash-style paths from Windows scouts', () => {
      const r = filterExistingFiles(['server\\factory\\real-file.js'], tmpRoot);
      expect(r.kept).toEqual(['server\\factory\\real-file.js']);
      expect(r.dropped).toEqual([]);
    });

    it('returns unchecked=true when baseDir is missing (fail-open)', () => {
      const r = filterExistingFiles(['anything.js'], null);
      expect(r.unchecked).toBe(true);
      expect(r.kept).toEqual(['anything.js']);
      expect(r.dropped).toEqual([]);
    });

    it('returns empty when input is empty or non-array', () => {
      expect(filterExistingFiles([], tmpRoot)).toEqual({ kept: [], dropped: [], unchecked: false });
      expect(filterExistingFiles(null, tmpRoot)).toEqual({ kept: [], dropped: [], unchecked: false });
      expect(filterExistingFiles('not-an-array', tmpRoot)).toEqual({ kept: [], dropped: [], unchecked: false });
    });

    it('skips non-string and empty entries', () => {
      const r = filterExistingFiles(['server/factory/real-file.js', '', null, 42, '   '], tmpRoot);
      expect(r.kept).toEqual(['server/factory/real-file.js']);
      expect(r.dropped).toEqual([]);
    });
  });

  describe('resolveScoutWorkingDir', () => {
    it('prefers task.working_directory', () => {
      expect(resolveScoutWorkingDir(
        { working_directory: 'C:/proj' },
        { working_directory: 'C:/wrong', project_path: 'C:/wrong2' },
      )).toBe('C:/proj');
    });
    it('falls back to metadata.working_directory then metadata.project_path', () => {
      expect(resolveScoutWorkingDir({}, { working_directory: 'C:/meta' })).toBe('C:/meta');
      expect(resolveScoutWorkingDir({}, { project_path: 'C:/proj' })).toBe('C:/proj');
    });
    it('returns null when no candidate is available', () => {
      expect(resolveScoutWorkingDir({}, {})).toBe(null);
      expect(resolveScoutWorkingDir(null, null)).toBe(null);
      expect(resolveScoutWorkingDir({ working_directory: '   ' }, {})).toBe(null);
    });
  });

  describe('promoteTask integration', () => {
    function makeFactoryIntake() {
      return {
        findDuplicates: vi.fn().mockReturnValue([]),
        findRecentDuplicateWorkItems: vi.fn().mockReturnValue([]),
        createWorkItem: vi.fn((item) => ({ id: Math.floor(Math.random() * 1000), ...item })),
      };
    }

    it('drops a pattern whose exemplar_files are entirely hallucinated', () => {
      const factoryIntake = makeFactoryIntake();
      const logger = { warn: vi.fn(), info: vi.fn() };
      const intake = createScoutOutputIntake({ factoryIntake, logger });

      const result = intake.promoteTask({
        id: 'task-halluc',
        status: 'completed',
        working_directory: tmpRoot,
        metadata: { mode: 'scout', reason: 'factory_starvation_recovery', project_id: 'project-1' },
        output: [
          '__PATTERNS_READY__',
          JSON.stringify({
            patterns: [{
              id: 'queue-monitoring',
              description: 'Add monitoring for queue starvation',
              transformation: 'Add queue monitoring logic',
              exemplar_files: ['docs/superpowers/plans/queue-monitoring.md'],
              file_count: 15,
            }],
          }),
          '__PATTERNS_READY_END__',
        ].join('\n'),
      });

      expect(factoryIntake.createWorkItem).not.toHaveBeenCalled();
      expect(result.created).toHaveLength(0);
      expect(result.skipped).toEqual([expect.objectContaining({
        reason: 'exemplar_files_hallucinated',
        pattern_id: 'queue-monitoring',
        dropped_files: ['docs/superpowers/plans/queue-monitoring.md'],
      })]);
      expect(logger.warn).toHaveBeenCalledWith(
        'Scout pattern dropped: all exemplar_files non-existent',
        expect.objectContaining({
          project_id: 'project-1',
          pattern_id: 'queue-monitoring',
          scout_task_id: 'task-halluc',
        }),
      );
    });

    it('filters partially-hallucinated exemplar_files and creates the work item with the real subset', () => {
      const factoryIntake = makeFactoryIntake();
      const logger = { warn: vi.fn(), info: vi.fn() };
      const intake = createScoutOutputIntake({ factoryIntake, logger });

      const result = intake.promoteTask({
        id: 'task-mixed',
        status: 'completed',
        working_directory: tmpRoot,
        metadata: { mode: 'scout', reason: 'factory_starvation_recovery', project_id: 'project-1' },
        output: [
          '__PATTERNS_READY__',
          JSON.stringify({
            patterns: [{
              id: 'mixed-pattern',
              description: 'Pattern with mixed real and fake files',
              transformation: 'Refactor',
              exemplar_files: [
                'server/factory/real-file.js',
                'docs/superpowers/plans/imaginary.md',
                'server/factory/another-real.js',
              ],
              file_count: 3,
            }],
          }),
          '__PATTERNS_READY_END__',
        ].join('\n'),
      });

      expect(result.created).toHaveLength(1);
      expect(factoryIntake.createWorkItem).toHaveBeenCalledWith(expect.objectContaining({
        origin: expect.objectContaining({
          exemplar_files: [
            'server/factory/real-file.js',
            'server/factory/another-real.js',
          ],
        }),
      }));
      expect(logger.info).toHaveBeenCalledWith(
        'Scout pattern: filtered hallucinated exemplar_files',
        expect.objectContaining({
          pattern_id: 'mixed-pattern',
          kept_count: 2,
          dropped_count: 1,
        }),
      );
    });

    it('creates the work item normally when all exemplar_files exist', () => {
      const factoryIntake = makeFactoryIntake();
      const logger = { warn: vi.fn(), info: vi.fn() };
      const intake = createScoutOutputIntake({ factoryIntake, logger });

      const result = intake.promoteTask({
        id: 'task-clean',
        status: 'completed',
        working_directory: tmpRoot,
        metadata: { mode: 'scout', reason: 'factory_starvation_recovery', project_id: 'project-1' },
        output: [
          '__PATTERNS_READY__',
          JSON.stringify({
            patterns: [{
              id: 'real-pattern',
              description: 'Pattern with real exemplars',
              exemplar_files: ['server/factory/real-file.js'],
              file_count: 1,
            }],
          }),
          '__PATTERNS_READY_END__',
        ].join('\n'),
      });

      expect(result.created).toHaveLength(1);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('fails open when no working_directory is available (preserves prior behavior)', () => {
      const factoryIntake = makeFactoryIntake();
      const logger = { warn: vi.fn(), info: vi.fn() };
      const intake = createScoutOutputIntake({ factoryIntake, logger });

      const result = intake.promoteTask({
        id: 'task-no-cwd',
        status: 'completed',
        // no working_directory; no project_path/working_directory in metadata
        metadata: { mode: 'scout', reason: 'factory_starvation_recovery', project_id: 'project-1' },
        output: [
          '__PATTERNS_READY__',
          JSON.stringify({
            patterns: [{
              id: 'unchecked-pattern',
              description: 'Pattern that cannot be validated',
              exemplar_files: ['some/path/that/might/not/exist.js'],
              file_count: 1,
            }],
          }),
          '__PATTERNS_READY_END__',
        ].join('\n'),
      });

      expect(result.created).toHaveLength(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not gate on patterns that have no exemplar_files at all', () => {
      // A pattern with 0 exemplar_files makes no path claim, so the guard
      // shouldn't drop it. The factory's other quality gates handle the
      // "vague pattern" case.
      const factoryIntake = makeFactoryIntake();
      const intake = createScoutOutputIntake({ factoryIntake });

      const result = intake.promoteTask({
        id: 'task-empty-exemplars',
        status: 'completed',
        working_directory: tmpRoot,
        metadata: { mode: 'scout', reason: 'factory_starvation_recovery', project_id: 'project-1' },
        output: [
          '__PATTERNS_READY__',
          JSON.stringify({
            patterns: [{
              id: 'no-exemplars',
              description: 'Pattern without exemplar_files',
              exemplar_files: [],
              file_count: 0,
            }],
          }),
          '__PATTERNS_READY_END__',
        ].join('\n'),
      });

      expect(result.created).toHaveLength(1);
    });

    it('drops a concrete work item whose allowed_files are entirely hallucinated', () => {
      const factoryIntake = makeFactoryIntake();
      const logger = { warn: vi.fn(), info: vi.fn() };
      const intake = createScoutOutputIntake({ factoryIntake, logger });

      const result = intake.promoteTask({
        id: 'task-concrete-halluc',
        status: 'completed',
        working_directory: tmpRoot,
        metadata: { mode: 'scout', reason: 'factory_starvation_recovery', project_id: 'project-1' },
        output: [
          '__SCOUT_COMPLETE__',
          JSON.stringify({
            concrete_factory_work_items: [{
              title: 'Implement queue starvation recovery',
              description: 'Add starvation recovery mechanism',
              allowed_files: ['docs/imagined.md', 'src/imagined.ts'],
            }],
          }),
          '__SCOUT_COMPLETE_END__',
        ].join('\n'),
      });

      expect(result.created).toHaveLength(0);
      expect(result.skipped).toEqual([expect.objectContaining({
        reason: 'allowed_files_hallucinated',
        dropped_files: ['docs/imagined.md', 'src/imagined.ts'],
      })]);
    });

    it('falls back to metadata.project_path when task.working_directory is absent', () => {
      const factoryIntake = makeFactoryIntake();
      const logger = { warn: vi.fn(), info: vi.fn() };
      const intake = createScoutOutputIntake({ factoryIntake, logger });

      intake.promoteTask({
        id: 'task-meta-cwd',
        status: 'completed',
        // no working_directory at top level
        metadata: {
          mode: 'scout',
          reason: 'factory_starvation_recovery',
          project_id: 'project-1',
          project_path: tmpRoot,
        },
        output: [
          '__PATTERNS_READY__',
          JSON.stringify({
            patterns: [{
              id: 'p1',
              description: 'Pattern',
              exemplar_files: ['docs/imagined.md'],
              file_count: 1,
            }],
          }),
          '__PATTERNS_READY_END__',
        ].join('\n'),
      });

      expect(logger.warn).toHaveBeenCalledWith(
        'Scout pattern dropped: all exemplar_files non-existent',
        expect.objectContaining({
          working_directory: tmpRoot,
        }),
      );
    });
  });
});
