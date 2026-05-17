'use strict';

/**
 * Repository scanning/indexing module — `buildKnowledgePack`, `updateStudyDocs`,
 * `getStudyStatus`, `evaluateStudy`, and `benchmarkStudy`.
 *
 * Extracted from the parent `codebase-study.js` orchestrator to reduce god-module size.
 * Accepts all shared services and helpers via factory injection.
 *
 * @param {object} deps
 * @returns {object} { buildKnowledgePack, updateStudyDocs, getStudyStatus, evaluateStudy, benchmarkStudy }
 */
function createRepoScanner(deps) {
  const {
    // Services
    evaluator,
    proposer,
    hotspotsAnalyzer,
    scanner,

    // Sub-modules
    symbolExtraction,
    artifactFiles,
    subsystems: subsystemsModule,
    flowDefinitions: flowDefinitionsModule,
    testsIndex: testsIndexModule,
    expertise: expertiseModule,
    summary: summaryModule,
    studyProposals: studyProposalsModule,
    profileSerializer: profileSerializerModule,

    // Helpers (from orchestrator-helpers)
    writeTextFileIfChanged,
    buildCounts,
    buildScanLookup,

    // State-docs functions
    resolveWorkingDirectory,
    readStudyState,
    writeStudyState,
    ensureStudyDocs,
    readJsonIfPresent,
    normalizeState,
    loadRepoMetadata,
    buildInitialState,

    // Profile functions
    resolveStudyProfile,
    detectStudyProfileSignals,
    normalizeStudyThresholdLevel,
    evaluateStudyArtifacts,
    benchmarkStudyArtifacts,

    // Utility
    uniquePaths,
    safeHeadSha,
    normalizeNonNegativeInteger,

    // Constants
    KNOWLEDGE_PACK_VERSION,
    LOCAL_ONLY_STRATEGY,
    STUDY_EVALUATION_FILE,
    STUDY_BENCHMARK_FILE,
    STUDY_BENCHMARK_FILE_LOCAL,
    SUMMARY_FILE,
    MODULE_INDEX_FILE,
    KNOWLEDGE_PACK_FILE,
    DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL,
    DEFAULT_PROPOSAL_MIN_SCORE,
  } = deps;

  // Destructure sub-module functions
  const { buildModuleEntry, enrichModuleEntries } = symbolExtraction;
  const { readModuleIndex, writeModuleIndex, writeKnowledgePack, writeStudyDelta, writeStudyBenchmark } = artifactFiles;
  const { buildSubsystemRows, buildSubsystemLookup, buildDetectionSummary, buildSubsystemRelationships } = subsystemsModule;
  const { buildFlowSummaries, buildEntrypoints } = flowDefinitionsModule;
  const { buildTestInventory } = testsIndexModule;
  const { buildOperationalInvariants, buildFailureModes, buildCanonicalTraces, buildChangePlaybooks, buildImpactGuidance, buildExpertiseOnramp, buildCapabilityList, buildNavigationHints } = expertiseModule;
  const { buildSummaryFromKnowledgePack, buildStatusPayload, toPercent } = summaryModule;
  const { buildStudyDelta } = studyProposalsModule;
  const { serializeStudyProfile } = profileSerializerModule;

  async function buildKnowledgePack(workingDirectory, modules, context = {}) {
    const repoMetadata = await loadRepoMetadata(workingDirectory);
    const trackedFiles = uniquePaths(context.trackedFiles || modules.map(entry => entry.file));
    const pendingFiles = uniquePaths(context.pendingFiles || []);
    const availableFiles = new Set(trackedFiles);
    const profile = resolveStudyProfile({
      repoMetadata,
      trackedFiles,
      workingDirectory,
    });
    const repoSignals = detectStudyProfileSignals({
      repoMetadata,
      trackedFiles,
      profile,
    });
    const subsystemLookup = buildSubsystemLookup([...trackedFiles, ...modules.map(entry => entry.file)], profile);
    const reverseDeps = hotspotsAnalyzer.buildReverseDependencyMap(modules);
    const subsystemRows = buildSubsystemRows(modules, {
      trackedFiles,
      pendingFiles,
      reverseDeps,
      subsystemLookup,
      activeProfile: profile,
    });
    const relationships = buildSubsystemRelationships(modules, subsystemLookup, profile);
    const hotspots = hotspotsAnalyzer.analyzeHotspots({
      entries: modules,
      reverseDeps,
      subsystemLookup,
      activeProfile: profile,
      repoSignals,
    });
    const entrypoints = buildEntrypoints(repoMetadata, availableFiles, hotspots, modules, subsystemLookup, profile, repoSignals);
    const flows = buildFlowSummaries({
      repoMetadata,
      trackedFiles,
      modules,
      entrypoints,
      hotspots,
      subsystemLookup,
      activeProfile: profile,
    });
    const testInventory = buildTestInventory(modules, trackedFiles, subsystemLookup, flows, profile, workingDirectory);
    const invariants = buildOperationalInvariants(subsystemRows, flows, testInventory, profile);
    const failureModes = buildFailureModes(flows, hotspots, testInventory, profile);
    const canonicalTraces = buildCanonicalTraces(flows, testInventory, profile);
    const changePlaybooks = buildChangePlaybooks(subsystemRows, flows, testInventory, profile, workingDirectory, invariants);
    const impactGuidance = buildImpactGuidance(subsystemRows, flows, invariants, testInventory, profile, workingDirectory);
    const onramp = buildExpertiseOnramp(profile, entrypoints, flows, invariants, subsystemRows);
    const publicProfile = serializeStudyProfile({ ...profile, detection: repoSignals });
    const coverage = {
      tracked_files: trackedFiles.length,
      indexed_modules: modules.length,
      pending_files: pendingFiles.length,
      indexed_percent: toPercent(modules.length, trackedFiles.length),
    };

    return {
      version: KNOWLEDGE_PACK_VERSION,
      generated_at: context.generatedAt || new Date().toISOString(),
      study_profile: publicProfile,
      repo: {
        name: repoMetadata.name,
        description: repoMetadata.description,
        working_directory: workingDirectory,
        current_sha: context.currentSha || null,
        study_strategy: LOCAL_ONLY_STRATEGY,
        detection: buildDetectionSummary(repoSignals),
        capabilities: buildCapabilityList(subsystemRows, flows),
      },
      coverage,
      artifacts: {
        summary: SUMMARY_FILE.replace(/\\/g, '/'),
        module_index: MODULE_INDEX_FILE.replace(/\\/g, '/'),
        knowledge_pack: KNOWLEDGE_PACK_FILE.replace(/\\/g, '/'),
        study_evaluation: STUDY_EVALUATION_FILE.replace(/\\/g, '/'),
        study_benchmark: (STUDY_BENCHMARK_FILE || STUDY_BENCHMARK_FILE_LOCAL).replace(/\\/g, '/'),
      },
      entrypoints,
      subsystems: subsystemRows,
      subsystem_relationships: relationships,
      flows,
      hotspots,
      navigation_hints: buildNavigationHints(flows, subsystemRows, entrypoints),
      expertise: {
        onramp,
        invariants,
        failure_modes: failureModes,
        canonical_traces: canonicalTraces,
        test_matrix: testInventory.coverage,
        change_playbooks: changePlaybooks,
        impact_guidance: impactGuidance,
      },
    };
  }

  async function updateStudyDocs(workingDirectory, batchFiles, removedFiles, context = {}) {
    const paths = await ensureStudyDocs(workingDirectory);
    const previousKnowledgePack = await readJsonIfPresent(paths.knowledgePackPath);
    const { moduleIndex } = await readModuleIndex(workingDirectory);
    const entryMap = new Map(moduleIndex.modules.map(entry => [entry.file, entry]));
    const trackedFiles = uniquePaths(context.trackedFiles || []);
    const scanTargets = uniquePaths([
      ...uniquePaths(batchFiles),
      ...trackedFiles.filter(file => !entryMap.has(file)),
    ]);
    const scanLookup = scanTargets.length > 0
      ? buildScanLookup(await scanner.scanRepo(workingDirectory, { files: scanTargets }))
      : buildScanLookup({ files: [], symbols: [], imports: [] });

    for (const removedFile of uniquePaths(removedFiles)) {
      entryMap.delete(removedFile);
    }

    const updatedEntries = [];
    for (const batchFile of uniquePaths(batchFiles)) {
      const entry = await buildModuleEntry(workingDirectory, batchFile, scanLookup);
      if (entry) {
        entryMap.set(entry.file, entry);
        updatedEntries.push(entry.file);
      }
    }

    // Self-heal stale module indexes when tracked study candidates expand without a git diff.
    for (const trackedFile of trackedFiles) {
      if (entryMap.has(trackedFile)) {
        continue;
      }
      const entry = await buildModuleEntry(workingDirectory, trackedFile, scanLookup);
      if (entry) {
        entryMap.set(entry.file, entry);
        updatedEntries.push(entry.file);
      }
    }

    const nextModules = await enrichModuleEntries(
      Array.from(entryMap.values()).sort((left, right) => left.file.localeCompare(right.file)),
      workingDirectory
    );
    const dateStamp = new Date().toISOString().slice(0, 10);
    await writeModuleIndex(workingDirectory, {
      modules: nextModules,
      last_updated: dateStamp,
    });

    const knowledgePack = await buildKnowledgePack(workingDirectory, nextModules, {
      trackedFiles,
      pendingFiles: context.pendingFiles || [],
      currentSha: context.currentSha || null,
      generatedAt: context.generatedAt || new Date().toISOString(),
    });
    const activeProfile = resolveStudyProfile({
      repoMetadata: {
        name: knowledgePack?.repo?.name,
        description: knowledgePack?.repo?.description,
      },
      trackedFiles: trackedFiles.length > 0 ? trackedFiles : nextModules.map(entry => entry.file),
      workingDirectory,
    });
    await writeKnowledgePack(workingDirectory, knowledgePack);
    const studyDelta = buildStudyDelta(previousKnowledgePack, knowledgePack, {
      workingDirectory,
      currentSha: context.currentSha || null,
      previousSha: context.previousSha || null,
      signalFiles: context.signalFiles || [],
      processedFiles: batchFiles,
      removedFiles,
      generatedAt: context.generatedAt || new Date().toISOString(),
      batchCount: context.batchCount || 0,
      manualRunNow: context.manualRunNow === true,
      forceRefresh: context.forceRefresh === true,
      scheduleId: context.scheduleId || null,
      scheduleName: context.scheduleName || null,
      scheduleRunId: context.scheduleRunId || null,
      currentTaskId: context.currentTaskId || null,
      activeProfile,
      subsystemLookup: buildSubsystemLookup([
        ...trackedFiles,
        ...nextModules.map(entry => entry.file),
        ...(context.signalFiles || []),
      ], activeProfile),
      isBaseline: !context.previousSha,
    });
    const evaluationResult = await evaluator.evaluateStudy(workingDirectory, {
      workingDirectory,
      state: {
        file_counts: {
          tracked: trackedFiles.length,
          pending: (context.pendingFiles || []).length,
        },
      },
      moduleIndex: {
        modules: nextModules,
      },
      knowledgePack,
      studyDelta,
      activeProfile,
      persistState: false,
    });
    const filteredProposals = proposer.filterProposals(
      evaluationResult.proposals?.suggested || [],
      {
        studyDelta,
        project: context.project,
        workingDirectory,
        submitProposals: context.submitProposals === true,
        proposalSignificanceLevel: context.proposalSignificanceLevel,
        proposalMinScore: context.proposalMinScore,
      }
    );
    const proposalResult = await proposer.submitProposals(workingDirectory, {
      workingDirectory,
      project: context.project,
      proposalLimit: context.proposalLimit,
      proposalSignificanceLevel: context.proposalSignificanceLevel,
      proposalMinScore: context.proposalMinScore,
      proposals: filteredProposals,
    });
    studyDelta.proposals = proposalResult;
    await writeStudyDelta(workingDirectory, studyDelta);
    const studyEvaluation = await readJsonIfPresent(paths.evaluationPath);
    const studyBenchmark = await readJsonIfPresent(paths.benchmarkPath);
    const summaryText = buildSummaryFromKnowledgePack(knowledgePack, studyDelta, studyEvaluation, studyBenchmark);
    const summaryUpdated = await writeTextFileIfChanged(paths.summaryPath, summaryText);

    return {
      module_entry_count: nextModules.length,
      module_entries_updated: updatedEntries.length,
      module_entries_removed: uniquePaths(removedFiles).length,
      subsystem_count: knowledgePack.subsystems.length,
      flow_count: knowledgePack.flows.length,
      hotspot_count: knowledgePack.hotspots.length,
      invariant_count: knowledgePack.expertise?.invariants?.length || 0,
      failure_mode_count: knowledgePack.expertise?.failure_modes?.length || 0,
      trace_count: knowledgePack.expertise?.canonical_traces?.length || 0,
      playbook_count: knowledgePack.expertise?.change_playbooks?.length || 0,
      test_area_count: knowledgePack.expertise?.test_matrix?.length || 0,
      delta_significance_level: studyDelta.significance.level,
      delta_significance_score: studyDelta.significance.score,
      proposal_count: proposalResult?.suggested?.length || 0,
      submitted_proposal_count: proposalResult?.submitted?.length || 0,
      proposal_significance_level: proposalResult?.policy?.threshold_level || normalizeStudyThresholdLevel(context.proposalSignificanceLevel),
      proposal_min_score: proposalResult?.policy?.threshold_score ?? normalizeNonNegativeInteger(context.proposalMinScore, DEFAULT_PROPOSAL_MIN_SCORE),
      evaluation_score: studyEvaluation.summary.score,
      evaluation_grade: studyEvaluation.summary.grade,
      evaluation_readiness: studyEvaluation.summary.readiness,
      evaluation_findings_count: studyEvaluation.summary.findings_count,
      evaluation_generated_at: studyEvaluation.generated_at,
      benchmark_score: studyBenchmark.summary.score,
      benchmark_grade: studyBenchmark.summary.grade,
      benchmark_readiness: studyBenchmark.summary.readiness,
      benchmark_findings_count: studyBenchmark.findings.length,
      benchmark_case_count: studyBenchmark.summary.total_cases,
      benchmark_generated_at: studyBenchmark.generated_at,
      study_delta: studyDelta,
      study_evaluation: studyEvaluation,
      study_benchmark: studyBenchmark,
      summary_updated: summaryUpdated,
    };
  }

  async function getStudyStatus(workingDirectory) {
    const resolvedWorkingDirectory = resolveWorkingDirectory(workingDirectory);
    const { state } = await readStudyState(resolvedWorkingDirectory);
    return buildStatusPayload(resolvedWorkingDirectory, state, safeHeadSha(resolvedWorkingDirectory));
  }

  async function evaluateStudy(workingDirectory) {
    const resolvedWorkingDirectory = resolveWorkingDirectory(workingDirectory);
    const { paths, state } = await readStudyState(resolvedWorkingDirectory);
    const { moduleIndex } = await readModuleIndex(resolvedWorkingDirectory);
    const knowledgePack = await readJsonIfPresent(paths.knowledgePackPath);
    const studyDelta = await readJsonIfPresent(paths.deltaPath);

    if (!knowledgePack?.generated_at) {
      throw new Error('Study artifacts are not ready yet. Run the codebase study before evaluating it.');
    }

    await evaluator.evaluateStudy(resolvedWorkingDirectory, {
      workingDirectory: resolvedWorkingDirectory,
      state,
      moduleIndex,
      knowledgePack,
      studyDelta,
      persistState: false,
    });
    const studyEvaluation = await readJsonIfPresent(paths.evaluationPath);
    const studyBenchmark = await readJsonIfPresent(paths.benchmarkPath);
    const nextState = normalizeState({
      ...state,
      evaluation_score: studyEvaluation.summary.score,
      evaluation_grade: studyEvaluation.summary.grade,
      evaluation_readiness: studyEvaluation.summary.readiness,
      evaluation_findings_count: studyEvaluation.summary.findings_count,
      evaluation_generated_at: studyEvaluation.generated_at,
      benchmark_score: studyBenchmark.summary.score,
      benchmark_grade: studyBenchmark.summary.grade,
      benchmark_readiness: studyBenchmark.summary.readiness,
      benchmark_findings_count: studyBenchmark.findings.length,
      benchmark_case_count: studyBenchmark.summary.total_cases,
      benchmark_generated_at: studyBenchmark.generated_at,
    });
    await writeStudyState(resolvedWorkingDirectory, nextState);

    return {
      ...buildStatusPayload(resolvedWorkingDirectory, nextState, safeHeadSha(resolvedWorkingDirectory)),
      study_evaluation: studyEvaluation,
      study_benchmark: studyBenchmark,
      files_modified: [
        STUDY_EVALUATION_FILE.replace(/\\/g, '/'),
        STUDY_BENCHMARK_FILE_LOCAL.replace(/\\/g, '/'),
      ],
    };
  }

  async function benchmarkStudy(workingDirectory) {
    const resolvedWorkingDirectory = resolveWorkingDirectory(workingDirectory);
    const { paths, state } = await readStudyState(resolvedWorkingDirectory);
    const { moduleIndex } = await readModuleIndex(resolvedWorkingDirectory);
    const knowledgePack = await readJsonIfPresent(paths.knowledgePackPath);
    const studyDelta = await readJsonIfPresent(paths.deltaPath);
    const studyEvaluation = await readJsonIfPresent(paths.evaluationPath);

    if (!knowledgePack?.generated_at) {
      throw new Error('Study artifacts are not ready yet. Run the codebase study before benchmarking it.');
    }

    const benchmarkSourceEvaluation = studyEvaluation?.summary
      ? studyEvaluation
      : evaluateStudyArtifacts({
          knowledgePack,
          studyDelta,
          state,
          moduleIndex,
          workingDirectory: resolvedWorkingDirectory,
        });
    const studyBenchmark = benchmarkStudyArtifacts({
      knowledgePack,
      studyDelta,
      studyEvaluation: benchmarkSourceEvaluation,
      moduleIndex,
      workingDirectory: resolvedWorkingDirectory,
    });
    await writeStudyBenchmark(resolvedWorkingDirectory, studyBenchmark);
    const nextState = normalizeState({
      ...state,
      benchmark_score: studyBenchmark.summary.score,
      benchmark_grade: studyBenchmark.summary.grade,
      benchmark_readiness: studyBenchmark.summary.readiness,
      benchmark_findings_count: studyBenchmark.findings.length,
      benchmark_case_count: studyBenchmark.summary.total_cases,
      benchmark_generated_at: studyBenchmark.generated_at,
    });
    await writeStudyState(resolvedWorkingDirectory, nextState);

    return {
      ...buildStatusPayload(resolvedWorkingDirectory, nextState, safeHeadSha(resolvedWorkingDirectory)),
      study_benchmark: studyBenchmark,
      files_modified: [STUDY_BENCHMARK_FILE_LOCAL.replace(/\\/g, '/')],
    };
  }

  return {
    buildKnowledgePack,
    updateStudyDocs,
    getStudyStatus,
    evaluateStudy,
    benchmarkStudy,
  };
}

module.exports = { createRepoScanner };
