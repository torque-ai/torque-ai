'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  STUDY_PROFILE_OVERRIDE_FILE,
  resolveStudyProfile,
  getStudyProfileOverridePath,
  readStudyProfileOverride,
  createStudyProfileOverrideTemplate,
  detectStudyProfileSignals,
} = require('../codebase-study-profiles');

const fsPromises = fs.promises;

const LOCAL_ONLY_STRATEGY = 'local-deterministic';
const GENERATED_STUDY_FILES = new Set([
  'docs/architecture/module-index.json',
  'docs/architecture/study-state.json',
  'docs/architecture/knowledge-pack.json',
  'docs/architecture/study-delta.json',
  'docs/architecture/study-evaluation.json',
  'docs/architecture/study-benchmark.json',
  'docs/architecture/SUMMARY.md',
]);
const ALLOWED_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.json', '.py', '.cs']);

function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function toRepoPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function uniquePaths(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = toRepoPath(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function isStudyCandidate(filePath) {
  const normalized = toRepoPath(filePath);
  if (!normalized) {
    return false;
  }

  if (GENERATED_STUDY_FILES.has(normalized)) {
    return false;
  }

  return ALLOWED_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function filterStudyCandidates(values) {
  return uniquePaths(values).filter(isStudyCandidate);
}

function splitGitOutput(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function runGitCommand(workingDirectory, args) {
  const result = spawnSync('git', args, {
    cwd: workingDirectory,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `git ${args.join(' ')} failed with exit code ${result.status}`);
  }

  return (result.stdout || '').trim();
}

function loadTrackedFiles(workingDirectory) {
  return filterStudyCandidates(splitGitOutput(runGitCommand(workingDirectory, ['ls-files'])));
}

function resolveWorkingDirectory(workingDirectory) {
  if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) {
    throw new Error('workingDirectory must be a non-empty string');
  }

  const resolved = path.resolve(workingDirectory.trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(`Working directory not found: ${resolved}`);
  }

  return resolved;
}

async function readJsonIfPresent(filePath) {
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readTextIfPresent(filePath) {
  try {
    return await fsPromises.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function extractReadmeIntro(content) {
  const lines = String(content || '').split(/\r?\n/);
  const collected = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      started = true;
      collected.push(trimmed);
      continue;
    }
    if (!trimmed) {
      break;
    }
    collected.push(trimmed);
  }
  return collected.join(' ');
}

async function loadRepoMetadata(workingDirectory) {
  const packageJson = await readJsonIfPresent(path.join(workingDirectory, 'package.json'));
  const readmeIntro = extractReadmeIntro(await readTextIfPresent(path.join(workingDirectory, 'README.md')));
  const rootEntries = await fsPromises.readdir(workingDirectory, { withFileTypes: true }).catch(() => []);
  const solutionFiles = rootEntries
    .filter((entry) => entry && typeof entry.name === 'string' && entry.isFile && entry.isFile() && entry.name.toLowerCase().endsWith('.sln'))
    .map((entry) => toRepoPath(entry.name));
  const repoName = typeof packageJson?.name === 'string' && packageJson.name.trim()
    ? packageJson.name.trim()
    : path.basename(workingDirectory);
  const description = typeof packageJson?.description === 'string' && packageJson.description.trim()
    ? packageJson.description.trim()
    : (readmeIntro || `Architecture study for ${repoName}.`);
  const packageMain = typeof packageJson?.main === 'string' && packageJson.main.trim()
    ? toRepoPath(packageJson.main)
    : null;
  const binFiles = packageJson?.bin && typeof packageJson.bin === 'object' && !Array.isArray(packageJson.bin)
    ? uniquePaths(Object.values(packageJson.bin))
    : [];

  return {
    name: repoName,
    description,
    package_main: packageMain,
    bin_files: binFiles,
    package_json: packageJson || null,
    solution_files: solutionFiles,
    dotnet_project: solutionFiles.length > 0 || fs.existsSync(path.join(workingDirectory, 'global.json')),
    python_project: fs.existsSync(path.join(workingDirectory, 'pyproject.toml'))
      || fs.existsSync(path.join(workingDirectory, 'requirements.txt'))
      || fs.existsSync(path.join(workingDirectory, 'setup.py')),
    has_powershell_build: fs.existsSync(path.join(workingDirectory, 'scripts', 'build.ps1')),
  };
}

function buildDetectionSummary(repoSignals) {
  if (!repoSignals || typeof repoSignals !== 'object') {
    return null;
  }
  return {
    archetype: repoSignals.archetype || 'generic-javascript-repo',
    confidence: repoSignals.confidence || 'medium',
    frameworks: uniqueStrings(repoSignals.frameworks || []),
    traits: uniqueStrings(repoSignals.traits || []),
    evidence: uniqueStrings(repoSignals.evidence || []),
  };
}

function serializeStudyProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return null;
  }
  return {
    id: profile.id,
    label: profile.label,
    description: profile.description,
    reusable_strategy: profile.reusable_strategy,
    framework_detection: buildDetectionSummary(profile.detection || null),
    base_profile_id: profile.base_profile_id || null,
    override_applied: profile.override_applied === true,
    override_repo_path: profile.override_repo_path || null,
    override_notes: uniqueStrings(profile.override_notes || []),
  };
}

function createProfileManager({ db: _db, logger, ...deps } = {}) {
  const studyLogger = logger || createNoopLogger();
  const resolveWorkingDirectoryFn = typeof deps.resolveWorkingDirectory === 'function'
    ? deps.resolveWorkingDirectory
    : resolveWorkingDirectory;
  const loadRepoMetadataFn = typeof deps.loadRepoMetadata === 'function'
    ? deps.loadRepoMetadata
    : loadRepoMetadata;
  const loadTrackedFilesFn = typeof deps.loadTrackedFiles === 'function'
    ? deps.loadTrackedFiles
    : loadTrackedFiles;
  const readTextIfPresentFn = typeof deps.readTextIfPresent === 'function'
    ? deps.readTextIfPresent
    : readTextIfPresent;
  const readJsonIfPresentFn = typeof deps.readJsonIfPresent === 'function'
    ? deps.readJsonIfPresent
    : readJsonIfPresent;

  function resolveProfile(options = {}) {
    return resolveStudyProfile(options && typeof options === 'object' ? options : {});
  }

  async function getOverrideStatus(workingDirectory) {
    const resolvedWorkingDirectory = resolveWorkingDirectoryFn(workingDirectory);
    const repoMetadata = await loadRepoMetadataFn(resolvedWorkingDirectory);
    const trackedFiles = await Promise.resolve(loadTrackedFilesFn(resolvedWorkingDirectory));
    const overridePath = getStudyProfileOverridePath(resolvedWorkingDirectory);
    const template = createStudyProfileOverrideTemplate({
      repoMetadata,
      profile: resolveProfile({
        repoMetadata,
        trackedFiles,
        workingDirectory: resolvedWorkingDirectory,
      }),
    });
    let rawOverride = null;
    let parsedOverride = null;
    let fileExists = false;

    if (overridePath && fs.existsSync(overridePath)) {
      fileExists = true;
      rawOverride = await readTextIfPresentFn(overridePath);
      parsedOverride = await readJsonIfPresentFn(overridePath);
    }

    const effectiveProfile = resolveProfile({
      repoMetadata,
      trackedFiles,
      workingDirectory: resolvedWorkingDirectory,
    });
    const repoSignals = detectStudyProfileSignals({
      repoMetadata,
      trackedFiles,
      profile: effectiveProfile,
    });
    const activeOverride = readStudyProfileOverride(resolvedWorkingDirectory);

    return {
      working_directory: resolvedWorkingDirectory,
      path: overridePath,
      repo_path: STUDY_PROFILE_OVERRIDE_FILE.replace(/\\/g, '/'),
      exists: fileExists,
      active: Boolean(activeOverride),
      raw_override: rawOverride,
      override: parsedOverride,
      template,
      study_profile: serializeStudyProfile({ ...effectiveProfile, detection: repoSignals }),
    };
  }

  async function saveOverride(workingDirectory, overrideValue, options = {}) {
    const resolvedWorkingDirectory = resolveWorkingDirectoryFn(workingDirectory);
    const overridePath = getStudyProfileOverridePath(resolvedWorkingDirectory);
    if (!overridePath) {
      throw new Error('Unable to resolve study profile override path');
    }

    const shouldClear = options.clear === true || overrideValue === null;
    studyLogger.debug('Persisting codebase-study profile override', {
      workingDirectory: resolvedWorkingDirectory,
      clear: shouldClear,
      strategy: LOCAL_ONLY_STRATEGY,
    });

    if (shouldClear) {
      await fsPromises.rm(overridePath, { force: true });
      return getOverrideStatus(resolvedWorkingDirectory);
    }

    const normalizedOverride = typeof overrideValue === 'string'
      ? JSON.parse(overrideValue)
      : overrideValue;
    if (!normalizedOverride || typeof normalizedOverride !== 'object' || Array.isArray(normalizedOverride)) {
      throw new Error('override must be a JSON object');
    }

    await fsPromises.mkdir(path.dirname(overridePath), { recursive: true });
    await fsPromises.writeFile(overridePath, `${JSON.stringify(normalizedOverride, null, 2)}\n`, 'utf8');
    return getOverrideStatus(resolvedWorkingDirectory);
  }

  return {
    resolveProfile,
    saveOverride,
    getOverrideStatus,
  };
}

module.exports = { createProfileManager };
