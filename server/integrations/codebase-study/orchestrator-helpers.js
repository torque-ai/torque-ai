'use strict';

const fsPromises = require('node:fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');

function defaultToRepoPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

function defaultUniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function createDefaultUniquePaths(toRepoPath) {
  return function uniquePaths(values) {
    const seen = new Set();
    const output = [];
    for (const value of Array.isArray(values) ? values : []) {
      const normalized = toRepoPath(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      output.push(normalized);
    }
    return output;
  };
}

function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function createOrchestratorHelpers(deps = {}) {
  const studyLogger = deps.logger || createNoopLogger();
  const toRepoPath = typeof deps.toRepoPath === 'function' ? deps.toRepoPath : defaultToRepoPath;
  const uniqueStrings = typeof deps.uniqueStrings === 'function' ? deps.uniqueStrings : defaultUniqueStrings;
  const uniquePaths = typeof deps.uniquePaths === 'function' ? deps.uniquePaths : createDefaultUniquePaths(toRepoPath);
  const GENERATED_STUDY_FILES = deps.GENERATED_STUDY_FILES instanceof Set ? deps.GENERATED_STUDY_FILES : new Set();
  const ALLOWED_EXTENSIONS = deps.ALLOWED_EXTENSIONS instanceof Set ? deps.ALLOWED_EXTENSIONS : new Set();
  const MAX_RUN_BATCH_COUNT = Number.isInteger(deps.MAX_RUN_BATCH_COUNT) && deps.MAX_RUN_BATCH_COUNT > 0
    ? deps.MAX_RUN_BATCH_COUNT
    : Number.MAX_SAFE_INTEGER;

  function isStudyCandidate(filePath) {
    const normalized = toRepoPath(filePath);
    if (!normalized) return false;
    if (GENERATED_STUDY_FILES.has(normalized)) return false;
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

  function normalizeNonNegativeInteger(value, fallback = 0) {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  function normalizePositiveInteger(value, fallback = 1, maxValue = MAX_RUN_BATCH_COUNT) {
    if (!Number.isInteger(value) || value <= 0) {
      return fallback;
    }
    return Math.min(value, maxValue);
  }

  function buildCounts(trackedFiles, pendingFiles) {
    return {
      tracked: trackedFiles.length,
      pending: pendingFiles.length,
      up_to_date: Math.max(0, trackedFiles.length - pendingFiles.length),
    };
  }

  function extractReadmeIntro(content) {
    const lines = String(content || '').split(/\r?\n/);
    const collected = [];
    let started = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!started) {
        if (!trimmed || trimmed.startsWith('#')) continue;
        started = true;
        collected.push(trimmed);
        continue;
      }
      if (!trimmed) break;
      collected.push(trimmed);
    }
    return collected.join(' ');
  }

  async function writeTextFileIfChanged(filePath, nextContent) {
    let currentContent = null;
    try {
      currentContent = await fsPromises.readFile(filePath, 'utf8');
    } catch {
      currentContent = null;
    }
    if (currentContent === nextContent) {
      return false;
    }
    await fsPromises.writeFile(filePath, nextContent, 'utf8');
    return true;
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

  function safeHeadSha(workingDirectory) {
    try {
      return runGitCommand(workingDirectory, ['rev-parse', 'HEAD']);
    } catch (error) {
      studyLogger.warn('[codebase-study] unable to resolve HEAD sha: ' + (error.message || error));
      return null;
    }
  }

  function loadTrackedFiles(workingDirectory) {
    return filterStudyCandidates(splitGitOutput(runGitCommand(workingDirectory, ['ls-files'])));
  }

  function loadDeltaChanges(workingDirectory, lastSha) {
    if (!lastSha) {
      return {
        changed: loadTrackedFiles(workingDirectory),
        removed: [],
      };
    }

    try {
      const lines = splitGitOutput(runGitCommand(workingDirectory, ['diff', '--name-status', '--find-renames', lastSha, 'HEAD']));
      const changed = [];
      const removed = [];
      for (const line of lines) {
        const parts = line.split(/\t+/).map(part => part.trim()).filter(Boolean);
        if (parts.length === 0) continue;
        const status = parts[0];
        if (status.startsWith('R') || status.startsWith('C')) {
          const previousPath = parts[1];
          const nextPath = parts[2];
          if (isStudyCandidate(previousPath) && previousPath !== nextPath) removed.push(previousPath);
          if (isStudyCandidate(nextPath)) changed.push(nextPath);
          continue;
        }
        const filePath = parts[1];
        if (status.startsWith('D')) {
          if (isStudyCandidate(filePath)) removed.push(filePath);
          continue;
        }
        if (isStudyCandidate(filePath)) changed.push(filePath);
      }
      return {
        changed: uniquePaths(changed),
        removed: uniquePaths(removed),
      };
    } catch (error) {
      studyLogger.warn('[codebase-study] diff failed, falling back to ls-files: ' + (error.message || error));
      return {
        changed: loadTrackedFiles(workingDirectory),
        removed: [],
      };
    }
  }

  function mergeUnique(baseValues, newValues) {
    return uniquePaths([...(baseValues || []), ...(newValues || [])]);
  }

  function buildScanLookup(scanResult) {
    const scannedFiles = new Set(uniquePaths(scanResult?.files || []));
    const symbolLookup = new Map();
    const importLookup = new Map();

    for (const entry of Array.isArray(scanResult?.symbols) ? scanResult.symbols : []) {
      if (entry && typeof entry.file === 'string') {
        symbolLookup.set(entry.file, entry);
      }
    }
    for (const entry of Array.isArray(scanResult?.imports) ? scanResult.imports : []) {
      if (entry && typeof entry.file === 'string') {
        importLookup.set(entry.file, entry);
      }
    }

    return {
      scannedFiles,
      symbolLookup,
      importLookup,
    };
  }

  function formatInlineList(values) {
    const items = (values || []).filter(Boolean);
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  }

  function formatCodeList(values, maxItems = 3) {
    const items = uniqueStrings(values).slice(0, maxItems).map(value => `\`${value}\``);
    return formatInlineList(items);
  }

  return {
    isStudyCandidate,
    filterStudyCandidates,
    splitGitOutput,
    normalizeNonNegativeInteger,
    normalizePositiveInteger,
    buildCounts,
    extractReadmeIntro,
    writeTextFileIfChanged,
    runGitCommand,
    safeHeadSha,
    loadTrackedFiles,
    loadDeltaChanges,
    mergeUnique,
    buildScanLookup,
    formatInlineList,
    formatCodeList,
  };
}

module.exports = { createOrchestratorHelpers };
