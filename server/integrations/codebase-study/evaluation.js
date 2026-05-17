'use strict';

/**
 * Evaluation/benchmarking coordination module — `evaluateStudy` and `benchmarkStudy`.
 *
 * Extracted from `repo-scanner.js` to separate the evaluation/benchmark orchestration
 * (reading artifacts, calling evaluator, updating state, returning status payloads) from
 * the repo scanning/indexing concerns.
 *
 * @param {object} deps
 * @returns {object} { evaluateStudy, benchmarkStudy }
 */
function createEvaluation(deps) {
  const {
    // Services
    evaluator,

    // Sub-modules
    artifactFiles,
    summaryModule,

    // Engine functions
    evaluateStudyArtifacts,
    benchmarkStudyArtifacts,

    // State-docs functions
    resolveWorkingDirectory,
    readStudyState,
    writeStudyState,
    readJsonIfPresent,
    normalizeState,

    // Utility
    safeHeadSha,

    // Constants
    STUDY_EVALUATION_FILE,
    STUDY_BENCHMARK_FILE_LOCAL,
  } = deps;

  const { readModuleIndex, writeStudyBenchmark } = artifactFiles;
  const { buildStatusPayload } = summaryModule;

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
    evaluateStudy,
    benchmarkStudy,
  };
}

module.exports = { createEvaluation };
