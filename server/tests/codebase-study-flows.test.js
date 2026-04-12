'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFlows } = require('../integrations/codebase-study/flows');

const STUDY_OUTPUT_FILES = [
  'docs/architecture/module-index.json',
  'docs/architecture/knowledge-pack.json',
  'docs/architecture/study-delta.json',
  'docs/architecture/study-evaluation.json',
  'docs/architecture/study-benchmark.json',
  'docs/architecture/SUMMARY.md',
  'docs/architecture/study-state.json',
];

const tempDirectories = new Set();

function uniquePaths(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function mergeUnique(...groups) {
  return uniquePaths(groups.flat());
}

function buildInitialState() {
  return {
    run_count: 0,
    last_sha: null,
    last_task_id: null,
    last_batch: [],
    last_run_at: null,
    last_completed_at: null,
    last_result: null,
    last_error: null,
    tracked_files: [],
    pending_files: [],
    file_counts: {
      tracked: 0,
      pending: 0,
      up_to_date: 0,
    },
    index_strategy: 'local-deterministic',
    summary_strategy: 'local-deterministic',
    last_processed_count: 0,
    last_removed_count: 0,
    last_summary_updated_at: null,
    knowledge_pack_updated_at: null,
    last_delta_updated_at: null,
    module_entry_count: 0,
    subsystem_count: 0,
    flow_count: 0,
    hotspot_count: 0,
    invariant_count: 0,
    failure_mode_count: 0,
    trace_count: 0,
    playbook_count: 0,
    test_area_count: 0,
    delta_significance_level: 'none',
    delta_significance_score: 0,
    proposal_count: 0,
    submitted_proposal_count: 0,
    proposal_significance_level: 'moderate',
    proposal_min_score: 0,
    evaluation_score: 0,
    evaluation_grade: null,
    evaluation_readiness: null,
    evaluation_findings_count: 0,
    evaluation_generated_at: null,
    benchmark_score: 0,
    benchmark_grade: null,
    benchmark_readiness: null,
    benchmark_findings_count: 0,
    benchmark_case_count: 0,
    benchmark_generated_at: null,
  };
}

function buildCounts(trackedFiles, pendingFiles) {
  return {
    tracked: trackedFiles.length,
    pending: pendingFiles.length,
    up_to_date: Math.max(0, trackedFiles.length - pendingFiles.length),
  };
}

function normalizeState(rawState) {
  const source = rawState && typeof rawState === 'object' ? rawState : {};
  const initial = buildInitialState();
  const trackedFiles = uniquePaths(source.tracked_files);
  const pendingFiles = uniquePaths(source.pending_files).filter(file => trackedFiles.includes(file));
  return {
    ...initial,
    ...source,
    last_batch: uniquePaths(source.last_batch),
    tracked_files: trackedFiles,
    pending_files: pendingFiles,
    file_counts: buildCounts(trackedFiles, pendingFiles),
    last_error: source.last_error || null,
  };
}

function buildStatusPayload(workingDirectory, state, currentSha) {
  return {
    working_directory: workingDirectory,
    last_sha: state.last_sha,
    current_sha: currentSha,
    run_count: state.run_count || 0,
    last_batch: uniquePaths(state.last_batch),
    last_result: state.last_result || null,
    last_error: state.last_error || null,
    tracked_count: state.file_counts?.tracked ?? state.tracked_files.length,
    pending_count: state.file_counts?.pending ?? state.pending_files.length,
    up_to_date_count: state.file_counts?.up_to_date ?? Math.max(0, state.tracked_files.length - state.pending_files.length),
    pending_files: uniquePaths(state.pending_files),
    last_processed_count: state.last_processed_count || 0,
    last_removed_count: state.last_removed_count || 0,
    module_entry_count: state.module_entry_count || 0,
    subsystem_count: state.subsystem_count || 0,
    flow_count: state.flow_count || 0,
    hotspot_count: state.hotspot_count || 0,
    invariant_count: state.invariant_count || 0,
    failure_mode_count: state.failure_mode_count || 0,
    trace_count: state.trace_count || 0,
    playbook_count: state.playbook_count || 0,
    test_area_count: state.test_area_count || 0,
    proposal_count: state.proposal_count || 0,
    submitted_proposal_count: state.submitted_proposal_count || 0,
  };
}

function createTempWorkingDirectory() {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-study-flows-'));
  tempDirectories.add(workingDirectory);
  fs.mkdirSync(path.join(workingDirectory, 'docs', 'architecture'), { recursive: true });
  return workingDirectory;
}

function createFlowHarness(options = {}) {
  const workingDirectory = createTempWorkingDirectory();
  const docsDirectory = path.join(workingDirectory, 'docs', 'architecture');
  const statePath = path.join(docsDirectory, 'study-state.json');
  const moduleIndexPath = path.join(docsDirectory, 'module-index.json');
  const knowledgePackPath = path.join(docsDirectory, 'knowledge-pack.json');
  const evaluationPath = path.join(docsDirectory, 'study-evaluation.json');
  const benchmarkPath = path.join(docsDirectory, 'study-benchmark.json');
  const callOrder = [];

  const trackedFiles = options.trackedFiles || ['src/alpha.js', 'src/beta.js'];
  const delta = options.delta || {
    changed: [...trackedFiles],
    removed: [],
  };

  if (options.seedState) {
    fs.writeFileSync(statePath, `${JSON.stringify(normalizeState(options.seedState), null, 2)}\n`, 'utf8');
  }

  const scanner = {
    scanRepo: vi.fn(async (_workingDirectory, scanOptions) => {
      callOrder.push('scanner');
      return {
        files: uniquePaths(scanOptions?.files),
      };
    }),
  };
  const evaluator = {
    evaluateStudy: vi.fn(async () => {
      callOrder.push('evaluator');
      return {
        summary: {
          score: 91,
          grade: 'A',
          readiness: 'expert_ready',
        },
        findings: [],
      };
    }),
  };
  const proposer = {
    filterProposals: vi.fn((proposals) => proposals),
    submitProposals: vi.fn(async () => {
      callOrder.push('proposer');
      return {
        submitted_proposal_count: 1,
      };
    }),
  };
  const profileManager = {
    getActiveProfile: vi.fn(async () => {
      callOrder.push('profileManager');
      return {
        id: 'generic-javascript-repo',
      };
    }),
  };

  if (typeof options.scannerImpl === 'function') {
    scanner.scanRepo.mockImplementation(options.scannerImpl);
  }
  if (typeof options.evaluatorImpl === 'function') {
    evaluator.evaluateStudy.mockImplementation(options.evaluatorImpl);
  }
  if (typeof options.submitProposalsImpl === 'function') {
    proposer.submitProposals.mockImplementation(options.submitProposalsImpl);
  }

  const readStudyState = vi.fn(async () => {
    const parsed = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
      : buildInitialState();
    return {
      paths: {
        statePath,
      },
      state: normalizeState(parsed),
    };
  });

  const writeStudyState = vi.fn(async (_workingDirectory, state) => {
    const normalized = normalizeState(state);
    fs.mkdirSync(docsDirectory, { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    if (options.deleteModuleIndexOnReset && normalized.run_count === 0 && normalized.last_sha === null) {
      fs.rmSync(moduleIndexPath, { force: true });
    }
    return {
      paths: {
        statePath,
      },
      state: normalized,
    };
  });

  const updateStudyDocs = options.updateStudyDocs || vi.fn(async (_workingDirectory, batchFiles, removedFiles, context) => {
    await profileManager.getActiveProfile(_workingDirectory, {
      trackedFiles: context.trackedFiles,
    });
    const scanResult = await scanner.scanRepo(_workingDirectory, {
      files: batchFiles.length > 0 ? batchFiles : context.trackedFiles,
    });
    const evaluationResult = await evaluator.evaluateStudy(_workingDirectory, {
      scanResult,
      removedFiles,
      context,
    });
    const filteredProposals = proposer.filterProposals([
      {
        id: 'proposal-1',
        score: 8,
      },
    ], context);
    const proposalResult = await proposer.submitProposals(_workingDirectory, {
      proposals: filteredProposals,
      context,
    });

    fs.writeFileSync(moduleIndexPath, `${JSON.stringify({
      modules: context.trackedFiles.map(file => ({
        file,
        exports: [],
        deps: [],
      })),
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(knowledgePackPath, `${JSON.stringify({
      generated_at: context.generatedAt,
      coverage: {
        tracked_files: context.trackedFiles.length,
        pending_files: context.pendingFiles.length,
      },
      study_profile: {
        id: 'generic-javascript-repo',
      },
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(evaluationPath, `${JSON.stringify({
      summary: evaluationResult.summary,
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(benchmarkPath, `${JSON.stringify({
      summary: {
        score: 88,
        grade: 'B',
        readiness: 'ready',
      },
    }, null, 2)}\n`, 'utf8');

    return {
      module_entry_count: context.trackedFiles.length,
      subsystem_count: 2,
      flow_count: 1,
      hotspot_count: 1,
      invariant_count: 1,
      failure_mode_count: 1,
      trace_count: 1,
      playbook_count: 1,
      test_area_count: 1,
      delta_significance_level: batchFiles.length > 0 ? 'moderate' : 'none',
      delta_significance_score: batchFiles.length > 0 ? 5 : 0,
      proposal_count: filteredProposals.length,
      submitted_proposal_count: proposalResult.submitted_proposal_count,
      proposal_significance_level: context.proposalSignificanceLevel,
      proposal_min_score: context.proposalMinScore,
      evaluation_score: evaluationResult.summary.score,
      evaluation_grade: evaluationResult.summary.grade,
      evaluation_readiness: evaluationResult.summary.readiness,
      evaluation_findings_count: evaluationResult.findings.length,
      evaluation_generated_at: context.generatedAt,
      benchmark_score: 88,
      benchmark_grade: 'B',
      benchmark_readiness: 'ready',
      benchmark_findings_count: 0,
      benchmark_case_count: 2,
      benchmark_generated_at: context.generatedAt,
      study_evaluation: {
        summary: evaluationResult.summary,
      },
      study_benchmark: {
        summary: {
          score: 88,
          grade: 'B',
          readiness: 'ready',
        },
      },
    };
  });

  const deps = {
    scanner,
    evaluator,
    proposer,
    profileManager,
    taskCore: {
      listTasks: vi.fn(() => []),
    },
    resolveWorkingDirectory: vi.fn(value => path.resolve(value)),
    readStudyState,
    writeStudyState,
    safeHeadSha: vi.fn(() => options.currentSha || 'current-sha'),
    loadTrackedFiles: vi.fn(() => [...trackedFiles]),
    loadDeltaChanges: vi.fn(() => ({
      changed: [...(delta.changed || [])],
      removed: [...(delta.removed || [])],
    })),
    mergeUnique,
    uniquePaths,
    updateStudyDocs,
    normalizeState,
    buildCounts,
    buildStatusPayload,
    buildInitialState,
    loadRepoMetadata: vi.fn(async () => ({
      name: 'temp-study-repo',
      project: options.project || 'temp-study-repo',
    })),
    describeStudyProfile: vi.fn(async () => ({
      profile: {
        id: 'generic-javascript-repo',
      },
      serializedProfile: {
        id: 'generic-javascript-repo',
        label: 'Generic JavaScript Repo',
      },
      profileOverride: {
        exists: false,
        repo_path: 'docs/architecture/study-profile.override.json',
      },
    })),
    maybeWriteStudyProfileOverrideScaffold: vi.fn(async () => ({
      exists: true,
      scaffold_written: true,
      repo_path: 'docs/architecture/study-profile.override.json',
    })),
    readJsonIfPresent: vi.fn(async (filePath) => (
      fs.existsSync(filePath)
        ? JSON.parse(fs.readFileSync(filePath, 'utf8'))
        : null
    )),
    normalizeNonNegativeInteger: (value, fallback = 0) => (
      Number.isInteger(value) && value >= 0 ? value : fallback
    ),
    normalizePositiveInteger: (value, fallback = 1) => (
      Number.isInteger(value) && value > 0 ? value : fallback
    ),
    normalizeStudyThresholdLevel: (value, fallback) => (
      typeof value === 'string' && value.trim() ? value.trim() : fallback
    ),
    buildStudyBootstrapPlan: vi.fn((planOptions) => ({
      repo: {
        name: 'temp-study-repo',
        project: planOptions.project || 'temp-study-repo',
      },
      study_profile: {
        id: 'generic-javascript-repo',
        label: 'Generic JavaScript Repo',
      },
      recommendations: {
        run_initial_study: true,
        run_benchmark: true,
        create_schedule: true,
        initial_run: {
          max_batches: planOptions.initialMaxBatches || 2,
        },
        schedule: {
          name: planOptions.scheduleName || 'codebase-study:temp-study-repo',
          submit_proposals: planOptions.submitProposals === true,
          proposal_limit: planOptions.proposalLimit ?? 2,
          proposal_significance_level: planOptions.proposalSignificanceLevel || 'moderate',
          proposal_min_score: planOptions.proposalMinScore ?? 0,
        },
      },
      steps: [],
    })),
    benchmarkStudy: vi.fn(async () => ({
      study_benchmark: {
        summary: {
          score: 77,
          grade: 'B',
          readiness: 'ready',
        },
      },
    })),
    constants: {
      DEFAULT_LOCAL_BATCH_SIZE: options.batchSize || 10,
      DEFAULT_MANUAL_RUN_BATCH_COUNT: 5,
      DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL: 'moderate',
      DEFAULT_PROPOSAL_MIN_SCORE: 0,
      LOCAL_ONLY_STRATEGY: 'local-deterministic',
      STUDY_OUTPUT_FILES,
      STUDY_BENCHMARK_FILE_LOCAL: 'docs/architecture/study-benchmark.json',
      STUDY_EVALUATION_FILE: 'docs/architecture/study-evaluation.json',
    },
  };

  return {
    workingDirectory,
    docsDirectory,
    statePath,
    moduleIndexPath,
    knowledgePackPath,
    evaluationPath,
    benchmarkPath,
    callOrder,
    deps,
    scanner,
    evaluator,
    proposer,
    profileManager,
    flows: createFlows(deps),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.clear();
});

describe('createFlows', () => {
  it('runs a study cycle end to end and returns the expected status payload shape', async () => {
    const harness = createFlowHarness();

    const result = await harness.flows.runStudyCycle(harness.workingDirectory, {
      submitProposals: true,
      proposalLimit: 2,
    });

    expect(harness.callOrder).toEqual([
      'profileManager',
      'scanner',
      'evaluator',
      'proposer',
    ]);
    expect(result).toEqual(expect.objectContaining({
      skipped: false,
      task_status: 'completed',
      batch_count: 1,
      batch_files: ['src/alpha.js', 'src/beta.js'],
      removed_files: [],
      tracked_count: 2,
      pending_count: 0,
      pending_files: [],
      last_batch: ['src/alpha.js', 'src/beta.js'],
      last_result: 'completed_local',
      last_processed_count: 2,
      last_removed_count: 0,
      module_entry_count: 2,
      flow_count: 1,
      hotspot_count: 1,
      proposal_count: 1,
      submitted_proposal_count: 1,
    }));
    expect(result.files_modified).toEqual(STUDY_OUTPUT_FILES);
    expect(JSON.parse(fs.readFileSync(harness.statePath, 'utf8'))).toEqual(expect.objectContaining({
      last_result: 'completed_local',
      last_error: null,
      tracked_files: ['src/alpha.js', 'src/beta.js'],
      pending_files: [],
    }));
  });

  it('treats an unchanged repository as up to date and clears pending files', async () => {
    const harness = createFlowHarness({
      trackedFiles: ['src/alpha.js', 'src/beta.js'],
      delta: {
        changed: [],
        removed: [],
      },
      seedState: {
        ...buildInitialState(),
        last_sha: 'previous-sha',
        run_count: 1,
        tracked_files: ['src/alpha.js', 'src/beta.js'],
        pending_files: [],
      },
    });

    const result = await harness.flows.runStudyCycle(harness.workingDirectory);

    expect(result).toEqual(expect.objectContaining({
      skipped: true,
      reason: 'up_to_date',
      pending_count: 0,
      pending_files: [],
      tracked_count: 2,
      last_result: 'up_to_date',
      last_processed_count: 0,
    }));
    expect(harness.deps.updateStudyDocs).toHaveBeenCalledWith(
      harness.workingDirectory,
      [],
      [],
      expect.objectContaining({
        pendingFiles: [],
        batchCount: 0,
      })
    );
  });

  it('persists last_error when the scan pipeline throws during a study cycle', async () => {
    const harness = createFlowHarness({
      scannerImpl: async () => {
        throw new Error('scan failed');
      },
    });

    await expect(
      harness.flows.runStudyCycle(harness.workingDirectory)
    ).rejects.toThrow('scan failed');

    const persistedState = JSON.parse(fs.readFileSync(harness.statePath, 'utf8'));
    expect(persistedState).toEqual(expect.objectContaining({
      last_result: 'failed_local',
      last_error: 'scan failed',
      tracked_files: ['src/alpha.js', 'src/beta.js'],
      pending_files: ['src/alpha.js', 'src/beta.js'],
    }));
  });

  it('bootstraps study artifacts and persists the module index, knowledge pack, and state', async () => {
    const harness = createFlowHarness();

    const result = await harness.flows.bootstrapStudy(harness.workingDirectory, {
      project: 'temp-study-repo',
      scheduleName: 'codebase-study:temp-study-repo',
      submitProposals: true,
      proposalLimit: 3,
      initialMaxBatches: 4,
    });

    expect(result.bootstrap_plan).toEqual(expect.objectContaining({
      repo: expect.objectContaining({
        name: 'temp-study-repo',
        project: 'temp-study-repo',
      }),
      recommendations: expect.objectContaining({
        initial_run: expect.objectContaining({
          max_batches: 4,
        }),
        schedule: expect.objectContaining({
          name: 'codebase-study:temp-study-repo',
          submit_proposals: true,
          proposal_limit: 3,
        }),
      }),
    }));
    expect(result.initial_run).toEqual(expect.objectContaining({
      skipped: false,
      task_status: 'completed',
      batch_count: 1,
      pending_count: 0,
    }));
    expect(fs.existsSync(harness.moduleIndexPath)).toBe(true);
    expect(fs.existsSync(harness.knowledgePackPath)).toBe(true);
    expect(fs.existsSync(harness.statePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(harness.moduleIndexPath, 'utf8'))).toEqual(expect.objectContaining({
      modules: expect.arrayContaining([
        expect.objectContaining({ file: 'src/alpha.js' }),
        expect.objectContaining({ file: 'src/beta.js' }),
      ]),
    }));
    expect(JSON.parse(fs.readFileSync(harness.knowledgePackPath, 'utf8'))).toEqual(expect.objectContaining({
      coverage: expect.objectContaining({
        tracked_files: 2,
        pending_files: 0,
      }),
    }));
    expect(JSON.parse(fs.readFileSync(harness.statePath, 'utf8'))).toEqual(expect.objectContaining({
      last_result: 'completed_local',
      module_entry_count: 2,
    }));
  });

  it('resets study state and removes the persisted module index via injected helpers', async () => {
    const harness = createFlowHarness({
      deleteModuleIndexOnReset: true,
    });
    fs.writeFileSync(harness.moduleIndexPath, `${JSON.stringify({
      modules: [
        { file: 'src/alpha.js' },
      ],
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(harness.statePath, `${JSON.stringify(normalizeState({
      ...buildInitialState(),
      run_count: 4,
      last_sha: 'current-sha',
      tracked_files: ['src/alpha.js'],
      pending_files: ['src/alpha.js'],
    }), null, 2)}\n`, 'utf8');

    const result = await harness.flows.resetStudy(harness.workingDirectory);

    expect(result).toEqual(expect.objectContaining({
      reset: true,
      tracked_count: 0,
      pending_count: 0,
      last_error: null,
    }));
    expect(fs.existsSync(harness.moduleIndexPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(harness.statePath, 'utf8'))).toEqual(expect.objectContaining({
      run_count: 0,
      last_sha: null,
      tracked_files: [],
      pending_files: [],
    }));
  });
});
