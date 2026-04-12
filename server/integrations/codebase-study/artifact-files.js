'use strict';

const fsPromises = require('node:fs/promises');
const path = require('path');

function createArtifactFiles(deps = {}) {
  const ensureStudyDocs = typeof deps.ensureStudyDocs === 'function' ? deps.ensureStudyDocs : null;
  const normalizeModuleIndex = typeof deps.normalizeModuleIndex === 'function'
    ? deps.normalizeModuleIndex
    : (value => value);
  const STUDY_DIR = typeof deps.STUDY_DIR === 'string' ? deps.STUDY_DIR : path.join('docs', 'architecture');
  const STATE_FILE = typeof deps.STATE_FILE === 'string' ? deps.STATE_FILE : path.join(STUDY_DIR, 'study-state.json');
  const MODULE_INDEX_FILE = typeof deps.MODULE_INDEX_FILE === 'string' ? deps.MODULE_INDEX_FILE : path.join(STUDY_DIR, 'module-index.json');
  const KNOWLEDGE_PACK_FILE = typeof deps.KNOWLEDGE_PACK_FILE === 'string' ? deps.KNOWLEDGE_PACK_FILE : path.join(STUDY_DIR, 'knowledge-pack.json');
  const STUDY_DELTA_FILE = typeof deps.STUDY_DELTA_FILE === 'string' ? deps.STUDY_DELTA_FILE : path.join(STUDY_DIR, 'study-delta.json');
  const STUDY_EVALUATION_FILE = typeof deps.STUDY_EVALUATION_FILE === 'string' ? deps.STUDY_EVALUATION_FILE : path.join(STUDY_DIR, 'study-evaluation.json');
  const STUDY_BENCHMARK_FILE_LOCAL = typeof deps.STUDY_BENCHMARK_FILE_LOCAL === 'string'
    ? deps.STUDY_BENCHMARK_FILE_LOCAL
    : path.join(STUDY_DIR, 'study-benchmark.json');
  const SUMMARY_FILE = typeof deps.SUMMARY_FILE === 'string' ? deps.SUMMARY_FILE : path.join(STUDY_DIR, 'SUMMARY.md');

  function getPaths(workingDirectory) {
    return {
      studyDir: path.join(workingDirectory, STUDY_DIR),
      statePath: path.join(workingDirectory, STATE_FILE),
      moduleIndexPath: path.join(workingDirectory, MODULE_INDEX_FILE),
      knowledgePackPath: path.join(workingDirectory, KNOWLEDGE_PACK_FILE),
      deltaPath: path.join(workingDirectory, STUDY_DELTA_FILE),
      evaluationPath: path.join(workingDirectory, STUDY_EVALUATION_FILE),
      benchmarkPath: path.join(workingDirectory, STUDY_BENCHMARK_FILE_LOCAL),
      summaryPath: path.join(workingDirectory, SUMMARY_FILE),
    };
  }

  async function readModuleIndex(workingDirectory) {
    const paths = await ensureStudyDocs(workingDirectory);
    const raw = await fsPromises.readFile(paths.moduleIndexPath, 'utf8');
    let parsed = {};
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Invalid module index JSON: ${error.message}`);
      }
    }
    return { paths, moduleIndex: normalizeModuleIndex(parsed) };
  }

  async function writeModuleIndex(workingDirectory, moduleIndex) {
    const paths = await ensureStudyDocs(workingDirectory);
    const normalized = normalizeModuleIndex(moduleIndex);
    await fsPromises.writeFile(paths.moduleIndexPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return { paths, moduleIndex: normalized };
  }

  async function writeKnowledgePack(workingDirectory, knowledgePack) {
    const paths = await ensureStudyDocs(workingDirectory);
    await fsPromises.writeFile(paths.knowledgePackPath, `${JSON.stringify(knowledgePack, null, 2)}\n`, 'utf8');
    return { paths, knowledgePack };
  }

  async function writeStudyDelta(workingDirectory, studyDelta) {
    const paths = await ensureStudyDocs(workingDirectory);
    await fsPromises.writeFile(paths.deltaPath, `${JSON.stringify(studyDelta, null, 2)}\n`, 'utf8');
    return { paths, studyDelta };
  }

  async function writeStudyBenchmark(workingDirectory, studyBenchmark) {
    const paths = await ensureStudyDocs(workingDirectory);
    await fsPromises.writeFile(paths.benchmarkPath, `${JSON.stringify(studyBenchmark, null, 2)}\n`, 'utf8');
    return { paths, studyBenchmark };
  }

  return {
    getPaths,
    readModuleIndex,
    writeModuleIndex,
    writeKnowledgePack,
    writeStudyDelta,
    writeStudyBenchmark,
  };
}

module.exports = { createArtifactFiles };
